// Exercises the /api endpoint against a local stand-in for the Anthropic API:
// checks the request the SDK actually sends and that the streamed response is
// relayed to the browser in the shape the client expects.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleApi, type Env } from "../server/handler";

let server: Server;
let baseURL = "";
const seen: { url: string; headers: Record<string, unknown>; body: Record<string, any> }[] = [];

const sse = (events: [string, object][]) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const reply = sse([
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Adding " } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a plate." } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "rename_part", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"name": "Pl' } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ate"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
  ["message_stop", { type: "message_stop" }],
]);

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
      // Current SDK releases send the key as a bearer token.
      if (req.headers.authorization !== "Bearer sk-test" && req.headers["x-api-key"] !== "sk-test") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  handleApi(new Request("http://app/api/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);

const events = async (res: Response) =>
  (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));

const messages = [{ role: "user", content: [{ type: "text", text: "<request>plate</request>" }] }];

describe("/api/chat", () => {
  it("relays a streamed turn and sends the documented request", async () => {
    const res = await post({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: baseURL }, { messages });
    expect(res.status).toBe(200);
    const ev = await events(res);
    expect(ev.find((e) => e.type === "error")).toBeUndefined();
    expect(ev.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Adding a plate.");
    expect(ev.find((e) => e.type === "tool")).toEqual({ type: "tool", name: "rename_part" });
    const final = ev.at(-1);
    expect(final.type).toBe("message");
    expect(final.message.stop_reason).toBe("tool_use");
    expect(final.message.content[1]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "rename_part", input: { name: "Plate" } });

    const sent = seen.at(-1)!;
    expect(sent.url).toContain("/v1/messages");
    expect(String(sent.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    const b = sent.body;
    expect(b).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      messages,
    });
    expect(b.betas).toBeUndefined(); // betas travel as a header, not in the body
    expect(typeof b.system).toBe("string");
    expect(b.tools.map((t: any) => t.name)).toEqual(["add_features", "update_feature", "delete_features", "rename_part", "add_sketch_shapes", "set_dimensions"]);
    for (const t of b.tools) {
      expect(t.eager_input_streaming).toBe(true);
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.$schema).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(20);
    }
    // The feature union must reach Claude as real JSON Schema with every feature type present.
    const featureSchema = JSON.stringify(b.tools[0].input_schema);
    for (const type of ["sketch", "extrude", "revolve", "fillet", "chamfer", "shell", "rect", "circle", "polygon", "slot"]) expect(featureSchema).toContain(`"${type}"`);
  });

  it("honours model, effort and fallback settings", async () => {
    await (await post({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: baseURL, CLAUDE_MODEL: "claude-fable-5-2", CLAUDE_EFFORT: "high", CLAUDE_FALLBACKS: "off" }, { messages })).text();
    const b = seen.at(-1)!.body;
    expect(b.model).toBe("claude-fable-5-2");
    expect(b.output_config.effort).toBe("high");
    expect(b.fallbacks).toBeUndefined();
    expect(seen.at(-1)!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("reports a rejected API key as a non-retryable error event", async () => {
    const ev = await events(await post({ ANTHROPIC_API_KEY: "sk-wrong", ANTHROPIC_BASE_URL: baseURL }, { messages }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "error", retryable: false });
    expect(ev[0].error).toMatch(/API key/);
  });

  it("guards the endpoint", async () => {
    expect((await post({}, { messages })).status).toBe(503);
    expect((await post({ ANTHROPIC_API_KEY: "k", APP_PASSCODE: "open" }, { messages })).status).toBe(401);
    expect((await post({ ANTHROPIC_API_KEY: "k", APP_PASSCODE: "open" }, { messages }, { "x-app-passcode": "nope" })).status).toBe(401);
    expect((await post({ ANTHROPIC_API_KEY: "k" }, { messages: [] })).status).toBe(400);
    expect((await handleApi(new Request("http://app/api/chat"), { ANTHROPIC_API_KEY: "k" })).status).toBe(405);
    const status = await handleApi(new Request("http://app/api/status"), { ANTHROPIC_API_KEY: "k" });
    expect(await status.json()).toEqual({ configured: true, passcode: false });
  });
});

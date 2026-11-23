// The only server-side code: a thin endpoint that holds the Anthropic API key
// and runs one model turn per request. The tool loop itself lives in the
// browser, because that is where the CAD kernel and the part are.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { TOOL_DESCRIPTIONS, ToolInputs, type ToolName } from "../src/ai/tools";
import { SYSTEM_PROMPT } from "./prompt";

export interface Env {
  ANTHROPIC_API_KEY?: string;
  /** Optional shared secret so strangers who find the URL cannot spend the key. */
  APP_PASSCODE?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  /** Set to "off" to disable the server-side refusal fallback. */
  CLAUDE_FALLBACKS?: string;
  /** Optional alternative endpoint, e.g. a Cloudflare AI Gateway URL. */
  ANTHROPIC_BASE_URL?: string;
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const tools: Anthropic.Beta.BetaTool[] = (Object.keys(ToolInputs) as ToolName[]).map((name) => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(ToolInputs[name]) as Record<string, unknown>;
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    // Inputs stream as they are generated; the browser validates each one against the same zod schema.
    eager_input_streaming: true,
    input_schema: schema as Anthropic.Beta.BetaTool["input_schema"],
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function describeError(err: unknown): { error: string; retryable: boolean } {
  if (err instanceof Anthropic.AuthenticationError) return { error: "The server's Anthropic API key was rejected.", retryable: false };
  if (err instanceof Anthropic.PermissionDeniedError) return { error: "The API key does not have access to this model.", retryable: false };
  if (err instanceof Anthropic.RateLimitError) return { error: "Claude is rate limited right now. Try again in a moment.", retryable: false };
  if (err instanceof Anthropic.BadRequestError) return { error: `Request rejected: ${err.message}`, retryable: false };
  if (err instanceof Anthropic.APIError) return { error: `Claude API error${err.status ? ` ${err.status}` : ""}: ${err.message}`, retryable: false };
  // Not an API error: a tool input that could not be parsed or a dropped connection. Safe to re-issue.
  return { error: err instanceof Error ? err.message : "The response was interrupted.", retryable: true };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/status" && request.method === "GET")
    return json({ configured: !!env.ANTHROPIC_API_KEY, passcode: !!env.APP_PASSCODE });

  if (url.pathname !== "/api/chat") return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.ANTHROPIC_API_KEY)
    return json({ error: "Claude is not connected yet: set the ANTHROPIC_API_KEY secret on the server.", code: "not_configured" }, 503);
  if (env.APP_PASSCODE && !sameSecret(request.headers.get("x-app-passcode") ?? "", env.APP_PASSCODE))
    return json({ error: "Passcode required", code: "passcode" }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413);
  let messages: Anthropic.Beta.BetaMessageParam[];
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown };
    if (!Array.isArray(parsed.messages) || !parsed.messages.length) throw new Error("no messages");
    messages = parsed.messages as Anthropic.Beta.BetaMessageParam[];
  } catch {
    return json({ error: "Body must be JSON with a non-empty messages array" }, 400);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const effort = (EFFORTS.includes(env.CLAUDE_EFFORT ?? "") ? env.CLAUDE_EFFORT : "medium") as Effort;
  const useFallbacks = env.CLAUDE_FALLBACKS !== "off";

  const stream = client.beta.messages.stream({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort },
    // If a safety classifier declines a turn, the API re-runs it on its recommended fallback model.
    ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });
  request.signal.addEventListener("abort", () => stream.abort());

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") send({ type: "text", text: event.delta.text });
          else if (event.type === "content_block_start" && event.content_block.type === "tool_use")
            send({ type: "tool", name: event.content_block.name });
        }
        send({ type: "message", message: await stream.finalMessage() });
      } catch (err) {
        if (!request.signal.aborted) send({ type: "error", ...describeError(err) });
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

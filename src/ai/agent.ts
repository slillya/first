// The in-browser half of the Claude integration: builds the context for a
// turn, calls the server for each model step, runs the tool calls against the
// local part, and feeds the build results back until Claude is done.
import type Anthropic from "@anthropic-ai/sdk";
import { signal } from "@preact/signals";
import type { EvalOutcome } from "../kernel/protocol";
import { planeFrame, recognizeStroke } from "../model/geom2d";
import { FeatureSchema, issuesText, type Feature, type PartDoc } from "../model/schema";
import {
  activeSketch,
  bodyInfo,
  commit,
  consumedSketches,
  doc,
  evalStatus,
  gridStep,
  ink,
  draft,
  mode,
  selection,
  treeSelected,
  withFeature,
  withoutFeature,
  withPatch,
} from "../model/store";
import { viewport } from "../view/Viewport";
import { ToolInputs, type ToolName } from "./tools";

// Build-time constant: true only in the Claude artifact build (see scripts/build-artifact.mjs).
const ARTIFACT = import.meta.env.MODE === "artifact";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
}

export const chat = signal<ChatMsg[]>([]);
export const aiBusy = signal(false);
export const aiStatus = signal("");
export const liveReply = signal("");

const PASS_KEY = "napkin.passcode";
const MAX_STEPS = 16;
let controller: AbortController | null = null;

const r3 = (v: number) => Math.round(v * 1000) / 1000;

class ServerError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly code?: string,
  ) {
    super(message);
  }
}

function passcode(): string {
  try {
    return localStorage.getItem(PASS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** One model step: POST the conversation, stream text as it arrives, return the finished message. */
async function step(messages: MessageParam[], signal: AbortSignal): Promise<Message> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-passcode": passcode() },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    const info = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ServerError(info?.error ?? `The server returned ${res.status}`, false, info?.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: Message | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6)) as
        | { type: "text"; text: string }
        | { type: "tool"; name: string }
        | { type: "message"; message: Message }
        | { type: "error"; error: string; retryable?: boolean };
      if (ev.type === "text") liveReply.value += ev.text;
      else if (ev.type === "tool") aiStatus.value = ev.name === "delete_features" ? "Removing…" : "Building…";
      else if (ev.type === "message") final = ev.message;
      else throw new ServerError(ev.error, !!ev.retryable);
    }
  }
  if (!final) throw new ServerError("The response was cut off.", true);
  return final;
}

// ---------------------------------------------------------------------------
// Context for a turn

export function describeState(userText: string): { text: string; wantsImage: boolean } {
  const d = doc.value;
  const status = evalStatus.value;
  const errors = d.features.flatMap((f) => (status[f.id] && !status[f.id].ok ? [`${f.id}: ${status[f.id].error}`] : []));
  const body = bodyInfo.value;
  const lines: string[] = [];
  lines.push(`<state>`);
  lines.push(`part: ${JSON.stringify(d.name)} (mm)`);
  lines.push(`features: ${d.features.length ? JSON.stringify(d.features) : "[] (empty part)"}`);
  lines.push(`build: ${errors.length ? `ERRORS — ${errors.join(" | ")}` : "all features built"}`);
  lines.push(
    body
      ? `body: bbox min ${JSON.stringify(body.bbox.min.map(r3))} max ${JSON.stringify(body.bbox.max.map(r3))}, volume ${r3(body.volume)} mm³, ${body.faces} faces, ${body.edges} edges`
      : `body: no solid yet`,
  );
  const unused = d.features.filter((f) => f.type === "sketch" && !consumedSketches(d).has(f.id)).map((f) => f.id);
  if (unused.length) lines.push(`sketches not yet used by a feature: ${unused.join(", ")}`);
  if (treeSelected.value) lines.push(`feature highlighted in the tree: ${treeSelected.value}`);

  const sel = selection.value;
  if (sel.edges.length) lines.push(`selected edges (a point on each): ${JSON.stringify(sel.edges.map((e) => e.point.map(r3)))}`);
  if (sel.faces.length)
    lines.push(
      `selected faces: ${JSON.stringify(
        sel.faces.map((f) => ({ point: f.point.map(r3), center: f.center.map(r3), outwardNormal: f.normal.map(r3), planar: f.planar })),
      )}`,
    );

  const sk = activeSketch();
  let wantsImage = !!body;
  if (sk) {
    const fr = planeFrame(sk.plane);
    lines.push(
      `mode: sketching in "${sk.id}" — plane origin ${JSON.stringify(fr.origin.map(r3))}, sketch x = ${JSON.stringify(fr.x.map(r3))}, sketch y = ${JSON.stringify(fr.y.map(r3))}, normal ${JSON.stringify(fr.n.map(r3))}`,
    );
    const strokes = ink.value;
    if (strokes.length) {
      wantsImage = true;
      lines.push(`ink: ${strokes.length} finger stroke(s) in sketch coordinates (mm), in the order drawn. Orange in the screenshot.`);
      strokes.forEach((s, i) => {
        // Cap each stroke at ~80 points; that keeps the shape and bounds the prompt size.
        const stride = Math.max(1, Math.ceil(s.length / 80));
        const pts = s.filter((_, k) => k % stride === 0 || k === s.length - 1);
        const guess = recognizeStroke(s, gridStep.value);
        lines.push(`  stroke ${i + 1}: ${JSON.stringify(pts)}${guess ? ` — app's guess: ${JSON.stringify(guess)}` : " — app could not classify it (open stroke or annotation?)"}`);
      });
    }
    lines.push(`sketch grid step: ${gridStep.value} mm`);
  } else lines.push(`mode: 3D model view`);
  lines.push(`</state>`);

  const recent = chat.value.slice(-8);
  if (recent.length) {
    lines.push(`<earlier_in_this_session>`);
    for (const m of recent) lines.push(`${m.role === "user" ? "User" : "You"}: ${m.text}`);
    lines.push(`</earlier_in_this_session>`);
  }
  lines.push(`<request>${userText}</request>`);
  return { text: lines.join("\n"), wantsImage };
}

function firstMessage(userText: string): MessageParam {
  const { text, wantsImage } = describeState(userText);
  const content: ContentBlockParam[] = [];
  const vp = viewport();
  if (wantsImage && vp) {
    const shot = vp.snapshot();
    if (shot.data) {
      content.push({ type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.data } });
      const where = shot.region
        ? ` It is the sketch view: sketch x runs from ${r3(shot.region.min[0])} (left) to ${r3(shot.region.max[0])} (right), y from ${r3(shot.region.min[1])} (bottom) to ${r3(shot.region.max[1])} (top).`
        : "";
      content.push({ type: "text", text: `Screenshot of the user's current view.${where}` });
    }
  }
  content.push({ type: "text", text });
  return { role: "user", content };
}

// ---------------------------------------------------------------------------
// Tools

function report(out: EvalOutcome, d: PartDoc, extra: Record<string, unknown> = {}): string {
  const errors = d.features.flatMap((f) => {
    const s = out.status[f.id];
    return s && !s.ok ? [{ id: f.id, error: s.error }] : [];
  });
  return JSON.stringify({
    built: errors.length === 0,
    ...(errors.length ? { errors } : {}),
    body: out.body
      ? { bbox_min: out.body.bbox.min.map(r3), bbox_max: out.body.bbox.max.map(r3), volume_mm3: r3(out.body.volume), faces: out.body.faces, edges: out.body.edges }
      : null,
    ...extra,
  });
}

export async function runTool(name: string, input: unknown): Promise<{ content: string; isError?: boolean }> {
  if (!(name in ToolInputs)) return { content: `Unknown tool "${name}"`, isError: true };
  const parsed = ToolInputs[name as ToolName].safeParse(input);
  // Inputs stream unvalidated, so a schema failure is reported back the same way invalid JSON would be.
  if (!parsed.success)
    return { content: JSON.stringify({ INVALID_INPUT: issuesText(parsed.error), received: JSON.stringify(input).slice(0, 2000) }), isError: true };
  const d = doc.value;

  switch (name as ToolName) {
    case "add_features": {
      const { features, after } = parsed.data as { features: Feature[]; after?: string };
      const ids = new Set(d.features.map((f) => f.id));
      for (const f of features) {
        if (ids.has(f.id)) return { content: `A feature with id "${f.id}" already exists. Pick a new id, or use update_feature to change it.`, isError: true };
        ids.add(f.id);
      }
      if (after && !d.features.some((f) => f.id === after)) return { content: `No feature with id "${after}" to insert after.`, isError: true };
      let next = d;
      let anchor = after;
      for (const f of features) {
        next = withFeature(next, f, anchor).doc;
        if (anchor) anchor = f.id;
      }
      return { content: report(await commit(next), next, { added: features.map((f) => f.id) }) };
    }
    case "update_feature": {
      const { id, changes } = parsed.data as { id: string; changes: Record<string, unknown> };
      const current = d.features.find((f) => f.id === id);
      if (!current) return { content: `No feature with id "${id}". Existing ids: ${d.features.map((f) => f.id).join(", ") || "(none)"}`, isError: true };
      if ("id" in changes || ("type" in changes && changes.type !== current.type))
        return { content: "id and type cannot be changed; delete the feature and add a new one instead.", isError: true };
      const merged = FeatureSchema.safeParse({ ...current, ...changes });
      if (!merged.success) return { content: `The changed feature is invalid — ${issuesText(merged.error)}`, isError: true };
      const next = withPatch(d, id, merged.data);
      return { content: report(await commit(next), next, { updated: id }) };
    }
    case "delete_features": {
      const { ids } = parsed.data as { ids: string[] };
      const missing = ids.filter((id) => !d.features.some((f) => f.id === id));
      if (missing.length) return { content: `No feature with id ${missing.map((m) => `"${m}"`).join(", ")}.`, isError: true };
      let next = d;
      for (const id of ids) next = withoutFeature(next, id);
      const removed = d.features.filter((f) => !next.features.includes(f)).map((f) => f.id);
      return { content: report(await commit(next), next, { removed }) };
    }
    case "rename_part": {
      const { name: partName } = parsed.data as { name: string };
      await commit({ ...d, name: partName });
      return { content: JSON.stringify({ renamed: partName }) };
    }
  }
}

/**
 * What to send back as the assistant turn. After a mid-output fallback the
 * API requires dropping thinking and tool_use blocks from before the last
 * fallback marker; everything else is echoed unchanged.
 */
function echo(content: ContentBlock[]): ContentBlockParam[] {
  const boundary = content.map((b) => b.type as string).lastIndexOf("fallback");
  return content.filter((b, i) => i >= boundary || b.type === "text") as ContentBlockParam[];
}

function liveTools(content: ContentBlock[]): Anthropic.Beta.BetaToolUseBlock[] {
  const boundary = content.map((b) => b.type as string).lastIndexOf("fallback");
  return content.filter((b, i): b is Anthropic.Beta.BetaToolUseBlock => i > boundary && b.type === "tool_use");
}

// ---------------------------------------------------------------------------
// Turn

export function stop() {
  controller?.abort();
}

export async function send(userText: string) {
  if (aiBusy.value) return;
  const hadInk = ink.value.length > 0;
  const text = userText.trim() || (hadInk ? "Interpret my sketch." : "");
  if (!text) return;

  const before = doc.value;
  // Built before the message is added to the chat, so the request is not repeated in its own context.
  const messages: MessageParam[] = ARTIFACT ? [] : [firstMessage(text)];
  const artifactTurn = ARTIFACT ? (signal: AbortSignal) => import("./artifact").then((m) => m.runInArtifact(text, signal)) : null;
  chat.value = [...chat.value, { role: "user", text }];
  aiBusy.value = true;
  aiStatus.value = "Thinking…";
  liveReply.value = "";
  controller = new AbortController();
  let reply = "";
  let failed = false;

  try {
    let retries = 0;
    if (artifactTurn) reply = await artifactTurn(controller.signal);
    for (let i = 0; !artifactTurn && i < MAX_STEPS; i++) {
      let msg: Message;
      try {
        msg = await step(messages, controller.signal);
        retries = 0;
      } catch (e) {
        // An unparseable tool input or a dropped stream is safe to re-issue; API errors are not.
        if (e instanceof ServerError && e.retryable && retries++ < 2) {
          liveReply.value = "";
          i--;
          continue;
        }
        if (e instanceof ServerError && e.code === "passcode") {
          const entered = window.prompt("Passcode for this app");
          if (entered) {
            try {
              localStorage.setItem(PASS_KEY, entered);
            } catch {
              // Without storage the passcode simply has to be re-entered next time.
            }
            i--;
            continue;
          }
        }
        throw e;
      }

      const said = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      if (said) reply = said;
      if (msg.stop_reason === "refusal") {
        reply = "Claude declined that request.";
        failed = true;
        break;
      }
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: echo(msg.content) });
        continue;
      }
      const calls = liveTools(msg.content);
      if (!calls.length) break;
      // A tool input cut off at the token limit can still parse; never run it.
      if (msg.stop_reason === "max_tokens") throw new ServerError("The change was too large to finish in one step. Try asking for it in smaller pieces.");

      messages.push({ role: "assistant", content: echo(msg.content) });
      const results: ToolResult[] = [];
      for (const call of calls) {
        aiStatus.value = "Building…";
        const r = await runTool(call.name, call.input);
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      aiStatus.value = "Checking…";
      liveReply.value = "";
      if (i === MAX_STEPS - 1) reply = reply || "Stopped after many steps; check the feature tree.";
    }
    if (!reply) reply = doc.value !== before ? "Done." : "No changes made.";
  } catch (e) {
    failed = true;
    if (controller.signal.aborted) reply = "Stopped.";
    else reply = e instanceof Error ? e.message : "Something went wrong talking to Claude.";
    if (e instanceof TypeError) reply = "Couldn't reach the server. Check your connection.";
  } finally {
    controller = null;
    chat.value = [...chat.value, { role: "assistant", text: reply, error: failed }];
    liveReply.value = "";
    aiStatus.value = "";
    aiBusy.value = false;
    // Ink that Claude has turned into geometry is done with; a consumed sketch ends sketch mode.
    if (doc.value !== before) {
      if (hadInk) ink.value = [];
      draft.value = [];
      const m = mode.value;
      if (m.kind === "sketch" && (consumedSketches(doc.value).has(m.sketchId) || !doc.value.features.some((f) => f.id === m.sketchId)))
        mode.value = { kind: "model" };
      // Let the rebuilt mesh land, then make sure the result is in view.
      setTimeout(() => viewport()?.fitIfNeeded(), 120);
    }
  }
}

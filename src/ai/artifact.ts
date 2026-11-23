// Artifact build only: the same chat and tools, but Claude is reached through
// the viewer's own Claude account (the artifact runtime's `sample` capability)
// instead of our server, so no API key or deployment is needed.
import { z } from "zod";
import { FeatureSchema } from "../model/schema";
import { viewport } from "../view/Viewport";
import { aiStatus, describeState, liveReply, runTool } from "./agent";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOL_DESCRIPTIONS, type ToolName } from "./tools";

type SampleTool = {
  name: string;
  description: string;
  inputSchema?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  execute(input: Record<string, unknown>): unknown;
};
type Sample = {
  (input: string, options?: { tools?: SampleTool[]; images?: Blob[]; cache?: false; signal?: AbortSignal; onText?: (u: { text: string }) => void }): Promise<{ text: string; truncated: boolean }>;
  limits(): Promise<{ images?: { maxCount: number }; tools?: { maxCount: number } }>;
};
type Downloads = { save(req: { filename: string; data: Blob }): Promise<{ status: string }> };
type Runtime = { use(name: "sample"): Promise<Sample | null>; use(name: "downloads"): Promise<Downloads | null> };

const runtime = () => (window as unknown as { claude?: Runtime }).claude;

// Tool schemas here are capped at a few KB, so the tools take loosely-typed
// arguments and the full feature schema travels in the prompt instead. Every
// call is still validated against the real schema before it touches the part.
const SCHEMAS: Record<ToolName, SampleTool["inputSchema"]> = {
  add_features: {
    type: "object",
    properties: {
      features: { type: "array", items: { type: "object" }, description: "Feature objects in build order, each matching the feature schema in the instructions" },
      after: { type: "string", description: "Insert after this feature id; default is the end of the tree" },
    },
    required: ["features"],
  },
  update_feature: {
    type: "object",
    properties: {
      id: { type: "string" },
      changes: { type: "object", description: "Fields to replace on the feature (shallow merge; arrays and nested objects are replaced whole)" },
    },
    required: ["id", "changes"],
  },
  delete_features: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  rename_part: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
};

const INSTRUCTIONS = `${SYSTEM_PROMPT}

# Feature format
Every feature passed to add_features, and every feature after update_feature's changes are merged in, must match this JSON Schema:
${JSON.stringify(z.toJSONSchema(FeatureSchema))}`;

const COPY: Record<string, string> = {
  not_granted: "Claude was not allowed for this page, so the chat is off. The tools still work.",
  sampling_disabled: "Claude is not available for this account here.",
  tools_unavailable: "This view cannot let Claude edit the part. Open the page in the Claude app or on claude.ai.",
  rate_limited: "Claude is busy or you have reached a usage limit. Try again in a little while.",
  session_expired: "Sign in to Claude again, then retry.",
  refused: "Claude declined that request.",
  prompt_too_large: "The part is too large to send in one message.",
  empty_completion: "Claude returned nothing. Try rephrasing.",
};

function jpegBlob(base64: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

/** One chat turn. Resolves with Claude's final words; the tools have already been applied to the part. */
export async function runInArtifact(userText: string, signal: AbortSignal): Promise<string> {
  const sample = await runtime()?.use("sample");
  if (!sample) throw new Error("Claude is not available in this view. Open the page in the Claude app or on claude.ai.");
  const limits = await sample.limits().catch(() => null);
  if (!limits?.tools) throw new Error(COPY.tools_unavailable);

  const { text, wantsImage } = describeState(userText);
  let input = `${INSTRUCTIONS}\n\n${text}`;
  let images: Blob[] | undefined;
  const vp = viewport();
  if (wantsImage && limits.images && vp) {
    const shot = vp.snapshot();
    if (shot.data) {
      images = [jpegBlob(shot.data)];
      const r = shot.region;
      input += `\n\nThe attached image is a screenshot of the user's current view.${
        r ? ` It is the sketch view: sketch x runs from ${r.min[0].toFixed(2)} (left) to ${r.max[0].toFixed(2)} (right), y from ${r.min[1].toFixed(2)} (bottom) to ${r.max[1].toFixed(2)} (top).` : ""
      }`;
    }
  }

  const tools: SampleTool[] = (Object.keys(SCHEMAS) as ToolName[]).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: SCHEMAS[name],
    async execute(args) {
      aiStatus.value = name === "delete_features" ? "Removing…" : "Building…";
      const r = await runTool(name, args);
      aiStatus.value = "Checking…";
      // Throwing is how a page tool reports a problem back to Claude.
      if (r.isError) throw new Error(r.content);
      return r.content;
    },
  }));

  try {
    const res = await sample(input, { tools, images, cache: false, signal, onText: ({ text: t }) => (liveReply.value = t) });
    // With tools, the text of every round comes back joined by blank lines; the last part is the answer.
    const parts = res.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? res.text.trim();
  } catch (e) {
    const code = (e as { code?: string } | null)?.code ?? "";
    if (code === "cancelled") throw e;
    throw new Error(COPY[code] ?? "Something went wrong reaching Claude. Try again.");
  }
}

// --- Saving files -----------------------------------------------------------

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A zip archive holding one uncompressed file. */
export function zipOne(name: string, data: Uint8Array): Blob {
  const file = new TextEncoder().encode(name);
  const crc = crc32(data);
  const header = (central: boolean) => {
    const v = new DataView(new ArrayBuffer(central ? 46 : 30));
    let o = 0;
    const u16 = (n: number) => (v.setUint16(o, n, true), (o += 2));
    const u32 = (n: number) => (v.setUint32(o, n, true), (o += 4));
    u32(central ? 0x02014b50 : 0x04034b50);
    if (central) u16(20); // version made by
    u16(20); // version needed
    u16(0x0800); // UTF-8 names
    u16(0); // stored
    u16(0); // time
    u16(0x21); // date: 1980-01-01
    u32(crc);
    u32(data.length);
    u32(data.length);
    u16(file.length);
    u16(0); // extra
    if (central) {
      u16(0); // comment
      u16(0); // disk
      u16(0); // internal attributes
      u32(0); // external attributes
      u32(0); // offset of the local header
    }
    return v;
  };
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + file.length, true);
  end.setUint32(16, 30 + file.length + data.length, true);
  return new Blob([header(false), file, data as BlobPart, header(true), file, end], { type: "application/zip" });
}

/**
 * Hands a CAD export to the viewer. The artifact save dialog only accepts
 * common file types, so STEP and STL go out inside a zip.
 */
export async function saveInArtifact(name: string, data: ArrayBuffer): Promise<void> {
  const downloads = await runtime()?.use("downloads");
  if (!downloads) throw new Error("This view cannot save files. Open the page in the Claude app or on claude.ai.");
  try {
    await downloads.save({ filename: `${name}.zip`, data: zipOne(name, new Uint8Array(data)) });
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === "declined") return;
    throw new Error(code === "rate_limited" ? "A save is already in progress." : "The file could not be saved here.");
  }
}

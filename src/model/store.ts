// App state. Everything the UI and the viewport react to lives in signals here.
import { computed, signal } from "@preact/signals";
import { kernel } from "../kernel/client";
import type { BodyInfo, EvalOutcome, FeatureStatus, MeshData } from "../kernel/protocol";
import { frameForFace, recognizeStroke } from "./geom2d";
import {
  defaultName,
  FeatureSchema,
  ID_PREFIX,
  newId,
  type Feature,
  type PartDoc,
  type PlaneRef,
  type Profile,
  type Vec2,
  type Vec3,
} from "./schema";

export type SketchTool = "ink" | "line" | "rect" | "circle" | "select" | "erase";
export type Mode =
  | { kind: "model" }
  | { kind: "sketch"; sketchId: string; tool: SketchTool; selected: number | null };

export interface FacePick {
  faceId: number;
  /** A point on the face (centre of the tapped triangle). */
  point: Vec3;
  /** Centre of the face's bounding box, used as the sketch origin. */
  center: Vec3;
  normal: Vec3;
  planar: boolean;
}
export interface EdgePick {
  edgeId: number;
  point: Vec3;
}

export interface NumPrompt {
  title: string;
  fields: { key: string; label: string; value: number; min?: number }[];
  onSubmit: (values: Record<string, number>) => void;
}

const STORAGE_KEY = "napkin.doc.v1";

function loadDoc(): PartDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as { name?: unknown; features?: unknown[] };
      const features = (d.features ?? []).flatMap((f) => {
        const r = FeatureSchema.safeParse(f);
        return r.success ? [r.data] : [];
      });
      return { name: typeof d.name === "string" && d.name ? d.name : "Part1", features };
    }
  } catch {
    // Unreadable or unavailable storage just means starting with a blank part.
  }
  return { name: "Part1", features: [] };
}

export const doc = signal<PartDoc>(loadDoc());
export const evalStatus = signal<Record<string, FeatureStatus>>({});
export const bodyInfo = signal<BodyInfo | null>(null);
export const mesh = signal<MeshData | null>(null);
export const kernelPhase = signal<"loading" | "ready" | "busy" | "failed">("loading");
export const kernelError = signal("");
export const mode = signal<Mode>({ kind: "model" });
export const selection = signal<{ faces: FacePick[]; edges: EdgePick[] }>({ faces: [], edges: [] });
export const ink = signal<Vec2[][]>([]);
export const draft = signal<Vec2[]>([]);
export const treeOpen = signal(false);
export const toolsOpen = signal(false);
export const treeSelected = signal<string | null>(null);
export const sheet = signal<{ featureId: string; isNew: boolean } | null>(null);
export const numPrompt = signal<NumPrompt | null>(null);
export const toast = signal<{ text: string; id: number } | null>(null);
/** Bumped by the viewport whenever the camera moves, so overlays can re-project. */
export const cameraTick = signal(0);
/** Current sketch grid/snap step in mm, published by the viewport. */
export const gridStep = signal(1);

const histTick = signal(0);
let past: PartDoc[] = [];
let future: PartDoc[] = [];
export const canUndo = computed(() => (histTick.value, past.length > 0 || ink.value.length > 0));
export const canRedo = computed(() => (histTick.value, future.length > 0));

let toastSeq = 0;
export function showToast(text: string) {
  const id = ++toastSeq;
  toast.value = { text, id };
  setTimeout(() => {
    if (toast.value?.id === id) toast.value = null;
  }, 3200);
}

// ---------------------------------------------------------------------------
// Evaluation: one kernel run at a time, always converging on the latest doc.

let running = false;
let queued = false;
let waiters: ((r: EvalOutcome) => void)[] = [];

function requestEval(): Promise<EvalOutcome> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    void pump();
  });
}

async function pump() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  for (;;) {
    queued = false;
    const mine = waiters;
    waiters = [];
    if (kernelPhase.value !== "loading") kernelPhase.value = "busy";
    let out: EvalOutcome;
    try {
      out = await kernel.evaluate(doc.value.features);
      kernelPhase.value = "ready";
    } catch (e) {
      out = { status: {}, body: null, mesh: null };
      kernelPhase.value = "failed";
      showToast(e instanceof Error ? e.message : "The CAD kernel failed");
    }
    if (!queued) {
      evalStatus.value = out.status;
      bodyInfo.value = out.body;
      mesh.value = out.mesh;
      // Face and edge ids belong to the previous mesh.
      if (selection.value.faces.length || selection.value.edges.length) selection.value = { faces: [], edges: [] };
    }
    for (const w of mine) w(out);
    if (!queued) break;
  }
  running = false;
}

function setDoc(next: PartDoc): Promise<EvalOutcome> {
  const sameGeometry = next.features === doc.value.features;
  doc.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the part still works for this session.
  }
  if (sameGeometry) return Promise.resolve({ status: evalStatus.value, body: bodyInfo.value, mesh: mesh.value });
  return requestEval();
}

/** Apply a change and record it for undo. */
export function commit(next: PartDoc): Promise<EvalOutcome> {
  past.push(doc.value);
  if (past.length > 100) past.shift();
  future = [];
  histTick.value++;
  return setDoc(next);
}

/** Apply a change without an undo entry (live previews while a sheet is open). */
export function preview(next: PartDoc): Promise<EvalOutcome> {
  return setDoc(next);
}

export function pushUndo(snapshot: PartDoc) {
  past.push(snapshot);
  future = [];
  histTick.value++;
}

function afterHistoryJump() {
  histTick.value++;
  const m = mode.value;
  if (m.kind === "sketch" && !doc.value.features.some((f) => f.id === m.sketchId)) {
    ink.value = [];
    draft.value = [];
    mode.value = { kind: "model" };
  } else if (m.kind === "sketch" && m.selected !== null) mode.value = { ...m, selected: null };
  sheet.value = null;
}

export function undo() {
  if (ink.value.length) {
    ink.value = ink.value.slice(0, -1);
    return;
  }
  const prev = past.pop();
  if (!prev) return;
  future.push(doc.value);
  void setDoc(prev);
  afterHistoryJump();
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(doc.value);
  void setDoc(next);
  afterHistoryJump();
}

export function initKernel() {
  kernel.init().then(
    () => {
      kernelPhase.value = "ready";
      void requestEval();
    },
    (e: unknown) => {
      kernelError.value = e instanceof Error ? e.message : "The CAD kernel failed to load";
      kernelPhase.value = "failed";
    },
  );
}

// ---------------------------------------------------------------------------
// Feature edits

type NewFeature<T extends Feature = Feature> = T extends Feature ? Omit<T, "id" | "name"> & { id?: string; name?: string } : never;

export function withFeature(d: PartDoc, f: NewFeature, after?: string): { doc: PartDoc; id: string } {
  const id = f.id ?? newId(ID_PREFIX[f.type], d.features);
  const full = { ...f, id } as Feature;
  full.name = f.name ?? defaultName(full, d.features);
  const features = d.features.slice();
  const at = after ? features.findIndex((x) => x.id === after) : -1;
  if (at >= 0) features.splice(at + 1, 0, full);
  else features.push(full);
  return { doc: { ...d, features }, id };
}

export function withPatch(d: PartDoc, id: string, patch: Partial<Feature>): PartDoc {
  return { ...d, features: d.features.map((f) => (f.id === id ? ({ ...f, ...patch } as Feature) : f)) };
}

/** Removing a sketch also removes the features built on it. */
export function withoutFeature(d: PartDoc, id: string): PartDoc {
  return {
    ...d,
    features: d.features.filter((f) => f.id !== id && !((f.type === "extrude" || f.type === "revolve") && f.sketch === id)),
  };
}

export const feature = (id: string | null | undefined) => doc.value.features.find((f) => f.id === id);

export function consumedSketches(d: PartDoc): Set<string> {
  const used = new Set<string>();
  for (const f of d.features) if (f.type === "extrude" || f.type === "revolve") used.add(f.sketch);
  return used;
}

/** The sketch a new extrude/revolve should use: the one picked in the tree, else the newest unused one. */
export function sketchForNewFeature(): string | null {
  const d = doc.value;
  const picked = feature(treeSelected.value);
  if (picked?.type === "sketch" && picked.profiles.length) return picked.id;
  const used = consumedSketches(d);
  const sketches = d.features.filter((f) => f.type === "sketch" && f.profiles.length && !f.suppressed);
  const unused = sketches.filter((s) => !used.has(s.id));
  return (unused[unused.length - 1] ?? sketches[sketches.length - 1])?.id ?? null;
}

// ---------------------------------------------------------------------------
// Parameter sheet (live preview, single undo step on confirm)

let sheetBase: PartDoc | null = null;

export function openSheet(featureId: string, isNew: boolean, base: PartDoc = doc.value) {
  sheetBase = base;
  numPrompt.value = null;
  sheet.value = { featureId, isNew };
}

export function createWithSheet(f: NewFeature) {
  const base = doc.value;
  const { doc: next, id } = withFeature(base, f);
  void preview(next);
  openSheet(id, true, base);
  treeSelected.value = null;
  treeOpen.value = false;
  toolsOpen.value = false;
}

export function confirmSheet() {
  if (sheetBase && sheetBase !== doc.value) pushUndo(sheetBase);
  sheetBase = null;
  sheet.value = null;
}

export function cancelSheet() {
  if (sheetBase && sheetBase !== doc.value) void preview(sheetBase);
  sheetBase = null;
  sheet.value = null;
}

// ---------------------------------------------------------------------------
// Sketch mode

export function startSketch(plane: PlaneRef) {
  const { doc: next, id } = withFeature(doc.value, { type: "sketch", plane, profiles: [] });
  void commit(next);
  ink.value = [];
  draft.value = [];
  sheet.value = null;
  selection.value = { faces: [], edges: [] };
  mode.value = { kind: "sketch", sketchId: id, tool: "ink", selected: null };
  treeOpen.value = false;
  toolsOpen.value = false;
}

export function startSketchOnFace(face: FacePick) {
  const f = frameForFace(face.center, face.normal);
  startSketch({ origin: f.origin, normal: f.n, xDir: f.x });
}

export function editSketch(id: string) {
  ink.value = [];
  draft.value = [];
  sheet.value = null;
  mode.value = { kind: "sketch", sketchId: id, tool: "select", selected: null };
  treeOpen.value = false;
  toolsOpen.value = false;
}

export function setTool(tool: SketchTool) {
  const m = mode.value;
  if (m.kind !== "sketch") return;
  draft.value = [];
  mode.value = { ...m, tool, selected: tool === "select" ? m.selected : null };
}

export function activeSketch() {
  const m = mode.value;
  if (m.kind !== "sketch") return null;
  const f = feature(m.sketchId);
  return f?.type === "sketch" ? f : null;
}

export function setProfiles(profiles: Profile[], record = true) {
  const sk = activeSketch();
  if (!sk) return;
  const next = withPatch(doc.value, sk.id, { profiles } as Partial<Feature>);
  void (record ? commit(next) : preview(next));
}

export function addProfile(p: Profile) {
  const sk = activeSketch();
  if (sk) setProfiles([...sk.profiles, p]);
}

/** Offline clean-up: turn each recognisable ink stroke into a profile. Returns how many were left as ink. */
export function cleanUpInk(step = gridStep.value): number {
  const sk = activeSketch();
  if (!sk || !ink.value.length) return 0;
  const made: Profile[] = [];
  const left: Vec2[][] = [];
  for (const stroke of ink.value) {
    const p = recognizeStroke(stroke, step);
    if (p) made.push(p);
    else left.push(stroke);
  }
  ink.value = left;
  if (made.length) setProfiles([...sk.profiles, ...made]);
  return left.length;
}

export function finishSketch() {
  const m = mode.value;
  if (m.kind !== "sketch") return;
  const left = cleanUpInk();
  if (left) showToast(`${left} stroke${left > 1 ? "s" : ""} weren't closed shapes and were dropped`);
  ink.value = [];
  draft.value = [];
  numPrompt.value = null;
  const sk = feature(m.sketchId);
  if (sk?.type === "sketch" && !sk.profiles.length && !consumedSketches(doc.value).has(sk.id)) {
    void preview(withoutFeature(doc.value, sk.id));
    treeSelected.value = null;
  } else treeSelected.value = m.sketchId;
  mode.value = { kind: "model" };
}

export function newPart() {
  if (mode.value.kind === "sketch") mode.value = { kind: "model" };
  ink.value = [];
  draft.value = [];
  sheet.value = null;
  treeSelected.value = null;
  void commit({ name: "Part1", features: [] });
  showToast("New part. Undo brings the old one back.");
}


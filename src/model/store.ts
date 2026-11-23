// App state. Everything the UI and the viewport react to lives in signals here.
import { computed, signal } from "@preact/signals";
import { solveMates, type MateStatus } from "../assembly/mates";
import { kernel } from "../kernel/client";
import type { BodyInfo, EvalOutcome, FeatureStatus, MeshData } from "../kernel/protocol";
import {
  addModelRef,
  addProfile,
  Ids,
  makeDimension,
  makeRelation,
  removeEntities,
  sketchLoops,
  solved,
  withOrigin,
  type DimMode,
  type ModelRef,
  type RelationType,
  type SketchData,
} from "../sketch/build";
import { solveSketch } from "../sketch/solver";
import { createFile, files, initFiles, loadFile, loadPart, rememberCurrent, saveFile } from "./files";
import { frameForFace, planeFrame, planeFrames, recognizeStroke, type Frame } from "./geom2d";
import {
  defaultName,
  ID_PREFIX,
  isAssembly,
  newId,
  type AnyDoc,
  type AssemblyDoc,
  type Component,
  type Constraint,
  type Entity,
  type Feature,
  type GeoRef,
  type Mate,
  type MateType,
  type PartDoc,
  type PlaneRef,
  type Pose,
  type SketchFeature,
  type Vec2,
  type Vec3,
} from "./schema";

export type SketchTool = "select" | "line" | "rect" | "circle" | "arc" | "ink" | "dim" | "erase";
export type Mode = { kind: "model" } | { kind: "sketch"; sketchId: string; tool: SketchTool };

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
export interface VertexPick {
  point: Vec3;
}
/** Something picked on a component of an assembly, in that component's own coordinates. */
export interface AsmPick {
  component: string;
  ref: GeoRef;
  /** Identifies the picked face/edge/vertex for highlighting. */
  key: string;
  what: "face" | "edge" | "vertex";
}

export interface NumPrompt {
  title: string;
  fields: { key: string; label: string; value: number; min?: number; unit?: string }[];
  onSubmit: (values: Record<string, number>) => void;
  onDelete?: () => void;
}

/** Ids the tree uses for the three origin planes. */
export const BASE_PLANES = [
  { id: "@XY", name: "Top plane", plane: { base: "XY" } as PlaneRef },
  { id: "@XZ", name: "Front plane", plane: { base: "XZ" } as PlaneRef },
  { id: "@YZ", name: "Right plane", plane: { base: "YZ" } as PlaneRef },
];

const EMPTY_PART: PartDoc = { name: "Part1", features: [] };

export const fileId = signal("");
export const doc = signal<PartDoc>(EMPTY_PART);
export const asm = signal<AssemblyDoc | null>(null);
/** Where "back" returns to after opening a part from an assembly. */
export const returnTo = signal<string | null>(null);
export const evalStatus = signal<Record<string, FeatureStatus>>({});
export const bodyInfo = signal<BodyInfo | null>(null);
export const mesh = signal<MeshData | null>(null);
export const kernelPhase = signal<"loading" | "ready" | "busy" | "failed">("loading");
export const kernelError = signal("");
export const mode = signal<Mode>({ kind: "model" });
export const selection = signal<{ faces: FacePick[]; edges: EdgePick[]; vertices: VertexPick[] }>({ faces: [], edges: [], vertices: [] });
export const ink = signal<Vec2[][]>([]);
export const treeOpen = signal(false);
export const toolsOpen = signal(false);
/** The file browser: closed, browsing, or picking a part to insert into the open assembly. */
export const filesOpen = signal<false | "browse" | "insert">(false);
export const treeSelected = signal<string | null>(null);
export const sheet = signal<{ featureId: string; isNew: boolean } | null>(null);
export const numPrompt = signal<NumPrompt | null>(null);
export const toast = signal<{ text: string; id: number } | null>(null);
/** Bumped by the viewport whenever the camera moves, so overlays can re-project. */
export const cameraTick = signal(0);
/** Current sketch grid/snap step in mm, published by the viewport. */
export const gridStep = signal(1);

// Sketch editing
export const sketchSel = signal<string[]>([]);
export const selConstraint = signal<string | null>(null);
export const dimMode = signal<DimMode>("smart");
/** Geometry mid-drag: shown instead of the stored sketch until the finger lifts. */
export const liveSketch = signal<Entity[] | null>(null);

// Assemblies
export const asmMeshes = signal<Record<string, MeshData | null>>({});
export const asmSel = signal<AsmPick[]>([]);
export const asmInfo = signal<{ mates: Record<string, MateStatus>; dof: number; converged: boolean }>({ mates: {}, dof: 0, converged: true });

const histTick = signal(0);
let past: AnyDoc[] = [];
let future: AnyDoc[] = [];
export const canUndo = computed(() => (histTick.value, past.length > 0 || ink.value.length > 0));
export const canRedo = computed(() => (histTick.value, future.length > 0));

let toastSeq = 0;
export function showToast(text: string) {
  const id = ++toastSeq;
  toast.value = { text, id };
  setTimeout(() => {
    if (toast.value?.id === id) toast.value = null;
  }, 3400);
}

export const NO_SELECTION = { faces: [], edges: [], vertices: [] };
export const clearSelection = () => {
  const s = selection.value;
  if (s.faces.length || s.edges.length || s.vertices.length) selection.value = NO_SELECTION;
  if (asmSel.value.length) asmSel.value = [];
};

// ---------------------------------------------------------------------------
// Part evaluation: one kernel run at a time, always converging on the latest doc.

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
      out = asm.value ? { status: {}, body: null, mesh: null } : await kernel.evaluate(doc.value.features);
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
      const s = selection.value;
      if (s.faces.length || s.edges.length || s.vertices.length) selection.value = NO_SELECTION;
    }
    for (const w of mine) w(out);
    if (!queued) break;
  }
  running = false;
}

const settled = (): EvalOutcome => ({ status: evalStatus.value, body: bodyInfo.value, mesh: mesh.value });

function setCurrent(next: AnyDoc): Promise<EvalOutcome> {
  if (isAssembly(next)) {
    asm.value = next;
    if (fileId.value) saveFile(fileId.value, next);
    void loadAsmMeshes();
    return Promise.resolve(settled());
  }
  const sameGeometry = next.features === doc.value.features;
  doc.value = next;
  if (fileId.value) saveFile(fileId.value, next);
  return sameGeometry ? Promise.resolve(settled()) : requestEval();
}

const current = (): AnyDoc => asm.value ?? doc.value;

/** Apply a change and record it for undo. */
export function commit(next: AnyDoc): Promise<EvalOutcome> {
  past.push(current());
  if (past.length > 100) past.shift();
  future = [];
  histTick.value++;
  return setCurrent(next);
}

/** Apply a change without an undo entry (live previews while a sheet is open). */
export function preview(next: AnyDoc): Promise<EvalOutcome> {
  return setCurrent(next);
}

export function pushUndo(snapshot: AnyDoc) {
  past.push(snapshot);
  future = [];
  histTick.value++;
}

function leaveSketch() {
  ink.value = [];
  liveSketch.value = null;
  sketchSel.value = [];
  selConstraint.value = null;
  numPrompt.value = null;
  mode.value = { kind: "model" };
}

function afterHistoryJump() {
  histTick.value++;
  const m = mode.value;
  if (m.kind === "sketch") {
    if (!doc.value.features.some((f) => f.id === m.sketchId)) leaveSketch();
    else {
      sketchSel.value = [];
      selConstraint.value = null;
      liveSketch.value = null;
    }
  }
  sheet.value = null;
  numPrompt.value = null;
  asmSel.value = [];
}

export function undo() {
  if (ink.value.length) {
    ink.value = ink.value.slice(0, -1);
    return;
  }
  const prev = past.pop();
  if (!prev) return;
  future.push(current());
  void setCurrent(prev);
  afterHistoryJump();
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(current());
  void setCurrent(next);
  afterHistoryJump();
}

// ---------------------------------------------------------------------------
// Files

export function openFile(id: string) {
  const loaded = loadFile(id);
  if (!loaded) return;
  if (mode.value.kind === "sketch") leaveSketch();
  past = [];
  future = [];
  histTick.value++;
  sheet.value = null;
  numPrompt.value = null;
  treeSelected.value = null;
  selection.value = NO_SELECTION;
  asmSel.value = [];
  filesOpen.value = false;
  treeOpen.value = false;
  toolsOpen.value = false;
  fileId.value = id;
  rememberCurrent(id);
  if (isAssembly(loaded)) {
    asm.value = solveAssembly(loaded);
    doc.value = EMPTY_PART;
    evalStatus.value = {};
    bodyInfo.value = null;
    mesh.value = null;
    void loadAsmMeshes();
  } else {
    asm.value = null;
    doc.value = loaded;
    mesh.value = null;
    bodyInfo.value = null;
    if (kernelPhase.value !== "loading") void requestEval();
  }
}

export function newFile(kind: "part" | "assembly", parent: string | null = null) {
  returnTo.value = null;
  openFile(createFile(kind, parent).id);
}

export function initApp() {
  const first = initFiles();
  openFile(first.id);
  kernel.init().then(
    () => {
      kernelPhase.value = "ready";
      if (asm.value) void loadAsmMeshes();
      else void requestEval();
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

const hasProfile = (f: Feature) => f.type === "sketch" && sketchLoops(f.entities).loops.length > 0;

/** The sketch a new extrude/revolve should use: the one picked in the tree, else the newest unused one. */
export function sketchForNewFeature(): string | null {
  const d = doc.value;
  const picked = feature(treeSelected.value);
  if (picked && hasProfile(picked)) return picked.id;
  const used = consumedSketches(d);
  const sketches = d.features.filter((f) => hasProfile(f) && !f.suppressed);
  const unused = sketches.filter((s) => !used.has(s.id));
  return (unused[unused.length - 1] ?? sketches[sketches.length - 1])?.id ?? null;
}

/** Frames of the part's reference planes, for drawing and for sketches that sit on them. */
export const frames = computed(() => planeFrames(doc.value.features));

export function frameOf(sk: SketchFeature): Frame | null {
  try {
    return planeFrame(sk.plane, frames.value);
  } catch {
    return null;
  }
}

/** The plane a tree selection stands for: an origin plane or a plane feature. */
export function selectedPlane(): { ref: PlaneRef; frame: Frame; name: string } | null {
  const id = treeSelected.value;
  const base = BASE_PLANES.find((b) => b.id === id);
  if (base) return { ref: base.plane, frame: planeFrame(base.plane), name: base.name };
  const f = feature(id);
  const frame = f?.type === "plane" ? frames.value.get(f.id) : undefined;
  return f && frame ? { ref: { feature: f.id }, frame, name: f.name ?? f.id } : null;
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
  treeSelected.value = f.type === "plane" ? id : null;
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
  const { doc: next, id } = withFeature(doc.value, { type: "sketch", plane, entities: withOrigin([]), constraints: [] });
  void commit(next);
  ink.value = [];
  sheet.value = null;
  selection.value = NO_SELECTION;
  sketchSel.value = [];
  selConstraint.value = null;
  treeSelected.value = null;
  mode.value = { kind: "sketch", sketchId: id, tool: "line" };
  treeOpen.value = false;
  toolsOpen.value = false;
}

export function startSketchOnFace(face: FacePick) {
  const f = frameForFace(face.center, face.normal);
  startSketch({ origin: f.origin, normal: f.n, xDir: f.x });
}

export function editSketch(id: string) {
  // Sketches made by Claude or by older versions get the origin point on first edit.
  const f = feature(id);
  if (f?.type === "sketch" && !f.entities.some((e) => e.id === "origin")) void preview(withPatch(doc.value, id, { entities: withOrigin(f.entities) } as Partial<Feature>));
  ink.value = [];
  sheet.value = null;
  sketchSel.value = [];
  selConstraint.value = null;
  selection.value = NO_SELECTION;
  mode.value = { kind: "sketch", sketchId: id, tool: "select" };
  treeOpen.value = false;
  toolsOpen.value = false;
}

export function setTool(tool: SketchTool) {
  const m = mode.value;
  if (m.kind !== "sketch") return;
  if (tool === "dim" || m.tool === "dim") sketchSel.value = [];
  selConstraint.value = null;
  numPrompt.value = null;
  mode.value = { ...m, tool };
}

export function activeSketch(): SketchFeature | null {
  const m = mode.value;
  if (m.kind !== "sketch") return null;
  const f = feature(m.sketchId);
  return f?.type === "sketch" ? f : null;
}

export const activeFrame = computed(() => {
  const sk = activeSketch();
  return sk ? frameOf(sk) : null;
});

/** Solve state of the sketch being edited: what is still free, what failed, whether it closes. */
export const sketchInfo = computed(() => {
  const sk = activeSketch();
  if (!sk) return null;
  const r = solveSketch(sk.entities, sk.constraints);
  const { loops, open } = sketchLoops(sk.entities);
  const curves = sk.entities.filter((e) => e.type !== "point" && !e.construction && !(e.type === "line" && e.ref)).length;
  return { dof: r.dof, free: r.free, ok: r.ok, failed: r.failed, loops: loops.length, open, curves };
});

/**
 * Changes the open sketch and re-solves it. The edit is rejected (and
 * explained) if the result cannot satisfy every relation and dimension, so a
 * sketch never ends up in a contradictory state.
 */
export function editSketchData(change: (d: SketchData, ids: Ids) => void | false, opts: { record?: boolean; quiet?: boolean } = {}): boolean {
  const sk = activeSketch();
  if (!sk) return false;
  const data: SketchData = { entities: sk.entities.map((e) => ({ ...e })), constraints: sk.constraints.map((c) => ({ ...c })) };
  if (change(data, new Ids(data)) === false) return false;
  const r = solved({ ...sk, ...data });
  if (!r.ok) {
    if (!opts.quiet) showToast(r.error ?? "That would over-define the sketch");
    return false;
  }
  const next = withPatch(doc.value, sk.id, { entities: r.feature.entities, constraints: r.feature.constraints } as Partial<Feature>);
  void (opts.record === false ? preview(next) : commit(next));
  return true;
}

export function addRelation(type: RelationType) {
  const sel = sketchSel.value;
  const done = editSketchData((d, ids) => {
    const c = makeRelation(d.entities, sel, type, ids.get("k"));
    if (!c) return false;
    d.constraints.push(c);
  });
  if (done) sketchSel.value = [];
}

const DIM_TITLE: Record<string, string> = { distance: "Distance", radius: "Radius", diameter: "Diameter", angle: "Angle" };

export function promptDimension(id: string) {
  const sk = activeSketch();
  const c = sk?.constraints.find((k) => k.id === id);
  if (!c || !("value" in c)) return;
  const axis = c.type === "distance" && c.mode && c.mode !== "aligned" ? ` (${c.mode})` : "";
  selConstraint.value = id;
  numPrompt.value = {
    title: `${DIM_TITLE[c.type]}${axis}`,
    fields: [{ key: "v", label: "Value", value: c.value, min: c.type === "angle" ? undefined : 0, unit: c.type === "angle" ? "°" : "mm" }],
    onSubmit: ({ v }) => {
      selConstraint.value = null;
      setDimension(id, v);
    },
    onDelete: () => {
      numPrompt.value = null;
      deleteConstraint(id);
    },
  };
}

/** Adds a driving dimension for the selection at its current size, then asks for the value. */
export function addDimension(m: DimMode = dimMode.value) {
  const sel = sketchSel.value;
  let made: Constraint | null = null;
  const done = editSketchData((d, ids) => {
    made = makeDimension(d.entities, sel, m, ids.get("d"));
    if (!made) return false;
    d.constraints.push(made);
  });
  if (!done || !made) {
    if (!made) showToast("Pick a line, a circle, or two things to dimension between");
    return;
  }
  sketchSel.value = [];
  promptDimension((made as Constraint).id);
}

export function setDimension(id: string, value: number) {
  editSketchData((d) => {
    const c = d.constraints.find((k) => k.id === id);
    if (!c || !("value" in c)) return false;
    c.value = c.type === "angle" ? value : Math.max(0, value);
  });
}

export function deleteConstraint(id: string) {
  selConstraint.value = null;
  editSketchData((d) => {
    d.constraints = d.constraints.filter((c) => c.id !== id);
  });
}

export function deleteSketchSelection() {
  const sel = sketchSel.value;
  if (!sel.length) return;
  sketchSel.value = [];
  editSketchData((d) => {
    const next = removeEntities(d, sel);
    d.entities = next.entities;
    d.constraints = next.constraints;
  });
}

export function toggleConstruction() {
  const sel = new Set(sketchSel.value);
  editSketchData((d) => {
    for (const e of d.entities) if (sel.has(e.id) && e.type !== "point" && !(e.type === "line" && e.ref)) e.construction = !e.construction;
  });
  sketchSel.value = [];
}

/** Brings model geometry into the open sketch as a reference and returns its id. */
export function referenceModel(ref: ModelRef): string | null {
  const frame = activeFrame.value;
  if (!frame) return null;
  let id: string | null = null;
  let error = "";
  editSketchData((d) => {
    const r = addModelRef(d, frame, ref);
    if ("error" in r) {
      error = r.error;
      return false;
    }
    id = r.id;
  });
  if (error) showToast(error);
  return id;
}

/** Offline clean-up: turn each recognisable ink stroke into geometry. Returns how many were left as ink. */
export function cleanUpInk(step = gridStep.value): number {
  const sk = activeSketch();
  if (!sk || !ink.value.length) return 0;
  const left: Vec2[][] = [];
  const shapes = ink.value.flatMap((stroke) => {
    const p = recognizeStroke(stroke, step);
    if (!p) left.push(stroke);
    return p ? [p] : [];
  });
  ink.value = left;
  if (shapes.length)
    editSketchData((d) => {
      for (const p of shapes) addProfile(d, p, false);
    });
  return left.length;
}

export function finishSketch() {
  const m = mode.value;
  if (m.kind !== "sketch") return;
  const left = cleanUpInk();
  if (left) showToast(`${left} stroke${left > 1 ? "s" : ""} weren't closed shapes and were dropped`);
  const sk = feature(m.sketchId);
  leaveSketch();
  if (sk?.type === "sketch" && !sk.entities.some((e) => e.id !== "origin") && !consumedSketches(doc.value).has(sk.id)) {
    void preview(withoutFeature(doc.value, sk.id));
    treeSelected.value = null;
  } else treeSelected.value = m.sketchId;
}

// ---------------------------------------------------------------------------
// Assemblies

const IDENTITY: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };

/** Runs the mate solver and writes the solved poses back into the components. */
export function solveAssembly(a: AssemblyDoc): AssemblyDoc {
  const r = solveMates(
    a.components.map((c) => ({ id: c.id, pose: c.pose, fixed: c.fixed })),
    a.mates.filter((m) => !m.suppressed).map((m) => ({ id: m.id, type: m.type, a: m.a, b: m.b, value: m.value, flip: m.flip })),
  );
  asmInfo.value = { mates: r.mates, dof: r.dof, converged: r.converged };
  return { ...a, components: a.components.map((c) => ({ ...c, pose: r.poses[c.id] ?? c.pose })) };
}

const meshStamp = new Map<string, number>();

/** Builds (or reuses) the mesh of every part the open assembly uses. */
async function loadAsmMeshes() {
  const a = asm.value;
  if (!a || kernelPhase.value === "loading" || kernelPhase.value === "failed") return;
  for (const partId of new Set(a.components.map((c) => c.part))) {
    const stamp = files.value.find((f) => f.id === partId)?.updated ?? 0;
    if (meshStamp.get(partId) === stamp && partId in asmMeshes.value) continue;
    const part = loadPart(partId);
    let built: MeshData | null = null;
    if (part) {
      kernelPhase.value = "busy";
      try {
        built = (await kernel.evaluate(part.features)).mesh;
      } catch {
        built = null;
      }
      kernelPhase.value = "ready";
    }
    meshStamp.set(partId, stamp);
    asmMeshes.value = { ...asmMeshes.value, [partId]: built };
  }
}

function commitAsm(next: AssemblyDoc, record = true) {
  const solvedDoc = solveAssembly(next);
  void (record ? commit(solvedDoc) : preview(solvedDoc));
}

/** Largest world x reached by any component already placed, so a new part can go beside them. */
function assemblyMaxX(a: AssemblyDoc): number {
  let max = -Infinity;
  for (const c of a.components) {
    const data = asmMeshes.value[c.part];
    if (!data) continue;
    const [qx, qy, qz, qw] = c.pose.q;
    // First row of the rotation matrix gives world x of a local point.
    const r = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)];
    for (let i = 0; i < data.positions.length; i += 3) {
      const x = r[0] * data.positions[i] + r[1] * data.positions[i + 1] + r[2] * data.positions[i + 2] + c.pose.p[0];
      if (x > max) max = x;
    }
  }
  return Number.isFinite(max) ? max : 0;
}

export function insertComponent(partId: string) {
  const a = asm.value;
  const entry = files.value.find((f) => f.id === partId);
  if (!a || !entry) return;
  const n = a.components.filter((c) => c.part === partId).length + 1;
  const used = new Set(a.components.map((c) => c.id));
  let k = a.components.length + 1;
  while (used.has(`c${k}`)) k++;
  const first = a.components.length === 0;
  // Later parts are set to one side so they do not land inside the first one.
  const comp: Component = {
    id: `c${k}`,
    name: `${entry.name}<${n}>`,
    part: partId,
    pose: first ? IDENTITY : { p: [Math.ceil(assemblyMaxX(a) / 10) * 10 + 30, 0, 0], q: [0, 0, 0, 1] },
    ...(first ? { fixed: true } : {}),
  };
  commitAsm({ ...a, components: [...a.components, comp] });
  filesOpen.value = false;
}

const MATE_NAME: Record<MateType, string> = {
  coincident: "Coincident",
  concentric: "Concentric",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  distance: "Distance",
  angle: "Angle",
  lock: "Lock",
};

/** Mates the two picked pieces of geometry. Rejected, with the reason, if the solver cannot satisfy it. */
export function addMate(type: MateType) {
  const a = asm.value;
  const [first, second] = asmSel.value;
  if (!a || !first || !second) return showToast("Pick geometry on two different parts first");
  if (first.component === second.component) return showToast("A mate needs two different parts");
  const taken = new Set(a.mates.map((m) => m.name));
  let n = 1;
  while (taken.has(`${MATE_NAME[type]}${n}`)) n++;
  const used = new Set(a.mates.map((m) => m.id));
  let k = a.mates.length + 1;
  while (used.has(`m${k}`)) k++;
  const mate: Mate = {
    id: `m${k}`,
    name: `${MATE_NAME[type]}${n}`,
    type,
    a: { component: first.component, ref: first.ref },
    b: { component: second.component, ref: second.ref },
    ...(type === "distance" ? { value: 10 } : type === "angle" ? { value: 90 } : {}),
  };
  const next = solveAssembly({ ...a, mates: [...a.mates, mate] });
  const status = asmInfo.value.mates[mate.id];
  if (status && !status.ok) {
    solveAssembly(a);
    return showToast(status.error ?? "That mate conflicts with the others");
  }
  void commit(next);
  asmSel.value = [];
  if (type === "distance" || type === "angle") promptMate(mate.id);
}

export function promptMate(id: string) {
  const m = asm.value?.mates.find((x) => x.id === id);
  if (!m || (m.type !== "distance" && m.type !== "angle")) return;
  numPrompt.value = {
    title: m.name,
    fields: [{ key: "v", label: m.type === "angle" ? "Angle" : "Distance", value: m.value ?? 0, min: m.type === "distance" ? 0 : undefined, unit: m.type === "angle" ? "°" : "mm" }],
    onSubmit: ({ v }) => patchMate(id, { value: v }),
  };
}

export function patchMate(id: string, patch: Partial<Mate>) {
  const a = asm.value;
  if (!a) return;
  const next = solveAssembly({ ...a, mates: a.mates.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const status = asmInfo.value.mates[id];
  if (status && !status.ok && !patch.suppressed) {
    solveAssembly(a);
    return showToast(status.error ?? "That value conflicts with the other mates");
  }
  void commit(next);
}

export function deleteMate(id: string) {
  const a = asm.value;
  if (a) commitAsm({ ...a, mates: a.mates.filter((m) => m.id !== id) });
}

export function patchComponent(id: string, patch: Partial<Component>, record = true) {
  const a = asm.value;
  if (a) commitAsm({ ...a, components: a.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, record);
}

export function deleteComponent(id: string) {
  const a = asm.value;
  if (!a) return;
  commitAsm({ ...a, components: a.components.filter((c) => c.id !== id), mates: a.mates.filter((m) => m.a.component !== id && m.b.component !== id) });
  asmSel.value = [];
}

/** Opens a component's part for editing, remembering the assembly to come back to. */
export function openComponentPart(id: string) {
  const comp = asm.value?.components.find((c) => c.id === id);
  if (!comp) return;
  const back = fileId.value;
  openFile(comp.part);
  returnTo.value = back;
}

export function goBack() {
  const to = returnTo.value;
  returnTo.value = null;
  if (to) openFile(to);
}

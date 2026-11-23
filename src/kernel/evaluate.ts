// Turns the feature list into B-rep geometry with replicad (OpenCascade).
// Pure with respect to the DOM so it runs in a Web Worker and in Node tests.
// The caller must have called replicad's setOC() first.
import {
  draw,
  drawCircle,
  drawRoundedRectangle,
  FaceFinder,
  measureVolume,
  Plane,
  type Drawing,
  type Edge,
  type Face,
  type Shape3D,
} from "replicad";
import { nestingOf, planeFrame, planeFeatureFrame, v3, type Frame } from "../model/geom2d";
import { loopPolygon, sketchLoops, type Loop } from "../sketch/build";
import type {
  Axis,
  EdgeSel,
  ExtrudeFeature,
  FaceSel,
  Feature,
  RevolveFeature,
  SketchFeature,
  Vec3,
} from "../model/schema";

export interface FeatureStatus {
  ok: boolean;
  error?: string;
  suppressed?: boolean;
}

export interface BodyInfo {
  bbox: { min: Vec3; max: Vec3 };
  volume: number;
  faces: number;
  edges: number;
}

export interface EvalResult {
  shape: Shape3D | null;
  status: Record<string, FeatureStatus>;
  body: BodyInfo | null;
}

const AXIS: Record<Axis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const AXIS_INDEX: Record<Axis, number> = { X: 0, Y: 1, Z: 2 };
const TOL = 1e-4;

function loopDrawing(loop: Loop): Drawing {
  if (loop.kind === "circle") return drawCircle(loop.r).translate(loop.c[0], loop.c[1]);
  // Start on a line when there is one, so the pen's closing segment is the straight one.
  const segs = loop.segs.slice();
  const lineAt = segs.findIndex((s) => s.kind === "line");
  if (lineAt >= 0) segs.push(...segs.splice(0, lineAt + 1));
  let pen = draw(segs[0].a);
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s.kind === "arc") pen = pen.threePointsArcTo(s.b, s.mid);
    else if (!last) pen = pen.lineTo(s.b);
  });
  return pen.close();
}

/** Union of the outer loops minus the nested ones (holes), by nesting depth. */
function sketchDrawing(sk: SketchFeature): Drawing {
  const { loops } = sketchLoops(sk.entities);
  if (!loops.length) throw new Error("sketch has no closed profile to use (lines must join end to end into a loop)");
  const depths = nestingOf(loops.map((l) => loopPolygon(l, 32)));
  const order = loops.map((_, i) => i).sort((a, b) => depths[a] - depths[b]);
  let result: Drawing | null = null;
  for (const i of order) {
    const d = loopDrawing(loops[i]);
    if (!result) result = d;
    else result = depths[i] % 2 === 0 ? result.fuse(d) : result.cut(d);
  }
  return result!;
}

function replicadPlane(f: Frame): Plane {
  return new Plane(f.origin, f.x, f.n);
}

function bboxOf(shape: Shape3D): { min: Vec3; max: Vec3 } {
  const [min, max] = shape.boundingBox.bounds;
  return { min: [...min] as Vec3, max: [...max] as Vec3 };
}

function solidFromSketch(sk: SketchFeature, frame: Frame, distance: number): Shape3D {
  const sketch = sketchDrawing(sk).sketchOnPlane(replicadPlane(frame)) as {
    extrude(d: number): Shape3D;
  };
  return sketch.extrude(distance);
}

function extrude(f: ExtrudeFeature, sk: SketchFeature, frame: Frame, body: Shape3D | null): Shape3D {
  let dir = f.direction ?? "auto";
  if (dir === "auto") {
    dir = "normal";
    if (f.op === "cut" && body) {
      const b = bboxOf(body);
      const c = v3.scale(v3.add(b.min, b.max), 0.5);
      if (v3.dot(v3.sub(c, frame.origin), frame.n) < 0) dir = "reverse";
    }
  }
  let dist = f.distance;
  if (f.throughAll && f.op === "cut" && body) {
    const b = bboxOf(body);
    // Farther than any point of the body can be from the sketch plane.
    dist = v3.len(v3.sub(b.max, b.min)) + v3.len(v3.sub(v3.scale(v3.add(b.min, b.max), 0.5), frame.origin)) + 1;
  }
  let solid: Shape3D;
  if (dir === "symmetric") {
    const total = f.throughAll && f.op === "cut" ? dist * 2 : dist;
    const shifted = { ...frame, origin: v3.sub(frame.origin, v3.scale(frame.n, total / 2)) };
    solid = solidFromSketch(sk, shifted, total);
  } else {
    solid = solidFromSketch(sk, frame, dir === "reverse" ? -dist : dist);
  }
  return combine(body, solid, f.op);
}

function revolve(f: RevolveFeature, sk: SketchFeature, frame: Frame, body: Shape3D | null): Shape3D {
  const off = f.axisOffset ?? 0;
  const axisDir = f.axis === "x" ? frame.x : frame.y;
  const origin = v3.add(frame.origin, v3.scale(f.axis === "x" ? frame.y : frame.x, off));
  const made = sketchDrawing(sk).sketchOnPlane(replicadPlane(frame)) as unknown as {
    sketches?: { revolve(a: Vec3, o: { origin: Vec3; angle: number }): Shape3D }[];
    revolve?(a: Vec3, o: { origin: Vec3; angle: number }): Shape3D;
  };
  const opts = { origin, angle: f.angle ?? 360 };
  let solid: Shape3D | null = null;
  if (made.revolve) solid = made.revolve(axisDir, opts);
  else
    for (const s of made.sketches ?? []) {
      const part = s.revolve(axisDir, opts);
      solid = solid ? solid.fuse(part) : part;
    }
  if (!solid) throw new Error("nothing to revolve");
  return combine(body, solid, f.op);
}

function combine(body: Shape3D | null, tool: Shape3D, op: "add" | "cut"): Shape3D {
  if (op === "cut") {
    if (!body) throw new Error("nothing to cut from yet — add material first");
    return body.cut(tool);
  }
  return body ? body.fuse(tool) : tool;
}

function edgeSamples(e: Edge, n = 9): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = e.pointAt(i / (n - 1));
    out.push([p.x, p.y, p.z]);
    p.delete();
  }
  return out;
}

function selectEdges(shape: Shape3D, sel: EdgeSel): Edge[] {
  let cands = realEdges(shape).map((e) => ({ e, pts: edgeSamples(e) }));
  if (sel.parallelTo) {
    const a = AXIS[sel.parallelTo];
    cands = cands.filter(({ pts }) => {
      const d = v3.sub(pts[pts.length - 1], pts[0]);
      const len = v3.len(d);
      if (len < TOL) return false;
      // Straight and aligned: every sample stays on the chord, chord ∥ axis.
      if (Math.abs(Math.abs(v3.dot(d, a)) / len - 1) > 1e-6) return false;
      return pts.every((p) => v3.len(v3.cross(v3.sub(p, pts[0]), a)) < TOL * 10);
    });
  }
  if (sel.onPlane) {
    const i = AXIS_INDEX[sel.onPlane.normal];
    const at = sel.onPlane.at;
    cands = cands.filter(({ pts }) => pts.every((p) => Math.abs(p[i] - at) < 1e-3));
  }
  if (sel.near?.length) {
    const picked = new Set<number>();
    for (const q of sel.near as Vec3[]) {
      let best = -1;
      let bestD = Infinity;
      cands.forEach(({ pts }, idx) => {
        for (const p of pts) {
          const d = v3.len(v3.sub(p, q));
          if (d < bestD) {
            bestD = d;
            best = idx;
          }
        }
      });
      if (best >= 0) picked.add(best);
    }
    cands = cands.filter((_, idx) => picked.has(idx));
  }
  return cands.map((c) => c.e);
}

function selectFaces(shape: Shape3D, sel: FaceSel): Face[] {
  if (!sel.onPlane && !sel.near?.length) throw new Error("no faces specified");
  const faces = shape.faces;
  const picked = new Set<number>();
  if (sel.onPlane) {
    const i = AXIS_INDEX[sel.onPlane.normal];
    faces.forEach((f, idx) => {
      if (f.geomType !== "PLANE") return;
      const c = f.center;
      const n = f.normalAt();
      if (Math.abs([c.x, c.y, c.z][i] - sel.onPlane!.at) < 1e-3 && Math.abs(Math.abs([n.x, n.y, n.z][i]) - 1) < 1e-6)
        picked.add(idx);
      c.delete();
      n.delete();
    });
  }
  for (const q of (sel.near ?? []) as Vec3[]) {
    // Prefer the face the point actually lies on; fall back to the nearest face centre.
    const hit = new FaceFinder().containsPoint(q).find(shape);
    let found = -1;
    if (hit.length) found = faces.findIndex((f) => f.isSame(hit[0]));
    if (found < 0) {
      let bestD = Infinity;
      faces.forEach((f, idx) => {
        const c = f.center;
        const d = v3.len(v3.sub([c.x, c.y, c.z], q));
        c.delete();
        if (d < bestD) {
          bestD = d;
          found = idx;
        }
      });
    }
    if (found >= 0) picked.add(found);
  }
  return faces.filter((_, idx) => picked.has(idx));
}

function requireBody(body: Shape3D | null, what: string): Shape3D {
  if (!body) throw new Error(`${what} needs a solid body first`);
  return body;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  // OpenCascade throws raw pointers (numbers) for geometric failures.
  if (typeof e === "number") return "geometry kernel could not build this (check sizes and selections)";
  return String(e);
}

export function evaluate(features: Feature[]): EvalResult {
  let body: Shape3D | null = null;
  const sketches = new Map<string, SketchFeature>();
  const planes = new Map<string, Frame>();
  const status: Record<string, FeatureStatus> = {};

  const sketchFor = (id: string): SketchFeature => {
    const sk = sketches.get(id);
    if (!sk) throw new Error(`sketch "${id}" not found before this feature (missing, later in the tree, suppressed or invalid)`);
    return sk;
  };
  const frameOf = (sk: SketchFeature): Frame => planeFrame(sk.plane, planes);

  for (const f of features) {
    if (f.suppressed) {
      status[f.id] = { ok: true, suppressed: true };
      continue;
    }
    try {
      switch (f.type) {
        case "plane":
          planes.set(f.id, planeFeatureFrame(f, planes));
          break;
        case "sketch":
          frameOf(f); // surface a missing plane here, not at the extrude
          sketches.set(f.id, f);
          break;
        case "extrude":
          body = extrude(f, sketchFor(f.sketch), frameOf(sketchFor(f.sketch)), body);
          break;
        case "revolve":
          body = revolve(f, sketchFor(f.sketch), frameOf(sketchFor(f.sketch)), body);
          break;
        case "fillet":
        case "chamfer": {
          const b = requireBody(body, f.type);
          const edges = selectEdges(b, f.edges);
          if (!edges.length) throw new Error("no edges match the selection");
          const size = f.type === "fillet" ? f.radius : f.distance;
          const pick = (e: Edge) => (edges.some((x) => x.isSame(e)) ? size : null);
          body = f.type === "fillet" ? b.fillet(pick) : b.chamfer(pick);
          break;
        }
        case "shell": {
          const b = requireBody(body, "shell");
          const faces = selectFaces(b, f.openFaces);
          if (!faces.length) throw new Error("no faces match the selection");
          body = b.shell({ filter: new FaceFinder().inList(faces), thickness: f.thickness });
          break;
        }
      }
      status[f.id] = { ok: true };
    } catch (e) {
      status[f.id] = { ok: false, error: errText(e) };
    }
  }

  let info: BodyInfo | null = null;
  if (body) {
    try {
      info = { bbox: bboxOf(body), volume: measureVolume(body), faces: body.faces.length, edges: realEdges(body).length };
    } catch {
      info = null;
    }
  }
  return { shape: body, status, body: info };
}

/**
 * The edges of a shape that are real corners. Leaves out artefacts of how
 * surfaces are stored: the seam where a cylinder or sphere closes on itself
 * (one adjacent face), and the join between two pieces of the same smooth
 * surface, such as the two half-cylinders a circular hole is built from.
 * Tangent edges between different surface types (a fillet meeting a flat
 * face) are real and kept.
 */
export function realEdges(shape: Shape3D): Edge[] {
  const adjacent = new Map<number, { edge: Edge; faces: Face[] }>();
  for (const face of shape.faces)
    for (const edge of face.edges) {
      const entry = adjacent.get(edge.hashCode);
      if (entry) entry.faces.push(face);
      else adjacent.set(edge.hashCode, { edge, faces: [face] });
    }
  const out: Edge[] = [];
  for (const { edge, faces } of adjacent.values()) {
    if (faces.length === 1) continue;
    const [a, b] = faces;
    if (faces.length === 2 && a.geomType === b.geomType) {
      try {
        const mid = edge.pointAt(0.5);
        const na = a.normalAt(mid);
        const nb = b.normalAt(mid);
        const smooth = Math.abs(na.x * nb.x + na.y * nb.y + na.z * nb.z) > 0.9999;
        mid.delete();
        na.delete();
        nb.delete();
        if (smooth) continue;
      } catch {
        // If the surfaces cannot be evaluated here, treat the edge as real.
      }
    }
    out.push(edge);
  }
  return out;
}

/** Tessellated edge groups restricted to the real edges, for drawing and picking. */
export function realEdgeGroups<G extends { edgeId: number }>(shape: Shape3D, groups: G[]): G[] {
  const real = new Set(realEdges(shape).map((e) => e.hashCode));
  return groups.filter((g) => real.has(g.edgeId));
}

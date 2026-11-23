// Everything about sketch content that is not the solver itself: creating
// entities, expanding whole shapes into constrained geometry, finding the
// closed loops an extrude can use, and deciding what a dimension or relation
// between selected things should mean.
import { toPlane, v3, type Frame } from "../model/geom2d";
import type {
  ArcEntity,
  CircleEntity,
  Constraint,
  ConstraintType,
  Entity,
  LineEntity,
  PointEntity,
  Profile,
  SketchFeature,
  Vec2,
  Vec3,
} from "../model/schema";
import { solveSketch } from "./solver";

export interface SketchData {
  entities: Entity[];
  constraints: Constraint[];
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Hands out ids that are unused in a sketch: p1, p2… for points, l/c/a for curves, k for constraints. */
export class Ids {
  private used = new Set<string>();
  private next: Record<string, number> = {};
  constructor(data: SketchData) {
    for (const e of data.entities) this.used.add(e.id);
    for (const c of data.constraints) this.used.add(c.id);
  }
  get(prefix: string): string {
    let n = this.next[prefix] ?? 1;
    while (this.used.has(`${prefix}${n}`)) n++;
    this.next[prefix] = n + 1;
    const id = `${prefix}${n}`;
    this.used.add(id);
    return id;
  }
}

export const byId = (entities: Entity[]) => new Map(entities.map((e) => [e.id, e]));

export function pointXY(map: Map<string, Entity>, id: string): Vec2 {
  const p = map.get(id);
  return p?.type === "point" ? [p.x, p.y] : [0, 0];
}

/** Adds a shape's entities and constraints to a sketch, in place, and returns the ids created. */
class Pen {
  readonly ids: Ids;
  constructor(readonly data: SketchData) {
    this.ids = new Ids(data);
  }
  point(x: number, y: number, extra: Partial<PointEntity> = {}): string {
    const id = this.ids.get("p");
    this.data.entities.push({ id, type: "point", x: r4(x), y: r4(y), ...extra });
    return id;
  }
  line(p1: string, p2: string, extra: Partial<LineEntity> = {}): string {
    const id = this.ids.get("l");
    this.data.entities.push({ id, type: "line", p1, p2, ...extra });
    return id;
  }
  circle(c: string, r: number): string {
    const id = this.ids.get("c");
    this.data.entities.push({ id, type: "circle", c, r: r4(r) });
    return id;
  }
  arc(c: string, p1: string, p2: string): string {
    const id = this.ids.get("a");
    this.data.entities.push({ id, type: "arc", c, p1, p2 });
    return id;
  }
  rel(c: Record<string, unknown> & { type: ConstraintType }) {
    this.data.constraints.push({ id: this.ids.get("k"), ...c } as Constraint);
  }
}

/**
 * Expands a whole-shape profile into points, curves, relations and
 * dimensions. With `dimensioned`, sizes get driving dimensions and one point
 * is pinned, so the result is fully defined (what Claude's shorthand wants);
 * without it only the shape relations are added (what a finger-drawn shape
 * wants, leaving it free to be dimensioned).
 */
export function addProfile(data: SketchData, p: Profile, dimensioned: boolean): string[] {
  const pen = new Pen(data);
  const start = data.entities.length;
  switch (p.type) {
    case "circle": {
      const c = pen.point(p.cx, p.cy);
      const id = pen.circle(c, p.d / 2);
      if (dimensioned) {
        pen.rel({ type: "diameter", a: id, value: r4(p.d) });
        pen.rel({ type: "fix", a: c });
      }
      break;
    }
    case "rect": {
      const a = ((p.angle ?? 0) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const at = (x: number, y: number): Vec2 => [p.cx + x * cos - y * sin, p.cy + x * sin + y * cos];
      const hw = p.w / 2;
      const hh = p.h / 2;
      const r = Math.min(p.r ?? 0, hw - 1e-6, hh - 1e-6);
      const square = Math.abs(((p.angle ?? 0) % 90) + 90) % 90 < 1e-9;
      if (r > 1e-6) {
        // Four edges and four tangent corner arcs, walking counter-clockwise from the bottom edge.
        const corners: [number, number][] = [
          [hw - r, -hh + r],
          [hw - r, hh - r],
          [-hw + r, hh - r],
          [-hw + r, -hh + r],
        ];
        const ends: [number, number, number, number][] = [
          [-hw + r, -hh, hw - r, -hh],
          [hw, -hh + r, hw, hh - r],
          [hw - r, hh, -hw + r, hh],
          [-hw, hh - r, -hw, -hh + r],
        ];
        const pts = ends.map(([x1, y1, x2, y2]) => [pen.point(...at(x1, y1)), pen.point(...at(x2, y2))]);
        const lines = pts.map(([s, e]) => pen.line(s, e));
        const arcs = corners.map(([cx, cy], i) => pen.arc(pen.point(...at(cx, cy)), pts[i][1], pts[(i + 1) % 4][0]));
        arcs.forEach((arc, i) => {
          pen.rel({ type: "tangent", a: lines[i], b: arc });
          pen.rel({ type: "tangent", a: lines[(i + 1) % 4], b: arc });
          if (i) pen.rel({ type: "equal", a: arcs[0], b: arc });
        });
        if (square && !p.angle) {
          pen.rel({ type: "horizontal", a: lines[0] });
          pen.rel({ type: "vertical", a: lines[1] });
          pen.rel({ type: "horizontal", a: lines[2] });
          pen.rel({ type: "vertical", a: lines[3] });
        } else {
          pen.rel({ type: "perpendicular", a: lines[0], b: lines[1] });
          pen.rel({ type: "parallel", a: lines[0], b: lines[2] });
          pen.rel({ type: "parallel", a: lines[1], b: lines[3] });
          if (dimensioned) pen.rel({ type: "angle", a: lines[0], value: r4(Math.abs(wrapDeg(p.angle ?? 0))) });
        }
        if (dimensioned) {
          pen.rel({ type: "distance", a: lines[0], b: lines[2], value: r4(p.h) });
          pen.rel({ type: "distance", a: lines[1], b: lines[3], value: r4(p.w) });
          pen.rel({ type: "radius", a: arcs[0], value: r4(r) });
          pen.rel({ type: "fix", a: pts[0][0] });
        }
      } else {
        const pts = [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)].map((q) => pen.point(...q));
        const lines = pts.map((q, i) => pen.line(q, pts[(i + 1) % 4]));
        if (square && !p.angle) {
          pen.rel({ type: "horizontal", a: lines[0] });
          pen.rel({ type: "vertical", a: lines[1] });
          pen.rel({ type: "horizontal", a: lines[2] });
          pen.rel({ type: "vertical", a: lines[3] });
        } else {
          pen.rel({ type: "perpendicular", a: lines[0], b: lines[1] });
          pen.rel({ type: "parallel", a: lines[0], b: lines[2] });
          pen.rel({ type: "parallel", a: lines[1], b: lines[3] });
          if (dimensioned) pen.rel({ type: "angle", a: lines[0], value: r4(Math.abs(wrapDeg(p.angle ?? 0))) });
        }
        if (dimensioned) {
          pen.rel({ type: "distance", a: lines[0], value: r4(p.w) });
          pen.rel({ type: "distance", a: lines[1], value: r4(p.h) });
          pen.rel({ type: "fix", a: pts[0] });
        }
      }
      break;
    }
    case "polygon": {
      const pts = p.points.map((q) => pen.point(q[0], q[1]));
      pts.forEach((q, i) => {
        const next = pts[(i + 1) % pts.length];
        const l = pen.line(q, next);
        const [x1, y1] = p.points[i];
        const [x2, y2] = p.points[(i + 1) % pts.length];
        if (!dimensioned && Math.abs(y2 - y1) < 1e-9 && Math.abs(x2 - x1) > 1e-9) pen.rel({ type: "horizontal", a: l });
        if (!dimensioned && Math.abs(x2 - x1) < 1e-9 && Math.abs(y2 - y1) > 1e-9) pen.rel({ type: "vertical", a: l });
        if (dimensioned) pen.rel({ type: "fix", a: q });
      });
      break;
    }
    case "slot": {
      const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      if (len < 1e-6) return addProfile(data, { type: "circle", cx: p.x1, cy: p.y1, d: p.w }, dimensioned);
      const ux = (p.x2 - p.x1) / len;
      const uy = (p.y2 - p.y1) / len;
      const nx = -uy * (p.w / 2);
      const ny = ux * (p.w / 2);
      const c1 = pen.point(p.x1, p.y1);
      const c2 = pen.point(p.x2, p.y2);
      // Right side runs c1→c2 below the axis, left side comes back above it; arcs cap the ends.
      const a = pen.point(p.x1 - nx, p.y1 - ny);
      const b = pen.point(p.x2 - nx, p.y2 - ny);
      const c = pen.point(p.x2 + nx, p.y2 + ny);
      const d = pen.point(p.x1 + nx, p.y1 + ny);
      const l1 = pen.line(a, b);
      const l2 = pen.line(c, d);
      const arc2 = pen.arc(c2, b, c);
      const arc1 = pen.arc(c1, d, a);
      for (const [l, arc] of [
        [l1, arc1],
        [l1, arc2],
        [l2, arc1],
        [l2, arc2],
      ])
        pen.rel({ type: "tangent", a: l, b: arc });
      pen.rel({ type: "equal", a: arc1, b: arc2 });
      if (dimensioned) {
        pen.rel({ type: "radius", a: arc1, value: r4(p.w / 2) });
        pen.rel({ type: "fix", a: c1 });
        pen.rel({ type: "fix", a: c2 });
      }
      break;
    }
  }
  return data.entities.slice(start).map((e) => e.id);
}

const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Stored sketches hold entities and constraints only; this folds the `profiles` shorthand into them. */
export function normalizeSketch(f: SketchFeature): SketchFeature {
  if (!f.profiles?.length) {
    if (f.profiles) {
      const { profiles: _drop, ...rest } = f;
      return rest as SketchFeature;
    }
    return f;
  }
  const data: SketchData = { entities: [...f.entities], constraints: [...f.constraints] };
  for (const p of f.profiles) addProfile(data, p, true);
  const { profiles: _drop, ...rest } = f;
  return { ...rest, ...data } as SketchFeature;
}

/** Runs the solver and writes the solved positions back. */
export function solved(f: SketchFeature): { feature: SketchFeature; ok: boolean; error?: string; dof: number } {
  const r = solveSketch(f.entities, f.constraints);
  const entities = r.entities.map((e) => (e.type === "point" ? { ...e, x: r4(e.x), y: r4(e.y) } : e.type === "circle" ? { ...e, r: r4(e.r) } : e));
  return { feature: { ...f, entities }, ok: r.ok, error: r.error, dof: r.dof };
}

/** Id of the fixed point every hand-edited sketch has at (0, 0), to dimension and constrain against. */
export const ORIGIN = "origin";

export function withOrigin(entities: Entity[]): Entity[] {
  return entities.some((e) => e.id === ORIGIN) ? entities : [{ id: ORIGIN, type: "point", x: 0, y: 0, fixed: true }, ...entities];
}

// ---------------------------------------------------------------------------
// Closed loops

export type Seg = { kind: "line"; a: Vec2; b: Vec2 } | { kind: "arc"; a: Vec2; b: Vec2; mid: Vec2; c: Vec2; r: number; ccw: boolean };
export type Loop = { kind: "path"; segs: Seg[] } | { kind: "circle"; c: Vec2; r: number };

export function arcMid(c: Vec2, a: Vec2, b: Vec2, ccw: boolean): Vec2 {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  if (ccw) while (a1 <= a0 + 1e-12) a1 += Math.PI * 2;
  else while (a1 >= a0 - 1e-12) a1 -= Math.PI * 2;
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const m = (a0 + a1) / 2;
  return [c[0] + r * Math.cos(m), c[1] + r * Math.sin(m)];
}

/**
 * Closed, non-branching chains of lines and arcs, plus full circles. Returns
 * how many real (non-construction) curves were left out because they do not
 * close, so the UI can say the profile is open.
 */
export function sketchLoops(entities: Entity[]): { loops: Loop[]; open: number } {
  const map = byId(entities);
  const key = (p: Vec2) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  type Edge = { ends: [Vec2, Vec2]; e: LineEntity | ArcEntity; used: boolean };
  const edges: Edge[] = [];
  const loops: Loop[] = [];
  for (const e of entities) {
    if (e.type === "point" || e.construction || (e.type === "line" && e.ref)) continue;
    if (e.type === "circle") loops.push({ kind: "circle", c: pointXY(map, e.c), r: e.r });
    else {
      const a = pointXY(map, e.p1);
      const b = pointXY(map, e.p2);
      if (key(a) !== key(b)) edges.push({ ends: [a, b], e, used: false });
    }
  }
  const at = new Map<string, Edge[]>();
  for (const ed of edges) for (const p of ed.ends) at.set(key(p), [...(at.get(key(p)) ?? []), ed]);

  let open = 0;
  for (const startEdge of edges) {
    if (startEdge.used) continue;
    // Collect the connected chain, then accept it only if every joint has exactly two curves.
    const chain: Edge[] = [];
    const stack = [startEdge];
    let clean = true;
    while (stack.length) {
      const ed = stack.pop()!;
      if (ed.used) continue;
      ed.used = true;
      chain.push(ed);
      for (const p of ed.ends) {
        const here = at.get(key(p))!;
        if (here.length !== 2) clean = false;
        for (const o of here) if (!o.used) stack.push(o);
      }
    }
    if (!clean || chain.length < 2) {
      open += chain.length;
      continue;
    }
    const segs: Seg[] = [];
    let cur = chain[0];
    let from = cur.ends[0];
    const seen = new Set<Edge>();
    for (let i = 0; i < chain.length; i++) {
      seen.add(cur);
      const forward = key(cur.ends[0]) === key(from);
      const to = forward ? cur.ends[1] : cur.ends[0];
      if (cur.e.type === "line") segs.push({ kind: "line", a: from, b: to });
      else {
        const c = pointXY(map, cur.e.c);
        // Stored arcs run counter-clockwise p1→p2, so walking them backwards is clockwise.
        segs.push({ kind: "arc", a: from, b: to, c, r: Math.hypot(from[0] - c[0], from[1] - c[1]), ccw: forward, mid: arcMid(c, from, to, forward) });
      }
      const next = at.get(key(to))!.find((o) => !seen.has(o));
      from = to;
      if (!next) break;
      cur = next;
    }
    if (segs.length === chain.length) loops.push({ kind: "path", segs });
    else open += chain.length;
  }
  return { loops, open };
}

/** Outline of a loop as a polygon (curves tessellated), for nesting tests, picking and fitting the view. */
export function loopPolygon(loop: Loop, segsPerTurn = 48): Vec2[] {
  if (loop.kind === "circle") return arcPoints(loop.c, loop.r, 0, Math.PI * 2, segsPerTurn).slice(0, -1);
  const out: Vec2[] = [];
  for (const s of loop.segs) {
    if (s.kind === "line") out.push(s.a);
    else {
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
      let a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
      if (s.ccw) while (a1 <= a0 + 1e-12) a1 += Math.PI * 2;
      else while (a1 >= a0 - 1e-12) a1 -= Math.PI * 2;
      out.push(...arcPoints(s.c, s.r, a0, a1, segsPerTurn).slice(0, -1));
    }
  }
  return out;
}

export function arcPoints(c: Vec2, r: number, a0: number, a1: number, segsPerTurn = 48): Vec2[] {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * segsPerTurn));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as Vec2;
  });
}

/** Polyline for drawing any curve entity. */
export function entityPolyline(e: Entity, map: Map<string, Entity>): Vec2[] {
  if (e.type === "line") return [pointXY(map, e.p1), pointXY(map, e.p2)];
  if (e.type === "circle") return arcPoints(pointXY(map, e.c), e.r, 0, Math.PI * 2, 64);
  if (e.type === "arc") {
    const c = pointXY(map, e.c);
    const a = pointXY(map, e.p1);
    const b = pointXY(map, e.p2);
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    while (a1 <= a0 + 1e-12) a1 += Math.PI * 2;
    return arcPoints(c, Math.hypot(a[0] - c[0], a[1] - c[1]), a0, a1, 64);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Editing

/** Removes entities together with anything that depends on them. */
export function removeEntities(data: SketchData, ids: string[]): SketchData {
  const gone = new Set(ids.filter((id) => id !== ORIGIN));
  // A curve goes with any of its points; a point left with nothing attached goes with its last curve.
  for (const e of data.entities) {
    if (e.type === "line" && (gone.has(e.p1) || gone.has(e.p2))) gone.add(e.id);
    if (e.type === "circle" && gone.has(e.c)) gone.add(e.id);
    if (e.type === "arc" && (gone.has(e.c) || gone.has(e.p1) || gone.has(e.p2))) gone.add(e.id);
  }
  const remaining = data.entities.filter((e) => !gone.has(e.id));
  const stillUsed = new Set<string>();
  for (const e of remaining) {
    if (e.type === "line") stillUsed.add(e.p1).add(e.p2);
    if (e.type === "circle") stillUsed.add(e.c);
    if (e.type === "arc") stillUsed.add(e.c).add(e.p1).add(e.p2);
  }
  const wasUsed = new Set<string>();
  for (const e of data.entities) {
    if (!gone.has(e.id)) continue;
    if (e.type === "line") wasUsed.add(e.p1).add(e.p2);
    if (e.type === "circle") wasUsed.add(e.c);
    if (e.type === "arc") wasUsed.add(e.c).add(e.p1).add(e.p2);
  }
  for (const p of wasUsed) if (!stillUsed.has(p) && p !== ORIGIN) gone.add(p);
  return {
    entities: data.entities.filter((e) => !gone.has(e.id)),
    constraints: data.constraints.filter((c) => !gone.has(c.a) && !("b" in c && c.b && gone.has(c.b))),
  };
}

export type RelationType = "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "equal" | "tangent" | "concentric" | "midpoint" | "fix";

/** Which relations make sense for the current selection, most likely first. */
export function relationsFor(entities: Entity[], selected: string[]): RelationType[] {
  const map = byId(entities);
  const sel = selected.map((id) => map.get(id)).filter((e): e is Entity => !!e);
  const types = sel.map((e) => e.type);
  const count = (t: Entity["type"]) => types.filter((x) => x === t).length;
  const round = count("circle") + count("arc");
  if (sel.length === 1) {
    if (types[0] === "line") return ["horizontal", "vertical", "fix"];
    return ["fix"];
  }
  if (sel.length !== 2) return [];
  if (count("point") === 2) return ["coincident", "horizontal", "vertical"];
  if (count("point") === 1 && count("line") === 1) return ["coincident", "midpoint"];
  if (count("point") === 1 && round === 1) return ["coincident"];
  if (count("line") === 2) return ["parallel", "perpendicular", "equal", "coincident"];
  if (count("line") === 1 && round === 1) return ["tangent"];
  if (round === 2) return ["tangent", "concentric", "equal"];
  return [];
}

/** Builds the relation for a selection, ordering operands the way the solver expects. */
export function makeRelation(entities: Entity[], selected: string[], type: RelationType, id: string): Constraint | null {
  const map = byId(entities);
  const [a, b] = selected.map((s) => map.get(s));
  if (!a) return null;
  if (type === "fix") return { id, type, a: a.id };
  if ((type === "horizontal" || type === "vertical") && !b) return a.type === "line" ? { id, type, a: a.id } : null;
  if (!b) return null;
  if (type === "midpoint") {
    const [p, l] = a.type === "point" ? [a, b] : [b, a];
    return p.type === "point" && l.type === "line" ? { id, type, a: p.id, b: l.id } : null;
  }
  return { id, type, a: a.id, b: b.id } as Constraint;
}

export type DimMode = "smart" | "horizontal" | "vertical";

/**
 * The driving dimension a selection implies, with its current measured value.
 * Smart picks the natural one: a line's length, a circle's diameter, an arc's
 * radius, the distance between two points or a point and a line, the gap
 * between parallel lines or the angle between lines that are not parallel.
 * Horizontal and vertical always measure along one sketch axis only, so the
 * other direction stays free.
 */
export function makeDimension(entities: Entity[], selected: string[], mode: DimMode, id: string): Constraint | null {
  const map = byId(entities);
  const sel = selected.map((s) => map.get(s)).filter((e): e is Entity => !!e);
  if (!sel.length || sel.length > 2) return null;
  const xy = (pid: string) => pointXY(map, pid);
  const anchor = (e: Entity): Vec2 | null => (e.type === "point" ? [e.x, e.y] : e.type === "circle" || e.type === "arc" ? xy(e.c) : null);
  const [a, b] = sel;

  if (mode !== "smart") {
    // One axis only: between two points (or centres), or across a single line.
    let p: Vec2 | null;
    let q: Vec2 | null;
    if (sel.length === 1) {
      if (a.type !== "line") return null;
      p = xy(a.p1);
      q = xy(a.p2);
    } else {
      p = anchor(a);
      q = anchor(b);
    }
    if (!p || !q) return null;
    const value = r4(Math.abs(mode === "horizontal" ? q[0] - p[0] : q[1] - p[1]));
    return sel.length === 1 ? { id, type: "distance", a: a.id, value, mode } : { id, type: "distance", a: a.id, b: b.id, value, mode };
  }

  if (sel.length === 1) {
    if (a.type === "line") {
      const [p, q] = [xy(a.p1), xy(a.p2)];
      return { id, type: "distance", a: a.id, value: r4(Math.hypot(q[0] - p[0], q[1] - p[1])) };
    }
    if (a.type === "circle") return { id, type: "diameter", a: a.id, value: r4(a.r * 2) };
    if (a.type === "arc") {
      const [c, p] = [xy(a.c), xy(a.p1)];
      return { id, type: "radius", a: a.id, value: r4(Math.hypot(p[0] - c[0], p[1] - c[1])) };
    }
    return null;
  }
  if (a.type === "line" && b.type === "line") {
    const da = v2sub(xy(a.p2), xy(a.p1));
    const db = v2sub(xy(b.p2), xy(b.p1));
    const sin = Math.abs(da[0] * db[1] - da[1] * db[0]) / ((Math.hypot(...da) || 1) * (Math.hypot(...db) || 1));
    if (sin < 0.02) return { id, type: "distance", a: a.id, b: b.id, value: r4(Math.abs(distToLine(xy(a.p1), xy(b.p1), xy(b.p2)))) };
    const ang = Math.abs(wrapDeg(((Math.atan2(da[1], da[0]) - Math.atan2(db[1], db[0])) * 180) / Math.PI));
    return { id, type: "angle", a: a.id, b: b.id, value: r4(ang) };
  }
  const line = a.type === "line" ? a : b.type === "line" ? b : null;
  if (line) {
    const other = line === a ? b : a;
    const p = anchor(other);
    if (!p) return null;
    return { id, type: "distance", a: other.id, b: line.id, value: r4(Math.abs(distToLine(p, xy(line.p1), xy(line.p2)))) };
  }
  const p = anchor(a);
  const q = anchor(b);
  if (!p || !q) return null;
  return { id, type: "distance", a: a.id, b: b.id, value: r4(Math.hypot(q[0] - p[0], q[1] - p[1])) };
}

const v2sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];

export function distToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / (Math.hypot(dx, dy) || 1);
}

// ---------------------------------------------------------------------------
// References to model geometry

export type ModelRef = { kind: "point"; point: Vec3 } | { kind: "line"; origin: Vec3; dir: Vec3 } | { kind: "plane"; origin: Vec3; normal: Vec3 };

/**
 * Brings a piece of the model into the sketch as fixed reference geometry: a
 * vertex becomes a point, a straight edge becomes a line, and a flat face
 * standing square to the sketch plane becomes the line where it crosses it.
 * Returns the id to select, or an error if the geometry has no usable trace.
 */
export function addModelRef(data: SketchData, frame: Frame, ref: ModelRef): { id: string } | { error: string } {
  const pen = new Pen(data);
  const find = (x: number, y: number) => data.entities.find((e) => e.type === "point" && e.fixed && e.src && Math.hypot(e.x - x, e.y - y) < 1e-6)?.id;
  if (ref.kind === "point") {
    const [x, y] = toPlane(frame, ref.point);
    return { id: find(x, y) ?? pen.point(x, y, { fixed: true, src: ref.point }) };
  }
  let a: Vec2;
  let b: Vec2;
  if (ref.kind === "line") {
    a = toPlane(frame, ref.origin);
    b = toPlane(frame, v3.add(ref.origin, ref.dir));
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return addModelRef(data, frame, { kind: "point", point: ref.origin });
  } else {
    const n = v3.norm(ref.normal);
    if (Math.abs(v3.dot(n, frame.n)) > 0.05) return { error: "That face is not square to the sketch plane, so it has no edge-on line here" };
    // The face plane crosses the sketch plane along a line whose direction is n × sketch normal.
    const dir = v3.norm(v3.cross(n, frame.n));
    const foot = v3.sub(ref.origin, v3.scale(frame.n, v3.dot(v3.sub(ref.origin, frame.origin), frame.n)));
    a = toPlane(frame, foot);
    b = toPlane(frame, v3.add(foot, v3.scale(dir, 10)));
  }
  // Reuse an existing reference to the same line.
  const map = byId(data.entities);
  for (const e of data.entities)
    if (e.type === "line" && e.ref) {
      const [p, q] = [pointXY(map, e.p1), pointXY(map, e.p2)];
      if (Math.abs(distToLine(a, p, q)) < 1e-6 && Math.abs(distToLine(b, p, q)) < 1e-6) return { id: e.id };
    }
  const src: Vec3 = ref.kind === "line" ? ref.origin : ref.origin;
  const p1 = pen.point(a[0], a[1], { fixed: true, src });
  const p2 = pen.point(b[0], b[1], { fixed: true, src });
  return { id: pen.line(p1, p2, { ref: true }) };
}

export function isCurve(e: Entity): e is LineEntity | CircleEntity | ArcEntity {
  return e.type !== "point";
}

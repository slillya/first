// 2D geometric constraint solver for sketches.
//
// Unknowns are the coordinates of every free point and the radius of every
// circle. Each constraint contributes residuals that are zero when it holds.
// Levenberg–Marquardt drives the residuals to zero starting from where the
// geometry already is, so the sketch moves as little as it has to. The
// Jacobian's rank at the solution gives the remaining degrees of freedom and
// which entities are still free to move (drawn blue, as in SolidWorks).
import type { ArcEntity, CircleEntity, Constraint, Entity, LineEntity, PointEntity, Vec2 } from "../model/schema";

export interface SolveResult {
  entities: Entity[];
  /** True when every constraint is satisfied. */
  ok: boolean;
  /** Remaining degrees of freedom; 0 means fully defined. */
  dof: number;
  /** Ids of entities that can still move. */
  free: Set<string>;
  /** Ids of constraints that could not be satisfied or reference missing/unsuitable entities. */
  failed: string[];
  /** Human-readable reason for the first failure, if any. */
  error?: string;
}

export interface SolveOptions {
  /** Pull these points toward targets while keeping constraints (finger dragging). */
  drag?: { point: string; to: Vec2 }[];
  /** Pull this circle's radius toward a value (dragging its rim). */
  dragRadius?: { circle: string; r: number };
  /** Skip the degrees-of-freedom analysis (while dragging). */
  fast?: boolean;
}

type Fn = (x: Float64Array) => number;
interface Residual {
  f: Fn;
  deps: number[];
  /** Owning constraint; undefined for built-in arc consistency. */
  owner?: string;
  soft?: boolean;
}

const TOL = 1e-7;

class Builder {
  readonly vars: number[] = [];
  readonly res: Residual[] = [];
  readonly byId = new Map<string, Entity>();
  /** Variable index for a point's x (y is +1), or -1 when the point is fixed. */
  readonly pIdx = new Map<string, number>();
  readonly rIdx = new Map<string, number>();
  readonly bad = new Map<string, string>();

  constructor(
    readonly entities: Entity[],
    constraints: Constraint[],
  ) {
    for (const e of entities) this.byId.set(e.id, e);
    const pinned = new Set<string>();
    for (const c of constraints) if (c.type === "fix") for (const p of this.pointsOf(c.a)) pinned.add(p);
    for (const e of entities) {
      if (e.type === "point") {
        if (e.fixed || pinned.has(e.id)) this.pIdx.set(e.id, -1);
        else {
          this.pIdx.set(e.id, this.vars.length);
          this.vars.push(e.x, e.y);
        }
      } else if (e.type === "circle") {
        this.rIdx.set(e.id, this.vars.length);
        this.vars.push(e.r);
      }
    }
    for (const e of entities) if (e.type === "arc") this.arcConsistency(e);
    for (const c of constraints) {
      try {
        this.add(c);
      } catch (err) {
        this.bad.set(c.id, err instanceof Error ? err.message : "invalid constraint");
      }
    }
  }

  pointsOf(id: string): string[] {
    const e = this.byId.get(id);
    if (!e) return [];
    if (e.type === "point") return [e.id];
    if (e.type === "line") return [e.p1, e.p2];
    if (e.type === "circle") return [e.c];
    return [e.c, e.p1, e.p2];
  }

  private ent(id: string): Entity {
    const e = this.byId.get(id);
    if (!e) throw new Error(`"${id}" does not exist in this sketch`);
    return e;
  }
  private point(id: string): PointEntity {
    const e = this.ent(id);
    if (e.type !== "point") throw new Error(`"${id}" is not a point`);
    return e;
  }
  private line(id: string): LineEntity {
    const e = this.ent(id);
    if (e.type !== "line") throw new Error(`"${id}" is not a line`);
    return e;
  }

  /** Accessors for a point's coordinates and the variables they depend on. */
  private P(id: string): { x: Fn; y: Fn; deps: number[] } {
    const p = this.point(id);
    const i = this.pIdx.get(id)!;
    if (i < 0) return { x: () => p.x, y: () => p.y, deps: [] };
    return { x: (v) => v[i], y: (v) => v[i + 1], deps: [i, i + 1] };
  }

  /** Radius of a circle (a variable) or an arc (distance from centre to its start point). */
  private R(e: CircleEntity | ArcEntity): { r: Fn; deps: number[] } {
    if (e.type === "circle") {
      const i = this.rIdx.get(e.id)!;
      return { r: (v) => v[i], deps: [i] };
    }
    const c = this.P(e.c);
    const p = this.P(e.p1);
    return { r: (v) => Math.hypot(p.x(v) - c.x(v), p.y(v) - c.y(v)), deps: [...c.deps, ...p.deps] };
  }

  private push(owner: string | undefined, deps: number[], f: Fn) {
    this.res.push({ f, deps: [...new Set(deps)], owner });
  }

  private arcConsistency(a: ArcEntity) {
    const c = this.P(a.c);
    const p1 = this.P(a.p1);
    const p2 = this.P(a.p2);
    this.push(undefined, [...c.deps, ...p1.deps, ...p2.deps], (v) => Math.hypot(p1.x(v) - c.x(v), p1.y(v) - c.y(v)) - Math.hypot(p2.x(v) - c.x(v), p2.y(v) - c.y(v)));
  }

  /** Signed distance from point p to the infinite line through a and b. */
  private lineDist(p: ReturnType<Builder["P"]>, l: LineEntity): { d: Fn; deps: number[] } {
    const a = this.P(l.p1);
    const b = this.P(l.p2);
    return {
      deps: [...p.deps, ...a.deps, ...b.deps],
      d: (v) => {
        const dx = b.x(v) - a.x(v);
        const dy = b.y(v) - a.y(v);
        return (dx * (p.y(v) - a.y(v)) - dy * (p.x(v) - a.x(v))) / (Math.hypot(dx, dy) || 1);
      },
    };
  }

  private dir(l: LineEntity): { dx: Fn; dy: Fn; len: Fn; deps: number[] } {
    const a = this.P(l.p1);
    const b = this.P(l.p2);
    const dx: Fn = (v) => b.x(v) - a.x(v);
    const dy: Fn = (v) => b.y(v) - a.y(v);
    return { dx, dy, len: (v) => Math.hypot(dx(v), dy(v)), deps: [...a.deps, ...b.deps] };
  }

  private add(c: Constraint) {
    const x0 = Float64Array.from(this.vars);
    const sign = (n: number) => (n < 0 ? -1 : 1);
    switch (c.type) {
      case "fix":
        this.ent(c.a);
        return;
      case "coincident":
      case "concentric": {
        let a = this.ent(c.a);
        let b = this.ent(c.b);
        if (c.type === "concentric") {
          if (a.type === "point" || a.type === "line" || b.type === "point" || b.type === "line") throw new Error("Concentric needs two circles or arcs");
          a = this.point(a.c);
          b = this.point(b.c);
        }
        if (a.type !== "point" && b.type === "point") [a, b] = [b, a];
        if (a.type === "point" && b.type === "point") {
          const p = this.P(a.id);
          const q = this.P(b.id);
          this.push(c.id, [...p.deps, ...q.deps], (v) => p.x(v) - q.x(v));
          this.push(c.id, [...p.deps, ...q.deps], (v) => p.y(v) - q.y(v));
        } else if (a.type === "point" && b.type === "line") {
          const d = this.lineDist(this.P(a.id), b);
          this.push(c.id, d.deps, d.d);
        } else if (a.type === "point" && (b.type === "circle" || b.type === "arc")) {
          const p = this.P(a.id);
          const ctr = this.P(b.c);
          const r = this.R(b);
          this.push(c.id, [...p.deps, ...ctr.deps, ...r.deps], (v) => Math.hypot(p.x(v) - ctr.x(v), p.y(v) - ctr.y(v)) - r.r(v));
        } else if (a.type === "line" && b.type === "line") {
          // Collinear: both ends of the movable line sit on the other line.
          const [moving, target] = a.ref && !b.ref ? [b, a] : [a, b];
          for (const pid of [moving.p1, moving.p2]) {
            const d = this.lineDist(this.P(pid), target);
            this.push(c.id, d.deps, d.d);
          }
        } else throw new Error("Coincident needs a point and a point, line or circle, or two lines");
        return;
      }
      case "horizontal":
      case "vertical": {
        const first = this.ent(c.a);
        const [p, q] = first.type === "line" ? [this.P(first.p1), this.P(first.p2)] : [this.P(c.a), this.P(c.b ?? "")];
        const pick = c.type === "horizontal" ? (o: typeof p) => o.y : (o: typeof p) => o.x;
        this.push(c.id, [...p.deps, ...q.deps], (v) => pick(p)(v) - pick(q)(v));
        return;
      }
      case "parallel":
      case "perpendicular": {
        const a = this.dir(this.line(c.a));
        const b = this.dir(this.line(c.b));
        const deps = [...a.deps, ...b.deps];
        // Scaled by one line's length so the residual is a distance, comparable with the others.
        if (c.type === "parallel") this.push(c.id, deps, (v) => (a.dx(v) * b.dy(v) - a.dy(v) * b.dx(v)) / (b.len(v) || 1));
        else this.push(c.id, deps, (v) => (a.dx(v) * b.dx(v) + a.dy(v) * b.dy(v)) / (b.len(v) || 1));
        return;
      }
      case "equal": {
        const a = this.ent(c.a);
        const b = this.ent(c.b);
        if (a.type === "line" && b.type === "line") {
          const da = this.dir(a);
          const db = this.dir(b);
          this.push(c.id, [...da.deps, ...db.deps], (v) => da.len(v) - db.len(v));
        } else if ((a.type === "circle" || a.type === "arc") && (b.type === "circle" || b.type === "arc")) {
          const ra = this.R(a);
          const rb = this.R(b);
          this.push(c.id, [...ra.deps, ...rb.deps], (v) => ra.r(v) - rb.r(v));
        } else throw new Error("Equal needs two lines or two circles/arcs");
        return;
      }
      case "tangent": {
        let a = this.ent(c.a);
        let b = this.ent(c.b);
        if (a.type !== "line" && b.type === "line") [a, b] = [b, a];
        // Where two curves meet at a shared end point, tangency is stated at that point (the radius
        // is square to the line there). The general "touches somewhere" form has a vanishing
        // gradient at the touching point, which would leave the end point looking free.
        const ends = (e: Entity) => (e.type === "line" || e.type === "arc" ? [e.p1, e.p2] : []);
        const shared = ends(a).find((id) => ends(b).includes(id));
        if (a.type === "line" && (b.type === "circle" || b.type === "arc")) {
          const r = this.R(b);
          if (shared) {
            const p = this.P(shared);
            const ctr = this.P(b.c);
            const d = this.dir(a);
            this.push(c.id, [...p.deps, ...ctr.deps, ...d.deps], (v) => ((p.x(v) - ctr.x(v)) * d.dx(v) + (p.y(v) - ctr.y(v)) * d.dy(v)) / (d.len(v) || 1));
          } else {
            const d = this.lineDist(this.P(b.c), a);
            const s = sign(d.d(x0));
            this.push(c.id, [...d.deps, ...r.deps], (v) => s * d.d(v) - r.r(v));
          }
        } else if ((a.type === "circle" || a.type === "arc") && (b.type === "circle" || b.type === "arc")) {
          const ca = this.P(a.c);
          const cb = this.P(b.c);
          const ra = this.R(a);
          const rb = this.R(b);
          const deps = [...ca.deps, ...cb.deps, ...ra.deps, ...rb.deps];
          const gap: Fn = (v) => Math.hypot(ca.x(v) - cb.x(v), ca.y(v) - cb.y(v));
          if (shared) {
            // Both centres in line with the shared point.
            const p = this.P(shared);
            this.push(c.id, [...p.deps, ...ca.deps, ...cb.deps], (v) => {
              const ax = p.x(v) - ca.x(v);
              const ay = p.y(v) - ca.y(v);
              const bx = p.x(v) - cb.x(v);
              const by = p.y(v) - cb.y(v);
              return (ax * by - ay * bx) / (Math.hypot(bx, by) || 1);
            });
            return;
          }
          // Keep whichever arrangement the sketch is already in: side by side, or one inside the other.
          const inside = gap(x0) < Math.max(ra.r(x0), rb.r(x0));
          if (inside) {
            const s = sign(ra.r(x0) - rb.r(x0));
            this.push(c.id, deps, (v) => gap(v) - s * (ra.r(v) - rb.r(v)));
          } else this.push(c.id, deps, (v) => gap(v) - ra.r(v) - rb.r(v));
        } else throw new Error("Tangent needs a line and a circle/arc, or two circles/arcs");
        return;
      }
      case "midpoint": {
        const p = this.P(c.a);
        const l = this.line(c.b);
        const a = this.P(l.p1);
        const b = this.P(l.p2);
        const deps = [...p.deps, ...a.deps, ...b.deps];
        this.push(c.id, deps, (v) => p.x(v) - (a.x(v) + b.x(v)) / 2);
        this.push(c.id, deps, (v) => p.y(v) - (a.y(v) + b.y(v)) / 2);
        return;
      }
      case "radius":
      case "diameter": {
        const e = this.ent(c.a);
        if (e.type !== "circle" && e.type !== "arc") throw new Error("Radius and diameter need a circle or arc");
        const r = this.R(e);
        const target = c.type === "radius" ? c.value : c.value / 2;
        this.push(c.id, r.deps, (v) => r.r(v) - target);
        return;
      }
      case "angle": {
        const a = this.dir(this.line(c.a));
        const b = c.b ? this.dir(this.line(c.b)) : null;
        const deps = [...a.deps, ...(b?.deps ?? [])];
        const wrap = (t: number) => Math.atan2(Math.sin(t), Math.cos(t));
        const between: Fn = b ? (v) => wrap(Math.atan2(a.dy(v), a.dx(v)) - Math.atan2(b.dy(v), b.dx(v))) : (v) => Math.atan2(a.dy(v), a.dx(v));
        const s = sign(between(x0));
        const target = (c.value * Math.PI) / 180;
        // Radians times length keeps this in the same units as the distance residuals.
        this.push(c.id, deps, (v) => wrap(between(v) - s * target) * (a.len(v) || 1));
        return;
      }
      case "distance": {
        const mode = c.mode ?? "aligned";
        let a = this.ent(c.a);
        let b = c.b ? this.ent(c.b) : null;
        // A circle or arc stands for its centre.
        if (a.type === "circle" || a.type === "arc") a = this.point(a.c);
        if (b && (b.type === "circle" || b.type === "arc")) b = this.point(b.c);
        if (!b) {
          if (a.type !== "line") throw new Error("A distance on one entity needs a line");
          b = this.point(a.p2);
          a = this.point(a.p1);
        }
        if (a.type === "line" && b.type === "point") [a, b] = [b, a];
        if (a.type === "point" && b.type === "point") {
          const p = this.P(a.id);
          const q = this.P(b.id);
          const deps = [...p.deps, ...q.deps];
          if (mode === "aligned") this.push(c.id, deps, (v) => Math.hypot(q.x(v) - p.x(v), q.y(v) - p.y(v)) - c.value);
          else {
            const gap: Fn = mode === "horizontal" ? (v) => q.x(v) - p.x(v) : (v) => q.y(v) - p.y(v);
            const s = sign(gap(x0));
            this.push(c.id, deps, (v) => s * gap(v) - c.value);
          }
        } else if (a.type === "point" && b.type === "line") {
          const d = this.lineDist(this.P(a.id), b);
          const s = sign(d.d(x0));
          this.push(c.id, d.deps, (v) => s * d.d(v) - c.value);
        } else if (a.type === "line" && b.type === "line") {
          // Both ends at the same distance, which also keeps the lines parallel.
          const [moving, target] = a.ref && !b.ref ? [b, a] : [a, b];
          for (const pid of [moving.p1, moving.p2]) {
            const d = this.lineDist(this.P(pid), target);
            const s = sign(d.d(x0));
            this.push(c.id, d.deps, (v) => s * d.d(v) - c.value);
          }
        } else throw new Error("Distance needs points and/or lines");
        return;
      }
    }
  }
}

/** Solves A·x = b for symmetric positive-definite A (in place). Returns false if A is singular. */
function solveSPD(A: Float64Array, b: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 1e-300)) return false;
    d = Math.sqrt(d);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= A[i * n + k] * b[k];
    b[i] = s / A[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= A[k * n + i] * b[k];
    b[i] = s / A[i * n + i];
  }
  return true;
}

function evalAll(res: Residual[], x: Float64Array, out: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < res.length; i++) {
    const r = res[i].f(x);
    out[i] = r;
    sum += r * r;
  }
  return sum;
}

/** Dense m×n Jacobian by central differences, touching only the variables each residual depends on. */
function jacobian(res: Residual[], x: Float64Array, n: number): Float64Array {
  const J = new Float64Array(res.length * n);
  for (let i = 0; i < res.length; i++) {
    for (const j of res[i].deps) {
      const keep = x[j];
      const h = 1e-6 * (1 + Math.abs(keep));
      x[j] = keep + h;
      const up = res[i].f(x);
      x[j] = keep - h;
      const down = res[i].f(x);
      x[j] = keep;
      J[i * n + j] = (up - down) / (2 * h);
    }
  }
  return J;
}

function minimise(res: Residual[], x: Float64Array, maxIter: number): void {
  const n = x.length;
  const m = res.length;
  if (!n || !m) return;
  const r = new Float64Array(m);
  const trial = new Float64Array(m);
  let cost = evalAll(res, x, r);
  let lambda = 1e-3;
  for (let iter = 0; iter < maxIter && cost > TOL * TOL * 1e-4; iter++) {
    const J = jacobian(res, x, n);
    const JtJ = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const deps = res[i].deps;
      for (const a of deps) {
        const ja = J[i * n + a];
        if (!ja) continue;
        g[a] -= ja * r[i];
        for (const b of deps) JtJ[a * n + b] += ja * J[i * n + b];
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const A = JtJ.slice();
      // Additive damping keeps unconstrained directions still instead of letting them drift.
      for (let j = 0; j < n; j++) A[j * n + j] += lambda * (1 + JtJ[j * n + j]);
      const step = g.slice();
      if (solveSPD(A, step, n)) {
        const next = x.slice();
        for (let j = 0; j < n; j++) next[j] += step[j];
        const c = evalAll(res, next, trial);
        if (Number.isFinite(c) && c < cost) {
          x.set(next);
          r.set(trial);
          const gain = cost - c;
          cost = c;
          lambda = Math.max(lambda / 4, 1e-12);
          improved = true;
          if (gain < 1e-22) return;
          break;
        }
      }
      lambda *= 6;
    }
    if (!improved) return;
  }
}

/** Rank of J and, per variable, whether it is pinned down by the constraints. */
function analyse(J: Float64Array, m: number, n: number): { rank: number; determined: boolean[] } {
  const A = J.slice();
  const pivotCol: number[] = [];
  let row = 0;
  let scale = 0;
  for (let i = 0; i < A.length; i++) scale = Math.max(scale, Math.abs(A[i]));
  const eps = 1e-7 * (scale || 1);
  for (let col = 0; col < n && row < m; col++) {
    let best = row;
    for (let i = row + 1; i < m; i++) if (Math.abs(A[i * n + col]) > Math.abs(A[best * n + col])) best = i;
    if (Math.abs(A[best * n + col]) < eps) continue;
    if (best !== row)
      for (let k = 0; k < n; k++) {
        const t = A[row * n + k];
        A[row * n + k] = A[best * n + k];
        A[best * n + k] = t;
      }
    const p = A[row * n + col];
    for (let k = 0; k < n; k++) A[row * n + k] /= p;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = A[i * n + col];
      if (f) for (let k = 0; k < n; k++) A[i * n + k] -= f * A[row * n + k];
    }
    pivotCol.push(col);
    row++;
  }
  // In reduced row echelon form a pivot variable is fixed only if its row has no free-variable terms.
  const isPivot = new Array<boolean>(n).fill(false);
  for (const c of pivotCol) isPivot[c] = true;
  const determined = new Array<boolean>(n).fill(false);
  pivotCol.forEach((c, i) => {
    let clean = true;
    for (let k = 0; k < n; k++) if (!isPivot[k] && Math.abs(A[i * n + k]) > 1e-6) clean = false;
    determined[c] = clean;
  });
  return { rank: pivotCol.length, determined };
}

export function solveSketch(entities: Entity[], constraints: Constraint[], opts: SolveOptions = {}): SolveResult {
  const b = new Builder(entities, constraints);
  const x = Float64Array.from(b.vars);
  const n = x.length;
  const hard = b.res;

  if (opts.drag?.length || opts.dragRadius) {
    // Weak pulls toward the finger, then a clean-up pass so constraints end exact.
    const soft: Residual[] = [];
    const w = 0.05;
    for (const d of opts.drag ?? []) {
      const i = b.pIdx.get(d.point);
      if (i === undefined || i < 0) continue;
      soft.push({ f: (v) => w * (v[i] - d.to[0]), deps: [i], soft: true }, { f: (v) => w * (v[i + 1] - d.to[1]), deps: [i + 1], soft: true });
      x[i] = d.to[0];
      x[i + 1] = d.to[1];
    }
    if (opts.dragRadius) {
      const i = b.rIdx.get(opts.dragRadius.circle);
      if (i !== undefined) {
        const target = Math.max(1e-3, opts.dragRadius.r);
        soft.push({ f: (v) => w * (v[i] - target), deps: [i], soft: true });
        x[i] = target;
      }
    }
    minimise([...hard, ...soft], x, 30);
  }
  minimise(hard, x, opts.fast ? 30 : 80);

  let bad = false;
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) bad = true;
  if (bad) x.set(b.vars);

  const failed = new Set<string>(b.bad.keys());
  let scale = 1;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(x[i]));
  const tol = 1e-6 * scale;
  let internal = false;
  for (const r of hard) {
    if (Math.abs(r.f(x)) > tol) {
      if (r.owner) failed.add(r.owner);
      else internal = true;
    }
  }

  const out = entities.map((e): Entity => {
    if (e.type === "point") {
      const i = b.pIdx.get(e.id)!;
      return i < 0 ? e : { ...e, x: x[i], y: x[i + 1] };
    }
    if (e.type === "circle") return { ...e, r: Math.max(1e-6, Math.abs(x[b.rIdx.get(e.id)!])) };
    return e;
  });

  const free = new Set<string>();
  let dof = 0;
  if (!opts.fast) {
    const usable = hard.filter((r) => !r.owner || !failed.has(r.owner));
    const { rank, determined } = usable.length ? analyse(jacobian(usable, x, n), usable.length, n) : { rank: 0, determined: new Array<boolean>(n).fill(false) };
    dof = n - rank;
    const pointFree = (id: string) => {
      const i = b.pIdx.get(id);
      return i !== undefined && i >= 0 && (!determined[i] || !determined[i + 1]);
    };
    for (const e of entities) {
      if (e.type === "point") {
        if (pointFree(e.id)) free.add(e.id);
      } else if (e.type === "line") {
        if (pointFree(e.p1) || pointFree(e.p2)) free.add(e.id);
      } else if (e.type === "circle") {
        if (pointFree(e.c) || !determined[b.rIdx.get(e.id)!]) free.add(e.id);
      } else if (pointFree(e.c) || pointFree(e.p1) || pointFree(e.p2)) free.add(e.id);
    }
  }

  const ok = failed.size === 0 && !internal && !bad;
  let error: string | undefined;
  if (!ok) {
    const first = [...b.bad.values()][0];
    error = first ?? "These relations and dimensions cannot all be satisfied together";
  }
  return { entities: out, ok, dof, free, failed: [...failed], error };
}

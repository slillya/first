// Assembly mate solver: positions rigid components so that SolidWorks-style mates between them hold.
// Self-contained on purpose (no imports) so it can run on the main thread, in a worker or in tests.

export type Vec3 = [number, number, number];
/** Unit quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];
/** world = rotate(q, local) + p */
export interface Pose { p: Vec3; q: Quat }

/** Geometry on a component, in that component's LOCAL coordinates. dir is a unit vector. */
export type GeoRef =
  | { type: "plane"; origin: Vec3; dir: Vec3 } // a planar face: a point on it and its outward normal
  | { type: "axis"; origin: Vec3; dir: Vec3 } // an infinite line: a straight edge, or the axis of a cylindrical face
  | { type: "point"; origin: Vec3 }; // a vertex

export type MateType = "coincident" | "concentric" | "parallel" | "perpendicular" | "distance" | "angle" | "lock";

export interface MateInput {
  id: string;
  type: MateType;
  a: { component: string; ref: GeoRef };
  b: { component: string; ref: GeoRef };
  /** distance in mm, or angle in degrees. Ignored by other types. */
  value?: number;
  /**
   * Plane–plane mates: false/undefined = faces oppose each other (normals anti-parallel, the usual "touching" case);
   * true = normals point the same way.
   */
  flip?: boolean;
}

export interface ComponentInput { id: string; pose: Pose; fixed?: boolean }

export interface MateStatus { ok: boolean; residual: number; error?: string }

export interface MateResult {
  /** Pose of every component passed in (fixed ones unchanged). */
  poses: Record<string, Pose>;
  mates: Record<string, MateStatus>;
  /** Remaining rigid-body degrees of freedom across all non-fixed components (6 each when unconstrained). */
  dof: number;
  /** True when every supported mate is satisfied within tolerance. */
  converged: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Vectors and quaternions
// ---------------------------------------------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function unit(a: Vec3): Vec3 {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

function qnormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 0 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

function qrot(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

/** Rotation vector (axis · angle) to quaternion. */
function qexp(w: Vec3): Quat {
  const angle = len(w);
  if (angle < 1e-10) return qnormalize([w[0] / 2, w[1] / 2, w[2] / 2, 1]);
  const s = Math.sin(angle / 2) / angle;
  return [w[0] * s, w[1] * s, w[2] * s, Math.cos(angle / 2)];
}

/** Quaternion to rotation vector, taking the short way round. */
function qlog(q: Quat): Vec3 {
  const sign = q[3] < 0 ? -1 : 1;
  const v: Vec3 = [q[0] * sign, q[1] * sign, q[2] * sign];
  const s = len(v);
  if (s < 1e-10) return scale(v, 2);
  return scale(v, (2 * Math.atan2(s, q[3] * sign)) / s);
}

/** Angle between two unit vectors, accurate near 0 and π (acos is not). */
const angleBetween = (u: Vec3, v: Vec3): number => Math.atan2(len(cross(u, v)), dot(u, v));

// ---------------------------------------------------------------------------------------------------------------------
// Pose helpers
// ---------------------------------------------------------------------------------------------------------------------

export const IDENTITY_POSE: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };

/** Local point -> world. */
export function applyPose(pose: Pose, point: Vec3): Vec3 {
  return add(qrot(pose.q, point), pose.p);
}

/** Local direction -> world. */
export function rotateByPose(pose: Pose, dir: Vec3): Vec3 {
  return qrot(pose.q, dir);
}

export function invertPose(pose: Pose): Pose {
  const q = qconj(pose.q);
  return { p: scale(qrot(q, pose.p), -1), q };
}

/** Apply b first, then a. */
export function composePose(a: Pose, b: Pose): Pose {
  return { p: add(qrot(a.q, b.p), a.p), q: qnormalize(qmul(a.q, b.q)) };
}

/** 16 numbers, column-major (three.js Matrix4.fromArray layout). */
export function poseToMatrix(pose: Pose): number[] {
  const [x, y, z, w] = pose.q;
  const [px, py, pz] = pose.p;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    px, py, pz, 1,
  ];
}

const copyPose = (pose: Pose): Pose => ({ p: [pose.p[0], pose.p[1], pose.p[2]], q: [pose.q[0], pose.q[1], pose.q[2], pose.q[3]] });

// ---------------------------------------------------------------------------------------------------------------------
// Mates -> constraints
// ---------------------------------------------------------------------------------------------------------------------

/** A mate is satisfied when its angular error is below ANG_TOL (rad) and its positional error below POS_TOL (mm, grows for huge parts). */
const ANG_TOL = 1e-7;
const POS_TOL = 1e-5;
/** The solver itself aims this much tighter than the tolerances, so reported residuals sit well inside them. */
const POLISH = 0.01;

type RefType = GeoRef["type"];
interface CleanRef { type: RefType; origin: Vec3; dir: Vec3 }
interface WorldRef { o: Vec3; d: Vec3 }

/** err[0] = angular error in rad, err[1] = positional error in mm. */
type ErrOut = Float64Array;
type Emit = (x: WorldRef, y: WorldRef, out: Float64Array, at: number, err: ErrOut) => void;

interface Spec {
  n: number;
  kind: "ang" | "pos" | "mixed";
  /** How to get this mate off a stationary point where it is unsatisfied but has no gradient. */
  kick: "rot" | "trans" | "both";
  emit: Emit;
}

interface Constraint extends Omit<Spec, "emit"> {
  id: string;
  ia: number;
  ib: number;
  refA: CleanRef | null;
  refB: CleanRef | null;
  /** Writes n residuals (lengths divided by the characteristic length) to out[at..] and the natural-unit errors to err. */
  eval(pa: Pose, pb: Pose, out: Float64Array, at: number, err: ErrOut): void;
}

const finite3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

function cleanRef(ref: GeoRef | undefined): CleanRef | null {
  if (!ref || !finite3(ref.origin)) return null;
  const origin: Vec3 = [ref.origin[0], ref.origin[1], ref.origin[2]];
  if (ref.type === "point") return { type: "point", origin, dir: [0, 0, 0] };
  if ((ref.type !== "plane" && ref.type !== "axis") || !finite3(ref.dir)) return null;
  const l = len(ref.dir);
  if (!(l > 1e-12)) return null;
  return { type: ref.type, origin, dir: scale(ref.dir, 1 / l) };
}

const toWorld = (pose: Pose, ref: CleanRef): WorldRef => ({ o: applyPose(pose, ref.origin), d: qrot(pose.q, ref.dir) });

/**
 * One block of residual rows for a mate whose two sides are x and y in world space. Writes its rows to out[at..] (lengths
 * divided by the characteristic length) and returns its error in natural units: radians for directions, mm for positions.
 */
type Part = (x: WorldRef, y: WorldRef, out: Float64Array, at: number) => number;

function put3(v: Vec3, k: number, out: Float64Array, at: number): void {
  out[at] = v[0] * k;
  out[at + 1] = v[1] * k;
  out[at + 2] = v[2] * k;
}

// Directions.

/** y.d must equal s·x.d: 3 rows, rank 2 at the solution. */
const aligned = (s: number): Part => (x, y, out, at) => {
  put3(sub(y.d, scale(x.d, s)), 1, out, at);
  return angleBetween(scale(x.d, s), y.d);
};

/** Parallel in either sense: 3 rows, rank 2 at the solution. */
const parallel: Part = (x, y, out, at) => {
  const c = cross(x.d, y.d);
  put3(c, 1, out, at);
  return Math.atan2(len(c), Math.abs(dot(x.d, y.d)));
};

/** At right angles: 1 row. */
const square: Part = (x, y, out, at) => {
  const d = dot(x.d, y.d);
  out[at] = d;
  return Math.abs(Math.atan2(d, len(cross(x.d, y.d))));
};

/** The angle between the directions must be `target`, which is strictly between 0 and π: 1 row. */
const atAngle = (target: number): Part => (x, y, out, at) => {
  const e = angleBetween(x.d, y.d) - target;
  out[at] = e;
  return Math.abs(e);
};

// Positions.

const offLine = (o: Vec3, d: Vec3, p: Vec3): Vec3 => {
  const w = sub(p, o);
  return sub(w, scale(d, dot(w, d)));
};

/** y's origin sits at signed height `target` over the plane (x.o, x.d): 1 row. */
const height = (target: number, L: number): Part => (x, y, out, at) => {
  const e = dot(sub(y.o, x.o), x.d) - target;
  out[at] = e / L;
  return Math.abs(e);
};

/** y's origin is on the line (x.o, x.d): 3 rows, rank 2. */
const onLine = (L: number): Part => (x, y, out, at) => {
  const v = offLine(x.o, x.d, y.o);
  put3(v, 1 / L, out, at);
  return len(v);
};

/** y's origin is `gap` > 0 away from the line (x.o, x.d): 1 row, with no gradient while the point is on the line. */
const offLineBy = (gap: number, L: number): Part => (x, y, out, at) => {
  const e = len(offLine(x.o, x.d, y.o)) - gap;
  out[at] = e / L;
  return Math.abs(e);
};

/** The two origins coincide: 3 rows. */
const together = (L: number): Part => (x, y, out, at) => {
  const v = sub(y.o, x.o);
  put3(v, 1 / L, out, at);
  return len(v);
};

/** The two origins are `gap` > 0 apart: 1 row, with no gradient while they coincide. */
const apart = (gap: number, L: number): Part => (x, y, out, at) => {
  const e = len(sub(y.o, x.o)) - gap;
  out[at] = e / L;
  return Math.abs(e);
};

const angular = (n: number, part: Part): Spec => ({
  n, kind: "ang", kick: "rot",
  emit: (x, y, out, at, err) => {
    err[0] = part(x, y, out, at);
  },
});

const positional = (n: number, part: Part, kick: Spec["kick"] = "rot"): Spec => ({
  n, kind: "pos", kick,
  emit: (x, y, out, at, err) => {
    err[1] = part(x, y, out, at);
  },
});

const mixed = (nAng: number, ang: Part, nPos: number, pos: Part, kick: Spec["kick"] = "rot"): Spec => ({
  n: nAng + nPos, kind: "mixed", kick,
  emit: (x, y, out, at, err) => {
    err[0] = ang(x, y, out, at);
    err[1] = pos(x, y, out, at + nAng);
  },
});

/** Angle between x.d and y.d must equal `target` (0..π). `either` = the directions are unsigned lines, so 0 and π are the same thing. */
function angleSpec(target: number, either: boolean): Spec {
  const nearZero = target < 1e-9;
  // The angle function has a cone point at 0 and π (no gradient, wrong rank), so use the vector forms there.
  if (nearZero || target > Math.PI - 1e-9) return angular(3, either ? parallel : aligned(nearZero ? 1 : -1));
  return angular(1, atAngle(target));
}

/** For unsigned lines the target angle can be met as t or π − t; keep whichever is nearer the current configuration. */
function nearestSense(target: number, current: number): number {
  return Math.abs(current - target) <= Math.abs(current - (Math.PI - target)) ? target : Math.PI - target;
}

function degToAngle(deg: number): number {
  let a = Math.abs(deg) % 360;
  if (a > 180) a = 360 - a;
  return (a * Math.PI) / 180;
}

const NEEDS: Record<Exclude<MateType, "lock" | "coincident">, string> = {
  concentric: "Concentric needs two round faces or straight edges",
  parallel: "Parallel needs flat faces or straight edges",
  perpendicular: "Perpendicular needs flat faces or straight edges",
  distance: "Distance between a flat face and an edge or axis is not supported",
  angle: "Angle needs flat faces or straight edges",
};

/**
 * Residuals for one mate, with the two sides already put in canonical order (plane before axis before point), so `x` is
 * never a "later" kind than `y`. x0/y0 are the sides at the input poses, used to freeze choices such as which side of a
 * plane a point stays on.
 */
function buildSpec(m: MateInput, key: string, x0: WorldRef, y0: WorldRef, L: number): Spec | string {
  const flipSign = m.flip ? 1 : -1;
  const value = m.value ?? 0;
  const gap = Math.abs(value);
  const touching = gap < 1e-12;

  switch (m.type) {
    case "coincident":
    case "concentric":
      if (m.type === "concentric" && key !== "axis-axis" && key !== "axis-point") return NEEDS.concentric;
      if (key === "plane-plane") return mixed(3, aligned(flipSign), 1, height(0, L));
      if (key === "plane-axis") return mixed(1, square, 1, height(0, L));
      if (key === "plane-point") return positional(1, height(0, L));
      if (key === "axis-axis") return mixed(3, parallel, 3, onLine(L));
      if (key === "axis-point") return positional(3, onLine(L));
      return positional(3, together(L));

    case "parallel":
      if (key === "plane-plane") return angular(3, m.flip === undefined ? parallel : aligned(flipSign));
      if (key === "axis-axis") return angular(3, parallel);
      if (key === "plane-axis") return angular(1, square);
      return NEEDS.parallel;

    case "perpendicular":
      if (key === "plane-plane" || key === "axis-axis") return angular(1, square);
      if (key === "plane-axis") return angular(3, parallel);
      return NEEDS.perpendicular;

    case "distance":
      if (key === "plane-plane") return mixed(3, aligned(flipSign), 1, height(value, L));
      if (key === "plane-point") {
        const side = dot(sub(y0.o, x0.o), x0.d) < -1e-9 ? -1 : 1;
        return positional(1, height(side * gap, L));
      }
      if (key === "point-point") return touching ? positional(3, together(L)) : positional(1, apart(gap, L), "trans");
      if (key === "axis-point") return touching ? positional(3, onLine(L)) : positional(1, offLineBy(gap, L), "trans");
      if (key === "axis-axis") return touching ? mixed(3, parallel, 3, onLine(L)) : mixed(3, parallel, 1, offLineBy(gap, L), "both");
      return NEEDS.distance;

    case "angle": {
      const a = degToAngle(value);
      // Opposing faces count as 0°, so without flip the angle is measured between na and −nb.
      if (key === "plane-plane") return angleSpec(m.flip ? a : Math.PI - a, false);
      if (key === "axis-axis") return angleSpec(nearestSense(a, angleBetween(x0.d, y0.d)), true);
      if (key === "plane-axis") {
        // The line-to-plane angle is the complement of the line-to-normal angle.
        const beta = a > Math.PI / 2 ? Math.PI - a : a;
        return angleSpec(nearestSense(Math.PI / 2 - beta, angleBetween(x0.d, y0.d)), true);
      }
      return NEEDS.angle;
    }

    default:
      return "Unsupported mate type";
  }
}

const ORDER: Record<RefType, number> = { plane: 0, axis: 1, point: 2 };

function compileMate(m: MateInput, ia: number, ib: number, pa0: Pose, pb0: Pose, L: number): Constraint | string {
  if (m.type === "lock") {
    const rel = composePose(invertPose(pa0), pb0);
    return {
      id: m.id, ia, ib, refA: null, refB: null, n: 6, kind: "mixed", kick: "rot",
      eval: (pa, pb, out, at, err) => {
        const target = composePose(pa, rel);
        const dp = sub(pb.p, target.p);
        const rv = qlog(qmul(pb.q, qconj(target.q)));
        put3(dp, 1 / L, out, at);
        put3(rv, 1, out, at + 3);
        err[0] = len(rv);
        err[1] = len(dp);
      },
    };
  }
  const refA = cleanRef(m.a.ref);
  const refB = cleanRef(m.b.ref);
  if (!refA || !refB) return "Invalid reference geometry";
  if (m.value !== undefined && !Number.isFinite(m.value)) return "Invalid value";
  const swapped = ORDER[refA.type] > ORDER[refB.type];
  const key = swapped ? `${refB.type}-${refA.type}` : `${refA.type}-${refB.type}`;
  const wa0 = toWorld(pa0, refA);
  const wb0 = toWorld(pb0, refB);
  const spec = swapped ? buildSpec(m, key, wb0, wa0, L) : buildSpec(m, key, wa0, wb0, L);
  if (typeof spec === "string") return spec;
  const emit = spec.emit;
  return {
    id: m.id, ia, ib, refA, refB, n: spec.n, kind: spec.kind, kick: spec.kick,
    eval: (pa, pb, out, at, err) => {
      err[0] = 0;
      err[1] = 0;
      const wa = toWorld(pa, refA);
      const wb = toWorld(pb, refB);
      if (swapped) emit(wb, wa, out, at, err);
      else emit(wa, wb, out, at, err);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------------------------------------------------

/** Cholesky factor (lower, row-major) of A + damping·I for symmetric positive semi-definite A. Null if not positive definite. */
function factor(A: Float64Array, n: number, damping: number): Float64Array | null {
  const C = new Float64Array(A);
  for (let i = 0; i < n; i++) C[i * n + i] += damping;
  for (let j = 0; j < n; j++) {
    let s = C[j * n + j];
    for (let k = 0; k < j; k++) s -= C[j * n + k] * C[j * n + k];
    if (!(s > 0)) return null;
    const d = Math.sqrt(s);
    C[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = C[i * n + j];
      for (let k = 0; k < j; k++) t -= C[i * n + k] * C[j * n + k];
      C[i * n + j] = t / d;
    }
  }
  return C;
}

/** Solves C·Cᵀ·x = sign·b for a factor from `factor`. */
function backSolve(C: Float64Array, n: number, b: Float64Array, sign: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = sign * b[i];
    for (let k = 0; k < i; k++) t -= C[i * n + k] * x[k];
    x[i] = t / C[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = x[i];
    for (let k = i + 1; k < n; k++) t -= C[k * n + i] * x[k];
    x[i] = t / C[i * n + i];
  }
  return x;
}

/**
 * Rank of a symmetric positive semi-definite matrix (destroyed in the process) by Cholesky elimination with diagonal
 * pivoting. Called on JᵀJ, whose pivots are squared singular values, hence the squared tolerance at the call site.
 */
function rankOfGram(A: Float64Array, n: number, tol: number): number {
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) diag[i] = A[i * n + i];
  const order = Array.from({ length: n }, (_, i) => i);
  let first = 0;
  for (let k = 0; k < n; k++) {
    let best = k;
    for (let j = k + 1; j < n; j++) if (diag[order[j]] > diag[order[best]]) best = j;
    const pk = order[best];
    order[best] = order[k];
    order[k] = pk;
    const pivot = diag[pk];
    if (k === 0) first = pivot;
    if (!(pivot > tol * first) || !(pivot > 0)) return k;
    // Right-looking update of the remaining rows and columns.
    for (let a = k + 1; a < n; a++) {
      const ia = order[a];
      const f = A[ia * n + pk] / pivot;
      if (f === 0) continue;
      for (let b = a; b < n; b++) {
        const ib = order[b];
        const v = A[ia * n + ib] - f * A[pk * n + ib];
        A[ia * n + ib] = v;
        A[ib * n + ia] = v;
      }
      diag[ia] = A[ia * n + ia];
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------------------------------------------------

const MAX_ITERATIONS = 100;
/** Budget for the first attempt, straight from the input poses. Past that the start is too far away and staging gets there sooner. */
const FIRST_TRY_ITERATIONS = 30;
/** Budget for re-closing the mates after each relaxation step. */
const RELAX_ITERATIONS = 10;
const MAX_KICKS = 6;
const MAX_RELAX = 12;
const FD_STEP = 1e-5;
const RANK_TOL = 1e-6;
/** Largest rotation of any one component in a single iteration, in radians. */
const MAX_TURN = 0.5;
/**
 * When choosing the nearest solution, one radian of rotation counts as this many characteristic lengths of travel. Well
 * above 1 so that parts slide into place and only turn when a mate needs them to, instead of tumbling to save distance.
 */
const TRAVEL = 100;
/** Arbitrary but fixed directions, used to break symmetric stalls deterministically. */
const SKEW_1 = unit([0.37, 0.53, 0.76]);
const SKEW_2 = unit([-0.61, 0.71, 0.35]);

/** The 23 ways of turning a cube onto itself, half turns first: alternative starting orientations for a part that will not go in. */
const RESTARTS: Quat[] = (() => {
  const h = Math.SQRT1_2;
  const list: Quat[] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  for (const s of [1, -1]) list.push([h, s * h, 0, 0], [h, 0, s * h, 0], [0, h, s * h, 0]);
  for (const s of [1, -1]) list.push([h, 0, 0, s * h], [0, h, 0, s * h], [0, 0, h, s * h]);
  for (const x of [1, -1]) for (const y of [1, -1]) for (const z of [1, -1]) list.push([x / 2, y / 2, z / 2, 0.5]);
  return list;
})();

function validPose(pose: Pose | undefined): pose is Pose {
  if (!pose || !finite3(pose.p) || !Array.isArray(pose.q) || pose.q.length < 4) return false;
  const norm = Math.hypot(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
  return Number.isFinite(norm) && norm > 1e-12;
}

const sumSquares = (v: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
};

interface Normal { A: Float64Array; g: Float64Array; maxDiag: number }

/** A candidate set of poses with its residuals; errs holds [angular rad, positional mm] per mate. */
interface Run { poses: Pose[]; cost: number; errs: Float64Array; res: Float64Array }

interface Setup {
  /** Input poses (quaternions normalised), indexed by component. */
  start: Pose[];
  /**
   * Characteristic length: the largest distance from a component's origin to one of its mate references. Lengths are
   * divided by it so they weigh like the unitless direction residuals.
   */
  L: number;
  posTol: number;
}

/**
 * The mates in `cons` as a least-squares problem over the poses of the components in `active`; every other component
 * stays put. `weight` is how many characteristic lengths of travel one radian of rotation is worth: TRAVEL to stay
 * close to the input poses, 1 for the most dependable convergence from far away.
 */
function createSystem(setup: Setup, cons: Constraint[], active: number[], weight: number) {
  const { start, L, posTol } = setup;
  const travel = weight * L;
  const colOf = start.map(() => -1);
  active.forEach((comp, k) => {
    colOf[comp] = 6 * k;
  });
  const n = 6 * active.length;
  const rowOf: number[] = [];
  let m = 0;
  for (const c of cons) {
    rowOf.push(m);
    m += c.n;
  }
  const colsOf = cons.map((c) => {
    const list: number[] = [];
    for (const i of [c.ia, c.ib]) if (colOf[i] >= 0) for (let k = 0; k < 6; k++) list.push(colOf[i] + k);
    return list;
  });

  const scratchErr = new Float64Array(2);
  const bufPlus = new Float64Array(6);
  const bufMinus = new Float64Array(6);

  const evaluate = (poses: Pose[]): Run => {
    const res = new Float64Array(m);
    const errs = new Float64Array(2 * cons.length);
    for (let ci = 0; ci < cons.length; ci++) {
      const c = cons[ci];
      c.eval(poses[c.ia], poses[c.ib], res, rowOf[ci], scratchErr);
      errs[2 * ci] = scratchErr[0];
      errs[2 * ci + 1] = scratchErr[1];
    }
    return { poses, cost: sumSquares(res), errs, res };
  };

  const mateOk = (errs: Float64Array, ci: number, factor = 1): boolean =>
    errs[2 * ci] < ANG_TOL * factor && errs[2 * ci + 1] < posTol * factor;
  const allOk = (errs: Float64Array, factor = 1): boolean => {
    for (let ci = 0; ci < cons.length; ci++) if (!mateOk(errs, ci, factor)) return false;
    return true;
  };

  /** Moves one component along unknown k: 0..2 translate along world x/y/z by h·L, 3..5 turn about world x/y/z through its origin by h. */
  const nudge = (pose: Pose, k: number, h: number): Pose => {
    if (k < 3) {
      const p: Vec3 = [pose.p[0], pose.p[1], pose.p[2]];
      p[k] += h * L;
      return { p, q: pose.q };
    }
    const w: Vec3 = [0, 0, 0];
    w[k - 3] = h;
    return { p: pose.p, q: qmul(qexp(w), pose.q) };
  };

  /** Central-difference Jacobian of the residuals, dense m×n row-major. */
  const jacobian = (poses: Pose[]): Float64Array => {
    const J = new Float64Array(m * n);
    for (let ci = 0; ci < cons.length; ci++) {
      const c = cons[ci];
      for (let side = 0; side < 2; side++) {
        const comp = side === 0 ? c.ia : c.ib;
        const col = colOf[comp];
        if (col < 0) continue;
        for (let k = 0; k < 6; k++) {
          const plus = nudge(poses[comp], k, FD_STEP);
          const minus = nudge(poses[comp], k, -FD_STEP);
          if (side === 0) {
            c.eval(plus, poses[c.ib], bufPlus, 0, scratchErr);
            c.eval(minus, poses[c.ib], bufMinus, 0, scratchErr);
          } else {
            c.eval(poses[c.ia], plus, bufPlus, 0, scratchErr);
            c.eval(poses[c.ia], minus, bufMinus, 0, scratchErr);
          }
          // The translation unknowns are in units of `travel`, not L.
          const unit = (k < 3 ? weight : 1) / (2 * FD_STEP);
          for (let i = 0; i < c.n; i++) J[(rowOf[ci] + i) * n + col + k] = (bufPlus[i] - bufMinus[i]) * unit;
        }
      }
    }
    return J;
  };

  /** JᵀJ and Jᵀr, optionally over a subset of the mates. */
  const normalEquations = (J: Float64Array, res: Float64Array, include?: (ci: number) => boolean): Normal => {
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let ci = 0; ci < cons.length; ci++) {
      if (include && !include(ci)) continue;
      const cols = colsOf[ci];
      for (let i = 0; i < cons[ci].n; i++) {
        const row = (rowOf[ci] + i) * n;
        for (const a of cols) {
          const ja = J[row + a];
          if (ja === 0) continue;
          g[a] += ja * res[rowOf[ci] + i];
          for (const b of cols) A[a * n + b] += ja * J[row + b];
        }
      }
    }
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, A[i * n + i]);
    return { A, g, maxDiag };
  };

  const step = (poses: Pose[], dx: Float64Array, factor: number): Pose[] => {
    const next = poses.slice();
    for (const i of active) {
      const c = colOf[i];
      const pose = poses[i];
      next[i] = {
        p: [pose.p[0] + factor * travel * dx[c], pose.p[1] + factor * travel * dx[c + 1], pose.p[2] + factor * travel * dx[c + 2]],
        q: qnormalize(qmul(qexp([factor * dx[c + 3], factor * dx[c + 4], factor * dx[c + 5]]), pose.q)),
      };
    }
    return next;
  };

  /**
   * Levenberg–Marquardt. The damping never reaches zero, so every step lies in the row space of the Jacobian: directions
   * that no mate cares about are left alone, which is what keeps under-constrained parts close to where they were.
   */
  const descend = (from: Pose[], maxIterations = MAX_ITERATIONS): Run => {
    let cur = evaluate(from);
    let lambda = 1e-4 / (weight * weight);
    for (let iter = 0; iter < maxIterations && !allOk(cur.errs, POLISH); iter++) {
      const { A, g, maxDiag } = normalEquations(jacobian(cur.poses), cur.res);
      let gMax = 0;
      for (let i = 0; i < n; i++) gMax = Math.max(gMax, Math.abs(g[i]));
      if (!(maxDiag > 0) || !(gMax > 1e-15)) break;
      let next: Run | null = null;
      for (; lambda <= 1e8; lambda *= 10) {
        const C = factor(A, n, lambda * maxDiag);
        if (!C) continue;
        const dx = backSolve(C, n, g, -1);
        // Never turn a part far in one go: a long stride can vault over a hump into the basin of a different solution
        // (the other sense of a parallel mate, say) when the one on this side is nearer.
        let turn = 0;
        for (let c = 3; c < n; c += 6) turn = Math.max(turn, Math.hypot(dx[c], dx[c + 1], dx[c + 2]));
        const stride = Math.min(1, MAX_TURN / turn);
        const trial = evaluate(step(cur.poses, dx, stride));
        if (!Number.isFinite(trial.cost) || !(trial.cost < cur.cost)) continue;
        // Compare with what the linear model promised, to decide how much to trust it next time.
        let slope = 0;
        let damped = 0;
        for (let i = 0; i < n; i++) {
          slope -= dx[i] * g[i];
          damped += lambda * maxDiag * dx[i] * dx[i];
        }
        const ratio = (cur.cost - trial.cost) / (stride * (2 - stride) * slope + stride * stride * damped);
        if (ratio > 0.75) lambda *= 0.1;
        else if (ratio < 0.25) lambda *= 4;
        next = trial;
        break;
      }
      if (!next) break;
      lambda = Math.min(Math.max(lambda, 1e-10), 1e8);
      const gain = cur.cost - next.cost;
      cur = next;
      if (gain < 1e-10 * cur.cost) break;
    }
    return cur;
  };

  /** Unsatisfied mates whose own gradient vanishes: a face that must turn exactly 180°, say, or parallel edges asked to be square. */
  const stalledMates = (run: Run): number[] => {
    const J = jacobian(run.poses);
    const list: number[] = [];
    for (let ci = 0; ci < cons.length; ci++) {
      if (mateOk(run.errs, ci)) continue;
      let r2 = 0;
      let g2 = 0;
      for (let i = 0; i < cons[ci].n; i++) r2 += run.res[rowOf[ci] + i] ** 2;
      for (const a of colsOf[ci]) {
        let ga = 0;
        for (let i = 0; i < cons[ci].n; i++) ga += J[(rowOf[ci] + i) * n + a] * run.res[rowOf[ci] + i];
        g2 += ga * ga;
      }
      if (g2 <= 1e-8 * r2) list.push(ci);
    }
    return list;
  };

  /** Deterministic nudge of one component per stalled mate, about an axis chosen from the mate's own geometry. */
  const kick = (poses: Pose[], stalled: number[], attempt: number): Pose[] => {
    const next = poses.slice();
    const done = new Set<number>();
    const angle = [0.1, 0.1, 0.25, 0.25, 0.6, 0.6][attempt % 6];
    for (const ci of stalled) {
      const c = cons[ci];
      const moveB = colOf[c.ib] >= 0;
      const comp = moveB ? c.ib : c.ia;
      if (done.has(comp)) continue;
      done.add(comp);
      const own = moveB ? c.refB : c.refA;
      const other = moveB ? c.refA : c.refB;
      let d: Vec3 | null = null;
      if (own && own.type !== "point") d = qrot(poses[comp].q, own.dir);
      else if (other && other.type !== "point") d = qrot(poses[moveB ? c.ia : c.ib].q, other.dir);
      let axis1 = SKEW_1;
      let axis2 = SKEW_2;
      if (d) {
        let p = cross(d, SKEW_1);
        if (len(p) < 0.1) p = cross(d, SKEW_2);
        axis1 = unit(p);
        axis2 = cross(d, axis1);
      }
      const axis = attempt % 2 === 0 ? axis1 : axis2;
      let pose = next[comp];
      if (c.kick !== "trans") pose = { p: pose.p, q: qnormalize(qmul(qexp(scale(axis, angle)), pose.q)) };
      if (c.kick !== "rot") pose = { p: add(pose.p, scale(axis, 0.05 * L * (1 + attempt))), q: pose.q };
      next[comp] = pose;
    }
    return next;
  };

  /** Descends from the given poses, shaking individual mates loose when they come to rest on a stationary point that is not a solution. */
  const settle = (from: Pose[], maxIterations = MAX_ITERATIONS): Run => {
    let best = descend(from, maxIterations);
    for (let attempt = 0; attempt < MAX_KICKS && !allOk(best.errs); attempt++) {
      const stalled = stalledMates(best);
      if (stalled.length === 0) break;
      const trial = descend(kick(best.poses, stalled, attempt), maxIterations);
      if (allOk(trial.errs) || trial.cost < best.cost * 0.999) best = trial;
    }
    return best;
  };

  /** How far the active components are from where they started, as [Δp/travel, rotation vector] per component. */
  const displacement = (poses: Pose[]): Float64Array => {
    const d = new Float64Array(n);
    for (const i of active) {
      const c = colOf[i];
      const dp = sub(poses[i].p, start[i].p);
      const rv = qlog(qmul(poses[i].q, qconj(start[i].q)));
      for (let k = 0; k < 3; k++) {
        d[c + k] = dp[k] / travel;
        d[c + 3 + k] = rv[k];
      }
    }
    return d;
  };

  /**
   * Slides a solved assembly along its remaining freedoms back towards the input poses (projected gradient descent on the
   * distance travelled), so the result is the nearest solution and not merely a nearby one.
   */
  const relax = (solved: Run): Run => {
    let cur = solved;
    let dist = sumSquares(displacement(cur.poses));
    for (let iter = 0; iter < MAX_RELAX && dist > 1e-20; iter++) {
      const d = displacement(cur.poses);
      const { A, maxDiag } = normalEquations(jacobian(cur.poses), cur.res);
      if (!(maxDiag > 0)) break;
      // (A + εI)⁻¹A keeps the part of a vector that the mates pin down, almost: a fraction ~ε/σ² of it leaks through.
      // Removing it twice squares that leak, so a fully constrained assembly is not nudged about within its tolerances.
      const C = factor(A, n, 1e-9 * maxDiag);
      if (!C) break;
      let free = d;
      for (let pass = 0; pass < 2; pass++) {
        const Af = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (let j = 0; j < n; j++) s += A[i * n + j] * free[j];
          Af[i] = s;
        }
        const pinned = backSolve(C, n, Af, 1);
        const rest = new Float64Array(n);
        for (let i = 0; i < n; i++) rest[i] = free[i] - pinned[i];
        free = rest;
      }
      if (sumSquares(free) < 1e-12 * dist) break;
      // The step is only good to first order, so keep it short enough that the mates can be re-closed in a few iterations.
      let largest = 0;
      for (let i = 0; i < n; i++) largest = Math.max(largest, Math.abs(free[i]));
      const reach = Math.min(1, 0.5 / largest);
      let next: Run | null = null;
      for (const factor of [reach, reach / 2]) {
        const trial = descend(step(cur.poses, free, -factor), RELAX_ITERATIONS);
        if (allOk(trial.errs) && sumSquares(displacement(trial.poses)) < dist * (1 - 1e-9)) {
          next = trial;
          break;
        }
      }
      if (!next) break;
      cur = next;
      dist = sumSquares(displacement(cur.poses));
    }
    return cur;
  };

  /** Number of independent freedoms the satisfied mates remove at these poses. */
  const rank = (run: Run): number => {
    if (n === 0) return 0;
    const { A } = normalEquations(jacobian(run.poses), run.res, (ci) => mateOk(run.errs, ci));
    // Judge the rank with translations and rotations weighted alike, not skewed by the travel weighting.
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) A[a * n + b] /= (a % 6 < 3 ? weight : 1) * (b % 6 < 3 ? weight : 1);
    }
    return rankOfGram(A, n, RANK_TOL * RANK_TOL);
  };

  return { n, evaluate, mateOk, allOk, settle, relax, rank };
}

export function solveMates(components: ComponentInput[], mates: MateInput[]): MateResult {
  try {
    const result = solve(components, mates);
    for (const pose of Object.values(result.poses)) {
      if (!pose.p.every(Number.isFinite) || !pose.q.every(Number.isFinite)) throw new Error("non-finite pose");
    }
    if (!Number.isFinite(result.dof)) throw new Error("non-finite dof");
    return result;
  } catch {
    return fallback(components, mates);
  }
}

function fallback(components: ComponentInput[], mates: MateInput[]): MateResult {
  const poses: Record<string, Pose> = {};
  let dof = 0;
  for (const c of Array.isArray(components) ? components : []) {
    if (!c || c.id in poses) continue;
    poses[c.id] = validPose(c.pose) ? copyPose(c.pose) : copyPose(IDENTITY_POSE);
    if (!c.fixed) dof += 6;
  }
  const status: Record<string, MateStatus> = {};
  for (const m of Array.isArray(mates) ? mates : []) if (m) status[m.id] = { ok: false, residual: 0, error: "Solver failed" };
  return { poses, mates: status, dof, converged: false };
}

function solve(components: ComponentInput[], mates: MateInput[]): MateResult {
  // ---- components ----
  const index = new Map<string, number>();
  const comps: ComponentInput[] = [];
  for (const c of components) {
    if (index.has(c.id)) continue;
    index.set(c.id, comps.length);
    comps.push(c);
  }
  const valid = comps.map((c) => validPose(c.pose));
  const start: Pose[] = comps.map((c, i) => {
    if (!valid[i]) return copyPose(IDENTITY_POSE);
    const pose = copyPose(c.pose);
    pose.q = qnormalize(pose.q);
    return pose;
  });
  const movable = comps.map((c, i) => !c.fixed && valid[i]);

  // ---- mates ----
  const status: Record<string, MateStatus> = {};
  const fail = (m: MateInput, error: string): void => {
    status[m.id] = { ok: false, residual: 0, error };
  };
  const usable: { m: MateInput; ia: number; ib: number }[] = [];
  let L = 1;
  for (const m of mates) {
    const ia = index.get(m.a?.component);
    const ib = index.get(m.b?.component);
    if (ia === undefined || ib === undefined) fail(m, "Component not found");
    else if (ia === ib) fail(m, "Both sides are on the same component");
    else if (!valid[ia] || !valid[ib]) fail(m, "Invalid component pose");
    else {
      // Dry run: only mates that will take part may influence the length scale.
      const probe = compileMate(m, ia, ib, start[ia], start[ib], 1);
      if (typeof probe === "string") fail(m, probe);
      else {
        usable.push({ m, ia, ib });
        for (const ref of [probe.refA, probe.refB]) if (ref) L = Math.max(L, len(ref.origin));
      }
    }
  }
  const setup: Setup = { start, L, posTol: POS_TOL * Math.max(1, L / 100) };

  const cons: Constraint[] = []; // at least one movable side: these are solved
  const frozen: Constraint[] = []; // both sides fixed: only checked
  for (const { m, ia, ib } of usable) {
    const c = compileMate(m, ia, ib, start[ia], start[ib], L);
    if (typeof c === "string") fail(m, c);
    else if (movable[ia] || movable[ib]) cons.push(c);
    else frozen.push(c);
  }

  // ---- unknowns: 6 per movable component that some mate touches ----
  const isActive = comps.map(() => false);
  const active: number[] = [];
  for (const c of cons) {
    for (const i of [c.ia, c.ib]) {
      if (movable[i] && !isActive[i]) {
        isActive[i] = true;
        active.push(i);
      }
    }
  }
  const system = createSystem(setup, cons, active, TRAVEL);

  /**
   * Fallback starting point when descending from the input poses gets trapped in a local minimum: put the parts in one at
   * a time, each against the ones already placed, the way a person would build the assembly. A single part is cheap to
   * solve, so it can afford to retry from other orientations until one works.
   */
  const placeOneByOne = (): Pose[] => {
    const poses = start.slice();
    const placed = isActive.map((a) => !a);
    const remaining = new Set(active);
    while (remaining.size > 0) {
      let pick = -1;
      let most = 0;
      for (const i of remaining) {
        let count = 0;
        for (const c of cons) if ((c.ia === i && placed[c.ib]) || (c.ib === i && placed[c.ia])) count++;
        if (count > most) {
          most = count;
          pick = i;
        }
      }
      if (pick < 0) {
        // A group that is not tied to anything placed yet: its first part stays where it is and the rest gather round it.
        pick = remaining.values().next().value as number;
      } else {
        const part = pick;
        const ties = cons.filter((c) => (c.ia === part && placed[c.ib]) || (c.ib === part && placed[c.ia]));
        const local = createSystem(setup, ties, [part], 1);
        let run = local.settle(poses);
        for (let k = 0; k < RESTARTS.length && !local.allOk(run.errs); k++) {
          const turned = poses.slice();
          turned[part] = { p: poses[part].p, q: qnormalize(qmul(RESTARTS[k], poses[part].q)) };
          const trial = local.settle(turned);
          if (local.allOk(trial.errs) || trial.cost < 0.99 * run.cost) run = trial;
        }
        poses[part] = run.poses[part];
      }
      placed[pick] = true;
      remaining.delete(pick);
    }
    return poses;
  };

  // ---- solve ----
  let best = system.evaluate(start);
  if (system.n > 0 && !system.allOk(best.errs)) {
    best = system.settle(start, FIRST_TRY_ITERATIONS);
    if (!system.allOk(best.errs)) {
      const plain = createSystem(setup, cons, active, 1);
      const staged = plain.settle(placeOneByOne());
      if (plain.allOk(staged.errs) || staged.cost < 0.99 * best.cost) best = staged;
      if (!plain.allOk(best.errs)) {
        // Nothing satisfies every mate: finish converging on the least-squares compromise.
        const polished = plain.settle(best.poses);
        if (polished.cost <= best.cost) best = polished;
      }
    }
    if (system.allOk(best.errs)) best = system.relax(best);
  }

  // ---- report ----
  // Mates with both a direction and a position part report mm, counting an angular error as the gap it opens at distance L.
  const residualOf = (c: Constraint, ang: number, pos: number): number =>
    c.kind === "ang" ? ang : c.kind === "pos" ? pos : Math.max(pos, ang * L);
  let converged = true;
  cons.forEach((c, ci) => {
    const residual = residualOf(c, best.errs[2 * ci], best.errs[2 * ci + 1]);
    if (system.mateOk(best.errs, ci)) status[c.id] = { ok: true, residual };
    else {
      status[c.id] = { ok: false, residual, error: "Conflicts with other mates" };
      converged = false;
    }
  });
  const out = new Float64Array(6);
  const err = new Float64Array(2);
  for (const c of frozen) {
    c.eval(start[c.ia], start[c.ib], out, 0, err);
    const residual = residualOf(c, err[0], err[1]);
    if (err[0] < ANG_TOL && err[1] < setup.posTol) status[c.id] = { ok: true, residual };
    else {
      status[c.id] = { ok: false, residual, error: "Not satisfied, and both components are fixed" };
      converged = false;
    }
  }

  let dof = 0;
  for (const c of comps) if (!c.fixed) dof += 6;
  dof -= system.rank(best);

  const poses: Record<string, Pose> = {};
  comps.forEach((c, i) => {
    // Components that did not move (fixed, untouched by any mate, or already in place) are handed back exactly as given.
    poses[c.id] = best.poses[i] !== start[i] ? copyPose(best.poses[i]) : valid[i] ? copyPose(c.pose) : copyPose(IDENTITY_POSE);
  });
  return { poses, mates: status, dof, converged };
}

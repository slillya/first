import { describe, expect, it } from "vitest";
import {
  IDENTITY_POSE,
  applyPose,
  composePose,
  invertPose,
  poseToMatrix,
  rotateByPose,
  solveMates,
  type ComponentInput,
  type GeoRef,
  type MateInput,
  type MateResult,
  type MateType,
  type Pose,
  type Quat,
  type Vec3,
} from "../src/assembly/mates";

// ---- small helpers -------------------------------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => [a[0] / len(a), a[1] / len(a), a[2] / len(a)];
const deg = (rad: number): number => (rad * 180) / Math.PI;
const angle = (a: Vec3, b: Vec3): number => Math.atan2(len(cross(a, b)), dot(a, b));

function axisAngle(axis: Vec3, degrees: number): Quat {
  const a = norm(axis);
  const h = (degrees * Math.PI) / 360;
  return [a[0] * Math.sin(h), a[1] * Math.sin(h), a[2] * Math.sin(h), Math.cos(h)];
}
const pose = (p: Vec3, axis: Vec3 = [0, 0, 1], degrees = 0): Pose => ({ p, q: axisAngle(axis, degrees) });
/** Rotation angle (rad) that takes pose a's orientation to pose b's. */
function rotationBetween(a: Pose, b: Pose): number {
  const rel = composePose(b, invertPose(a)).q;
  return 2 * Math.atan2(Math.hypot(rel[0], rel[1], rel[2]), Math.abs(rel[3]));
}

type DirRef = Extract<GeoRef, { dir: Vec3 }>;
const plane = (origin: Vec3, dir: Vec3): DirRef => ({ type: "plane", origin, dir });
const axis = (origin: Vec3, dir: Vec3): DirRef => ({ type: "axis", origin, dir });
const point = (origin: Vec3): GeoRef => ({ type: "point", origin });

/** Faces of a 10 mm cube occupying [0,10]³ in its own coordinates. */
const BOX = {
  xp: plane([10, 5, 5], [1, 0, 0]),
  xn: plane([0, 5, 5], [-1, 0, 0]),
  yp: plane([5, 10, 5], [0, 1, 0]),
  yn: plane([5, 0, 5], [0, -1, 0]),
  zp: plane([5, 5, 10], [0, 0, 1]),
  zn: plane([5, 5, 0], [0, 0, -1]),
};
const START_B = pose([37, -12, 8], [1, 2, 3], 73);

let mateSeq = 0;
type Side = [component: string, ref: GeoRef];
function mate(type: MateType, a: Side, b: Side, extra: { value?: number; flip?: boolean; id?: string } = {}): MateInput {
  const id = extra.id ?? `m${++mateSeq}`;
  return { id, type, a: { component: a[0], ref: a[1] }, b: { component: b[0], ref: b[1] }, value: extra.value, flip: extra.flip };
}
const fixedA: ComponentInput = { id: "A", pose: IDENTITY_POSE, fixed: true };
const freeB = (p: Pose = START_B): ComponentInput => ({ id: "B", pose: p });

/** World-space origin and direction of a ref on a solved component. */
function world(result: MateResult, component: string, ref: GeoRef): { o: Vec3; d: Vec3 } {
  const p = result.poses[component];
  return { o: applyPose(p, ref.origin), d: ref.type === "point" ? [0, 0, 0] : rotateByPose(p, ref.dir) };
}
const distToLine = (p: Vec3, line: { o: Vec3; d: Vec3 }): number => len(cross(sub(p, line.o), line.d));

function expectFinite(result: MateResult): void {
  for (const p of Object.values(result.poses)) {
    for (const v of [...p.p, ...p.q]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(...p.q)).toBeCloseTo(1, 9);
  }
  for (const s of Object.values(result.mates)) expect(Number.isFinite(s.residual)).toBe(true);
  expect(Number.isFinite(result.dof)).toBe(true);
}
function expectSolved(result: MateResult): void {
  expectFinite(result);
  for (const [id, s] of Object.entries(result.mates)) expect(s, `mate ${id}`).toMatchObject({ ok: true });
  expect(result.converged).toBe(true);
}
function expectPoseClose(actual: Pose, expected: Pose, tol = 1e-6): void {
  expect(len(sub(actual.p, expected.p))).toBeLessThan(tol);
  expect(rotationBetween(actual, expected)).toBeLessThan(tol);
}
/** Solves A (fixed, identity) + B (free) with the given mates between them. */
const solveAB = (mates: MateInput[], startB: Pose = START_B): MateResult => solveMates([fixedA, freeB(startB)], mates);

// ---- tests ---------------------------------------------------------------------------------------------------------

describe("pose helpers", () => {
  const a = pose([3, -4, 5], [1, 1, 0], 40);
  const b = pose([-7, 2, 1], [0, 2, 1], 115);
  const v: Vec3 = [1.5, -2, 0.25];

  it("compose applies b first, then a", () => {
    const viaCompose = applyPose(composePose(a, b), v);
    const viaSteps = applyPose(a, applyPose(b, v));
    expect(len(sub(viaCompose, viaSteps))).toBeLessThan(1e-12);
  });

  it("invert round-trips", () => {
    expectPoseClose(composePose(a, invertPose(a)), IDENTITY_POSE, 1e-12);
    expectPoseClose(composePose(invertPose(a), a), IDENTITY_POSE, 1e-12);
    expect(len(sub(applyPose(invertPose(a), applyPose(a, v)), v))).toBeLessThan(1e-12);
  });

  it("rotateByPose ignores translation", () => {
    expect(len(sub(rotateByPose(a, v), sub(applyPose(a, v), a.p)))).toBeLessThan(1e-12);
    expect(len(rotateByPose(a, v))).toBeCloseTo(len(v), 12);
  });

  it("poseToMatrix is column-major and matches applyPose", () => {
    const m = poseToMatrix(a);
    expect(m).toHaveLength(16);
    expect([m[3], m[7], m[11], m[15]]).toEqual([0, 0, 0, 1]);
    expect([m[12], m[13], m[14]]).toEqual(a.p);
    const viaMatrix: Vec3 = [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
    ];
    expect(len(sub(viaMatrix, applyPose(a, v)))).toBeLessThan(1e-12);
    // 90° about z sends x to y: that is the first COLUMN, i.e. elements 0..2.
    const quarter = poseToMatrix(pose([0, 0, 0], [0, 0, 1], 90));
    expect(quarter[0]).toBeCloseTo(0, 12);
    expect(quarter[1]).toBeCloseTo(1, 12);
    expect(quarter[4]).toBeCloseTo(-1, 12);
  });

  it("identity pose is the identity", () => {
    expect(applyPose(IDENTITY_POSE, v)).toEqual(v);
    expect(poseToMatrix(IDENTITY_POSE)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});

describe("solveMates", () => {
  it("1. three face mates fully locate a box", () => {
    const r = solveAB([
      mate("coincident", ["A", BOX.xp], ["B", BOX.xn]),
      mate("coincident", ["A", BOX.yp], ["B", BOX.yp], { flip: true }),
      mate("coincident", ["A", BOX.zn], ["B", BOX.zn], { flip: true }),
    ]);
    expectSolved(r);
    expect(r.dof).toBe(0);
    // World-space plane equations: B's -x face lies in x = 10 facing -x, and so on.
    const xn = world(r, "B", BOX.xn);
    expect(xn.o[0]).toBeCloseTo(10, 6);
    expect(len(sub(xn.d, [-1, 0, 0]))).toBeLessThan(1e-6);
    const yp = world(r, "B", BOX.yp);
    expect(yp.o[1]).toBeCloseTo(10, 6);
    expect(len(sub(yp.d, [0, 1, 0]))).toBeLessThan(1e-6);
    const zn = world(r, "B", BOX.zn);
    expect(zn.o[2]).toBeCloseTo(0, 6);
    expect(len(sub(zn.d, [0, 0, -1]))).toBeLessThan(1e-6);
    expectPoseClose(r.poses.B, pose([10, 0, 0]));
    expect(r.poses.A).toEqual(IDENTITY_POSE);
  });

  it("2. pin in hole leaves one rotation", () => {
    const hole = axis([5, 5, 0], [0, 0, 1]);
    const pinAxis = axis([0, 0, 0], [0, 0, 1]);
    const shoulder = plane([0, 0, 20], [0, 0, -1]);
    const r = solveAB([mate("concentric", ["A", hole], ["B", pinAxis]), mate("coincident", ["A", BOX.zp], ["B", shoulder])]);
    expectSolved(r);
    expect(r.dof).toBe(1);
    const w = world(r, "B", pinAxis);
    expect(Math.abs(w.d[2])).toBeCloseTo(1, 9);
    expect(w.o[0]).toBeCloseTo(5, 6);
    expect(w.o[1]).toBeCloseTo(5, 6);
    expect(world(r, "B", shoulder).o[2]).toBeCloseTo(10, 6);
    expect(world(r, "B", shoulder).d[2]).toBeCloseTo(-1, 9);
  });

  it("3. a single face mate moves the part as little as possible", () => {
    const r = solveAB([mate("coincident", ["A", BOX.zp], ["B", BOX.zn])]);
    expectSolved(r);
    expect(r.dof).toBe(3);
    const w = world(r, "B", BOX.zn);
    expect(w.o[2]).toBeCloseTo(10, 6);
    expect(len(sub(w.d, [0, 0, -1]))).toBeLessThan(1e-6);
    // Nearest solution: the part's origin only travels along the plane normal...
    expect(r.poses.B.p[0]).toBeCloseTo(START_B.p[0], 4);
    expect(r.poses.B.p[1]).toBeCloseTo(START_B.p[1], 4);
    // ...and it turns by exactly the angle between where the face pointed and where it has to point, with no extra twist.
    const needed = angle(rotateByPose(START_B, BOX.zn.dir), [0, 0, -1]);
    expect(rotationBetween(START_B, r.poses.B)).toBeCloseTo(needed, 4);
  });

  it("3b. a part that already satisfies its mates is not moved at all", () => {
    const start = pose([3, -6, 10], [0, 0, 1], 25);
    const r = solveAB([mate("coincident", ["A", BOX.zp], ["B", BOX.zn])], start);
    expectSolved(r);
    expect(r.poses.B).toEqual(start);
  });

  it("3c. solving is idempotent and deterministic", () => {
    const mates = [mate("coincident", ["A", BOX.zp], ["B", BOX.zn]), mate("parallel", ["A", BOX.xp], ["B", BOX.yp])];
    const first = solveAB(mates);
    const again = solveAB(mates);
    expect(again).toEqual(first);
    const second = solveMates([fixedA, freeB(first.poses.B)], mates);
    expectSolved(second);
    expectPoseClose(second.poses.B, first.poses.B, 1e-9);
  });

  it("3d. parts slide into place and only turn as far as a mate needs", () => {
    // A vertex mate needs no rotation at all, however far away the part starts.
    const farAway = pose([150, -80, 40], [1, 2, 3], 40);
    const corner = solveAB([mate("coincident", ["A", point([10, 10, 10])], ["B", point([10, 0, 10])])], farAway);
    expectSolved(corner);
    expect(deg(rotationBetween(farAway, corner.poses.B))).toBeLessThan(0.1);
    // A pin only turns by the angle between its axis and the hole's.
    const hole = axis([5, 5, 0], [0, 0, 1]);
    const pinStart = pose([60, 25, -20], [1, 2, 3], 40);
    const pin = solveAB([mate("concentric", ["A", hole], ["B", hole])], pinStart);
    expectSolved(pin);
    const tilt = angle(rotateByPose(pinStart, hole.dir), hole.dir);
    expect(rotationBetween(pinStart, pin.poses.B)).toBeCloseTo(Math.min(tilt, Math.PI - tilt), 4);
    // Parallel without a stated sense goes to whichever sense is nearer.
    for (const [tip, sense] of [[80, 1], [100, -1]]) {
      const start = pose([1, 2, 3], [1, 0, 0], tip);
      const r = solveAB([mate("parallel", ["A", BOX.zp], ["B", BOX.zp])], start);
      expectSolved(r);
      expect(world(r, "B", BOX.zp).d[2]).toBeCloseTo(sense, 9);
      expect(deg(rotationBetween(start, r.poses.B))).toBeCloseTo(sense > 0 ? tip : 180 - tip, 3);
    }
  });

  it("4. distance between faces, with and without flip", () => {
    const opposed = solveAB([mate("distance", ["A", BOX.zp], ["B", BOX.zn], { value: 5 })]);
    expectSolved(opposed);
    const a = { o: BOX.zp.origin, d: BOX.zp.dir };
    let b = world(opposed, "B", BOX.zn);
    expect(dot(sub(b.o, a.o), a.d)).toBeCloseTo(5, 6);
    expect(dot(b.d, a.d)).toBeCloseTo(-1, 9);
    expect(opposed.dof).toBe(3);

    const aligned = solveAB([mate("distance", ["A", BOX.zp], ["B", BOX.zp], { value: 5, flip: true })]);
    expectSolved(aligned);
    b = world(aligned, "B", BOX.zp);
    expect(dot(sub(b.o, a.o), a.d)).toBeCloseTo(5, 6);
    expect(dot(b.d, a.d)).toBeCloseTo(1, 9);
  });

  it("5. a face pointing exactly the wrong way gets turned around", () => {
    // B is axis-aligned with A, so mating top to top needs a half turn and the naive gradient is exactly zero.
    const m = mate("coincident", ["A", BOX.zp], ["B", BOX.zp]);
    for (const start of [pose([0, 0, 30]), pose([14, -3, 2], [0, 0, 1], 35), pose([0, 0, 0])]) {
      const r = solveAB([m], start);
      expectSolved(r);
      const w = world(r, "B", BOX.zp);
      expect(w.d[2]).toBeCloseTo(-1, 9);
      expect(w.o[2]).toBeCloseTo(10, 6);
      expect(rotationBetween(start, r.poses.B)).toBeCloseTo(Math.PI, 5);
    }
  });

  it("5b. a half turn is found when other mates pin the rest", () => {
    // Top to top and right to right both need flipping; front to back is already fine. Only a half turn about y does it.
    const r = solveAB(
      [
        mate("coincident", ["A", BOX.zp], ["B", BOX.zp]),
        mate("coincident", ["A", BOX.xp], ["B", BOX.xp]),
        mate("coincident", ["A", BOX.yp], ["B", BOX.yn]),
      ],
      pose([3, 2, 1]),
    );
    expectSolved(r);
    expect(r.dof).toBe(0);
    expectPoseClose(r.poses.B, pose([20, 10, 20], [0, 1, 0], 180));
  });

  it("5c. a part trapped on the wrong side of a hump is re-seated", () => {
    // With B's base on A's top, only one spin about z makes the two slanted faces parallel. Starting 172° away from it,
    // the slanted faces are closer to anti-parallel, which the base mate makes unreachable: a local minimum.
    const slant = plane([0, 0, 0], norm([2, 0, 1]));
    const mates = [mate("coincident", ["A", BOX.zp], ["B", BOX.zn]), mate("parallel", ["A", slant], ["B", slant])];
    const r = solveAB(mates, pose([20, 3, 25], [0, 0, 1], 172));
    expectSolved(r);
    expect(Math.abs(dot(world(r, "B", slant).d, slant.dir))).toBeCloseTo(1, 9);
    expect(world(r, "B", BOX.zn).o[2]).toBeCloseTo(10, 6);
    expect(r.dof).toBe(2);
  });

  it("6. angle mates", () => {
    const za = axis([0, 0, 0], [0, 0, 1]);
    const zb = axis([1, 2, 3], [0, 0, 1]);
    for (const start of [START_B, pose([5, 5, 5]), pose([0, 0, 0], [1, 0, 0], 180)]) {
      const r = solveAB([mate("angle", ["A", za], ["B", zb], { value: 30 })], start);
      expectSolved(r);
      const between = deg(angle(za.dir, world(r, "B", zb).d));
      expect(Math.min(between, 180 - between)).toBeCloseTo(30, 5);
      expect(r.dof).toBe(5);
    }
    // The sense nearest the start is kept: starting at 170° between the directions ends at 150°, not 30°.
    const near = solveAB([mate("angle", ["A", za], ["B", zb], { value: 30 })], pose([0, 0, 0], [1, 0, 0], 170));
    expect(deg(angle(za.dir, world(near, "B", zb).d))).toBeCloseTo(150, 5);

    const square = solveAB([mate("angle", ["A", BOX.zp], ["B", BOX.zn], { value: 90 })]);
    expectSolved(square);
    expect(dot(BOX.zp.dir, world(square, "B", BOX.zn).d)).toBeCloseTo(0, 6);

    // Opposing faces are 0°, so 30° is measured between na and −nb; with flip, between na and nb.
    const tilted = solveAB([mate("angle", ["A", BOX.zp], ["B", BOX.zn], { value: 30 })]);
    expectSolved(tilted);
    expect(deg(angle([0, 0, -1], world(tilted, "B", BOX.zn).d))).toBeCloseTo(30, 5);
    const flipped = solveAB([mate("angle", ["A", BOX.zp], ["B", BOX.zn], { value: 30, flip: true })]);
    expectSolved(flipped);
    expect(deg(angle([0, 0, 1], world(flipped, "B", BOX.zn).d))).toBeCloseTo(30, 5);
    const flat = solveAB([mate("angle", ["A", BOX.zp], ["B", BOX.zn], { value: 0 })], pose([1, 2, 3]));
    expectSolved(flat);
    expect(world(flat, "B", BOX.zn).d[2]).toBeCloseTo(-1, 9);

    // Line to plane: 90° means the line is square to the face, 0° means it lies along it.
    const lineB = axis([2, 0, 0], [1, 0, 0]);
    for (const value of [0, 25, 90]) {
      const r = solveAB([mate("angle", ["A", BOX.zp], ["B", lineB], { value })]);
      expectSolved(r);
      const toNormal = deg(angle([0, 0, 1], world(r, "B", lineB).d));
      expect(90 - Math.min(toNormal, 180 - toNormal)).toBeCloseTo(value, 5);
    }
  });

  describe("7. each supported combination ends up satisfied", () => {
    const cornerA = point([10, 10, 10]);
    const cornerB = point([0, 0, 0]);
    const edgeA = axis([10, 0, 10], [0, 1, 0]);
    const edgeB = axis([0, 0, 0], [1, 0, 0]);

    it("point–point coincident", () => {
      const r = solveAB([mate("coincident", ["A", cornerA], ["B", point([10, 0, 10])])]);
      expectSolved(r);
      expect(len(sub(world(r, "B", point([10, 0, 10])).o, [10, 10, 10]))).toBeLessThan(1e-6);
      expect(r.dof).toBe(3);
    });

    it("point–plane coincident, either order", () => {
      for (const m of [mate("coincident", ["A", BOX.xp], ["B", cornerB]), mate("coincident", ["B", cornerB], ["A", BOX.xp])]) {
        const r = solveAB([m]);
        expectSolved(r);
        expect(world(r, "B", cornerB).o[0]).toBeCloseTo(10, 6);
        expect(r.dof).toBe(5);
      }
      // The plane may be on the moving part instead.
      const r = solveAB([mate("coincident", ["A", cornerA], ["B", BOX.zn])]);
      expectSolved(r);
      const w = world(r, "B", BOX.zn);
      expect(dot(sub([10, 10, 10], w.o), w.d)).toBeCloseTo(0, 6);
    });

    it("point–axis coincident, either order, and concentric point–axis", () => {
      const mates = [
        mate("coincident", ["A", edgeA], ["B", cornerB]),
        mate("coincident", ["B", cornerB], ["A", edgeA]),
        mate("concentric", ["A", edgeA], ["B", cornerB]),
      ];
      for (const m of mates) {
        const r = solveAB([m]);
        expectSolved(r);
        expect(distToLine(world(r, "B", cornerB).o, { o: edgeA.origin, d: edgeA.dir })).toBeLessThan(1e-6);
        expect(r.dof).toBe(4);
      }
    });

    it("axis–axis coincident", () => {
      const r = solveAB([mate("coincident", ["A", edgeA], ["B", edgeB])]);
      expectSolved(r);
      const w = world(r, "B", edgeB);
      expect(Math.abs(dot(w.d, edgeA.dir))).toBeCloseTo(1, 9);
      expect(distToLine(w.o, { o: edgeA.origin, d: edgeA.dir })).toBeLessThan(1e-6);
      expect(r.dof).toBe(2);
    });

    it("axis–plane coincident, either order", () => {
      for (const m of [mate("coincident", ["A", BOX.zp], ["B", edgeB]), mate("coincident", ["B", edgeB], ["A", BOX.zp])]) {
        const r = solveAB([m]);
        expectSolved(r);
        const w = world(r, "B", edgeB);
        expect(w.d[2]).toBeCloseTo(0, 6);
        expect(w.o[2]).toBeCloseTo(10, 6);
        expect(r.dof).toBe(4);
      }
    });

    it("point–plane distance keeps the side the point started on", () => {
      const above = solveAB([mate("distance", ["A", BOX.zp], ["B", cornerB], { value: 4 })], pose([1, 2, 50]));
      expectSolved(above);
      expect(world(above, "B", cornerB).o[2]).toBeCloseTo(14, 6);
      const below = solveAB([mate("distance", ["B", cornerB], ["A", BOX.zp], { value: 4 })], pose([1, 2, -50]));
      expectSolved(below);
      expect(world(below, "B", cornerB).o[2]).toBeCloseTo(6, 6);
      const onIt = solveAB([mate("distance", ["A", BOX.zp], ["B", cornerB], { value: 4 })], pose([1, 2, 10]));
      expectSolved(onIt);
      expect(world(onIt, "B", cornerB).o[2]).toBeCloseTo(14, 6);
    });

    it("point–point distance, including from a coincident start", () => {
      for (const start of [START_B, pose([10, 10, 10])]) {
        const r = solveAB([mate("distance", ["A", cornerA], ["B", cornerB], { value: 7 })], start);
        expectSolved(r);
        expect(len(sub(world(r, "B", cornerB).o, [10, 10, 10]))).toBeCloseTo(7, 6);
        expect(r.dof).toBe(5);
      }
    });

    it("point–axis distance, including from a start on the axis", () => {
      for (const start of [START_B, pose([10, 3, 10])]) {
        const r = solveAB([mate("distance", ["A", edgeA], ["B", cornerB], { value: 3 })], start);
        expectSolved(r);
        expect(distToLine(world(r, "B", cornerB).o, { o: edgeA.origin, d: edgeA.dir })).toBeCloseTo(3, 6);
      }
    });

    it("axis–axis distance", () => {
      const r = solveAB([mate("distance", ["A", edgeA], ["B", edgeB], { value: 6 })]);
      expectSolved(r);
      const w = world(r, "B", edgeB);
      expect(Math.abs(dot(w.d, edgeA.dir))).toBeCloseTo(1, 9);
      expect(distToLine(w.o, { o: edgeA.origin, d: edgeA.dir })).toBeCloseTo(6, 6);
      expect(r.dof).toBe(3);
    });

    it("parallel: faces (either sense, or forced by flip), edges, edge to face", () => {
      const free = solveAB([mate("parallel", ["A", BOX.zp], ["B", BOX.zp])], pose([1, 2, 3], [1, 0, 0], 150));
      expectSolved(free);
      expect(world(free, "B", BOX.zp).d[2]).toBeCloseTo(-1, 9); // 150° is nearer to opposed than to aligned
      expect(free.dof).toBe(4);
      const same = solveAB([mate("parallel", ["A", BOX.zp], ["B", BOX.zp], { flip: true })], pose([1, 2, 3], [1, 0, 0], 150));
      expectSolved(same);
      expect(world(same, "B", BOX.zp).d[2]).toBeCloseTo(1, 9);
      const opposite = solveAB([mate("parallel", ["A", BOX.zp], ["B", BOX.zp], { flip: false })], pose([1, 2, 3], [1, 0, 0], 20));
      expectSolved(opposite);
      expect(world(opposite, "B", BOX.zp).d[2]).toBeCloseTo(-1, 9);

      const edges = solveAB([mate("parallel", ["A", edgeA], ["B", edgeB])]);
      expectSolved(edges);
      expect(Math.abs(dot(world(edges, "B", edgeB).d, edgeA.dir))).toBeCloseTo(1, 9);

      // Exactly perpendicular to start with: no sense is nearer, and the gradient vanishes.
      const fromSquare = solveAB([mate("parallel", ["A", edgeA], ["B", edgeB])], pose([4, 4, 4]));
      expectSolved(fromSquare);
      expect(Math.abs(dot(world(fromSquare, "B", edgeB).d, edgeA.dir))).toBeCloseTo(1, 9);

      const edgeToFace = solveAB([mate("parallel", ["B", edgeB], ["A", BOX.zp])]);
      expectSolved(edgeToFace);
      expect(world(edgeToFace, "B", edgeB).d[2]).toBeCloseTo(0, 6);
      expect(edgeToFace.dof).toBe(5);
    });

    it("perpendicular: faces, edges, edge to face", () => {
      for (const start of [START_B, pose([0, 0, 40])]) {
        const faces = solveAB([mate("perpendicular", ["A", BOX.zp], ["B", BOX.zp])], start);
        expectSolved(faces);
        expect(world(faces, "B", BOX.zp).d[2]).toBeCloseTo(0, 6);
        expect(faces.dof).toBe(5);
      }
      const edges = solveAB([mate("perpendicular", ["A", edgeA], ["B", edgeB])]);
      expectSolved(edges);
      expect(dot(world(edges, "B", edgeB).d, edgeA.dir)).toBeCloseTo(0, 6);

      const edgeToFace = solveAB([mate("perpendicular", ["A", BOX.zp], ["B", edgeB])]);
      expectSolved(edgeToFace);
      expect(Math.abs(world(edgeToFace, "B", edgeB).d[2])).toBeCloseTo(1, 9);
      expect(edgeToFace.dof).toBe(4);
    });
  });

  it("8. lock carries a part along with the one it is locked to", () => {
    const startC = pose([-20, 15, 40], [3, -1, 2], 200);
    const before = composePose(invertPose(START_B), startC);
    const r = solveMates(
      [fixedA, freeB(), { id: "C", pose: startC }],
      [
        mate("coincident", ["A", BOX.xp], ["B", BOX.xn]),
        mate("coincident", ["A", BOX.yp], ["B", BOX.yp], { flip: true }),
        mate("coincident", ["A", BOX.zn], ["B", BOX.zn], { flip: true }),
        mate("lock", ["B", point([0, 0, 0])], ["C", point([0, 0, 0])]),
      ],
    );
    expectSolved(r);
    expect(r.dof).toBe(0);
    expectPoseClose(r.poses.B, pose([10, 0, 0]));
    expectPoseClose(composePose(invertPose(r.poses.B), r.poses.C), before);
    expect(len(sub(r.poses.C.p, startC.p))).toBeGreaterThan(1);
  });

  it("9. conflicting mates are reported, not hidden", () => {
    const r = solveAB([
      mate("distance", ["A", BOX.zp], ["B", BOX.zn], { value: 5, id: "five" }),
      mate("distance", ["A", BOX.zp], ["B", BOX.zn], { value: 9, id: "nine" }),
      mate("parallel", ["A", BOX.xp], ["B", BOX.xp], { id: "fine" }),
    ]);
    expectFinite(r);
    expect(r.converged).toBe(false);
    expect(r.mates.five).toMatchObject({ ok: false, error: "Conflicts with other mates" });
    expect(r.mates.nine).toMatchObject({ ok: false, error: "Conflicts with other mates" });
    expect(r.mates.fine.ok).toBe(true);
    // Best compromise: the gap settles halfway, each mate 2 mm out.
    expect(r.mates.five.residual).toBeCloseTo(2, 4);
    expect(r.mates.nine.residual).toBeCloseTo(2, 4);
    expect(world(r, "B", BOX.zn).o[2]).toBeCloseTo(17, 4);
    expect(r.dof).toBeGreaterThanOrEqual(0);
  });

  it("10. unsupported combinations and bad references are errors that do not stop the rest", () => {
    const good = mate("coincident", ["A", BOX.zp], ["B", BOX.zn], { id: "good" });
    const r = solveAB([
      good,
      mate("concentric", ["A", BOX.xp], ["B", BOX.xn], { id: "concentric-faces" }),
      mate("parallel", ["A", point([0, 0, 0])], ["B", BOX.xn], { id: "parallel-point" }),
      mate("perpendicular", ["A", point([0, 0, 0])], ["B", point([1, 1, 1])], { id: "perpendicular-points" }),
      mate("angle", ["A", BOX.xp], ["B", point([1, 1, 1])], { id: "angle-point", value: 10 }),
      mate("distance", ["A", BOX.xp], ["B", axis([0, 0, 0], [0, 1, 0])], { id: "distance-face-edge", value: 10 }),
      mate("coincident", ["A", BOX.xp], ["Z", BOX.xn], { id: "unknown" }),
      mate("coincident", ["B", BOX.xp], ["B", BOX.xn], { id: "self" }),
      mate("coincident", ["A", BOX.xp], ["B", plane([0, 0, 0], [0, 0, 0])], { id: "no-normal" }),
      mate("distance", ["A", BOX.xp], ["B", BOX.xn], { id: "nan", value: Number.NaN }),
    ]);
    expectFinite(r);
    expect(r.mates.good.ok).toBe(true);
    expect(r.mates["concentric-faces"]).toEqual({ ok: false, residual: 0, error: "Concentric needs two round faces or straight edges" });
    const rejected = ["parallel-point", "perpendicular-points", "angle-point", "distance-face-edge", "unknown", "self", "no-normal", "nan"];
    for (const id of rejected) {
      expect(r.mates[id].ok, id).toBe(false);
      expect(r.mates[id].residual, id).toBe(0);
      expect(r.mates[id].error, id).toBeTruthy();
    }
    expect(r.mates.unknown.error).toBe("Component not found");
    // Errors are ignored: the result is the same as solving the good mate alone.
    expect(r.converged).toBe(true);
    expect(r.dof).toBe(3);
    expectPoseClose(r.poses.B, solveAB([good]).poses.B, 1e-9);
  });

  it("10b. mates between two fixed components are checked but move nothing", () => {
    const r = solveMates(
      [fixedA, { id: "B", pose: pose([10, 0, 0]), fixed: true }, { id: "C", pose: START_B, fixed: true }],
      [
        mate("coincident", ["A", BOX.xp], ["B", BOX.xn], { id: "holds" }),
        mate("coincident", ["A", BOX.xp], ["C", BOX.xn], { id: "broken" }),
      ],
    );
    expect(r.mates.holds).toMatchObject({ ok: true });
    expect(r.mates.broken.ok).toBe(false);
    expect(r.mates.broken.residual).toBeGreaterThan(1);
    expect(r.converged).toBe(false);
    expect(r.dof).toBe(0);
    expect(r.poses.C).toEqual(START_B);
  });

  it("11. a chain of three is fully constrained through the middle part", () => {
    const three = (a: string, b: string): MateInput[] => [
      mate("coincident", [a, BOX.xp], [b, BOX.xn]),
      mate("coincident", [a, BOX.yp], [b, BOX.yp], { flip: true }),
      mate("coincident", [a, BOX.zn], [b, BOX.zn], { flip: true }),
    ];
    const startC = pose([-30, 44, 5], [2, -1, 1], 131);
    const r = solveMates([fixedA, freeB(), { id: "C", pose: startC }], [...three("A", "B"), ...three("B", "C")]);
    expectSolved(r);
    expect(r.dof).toBe(0);
    expectPoseClose(r.poses.B, pose([10, 0, 0]));
    expectPoseClose(r.poses.C, pose([20, 0, 0]));
  });

  it("12. redundant mates do not change the degrees of freedom", () => {
    const one = mate("coincident", ["A", BOX.zp], ["B", BOX.zn]);
    const single = solveAB([one]);
    const doubled = solveAB([
      one,
      { ...one, id: "again" },
      mate("parallel", ["A", BOX.zp], ["B", BOX.zn]),
      mate("distance", ["A", BOX.zp], ["B", BOX.zn], { value: 0 }),
    ]);
    expectSolved(doubled);
    expect(single.dof).toBe(3);
    expect(doubled.dof).toBe(3);
    expectPoseClose(doubled.poses.B, single.poses.B, 1e-5);

    // Over-determined but consistent: all six face pairs of a box sitting next to A.
    const all = solveAB([
      mate("coincident", ["A", BOX.xp], ["B", BOX.xn]),
      mate("distance", ["A", BOX.xn], ["B", BOX.xp], { value: -20 }),
      mate("coincident", ["A", BOX.yp], ["B", BOX.yp], { flip: true }),
      mate("coincident", ["A", BOX.yn], ["B", BOX.yn], { flip: true }),
      mate("coincident", ["A", BOX.zn], ["B", BOX.zn], { flip: true }),
      mate("coincident", ["A", BOX.zp], ["B", BOX.zp], { flip: true }),
    ]);
    expectSolved(all);
    expect(all.dof).toBe(0);
    expectPoseClose(all.poses.B, pose([10, 0, 0]));
  });

  it("counts six degrees of freedom per unconstrained free part", () => {
    const r = solveMates([fixedA, freeB(), { id: "C", pose: START_B }], []);
    expect(r).toEqual({ poses: { A: IDENTITY_POSE, B: START_B, C: START_B }, mates: {}, dof: 12, converged: true });
    const partly = solveMates([fixedA, freeB(), { id: "C", pose: START_B }], [mate("coincident", ["A", BOX.zp], ["B", BOX.zn])]);
    expect(partly.dof).toBe(9);
    expect(partly.poses.C).toEqual(START_B);
  });

  it("moves both parts when neither is fixed", () => {
    const r = solveMates([{ id: "A", pose: IDENTITY_POSE }, freeB()], [
      mate("coincident", ["A", BOX.xp], ["B", BOX.xn]),
      mate("coincident", ["A", BOX.yp], ["B", BOX.yp], { flip: true }),
      mate("coincident", ["A", BOX.zn], ["B", BOX.zn], { flip: true }),
    ]);
    expectSolved(r);
    expect(r.dof).toBe(6);
    expectPoseClose(composePose(invertPose(r.poses.A), r.poses.B), pose([10, 0, 0]));
    expect(rotationBetween(IDENTITY_POSE, r.poses.A)).toBeGreaterThan(0.01);
  });

  it("never throws or returns NaN on garbage", () => {
    const nan = Number.NaN;
    const r = solveMates(
      [
        fixedA,
        { id: "B", pose: { p: [nan, 0, 0], q: [0, 0, 0, 1] } },
        { id: "C", pose: { p: [1, 2, 3], q: [0, 0, 0, 0] } },
        { id: "D", pose: { p: [1, 2, 3], q: [0, 0, 0, 5] } },
      ],
      [
        mate("coincident", ["A", BOX.zp], ["B", BOX.zn], { id: "nan-pose" }),
        mate("coincident", ["A", BOX.zp], ["C", BOX.zn], { id: "zero-quat" }),
        mate("coincident", ["A", BOX.zp], ["D", BOX.zn], { id: "long-quat" }),
        mate("coincident", ["A", plane([nan, 0, 0], [0, 0, 1])], ["D", BOX.zn], { id: "nan-ref" }),
        { ...mate("coincident", ["A", BOX.zp], ["D", BOX.zn], { id: "bad-type" }), type: "weld" as MateType },
      ],
    );
    expectFinite(r);
    expect(r.mates["nan-pose"].ok).toBe(false);
    expect(r.mates["zero-quat"].ok).toBe(false);
    expect(r.mates["nan-ref"].ok).toBe(false);
    expect(r.mates["bad-type"].ok).toBe(false);
    expect(r.mates["long-quat"].ok).toBe(true);
  });

  it("copes with large parts far from the origin", () => {
    const s = 400;
    const g = {
      xp: plane([s, 0, 0], [1, 0, 0]),
      yp: plane([0, s, 0], [0, 1, 0]),
      zp: plane([0, 0, s], [0, 0, 1]),
      origin: point([0, 0, 0]),
    };
    const r = solveMates(
      [{ id: "A", pose: pose([5000, -3000, 1200], [1, 1, 1], 50), fixed: true }, freeB(pose([-800, 2500, 90], [0, 1, 3], 260))],
      [
        mate("coincident", ["A", g.xp], ["B", g.xp]),
        mate("coincident", ["A", g.yp], ["B", g.yp], { flip: true }),
        mate("distance", ["A", g.zp], ["B", g.origin], { value: 0 }),
      ],
    );
    expectSolved(r);
    expect(r.dof).toBe(0);
  });

  it("14. a chain of twelve parts converges quickly", () => {
    // Deterministic pseudo-random start poses.
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const comps: ComponentInput[] = [{ id: "c0", pose: IDENTITY_POSE, fixed: true }];
    const mates: MateInput[] = [];
    for (let i = 1; i < 12; i++) {
      comps.push({ id: `c${i}`, pose: pose([rnd() * 200, rnd() * 200, rnd() * 200], [rnd(), rnd(), rnd() + 0.01], rnd() * 360) });
      mates.push(
        mate("coincident", [`c${i - 1}`, BOX.xp], [`c${i}`, BOX.xn]),
        mate("coincident", [`c${i - 1}`, BOX.yp], [`c${i}`, BOX.yp], { flip: true }),
        mate("distance", [`c${i - 1}`, BOX.zn], [`c${i}`, BOX.zn], { flip: true, value: 0 }),
      );
    }
    const t0 = performance.now();
    const r = solveMates(comps, mates);
    const elapsed = performance.now() - t0;
    expectSolved(r);
    expect(r.dof).toBe(0);
    for (let i = 1; i < 12; i++) expectPoseClose(r.poses[`c${i}`], pose([10 * i, 0, 0]), 1e-5);
    expect(elapsed).toBeLessThan(2000);
  });

  /** A 6×5 grid of boxes: each is mated to the box before it in its row (or the row below) and starts near, but not at, its slot. */
  function grid(): { comps: ComponentInput[]; mates: MateInput[] } {
    const comps: ComponentInput[] = [{ id: "c0", pose: IDENTITY_POSE, fixed: true }];
    const mates: MateInput[] = [];
    for (let i = 1; i < 30; i++) {
      const col = i % 6;
      const prev = `c${col === 0 ? i - 6 : i - 1}`;
      const me = `c${i}`;
      comps.push({ id: me, pose: pose([col * 13 + 4, Math.floor(i / 6) * 9 - 3, (i % 5) * 4], [1, i, 2], 25 + 7 * i) });
      if (col === 0) {
        mates.push(mate("coincident", [prev, BOX.yp], [me, BOX.yn]), mate("coincident", [prev, BOX.xp], [me, BOX.xp], { flip: true }));
      } else {
        mates.push(mate("coincident", [prev, BOX.xp], [me, BOX.xn]), mate("coincident", [prev, BOX.yp], [me, BOX.yp], { flip: true }));
      }
      mates.push(mate("coincident", [prev, BOX.zn], [me, BOX.zn], { flip: true }));
      if (i % 3 === 0) mates.push(mate("parallel", ["c0", BOX.zp], [me, BOX.zp])); // redundant
    }
    return { comps, mates };
  }

  it("15. thirty parts and a hundred-odd mates stay well inside the time budget", () => {
    const { comps, mates } = grid();
    expect(mates.length).toBeGreaterThanOrEqual(96);
    const t0 = performance.now();
    const r = solveMates(comps, mates);
    const elapsed = performance.now() - t0;
    expectSolved(r);
    expect(r.dof).toBe(0);
    for (let i = 1; i < 30; i++) expectPoseClose(r.poses[`c${i}`], pose([(i % 6) * 10, Math.floor(i / 6) * 10, 0]), 1e-5);
    expect(elapsed).toBeLessThan(2000);

    // Solving again from the answer is immediate and changes nothing.
    const solved = comps.map((c) => ({ ...c, pose: r.poses[c.id] }));
    const again = solveMates(solved, mates);
    expectSolved(again);
    expect(again.poses).toEqual(r.poses);
  });

  it("16. a conflict in a large assembly is reported promptly", () => {
    const { comps, mates } = grid();
    mates.push(mate("distance", ["c0", BOX.xp], ["c29", BOX.xn], { value: 3, id: "impossible" }));
    const t0 = performance.now();
    const r = solveMates(comps, mates);
    const elapsed = performance.now() - t0;
    expectFinite(r);
    expect(r.converged).toBe(false);
    expect(r.mates.impossible).toMatchObject({ ok: false, error: "Conflicts with other mates" });
    expect(r.dof).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(2000);
  });
});

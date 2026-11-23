import { describe, expect, it } from "vitest";
import { frameForFace, planeFeatureFrame, planeFrame, polygonArea } from "../src/model/geom2d";
import { FeatureSchema, type Constraint, type Entity, type PlaneFeature, type Profile, type SketchFeature } from "../src/model/schema";
import {
  addModelRef,
  addProfile,
  byId,
  loopPolygon,
  makeDimension,
  makeRelation,
  normalizeSketch,
  pointXY,
  relationsFor,
  removeEntities,
  sketchLoops,
  type SketchData,
} from "../src/sketch/build";
import { solveSketch } from "../src/sketch/solver";

const pt = (id: string, x: number, y: number, extra = {}): Entity => ({ id, type: "point", x, y, ...extra });
const ln = (id: string, p1: string, p2: string): Entity => ({ id, type: "line", p1, p2 });

/** A slightly crooked quadrilateral with corners p1..p4 and sides l1..l4. */
function quad(): Entity[] {
  return [pt("p1", 0.3, -0.2), pt("p2", 39, 1.1), pt("p3", 41, 20.5), pt("p4", -0.8, 19), ln("l1", "p1", "p2"), ln("l2", "p2", "p3"), ln("l3", "p3", "p4"), ln("l4", "p4", "p1")];
}
const rectRelations: Constraint[] = [
  { id: "k1", type: "horizontal", a: "l1" },
  { id: "k2", type: "vertical", a: "l2" },
  { id: "k3", type: "horizontal", a: "l3" },
  { id: "k4", type: "vertical", a: "l4" },
];
const xy = (ents: Entity[], id: string) => pointXY(byId(ents), id);

describe("sketch solver", () => {
  it("counts degrees of freedom as relations and dimensions are added", () => {
    expect(solveSketch(quad(), []).dof).toBe(8);
    const squared = solveSketch(quad(), rectRelations);
    expect(squared.ok).toBe(true);
    expect(squared.dof).toBe(4); // position (2) + width + height
    expect(xy(squared.entities, "p1")[1]).toBeCloseTo(xy(squared.entities, "p2")[1], 8);
    expect(xy(squared.entities, "p2")[0]).toBeCloseTo(xy(squared.entities, "p3")[0], 8);

    const sized = solveSketch(quad(), [...rectRelations, { id: "d1", type: "distance", a: "l1", value: 40 }, { id: "d2", type: "distance", a: "l2", value: 20 }]);
    expect(sized.ok).toBe(true);
    expect(sized.dof).toBe(2);
    expect(sized.free.has("l1")).toBe(true);

    const pinned = solveSketch(quad(), [...rectRelations, { id: "d1", type: "distance", a: "l1", value: 40 }, { id: "d2", type: "distance", a: "l2", value: 20 }, { id: "f", type: "fix", a: "p1" }]);
    expect(pinned.dof).toBe(0);
    expect(pinned.free.size).toBe(0);
    expect(xy(pinned.entities, "p3")).toEqual([expect.closeTo(40.3, 6), expect.closeTo(19.8, 6)]);
  });

  it("moves geometry as little as needed", () => {
    const r = solveSketch(quad(), rectRelations);
    for (const id of ["p1", "p2", "p3", "p4"]) {
      const before = xy(quad(), id);
      const after = xy(r.entities, id);
      expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(1.5);
    }
  });

  it("horizontal and vertical dimensions leave the other axis free", () => {
    const ents = [pt("a", 0, 0, { fixed: true }), pt("b", 7, 4)];
    const h = solveSketch(ents, [{ id: "d", type: "distance", a: "a", b: "b", value: 10, mode: "horizontal" }]);
    expect(h.ok).toBe(true);
    expect(xy(h.entities, "b")).toEqual([expect.closeTo(10, 8), expect.closeTo(4, 8)]);
    expect(h.dof).toBe(1);
    expect(h.free.has("b")).toBe(true);

    const v = solveSketch(ents, [{ id: "d", type: "distance", a: "a", b: "b", value: 10, mode: "vertical" }]);
    expect(xy(v.entities, "b")).toEqual([expect.closeTo(7, 8), expect.closeTo(10, 8)]);

    const both = solveSketch(ents, [
      { id: "d", type: "distance", a: "a", b: "b", value: 10, mode: "horizontal" },
      { id: "e", type: "distance", a: "a", b: "b", value: 3, mode: "vertical" },
    ]);
    expect(both.dof).toBe(0);
    expect(xy(both.entities, "b")).toEqual([expect.closeTo(10, 8), expect.closeTo(3, 8)]);

    // The side is kept: a point to the left stays to the left.
    const left = solveSketch([pt("a", 0, 0, { fixed: true }), pt("b", -2, 1)], [{ id: "d", type: "distance", a: "a", b: "b", value: 10, mode: "horizontal" }]);
    expect(xy(left.entities, "b")[0]).toBeCloseTo(-10, 8);

    const aligned = solveSketch(ents, [{ id: "d", type: "distance", a: "a", b: "b", value: 10 }]);
    const p = xy(aligned.entities, "b");
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 8);
  });

  it("handles the other relations", () => {
    const base = [pt("a", 0, 0, { fixed: true }), pt("b", 10, 0, { fixed: true }), ln("l", "a", "b"), pt("c", 2, 5), pt("d", 9, 8), ln("m", "c", "d")];
    const par = solveSketch(base, [{ id: "k", type: "parallel", a: "m", b: "l" }]);
    expect(xy(par.entities, "c")[1]).toBeCloseTo(xy(par.entities, "d")[1], 7);
    const perp = solveSketch(base, [{ id: "k", type: "perpendicular", a: "m", b: "l" }]);
    expect(xy(perp.entities, "c")[0]).toBeCloseTo(xy(perp.entities, "d")[0], 7);
    const eq = solveSketch(base, [{ id: "k", type: "equal", a: "m", b: "l" }]);
    const [c, d] = [xy(eq.entities, "c"), xy(eq.entities, "d")];
    expect(Math.hypot(d[0] - c[0], d[1] - c[1])).toBeCloseTo(10, 7);
    const on = solveSketch(base, [{ id: "k", type: "coincident", a: "c", b: "l" }]);
    expect(xy(on.entities, "c")[1]).toBeCloseTo(0, 8);
    const col = solveSketch(base, [{ id: "k", type: "coincident", a: "m", b: "l" }]);
    expect(xy(col.entities, "c")[1]).toBeCloseTo(0, 7);
    expect(xy(col.entities, "d")[1]).toBeCloseTo(0, 7);
    const mid = solveSketch(base, [{ id: "k", type: "midpoint", a: "c", b: "l" }]);
    expect(xy(mid.entities, "c")).toEqual([expect.closeTo(5, 8), expect.closeTo(0, 8)]);
    const ang = solveSketch(base, [{ id: "k", type: "angle", a: "m", b: "l", value: 30 }]);
    const [c2, d2] = [xy(ang.entities, "c"), xy(ang.entities, "d")];
    expect((Math.atan2(d2[1] - c2[1], d2[0] - c2[0]) * 180) / Math.PI).toBeCloseTo(30, 6);
    const off = solveSketch(base, [{ id: "k", type: "distance", a: "c", b: "l", value: 12 }]);
    expect(xy(off.entities, "c")[1]).toBeCloseTo(12, 7);
    const gap = solveSketch(base, [{ id: "k", type: "distance", a: "m", b: "l", value: 6 }]);
    expect(xy(gap.entities, "c")[1]).toBeCloseTo(6, 7);
    expect(xy(gap.entities, "d")[1]).toBeCloseTo(6, 7);

    const circ: Entity[] = [...base, pt("o", 5, 9), { id: "ci", type: "circle", c: "o", r: 3 }, pt("q", 20, 20), { id: "cj", type: "circle", c: "q", r: 4 }];
    const tan = solveSketch(circ, [{ id: "k", type: "tangent", a: "l", b: "ci" }]);
    const ci = tan.entities.find((e) => e.id === "ci") as { r: number };
    expect(xy(tan.entities, "o")[1]).toBeCloseTo(ci.r, 7);
    const dia = solveSketch(circ, [{ id: "k", type: "diameter", a: "ci", value: 11 }]);
    expect((dia.entities.find((e) => e.id === "ci") as { r: number }).r).toBeCloseTo(5.5, 8);
    const con = solveSketch(circ, [{ id: "k", type: "concentric", a: "ci", b: "cj" }]);
    expect(xy(con.entities, "o")).toEqual(xy(con.entities, "q").map((v) => expect.closeTo(v, 7)));
    const kiss = solveSketch(circ, [{ id: "k", type: "tangent", a: "ci", b: "cj" }]);
    const [o, q] = [xy(kiss.entities, "o"), xy(kiss.entities, "q")];
    const rs = kiss.entities.filter((e) => e.type === "circle").map((e) => (e as { r: number }).r);
    expect(Math.hypot(q[0] - o[0], q[1] - o[1])).toBeCloseTo(rs[0] + rs[1], 7);
  });

  it("reports contradictions instead of inventing a solution", () => {
    const r = solveSketch(quad(), [...rectRelations, { id: "d1", type: "distance", a: "l1", value: 40 }, { id: "d3", type: "distance", a: "l3", value: 30 }]);
    expect(r.ok).toBe(false);
    expect(r.failed.length).toBeGreaterThan(0);
    for (const e of r.entities) if (e.type === "point") expect(Number.isFinite(e.x) && Number.isFinite(e.y)).toBe(true);
    const missing = solveSketch(quad(), [{ id: "k", type: "parallel", a: "l1", b: "nope" }]);
    expect(missing.ok).toBe(false);
    expect(missing.failed).toEqual(["k"]);
    // Redundant but consistent relations are fine and do not distort the count.
    const twice = solveSketch(quad(), [...rectRelations, { id: "k9", type: "horizontal", a: "l1" }, { id: "k10", type: "parallel", a: "l1", b: "l3" }]);
    expect(twice.ok).toBe(true);
    expect(twice.dof).toBe(4);
  });

  it("drags a point while the relations hold", () => {
    const cons: Constraint[] = [...rectRelations, { id: "d1", type: "distance", a: "l1", value: 40 }, { id: "d2", type: "distance", a: "l2", value: 20 }];
    const start = solveSketch(quad(), cons).entities;
    const dragged = solveSketch(start, cons, { drag: [{ point: "p3", to: [70, 50] }], fast: true });
    expect(dragged.ok).toBe(true);
    expect(xy(dragged.entities, "p3")).toEqual([expect.closeTo(70, 3), expect.closeTo(50, 3)]);
    const [p1, p3] = [xy(dragged.entities, "p1"), xy(dragged.entities, "p3")];
    expect(p3[0] - p1[0]).toBeCloseTo(40, 6);
    expect(p3[1] - p1[1]).toBeCloseTo(20, 6);
    // A fully pinned sketch does not follow the finger.
    const pinned = [...cons, { id: "f", type: "fix", a: "p1" } as Constraint];
    const still = solveSketch(start, pinned, { drag: [{ point: "p3", to: [70, 50] }], fast: true });
    expect(xy(still.entities, "p3")).toEqual(xy(start, "p3").map((v) => expect.closeTo(v, 5)));
  });
});

describe("sketch building", () => {
  const blank = (): SketchData => ({ entities: [], constraints: [] });

  it("expands whole shapes into fully defined geometry", () => {
    const shapes: Profile[] = [
      { type: "rect", cx: 5, cy: -3, w: 40, h: 20 },
      { type: "rect", cx: 0, cy: 0, w: 40, h: 20, r: 4 },
      { type: "rect", cx: 0, cy: 0, w: 30, h: 10, angle: 25 },
      { type: "rect", cx: 0, cy: 0, w: 30, h: 12, r: 3, angle: -40 },
      { type: "circle", cx: 3, cy: 4, d: 12 },
      { type: "slot", x1: 0, y1: 0, x2: 20, y2: 5, w: 6 },
      { type: "polygon", points: [[0, 0], [20, 0], [10, 15]] },
    ];
    for (const profile of shapes) {
      const data = blank();
      addProfile(data, profile, true);
      const r = solveSketch(data.entities, data.constraints);
      expect(r.ok, JSON.stringify(profile)).toBe(true);
      expect(r.dof, JSON.stringify(profile)).toBe(0);
      const { loops, open } = sketchLoops(r.entities);
      expect(open).toBe(0);
      expect(loops).toHaveLength(1);
    }
  });

  it("produces the right outline for a rounded rectangle and a slot", () => {
    const a = blank();
    addProfile(a, { type: "rect", cx: 0, cy: 0, w: 40, h: 20, r: 4 }, true);
    const loop = sketchLoops(a.entities).loops[0];
    expect(loop.kind === "path" && loop.segs.length).toBe(8);
    expect(Math.abs(polygonArea(loopPolygon(loop, 720)))).toBeCloseTo(40 * 20 - (4 - Math.PI) * 16, 1);
    const b = blank();
    addProfile(b, { type: "slot", x1: 0, y1: 0, x2: 20, y2: 0, w: 6 }, true);
    expect(Math.abs(polygonArea(loopPolygon(sketchLoops(b.entities).loops[0], 720)))).toBeCloseTo(20 * 6 + Math.PI * 9, 1);
  });

  it("re-solves when a dimension changes", () => {
    const data = blank();
    addProfile(data, { type: "rect", cx: 0, cy: 0, w: 40, h: 20 }, true);
    const width = data.constraints.find((c) => c.type === "distance" && c.value === 40)!;
    const changed = data.constraints.map((c) => (c.id === width.id ? { ...c, value: 64 } : c)) as Constraint[];
    const r = solveSketch(data.entities, changed);
    expect(r.ok).toBe(true);
    const xs = r.entities.filter((e) => e.type === "point").map((e) => (e as { x: number }).x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(64, 6);
    expect(Math.min(...xs)).toBeCloseTo(-20, 6); // the pinned corner stays put
  });

  it("free-drawn shapes get relations but no dimensions", () => {
    const data = blank();
    addProfile(data, { type: "rect", cx: 0, cy: 0, w: 40, h: 20 }, false);
    expect(data.constraints.map((c) => c.type)).toEqual(["horizontal", "vertical", "horizontal", "vertical"]);
    expect(solveSketch(data.entities, data.constraints).dof).toBe(4);
  });

  it("folds the profiles shorthand into a stored sketch", () => {
    const f = FeatureSchema.parse({ id: "sk1", type: "sketch", plane: { base: "XY" }, profiles: [{ type: "circle", cx: 0, cy: 0, d: 10 }] }) as SketchFeature;
    const n = normalizeSketch(f);
    expect(n.profiles).toBeUndefined();
    expect(n.entities.map((e) => e.type)).toEqual(["point", "circle"]);
    expect(FeatureSchema.safeParse(n).success).toBe(true);
  });

  it("reports open profiles and removes dependents", () => {
    const data = blank();
    addProfile(data, { type: "rect", cx: 0, cy: 0, w: 40, h: 20 }, false);
    const line = data.entities.find((e) => e.type === "line")!;
    const cut = removeEntities(data, [line.id]);
    expect(cut.entities.filter((e) => e.type === "line")).toHaveLength(3);
    expect(cut.entities.filter((e) => e.type === "point")).toHaveLength(4);
    expect(cut.constraints).toHaveLength(3);
    expect(sketchLoops(cut.entities)).toEqual({ loops: [], open: 3 });
    const pointGone = removeEntities(data, [data.entities[0].id]);
    expect(pointGone.entities.filter((e) => e.type === "line")).toHaveLength(2);
    expect(pointGone.entities.filter((e) => e.type === "point")).toHaveLength(3);
  });

  it("offers sensible relations and smart dimensions for a selection", () => {
    const ents: Entity[] = [...quad(), pt("o", 10, 10), { id: "c", type: "circle", c: "o", r: 4 }, pt("s", 30, 30), pt("e", 26, 34), pt("ac", 26, 30), { id: "arc", type: "arc", c: "ac", p1: "s", p2: "e" }];
    expect(relationsFor(ents, ["p1", "p2"])).toContain("coincident");
    expect(relationsFor(ents, ["l1", "l3"])).toEqual(["parallel", "perpendicular", "equal", "coincident"]);
    expect(relationsFor(ents, ["l1", "c"])).toEqual(["tangent"]);
    expect(relationsFor(ents, ["p1", "l2"])).toEqual(["coincident", "midpoint"]);
    expect(makeRelation(ents, ["l2", "p1"], "midpoint", "k")).toEqual({ id: "k", type: "midpoint", a: "p1", b: "l2" });

    expect(makeDimension(ents, ["l1"], "smart", "d")).toMatchObject({ type: "distance", a: "l1" });
    expect(makeDimension(ents, ["c"], "smart", "d")).toMatchObject({ type: "diameter", value: 8 });
    expect(makeDimension(ents, ["arc"], "smart", "d")).toMatchObject({ type: "radius", value: 4 });
    expect(makeDimension(ents, ["p1", "p3"], "smart", "d")).toMatchObject({ type: "distance", a: "p1", b: "p3" });
    expect(makeDimension(ents, ["p1", "p3"], "smart", "d")!.type === "distance" && (makeDimension(ents, ["p1", "p3"], "smart", "d") as { mode?: string }).mode).toBeUndefined();
    expect(makeDimension(ents, ["p1", "p3"], "horizontal", "d")).toMatchObject({ type: "distance", mode: "horizontal", value: 40.7 });
    expect(makeDimension(ents, ["p1", "p3"], "vertical", "d")).toMatchObject({ type: "distance", mode: "vertical", value: 20.7 });
    expect(makeDimension(ents, ["l1"], "vertical", "d")).toMatchObject({ type: "distance", a: "l1", mode: "vertical" });
    expect(makeDimension(ents, ["l1", "l2"], "smart", "d")).toMatchObject({ type: "angle" });
    expect(makeDimension(ents, ["l1", "l3"], "smart", "d")).toMatchObject({ type: "distance", a: "l1", b: "l3" });
    expect(makeDimension(ents, ["o", "l1"], "smart", "d")).toMatchObject({ type: "distance", a: "o", b: "l1" });
    expect(makeDimension(ents, ["c", "p1"], "smart", "d")).toMatchObject({ type: "distance", a: "c", b: "p1" });
  });

  it("references model geometry and snaps a sketch to it", () => {
    // Sketching on the front plane (XZ) of a 40 x 20 x 10 block that sits on z = 0.
    const frame = planeFrame({ base: "XZ" });
    const data = blank();
    addProfile(data, { type: "rect", cx: 3, cy: 30, w: 10, h: 6 }, false);
    const bottom = data.entities.find((e) => e.type === "line")!; // first line is the bottom edge
    // Top face of the block: flat, square to the sketch plane, at z = 10.
    const top = addModelRef(data, frame, { kind: "plane", origin: [5, 5, 10], normal: [0, 0, 1] });
    if ("error" in top) throw new Error(top.error);
    const refLine = byId(data.entities).get(top.id)!;
    expect(refLine.type === "line" && refLine.ref).toBe(true);
    data.constraints.push({ id: "snap", type: "coincident", a: bottom.id, b: top.id });
    const r = solveSketch(data.entities, data.constraints);
    expect(r.ok).toBe(true);
    const ys = [bottom.type === "line" ? xy(r.entities, bottom.p1)[1] : 0, bottom.type === "line" ? xy(r.entities, bottom.p2)[1] : 0];
    expect(ys).toEqual([expect.closeTo(10, 6), expect.closeTo(10, 6)]); // sketch y is world z on this plane
    expect(r.dof).toBe(3); // height above the face is gone; x, width and height remain

    // A model vertex becomes a fixed point a sketch point can be made coincident with.
    const corner = addModelRef(data, frame, { kind: "point", point: [20, -5, 10] });
    if ("error" in corner) throw new Error(corner.error);
    const first = bottom.type === "line" ? bottom.p2 : "";
    const snapped = solveSketch(data.entities, [...data.constraints, { id: "pin", type: "coincident", a: first, b: corner.id }]);
    expect(snapped.ok).toBe(true);
    expect(xy(snapped.entities, first)).toEqual([expect.closeTo(20, 6), expect.closeTo(10, 6)]);
    // Asking again for the same face reuses the reference; a face parallel to the sketch has no trace.
    expect(addModelRef(data, frame, { kind: "plane", origin: [0, 0, 10], normal: [0, 0, -1] })).toEqual({ id: top.id });
    expect("error" in addModelRef(data, frame, { kind: "plane", origin: [0, 0, 0], normal: [0, 1, 0] })).toBe(true);
  });
});

describe("reference planes", () => {
  it("offsets, passes through points and bisects faces", () => {
    const planes = new Map();
    const off: PlaneFeature = { id: "pl1", type: "plane", def: { kind: "offset", from: { base: "XY" }, distance: 12 } };
    planes.set("pl1", planeFeatureFrame(off, planes));
    expect(planes.get("pl1").origin).toEqual([0, 0, 12]);
    const stacked: PlaneFeature = { id: "pl2", type: "plane", def: { kind: "offset", from: { feature: "pl1" }, distance: -2 } };
    expect(planeFeatureFrame(stacked, planes).origin).toEqual([0, 0, 10]);
    expect(planeFrame({ feature: "pl1" }, planes).n).toEqual([0, 0, 1]);
    expect(() => planeFrame({ feature: "missing" }, planes)).toThrow();

    const three: PlaneFeature = { id: "pl3", type: "plane", def: { kind: "points", points: [[0, 0, 5], [10, 0, 5], [0, 10, 5]] } };
    const f = planeFeatureFrame(three, planes);
    expect(Math.abs(f.n[2])).toBeCloseTo(1, 9);
    expect(f.origin[2]).toBe(5);
    expect(() => planeFeatureFrame({ id: "x", type: "plane", def: { kind: "points", points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] } }, planes)).toThrow();

    const mid: PlaneFeature = { id: "pl4", type: "plane", def: { kind: "midplane", a: { origin: [0, 0, 0], normal: [-1, 0, 0] }, b: { origin: [30, 4, 4], normal: [1, 0, 0] } } };
    expect(planeFeatureFrame(mid, planes).origin[0]).toBe(15);
    expect(frameForFace([0, 0, 0], [0, 0, 1]).y).toEqual([0, 1, 0]);
  });
});

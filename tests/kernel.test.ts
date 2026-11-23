import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { evaluate, realEdgeGroups } from "../src/kernel/evaluate";
import { nestingDepths, recognizeStroke } from "../src/model/geom2d";
import { FeatureSchema, type Feature, type Vec2 } from "../src/model/schema";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  const oc = await (opencascade as unknown as (o: object) => Promise<unknown>)({
    locateFile: () => require.resolve("replicad-opencascadejs/wasm"),
  });
  setOC(oc as never);
}, 60_000);

const parse = (fs: unknown[]): Feature[] => fs.map((f) => FeatureSchema.parse(f));

const plate: unknown[] = [
  {
    id: "sk1",
    type: "sketch",
    plane: { base: "XY" },
    profiles: [
      { type: "rect", cx: 0, cy: 0, w: 40, h: 20 },
      { type: "circle", cx: 0, cy: 0, d: 10 },
    ],
  },
  { id: "ex1", type: "extrude", sketch: "sk1", distance: 5, op: "add" },
];

describe("kernel", () => {
  it("extrudes a plate with a nested hole", () => {
    const r = evaluate(parse(plate));
    expect(r.status.ex1).toEqual({ ok: true });
    expect(r.body!.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * 25 * 5, 3);
    expect(r.body!.bbox.min).toEqual([-20, -10, 0].map((v) => expect.closeTo(v, 5)));
    expect(r.body!.bbox.max).toEqual([20, 10, 5].map((v) => expect.closeTo(v, 5)));
  });

  it("front plane extrudes toward -Y, reverse toward +Y", () => {
    const sk = { id: "s", type: "sketch", plane: { base: "XZ" }, profiles: [{ type: "rect", cx: 0, cy: 5, w: 10, h: 10 }] };
    const a = evaluate(parse([sk, { id: "e", type: "extrude", sketch: "s", distance: 3, op: "add" }]));
    expect(a.body!.bbox.min[1]).toBeCloseTo(-3, 5);
    expect(a.body!.bbox.max[2]).toBeCloseTo(10, 5);
    const b = evaluate(parse([sk, { id: "e", type: "extrude", sketch: "s", distance: 3, op: "add", direction: "reverse" }]));
    expect(b.body!.bbox.max[1]).toBeCloseTo(3, 5);
    const c = evaluate(parse([sk, { id: "e", type: "extrude", sketch: "s", distance: 4, op: "add", direction: "symmetric" }]));
    expect(c.body!.bbox.min[1]).toBeCloseTo(-2, 5);
    expect(c.body!.bbox.max[1]).toBeCloseTo(2, 5);
  });

  it("auto cut goes into the body from a sketch on the top face", () => {
    const fs = parse([
      ...plate,
      { id: "sk2", type: "sketch", plane: { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] }, profiles: [{ type: "rect", cx: 12, cy: 0, w: 4, h: 4 }] },
      { id: "cut1", type: "extrude", sketch: "sk2", distance: 2, op: "cut" },
      { id: "sk3", type: "sketch", plane: { base: "XY" }, profiles: [{ type: "circle", cx: -12, cy: 0, d: 4 }] },
      { id: "cut2", type: "extrude", sketch: "sk3", distance: 1, op: "cut", throughAll: true },
    ]);
    const r = evaluate(fs);
    expect(r.status.cut1.ok && r.status.cut2.ok).toBe(true);
    expect(r.body!.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * 25 * 5 - 4 * 4 * 2 - Math.PI * 4 * 5, 3);
  });

  it("fillets edges chosen by direction, plane and nearest point", () => {
    const box = parse([
      { id: "s", type: "sketch", plane: { base: "XY" }, profiles: [{ type: "rect", cx: 0, cy: 0, w: 20, h: 20 }] },
      { id: "e", type: "extrude", sketch: "s", distance: 10, op: "add" },
    ]);
    const v0 = 20 * 20 * 10;
    const corner = (4 - Math.PI) * 2 * 2; // area removed from the square by four r=2 corners
    const vert = evaluate([...box, FeatureSchema.parse({ id: "f", type: "fillet", radius: 2, edges: { parallelTo: "Z" } })]);
    expect(vert.status.f.ok).toBe(true);
    expect(vert.body!.volume).toBeCloseTo(v0 - corner * 10, 2);

    const one = evaluate([...box, FeatureSchema.parse({ id: "f", type: "fillet", radius: 2, edges: { near: [[10, 10, 5]] } })]);
    expect(one.body!.volume).toBeCloseTo(v0 - (corner / 4) * 10, 2);

    const top = evaluate([...box, FeatureSchema.parse({ id: "c", type: "chamfer", distance: 1, edges: { onPlane: { normal: "Z", at: 10 } } })]);
    expect(top.status.c.ok).toBe(true);
    expect(top.body!.volume).toBeLessThan(v0);
    expect(top.body!.faces).toBe(10);

    const none = evaluate([...box, FeatureSchema.parse({ id: "f", type: "fillet", radius: 2, edges: { onPlane: { normal: "Z", at: 99 } } })]);
    expect(none.status.f.ok).toBe(false);
    expect(none.body!.volume).toBeCloseTo(v0, 3); // failed feature is skipped, body survives

    const tooBig = evaluate([...box, FeatureSchema.parse({ id: "f", type: "fillet", radius: 50, edges: {} })]);
    expect(tooBig.status.f.ok).toBe(false);
    expect(tooBig.status.f.error).toBeTruthy();
  });

  it("shells inward and opens the chosen face", () => {
    const r = evaluate(
      parse([
        { id: "s", type: "sketch", plane: { base: "XY" }, profiles: [{ type: "rect", cx: 0, cy: 0, w: 20, h: 20 }] },
        { id: "e", type: "extrude", sketch: "s", distance: 10, op: "add" },
        { id: "sh", type: "shell", thickness: 2, openFaces: { onPlane: { normal: "Z", at: 10 } } },
      ]),
    );
    expect(r.status.sh.ok).toBe(true);
    expect(r.body!.volume).toBeCloseTo(20 * 20 * 10 - 16 * 16 * 8, 2);
    expect(r.body!.bbox.max).toEqual([10, 10, 10].map((v) => expect.closeTo(v, 4)));
  });

  it("revolves a profile around the sketch y axis", () => {
    const r = evaluate(
      parse([
        { id: "s", type: "sketch", plane: { base: "XZ" }, profiles: [{ type: "rect", cx: 7.5, cy: 5, w: 5, h: 10 }] },
        { id: "r", type: "revolve", sketch: "s", axis: "y", op: "add" },
      ]),
    );
    expect(r.status.r.ok).toBe(true);
    expect(r.body!.volume).toBeCloseTo(Math.PI * (100 - 25) * 10, 2);
    expect(r.body!.bbox.max[2]).toBeCloseTo(10, 4);
  });

  it("builds slots, rotated and rounded rectangles and polygons", () => {
    const r = evaluate(
      parse([
        {
          id: "s",
          type: "sketch",
          plane: { base: "XY" },
          profiles: [
            { type: "slot", x1: 0, y1: 0, x2: 20, y2: 0, w: 6 },
            { type: "rect", cx: 0, cy: 30, w: 20, h: 10, r: 2, angle: 30 },
            { type: "polygon", points: [[40, 0], [60, 0], [50, 15]] },
          ],
        },
        { id: "e", type: "extrude", sketch: "s", distance: 1, op: "add" },
      ]),
    );
    expect(r.status.e.ok).toBe(true);
    const slot = 20 * 6 + Math.PI * 9;
    const rr = 20 * 10 - (4 - Math.PI) * 4;
    expect(r.body!.volume).toBeCloseTo(slot + rr + 150, 2);
  });

  it("reports a broken reference without losing the body", () => {
    const r = evaluate(parse([...plate, { id: "x", type: "extrude", sketch: "nope", distance: 5, op: "add" }]));
    expect(r.status.x.ok).toBe(false);
    expect(r.body!.volume).toBeGreaterThan(0);
  });

  it("meshes with face and edge groups", () => {
    const r = evaluate(parse(plate));
    const m = r.shape!.mesh({ tolerance: 0.1, angularTolerance: 0.3 });
    expect(m.faceGroups.length).toBe(r.body!.faces);
    expect(m.triangles.length).toBeGreaterThan(0);
    const e = r.shape!.meshEdges({ tolerance: 0.1, angularTolerance: 0.3 });
    expect(e.edgeGroups.length).toBeGreaterThan(0);
    // 12 box edges and the hole's two rims stay; the joins between the hole's half-cylinders go.
    const real = realEdgeGroups(r.shape!, e.edgeGroups);
    expect(real.length).toBeLessThan(e.edgeGroups.length);
    const straight = real.filter((g) => g.count === 2);
    expect(straight.length).toBe(12);
    expect(e.edgeGroups.filter((g) => g.count === 2).length).toBe(14);

    // The tangent lines bounding a fillet are real and stay visible.
    const filleted = evaluate(parse([...plate, { id: "f", type: "fillet", radius: 1, edges: { parallelTo: "Z" } }]));
    const fe = filleted.shape!.meshEdges({ tolerance: 0.1, angularTolerance: 0.3 });
    expect(realEdgeGroups(filleted.shape!, fe.edgeGroups).filter((g) => g.count === 2).length).toBe(8 + 8);
  });
});

describe("sketch helpers", () => {
  it("finds holes by nesting", () => {
    expect(
      nestingDepths([
        { type: "rect", cx: 0, cy: 0, w: 40, h: 20 },
        { type: "circle", cx: 0, cy: 0, d: 10 },
        { type: "circle", cx: 100, cy: 0, d: 10 },
      ]),
    ).toEqual([0, 1, 0]);
  });

  const wobble = (i: number) => Math.sin(i * 12.9898) * 0.6;

  it("recognises a wobbly circle", () => {
    const pts: Vec2[] = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 58) * Math.PI * 2;
      return [10 + (15 + wobble(i)) * Math.cos(a), -5 + (15 + wobble(i + 7)) * Math.sin(a)];
    });
    const p = recognizeStroke(pts, 1);
    expect(p).toMatchObject({ type: "circle", cx: 10, cy: -5 });
    expect((p as { d: number }).d).toBeGreaterThanOrEqual(29);
    expect((p as { d: number }).d).toBeLessThanOrEqual(31);
  });

  it("recognises a wobbly rectangle", () => {
    const pts: Vec2[] = [];
    const corners: Vec2[] = [[0, 0], [40.6, 0.8], [39.5, 20.4], [-0.7, 19.6], [0.3, 0.9]];
    for (let c = 0; c < 4; c++)
      for (let i = 0; i < 15; i++) {
        const t = i / 15;
        pts.push([
          corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t + wobble(c * 15 + i) * 0.5,
          corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t + wobble(c * 15 + i + 3) * 0.5,
        ]);
      }
    const p = recognizeStroke(pts, 1) as { type: string; w: number; h: number };
    expect(p.type).toBe("rect");
    expect(Math.abs(p.w - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.h - 20)).toBeLessThanOrEqual(2);
  });

  it("leaves an open stroke as ink", () => {
    expect(recognizeStroke(Array.from({ length: 20 }, (_, i) => [i * 2, i * 0.1] as Vec2), 1)).toBeNull();
  });
});

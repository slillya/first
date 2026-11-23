// The parametric model: an ordered list of features, evaluated top to bottom.
// These zod schemas are the single source of truth: they validate edits made
// by the UI and by Claude, and they generate the JSON Schema for Claude's tools.
import { z } from "zod";

const num = z.number().finite();
const pos = num.positive();
const pt2 = z.array(num).length(2);
const pt3 = z.array(num).length(3);

export const AxisSchema = z.enum(["X", "Y", "Z"]);

export const PlaneSchema = z.union([
  z
    .object({
      base: z.enum(["XY", "XZ", "YZ"]),
      offset: num.optional().describe("Distance along the plane normal, mm. Default 0."),
    })
    .describe(
      "Standard plane. XY (Top): sketch x=+X, y=+Y, normal +Z. XZ (Front): sketch x=+X, y=+Z, normal -Y. YZ (Right): sketch x=+Y, y=+Z, normal +X.",
    ),
  z
    .object({
      origin: pt3,
      normal: pt3,
      xDir: pt3.describe("World direction of the sketch x axis; must be perpendicular to normal."),
    })
    .describe("Arbitrary plane, e.g. on a planar face of the body. Sketch y = normal × xDir."),
  z.object({ feature: z.string().describe("id of an earlier plane feature") }).describe("A reference plane from the feature tree."),
]);

export const ProfileSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rect"),
    cx: num,
    cy: num,
    w: pos.describe("Size along sketch x before rotation"),
    h: pos.describe("Size along sketch y before rotation"),
    angle: num.optional().describe("Rotation about the centre, degrees CCW"),
    r: num.min(0).optional().describe("Corner radius"),
  }),
  z.object({ type: z.literal("circle"), cx: num, cy: num, d: pos.describe("Diameter") }),
  z.object({
    type: z.literal("polygon"),
    points: z.array(pt2).min(3).max(200).describe("Vertices in order; closed automatically"),
  }),
  z.object({
    type: z.literal("slot"),
    x1: num,
    y1: num,
    x2: num,
    y2: num,
    w: pos.describe("Slot width (= end diameter)"),
  }),
]);

export const EdgeSelSchema = z
  .object({
    parallelTo: AxisSchema.optional().describe("Keep straight edges parallel to this world axis"),
    onPlane: z
      .object({ normal: AxisSchema, at: num })
      .optional()
      .describe("Keep edges lying entirely in the plane <axis> = at, e.g. {normal:'Z', at:10} for the rim of a top face at z=10"),
    near: z
      .array(pt3)
      .max(100)
      .optional()
      .describe("For each point, pick the closest edge (among those passing the other filters). Use a point on the edge, e.g. its midpoint."),
  })
  .describe("Edge selection. Filters are ANDed. An empty object selects every edge.");

export const FaceSelSchema = z
  .object({
    onPlane: z
      .object({ normal: AxisSchema, at: num })
      .optional()
      .describe("Planar faces lying in the plane <axis> = at"),
    near: z.array(pt3).max(50).optional().describe("For each point, the face closest to it"),
  })
  .describe("Face selection. At least one filter is required.");

const base = {
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .describe("Unique id, e.g. sk1, ex1, f1"),
  name: z.string().max(60).optional().describe("Label shown in the feature tree"),
  suppressed: z.boolean().optional(),
};

const op = z.enum(["add", "cut"]).describe("add = join material to the body, cut = remove it");

const eid = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);

export const EntitySchema = z.discriminatedUnion("type", [
  z.object({
    id: eid,
    type: z.literal("point"),
    x: num,
    y: num,
    fixed: z.boolean().optional().describe("Locked in place; the solver never moves it"),
    src: pt3.optional().describe("Set on reference points: the model point (world mm) this was projected from"),
  }),
  z.object({
    id: eid,
    type: z.literal("line"),
    p1: eid.describe("id of the start point entity"),
    p2: eid.describe("id of the end point entity"),
    construction: z.boolean().optional().describe("Construction geometry is ignored when extruding"),
    ref: z.boolean().optional().describe("Reference to model geometry (an edge, or a face seen edge-on); treated as an infinite fixed line"),
  }),
  z.object({ id: eid, type: z.literal("circle"), c: eid.describe("id of the centre point"), r: pos, construction: z.boolean().optional() }),
  z.object({
    id: eid,
    type: z.literal("arc"),
    c: eid.describe("id of the centre point"),
    p1: eid.describe("start point; the arc runs counter-clockwise from p1 to p2"),
    p2: eid.describe("end point"),
    construction: z.boolean().optional(),
  }),
]);

const cbase = { id: eid };
export const ConstraintSchema = z.discriminatedUnion("type", [
  z.object({ ...cbase, type: z.literal("coincident"), a: eid, b: eid }).describe("point–point, point on line, point on circle/arc, or line–line (collinear)"),
  z.object({ ...cbase, type: z.literal("horizontal"), a: eid, b: eid.optional() }).describe("a line, or two points, level with sketch x"),
  z.object({ ...cbase, type: z.literal("vertical"), a: eid, b: eid.optional() }),
  z.object({ ...cbase, type: z.literal("parallel"), a: eid, b: eid }),
  z.object({ ...cbase, type: z.literal("perpendicular"), a: eid, b: eid }),
  z.object({ ...cbase, type: z.literal("equal"), a: eid, b: eid }).describe("two lines of equal length, or two circles/arcs of equal radius"),
  z.object({ ...cbase, type: z.literal("tangent"), a: eid, b: eid }).describe("line–circle/arc or circle/arc–circle/arc"),
  z.object({ ...cbase, type: z.literal("concentric"), a: eid, b: eid }),
  z.object({ ...cbase, type: z.literal("midpoint"), a: eid, b: eid }).describe("point a at the middle of line b"),
  z.object({ ...cbase, type: z.literal("fix"), a: eid }).describe("pins a point (or every point of a line/circle/arc) where it is"),
  z
    .object({
      ...cbase,
      type: z.literal("distance"),
      a: eid,
      b: eid.optional(),
      value: num.min(0),
      mode: z.enum(["aligned", "horizontal", "vertical"]).optional(),
    })
    .describe(
      "Driving dimension. One line: its length. Two points: straight-line distance (aligned, default), or only the x gap (horizontal) or y gap (vertical), leaving the other direction free. Point and line: perpendicular distance. Two lines: distance between them (makes them parallel).",
    ),
  z.object({ ...cbase, type: z.literal("radius"), a: eid, value: pos }),
  z.object({ ...cbase, type: z.literal("diameter"), a: eid, value: pos }),
  z.object({ ...cbase, type: z.literal("angle"), a: eid, b: eid.optional(), value: num }).describe("Degrees between two lines, or between line a and the sketch x axis when b is omitted"),
]);

export const SketchSchema = z.object({
  ...base,
  type: z.literal("sketch"),
  plane: PlaneSchema,
  entities: z.array(EntitySchema).max(2000).default([]).describe("Points, and the lines, circles and arcs that reference them by id"),
  constraints: z.array(ConstraintSchema).max(4000).default([]).describe("Geometric relations and driving dimensions; the app solves them"),
  profiles: z
    .array(ProfileSchema)
    .max(200)
    .optional()
    .describe(
      "Shorthand for input only: whole closed shapes, which the app expands into fully-dimensioned entities and constraints. A shape nested inside another becomes a hole.",
    ),
});

const planeLike = z.object({ origin: pt3, normal: pt3 });
export const PlaneFeatureSchema = z.object({
  ...base,
  type: z.literal("plane"),
  def: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("offset"), from: PlaneSchema, distance: num.describe("mm along the source plane's normal; negative goes the other way") }),
    z.object({ kind: z.literal("points"), points: z.array(pt3).length(3).describe("Three model points the plane passes through") }),
    z.object({ kind: z.literal("midplane"), a: planeLike, b: planeLike }).describe("Halfway between two parallel faces"),
  ]),
});

export const ExtrudeSchema = z.object({
  ...base,
  type: z.literal("extrude"),
  sketch: z.string().describe("id of an earlier sketch feature"),
  distance: pos.describe("mm. Ignored when throughAll is true."),
  op,
  direction: z
    .enum(["auto", "normal", "reverse", "symmetric"])
    .optional()
    .describe("auto (default): add goes along the plane normal, cut goes toward the body. symmetric: distance/2 each side."),
  throughAll: z.boolean().optional().describe("Cut only: go through the whole body in the chosen direction"),
});

export const RevolveSchema = z.object({
  ...base,
  type: z.literal("revolve"),
  sketch: z.string(),
  axis: z.enum(["x", "y"]).describe("Sketch axis to revolve around. The profile must lie on one side of it."),
  axisOffset: num.optional().describe("Shifts the axis: for axis 'y' it is the line x = axisOffset; for 'x', y = axisOffset"),
  angle: num.gt(0).max(360).optional().describe("Degrees, default 360"),
  op,
});

export const FilletSchema = z.object({
  ...base,
  type: z.literal("fillet"),
  radius: pos,
  edges: EdgeSelSchema,
});

export const ChamferSchema = z.object({
  ...base,
  type: z.literal("chamfer"),
  distance: pos,
  edges: EdgeSelSchema,
});

export const ShellSchema = z.object({
  ...base,
  type: z.literal("shell"),
  thickness: pos.describe("Wall thickness, mm; walls grow inward from the current faces"),
  openFaces: FaceSelSchema.describe("Faces to remove, leaving the part open there"),
});

export const FeatureSchema = z.discriminatedUnion("type", [
  SketchSchema,
  PlaneFeatureSchema,
  ExtrudeSchema,
  RevolveSchema,
  FilletSchema,
  ChamferSchema,
  ShellSchema,
]);

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Axis = z.infer<typeof AxisSchema>;
export type PlaneRef = z.infer<typeof PlaneSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type EdgeSel = z.infer<typeof EdgeSelSchema>;
export type FaceSel = z.infer<typeof FaceSelSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type PointEntity = Extract<Entity, { type: "point" }>;
export type LineEntity = Extract<Entity, { type: "line" }>;
export type CircleEntity = Extract<Entity, { type: "circle" }>;
export type ArcEntity = Extract<Entity, { type: "arc" }>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ConstraintType = Constraint["type"];
export type SketchFeature = z.infer<typeof SketchSchema>;
export type PlaneFeature = z.infer<typeof PlaneFeatureSchema>;
export type ExtrudeFeature = z.infer<typeof ExtrudeSchema>;
export type RevolveFeature = z.infer<typeof RevolveSchema>;
export type FilletFeature = z.infer<typeof FilletSchema>;
export type ChamferFeature = z.infer<typeof ChamferSchema>;
export type ShellFeature = z.infer<typeof ShellSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureType = Feature["type"];

export interface PartDoc {
  name: string;
  features: Feature[];
}

/** SolidWorks-style default label for a new feature. */
export function defaultName(f: Feature, existing: Feature[]): string {
  const label =
    f.type === "sketch"
      ? "Sketch"
      : f.type === "plane"
        ? "Plane"
        : f.type === "extrude"
        ? f.op === "cut"
          ? "Cut-Extrude"
          : "Boss-Extrude"
        : f.type === "revolve"
          ? f.op === "cut"
            ? "Cut-Revolve"
            : "Revolve"
          : f.type === "fillet"
            ? "Fillet"
            : f.type === "chamfer"
              ? "Chamfer"
              : "Shell";
  let n = 1;
  const taken = new Set(existing.map((e) => e.name));
  while (taken.has(`${label}${n}`)) n++;
  return `${label}${n}`;
}

export function newId(prefix: string, existing: Feature[]): string {
  const taken = new Set(existing.map((e) => e.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const ID_PREFIX: Record<FeatureType, string> = {
  sketch: "sk",
  plane: "pl",
  extrude: "ex",
  revolve: "rv",
  fillet: "fl",
  chamfer: "ch",
  shell: "sh",
};

/** Readable one-line summary of zod issues, for the UI and for Claude. */
export function issuesText(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Assemblies and the file tree

const quat = z.array(num).length(4);
export const PoseSchema = z.object({ p: pt3, q: quat.describe("Unit quaternion [x, y, z, w]") });

export const GeoRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plane"), origin: pt3, dir: pt3 }).describe("A flat face: a point on it and its outward normal, in the part's own coordinates"),
  z.object({ type: z.literal("axis"), origin: pt3, dir: pt3 }).describe("A straight edge, or the axis of a round face or circular edge"),
  z.object({ type: z.literal("point"), origin: pt3 }).describe("A vertex"),
]);

export const MateTypeSchema = z.enum(["coincident", "concentric", "parallel", "perpendicular", "distance", "angle", "lock"]);

export const ComponentSchema = z.object({
  id: z.string(),
  name: z.string().max(60),
  part: z.string().describe("File id of the part this is an instance of"),
  pose: PoseSchema,
  fixed: z.boolean().optional(),
});

export const MateSchema = z.object({
  id: z.string(),
  name: z.string().max(60),
  type: MateTypeSchema,
  a: z.object({ component: z.string(), ref: GeoRefSchema }),
  b: z.object({ component: z.string(), ref: GeoRefSchema }),
  value: num.optional().describe("mm for distance, degrees for angle"),
  flip: z.boolean().optional(),
  suppressed: z.boolean().optional(),
});

export const AssemblySchema = z.object({
  name: z.string(),
  components: z.array(ComponentSchema),
  mates: z.array(MateSchema),
});

export type Pose = { p: Vec3; q: [number, number, number, number] };
export type GeoRef = { type: "plane"; origin: Vec3; dir: Vec3 } | { type: "axis"; origin: Vec3; dir: Vec3 } | { type: "point"; origin: Vec3 };
export type MateType = z.infer<typeof MateTypeSchema>;
export interface Component {
  id: string;
  name: string;
  part: string;
  pose: Pose;
  fixed?: boolean;
}
export interface Mate {
  id: string;
  name: string;
  type: MateType;
  a: { component: string; ref: GeoRef };
  b: { component: string; ref: GeoRef };
  value?: number;
  flip?: boolean;
  suppressed?: boolean;
}
export interface AssemblyDoc {
  name: string;
  components: Component[];
  mates: Mate[];
}
export type AnyDoc = PartDoc | AssemblyDoc;
export const isAssembly = (d: AnyDoc): d is AssemblyDoc => "components" in d;

export interface FileEntry {
  id: string;
  kind: "folder" | "part" | "assembly";
  name: string;
  parent: string | null;
  updated: number;
}

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

export const SketchSchema = z.object({
  ...base,
  type: z.literal("sketch"),
  plane: PlaneSchema,
  profiles: z
    .array(ProfileSchema)
    .max(200)
    .describe("Closed profiles in sketch mm. A profile nested inside another becomes a hole in it."),
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
export type SketchFeature = z.infer<typeof SketchSchema>;
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

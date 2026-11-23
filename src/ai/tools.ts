// Tools Claude uses to edit the part. Shared by the server (which turns the
// zod schemas into JSON Schema for the API) and the browser (which validates
// each call against the same schemas and runs it on the local model).
import { z } from "zod";
import { FeatureSchema, ProfileSchema } from "../model/schema";

export const ToolInputs = {
  add_features: z.object({
    features: z
      .array(FeatureSchema)
      .min(1)
      .max(40)
      .describe("Features in build order. A feature may reference a sketch or plane added earlier in the same call."),
    after: z.string().optional().describe("Insert after this feature id. Default: append to the end of the tree."),
  }),
  update_feature: z.object({
    id: z.string().describe("id of the feature to change"),
    changes: z
      .record(z.string(), z.unknown())
      .describe(
        "Fields to replace on the feature. Shallow merge: arrays and nested objects (entities, constraints, plane, edges, def) are replaced whole. id and type cannot change.",
      ),
  }),
  delete_features: z.object({
    ids: z.array(z.string()).min(1).describe("Feature ids to remove. Removing a sketch also removes the extrudes/revolves built on it."),
  }),
  rename_part: z.object({ name: z.string().min(1).max(60) }),
  add_sketch_shapes: z.object({
    sketch: z.string().describe("id of an existing sketch feature"),
    profiles: z.array(ProfileSchema).min(1).max(100).describe("Whole shapes to add; each becomes fully-dimensioned lines, arcs and circles"),
  }),
  set_dimensions: z.object({
    sketch: z.string().describe("id of the sketch feature"),
    values: z
      .array(z.object({ id: z.string().describe("id of a distance, radius, diameter or angle constraint"), value: z.number().finite() }))
      .min(1)
      .max(100),
  }),
};

export type ToolName = keyof typeof ToolInputs;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  add_features:
    "Add one or more features (sketch, plane, extrude, revolve, fillet, chamfer, shell) to the part's feature tree. Use this to create new geometry. The result reports whether every feature built, and the body's bounding box and volume.",
  update_feature:
    "Change parameters of an existing feature, e.g. an extrude distance, a fillet radius, a plane offset, or a sketch's entities and constraints. Use this instead of adding a new feature whenever the user is modifying something already in the tree. The result reports build status and the new bounding box and volume.",
  delete_features: "Remove features from the tree. The result reports build status of what remains.",
  rename_part: "Rename the part. Call this when the user names the part or when a first design makes a descriptive name obvious.",
  add_sketch_shapes:
    "Add whole shapes (rectangles, circles, slots, polygons) to an existing sketch without touching what is already in it. Use this to turn the user's finger strokes into clean geometry, or to add holes to a sketch. The result reports the sketch's state and the build status.",
  set_dimensions:
    "Change the values of driving dimensions in a sketch; the sketch is re-solved and everything built on it updates. Use this for requests like 'make it 60 wide' when the sketch already has that dimension. The result reports build status and the new bounding box and volume.",
};

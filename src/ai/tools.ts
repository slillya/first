// Tools Claude uses to edit the part. Shared by the server (which turns the
// zod schemas into JSON Schema for the API) and the browser (which validates
// each call against the same schemas and runs it on the local model).
import { z } from "zod";
import { FeatureSchema } from "../model/schema";

export const ToolInputs = {
  add_features: z.object({
    features: z
      .array(FeatureSchema)
      .min(1)
      .max(40)
      .describe("Features in build order. A feature may reference a sketch added earlier in the same call."),
    after: z.string().optional().describe("Insert after this feature id. Default: append to the end of the tree."),
  }),
  update_feature: z.object({
    id: z.string().describe("id of the feature to change"),
    changes: z
      .record(z.string(), z.unknown())
      .describe(
        "Fields to replace on the feature. Shallow merge: arrays and nested objects (profiles, plane, edges) are replaced whole. id and type cannot change.",
      ),
  }),
  delete_features: z.object({
    ids: z.array(z.string()).min(1).describe("Feature ids to remove. Removing a sketch also removes the extrudes/revolves built on it."),
  }),
  rename_part: z.object({ name: z.string().min(1).max(60) }),
};

export type ToolName = keyof typeof ToolInputs;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  add_features:
    "Add one or more features (sketch, extrude, revolve, fillet, chamfer, shell) to the part's feature tree. Use this to create new geometry. The result reports whether every feature built, and the body's bounding box and volume.",
  update_feature:
    "Change parameters of an existing feature, e.g. an extrude distance, a fillet radius, or a sketch's profiles. Use this instead of adding a new feature whenever the user is modifying something already in the tree. The result reports build status and the new bounding box and volume.",
  delete_features: "Remove features from the tree. The result reports build status of what remains.",
  rename_part: "Rename the part. Call this when the user names the part or when a first design makes a descriptive name obvious.",
};

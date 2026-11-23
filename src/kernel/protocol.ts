import type { Feature } from "../model/schema";
import type { BodyInfo, FeatureStatus } from "./evaluate";

export type { BodyInfo, FeatureStatus };

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Triangle indices; faceGroups index into this array. */
  indices: Uint32Array;
  faceGroups: { start: number; count: number; faceId: number }[];
  /** Flat xyz of segment endpoint pairs; edgeGroups count vertices, not floats. */
  lines: Float32Array;
  edgeGroups: { start: number; count: number; edgeId: number }[];
}

export type KernelRequest =
  | { id: number; kind: "init" }
  | { id: number; kind: "eval"; features: Feature[] }
  | { id: number; kind: "export"; format: "step" | "stl" };

export type KernelResponse =
  | { id: number; kind: "init" }
  | { id: number; kind: "eval"; status: Record<string, FeatureStatus>; body: BodyInfo | null; mesh: MeshData | null }
  | { id: number; kind: "export"; data: ArrayBuffer }
  | { id: number; kind: "error"; message: string };

export interface EvalOutcome {
  status: Record<string, FeatureStatus>;
  body: BodyInfo | null;
  mesh: MeshData | null;
}

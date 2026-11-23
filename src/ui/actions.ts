// What the toolbox and context chips do.
import { kernel } from "../kernel/client";
import { frameForFace, v3 } from "../model/geom2d";
import type { Axis, EdgeSel, GeoRef, MateType } from "../model/schema";
import {
  bodyInfo,
  createWithSheet,
  doc,
  feature,
  selectedPlane,
  selection,
  showToast,
  sketchForNewFeature,
  startSketch,
  type FacePick,
} from "../model/store";

// Build-time constant: true only in the Claude artifact build (see scripts/build-artifact.mjs).
const ARTIFACT = import.meta.env.MODE === "artifact";

function axisAligned(f: FacePick): { normal: Axis; at: number } | null {
  if (!f.planar) return null;
  const axes: Axis[] = ["X", "Y", "Z"];
  const i = f.normal.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-4);
  return i < 0 ? null : { normal: axes[i], at: Math.round(f.point[i] * 1e4) / 1e4 };
}

export function newExtrude(op: "add" | "cut") {
  const sketch = sketchForNewFeature();
  if (!sketch) return showToast("Draw a closed sketch first (Tools → Sketch)");
  if (op === "cut" && !bodyInfo.value) return showToast("There is nothing to cut yet");
  createWithSheet({ type: "extrude", sketch, distance: 10, op, ...(op === "cut" ? { throughAll: true } : {}) });
}

export function newRevolve() {
  const sketch = sketchForNewFeature();
  if (!sketch) return showToast("Draw a closed sketch first (Tools → Sketch)");
  createWithSheet({ type: "revolve", sketch, axis: "y", angle: 360, op: "add" });
}

export function newEdgeFeature(kind: "fillet" | "chamfer") {
  if (!bodyInfo.value) return showToast("Make a solid first");
  const sel = selection.value;
  let edges: EdgeSel = {};
  const plane = sel.faces.length === 1 ? axisAligned(sel.faces[0]) : null;
  if (sel.edges.length) edges = { near: sel.edges.map((e) => e.point) };
  else if (plane) edges = { onPlane: plane };
  else showToast(`No edges selected, so this ${kind} applies to every edge`);
  createWithSheet(kind === "fillet" ? { type: "fillet", radius: 2, edges } : { type: "chamfer", distance: 1, edges });
}

export function newShell() {
  if (!bodyInfo.value) return showToast("Make a solid first");
  const faces = selection.value.faces;
  if (!faces.length) return showToast("Tap the face to open up, then choose Shell");
  createWithSheet({ type: "shell", thickness: 2, openFaces: { near: faces.map((f) => f.point) } });
}

/**
 * A reference plane from whatever is selected: offset from a plane or flat
 * face (type the distance), halfway between two parallel faces, or through
 * three corners.
 */
export function newPlane() {
  const sel = selection.value;
  const flat = sel.faces.filter((f) => f.planar);
  if (sel.vertices.length === 3) return createWithSheet({ type: "plane", def: { kind: "points", points: sel.vertices.map((v) => v.point) } });
  if (flat.length === 2) {
    if (Math.abs(Math.abs(v3.dot(flat[0].normal, flat[1].normal)) - 1) > 1e-6) return showToast("A midplane needs two parallel faces");
    return createWithSheet({ type: "plane", def: { kind: "midplane", a: { origin: flat[0].point, normal: flat[0].normal }, b: { origin: flat[1].point, normal: flat[1].normal } } });
  }
  if (flat.length === 1) {
    const f = frameForFace(flat[0].center, flat[0].normal);
    return createWithSheet({ type: "plane", def: { kind: "offset", from: { origin: f.origin, normal: f.n, xDir: f.x }, distance: 10 } });
  }
  const plane = selectedPlane();
  if (plane) return createWithSheet({ type: "plane", def: { kind: "offset", from: plane.ref, distance: 10 } });
  showToast("Pick a plane or flat face to offset from, two parallel faces for a midplane, or three corners");
}

export function sketchOnSelectedPlane() {
  const plane = selectedPlane();
  if (plane) startSketch(plane.ref);
}

export async function exportPart(format: "step" | "stl") {
  if (!bodyInfo.value) return showToast("There is no solid to export yet");
  try {
    const data = await kernel.export(format);
    const name = `${doc.value.name.replace(/[^\w.-]+/g, "_") || "part"}.${format}`;
    if (ARTIFACT) return await (await import("../ai/artifact")).saveInArtifact(name, data);
    const file = new File([data], name, { type: format === "step" ? "model/step" : "model/stl" });
    // The iOS share sheet is the dependable way to get a file into Files or AirDrop.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    showToast(e instanceof Error ? e.message : "Export failed");
  }
}

export function describeEdges(sel: EdgeSel): string {
  const parts: string[] = [];
  if (sel.near?.length) parts.push(`${sel.near.length} picked edge${sel.near.length > 1 ? "s" : ""}`);
  if (sel.parallelTo) parts.push(`edges along ${sel.parallelTo}`);
  if (sel.onPlane) parts.push(`edges at ${sel.onPlane.normal} = ${sel.onPlane.at}`);
  return parts.join(", ") || "All edges";
}

export const sketchName = (id: string) => feature(id)?.name ?? id;

/** Mates that make sense between two kinds of picked geometry, most likely first. */
export function matesFor(a: GeoRef["type"], b: GeoRef["type"]): MateType[] {
  const pair = [a, b].sort().join("+");
  switch (pair) {
    case "plane+plane":
      return ["coincident", "distance", "parallel", "perpendicular", "angle"];
    case "axis+axis":
      return ["concentric", "parallel", "perpendicular", "distance", "angle"];
    case "axis+plane":
      return ["coincident", "parallel", "perpendicular"];
    case "plane+point":
      return ["coincident", "distance"];
    case "axis+point":
      return ["coincident", "distance"];
    case "point+point":
      return ["coincident", "distance"];
    default:
      return [];
  }
}

// What the toolbox and context chips do.
import { kernel } from "../kernel/client";
import type { Axis, EdgeSel } from "../model/schema";
import {
  bodyInfo,
  createWithSheet,
  doc,
  feature,
  selection,
  showToast,
  sketchForNewFeature,
  type FacePick,
} from "../model/store";

function axisAligned(f: FacePick): { normal: Axis; at: number } | null {
  if (!f.planar) return null;
  const axes: Axis[] = ["X", "Y", "Z"];
  const i = f.normal.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-4);
  return i < 0 ? null : { normal: axes[i], at: Math.round(f.point[i] * 1e4) / 1e4 };
}

export function newExtrude(op: "add" | "cut") {
  const sketch = sketchForNewFeature();
  if (!sketch) return showToast("Draw a sketch first (Tools → Sketch)");
  if (op === "cut" && !bodyInfo.value) return showToast("There is nothing to cut yet");
  createWithSheet({ type: "extrude", sketch, distance: 10, op, ...(op === "cut" ? { throughAll: true } : {}) });
}

export function newRevolve() {
  const sketch = sketchForNewFeature();
  if (!sketch) return showToast("Draw a sketch first (Tools → Sketch)");
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

export async function exportPart(format: "step" | "stl") {
  if (!bodyInfo.value) return showToast("There is no solid to export yet");
  try {
    const data = await kernel.export(format);
    const name = `${doc.value.name.replace(/[^\w.-]+/g, "_") || "part"}.${format}`;
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

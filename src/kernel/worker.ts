/// <reference lib="webworker" />
// CAD kernel worker: owns the OpenCascade WASM instance so the UI thread
// never blocks on booleans or fillets.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC, type Shape3D } from "replicad";
import { evaluate, realEdgeGroups } from "./evaluate";
import type { KernelRequest, KernelResponse, MeshData } from "./protocol";

// Build-time constant: true only in the Claude artifact build (see scripts/build-artifact.mjs).
const ARTIFACT = import.meta.env.MODE === "artifact";

let ready: Promise<void> | null = null;
let current: Shape3D | null = null;

type OcFactory = (options: object) => Promise<unknown>;

async function loadKernel(): Promise<unknown> {
  const factory = opencascade as unknown as OcFactory;
  if (!ARTIFACT) return factory({ locateFile: () => wasmUrl });
  // Artifact files are capped below the kernel's size, so it is published in two halves next to the page.
  const parts = await Promise.all(
    ["../kernel.0.wasm", "../kernel.1.wasm"].map(async (name) => {
      const res = await fetch(new URL(name, self.location.href));
      if (!res.ok) throw new Error(`Could not download the CAD kernel (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
  const bytes = new Uint8Array(parts[0].length + parts[1].length);
  bytes.set(parts[0]);
  bytes.set(parts[1], parts[0].length);
  return factory({
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(bytes, imports).then((r) => done(r.instance, r.module));
      return {};
    },
  });
}

function init(): Promise<void> {
  ready ??= loadKernel().then((oc) => setOC(oc as never));
  return ready;
}

function meshOf(shape: Shape3D): MeshData {
  const [min, max] = shape.boundingBox.bounds;
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const opts = { tolerance: Math.min(0.5, Math.max(0.01, diag * 0.001)), angularTolerance: 0.2 };
  const m = shape.mesh(opts);
  const e = shape.meshEdges(opts);
  const edgeGroups = realEdgeGroups(shape, e.edgeGroups);
  return {
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups,
    lines: new Float32Array(e.lines),
    edgeGroups,
  };
}

const post = (msg: KernelResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<KernelRequest>) => {
  const req = ev.data;
  try {
    await init();
    if (req.kind === "init") {
      post({ id: req.id, kind: "init" });
    } else if (req.kind === "eval") {
      const r = evaluate(req.features);
      current = r.shape;
      let mesh: MeshData | null = null;
      if (r.shape) {
        try {
          mesh = meshOf(r.shape);
        } catch {
          mesh = null;
        }
      }
      post(
        { id: req.id, kind: "eval", status: r.status, body: r.body, mesh },
        mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.lines.buffer] : [],
      );
    } else if (req.kind === "export") {
      if (!current) throw new Error("There is no solid to export yet");
      const blob = req.format === "step" ? current.blobSTEP() : current.blobSTL({ tolerance: 0.02, angularTolerance: 0.15 });
      post({ id: req.id, kind: "export", data: await blob.arrayBuffer() });
    }
  } catch (e) {
    post({ id: req.id, kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};

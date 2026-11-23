import type { Feature } from "../model/schema";
import type { EvalOutcome, KernelRequest, KernelResponse } from "./protocol";

type Pending = { resolve: (r: KernelResponse) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function get(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<KernelResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.kind === "error") p.reject(new Error(ev.data.message));
    else p.resolve(ev.data);
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "The CAD kernel failed to load");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

type Body<K extends KernelRequest["kind"]> = Omit<Extract<KernelRequest, { kind: K }>, "id">;

function call<K extends KernelRequest["kind"]>(req: Body<K>): Promise<Extract<KernelResponse, { kind: K }>> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as Pending["resolve"], reject });
    get().postMessage({ ...req, id });
  });
}

export const kernel = {
  init: () => call<"init">({ kind: "init" }),
  async evaluate(features: Feature[]): Promise<EvalOutcome> {
    const r = await call<"eval">({ kind: "eval", features });
    return { status: r.status, body: r.body, mesh: r.mesh };
  },
  async export(format: "step" | "stl"): Promise<ArrayBuffer> {
    return (await call<"export">({ kind: "export", format })).data;
  },
};

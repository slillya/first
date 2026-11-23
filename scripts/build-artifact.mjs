// Turns the artifact-mode Vite build into what the Claude Artifact tool
// publishes: a page fragment (no doctype/head/body, CSS inlined) plus the
// script files and the CAD kernel (split in two) that sit beside it.
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const out = "dist-artifact";
const require = createRequire(import.meta.url);
const html = readFileSync(`${out}/index.html`, "utf8");
const script = /<script[^>]+src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
const sheet = /<link[^>]+href="\.\/(assets\/[^"]+\.css)"/.exec(html)?.[1];
if (!script || !sheet) throw new Error("Unexpected build output: entry script or stylesheet not found");

const page = `<title>Napkin CAD</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${readFileSync(`${out}/${sheet}`, "utf8")}</style>
<div id="app"></div>
<script type="module" src="${script}"></script>
`;
writeFileSync(`${out}/page.html`, page);

// The kernel is over the per-file limit, so it ships as two halves that the worker joins.
const kernel = readFileSync(require.resolve("replicad-opencascadejs/wasm"));
const half = Math.ceil(kernel.length / 2);
writeFileSync(`${out}/kernel.0.wasm`, kernel.subarray(0, half));
writeFileSync(`${out}/kernel.1.wasm`, kernel.subarray(half));
for (const f of readdirSync(`${out}/assets`)) if (f.endsWith(".wasm") || f.endsWith(".css")) rmSync(`${out}/assets/${f}`);

const files = Object.fromEntries(readdirSync(`${out}/assets`).map((f) => [`assets/${f}`, `${out}/assets/${f}`]));
for (const f of ["kernel.0.wasm", "kernel.1.wasm"]) files[f] = `${out}/${f}`;
writeFileSync(`${out}/files.json`, JSON.stringify(files, null, 2));
console.log(`page: ${out}/page.html\nfiles:`, files);

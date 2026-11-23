import { readFileSync } from "node:fs";
import preact from "@preact/preset-vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Secrets for local development, in wrangler's .dev.vars format (KEY=value per line). */
function devVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m) vars[m[1]] = m[2];
    }
  } catch {
    // No .dev.vars: the app still runs, Claude just reports that it is not connected.
  }
  return vars;
}

/** Serves /api/* in `vite dev` with the same handler the Cloudflare Worker uses. */
function devApi(): Plugin {
  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const { handleApi } = (await server.ssrLoadModule("/server/handler.ts")) as typeof import("./server/handler");
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const abort = new AbortController();
          res.on("close", () => abort.abort());
          const response = await handleApi(
            new Request(`http://localhost${req.url}`, {
              method: req.method,
              headers: req.headers as Record<string, string>,
              body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
              signal: abort.signal,
            }),
            { ...process.env, ...devVars() },
          );
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          if (response.body) {
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : "Server error" }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), devApi()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  server: { host: true },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000 },
});

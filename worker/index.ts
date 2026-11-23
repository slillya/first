// Cloudflare Worker entry: /api/* goes to the Claude endpoint, everything
// else is the built app served from static assets.
import { handleApi, type Env } from "../server/handler";

interface Bindings extends Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};

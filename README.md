# Napkin CAD

Parametric CAD for an iPhone. Sketch a part with your finger, or describe it in the chat box, and Claude turns it into a real solid with an editable feature tree.

It is a web app (installable to the home screen), not a native app. The CAD kernel runs in the browser, so nothing heavy runs on a server and your laptop does not need to be on. It ships two ways from the same code:

- **As a site on Cloudflare.** A small Worker serves the app and holds your Anthropic API key. This is the real product: your own URL, a home-screen icon, full-screen.
- **As a Claude artifact.** The same app published inside Claude, where the chat uses the viewer's own Claude account. No API key and nothing to deploy; good for trying changes quickly.

## What is on screen

- **Model view** fills the screen. One finger orbits, two fingers pan and pinch-zoom, a tap selects a face or edge.
- **Part name, top left.** Tap it to drop down the feature tree: every feature in the order it was built, with edit, rename, hide and delete. Build errors show in red on the feature that failed.
- **Tools, top right.** Sketch planes (Top, Front, Right, or the selected face), Extrude, Cut, Revolve, Fillet, Chamfer, Shell, standard views, undo/redo, and STEP/STL export. While a sketch is open it becomes the drawing tools: freehand, line, rectangle, circle, select/move, erase.
- **Chat box, bottom.** Tap to type; sending folds it back to a pill so the keyboard gives the screen back. Claude's reply shows in a small bubble above it. Tap the bubble for the conversation.
- **Context chips** appear above the chat box for the obvious next step: Extrude after a sketch, Fillet/Chamfer after picking edges, Sketch here/Shell after picking a face.

## Drawing with a finger

Open a sketch and draw. Strokes stay as orange "ink" until you do one of two things:

- **Send** (with or without words, e.g. "make this 10 thick"). Claude gets the strokes as coordinates plus a screenshot, replaces them with clean dimensioned geometry, and adds any feature you asked for.
- **Clean up**, which runs a recogniser on the phone (circles, rectangles, polygons) and needs no network.

Shapes show their dimensions; tap one to type an exact value. A shape drawn inside another becomes a hole.

## How it works

```
iPhone browser                               Cloudflare Worker            Anthropic
┌───────────────────────────────────────┐    ┌──────────────────┐         ┌────────┐
│ UI (Preact) ── feature list (JSON)    │    │ /api/chat        │         │ Claude │
│ Viewport (three.js)                   │◄──►│  holds API key   │◄───────►│        │
│ Kernel worker: OpenCascade (WASM)     │    │  one model turn  │         └────────┘
│ Tool loop: runs Claude's edits here   │    │ static assets    │
└───────────────────────────────────────┘    └──────────────────┘
```

- The part is an ordered list of features (`src/model/schema.ts`): sketch, extrude, revolve, fillet, chamfer, shell. That list is the whole document; it is saved in the browser's local storage.
- `src/kernel/evaluate.ts` builds it into B-rep geometry with [replicad](https://replicad.xyz) on OpenCascade, in a Web Worker. That is what makes real fillets, shells and STEP export possible.
- Claude edits the same list through four tools (`src/ai/tools.ts`): add, update, delete features, rename the part. The tool loop runs in the browser (`src/ai/agent.ts`) because the kernel is there; every tool result tells Claude whether the part built, plus its bounding box and volume, so it can check and fix its own work.
- `server/handler.ts` is the only server code. It adds the system prompt and tool definitions, calls the Messages API with streaming, and relays the turn.
- In the artifact build there is no server at all; `src/ai/artifact.ts` hands the same tools to Claude through the viewer's account.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # put your Anthropic API key in it
npm run dev                      # http://localhost:5173, also reachable from your phone on the same Wi-Fi
```

Everything except the chat works without a key.

## Put it on your phone (Cloudflare)

One-time setup, from a laptop:

```bash
npx wrangler login
npm run deploy                              # builds and uploads; prints your https://napkin-cad.<you>.workers.dev URL
npx wrangler secret put ANTHROPIC_API_KEY   # paste the key when asked
npx wrangler secret put APP_PASSCODE        # optional but recommended, see below
```

Or with no command line: in the Cloudflare dashboard choose Workers & Pages → Create → Import a repository, pick this repo, set the build command to `npm run build` and the deploy command to `npx wrangler deploy`, then add the two secrets under Settings → Variables and Secrets. After that every push redeploys.

Then open the URL in Safari on the iPhone and use Share → Add to Home Screen to get a full-screen app icon.

Settings (Worker secrets / variables):

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required for the chat. |
| `APP_PASSCODE` | If set, the app asks for it once before it may call Claude. Without it, anyone who finds the URL can spend your key. |
| `CLAUDE_MODEL` | Defaults to `claude-opus-5-5`. `claude-sonnet-5-5` is cheaper, `claude-fable-5-2` is the most capable. |
| `CLAUDE_EFFORT` | `low`, `medium` (default), `high`, `xhigh`, `max`. Higher thinks longer. |
| `CLAUDE_FALLBACKS` | Set to `off` to disable the server-side refusal fallback (on by default; it re-runs a turn on another model if a safety classifier declines it). |
| `ANTHROPIC_BASE_URL` | Optional alternative endpoint, e.g. a Cloudflare AI Gateway. |

## Publish it as a Claude artifact

```bash
npm run build:artifact    # writes dist-artifact/page.html, the script files, and the kernel split into two .wasm halves
```

Ask Claude Code to publish `dist-artifact/page.html` with the files listed in `dist-artifact/files.json` and the capabilities `sample` (with images) and `downloads`. In this build `src/ai/artifact.ts` replaces the server: Claude is called through the artifact runtime with the same four tools, and STEP/STL exports are saved through the viewer's save dialog as a zip (the dialog only accepts common file types).

## Tests

```bash
npm test                                   # kernel geometry, sketch recognition, and the /api endpoint against a stand-in API
npm run build && npx vite preview --port 4173 &
node tests/e2e/walkthrough.cjs             # phone-sized browser walkthrough (needs the playwright package)
```

## Not done yet

- Sketches are closed shapes (rectangle, circle, slot, polygon) with dimensions, not a constraint solver: no coincident/tangent/parallel relations, no arcs or splines by hand.
- One body per part. No patterns, mirror, draft, loft or sweep, no assemblies, no drawings.
- Fillet/chamfer/shell selections made by tapping are stored as points, so they can pick a different edge if earlier features change the shape a lot.
- The part lives in one browser's storage. No accounts, sync, or file open/save beyond STEP/STL export.
- The first load downloads the kernel (about 7 MB compressed); after that it is cached.

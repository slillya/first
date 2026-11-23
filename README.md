# Napkin CAD

Parametric CAD for an iPhone. Sketch a part with your finger, or describe it in the chat box, and Claude turns it into a real solid with an editable feature tree.

It is a web app (installable to the home screen), not a native app. The CAD kernel runs in the browser, so nothing heavy runs on a server and your laptop does not need to be on. It ships two ways from the same code:

- **As a site on Cloudflare.** A small Worker serves the app and holds your Anthropic API key. This is the real product: your own URL, a home-screen icon, full-screen.
- **As a Claude artifact.** The same app published inside Claude, where the chat uses the viewer's own Claude account. No API key and nothing to deploy; good for trying changes quickly.

## What is on screen

- **Model view** fills the screen. One finger orbits, two fingers pan and pinch-zoom. A tap selects a corner, edge or face; tapping the same spot again steps from corner to edge to face, which is how you pick a small face that is mostly edge under a fingertip.
- **Document name, top left.** Tap it for the tree. In a part: the three origin planes, then every feature in build order with edit, rename, hide and delete. In an assembly: the parts and the mates. Build errors show in red on the item that failed. **Files** at the top of the tree opens the file browser.
- **Tools, top right.** In a part: sketch planes, Extrude, Cut, Revolve, Fillet, Chamfer, Shell, Plane, views, undo/redo, STEP/STL export. In a sketch: Line, Rect, Circle, Arc, Freehand, Select, Dimension, Erase. In an assembly: Insert part and the mates.
- **Chat box, bottom.** Tap to type; sending folds it back to a pill so the keyboard gives the screen back. Claude's reply shows in a small bubble above it.
- **Context chips** above the chat box offer what fits the current selection: relations and dimensions in a sketch, Fillet/Chamfer on edges, Sketch here/Offset plane on a face or plane, mates between two picked parts.

## Sketching

Sketches are solved, SolidWorks-style: geometry carries relations and driving dimensions, and a solver moves it to satisfy them.

- **Draw** lines (drag; start on an existing point to chain), rectangles, circles and arcs. Nearly level or upright lines pick up a horizontal or vertical relation. Freehand strokes stay as ink until you send them to Claude or tap Clean up.
- **Select** by tapping, or press and hold in any tool. Up to two things can be selected.
- **Relations:** coincident (point to point, point on a line or circle, or line on line), horizontal, vertical, parallel, perpendicular, equal, tangent, concentric, midpoint, fix. Each shows as a small badge; tap a badge to select it and delete it.
- **Dimensions:** select one or two things and tap Set dimension, then type the value. Smart picks the natural one (length, diameter, radius, distance, gap between parallel lines, angle). Horizontal and Vertical control only the x or y distance between two points and leave the other direction free. Tap a dimension to change or delete it.
- **Blue** geometry can still move; **white** is fully defined. The bar says how many degrees of freedom are left and whether the profile is closed. A relation or value that contradicts the others is refused with a message.
- **Drag** blue geometry and it moves with its relations held.
- **Reference the model:** with Select, tap a corner, a straight edge, or a flat face that stands square to the sketch plane. It appears as pink reference geometry you can make things coincident with or dimension from. Every sketch also has a fixed origin point.
- Shapes inside other shapes become holes when extruded.

## Planes, files and assemblies

- **Planes.** Select an origin plane (in the tree), a plane, or a flat face and choose Offset plane, then type the distance. Two parallel faces give a midplane; three corners give a plane through them. Sketch on any of them.
- **Files.** Folders, parts and assemblies, with rename, move and delete. They are stored in this browser.
- **Assemblies.** Insert parts (the first is fixed), tap geometry on two parts, and pick a mate: coincident, concentric, parallel, perpendicular, distance, angle or lock. A solver positions the parts and reports remaining degrees of freedom. Unmated parts can be dragged. Edit part opens a component's part; the back arrow returns to the assembly, which picks up the change.

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

- A part is an ordered list of features (`src/model/schema.ts`): sketch, plane, extrude, revolve, fillet, chamfer, shell. An assembly is a list of part instances and mates. Both are plain JSON, kept in the browser's local storage through `src/model/files.ts`.
- `src/sketch/solver.ts` is the 2D constraint solver; `src/assembly/mates.ts` is the rigid-body mate solver. Both run on the phone.
- `src/kernel/evaluate.ts` builds it into B-rep geometry with [replicad](https://replicad.xyz) on OpenCascade, in a Web Worker. That is what makes real fillets, shells and STEP export possible.
- Claude edits a part through six tools (`src/ai/tools.ts`): add, update and delete features, rename the part, add shapes to a sketch, and set sketch dimensions. The tool loop runs in the browser (`src/ai/agent.ts`) because the kernel is there; every tool result tells Claude whether the part built, plus its bounding box and volume, so it can check and fix its own work.
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
npm test                                   # kernel, sketch solver, mate solver, and the /api endpoint against a stand-in API
npm run build && npx vite preview --port 4173 &
node tests/e2e/walkthrough.cjs             # phone-sized browser walkthrough (needs the playwright package)
node tests/e2e/sketching.cjs               # sketch gestures: chaining, dragging, press-and-hold, arcs, clean-up
```

## Not done yet

- Accounts, sign-in and cloud storage. Files live in one browser; there is no sync between devices yet.
- Claude edits parts only. It does not yet build assemblies or add mates.
- References to the model (in sketches, mates, and tapped fillet/shell selections) are stored by position, so they do not follow if earlier features move that geometry.
- Sketches have no trim, offset, mirror or pattern tools, no splines, and profiles must be simple closed loops.
- One body per part. No patterns, mirror, draft, loft or sweep, and no drawings.
- Dragging a mated part slides it but will not swing it about a hinge; assemblies cannot be exported as one file.
- The first load downloads the kernel (about 7 MB compressed); after that it is cached.

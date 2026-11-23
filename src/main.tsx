import { render } from "preact";
import "./app.css";
import { App } from "./ui/App";

// iOS keeps the layout viewport full height when the keyboard opens and
// scrolls the page instead. Pin the app to the visual viewport so the model
// stays in view above the keyboard and the chat box sits right on top of it.
const root = document.documentElement;
const vv = window.visualViewport;
function syncViewport() {
  root.style.setProperty("--vvh", `${vv ? vv.height : window.innerHeight}px`);
  root.style.setProperty("--vvt", `${vv ? vv.offsetTop : 0}px`);
}
syncViewport();
vv?.addEventListener("resize", syncViewport);
vv?.addEventListener("scroll", syncViewport);
window.addEventListener("resize", syncViewport);

// Safari's page-level pinch zoom would fight the model view's own pinch.
for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (e) => e.preventDefault());

render(<App />, document.getElementById("app")!);

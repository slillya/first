// Labels over the open sketch: driving dimensions (tap to type a value) and
// small badges for the geometric relations (tap to select, then delete).
import { fmt } from "../model/geom2d";
import type { Constraint, Entity, Vec2 } from "../model/schema";
import { activeSketch, cameraTick, liveSketch, mode, promptDimension, selConstraint } from "../model/store";
import { byId, pointXY } from "../sketch/build";
import { viewport } from "../view/Viewport";

const GLYPH: Record<string, string> = {
  coincident: "◉",
  horizontal: "—",
  vertical: "|",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "◠",
  concentric: "◎",
  midpoint: "◇",
  fix: "⚓",
};

const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** A representative point of an entity, and one to push a label away from. */
function anchor(e: Entity | undefined, map: Map<string, Entity>): Vec2 | null {
  if (!e) return null;
  if (e.type === "point") return [e.x, e.y];
  if (e.type === "line") return mid(pointXY(map, e.p1), pointXY(map, e.p2));
  if (e.type === "circle") {
    const c = pointXY(map, e.c);
    return [c[0] + e.r * Math.SQRT1_2, c[1] + e.r * Math.SQRT1_2];
  }
  return mid(pointXY(map, e.p1), pointXY(map, e.p2));
}

function centre(e: Entity | undefined, map: Map<string, Entity>): Vec2 | null {
  if (!e) return null;
  if (e.type === "circle" || e.type === "arc") return pointXY(map, e.c);
  return anchor(e, map);
}

/** Where a dimension's label sits, and a point to push it away from so it lands outside the shape. */
function dimLabel(c: Constraint, map: Map<string, Entity>, middle: Vec2): { at: Vec2; from: Vec2; text: string } | null {
  if (c.type === "radius" || c.type === "diameter") {
    const e = map.get(c.a);
    const ctr = centre(e, map);
    const at = anchor(e, map);
    return ctr && at ? { at, from: ctr, text: `${c.type === "radius" ? "R" : "⌀"}${fmt(c.value)}` } : null;
  }
  if (c.type === "angle") {
    const at = anchor(map.get(c.a), map);
    const other = c.b ? anchor(map.get(c.b), map) : null;
    return at ? { at: other ? mid(at, other) : at, from: middle, text: `${fmt(c.value)}°` } : null;
  }
  if (c.type !== "distance") return null;
  const prefix = c.mode === "horizontal" ? "↔ " : c.mode === "vertical" ? "↕ " : "";
  const a = map.get(c.a);
  let p: Vec2 | null;
  let q: Vec2 | null;
  if (!c.b) {
    if (a?.type !== "line") return null;
    p = pointXY(map, a.p1);
    q = pointXY(map, a.p2);
  } else {
    p = centre(a, map);
    q = centre(map.get(c.b), map);
  }
  if (!p || !q) return null;
  // One-axis dimensions sit along their own axis, below or beside the pair, so the two never share a spot.
  if (c.mode === "horizontal") {
    const y = Math.min(p[1], q[1]);
    return { at: [(p[0] + q[0]) / 2, y], from: [(p[0] + q[0]) / 2, y + 1], text: prefix + fmt(c.value) };
  }
  if (c.mode === "vertical") {
    const x = Math.max(p[0], q[0]);
    return { at: [x, (p[1] + q[1]) / 2], from: [x - 1, (p[1] + q[1]) / 2], text: prefix + fmt(c.value) };
  }
  const m = mid(p, q);
  // Step sideways off the measured span, on the side facing away from the middle of the sketch.
  const n: Vec2 = [-(q[1] - p[1]), q[0] - p[0]];
  const side = n[0] * (middle[0] - m[0]) + n[1] * (middle[1] - m[1]) > 0 ? 1 : -1;
  return { at: m, from: [m[0] + side * n[0], m[1] + side * n[1]], text: prefix + fmt(c.value) };
}

export function DimLabels() {
  cameraTick.value; // re-project whenever the camera moves
  const m = mode.value;
  const sk = activeSketch();
  const vp = viewport();
  if (m.kind !== "sketch" || !sk || !vp) return null;
  const map = byId(liveSketch.value ?? sk.entities);
  const picked = selConstraint.value;
  const drawn = [...map.values()].filter((e) => e.type === "point" && !e.fixed) as { x: number; y: number }[];
  const middle: Vec2 = drawn.length ? [drawn.reduce((t, e) => t + e.x, 0) / drawn.length, drawn.reduce((t, e) => t + e.y, 0) / drawn.length] : [0, 0];
  // Several relations on one entity fan out instead of stacking on the same spot.
  const stacked = new Map<string, number>();
  return (
    <div class="dims">
      {sk.constraints.map((c) => {
        const d = dimLabel(c, map, middle);
        if (d) {
          const at = vp.projectSketch(d.at);
          const from = vp.projectSketch(d.from);
          if (!at || !from) return null;
          const dx = at.x - from.x;
          const dy = at.y - from.y;
          const len = Math.hypot(dx, dy);
          const push = len > 1 ? 18 / len : 0;
          return (
            <button key={c.id} class={`dim ${picked === c.id ? "on" : ""}`} style={{ left: `${at.x + dx * push}px`, top: `${at.y + dy * push}px` }} onClick={() => promptDimension(c.id)}>
              {d.text}
            </button>
          );
        }
        const at = anchor(map.get(c.a), map);
        const s = at && vp.projectSketch(at);
        if (!s) return null;
        const n = stacked.get(c.a) ?? 0;
        stacked.set(c.a, n + 1);
        return (
          <button
            key={c.id}
            class={`rel ${picked === c.id ? "on" : ""}`}
            title={c.type}
            aria-label={`${c.type} relation`}
            style={{ left: `${s.x + 17 + n * 19}px`, top: `${s.y - 17}px` }}
            onClick={() => (selConstraint.value = picked === c.id ? null : c.id)}
          >
            {GLYPH[c.type] ?? "•"}
          </button>
        );
      })}
    </div>
  );
}

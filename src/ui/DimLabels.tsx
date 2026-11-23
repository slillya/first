// Tappable dimension labels over the open sketch. Tap one to type an exact value.
import { fmt } from "../model/geom2d";
import type { Profile, Vec2 } from "../model/schema";
import { activeSketch, cameraTick, mode, numPrompt, setProfiles } from "../model/store";
import { viewport } from "../view/Viewport";

interface Label {
  key: string;
  at: Vec2;
  /** Sketch point the label is pushed away from, so it sits outside the shape. */
  from: Vec2;
  text: string;
  title: string;
  fields: { key: string; label: string; value: number; min?: number }[];
  apply: (v: Record<string, number>) => Profile;
}

function labelsFor(p: Profile, i: number, selected: boolean): Label[] {
  const out: Label[] = [];
  if (p.type === "rect") {
    const a = ((p.angle ?? 0) * Math.PI) / 180;
    const u: Vec2 = [Math.cos(a), Math.sin(a)];
    const v: Vec2 = [-Math.sin(a), Math.cos(a)];
    const c: Vec2 = [p.cx, p.cy];
    out.push({
      key: `${i}w`,
      at: [p.cx - (v[0] * p.h) / 2, p.cy - (v[1] * p.h) / 2],
      from: c,
      text: fmt(p.w),
      title: "Width",
      fields: [{ key: "w", label: "Width", value: p.w, min: 0.001 }],
      apply: (x) => ({ ...p, w: x.w }),
    });
    out.push({
      key: `${i}h`,
      at: [p.cx + (u[0] * p.w) / 2, p.cy + (u[1] * p.w) / 2],
      from: c,
      text: fmt(p.h),
      title: "Height",
      fields: [{ key: "h", label: "Height", value: p.h, min: 0.001 }],
      apply: (x) => ({ ...p, h: x.h }),
    });
  } else if (p.type === "circle") {
    const k = (p.d / 2) * Math.SQRT1_2;
    out.push({
      key: `${i}d`,
      at: [p.cx + k, p.cy + k],
      from: [p.cx, p.cy],
      text: `⌀${fmt(p.d)}`,
      title: "Diameter",
      fields: [{ key: "d", label: "Diameter", value: p.d, min: 0.001 }],
      apply: (x) => ({ ...p, d: x.d }),
    });
  } else if (p.type === "slot") {
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1) || 1;
    const n: Vec2 = [-(p.y2 - p.y1) / len, (p.x2 - p.x1) / len];
    const mid: Vec2 = [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2];
    out.push({
      key: `${i}sw`,
      at: [mid[0] + (n[0] * p.w) / 2, mid[1] + (n[1] * p.w) / 2],
      from: mid,
      text: fmt(p.w),
      title: "Slot width",
      fields: [{ key: "w", label: "Width", value: p.w, min: 0.001 }],
      apply: (x) => ({ ...p, w: x.w }),
    });
  }
  if (selected && (p.type === "rect" || p.type === "circle"))
    out.push({
      key: `${i}pos`,
      at: [p.cx, p.cy],
      from: [p.cx, p.cy],
      text: `${fmt(p.cx)}, ${fmt(p.cy)}`,
      title: "Centre position",
      fields: [
        { key: "cx", label: "X", value: p.cx },
        { key: "cy", label: "Y", value: p.cy },
      ],
      apply: (x) => ({ ...p, cx: x.cx, cy: x.cy }),
    });
  return out;
}

export function DimLabels() {
  cameraTick.value; // re-project whenever the camera moves
  const m = mode.value;
  const sk = activeSketch();
  const vp = viewport();
  if (m.kind !== "sketch" || !sk || !vp) return null;
  return (
    <div class="dims">
      {sk.profiles.flatMap((p, i) =>
        labelsFor(p, i, m.selected === i).map((l) => {
          const at = vp.projectSketch(l.at);
          const from = vp.projectSketch(l.from);
          if (!at || !from) return null;
          const dx = at.x - from.x;
          const dy = at.y - from.y;
          const len = Math.hypot(dx, dy);
          const push = len > 1 ? 16 / len : 0;
          return (
            <button
              key={l.key}
              class={`dim ${m.selected === i ? "on" : ""}`}
              style={{ left: `${at.x + dx * push}px`, top: `${at.y + dy * push}px` }}
              onClick={() =>
                (numPrompt.value = {
                  title: l.title,
                  fields: l.fields,
                  onSubmit: (vals) => setProfiles(sk.profiles.map((q, k) => (k === i ? l.apply(vals) : q))),
                })
              }
            >
              {l.text}
            </button>
          );
        }),
      )}
    </div>
  );
}

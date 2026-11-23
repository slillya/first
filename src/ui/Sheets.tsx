// Cards that sit just above the chat box: feature parameters (with live
// preview), numeric entry for sketch dimensions, and the context chips.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Feature } from "../model/schema";
import {
  bodyInfo,
  cancelSheet,
  canUndo,
  cleanUpInk,
  confirmSheet,
  consumedSketches,
  activeSketch,
  doc,
  evalStatus,
  feature,
  finishSketch,
  ink,
  mode,
  numPrompt,
  preview,
  selection,
  setProfiles,
  sheet,
  showToast,
  sketchForNewFeature,
  startSketchOnFace,
  undo,
  withPatch,
} from "../model/store";
import { describeEdges, newEdgeFeature, newExtrude, newRevolve, newShell, sketchName } from "./actions";
import { Icon } from "./Icon";

function NumField(props: { label: string; value: number; unit?: string; min?: number; step?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(props.value));
  // Follow outside changes (undo, Claude) without fighting what the user is typing.
  useEffect(() => {
    if (Number(text) !== props.value) setText(String(props.value));
  }, [props.value]);
  const ok = (v: number) => Number.isFinite(v) && (props.min === undefined || v >= props.min);
  const apply = (raw: string) => {
    setText(raw);
    const v = Number(raw.replace(",", "."));
    if (raw.trim() !== "" && ok(v)) props.onChange(v);
  };
  const nudge = (dir: number) => {
    const step = props.step ?? (Math.abs(props.value) < 5 ? 0.5 : 1);
    const v = Math.round((props.value + dir * step) * 1000) / 1000;
    if (ok(v)) apply(String(v));
  };
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <span class="stepper">
        <button type="button" aria-label="Decrease" onClick={() => nudge(-1)}>
          −
        </button>
        <input type="text" inputMode="decimal" enterkeyhint="done" value={text} onInput={(e) => apply(e.currentTarget.value)} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" aria-label="Increase" onClick={() => nudge(1)}>
          +
        </button>
      </span>
      <span class="unit">{props.unit ?? "mm"}</span>
    </label>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <span class="segmented">
        {props.options.map(([v, label]) => (
          <button key={v} type="button" class={v === props.value ? "on" : ""} onClick={() => props.onChange(v)}>
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}

function Card(props: { title: string; icon?: string; onOk: () => void; onCancel: () => void; children: ComponentChildren; error?: string }) {
  return (
    <form
      class="card"
      onSubmit={(e) => {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        props.onOk();
      }}
    >
      <header>
        {props.icon && <Icon name={props.icon} size={18} />}
        <strong>{props.title}</strong>
        <button type="button" class="round" aria-label="Cancel" onClick={props.onCancel}>
          <Icon name="close" size={18} />
        </button>
        <button type="submit" class="round primary" aria-label="OK">
          <Icon name="check" size={18} />
        </button>
      </header>
      {props.children}
      {props.error && <p class="card-error">{props.error}</p>}
    </form>
  );
}

function ParamSheet({ f }: { f: Feature }) {
  const set = (patch: Partial<Feature>) => void preview(withPatch(doc.value, f.id, patch));
  const status = evalStatus.value[f.id];
  const body = (() => {
    switch (f.type) {
      case "extrude":
        return (
          <>
            <Segmented label="Mode" value={f.op} options={[["add", "Add"], ["cut", "Cut"]]} onChange={(op) => set({ op })} />
            {!(f.op === "cut" && f.throughAll) && <NumField label="Distance" value={f.distance} min={0.001} onChange={(distance) => set({ distance })} />}
            {f.op === "cut" && (
              <Segmented
                label="Depth"
                value={f.throughAll ? "all" : "blind"}
                options={[["all", "Through all"], ["blind", "To depth"]]}
                onChange={(v) => set({ throughAll: v === "all" })}
              />
            )}
            <Segmented
              label="Direction"
              value={f.direction ?? "auto"}
              options={[["auto", "Auto"], ["normal", "Out"], ["reverse", "Flip"], ["symmetric", "Both"]]}
              onChange={(direction) => set({ direction })}
            />
          </>
        );
      case "revolve":
        return (
          <>
            <Segmented label="Mode" value={f.op} options={[["add", "Add"], ["cut", "Cut"]]} onChange={(op) => set({ op })} />
            <Segmented label="Axis" value={f.axis} options={[["x", "Sketch X"], ["y", "Sketch Y"]]} onChange={(axis) => set({ axis })} />
            <NumField label="Axis offset" value={f.axisOffset ?? 0} onChange={(axisOffset) => set({ axisOffset })} />
            <NumField label="Angle" unit="°" value={f.angle ?? 360} min={0.001} step={15} onChange={(angle) => set({ angle: Math.min(360, angle) })} />
          </>
        );
      case "fillet":
        return (
          <>
            <NumField label="Radius" value={f.radius} min={0.001} onChange={(radius) => set({ radius })} />
            <p class="muted">{describeEdges(f.edges)}</p>
          </>
        );
      case "chamfer":
        return (
          <>
            <NumField label="Distance" value={f.distance} min={0.001} onChange={(distance) => set({ distance })} />
            <p class="muted">{describeEdges(f.edges)}</p>
          </>
        );
      case "shell":
        return <NumField label="Wall" value={f.thickness} min={0.001} onChange={(thickness) => set({ thickness })} />;
      default:
        return null;
    }
  })();
  return (
    <Card title={f.name ?? f.id} icon={f.type} onOk={confirmSheet} onCancel={cancelSheet} error={status && !status.ok ? status.error : undefined}>
      {body}
    </Card>
  );
}

function NumPromptSheet() {
  const p = numPrompt.value!;
  const [vals, setVals] = useState<Record<string, number>>(Object.fromEntries(p.fields.map((f) => [f.key, f.value])));
  return (
    <Card
      title={p.title}
      onOk={() => {
        numPrompt.value = null;
        p.onSubmit(vals);
      }}
      onCancel={() => (numPrompt.value = null)}
    >
      {p.fields.map((f) => (
        <NumField key={f.key} label={f.label} value={vals[f.key]} min={f.min} onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))} />
      ))}
    </Card>
  );
}

function Chip(props: { icon?: string; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button class={`chip ${props.primary ? "primary" : ""}`} onClick={props.onClick}>
      {props.icon && <Icon name={props.icon} size={16} />}
      {props.label}
    </button>
  );
}

const SKETCH_HINT: Record<string, string> = {
  ink: "Draw with one finger, then send to Claude or tap Clean up",
  line: "Tap corners; tap the first one again to close",
  rect: "Drag corner to corner",
  circle: "Drag out from the centre",
  select: "Tap a shape to edit it, drag to move",
  erase: "Tap a shape or stroke to remove it",
};

function ContextBar() {
  const m = mode.value;
  const sel = selection.value;
  if (m.kind === "sketch") {
    const sk = activeSketch();
    const hasInk = ink.value.length > 0;
    return (
      <div class="context">
        <p class="context-hint">{SKETCH_HINT[m.tool]}</p>
        <div class="chips">
          {hasInk && (
            <Chip
              icon="wand"
              label="Clean up"
              onClick={() => {
                const left = cleanUpInk();
                if (left) showToast(`${left} stroke${left > 1 ? "s" : ""} left as ink. Send to Claude to interpret.`);
              }}
            />
          )}
          {m.selected !== null && sk && (
            <Chip icon="trash" label="Delete shape" onClick={() => setProfiles(sk.profiles.filter((_, i) => i !== m.selected))} />
          )}
          {canUndo.value && <Chip icon="undo" label="Undo" onClick={undo} />}
          <Chip icon="check" label="Done" primary onClick={finishSketch} />
        </div>
      </div>
    );
  }
  const clear = () => (selection.value = { faces: [], edges: [] });
  if (sel.edges.length)
    return (
      <div class="context">
        <div class="chips">
          <span class="chip-label">
            {sel.edges.length} edge{sel.edges.length > 1 ? "s" : ""}
          </span>
          <Chip icon="fillet" label="Fillet" primary onClick={() => newEdgeFeature("fillet")} />
          <Chip icon="chamfer" label="Chamfer" onClick={() => newEdgeFeature("chamfer")} />
          <Chip icon="close" label="Clear" onClick={clear} />
        </div>
      </div>
    );
  if (sel.faces.length) {
    const one = sel.faces.length === 1 ? sel.faces[0] : null;
    return (
      <div class="context">
        <div class="chips">
          {one?.planar && <Chip icon="sketch" label="Sketch here" primary onClick={() => startSketchOnFace(one)} />}
          <Chip icon="shell" label="Shell" onClick={newShell} />
          {one?.planar && <Chip icon="fillet" label="Fillet rim" onClick={() => newEdgeFeature("fillet")} />}
          <Chip icon="close" label="Clear" onClick={clear} />
        </div>
      </div>
    );
  }
  const next = sketchForNewFeature();
  if (next && !consumedSketches(doc.value).has(next))
    return (
      <div class="context">
        <div class="chips">
          <span class="chip-label">{sketchName(next)}</span>
          <Chip icon="extrude" label="Extrude" primary onClick={() => newExtrude("add")} />
          {bodyInfo.value && <Chip icon="cut" label="Cut" onClick={() => newExtrude("cut")} />}
          <Chip icon="revolve" label="Revolve" onClick={newRevolve} />
        </div>
      </div>
    );
  return null;
}

/** Whichever card applies right now; at most one shows at a time. */
export function BottomCard() {
  if (numPrompt.value) return <NumPromptSheet key={numPrompt.value.title} />;
  const s = sheet.value;
  const f = s ? feature(s.featureId) : null;
  if (f) return <ParamSheet key={f.id} f={f} />;
  return <ContextBar />;
}

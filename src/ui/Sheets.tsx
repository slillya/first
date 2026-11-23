// Cards that sit just above the chat box: feature parameters (with live
// preview), numeric entry for dimensions and mates, and the context chips for
// whatever is selected.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Feature, MateType } from "../model/schema";
import {
  activeSketch,
  addDimension,
  addMate,
  addRelation,
  asm,
  asmInfo,
  asmSel,
  bodyInfo,
  cancelSheet,
  canUndo,
  cleanUpInk,
  clearSelection,
  confirmSheet,
  consumedSketches,
  deleteConstraint,
  deleteSketchSelection,
  dimMode,
  doc,
  evalStatus,
  feature,
  filesOpen,
  finishSketch,
  ink,
  mode,
  numPrompt,
  preview,
  selConstraint,
  selectedPlane,
  selection,
  sheet,
  showToast,
  sketchForNewFeature,
  sketchInfo,
  sketchSel,
  startSketchOnFace,
  toggleConstruction,
  undo,
  withPatch,
} from "../model/store";
import { relationsFor, type DimMode, type RelationType } from "../sketch/build";
import { describeEdges, matesFor, newEdgeFeature, newExtrude, newPlane, newRevolve, newShell, sketchName, sketchOnSelectedPlane } from "./actions";
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
    <div class="field">
      <span class="field-label">{props.label}</span>
      <span class="stepper">
        <button type="button" aria-label="Decrease" onClick={() => nudge(-1)}>
          −
        </button>
        <input type="text" inputMode="decimal" enterkeyhint="done" aria-label={props.label} value={text} onInput={(e) => apply(e.currentTarget.value)} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" aria-label="Increase" onClick={() => nudge(1)}>
          +
        </button>
      </span>
      <span class="unit">{props.unit ?? "mm"}</span>
    </div>
  );
}

function Segmented<T extends string>(props: { label?: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="field">
      {props.label && <span class="field-label">{props.label}</span>}
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

function Card(props: { title: string; icon?: string; onOk: () => void; onCancel: () => void; onDelete?: () => void; children: ComponentChildren; error?: string }) {
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
        {props.onDelete && (
          <button type="button" class="round danger" aria-label="Delete" onClick={props.onDelete}>
            <Icon name="trash" size={17} />
          </button>
        )}
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
              <Segmented label="Depth" value={f.throughAll ? "all" : "blind"} options={[["all", "Through all"], ["blind", "To depth"]]} onChange={(v) => set({ throughAll: v === "all" })} />
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
      case "plane": {
        const def = f.def;
        if (def.kind === "offset")
          return (
            <>
              <NumField label="Distance" value={def.distance} onChange={(distance) => set({ def: { ...def, distance } } as Partial<Feature>)} />
              <p class="muted">Offset from the source plane along its normal. Negative goes the other way.</p>
            </>
          );
        return <p class="muted">{def.kind === "points" ? "Through three picked corners" : "Halfway between two parallel faces"}</p>;
      }
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
  const close = () => {
    numPrompt.value = null;
    selConstraint.value = null;
  };
  return (
    <Card
      title={p.title}
      onOk={() => {
        numPrompt.value = null;
        p.onSubmit(vals);
      }}
      onCancel={close}
      onDelete={p.onDelete}
    >
      {p.fields.map((f) => (
        <NumField key={f.key} label={f.label} value={vals[f.key]} min={f.min} unit={f.unit} onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))} />
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
  select: "Tap to select, drag to move. Tap the model to reference it.",
  line: "Drag to draw a line. Start on a point to chain.",
  rect: "Drag corner to corner",
  circle: "Drag out from the centre",
  arc: "Drag from one end to the other, then drag the centre to shape it",
  ink: "Draw freehand, then send to Claude or tap Clean up",
  dim: "Tap one or two things, then Set dimension",
  erase: "Tap a line, point or stroke to remove it",
};

const RELATION: Record<RelationType, { label: string; icon: string }> = {
  coincident: { label: "Coincident", icon: "coincident" },
  horizontal: { label: "Horizontal", icon: "horizontal" },
  vertical: { label: "Vertical", icon: "vertical" },
  parallel: { label: "Parallel", icon: "parallel" },
  perpendicular: { label: "Perpendicular", icon: "perpendicular" },
  equal: { label: "Equal", icon: "equal" },
  tangent: { label: "Tangent", icon: "tangent" },
  concentric: { label: "Concentric", icon: "concentric" },
  midpoint: { label: "Midpoint", icon: "midpoint" },
  fix: { label: "Fix", icon: "fix" },
};

function SketchBar() {
  const m = mode.value;
  const sk = activeSketch();
  const info = sketchInfo.value;
  if (m.kind !== "sketch" || !sk) return null;
  const sel = sketchSel.value;
  const hasInk = ink.value.length > 0;
  const picked = selConstraint.value;
  const drawn = sk.entities.some((e) => e.id !== "origin");
  const state = !info
    ? ""
    : !info.ok
      ? "Over defined"
      : info.dof === 0 && drawn
        ? "Fully defined"
        : drawn
          ? `Under defined · ${info.dof} free`
          : "";
  const shape = info && info.curves > 0 ? (info.open ? " · open profile" : info.loops ? ` · ${info.loops} closed` : "") : "";
  const relations = relationsFor(sk.entities, sel);
  const curves = sel.some((id) => {
    const e = sk.entities.find((x) => x.id === id);
    return e && e.type !== "point" && !(e.type === "line" && e.ref);
  });
  return (
    <div class="context stretch">
      <p class="context-hint">
        <span class={`state ${info && !info.ok ? "err" : info?.dof === 0 && drawn ? "good" : ""}`}>{state}</span>
        {shape}
        {!sel.length && !picked && <span class="hint-text">{state ? " — " : ""}{SKETCH_HINT[m.tool]}</span>}
      </p>
      {(m.tool === "dim" || sel.length > 0) && (
        <div class="dim-row">
          <span class="segmented small" role="group" aria-label="Dimension type">
            {(["smart", "horizontal", "vertical"] as DimMode[]).map((d) => (
              <button key={d} type="button" class={dimMode.value === d ? "on" : ""} onClick={() => (dimMode.value = d)}>
                {d === "smart" ? "Smart" : d === "horizontal" ? "Horizontal" : "Vertical"}
              </button>
            ))}
          </span>
        </div>
      )}
      <div class="chips">
        {(m.tool === "dim" || sel.length > 0) && (
          <Chip icon="dim" label="Set dimension" primary onClick={() => (sel.length ? addDimension() : showToast("Tap a line, a circle, or two things first"))} />
        )}
        {relations.map((r) => (
          <Chip key={r} icon={RELATION[r].icon} label={RELATION[r].label} onClick={() => addRelation(r)} />
        ))}
        {curves && <Chip icon="construction" label="Construction" onClick={toggleConstruction} />}
        {sel.length > 0 && <Chip icon="trash" label="Delete" onClick={deleteSketchSelection} />}
        {picked && <Chip icon="trash" label="Delete relation" onClick={() => deleteConstraint(picked)} />}
        {!sel.length && hasInk && (
          <Chip
            icon="wand"
            label="Clean up"
            onClick={() => {
              const left = cleanUpInk();
              if (left) showToast(`${left} stroke${left > 1 ? "s" : ""} left as ink. Send to Claude to interpret.`);
            }}
          />
        )}
        {!sel.length && canUndo.value && <Chip icon="undo" label="Undo" onClick={undo} />}
        {!sel.length && <Chip icon="check" label="Done" primary onClick={finishSketch} />}
      </div>
    </div>
  );
}

const MATE: Record<MateType, { label: string; icon: string }> = {
  coincident: { label: "Coincident", icon: "coincident" },
  concentric: { label: "Concentric", icon: "concentric" },
  parallel: { label: "Parallel", icon: "parallel" },
  perpendicular: { label: "Perpendicular", icon: "perpendicular" },
  distance: { label: "Distance", icon: "dim" },
  angle: { label: "Angle", icon: "angle" },
  lock: { label: "Lock", icon: "fix" },
};

function AssemblyBar() {
  const a = asm.value!;
  const picks = asmSel.value;
  const info = asmInfo.value;
  if (!a.components.length)
    return (
      <div class="context">
        <div class="chips">
          <Chip icon="plus" label="Insert a part" primary onClick={() => (filesOpen.value = "insert")} />
        </div>
      </div>
    );
  if (!picks.length) {
    const free = a.components.some((c) => !c.fixed) && info.dof > 0;
    return (
      <div class="context">
        <p class="context-hint">{free ? `${info.dof} free · tap a face, edge or corner on two parts to mate them` : "Fully constrained"}</p>
      </div>
    );
  }
  const kind = (p: (typeof picks)[number]) => (p.what === "vertex" ? "corner" : p.what === "edge" ? "edge" : p.ref.type === "plane" ? "flat face" : "round face");
  const picked = picks.map(kind).join(" + ");
  const two = picks.length === 2 && picks[0].component !== picks[1].component;
  const options = two ? matesFor(picks[0].ref.type, picks[1].ref.type) : [];
  return (
    <div class="context stretch">
      <p class="context-hint">
        <span class="state">{picked}</span>
        {two ? " — choose a mate" : picks.length === 2 ? " — pick geometry on two different parts" : " — now pick on another part. Tap again to switch between edge and face."}
      </p>
      <div class="chips">
        {options.map((t, i) => (
          <Chip key={t} icon={MATE[t].icon} label={MATE[t].label} primary={i === 0} onClick={() => addMate(t)} />
        ))}
        {two && <Chip icon="fix" label="Lock" onClick={() => addMate("lock")} />}
        <Chip icon="close" label="Clear" onClick={() => (asmSel.value = [])} />
      </div>
    </div>
  );
}

function ContextBar() {
  if (asm.value) return <AssemblyBar />;
  if (mode.value.kind === "sketch") return <SketchBar />;
  const sel = selection.value;
  if (sel.vertices.length)
    return (
      <div class="context">
        <div class="chips">
          <span class="chip-label">
            {sel.vertices.length} corner{sel.vertices.length > 1 ? "s" : ""}
          </span>
          {sel.vertices.length === 3 ? <Chip icon="plane" label="Plane through these" primary onClick={newPlane} /> : <span class="chip-label">pick 3 for a plane</span>}
          <Chip icon="close" label="Clear" onClick={clearSelection} />
        </div>
      </div>
    );
  if (sel.edges.length)
    return (
      <div class="context">
        <div class="chips">
          <span class="chip-label">
            {sel.edges.length} edge{sel.edges.length > 1 ? "s" : ""}
          </span>
          <Chip icon="fillet" label="Fillet" primary onClick={() => newEdgeFeature("fillet")} />
          <Chip icon="chamfer" label="Chamfer" onClick={() => newEdgeFeature("chamfer")} />
          <Chip icon="close" label="Clear" onClick={clearSelection} />
        </div>
      </div>
    );
  if (sel.faces.length) {
    const one = sel.faces.length === 1 ? sel.faces[0] : null;
    const flat = sel.faces.filter((f) => f.planar).length;
    return (
      <div class="context">
        <div class="chips">
          {one?.planar && <Chip icon="sketch" label="Sketch here" primary onClick={() => startSketchOnFace(one)} />}
          {one?.planar && <Chip icon="plane" label="Offset plane" onClick={newPlane} />}
          {flat === 2 && sel.faces.length === 2 && <Chip icon="plane" label="Midplane" primary onClick={newPlane} />}
          <Chip icon="shell" label="Shell" onClick={newShell} />
          {one?.planar && <Chip icon="fillet" label="Fillet rim" onClick={() => newEdgeFeature("fillet")} />}
          <Chip icon="close" label="Clear" onClick={clearSelection} />
        </div>
      </div>
    );
  }
  const plane = selectedPlane();
  if (plane)
    return (
      <div class="context">
        <div class="chips">
          <span class="chip-label">{plane.name}</span>
          <Chip icon="sketch" label="Sketch here" primary onClick={sketchOnSelectedPlane} />
          <Chip icon="plane" label="Offset plane" onClick={newPlane} />
        </div>
      </div>
    );
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
  if (numPrompt.value) return <NumPromptSheet key={numPrompt.value.title + (selConstraint.value ?? "")} />;
  const s = sheet.value;
  const f = s ? feature(s.featureId) : null;
  if (f) return <ParamSheet key={f.id} f={f} />;
  return <ContextBar />;
}

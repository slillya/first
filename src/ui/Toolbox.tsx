// Top-right bubble: sketch, feature, view and file tools. While a sketch is
// open it switches to drawing tools and its pill shows the active one; in an
// assembly it offers parts and mates.
import type { ComponentChildren } from "preact";
import type { MateType } from "../model/schema";
import {
  addMate,
  asm,
  canRedo,
  canUndo,
  cleanUpInk,
  filesOpen,
  finishSketch,
  ink,
  mode,
  redo,
  selection,
  setTool,
  showToast,
  startSketch,
  startSketchOnFace,
  toolsOpen,
  treeOpen,
  undo,
  type SketchTool,
} from "../model/store";
import { viewport, type StandardView } from "../view/Viewport";
import { exportPart, newEdgeFeature, newExtrude, newPlane, newRevolve, newShell } from "./actions";
import { Icon } from "./Icon";

const SKETCH_TOOLS: { tool: SketchTool; icon: string; label: string }[] = [
  { tool: "line", icon: "line", label: "Line" },
  { tool: "rect", icon: "rect", label: "Rect" },
  { tool: "circle", icon: "circle", label: "Circle" },
  { tool: "arc", icon: "arc", label: "Arc" },
  { tool: "ink", icon: "ink", label: "Freehand" },
  { tool: "select", icon: "select", label: "Select" },
  { tool: "dim", icon: "dim", label: "Dimension" },
  { tool: "erase", icon: "erase", label: "Erase" },
];

const MATES: { type: MateType; icon: string; label: string }[] = [
  { type: "coincident", icon: "coincident", label: "Coincident" },
  { type: "concentric", icon: "concentric", label: "Concentric" },
  { type: "distance", icon: "dim", label: "Distance" },
  { type: "parallel", icon: "parallel", label: "Parallel" },
  { type: "perpendicular", icon: "perpendicular", label: "Perp." },
  { type: "angle", icon: "angle", label: "Angle" },
  { type: "lock", icon: "lock", label: "Lock" },
];

function Tool(props: { icon: string; label: string; onClick: () => void; active?: boolean; disabled?: boolean; keepOpen?: boolean }) {
  return (
    <button
      class={`tool ${props.active ? "active" : ""}`}
      disabled={props.disabled}
      onClick={() => {
        if (!props.keepOpen) toolsOpen.value = false;
        props.onClick();
      }}
    >
      <Icon name={props.icon} size={22} />
      <span>{props.label}</span>
    </button>
  );
}

function Section({ title, children, five }: { title: string; children: ComponentChildren; five?: boolean }) {
  return (
    <section>
      <h3>{title}</h3>
      <div class={`tool-grid ${five ? "five" : ""}`}>{children}</div>
    </section>
  );
}

const view = (v: StandardView) => () => viewport()?.setView(v);

function ViewSection() {
  return (
    <Section title="View" five>
      <Tool icon="fit" label="Fit" onClick={() => viewport()?.fit()} />
      <Tool icon="cube" label="Iso" onClick={view("iso")} />
      <Tool icon="cube" label="Top" onClick={view("top")} />
      <Tool icon="cube" label="Front" onClick={view("front")} />
      <Tool icon="cube" label="Right" onClick={view("right")} />
    </Section>
  );
}

export function Toolbox() {
  const open = toolsOpen.value;
  const m = mode.value;
  const sketching = m.kind === "sketch";
  const assembly = !!asm.value;
  const current = sketching ? SKETCH_TOOLS.find((t) => t.tool === m.tool) : null;
  const faces = selection.value.faces;
  const planarFace = faces.length === 1 && faces[0].planar ? faces[0] : null;

  return (
    <div class={`bubble tools ${open ? "open" : ""}`}>
      <button
        class="pill"
        aria-expanded={open}
        onClick={() => {
          toolsOpen.value = !open;
          treeOpen.value = false;
          filesOpen.value = false;
        }}
      >
        <Icon name={current?.icon ?? "tools"} size={18} />
        <span class="pill-title">{current?.label ?? "Tools"}</span>
        <Icon name="chevron" size={18} class={open ? "flip" : ""} />
      </button>
      {open && (
        <div class="panel">
          {sketching ? (
            <>
              <Section title="Draw">
                {SKETCH_TOOLS.slice(0, 5).map((t) => (
                  <Tool key={t.tool} icon={t.icon} label={t.label} active={m.tool === t.tool} onClick={() => setTool(t.tool)} />
                ))}
              </Section>
              <Section title="Define">
                {SKETCH_TOOLS.slice(5).map((t) => (
                  <Tool key={t.tool} icon={t.icon} label={t.label} active={m.tool === t.tool} onClick={() => setTool(t.tool)} />
                ))}
                <Tool
                  icon="wand"
                  label="Clean up"
                  disabled={!ink.value.length}
                  onClick={() => {
                    const left = cleanUpInk();
                    if (left) showToast(`${left} stroke${left > 1 ? "s" : ""} left as ink. Send to Claude to interpret.`);
                  }}
                />
                <Tool icon="fit" label="Fit" onClick={() => viewport()?.fit()} />
                <Tool icon="undo" label="Undo" disabled={!canUndo.value} keepOpen onClick={undo} />
                <Tool icon="redo" label="Redo" disabled={!canRedo.value} keepOpen onClick={redo} />
              </Section>
              <button class="wide primary" onClick={finishSketch}>
                <Icon name="check" size={18} /> Finish sketch
              </button>
            </>
          ) : assembly ? (
            <>
              <Section title="Assembly">
                <Tool icon="plus" label="Insert part" onClick={() => (filesOpen.value = "insert")} />
                <Tool icon="undo" label="Undo" disabled={!canUndo.value} keepOpen onClick={undo} />
                <Tool icon="redo" label="Redo" disabled={!canRedo.value} keepOpen onClick={redo} />
              </Section>
              <Section title="Mate the two picked">
                {MATES.map((t) => (
                  <Tool key={t.type} icon={t.icon} label={t.label} onClick={() => addMate(t.type)} />
                ))}
              </Section>
              <ViewSection />
            </>
          ) : (
            <>
              <Section title="Sketch on">
                <Tool icon="plane" label="Top" onClick={() => startSketch({ base: "XY" })} />
                <Tool icon="plane" label="Front" onClick={() => startSketch({ base: "XZ" })} />
                <Tool icon="plane" label="Right" onClick={() => startSketch({ base: "YZ" })} />
                <Tool icon="face" label="Face" onClick={() => (planarFace ? startSketchOnFace(planarFace) : showToast("Tap a flat face on the part first"))} />
              </Section>
              <Section title="Features">
                <Tool icon="extrude" label="Extrude" onClick={() => newExtrude("add")} />
                <Tool icon="cut" label="Cut" onClick={() => newExtrude("cut")} />
                <Tool icon="revolve" label="Revolve" onClick={newRevolve} />
                <Tool icon="fillet" label="Fillet" onClick={() => newEdgeFeature("fillet")} />
                <Tool icon="chamfer" label="Chamfer" onClick={() => newEdgeFeature("chamfer")} />
                <Tool icon="shell" label="Shell" onClick={newShell} />
                <Tool icon="plane" label="Plane" onClick={newPlane} />
                <Tool icon="undo" label="Undo" disabled={!canUndo.value} keepOpen onClick={undo} />
              </Section>
              <ViewSection />
              <Section title="Part">
                <Tool icon="download" label="STEP" onClick={() => void exportPart("step")} />
                <Tool icon="download" label="STL" onClick={() => void exportPart("stl")} />
                <Tool icon="redo" label="Redo" disabled={!canRedo.value} keepOpen onClick={redo} />
                <Tool icon="files" label="Files" onClick={() => (filesOpen.value = "browse")} />
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

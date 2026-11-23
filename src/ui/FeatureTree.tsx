// Top-left bubble: the part name, expanding into the chronological feature list.
import { useState } from "preact/hooks";
import { fmt } from "../model/geom2d";
import type { Feature } from "../model/schema";
import {
  bodyInfo,
  commit,
  doc,
  editSketch,
  evalStatus,
  kernelPhase,
  mode,
  openSheet,
  toolsOpen,
  treeOpen,
  treeSelected,
  withoutFeature,
  withPatch,
} from "../model/store";
import { FEATURE_ICON, Icon } from "./Icon";

function Row({ f }: { f: Feature }) {
  const status = evalStatus.value[f.id];
  const selected = treeSelected.value === f.id;
  const editing = mode.value.kind === "sketch" && mode.value.sketchId === f.id;
  const [renaming, setRenaming] = useState(false);
  const failed = status && !status.ok;

  const rename = (name: string) => {
    setRenaming(false);
    const clean = name.trim().slice(0, 60);
    if (clean && clean !== f.name) void commit(withPatch(doc.value, f.id, { name: clean }));
  };

  return (
    <li class={`row ${selected ? "selected" : ""} ${f.suppressed ? "suppressed" : ""}`}>
      <button class="row-main" onClick={() => (treeSelected.value = selected ? null : f.id)}>
        <Icon name={FEATURE_ICON[f.type]} size={17} />
        {renaming ? (
          <input
            class="rename"
            defaultValue={f.name}
            ref={(el) => el?.focus()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => rename(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        ) : (
          <span class="row-name">{f.name ?? f.id}</span>
        )}
        {editing && <span class="tag">editing</span>}
        {failed && <Icon name="warn" size={15} class="err" />}
      </button>
      {failed && <p class="row-error">{status.error}</p>}
      {selected && (
        <div class="row-actions">
          <button
            onClick={() => {
              treeOpen.value = false;
              if (f.type === "sketch") editSketch(f.id);
              else openSheet(f.id, false);
            }}
          >
            <Icon name="edit" size={16} /> Edit
          </button>
          <button onClick={() => setRenaming(true)}>Rename</button>
          <button onClick={() => void commit(withPatch(doc.value, f.id, { suppressed: !f.suppressed }))}>
            <Icon name={f.suppressed ? "eye" : "eyeOff"} size={16} /> {f.suppressed ? "Show" : "Hide"}
          </button>
          <button
            class="danger"
            aria-label="Delete"
            onClick={() => {
              treeSelected.value = null;
              void commit(withoutFeature(doc.value, f.id));
            }}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      )}
    </li>
  );
}

export function FeatureTree() {
  const open = treeOpen.value;
  const d = doc.value;
  const status = evalStatus.value;
  const errors = d.features.filter((f) => status[f.id] && !status[f.id].ok).length;
  const body = bodyInfo.value;
  const [renaming, setRenaming] = useState(false);

  return (
    <div class={`bubble tree ${open ? "open" : ""}`}>
      <button
        class="pill"
        aria-expanded={open}
        onClick={() => {
          treeOpen.value = !open;
          toolsOpen.value = false;
        }}
      >
        <span class="pill-title">{d.name}</span>
        {kernelPhase.value === "busy" && <span class="spinner small" />}
        {errors > 0 && <span class="badge err">{errors}</span>}
        <Icon name="chevron" size={18} class={open ? "flip" : ""} />
      </button>
      {open && (
        <div class="panel">
          <div class="panel-head">
            {renaming ? (
              <input
                class="rename"
                defaultValue={d.name}
                ref={(el) => el?.focus()}
                onBlur={(e) => {
                  setRenaming(false);
                  const name = e.currentTarget.value.trim().slice(0, 60);
                  if (name && name !== d.name) void commit({ ...d, name });
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            ) : (
              <button class="link" onClick={() => setRenaming(true)}>
                Rename part
              </button>
            )}
            <span class="muted">{d.features.length} features</span>
          </div>
          {d.features.length === 0 ? (
            <p class="hint">Nothing here yet. Start a sketch from Tools, or describe the part to Claude below.</p>
          ) : (
            <ul class="rows">
              {d.features.map((f) => (
                <Row key={f.id} f={f} />
              ))}
            </ul>
          )}
          {body && (
            <div class="panel-foot">
              {fmt(body.bbox.max[0] - body.bbox.min[0])} × {fmt(body.bbox.max[1] - body.bbox.min[1])} ×{" "}
              {fmt(body.bbox.max[2] - body.bbox.min[2])} mm · {fmt(body.volume / 1000)} cm³
            </div>
          )}
        </div>
      )}
    </div>
  );
}

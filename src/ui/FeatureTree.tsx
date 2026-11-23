// Top-left bubble: the document name, expanding into the feature tree of a
// part (origin planes, then features in build order) or the components and
// mates of an assembly.
import { useState } from "preact/hooks";
import { files } from "../model/files";
import { fmt } from "../model/geom2d";
import type { Component, Feature, Mate } from "../model/schema";
import {
  asm,
  asmInfo,
  BASE_PLANES,
  bodyInfo,
  commit,
  deleteComponent,
  deleteMate,
  doc,
  editSketch,
  evalStatus,
  filesOpen,
  goBack,
  kernelPhase,
  mode,
  openComponentPart,
  openSheet,
  patchComponent,
  patchMate,
  promptMate,
  returnTo,
  toolsOpen,
  treeOpen,
  treeSelected,
  withoutFeature,
  withPatch,
} from "../model/store";
import { newPlane, sketchOnSelectedPlane } from "./actions";
import { FEATURE_ICON, Icon } from "./Icon";

function Rename({ value, onDone }: { value: string; onDone: (name: string) => void }) {
  return (
    <input
      class="rename"
      defaultValue={value}
      ref={(el) => el?.focus()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.currentTarget.value.trim().slice(0, 60))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

function PlaneRow({ id, name }: { id: string; name: string }) {
  const selected = treeSelected.value === id;
  return (
    <li class={`row quiet ${selected ? "selected" : ""}`}>
      <button class="row-main" onClick={() => (treeSelected.value = selected ? null : id)}>
        <Icon name="plane" size={17} />
        <span class="row-name">{name}</span>
      </button>
      {selected && (
        <div class="row-actions">
          <button onClick={sketchOnSelectedPlane}>
            <Icon name="sketch" size={16} /> Sketch
          </button>
          <button onClick={newPlane}>
            <Icon name="plane" size={16} /> Offset plane
          </button>
        </div>
      )}
    </li>
  );
}

function Row({ f }: { f: Feature }) {
  const status = evalStatus.value[f.id];
  const selected = treeSelected.value === f.id;
  const editing = mode.value.kind === "sketch" && mode.value.sketchId === f.id;
  const [renaming, setRenaming] = useState(false);
  const failed = status && !status.ok;

  return (
    <li class={`row ${selected ? "selected" : ""} ${f.suppressed ? "suppressed" : ""}`}>
      <button class="row-main" onClick={() => (treeSelected.value = selected ? null : f.id)}>
        <Icon name={FEATURE_ICON[f.type]} size={17} />
        {renaming ? (
          <Rename
            value={f.name ?? f.id}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== f.name) void commit(withPatch(doc.value, f.id, { name }));
            }}
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
          {f.type === "plane" && (
            <button onClick={sketchOnSelectedPlane}>
              <Icon name="sketch" size={16} /> Sketch
            </button>
          )}
          <button onClick={() => setRenaming(true)}>Rename</button>
          <button aria-label={f.suppressed ? "Show" : "Hide"} onClick={() => void commit(withPatch(doc.value, f.id, { suppressed: !f.suppressed }))}>
            <Icon name={f.suppressed ? "eye" : "eyeOff"} size={16} />
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

function ComponentRow({ c }: { c: Component }) {
  const selected = treeSelected.value === c.id;
  const missing = !files.value.some((f) => f.id === c.part);
  return (
    <li class={`row ${selected ? "selected" : ""}`}>
      <button class="row-main" onClick={() => (treeSelected.value = selected ? null : c.id)}>
        <Icon name="part" size={17} />
        <span class="row-name">{c.name}</span>
        {c.fixed && <span class="tag muted-tag">fixed</span>}
        {missing && <Icon name="warn" size={15} class="err" />}
      </button>
      {missing && <p class="row-error">The part file was deleted</p>}
      {selected && (
        <div class="row-actions">
          {!missing && (
            <button onClick={() => openComponentPart(c.id)}>
              <Icon name="edit" size={16} /> Edit part
            </button>
          )}
          <button onClick={() => patchComponent(c.id, { fixed: !c.fixed })}>
            <Icon name="lock" size={16} /> {c.fixed ? "Float" : "Fix"}
          </button>
          <button
            class="danger"
            aria-label="Delete"
            onClick={() => {
              treeSelected.value = null;
              deleteComponent(c.id);
            }}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      )}
    </li>
  );
}

function MateRow({ m }: { m: Mate }) {
  const selected = treeSelected.value === m.id;
  const status = asmInfo.value.mates[m.id];
  const failed = !m.suppressed && status && !status.ok;
  const valued = m.type === "distance" || m.type === "angle";
  const flippable = m.a.ref.type === "plane" && m.b.ref.type === "plane" && m.type !== "perpendicular" && m.type !== "lock";
  return (
    <li class={`row ${selected ? "selected" : ""} ${m.suppressed ? "suppressed" : ""}`}>
      <button class="row-main" onClick={() => (treeSelected.value = selected ? null : m.id)}>
        <Icon name={m.type === "distance" ? "dim" : m.type === "lock" ? "lock" : m.type} size={17} />
        <span class="row-name">
          {m.name}
          {valued && m.value !== undefined ? ` · ${fmt(m.value)}${m.type === "angle" ? "°" : " mm"}` : ""}
        </span>
        {failed && <Icon name="warn" size={15} class="err" />}
      </button>
      {failed && <p class="row-error">{status.error ?? "Not satisfied"}</p>}
      {selected && (
        <div class="row-actions">
          {valued && (
            <button
              onClick={() => {
                treeOpen.value = false;
                promptMate(m.id);
              }}
            >
              <Icon name="edit" size={16} /> Value
            </button>
          )}
          {flippable && (
            <button onClick={() => patchMate(m.id, { flip: !m.flip })}>
              <Icon name="flip" size={16} /> Flip
            </button>
          )}
          <button aria-label={m.suppressed ? "Unsuppress" : "Suppress"} onClick={() => patchMate(m.id, { suppressed: !m.suppressed })}>
            <Icon name={m.suppressed ? "eye" : "eyeOff"} size={16} />
          </button>
          <button
            class="danger"
            aria-label="Delete"
            onClick={() => {
              treeSelected.value = null;
              deleteMate(m.id);
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
  const a = asm.value;
  const d = doc.value;
  const name = a ? a.name : d.name;
  const status = evalStatus.value;
  const errors = a
    ? a.mates.filter((m) => !m.suppressed && asmInfo.value.mates[m.id] && !asmInfo.value.mates[m.id].ok).length
    : d.features.filter((f) => status[f.id] && !status[f.id].ok).length;
  const body = bodyInfo.value;
  const [renaming, setRenaming] = useState(false);
  const back = returnTo.value;
  const backName = back ? files.value.find((f) => f.id === back)?.name : null;

  return (
    <div class={`bubble tree ${open ? "open" : ""}`}>
      <div class="pill-row">
        {backName && (
          <button class="pill icon-only" aria-label={`Back to ${backName}`} onClick={goBack}>
            <Icon name="back" size={18} />
          </button>
        )}
        <button
          class="pill"
          aria-expanded={open}
          onClick={() => {
            treeOpen.value = !open;
            toolsOpen.value = false;
            filesOpen.value = false;
          }}
        >
          <Icon name={a ? "assembly" : "part"} size={17} class="kind" />
          <span class="pill-title">{name}</span>
          {kernelPhase.value === "busy" && <span class="spinner small" />}
          {errors > 0 && <span class="badge err">{errors}</span>}
          <Icon name="chevron" size={18} class={open ? "flip" : ""} />
        </button>
      </div>
      {open && (
        <div class="panel">
          <div class="panel-head">
            <button
              class="link"
              onClick={() => {
                treeOpen.value = false;
                filesOpen.value = "browse";
              }}
            >
              <Icon name="files" size={15} /> Files
            </button>
            {renaming ? (
              <Rename
                value={name}
                onDone={(next) => {
                  setRenaming(false);
                  if (next && next !== name) void commit(a ? { ...a, name: next } : { ...d, name: next });
                }}
              />
            ) : (
              <button class="link" onClick={() => setRenaming(true)}>
                Rename
              </button>
            )}
          </div>
          {a ? (
            <>
              <h4>Parts</h4>
              {a.components.length === 0 ? <p class="hint">No parts yet. Use Tools → Insert part.</p> : <ul class="rows">{a.components.map((c) => <ComponentRow key={c.id} c={c} />)}</ul>}
              <h4>Mates</h4>
              {a.mates.length === 0 ? (
                <p class="hint">Tap geometry on two parts, then pick a mate.</p>
              ) : (
                <ul class="rows">{a.mates.map((m) => <MateRow key={m.id} m={m} />)}</ul>
              )}
              {a.components.length > 0 && <div class="panel-foot">{asmInfo.value.dof === 0 ? "Fully constrained" : `${asmInfo.value.dof} degree${asmInfo.value.dof === 1 ? "" : "s"} of freedom left`}</div>}
            </>
          ) : (
            <>
              <ul class="rows">
                {BASE_PLANES.map((b) => (
                  <PlaneRow key={b.id} id={b.id} name={b.name} />
                ))}
                {d.features.map((f) => (
                  <Row key={f.id} f={f} />
                ))}
              </ul>
              {d.features.length === 0 && <p class="hint">Pick a plane to sketch on, or describe the part to Claude below.</p>}
              {body && (
                <div class="panel-foot">
                  {fmt(body.bbox.max[0] - body.bbox.min[0])} × {fmt(body.bbox.max[1] - body.bbox.min[1])} × {fmt(body.bbox.max[2] - body.bbox.min[2])} mm · {fmt(body.volume / 1000)} cm³
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The file browser: folders, parts and assemblies. Also used to pick a part
// to insert into the open assembly.
import { useState } from "preact/hooks";
import { createFile, deleteFile, files, moveFile, renameFile, subtree } from "../model/files";
import type { FileEntry } from "../model/schema";
import { asm, fileId, filesOpen, insertComponent, newFile, openFile, returnTo, showToast } from "../model/store";
import { Icon } from "./Icon";

const ORDER = { folder: 0, assembly: 1, part: 2 };

export function Files() {
  const intent = filesOpen.value;
  const [folder, setFolder] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  if (!intent) return null;
  const all = files.value;
  const here = folder && all.some((f) => f.id === folder) ? folder : null;
  const inserting = intent === "insert";
  const list = all.filter((f) => f.parent === here && (!inserting || f.kind !== "assembly")).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name));
  const path: FileEntry[] = [];
  for (let at = all.find((f) => f.id === here); at; at = all.find((f) => f.id === at!.parent)) path.unshift(at);
  const close = () => (filesOpen.value = false);

  const open = (f: FileEntry) => {
    if (f.kind === "folder") return setFolder(f.id);
    if (inserting) return insertComponent(f.id);
    returnTo.value = null;
    openFile(f.id);
  };

  const remove = (f: FileEntry) => {
    const gone = subtree(f.id);
    if (gone.includes(fileId.value)) return showToast("That is the open document. Open another one first.");
    const used = asm.value?.components.some((c) => gone.includes(c.part));
    if (used) return showToast("The open assembly uses that part");
    deleteFile(f.id);
    setMenu(null);
  };

  if (moving) {
    const item = all.find((f) => f.id === moving)!;
    const blocked = new Set(subtree(moving));
    const targets = all.filter((f) => f.kind === "folder" && !blocked.has(f.id));
    const go = (parent: string | null) => {
      moveFile(moving, parent);
      setMoving(null);
      setMenu(null);
    };
    return (
      <div class="files" role="dialog" aria-label="Move to folder">
        <header>
          <strong>Move “{item.name}” to</strong>
          <button class="round" aria-label="Cancel" onClick={() => setMoving(null)}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <ul class="rows">
          <li class="row">
            <button class="row-main" onClick={() => go(null)}>
              <Icon name="files" size={17} />
              <span class="row-name">Top level</span>
            </button>
          </li>
          {targets.map((t) => (
            <li class="row" key={t.id}>
              <button class="row-main" onClick={() => go(t.id)}>
                <Icon name="folder" size={17} />
                <span class="row-name">{t.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div class="files" role="dialog" aria-label={inserting ? "Insert a part" : "Files"}>
      <header>
        {here && (
          <button class="round" aria-label="Up one folder" onClick={() => setFolder(path[path.length - 2]?.id ?? null)}>
            <Icon name="back" size={18} />
          </button>
        )}
        <strong>{inserting ? "Insert a part" : path.length ? path.map((p) => p.name).join(" / ") : "Files"}</strong>
        <button class="round" aria-label="Close" onClick={close}>
          <Icon name="close" size={18} />
        </button>
      </header>
      {!inserting && (
        <div class="file-new">
          <button onClick={() => newFile("part", here)}>
            <Icon name="part" size={16} /> New part
          </button>
          <button onClick={() => newFile("assembly", here)}>
            <Icon name="assembly" size={16} /> New assembly
          </button>
          <button onClick={() => createFile("folder", here)}>
            <Icon name="folder" size={16} /> New folder
          </button>
        </div>
      )}
      {list.length === 0 ? (
        <p class="hint">{inserting ? "No parts here. Create a part first, then insert it." : "This folder is empty."}</p>
      ) : (
        <ul class="rows">
          {list.map((f) => (
            <li key={f.id} class={`row ${f.id === fileId.value ? "current" : ""} ${menu === f.id ? "selected" : ""}`}>
              <div class="file-row">
                <button class="row-main" onClick={() => open(f)}>
                  <Icon name={f.kind} size={17} />
                  {renaming === f.id ? (
                    <input
                      class="rename"
                      defaultValue={f.name}
                      ref={(el) => el?.focus()}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        renameFile(f.id, e.currentTarget.value);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    />
                  ) : (
                    <span class="row-name">{f.name}</span>
                  )}
                  {f.id === fileId.value && <span class="tag">open</span>}
                  {inserting && f.kind === "part" && <span class="tag">insert</span>}
                </button>
                {!inserting && (
                  <button class="more" aria-label={`Options for ${f.name}`} onClick={() => setMenu(menu === f.id ? null : f.id)}>
                    <Icon name="more" size={18} />
                  </button>
                )}
              </div>
              {menu === f.id && (
                <div class="row-actions">
                  <button
                    onClick={() => {
                      if (f.id === fileId.value) return showToast("Rename the open document from its tree");
                      setRenaming(f.id);
                    }}
                  >
                    Rename
                  </button>
                  <button onClick={() => setMoving(f.id)}>
                    <Icon name="folder" size={16} /> Move
                  </button>
                  <button class="danger" aria-label="Delete" onClick={() => remove(f)}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

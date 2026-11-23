// The file tree: folders, parts and assemblies. Kept in the browser's local
// storage for now behind this small interface, so a cloud store can replace
// it once there are accounts.
import { signal } from "@preact/signals";
import { normalizeSketch } from "../sketch/build";
import { AssemblySchema, FeatureSchema, type AnyDoc, type AssemblyDoc, type Feature, type FileEntry, type PartDoc } from "./schema";

const INDEX_KEY = "napkin.files.v1";
const CURRENT_KEY = "napkin.current";
const LEGACY_KEY = "napkin.doc.v1";
const docKey = (id: string) => `napkin.file.${id}`;

export const files = signal<FileEntry[]>([]);

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the work still exists for this session.
  }
}

const newFileId = () => `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Parses a stored part, dropping features that no longer validate and upgrading old sketches. */
export function parsePart(raw: unknown, fallbackName = "Part1"): PartDoc {
  const d = (raw ?? {}) as { name?: unknown; features?: unknown[] };
  const features = (Array.isArray(d.features) ? d.features : []).flatMap((f): Feature[] => {
    const r = FeatureSchema.safeParse(f);
    if (!r.success) return [];
    return [r.data.type === "sketch" ? normalizeSketch(r.data) : r.data];
  });
  return { name: typeof d.name === "string" && d.name ? d.name : fallbackName, features };
}

function parseAssembly(raw: unknown, fallbackName: string): AssemblyDoc {
  const r = AssemblySchema.safeParse(raw);
  return r.success ? (r.data as AssemblyDoc) : { name: fallbackName, components: [], mates: [] };
}

export function loadFile(id: string): AnyDoc | null {
  const entry = files.value.find((f) => f.id === id);
  if (!entry || entry.kind === "folder") return null;
  const raw = read(docKey(id));
  return entry.kind === "assembly" ? parseAssembly(raw, entry.name) : parsePart(raw, entry.name);
}

export function loadPart(id: string): PartDoc | null {
  const entry = files.value.find((f) => f.id === id);
  return entry?.kind === "part" ? parsePart(read(docKey(id)), entry.name) : null;
}

function setIndex(next: FileEntry[]) {
  files.value = next;
  write(INDEX_KEY, next);
}

export function saveFile(id: string, doc: AnyDoc) {
  write(docKey(id), doc);
  setIndex(files.value.map((f) => (f.id === id ? { ...f, name: doc.name, updated: Date.now() } : f)));
}

export function uniqueName(base: string, parent: string | null): string {
  const taken = new Set(files.value.filter((f) => f.parent === parent).map((f) => f.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\d+$/, "");
  let n = 2;
  while (taken.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

export function createFile(kind: FileEntry["kind"], parent: string | null, name?: string, doc?: AnyDoc): FileEntry {
  const base = name ?? (kind === "folder" ? "Folder" : kind === "assembly" ? "Assembly1" : "Part1");
  const entry: FileEntry = { id: newFileId(), kind, name: uniqueName(base, parent), parent, updated: Date.now() };
  setIndex([...files.value, entry]);
  if (kind === "part") write(docKey(entry.id), doc ?? { name: entry.name, features: [] });
  if (kind === "assembly") write(docKey(entry.id), doc ?? { name: entry.name, components: [], mates: [] });
  return entry;
}

export function renameFile(id: string, name: string) {
  const entry = files.value.find((f) => f.id === id);
  const clean = name.trim().slice(0, 60);
  if (!entry || !clean) return;
  setIndex(files.value.map((f) => (f.id === id ? { ...f, name: clean, updated: Date.now() } : f)));
  if (entry.kind !== "folder") {
    const raw = read(docKey(id)) as Record<string, unknown> | null;
    if (raw) write(docKey(id), { ...raw, name: clean });
  }
}

/** Ids of a folder and everything inside it. */
export function subtree(id: string): string[] {
  const out = [id];
  for (const f of files.value) if (f.parent === id) out.push(...subtree(f.id));
  return out;
}

export function moveFile(id: string, parent: string | null): boolean {
  // A folder cannot be moved into itself or its own contents.
  if (parent && subtree(id).includes(parent)) return false;
  setIndex(files.value.map((f) => (f.id === id ? { ...f, parent } : f)));
  return true;
}

export function deleteFile(id: string) {
  const gone = new Set(subtree(id));
  for (const g of gone) {
    try {
      localStorage.removeItem(docKey(g));
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }
  setIndex(files.value.filter((f) => !gone.has(f.id)));
}

export function rememberCurrent(id: string) {
  write(CURRENT_KEY, id);
}

/** Loads the index (creating a first part, or adopting one saved by an older version) and returns the file to open. */
export function initFiles(): FileEntry {
  const index = read(INDEX_KEY);
  if (Array.isArray(index)) files.value = index as FileEntry[];
  const docs = files.value.filter((f) => f.kind !== "folder");
  if (!docs.length) {
    const legacy = read(LEGACY_KEY);
    return createFile("part", null, undefined, legacy ? parsePart(legacy) : undefined);
  }
  const wanted = read(CURRENT_KEY);
  return docs.find((f) => f.id === wanted) ?? docs.sort((a, b) => b.updated - a.updated)[0];
}

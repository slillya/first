// The model view: an orthographic three.js scene with touch-first navigation
// (one finger orbits, two fingers pan and pinch), tap picking of faces, edges
// and corners, constraint-aware sketching, and assemblies of posed parts.
import { effect } from "@preact/signals";
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { poseToMatrix } from "../assembly/mates";
import type { MeshData } from "../kernel/protocol";
import { distToOutline, niceStep, planeFrame, toPlane, toWorld, type Frame } from "../model/geom2d";
import type { AssemblyDoc, Entity, GeoRef, Pose, Profile, Vec2, Vec3 } from "../model/schema";
import {
  activeFrame,
  activeSketch,
  asm,
  asmMeshes,
  asmSel,
  BASE_PLANES,
  bodyInfo,
  cameraTick,
  clearSelection,
  consumedSketches,
  doc,
  editSketchData,
  filesOpen,
  frames,
  gridStep,
  ink,
  liveSketch,
  mesh,
  mode,
  numPrompt,
  patchComponent,
  preview,
  pushUndo,
  referenceModel,
  selConstraint,
  selection,
  sheet,
  showToast,
  sketchInfo,
  sketchSel,
  solveAssembly,
  toolsOpen,
  treeOpen,
  treeSelected,
  type AsmPick,
} from "../model/store";
import { addProfile, arcPoints, byId, entityPolyline, pointXY, removeEntities, type ModelRef } from "../sketch/build";
import { solveSketch } from "../sketch/solver";
import { edgeInfo, faceGroupAt, faceInfo, meshVertices } from "./meshGeo";

const ACCENT = 0xd97757;
const SKETCH = 0x8fb8ff;
const DEFINED = 0xf2efe6;
const SKETCH_IDLE = 0x6f7f99;
const REFERENCE = 0xd08bd0;
const CONSTRUCTION = 0x8f8a7c;
const CAM_DIST = 5000;
const ISO_EL = Math.asin(1 / Math.sqrt(3));
const PART_COLORS = [0xcdc8bd, 0xb9c4cf, 0xcfc0b0, 0xbccab8, 0xc9bccb, 0xd0cab0];

export type StandardView = "iso" | "top" | "front" | "right";
const VIEWS: Record<StandardView, [number, number]> = {
  iso: [-Math.PI / 4, ISO_EL],
  top: [-Math.PI / 2, Math.PI / 2],
  front: [-Math.PI / 2, 0],
  right: [0, 0],
};

type Gesture =
  | { kind: "orbit" | "pan" | "none" }
  | { kind: "ink"; pts: Vec2[] }
  | { kind: "line" | "arc"; start: Vec2; startId: string | null; end: Vec2; endId: string | null; lock: "h" | "v" | null }
  | { kind: "rect"; start: Vec2 }
  | { kind: "circle"; center: Vec2; centerId: string | null; r: number }
  | { kind: "dragEnt"; id: string; start: Vec2; orig: Entity[] }
  | { kind: "dragComp"; id: string; orig: AssemblyDoc; pose: Pose };

/** One displayed body: the part itself, or one component of an assembly. */
interface Solid {
  id: string;
  data: MeshData;
  group: Group;
  mesh: Mesh;
  verts: Vec3[];
}

type Picked =
  | { solid: Solid; what: "vertex"; point: Vec3 }
  | { solid: Solid; what: "edge"; edgeId: number; group: { start: number; count: number } }
  | { solid: Solid; what: "face"; faceId: number; group: { start: number; count: number }; on: Vec3 };

function quatFromBasis(right: Vector3, up: Vector3, back: Vector3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, back));
}

function quatFromAzEl(az: number, el: number): Quaternion {
  const back = new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
  const right = new Vector3(-Math.sin(az), Math.cos(az), 0);
  return quatFromBasis(right, new Vector3().crossVectors(back, right), back);
}

const vec = (p: Vec3) => new Vector3(p[0], p[1], p[2]);
const arr = (v: Vector3): Vec3 => [v.x, v.y, v.z];

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 1, CAM_DIST * 2);
  private target = new Vector3();
  private quat = quatFromAzEl(...VIEWS.iso);
  private zoom = 4;
  private az = VIEWS.iso[0];
  private el = VIEWS.iso[1];
  private width = 1;
  private height = 1;
  /** Screen space covered by the top bubbles and the bottom composer. */
  insets = { top: 64, bottom: 96 };

  private edgeMat = this.fatMaterial(0x1b1a18, 1.3);
  private solidGroup = new Group();
  private solids: Solid[] = [];
  private geoCache = new Map<MeshData, { geo: BufferGeometry; edges: LineSegmentsGeometry; verts: Vec3[] }>();
  private bodyMats: MeshStandardMaterial[] = [];
  private selGroup = new Group();
  private planeGroup = new Group();
  private sketchGroup = new Group();
  private liveGroup = new Group();
  private gridGroup = new Group();
  private gridKey = "";
  private fatMats = new Set<LineMaterial>([this.edgeMat]);

  private frame: Frame | null = null;
  private sketchKey = "";
  private shownKey = "";
  private raf = 0;
  private anim: { t0: number; ms: number; from: [Vector3, Quaternion, number]; to: [Vector3, Quaternion, number] } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private down = { x: 0, y: 0, t: 0 };
  private moved = false;
  private multi = false;
  private pinch = { dist: 0, x: 0, y: 0 };
  private previewPolys: Vec2[][] = [];
  private pressTimer = 0;
  private longPressed = false;
  private beforeKeyboard: { target: Vector3; zoom: number } | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    this.canvas = this.renderer.domElement;
    this.canvas.className = "viewport";
    container.prepend(this.canvas);

    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(-0.6, 0.9, 1);
    const fill = new DirectionalLight(0xffffff, 0.7);
    fill.position.set(0.9, -0.3, 0.6);
    for (const l of [key, fill]) {
      l.target.position.set(0, 0, -1);
      this.camera.add(l, l.target);
    }
    this.scene.add(this.camera, new AmbientLight(0xffffff, 0.75));
    this.scene.add(this.solidGroup, this.gridGroup, this.planeGroup, this.sketchGroup, this.selGroup, this.liveGroup, this.triad());

    this.bindPointers();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    effect(() => this.rebuildSolids());
    effect(() => this.syncMode());
    effect(() => this.rebuildPlanes());
    effect(() => this.rebuildSketches());
    effect(() => this.rebuildSelection());
  }

  // -------------------------------------------------------------------------
  // Scene content

  private fatMaterial(color: number, width: number, opacity = 1, overlay = false): LineMaterial {
    const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1 || overlay, opacity });
    if (overlay) {
      m.depthTest = false;
      m.depthWrite = false;
    }
    m.resolution.set(this.width || 1, this.height || 1);
    return m;
  }

  private fatLines(positions: number[] | Float32Array, mat: LineMaterial, order = 0): LineSegments2 | null {
    if (positions.length < 6) return null;
    const g = new LineSegmentsGeometry();
    g.setPositions(positions);
    this.fatMats.add(mat);
    const l = new LineSegments2(g, mat);
    l.renderOrder = order;
    return l;
  }

  private clearGroup(g: Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      const o = c as Mesh;
      if (o.userData.sharedGeometry !== true) o.geometry?.dispose();
      const m = o.material as LineMaterial | undefined;
      if (m && this.fatMats.has(m) && m !== this.edgeMat) {
        this.fatMats.delete(m);
        m.dispose();
      }
    }
  }

  private triad(): Group {
    const g = new Group();
    const axes: [Vec3, number][] = [
      [[1, 0, 0], 0xe5484d],
      [[0, 1, 0], 0x46a758],
      [[0, 0, 1], 0x3e8bff],
    ];
    for (const [d, color] of axes) {
      const l = this.fatLines([0, 0, 0, d[0] * 8, d[1] * 8, d[2] * 8], this.fatMaterial(color, 1.6, 0.9, true), 5);
      if (l) g.add(l);
    }
    return g;
  }

  private geometryFor(data: MeshData) {
    let c = this.geoCache.get(data);
    if (!c) {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(data.positions, 3));
      geo.setAttribute("normal", new BufferAttribute(data.normals, 3));
      geo.setIndex(new BufferAttribute(data.indices, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      // Only the listed groups are drawn; the kernel leaves seam edges out of them.
      const segs: number[] = [];
      for (const grp of data.edgeGroups) for (let i = grp.start * 3; i < (grp.start + grp.count) * 3; i++) segs.push(data.lines[i]);
      const edges = new LineSegmentsGeometry();
      if (segs.length >= 6) edges.setPositions(segs);
      c = { geo, edges, verts: meshVertices(data) };
      this.geoCache.set(data, c);
    }
    return c;
  }

  private bodyMaterial(color: number): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.bodyMats.push(m);
    return m;
  }

  /** The part's body, or every component of the open assembly at its pose. */
  private rebuildSolids() {
    const a = asm.value;
    const partMesh = mesh.value;
    const meshes = asmMeshes.value;
    const want: { id: string; data: MeshData; pose: Pose | null; color: number }[] = [];
    if (a) {
      const partIds = [...new Set(a.components.map((c) => c.part))];
      for (const c of a.components) {
        const data = meshes[c.part];
        if (data?.indices.length) want.push({ id: c.id, data, pose: c.pose, color: PART_COLORS[partIds.indexOf(c.part) % PART_COLORS.length] });
      }
    } else if (partMesh?.indices.length) want.push({ id: "", data: partMesh, pose: null, color: PART_COLORS[0] });

    // Poses change on every drag frame; only rebuild objects when the set of bodies changes.
    const key = want.map((w) => `${w.id}:${this.dataId(w.data)}`).join("|");
    if (key !== this.shownKey) {
      const wasEmpty = this.solids.length === 0;
      for (const m of this.bodyMats) m.dispose();
      this.bodyMats = [];
      this.solidGroup.clear();
      this.solids = want.map((w) => {
        const g = this.geometryFor(w.data);
        const group = new Group();
        const body = new Mesh(g.geo, this.bodyMaterial(w.color));
        const edges = new LineSegments2(g.edges, this.edgeMat);
        edges.visible = w.data.edgeGroups.length > 0;
        group.add(body, edges);
        this.solidGroup.add(group);
        return { id: w.id, data: w.data, group, mesh: body, verts: g.verts };
      });
      this.shownKey = key;
      // Free the GPU buffers of meshes that are no longer shown.
      const inUse = new Set(want.map((w) => w.data));
      for (const [data, c] of this.geoCache)
        if (!inUse.has(data)) {
          c.geo.dispose();
          c.edges.dispose();
          this.geoCache.delete(data);
        }
      this.applySketchLook();
      // Frame the model the first time something appears; later edits keep the user's view.
      if (wasEmpty && this.solids.length && !this.frame) {
        this.placeSolids(want);
        this.fit(true);
      }
    }
    this.placeSolids(want);
    this.rebuildSelection();
    this.requestRender();
  }

  private dataIds = new WeakMap<MeshData, number>();
  private nextDataId = 1;
  private dataId(d: MeshData): number {
    let id = this.dataIds.get(d);
    if (!id) this.dataIds.set(d, (id = this.nextDataId++));
    return id;
  }

  private placeSolids(want: { id: string; pose: Pose | null }[]) {
    want.forEach((w, i) => {
      const g = this.solids[i]?.group;
      if (!g) return;
      g.matrixAutoUpdate = false;
      if (w.pose) g.matrix.fromArray(poseToMatrix(w.pose));
      else g.matrix.identity();
      g.updateMatrixWorld(true);
    });
  }

  private applySketchLook() {
    const sketching = !!this.frame;
    for (const m of this.bodyMats) {
      m.transparent = sketching;
      m.opacity = sketching ? 0.28 : 1;
      m.depthWrite = !sketching;
      m.needsUpdate = true;
    }
    this.edgeMat.transparent = sketching;
    this.edgeMat.opacity = sketching ? 0.45 : 1;
  }

  private syncMode() {
    const sk = mode.value.kind === "sketch" ? activeSketch() : null;
    const frame = activeFrame.value;
    // Re-orient if the sketch changes or its plane moves underneath us.
    const key = sk && frame ? `${sk.id}:${JSON.stringify(frame)}` : "";
    if (key === this.sketchKey) return;
    this.sketchKey = key;
    this.previewPolys = [];
    this.gesture = null;
    this.frame = sk ? frame : null;
    this.applySketchLook();
    this.gridKey = "";
    this.clearGroup(this.gridGroup);
    this.clearGroup(this.liveGroup);
    if (this.frame) {
      const f = this.frame;
      this.animateTo(this.fitParams(quatFromBasis(vec(f.x), vec(f.y), vec(f.n))));
    } else this.animateTo(this.fitParams(quatFromAzEl(this.az, this.el)));
  }

  private segments(frame: Frame, pts: Vec2[], closed: boolean, out: number[]) {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) out.push(...toWorld(frame, pts[i]), ...toWorld(frame, pts[(i + 1) % pts.length]));
  }

  private rebuildPlanes() {
    const d = doc.value;
    const fr = frames.value;
    const picked = treeSelected.value;
    const body = bodyInfo.value;
    const editing = sheet.value?.featureId;
    this.clearGroup(this.planeGroup);
    if (asm.value) return this.requestRender();
    const size = body ? Math.max(30, 0.75 * Math.hypot(...body.bbox.max.map((v, i) => v - body.bbox.min[i]))) : 60;
    const centre: Vec3 = body ? [0, 1, 2].map((i) => (body.bbox.min[i] + body.bbox.max[i]) / 2) as Vec3 : [0, 0, 0];
    const show: { id: string; frame: Frame }[] = [];
    // Origin planes appear while the part is still empty, or when picked in the tree.
    for (const b of BASE_PLANES) if (picked === b.id || (!d.features.length && !this.frame)) show.push({ id: b.id, frame: planeFrame(b.plane) });
    for (const f of d.features) {
      const frame = f.type === "plane" && !f.suppressed ? fr.get(f.id) : undefined;
      if (frame) show.push({ id: f.id, frame });
    }
    for (const { id, frame } of show) {
      const on = id === picked || id === editing;
      const c = toPlane(frame, centre);
      const h = size / 2;
      const corners = [
        [c[0] - h, c[1] - h],
        [c[0] + h, c[1] - h],
        [c[0] + h, c[1] + h],
        [c[0] - h, c[1] + h],
      ].map((q) => toWorld(frame, q as Vec2));
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(corners.flat()), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const quad = new Mesh(g, new MeshBasicMaterial({ color: on ? ACCENT : SKETCH, transparent: true, opacity: on ? 0.16 : 0.07, side: DoubleSide, depthWrite: false }));
      quad.userData.planeId = id;
      quad.renderOrder = 3;
      this.planeGroup.add(quad);
      const edge: number[] = [];
      corners.forEach((p, i) => edge.push(...p, ...corners[(i + 1) % 4]));
      const l = this.fatLines(edge, this.fatMaterial(on ? ACCENT : SKETCH, on ? 1.8 : 1.1, on ? 0.95 : 0.5), 4);
      if (l) this.planeGroup.add(l);
    }
    this.requestRender();
  }

  private rebuildSketches() {
    const d = doc.value;
    const m = mode.value;
    const strokes = ink.value;
    const picked = treeSelected.value;
    const live = liveSketch.value;
    const info = sketchInfo.value;
    const sel = new Set(sketchSel.value);
    const fr = frames.value;
    this.clearGroup(this.sketchGroup);
    if (asm.value) return this.requestRender();
    const used = consumedSketches(d);
    const activeId = m.kind === "sketch" ? m.sketchId : null;
    for (const f of d.features) {
      if (f.type !== "sketch") continue;
      const active = f.id === activeId;
      if (!active && f.id !== picked && (used.has(f.id) || f.suppressed)) continue;
      let frame: Frame;
      try {
        frame = planeFrame(f.plane, fr);
      } catch {
        continue;
      }
      const ents = active && live ? live : f.entities;
      const map = byId(ents);
      const buckets = new Map<string, { color: number; width: number; order: number; segs: number[]; opacity: number }>();
      const bucket = (color: number, width: number, order: number, opacity = 1) => {
        const k = `${color}:${width}:${opacity}`;
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = { color, width, order, segs: [], opacity }));
        return b.segs;
      };
      const pts: number[] = [];
      const ptColors: number[] = [];
      const rgb = (hex: number) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
      for (const e of ents) {
        if (e.type === "point") {
          if (!active) continue;
          pts.push(...toWorld(frame, [e.x, e.y]));
          ptColors.push(...rgb(sel.has(e.id) ? ACCENT : e.fixed ? REFERENCE : info?.free.has(e.id) ? SKETCH : DEFINED));
          continue;
        }
        const isRef = e.type === "line" && !!e.ref;
        if (!active && (isRef || e.construction)) continue;
        let poly = entityPolyline(e, map);
        if (isRef && poly.length === 2) {
          // A reference stands for an unbounded line: draw it well past its two defining points.
          const [p, q] = poly;
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
          const reach = 400 / Math.max(this.zoom, 0.05);
          const ux = ((q[0] - p[0]) / len) * reach;
          const uy = ((q[1] - p[1]) / len) * reach;
          poly = [
            [p[0] - ux, p[1] - uy],
            [q[0] + ux, q[1] + uy],
          ];
        }
        const target = !active
          ? bucket(SKETCH_IDLE, 1.5, 10)
          : sel.has(e.id)
            ? bucket(ACCENT, 3, 12)
            : isRef
              ? bucket(REFERENCE, 1.3, 9, 0.85)
              : e.construction
                ? bucket(CONSTRUCTION, 1.3, 9, 0.9)
                : info?.free.has(e.id)
                  ? bucket(SKETCH, 2.1, 10)
                  : bucket(DEFINED, 2.1, 11);
        this.segments(frame, poly, false, target);
      }
      for (const b of buckets.values()) {
        const l = this.fatLines(b.segs, this.fatMaterial(b.color, b.width, b.opacity, true), b.order);
        if (l) this.sketchGroup.add(l);
      }
      if (pts.length) {
        const g = new BufferGeometry();
        g.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
        g.setAttribute("color", new BufferAttribute(new Float32Array(ptColors), 3));
        const p = new Points(g, new PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, transparent: true }));
        p.renderOrder = 14;
        this.sketchGroup.add(p);
      }
      if (active) {
        const inkSegs: number[] = [];
        for (const s of strokes) this.segments(frame, s, false, inkSegs);
        const l = this.fatLines(inkSegs, this.fatMaterial(ACCENT, 2.4, 1, true), 12);
        if (l) this.sketchGroup.add(l);
      }
    }
    this.requestRender();
  }

  private rebuildLive() {
    this.clearGroup(this.liveGroup);
    if (!this.frame) return;
    const segs: number[] = [];
    if (this.gesture?.kind === "ink") this.segments(this.frame, this.gesture.pts, false, segs);
    for (const p of this.previewPolys) this.segments(this.frame, p, false, segs);
    const l = this.fatLines(segs, this.fatMaterial(ACCENT, 2.4, 1, true), 13);
    if (l) this.liveGroup.add(l);
    this.requestRender();
  }

  private highlight(solid: Solid, faces: number[], edges: number[], points: Vec3[]) {
    const data = solid.data;
    for (const faceId of faces) {
      const grp = data.faceGroups.find((g) => g.faceId === faceId);
      if (!grp) continue;
      const g = new BufferGeometry();
      g.setAttribute("position", solid.mesh.geometry.getAttribute("position"));
      g.setIndex(new BufferAttribute(data.indices.subarray(grp.start, grp.start + grp.count), 1));
      const m = new Mesh(g, new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.renderOrder = 2;
      m.matrixAutoUpdate = false;
      m.matrix.copy(solid.group.matrix);
      this.selGroup.add(m);
    }
    const segs: number[] = [];
    for (const edgeId of edges) {
      const grp = data.edgeGroups.find((g) => g.edgeId === edgeId);
      if (grp) for (let i = grp.start * 3; i < (grp.start + grp.count) * 3; i++) segs.push(data.lines[i]);
    }
    const l = this.fatLines(segs, this.fatMaterial(ACCENT, 4, 1, true), 6);
    if (l) {
      l.matrixAutoUpdate = false;
      l.matrix.copy(solid.group.matrix);
      this.selGroup.add(l);
    }
    if (points.length) {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(points.flat()), 3));
      const p = new Points(g, new PointsMaterial({ color: ACCENT, size: 11, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
      p.renderOrder = 7;
      p.matrixAutoUpdate = false;
      p.matrix.copy(solid.group.matrix);
      this.selGroup.add(p);
    }
  }

  private rebuildSelection() {
    const sel = selection.value;
    const picks = asmSel.value;
    this.clearGroup(this.selGroup);
    if (asm.value) {
      for (const s of this.solids) {
        const mine = picks.filter((p) => p.component === s.id);
        if (!mine.length) continue;
        this.highlight(
          s,
          mine.filter((p) => p.what === "face").map((p) => Number(p.key)),
          mine.filter((p) => p.what === "edge").map((p) => Number(p.key)),
          mine.filter((p) => p.what === "vertex").map((p) => p.ref.origin),
        );
      }
    } else if (this.solids[0])
      this.highlight(
        this.solids[0],
        sel.faces.map((f) => f.faceId),
        sel.edges.map((e) => e.edgeId),
        sel.vertices.map((v) => v.point),
      );
    this.selGroup.updateMatrixWorld(true);
    this.requestRender();
  }

  private updateGrid() {
    if (!this.frame) return;
    const f = this.frame;
    const step = niceStep(this.zoom, 7);
    if (gridStep.peek() !== step) gridStep.value = step;
    const corners = [
      [0, 0],
      [this.width, 0],
      [0, this.height],
      [this.width, this.height],
    ].map(([x, y]) => this.planePoint(x, y) ?? ([0, 0] as Vec2));
    const major = step * (String(step).startsWith("2") ? 5 : String(step).startsWith("5") ? 2 : 10);
    const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / major) * major;
    const x1 = Math.ceil(Math.max(...corners.map((c) => c[0])) / major) * major;
    const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / major) * major;
    const y1 = Math.ceil(Math.max(...corners.map((c) => c[1])) / major) * major;
    const key = [step, x0, x1, y0, y1].join(",");
    if (key === this.gridKey) return;
    this.gridKey = key;
    this.clearGroup(this.gridGroup);
    const minor: number[] = [];
    const maj: number[] = [];
    const showMinor = (x1 - x0 + (y1 - y0)) / step < 600;
    const isMajor = (v: number) => Math.abs(v / major - Math.round(v / major)) < 1e-6;
    for (let x = x0; x <= x1 + 1e-9; x += step) {
      if (Math.abs(x) < 1e-9) continue;
      const m = isMajor(x);
      if (m || showMinor) (m ? maj : minor).push(...toWorld(f, [x, y0]), ...toWorld(f, [x, y1]));
    }
    for (let y = y0; y <= y1 + 1e-9; y += step) {
      if (Math.abs(y) < 1e-9) continue;
      const m = isMajor(y);
      if (m || showMinor) (m ? maj : minor).push(...toWorld(f, [x0, y]), ...toWorld(f, [x1, y]));
    }
    const thin = (pos: number[], color: number, opacity: number) => {
      if (!pos.length) return;
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
      const l = new LineSegments(g, new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
      l.renderOrder = 1;
      this.gridGroup.add(l);
    };
    thin(minor, 0xffffff, 0.07);
    thin(maj, 0xffffff, 0.16);
    thin([...toWorld(f, [x0, 0]), ...toWorld(f, [x1, 0])], 0xe5484d, 0.6);
    thin([...toWorld(f, [0, y0]), ...toWorld(f, [0, y1])], 0x46a758, 0.6);
  }

  // -------------------------------------------------------------------------
  // Camera

  private basis() {
    return {
      right: new Vector3(1, 0, 0).applyQuaternion(this.quat),
      up: new Vector3(0, 1, 0).applyQuaternion(this.quat),
      back: new Vector3(0, 0, 1).applyQuaternion(this.quat),
    };
  }

  private applyCamera() {
    const c = this.camera;
    c.left = -this.width / 2;
    c.right = this.width / 2;
    c.top = this.height / 2;
    c.bottom = -this.height / 2;
    c.zoom = this.zoom;
    c.quaternion.copy(this.quat);
    c.position.copy(this.target).addScaledVector(this.basis().back, CAM_DIST);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    if (w === this.width && h === this.height) return;
    const dh = this.height > 1 ? h - this.height : 0;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    for (const m of this.fatMats) m.resolution.set(w, h);
    this.gridKey = "";
    if (dh < -120 && !this.beforeKeyboard) {
      // The keyboard took the lower part of the screen: re-frame so the whole part stays visible above it.
      this.beforeKeyboard = { target: this.target.clone(), zoom: this.zoom };
      this.animateTo(this.fitParams(this.quat), 200);
    } else if (dh > 120 && this.beforeKeyboard) {
      this.animateTo([this.beforeKeyboard.target, this.quat.clone(), this.beforeKeyboard.zoom], 200);
      this.beforeKeyboard = null;
    } else if (dh) {
      // Small height changes keep the picture anchored to the top edge.
      this.target.addScaledVector(this.basis().up, -dh / (2 * this.zoom));
    }
    this.frameNow();
  }

  requestRender() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frameNow());
  }

  private frameNow() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (performance.now() - a.t0) / a.ms);
      const e = 1 - (1 - k) ** 3;
      this.target.lerpVectors(a.from[0], a.to[0], e);
      this.quat.slerpQuaternions(a.from[1], a.to[1], e);
      this.zoom = Math.exp(Math.log(a.from[2]) + (Math.log(a.to[2]) - Math.log(a.from[2])) * e);
      if (k >= 1) this.anim = null;
      else this.requestRender();
    }
    this.applyCamera();
    this.updateGrid();
    this.renderer.render(this.scene, this.camera);
    cameraTick.value++;
  }

  private animateTo(to: [Vector3, Quaternion, number], ms = 320) {
    this.anim = { t0: performance.now(), ms, from: [this.target.clone(), this.quat.clone(), this.zoom], to };
    this.requestRender();
  }

  /** World-space corners of everything worth framing. */
  private extentPoints(): Vector3[] {
    const pts: Vector3[] = [];
    for (const s of this.solids) {
      const bb = s.mesh.geometry.boundingBox;
      if (!bb) continue;
      for (const x of [bb.min.x, bb.max.x])
        for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) pts.push(new Vector3(x, y, z).applyMatrix4(s.group.matrix));
    }
    if (asm.peek()) return pts;
    const d = doc.peek();
    const used = consumedSketches(d);
    const m = mode.peek();
    const activeId = m.kind === "sketch" ? m.sketchId : null;
    for (const f of d.features) {
      if (f.type !== "sketch" || (f.id !== activeId && (used.has(f.id) || f.suppressed))) continue;
      let frame: Frame;
      try {
        frame = planeFrame(f.plane, frames.peek());
      } catch {
        continue;
      }
      const map = byId(f.entities);
      for (const e of f.entities) {
        if (e.type === "point") {
          if (!e.fixed) pts.push(vec(toWorld(frame, [e.x, e.y])));
        } else if (e.type === "circle") for (const q of arcPoints(pointXY(map, e.c), e.r, 0, Math.PI * 2, 8)) pts.push(vec(toWorld(frame, q)));
      }
    }
    return pts;
  }

  /** Camera that frames everything visible, for a given orientation. */
  private fitParams(q: Quaternion): [Vector3, Quaternion, number] {
    const pts = this.extentPoints();
    const right = new Vector3(1, 0, 0).applyQuaternion(q);
    const up = new Vector3(0, 1, 0).applyQuaternion(q);
    const availW = Math.max(80, this.width - 32);
    const availH = Math.max(80, this.height - this.insets.top - this.insets.bottom);
    const shift = (this.insets.top - this.insets.bottom) / 2;
    if (!pts.length) {
      const zoom = Math.min(availW, availH) / 110;
      const origin = this.frame ? vec(this.frame.origin) : new Vector3();
      return [origin.addScaledVector(up, shift / zoom), q.clone(), zoom];
    }
    let [r0, r1, u0, u1] = [Infinity, -Infinity, Infinity, -Infinity];
    const centre = new Vector3();
    for (const p of pts) {
      r0 = Math.min(r0, p.dot(right));
      r1 = Math.max(r1, p.dot(right));
      u0 = Math.min(u0, p.dot(up));
      u1 = Math.max(u1, p.dot(up));
      centre.add(p);
    }
    centre.multiplyScalar(1 / pts.length);
    const zoom = Math.min(60, 0.78 * Math.min(availW / Math.max(r1 - r0, 1e-3), availH / Math.max(u1 - u0, 1e-3)));
    centre.addScaledVector(right, (r0 + r1) / 2 - centre.dot(right));
    centre.addScaledVector(up, (u0 + u1) / 2 - centre.dot(up) + shift / zoom);
    return [centre, q.clone(), zoom];
  }

  fit(instant = false) {
    const to = this.fitParams(this.frame ? this.quat : quatFromAzEl(this.az, this.el));
    if (instant) {
      [this.target, this.quat, this.zoom] = to;
      this.anim = null;
      this.requestRender();
    } else this.animateTo(to);
  }

  /** Re-frame only if the model has grown off screen or shrunk to a speck (after Claude edits). */
  fitIfNeeded() {
    if (this.frame) return;
    const pts = this.extentPoints();
    if (!pts.length) return;
    const to = this.fitParams(this.quat);
    const outside = pts.some((p) => {
      const s = this.project(arr(p));
      return s.x < 0 || s.x > this.width || s.y < this.insets.top - 20 || s.y > this.height - this.insets.bottom + 20;
    });
    if (outside || to[2] > this.zoom * 3) this.animateTo(to);
  }

  setView(view: StandardView) {
    if (this.frame) return this.fit();
    [this.az, this.el] = VIEWS[view];
    this.animateTo(this.fitParams(quatFromAzEl(this.az, this.el)));
  }

  get pxPerMm() {
    return this.zoom;
  }

  project(p: Vec3): { x: number; y: number } {
    const { right, up } = this.basis();
    const d = vec(p).sub(this.target);
    return { x: this.width / 2 + d.dot(right) * this.zoom, y: this.height / 2 - d.dot(up) * this.zoom };
  }

  projectSketch(p: Vec2): { x: number; y: number } | null {
    return this.frame ? this.project(toWorld(this.frame, p)) : null;
  }

  /** Point on the view plane through the target under a screen position. */
  private screenToWorld(x: number, y: number): Vector3 {
    const { right, up } = this.basis();
    return this.target
      .clone()
      .addScaledVector(right, (x - this.width / 2) / this.zoom)
      .addScaledVector(up, -(y - this.height / 2) / this.zoom);
  }

  /** Sketch-plane coordinates under a screen position. */
  planePoint(x: number, y: number): Vec2 | null {
    const f = this.frame;
    if (!f) return null;
    const o = this.screenToWorld(x, y);
    const dir = this.basis().back.negate();
    const n = vec(f.n);
    const denom = dir.dot(n);
    if (Math.abs(denom) < 1e-6) return null;
    const t = vec(f.origin).sub(o).dot(n) / denom;
    o.addScaledVector(dir, t);
    return toPlane(f, [o.x, o.y, o.z]);
  }

  private snap(p: Vec2): Vec2 {
    const s = gridStep.peek();
    return [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s];
  }

  /** Small JPEG of the current view for Claude, plus the sketch-plane rectangle it covers. */
  snapshot(max = 768): { data: string; mediaType: "image/jpeg"; region: { min: Vec2; max: Vec2 } | null } {
    this.frameNow();
    const scale = Math.min(1, max / Math.max(this.canvas.width, this.canvas.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(this.canvas.width * scale));
    c.height = Math.max(1, Math.round(this.canvas.height * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1f1e1d";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
    const a = this.planePoint(0, this.height);
    const b = this.planePoint(this.width, 0);
    return {
      data: c.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "",
      mediaType: "image/jpeg",
      region: a && b ? { min: a, max: b } : null,
    };
  }

  // -------------------------------------------------------------------------
  // Pointer input

  private local(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindPointers() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        this.zoomAbout(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private zoomAbout(x: number, y: number, factor: number) {
    const next = Math.min(2000, Math.max(0.02, this.zoom * factor));
    const { right, up } = this.basis();
    const k = 1 / this.zoom - 1 / next;
    this.target.addScaledVector(right, (x - this.width / 2) * k).addScaledVector(up, -(y - this.height / 2) * k);
    this.zoom = next;
    this.anim = null;
    this.requestRender();
  }

  private panBy(dx: number, dy: number) {
    const { right, up } = this.basis();
    this.target.addScaledVector(right, -dx / this.zoom).addScaledVector(up, dy / this.zoom);
    this.anim = null;
    this.requestRender();
  }

  private onDown(e: PointerEvent) {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    if (treeOpen.peek()) treeOpen.value = false;
    if (toolsOpen.peek()) toolsOpen.value = false;
    if (filesOpen.peek()) filesOpen.value = false;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    clearTimeout(this.pressTimer);
    if (this.pointers.size === 1) {
      this.down = { ...p, t: performance.now() };
      this.moved = false;
      this.multi = false;
      this.longPressed = false;
      this.gesture = this.beginSingle(e, p);
      // Press and hold selects whatever is under the finger, whichever tool is active.
      if (this.frame)
        this.pressTimer = window.setTimeout(() => {
          if (this.moved || this.multi || this.pointers.size !== 1) return;
          this.longPressed = true;
          this.abortSingle();
          navigator.vibrate?.(8);
          this.selectAt(p.x, p.y);
        }, 450);
    } else if (this.pointers.size === 2) {
      this.multi = true;
      this.abortSingle();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  /** Nearest sketch point within finger reach, if any. */
  private nearPoint(at: Vec2, exclude?: string | null): { id: string; xy: Vec2 } | null {
    const sk = activeSketch();
    if (!sk) return null;
    const reach = 16 / this.zoom;
    let best: { id: string; xy: Vec2 } | null = null;
    let bestD = reach;
    for (const e of sk.entities) {
      if (e.type !== "point" || e.id === exclude) continue;
      const d = Math.hypot(e.x - at[0], e.y - at[1]);
      if (d < bestD) {
        bestD = d;
        best = { id: e.id, xy: [e.x, e.y] };
      }
    }
    return best;
  }

  /** Sketch entity under a plane position: points win over curves. */
  private hitSketch(at: Vec2): string | null {
    const sk = activeSketch();
    if (!sk) return null;
    const p = this.nearPoint(at);
    if (p) return p.id;
    const map = byId(sk.entities);
    let best: string | null = null;
    let bestD = 13 / this.zoom;
    for (const e of sk.entities) {
      if (e.type === "point") continue;
      let d: number;
      if (e.type === "line" && e.ref) {
        const [a, b] = [pointXY(map, e.p1), pointXY(map, e.p2)];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        d = Math.abs(((b[0] - a[0]) * (at[1] - a[1]) - (b[1] - a[1]) * (at[0] - a[0])) / len);
      } else d = distToOutline(at, entityPolyline(e, map), false);
      if (d < bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  }

  private beginSingle(e: PointerEvent, p: { x: number; y: number }): Gesture {
    if (e.button === 1 || e.button === 2 || e.shiftKey) return { kind: "pan" };
    const m = mode.peek();
    if (m.kind !== "sketch" || !this.frame) {
      const a = asm.peek();
      if (a) {
        const hit = this.pick(p.x, p.y);
        const comp = hit && a.components.find((c) => c.id === hit.solid.id);
        if (comp && !comp.fixed) return { kind: "dragComp", id: comp.id, orig: a, pose: comp.pose };
      }
      return { kind: "orbit" };
    }
    const at = this.planePoint(p.x, p.y);
    if (!at) return { kind: "pan" };
    const near = this.nearPoint(at);
    switch (m.tool) {
      case "ink":
        return { kind: "ink", pts: [at] };
      case "line":
      case "arc": {
        const start = near?.xy ?? this.snap(at);
        return { kind: m.tool, start, startId: near?.id ?? null, end: start, endId: null, lock: null };
      }
      case "rect":
        return { kind: "rect", start: this.snap(at) };
      case "circle":
        return { kind: "circle", center: near?.xy ?? this.snap(at), centerId: near?.id ?? null, r: 0 };
      case "select": {
        const sk = activeSketch();
        const id = this.hitSketch(at);
        const ent = sk?.entities.find((x) => x.id === id);
        if (!sk || !ent || (ent.type === "point" && ent.fixed) || (ent.type === "line" && ent.ref)) return { kind: "pan" };
        return { kind: "dragEnt", id: ent.id, start: at, orig: sk.entities };
      }
      default:
        return { kind: "pan" };
    }
  }

  private abortSingle() {
    const g = this.gesture;
    if (g?.kind === "dragEnt") liveSketch.value = null;
    if (g?.kind === "dragComp") void preview(solveAssembly(g.orig));
    this.gesture = { kind: "none" };
    this.previewPolys = [];
    this.rebuildLive();
  }

  private onMove(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.panBy(mx - this.pinch.x, my - this.pinch.y);
      if (this.pinch.dist > 0 && dist > 0) this.zoomAbout(mx, my, dist / this.pinch.dist);
      this.pinch = { dist, x: mx, y: my };
      return;
    }
    if (this.multi || !this.gesture || this.longPressed) return;
    if (!this.moved && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 7) {
      this.moved = true;
      clearTimeout(this.pressTimer);
    }
    if (!this.moved) return;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const g = this.gesture;
    switch (g.kind) {
      case "orbit":
        this.az -= dx * 0.008;
        this.el = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.el + dy * 0.008));
        this.quat = quatFromAzEl(this.az, this.el);
        this.anim = null;
        this.requestRender();
        break;
      case "pan":
        this.panBy(dx, dy);
        break;
      case "ink": {
        const at = this.planePoint(p.x, p.y);
        if (at) g.pts.push(at);
        this.rebuildLive();
        break;
      }
      case "line":
      case "arc": {
        const raw = this.planePoint(p.x, p.y);
        if (!raw) break;
        const near = this.nearPoint(raw, g.startId);
        let end = near?.xy ?? this.snap(raw);
        g.lock = null;
        if (!near && g.kind === "line") {
          // Nearly level or nearly upright lines snap square and get the matching relation.
          const ddx = Math.abs(end[0] - g.start[0]);
          const ddy = Math.abs(end[1] - g.start[1]);
          if (ddy < 0.07 * ddx) {
            end = [end[0], g.start[1]];
            g.lock = "h";
          } else if (ddx < 0.07 * ddy) {
            end = [g.start[0], end[1]];
            g.lock = "v";
          }
        }
        g.end = end;
        g.endId = near?.id ?? null;
        if (g.kind === "line") this.previewPolys = [[g.start, end]];
        else {
          const c: Vec2 = [(g.start[0] + end[0]) / 2, (g.start[1] + end[1]) / 2];
          const a0 = Math.atan2(g.start[1] - c[1], g.start[0] - c[0]);
          this.previewPolys = [arcPoints(c, Math.hypot(end[0] - c[0], end[1] - c[1]), a0, a0 + Math.PI, 48)];
        }
        this.rebuildLive();
        break;
      }
      case "rect": {
        const raw = this.planePoint(p.x, p.y);
        if (!raw) break;
        const at = this.snap(raw);
        this.previewPolys = [[g.start, [at[0], g.start[1]], at, [g.start[0], at[1]], g.start]];
        this.rebuildLive();
        break;
      }
      case "circle": {
        const raw = this.planePoint(p.x, p.y);
        if (!raw) break;
        const s = gridStep.peek();
        g.r = Math.round(Math.hypot(raw[0] - g.center[0], raw[1] - g.center[1]) / (s / 2)) * (s / 2);
        this.previewPolys = g.r > 0 ? [arcPoints(g.center, g.r, 0, Math.PI * 2, 64)] : [];
        this.rebuildLive();
        break;
      }
      case "dragEnt": {
        const at = this.planePoint(p.x, p.y);
        const sk = activeSketch();
        if (!at || !sk) break;
        const ent = g.orig.find((x) => x.id === g.id);
        if (!ent) break;
        const map = byId(g.orig);
        const delta: Vec2 = [at[0] - g.start[0], at[1] - g.start[1]];
        const moveTo = (id: string) => {
          const q = pointXY(map, id);
          return { point: id, to: [q[0] + delta[0], q[1] + delta[1]] as Vec2 };
        };
        const r =
          ent.type === "point"
            ? solveSketch(g.orig, sk.constraints, { drag: [{ point: ent.id, to: at }], fast: true })
            : ent.type === "line"
              ? solveSketch(g.orig, sk.constraints, { drag: [moveTo(ent.p1), moveTo(ent.p2)], fast: true })
              : ent.type === "circle"
                ? solveSketch(g.orig, sk.constraints, { dragRadius: { circle: ent.id, r: Math.hypot(at[0] - pointXY(map, ent.c)[0], at[1] - pointXY(map, ent.c)[1]) }, fast: true })
                : solveSketch(g.orig, sk.constraints, { drag: [moveTo(ent.c), moveTo(ent.p1), moveTo(ent.p2)], fast: true });
        if (r.ok) liveSketch.value = r.entities;
        break;
      }
      case "dragComp": {
        // Slide the part in the screen plane; the mate solver then pulls it back onto its mates.
        const { right, up } = this.basis();
        const d = right.multiplyScalar(dx / this.zoom).addScaledVector(up, -dy / this.zoom);
        g.pose = { p: [g.pose.p[0] + d.x, g.pose.p[1] + d.y, g.pose.p[2] + d.z], q: g.pose.q };
        patchComponent(g.id, { pose: g.pose }, false);
        const solvedPose = asm.peek()?.components.find((c) => c.id === g.id)?.pose;
        if (solvedPose) g.pose = solvedPose;
        break;
      }
    }
  }

  private onUp(e: PointerEvent, cancelled = false) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size > 0) return;
    clearTimeout(this.pressTimer);
    const p = this.local(e);
    const g = this.gesture;
    this.gesture = null;
    if (this.multi || !g || this.longPressed) {
      this.multi = false;
      return;
    }
    if (cancelled) {
      this.gesture = g;
      this.abortSingle();
      this.gesture = null;
      return;
    }
    if (!this.moved && performance.now() - this.down.t < 700) {
      this.previewPolys = [];
      this.rebuildLive();
      this.tap(p.x, p.y);
      return;
    }
    this.finish(g);
    this.previewPolys = [];
    this.rebuildLive();
  }

  private finish(g: Gesture) {
    const step = gridStep.peek();
    switch (g.kind) {
      case "ink":
        if (g.pts.length > 3) ink.value = [...ink.value, this.thin(g.pts)];
        break;
      case "line":
      case "arc": {
        if (Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]) < step / 2 || (g.endId && g.endId === g.startId)) break;
        const build = (withLock: boolean) =>
          editSketchData(
            (d, ids) => {
              const point = (id: string | null, xy: Vec2) => {
                if (id) return id;
                const pid = ids.get("p");
                d.entities.push({ id: pid, type: "point", x: xy[0], y: xy[1] });
                return pid;
              };
              const a = point(g.startId, g.start);
              const b = point(g.endId, g.end);
              if (g.kind === "line") {
                const lid = ids.get("l");
                d.entities.push({ id: lid, type: "line", p1: a, p2: b });
                if (withLock && g.lock) d.constraints.push({ id: ids.get("k"), type: g.lock === "h" ? "horizontal" : "vertical", a: lid });
              } else {
                const c = point(null, [(g.start[0] + g.end[0]) / 2, (g.start[1] + g.end[1]) / 2]);
                d.entities.push({ id: ids.get("a"), type: "arc", c, p1: a, p2: b });
              }
            },
            { quiet: withLock },
          );
        // If the inferred relation would over-define things, keep the line without it.
        if (!build(true)) build(false);
        break;
      }
      case "rect": {
        const last = this.previewPolys[0]?.[2];
        if (!last) break;
        const w = Math.abs(last[0] - g.start[0]);
        const h = Math.abs(last[1] - g.start[1]);
        if (w < step || h < step) break;
        const rect: Profile = { type: "rect", cx: (last[0] + g.start[0]) / 2, cy: (last[1] + g.start[1]) / 2, w, h };
        editSketchData((d) => void addProfile(d, rect, false));
        break;
      }
      case "circle":
        if (g.r < step / 2) break;
        editSketchData((d, ids) => {
          let c = g.centerId;
          if (!c) {
            c = ids.get("p");
            d.entities.push({ id: c, type: "point", x: g.center[0], y: g.center[1] });
          }
          d.entities.push({ id: ids.get("c"), type: "circle", c, r: g.r });
        });
        break;
      case "dragEnt": {
        const live = liveSketch.peek();
        if (live) editSketchData((d) => void (d.entities = live.map((x) => ({ ...x }))));
        liveSketch.value = null;
        break;
      }
      case "dragComp":
        if (asm.peek() !== g.orig) pushUndo(g.orig);
        break;
    }
  }

  /** Drop ink samples closer than ~2px so strokes stay small when sent to Claude. */
  private thin(pts: Vec2[]): Vec2[] {
    const min = 2 / this.zoom;
    const out = [pts[0]];
    for (const p of pts) {
      const q = out[out.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p);
    }
    return out.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }

  /** What a sketch reference to the picked model geometry should be. */
  private modelRef(pk: Picked): ModelRef | null {
    if (pk.what === "vertex") return { kind: "point", point: pk.point };
    if (pk.what === "edge") {
      const info = edgeInfo(pk.solid.data, pk.group);
      if (info.kind === "line") return { kind: "line", origin: info.origin, dir: info.dir };
      if (info.kind === "circle") return { kind: "point", point: info.center };
      return null;
    }
    const info = faceInfo(pk.solid.data, pk.group);
    if (info.kind === "plane") return { kind: "plane", origin: info.origin, normal: info.normal };
    if (info.kind === "cylinder") return { kind: "line", origin: info.origin, dir: info.axis };
    return null;
  }

  /** Select (or deselect) the sketch entity or model geometry at a screen position. */
  private selectAt(x: number, y: number) {
    const at = this.planePoint(x, y);
    const m = mode.peek();
    if (!at || m.kind !== "sketch") return;
    let id = this.hitSketch(at);
    if (!id) {
      const pk = this.pick(x, y);
      const ref = pk && this.modelRef(pk);
      if (pk && !ref) showToast("Only corners, straight or circular edges, and flat or round faces can be referenced");
      if (ref) id = referenceModel(ref);
    }
    selConstraint.value = null;
    numPrompt.value = null;
    const cur = sketchSel.peek();
    if (!id) {
      if (cur.length) sketchSel.value = [];
      return;
    }
    if (cur.includes(id)) sketchSel.value = cur.filter((s) => s !== id);
    // Relations and dimensions work on at most two things; a third replaces the oldest.
    else sketchSel.value = [...cur, id].slice(-2);
  }

  private tap(x: number, y: number) {
    const m = mode.peek();
    if (m.kind === "sketch") {
      if (m.tool === "erase") return this.eraseAt(x, y);
      return this.selectAt(x, y);
    }
    numPrompt.value = null;
    const cands = this.pickAll(x, y);
    if (asm.peek()) return this.tapAssembly(cands);
    if (!cands.length) {
      const plane = this.pickPlane(x, y);
      clearSelection();
      if (plane) treeSelected.value = treeSelected.peek() === plane ? null : plane;
      else if (treeSelected.peek()) treeSelected.value = null;
      return;
    }
    const sel = selection.peek();
    const same = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
    const chosen = (pk: Picked) =>
      pk.what === "vertex" ? sel.vertices.some((v) => same(v.point, pk.point)) : pk.what === "edge" ? sel.edges.some((e) => e.edgeId === pk.edgeId) : sel.faces.some((f) => f.faceId === pk.faceId);
    // Tapping something already selected lets go of it and moves on to the next thing under the finger.
    const at = cands.findIndex(chosen);
    let next = { ...sel };
    if (at >= 0) {
      const pk = cands[at];
      if (pk.what === "vertex") next.vertices = sel.vertices.filter((v) => !same(v.point, pk.point));
      else if (pk.what === "edge") next.edges = sel.edges.filter((e) => e.edgeId !== pk.edgeId);
      else next.faces = sel.faces.filter((f) => f.faceId !== pk.faceId);
    }
    const pk = at < 0 ? cands[0] : cands[at + 1];
    if (pk?.what === "vertex") next = { ...next, vertices: [...next.vertices, { point: pk.point }] };
    else if (pk?.what === "edge") next = { ...next, edges: [...next.edges, { edgeId: pk.edgeId, point: edgeInfo(pk.solid.data, pk.group).mid }] };
    else if (pk?.what === "face") {
      const info = faceInfo(pk.solid.data, pk.group);
      const normal: Vec3 = info.kind === "plane" ? info.normal : [0, 0, 1];
      next = { ...next, faces: [...next.faces, { faceId: pk.faceId, point: pk.on, center: info.center, normal, planar: info.kind === "plane" }] };
    }
    selection.value = next;
  }

  private asmPick(pk: Picked): AsmPick | null {
    let ref: GeoRef | null = null;
    let key = "";
    if (pk.what === "vertex") {
      ref = { type: "point", origin: pk.point };
      key = pk.point.map((v) => v.toFixed(4)).join(",");
    } else if (pk.what === "edge") {
      const info = edgeInfo(pk.solid.data, pk.group);
      key = String(pk.edgeId);
      if (info.kind === "line") ref = { type: "axis", origin: info.origin, dir: info.dir };
      else if (info.kind === "circle") ref = { type: "axis", origin: info.center, dir: info.axis };
    } else {
      const info = faceInfo(pk.solid.data, pk.group);
      key = String(pk.faceId);
      if (info.kind === "plane") ref = { type: "plane", origin: info.origin, dir: info.normal };
      else if (info.kind === "cylinder") ref = { type: "axis", origin: info.origin, dir: info.axis };
    }
    return ref ? { component: pk.solid.id, ref, key, what: pk.what } : null;
  }

  private tapAssembly(cands: Picked[]) {
    const cur = asmSel.peek();
    if (!cands.length) {
      if (cur.length) asmSel.value = [];
      if (treeSelected.peek()) treeSelected.value = null;
      return;
    }
    const picks = cands.map((c) => this.asmPick(c)).filter((p): p is AsmPick => !!p);
    if (!picks.length) return showToast("Mates work on flat or round faces, straight or circular edges, and corners");
    const same = (a: AsmPick, b: AsmPick) => a.component === b.component && a.what === b.what && a.key === b.key;
    // As in a part: a second tap on the same spot swaps to the next thing under the finger.
    const at = picks.findIndex((p) => cur.some((c) => same(c, p)));
    if (at < 0) {
      asmSel.value = [...cur, picks[0]].slice(-2);
      return;
    }
    const next = picks[at + 1];
    asmSel.value = next ? cur.map((c) => (same(c, picks[at]) ? next : c)) : cur.filter((c) => !same(c, picks[at]));
  }

  private eraseAt(x: number, y: number) {
    const at = this.planePoint(x, y);
    if (!at) return;
    const reach = 18 / this.zoom;
    const strokes = ink.peek();
    const hit = strokes.findIndex((s) => distToOutline(at, s, false) < reach);
    if (hit >= 0) {
      ink.value = strokes.filter((_, i) => i !== hit);
      return;
    }
    const id = this.hitSketch(at);
    if (id)
      editSketchData((d) => {
        const next = removeEntities(d, [id]);
        d.entities = next.entities;
        d.constraints = next.constraints;
      });
  }

  private pickPlane(x: number, y: number): string | null {
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(
      this.planeGroup.children.filter((c) => c.userData.planeId),
      false,
    )[0];
    return (hit?.object.userData.planeId as string | undefined) ?? null;
  }

  /** The best pick under the finger: a corner, else an edge within reach, else the face. */
  private pick(x: number, y: number): Picked | null {
    return this.pickAll(x, y)[0] ?? null;
  }

  /**
   * Everything a tap could mean, most specific first: the nearest visible
   * corner, the nearest visible edge, then the face under the finger. Tapping
   * the same spot again steps through them, which is how a small face that is
   * mostly "edge" under a fingertip can still be chosen.
   */
  private pickAll(x: number, y: number): Picked[] {
    if (!this.solids.length) return [];
    const out: Picked[] = [];
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(
      this.solids.map((s) => s.mesh),
      false,
    )[0];
    const { back } = this.basis();
    const depth = (p: Vector3) => -p.dot(back); // larger = farther from the camera
    const hitDepth = hit ? depth(hit.point) : Infinity;
    const slack = Math.max(0.5, 6 / this.zoom);
    const tapPt: Vec2 = [x, y];
    const w = new Vector3();

    let bestV: { solid: Solid; point: Vec3; d: number } | null = null;
    for (const s of this.solids)
      for (const v of s.verts) {
        w.set(v[0], v[1], v[2]).applyMatrix4(s.group.matrix);
        if (depth(w) > hitDepth + slack) continue;
        const sp = this.project(arr(w));
        const d = Math.hypot(sp.x - x, sp.y - y);
        if (d < 12 && (!bestV || d < bestV.d)) bestV = { solid: s, point: v, d };
      }
    if (bestV) out.push({ solid: bestV.solid, what: "vertex", point: bestV.point });

    let bestE: { solid: Solid; group: { start: number; count: number; edgeId: number }; d: number; dep: number } | null = null;
    const a = new Vector3();
    const b = new Vector3();
    for (const s of this.solids)
      for (const grp of s.data.edgeGroups)
        for (let v = grp.start; v + 1 < grp.start + grp.count; v += 2) {
          a.fromArray(s.data.lines, v * 3).applyMatrix4(s.group.matrix);
          b.fromArray(s.data.lines, v * 3 + 3).applyMatrix4(s.group.matrix);
          const pa = this.project(arr(a));
          const pb = this.project(arr(b));
          const d = distToOutline(tapPt, [[pa.x, pa.y], [pb.x, pb.y]], false);
          if (d > 13) continue;
          // Depth of the edge where it passes under the finger (not at its ends, which may be far away).
          const ex = pb.x - pa.x;
          const ey = pb.y - pa.y;
          const along = ex || ey ? Math.max(0, Math.min(1, ((x - pa.x) * ex + (y - pa.y) * ey) / (ex * ex + ey * ey))) : 0;
          const dep = depth(a) + along * (depth(b) - depth(a));
          // Skip edges hidden behind the face under the finger.
          if (dep > hitDepth + slack) continue;
          if (!bestE || d < bestE.d - 3 || (d < bestE.d + 3 && dep < bestE.dep)) bestE = { solid: s, group: grp, d, dep };
        }
    if (bestE) out.push({ solid: bestE.solid, what: "edge", edgeId: bestE.group.edgeId, group: bestE.group });

    const solid = hit && this.solids.find((s) => s.mesh === hit.object);
    if (hit && solid && hit.faceIndex != null && hit.face) {
      const grp = faceGroupAt(solid.data, hit.faceIndex);
      if (grp) {
        const tri = [hit.face.a, hit.face.b, hit.face.c].map((i) => new Vector3().fromArray(solid.data.positions, i * 3));
        const on = tri[0].add(tri[1]).add(tri[2]).multiplyScalar(1 / 3);
        out.push({ solid, what: "face", faceId: grp.faceId, group: grp, on: arr(on) });
      }
    }
    return out;
  }
}

let instance: Viewport | null = null;
export const viewport = () => instance;
export function createViewport(container: HTMLElement): Viewport {
  instance ??= new Viewport(container);
  // Lets automated tests find where model and sketch points are on screen.
  (window as unknown as { napkinDebug?: object }).napkinDebug = {
    project: (p: Vec3) => instance!.project(p),
    sketch: (p: Vec2) => instance!.projectSketch(p),
  };
  return instance;
}

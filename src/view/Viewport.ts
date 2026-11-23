// The model view: an orthographic three.js scene with touch-first navigation
// (one finger orbits, two fingers pan and pinch), tap picking of faces and
// edges, and finger drawing when a sketch is open.
import { effect } from "@preact/signals";
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
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
import type { MeshData } from "../kernel/protocol";
import {
  distToOutline,
  moveProfile,
  niceStep,
  planeFrame,
  pointInPolygon,
  polygonArea,
  profilePolygon,
  toPlane,
  toWorld,
  type Frame,
} from "../model/geom2d";
import type { Profile, SketchFeature, Vec2, Vec3 } from "../model/schema";
import {
  activeSketch,
  addProfile,
  cameraTick,
  consumedSketches,
  doc,
  draft,
  gridStep,
  ink,
  mesh,
  mode,
  numPrompt,
  selection,
  setProfiles,
  toolsOpen,
  treeOpen,
  treeSelected,
  type EdgePick,
  type FacePick,
} from "../model/store";

const ACCENT = 0xd97757;
const SKETCH = 0x8fb8ff;
const SKETCH_IDLE = 0x6f7f99;
const CAM_DIST = 5000;
const ISO_EL = Math.asin(1 / Math.sqrt(3));

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
  | { kind: "rect" | "circle"; start: Vec2 }
  | { kind: "move"; index: number; start: Vec2; original: Profile[]; moved: boolean };

function quatFromBasis(right: Vector3, up: Vector3, back: Vector3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, back));
}

function quatFromAzEl(az: number, el: number): Quaternion {
  const back = new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
  const right = new Vector3(-Math.sin(az), Math.cos(az), 0);
  return quatFromBasis(right, new Vector3().crossVectors(back, right), back);
}

const vec = (p: Vec3) => new Vector3(p[0], p[1], p[2]);

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

  private bodyMat = new MeshStandardMaterial({
    color: 0xcdc8bd,
    roughness: 0.6,
    metalness: 0.05,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private body = new Mesh(new BufferGeometry(), this.bodyMat);
  private edgeMat = this.fatMaterial(0x1b1a18, 1.3);
  private edges = new LineSegments2(new LineSegmentsGeometry(), this.edgeMat);
  private selGroup = new Group();
  private sketchGroup = new Group();
  private liveGroup = new Group();
  private gridGroup = new Group();
  private gridKey = "";
  private fatMats = new Set<LineMaterial>([this.edgeMat]);

  private data: MeshData | null = null;
  private frame: Frame | null = null;
  private sketchId: string | null = null;
  private sketchKey = "";
  private hadBody = false;
  private raf = 0;
  private anim: { t0: number; ms: number; from: [Vector3, Quaternion, number]; to: [Vector3, Quaternion, number] } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private down = { x: 0, y: 0, t: 0 };
  private moved = false;
  private multi = false;
  private pinch = { dist: 0, x: 0, y: 0 };
  private preview: Profile | null = null;
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

    this.body.visible = false;
    this.edges.visible = false;
    this.scene.add(this.body, this.edges, this.gridGroup, this.sketchGroup, this.selGroup, this.liveGroup, this.triad());

    this.bindPointers();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    effect(() => this.setMesh(mesh.value));
    effect(() => this.syncMode());
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
      if (o.geometry && o.geometry !== this.body.geometry) o.geometry.dispose();
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

  private setMesh(data: MeshData | null) {
    this.data = data;
    this.body.geometry.dispose();
    this.edges.geometry.dispose();
    if (data && data.indices.length) {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(data.positions, 3));
      g.setAttribute("normal", new BufferAttribute(data.normals, 3));
      g.setIndex(new BufferAttribute(data.indices, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      this.body.geometry = g;
      this.body.visible = true;
      // Only the listed groups are drawn; the kernel leaves seam edges out of them.
      const segs: number[] = [];
      for (const grp of data.edgeGroups) for (let i = grp.start * 3; i < (grp.start + grp.count) * 3; i++) segs.push(data.lines[i]);
      const eg = new LineSegmentsGeometry();
      if (segs.length >= 6) eg.setPositions(segs);
      this.edges.geometry = eg;
      this.edges.visible = segs.length >= 6;
      // Frame the part the first time it appears; later edits keep the user's view.
      if (!this.hadBody && !this.frame) this.fit(true);
      this.hadBody = true;
    } else {
      this.body.geometry = new BufferGeometry();
      this.edges.geometry = new LineSegmentsGeometry();
      this.body.visible = false;
      this.edges.visible = false;
      this.hadBody = false;
    }
    this.requestRender();
  }

  private syncMode() {
    const m = mode.value;
    const sk = m.kind === "sketch" ? activeSketch() : null;
    const id = sk?.id ?? null;
    // Re-orient if the sketch changes or its plane is edited underneath us.
    const key = sk ? `${sk.id}:${JSON.stringify(sk.plane)}` : "";
    if (key === this.sketchKey) return;
    this.sketchKey = key;
    this.sketchId = id;
    this.preview = null;
    this.gesture = null;
    this.frame = sk ? planeFrame(sk.plane) : null;
    this.bodyMat.transparent = !!sk;
    this.bodyMat.opacity = sk ? 0.28 : 1;
    this.bodyMat.depthWrite = !sk;
    this.bodyMat.needsUpdate = true;
    this.edgeMat.transparent = !!sk;
    this.edgeMat.opacity = sk ? 0.45 : 1;
    this.gridKey = "";
    this.clearGroup(this.gridGroup);
    this.clearGroup(this.liveGroup);
    if (this.frame) {
      const f = this.frame;
      this.animateTo(this.fitParams(quatFromBasis(vec(f.x), vec(f.y), vec(f.n))));
    } else this.animateTo(this.fitParams(quatFromAzEl(this.az, this.el)));
  }

  private outlineSegments(frame: Frame, pts: Vec2[], closed: boolean, out: number[]) {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      out.push(...toWorld(frame, pts[i]), ...toWorld(frame, pts[(i + 1) % pts.length]));
    }
  }

  private rebuildSketches() {
    const d = doc.value;
    const m = mode.value;
    const strokes = ink.value;
    const pending = draft.value;
    const picked = treeSelected.value;
    this.clearGroup(this.sketchGroup);
    const used = consumedSketches(d);
    const activeId = m.kind === "sketch" ? m.sketchId : null;
    for (const f of d.features) {
      if (f.type !== "sketch") continue;
      const active = f.id === activeId;
      if (!active && f.id !== picked && (used.has(f.id) || f.suppressed)) continue;
      const frame = planeFrame(f.plane);
      const normal: number[] = [];
      const chosen: number[] = [];
      f.profiles.forEach((p, i) => {
        const target = active && m.kind === "sketch" && m.selected === i ? chosen : normal;
        this.outlineSegments(frame, profilePolygon(p, 64), true, target);
      });
      const a = this.fatLines(normal, this.fatMaterial(active ? SKETCH : SKETCH_IDLE, active ? 2 : 1.5, 1, true), 10);
      const b = this.fatLines(chosen, this.fatMaterial(ACCENT, 2.6, 1, true), 11);
      if (a) this.sketchGroup.add(a);
      if (b) this.sketchGroup.add(b);
    }
    if (this.frame && activeId) {
      const inkSegs: number[] = [];
      for (const s of strokes) this.outlineSegments(this.frame, s, false, inkSegs);
      const l = this.fatLines(inkSegs, this.fatMaterial(ACCENT, 2.4, 1, true), 12);
      if (l) this.sketchGroup.add(l);
      if (pending.length) {
        const segs: number[] = [];
        this.outlineSegments(this.frame, pending, false, segs);
        // Vertex ticks so single placed points are visible before a second tap.
        const t = 4 / this.zoom;
        for (const [x, y] of pending) {
          segs.push(...toWorld(this.frame, [x - t, y]), ...toWorld(this.frame, [x + t, y]));
          segs.push(...toWorld(this.frame, [x, y - t]), ...toWorld(this.frame, [x, y + t]));
        }
        const dl = this.fatLines(segs, this.fatMaterial(SKETCH, 2, 1, true), 12);
        if (dl) this.sketchGroup.add(dl);
      }
    }
    this.requestRender();
  }

  private rebuildLive() {
    this.clearGroup(this.liveGroup);
    if (!this.frame) return;
    const segs: number[] = [];
    if (this.gesture?.kind === "ink") this.outlineSegments(this.frame, this.gesture.pts, false, segs);
    if (this.preview) this.outlineSegments(this.frame, profilePolygon(this.preview, 64), true, segs);
    const l = this.fatLines(segs, this.fatMaterial(ACCENT, 2.4, 1, true), 13);
    if (l) this.liveGroup.add(l);
    this.requestRender();
  }

  private rebuildSelection() {
    const sel = selection.value;
    this.clearGroup(this.selGroup);
    const data = this.data;
    if (data) {
      for (const f of sel.faces) {
        const grp = data.faceGroups.find((g) => g.faceId === f.faceId);
        if (!grp) continue;
        const g = new BufferGeometry();
        g.setAttribute("position", this.body.geometry.getAttribute("position"));
        g.setIndex(new BufferAttribute(data.indices.subarray(grp.start, grp.start + grp.count), 1));
        const m = new Mesh(
          g,
          new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
        );
        m.renderOrder = 2;
        this.selGroup.add(m);
      }
      const segs: number[] = [];
      for (const e of sel.edges) {
        const grp = data.edgeGroups.find((g) => g.edgeId === e.edgeId);
        if (grp) for (let i = grp.start * 3; i < (grp.start + grp.count) * 3; i++) segs.push(data.lines[i]);
      }
      const l = this.fatLines(segs, this.fatMaterial(ACCENT, 4, 1, true), 6);
      if (l) this.selGroup.add(l);
    }
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

  /** Camera that frames everything visible, for a given orientation. */
  private fitParams(q: Quaternion): [Vector3, Quaternion, number] {
    const pts: Vector3[] = [];
    const bb = this.body.visible ? this.body.geometry.boundingBox : null;
    if (bb)
      for (const x of [bb.min.x, bb.max.x])
        for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) pts.push(new Vector3(x, y, z));
    const used = consumedSketches(doc.peek());
    for (const f of doc.peek().features) {
      if (f.type !== "sketch" || (f.id !== this.sketchId && (used.has(f.id) || f.suppressed))) continue;
      const frame = planeFrame(f.plane);
      for (const p of f.profiles) for (const q2 of profilePolygon(p, 12)) pts.push(vec(toWorld(frame, q2)));
    }
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
    const zoom = Math.min(400, 0.78 * Math.min(availW / Math.max(r1 - r0, 1e-3), availH / Math.max(u1 - u0, 1e-3)));
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

  /** Re-frame only if the part has grown off screen or shrunk to a speck (after Claude edits). */
  fitIfNeeded() {
    const bb = this.body.visible ? this.body.geometry.boundingBox : null;
    if (!bb || this.frame) return;
    const to = this.fitParams(this.quat);
    let outside = false;
    for (const x of [bb.min.x, bb.max.x])
      for (const y of [bb.min.y, bb.max.y])
        for (const z of [bb.min.z, bb.max.z]) {
          const p = this.project([x, y, z]);
          if (p.x < 0 || p.x > this.width || p.y < this.insets.top - 20 || p.y > this.height - this.insets.bottom + 20) outside = true;
        }
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
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.down = { ...p, t: performance.now() };
      this.moved = false;
      this.multi = false;
      this.gesture = this.beginSingle(e, p);
    } else if (this.pointers.size === 2) {
      this.multi = true;
      this.abortSingle();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  private beginSingle(e: PointerEvent, p: { x: number; y: number }): Gesture {
    if (e.button === 1 || e.button === 2 || e.shiftKey) return { kind: "pan" };
    const m = mode.peek();
    if (m.kind !== "sketch" || !this.frame) return { kind: "orbit" };
    const at = this.planePoint(p.x, p.y);
    if (!at) return { kind: "pan" };
    switch (m.tool) {
      case "ink":
        return { kind: "ink", pts: [at] };
      case "rect":
      case "circle":
        return { kind: m.tool, start: this.snap(at) };
      case "select": {
        const i = this.pickProfile(at);
        const sk = activeSketch();
        if (i === null || !sk) return { kind: "pan" };
        if (m.selected !== i) mode.value = { ...m, selected: i };
        return { kind: "move", index: i, start: at, original: sk.profiles, moved: false };
      }
      default:
        return { kind: "pan" };
    }
  }

  private abortSingle() {
    const g = this.gesture;
    if (g?.kind === "move" && g.moved) setProfiles(g.original, false);
    this.gesture = { kind: "none" };
    this.preview = null;
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
    if (this.multi || !this.gesture) return;
    if (!this.moved && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 7) this.moved = true;
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
      case "rect":
      case "circle": {
        const raw = this.planePoint(p.x, p.y);
        if (!raw) break;
        const at = this.snap(raw);
        const s = gridStep.peek();
        if (g.kind === "rect") {
          const w = Math.abs(at[0] - g.start[0]);
          const h = Math.abs(at[1] - g.start[1]);
          this.preview = w >= s && h >= s ? { type: "rect", cx: (at[0] + g.start[0]) / 2, cy: (at[1] + g.start[1]) / 2, w, h } : null;
        } else {
          const d = Math.round((2 * Math.hypot(raw[0] - g.start[0], raw[1] - g.start[1])) / s) * s;
          this.preview = d >= s ? { type: "circle", cx: g.start[0], cy: g.start[1], d } : null;
        }
        this.rebuildLive();
        break;
      }
      case "move": {
        const at = this.planePoint(p.x, p.y);
        if (!at) break;
        const [mx, my] = this.snap([at[0] - g.start[0], at[1] - g.start[1]]);
        g.moved = true;
        setProfiles(
          g.original.map((pr, i) => (i === g.index ? moveProfile(pr, mx, my) : pr)),
          false,
        );
        break;
      }
    }
  }

  private onUp(e: PointerEvent, cancelled = false) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size > 0) return;
    const p = this.local(e);
    const g = this.gesture;
    this.gesture = null;
    if (this.multi || !g) {
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
      this.preview = null;
      this.rebuildLive();
      this.tap(p.x, p.y);
      return;
    }
    switch (g.kind) {
      case "ink":
        if (g.pts.length > 3) ink.value = [...ink.value, this.thin(g.pts)];
        break;
      case "rect":
      case "circle":
        if (this.preview) addProfile(this.preview);
        break;
      case "move":
        if (g.moved) {
          // Re-apply as one recorded step so undo restores the pre-drag position.
          const final = activeSketch()?.profiles;
          if (final) {
            setProfiles(g.original, false);
            setProfiles(final, true);
          }
        }
        break;
    }
    this.preview = null;
    this.rebuildLive();
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

  private pickProfile(at: Vec2): number | null {
    const sk = activeSketch();
    if (!sk) return null;
    const reach = 16 / this.zoom;
    let best: number | null = null;
    let bestD = reach;
    let inside: number | null = null;
    let insideArea = Infinity;
    sk.profiles.forEach((p, i) => {
      const poly = profilePolygon(p, 48);
      const d = distToOutline(at, poly);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      const area = Math.abs(polygonArea(poly));
      if (pointInPolygon(at, poly) && area < insideArea) {
        insideArea = area;
        inside = i;
      }
    });
    return best ?? inside;
  }

  private tap(x: number, y: number) {
    const m = mode.peek();
    if (m.kind === "sketch") return this.tapSketch(x, y, m);
    numPrompt.value = null;
    const pick = this.pick(x, y);
    const sel = selection.peek();
    if (!pick) {
      if (sel.faces.length || sel.edges.length) selection.value = { faces: [], edges: [] };
      if (treeSelected.peek()) treeSelected.value = null;
      return;
    }
    if ("normal" in pick) {
      const has = sel.faces.some((f) => f.faceId === pick.faceId);
      selection.value = { ...sel, faces: has ? sel.faces.filter((f) => f.faceId !== pick.faceId) : [...sel.faces, pick] };
    } else {
      const has = sel.edges.some((f) => f.edgeId === pick.edgeId);
      selection.value = { ...sel, edges: has ? sel.edges.filter((f) => f.edgeId !== pick.edgeId) : [...sel.edges, pick] };
    }
  }

  private tapSketch(x: number, y: number, m: Extract<ReturnType<typeof mode.peek>, { kind: "sketch" }>) {
    const at = this.planePoint(x, y);
    const sk = activeSketch();
    if (!at || !sk) return;
    if (m.tool === "line") {
      const pts = draft.peek();
      const first = pts[0] && this.projectSketch(pts[0]);
      if (pts.length >= 3 && first && Math.hypot(first.x - x, first.y - y) < 22) {
        draft.value = [];
        addProfile({ type: "polygon", points: pts });
      } else draft.value = [...pts, this.snap(at)];
    } else if (m.tool === "erase") {
      const reach = 18 / this.zoom;
      const strokes = ink.peek();
      const hit = strokes.findIndex((s) => distToOutline(at, s, false) < reach);
      if (hit >= 0) ink.value = strokes.filter((_, i) => i !== hit);
      else {
        const i = this.pickProfile(at);
        if (i !== null) setProfiles(sk.profiles.filter((_, k) => k !== i));
      }
    } else if (m.tool === "select") {
      const i = this.pickProfile(at);
      if (i !== m.selected) mode.value = { ...m, selected: i };
    }
  }

  /** Nearest visible edge within finger reach, otherwise the face under the tap. */
  private pick(x: number, y: number): FacePick | EdgePick | null {
    const data = this.data;
    if (!data || !this.body.visible) return null;
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.body, false)[0];
    const { back } = this.basis();
    const depth = (p: Vector3) => -p.dot(back); // larger = farther from the camera

    let bestGroup = -1;
    let bestDist = 15;
    let bestDepth = Infinity;
    const a = new Vector3();
    const b = new Vector3();
    const tapPt: Vec2 = [x, y];
    data.edgeGroups.forEach((grp, gi) => {
      for (let v = grp.start; v + 1 < grp.start + grp.count; v += 2) {
        a.fromArray(data.lines, v * 3);
        b.fromArray(data.lines, v * 3 + 3);
        const pa = this.project([a.x, a.y, a.z]);
        const pb = this.project([b.x, b.y, b.z]);
        const d = distToOutline(tapPt, [[pa.x, pa.y], [pb.x, pb.y]], false);
        if (d > 15) continue;
        const dep = Math.min(depth(a), depth(b));
        // Skip edges hidden behind the face under the finger.
        if (hit && dep > depth(hit.point) + Math.max(0.5, 6 / this.zoom)) continue;
        if (d < bestDist - 3 || (d < bestDist + 3 && dep < bestDepth)) {
          bestDist = d;
          bestDepth = dep;
          bestGroup = gi;
        }
      }
    });
    if (bestGroup >= 0) {
      const grp = data.edgeGroups[bestGroup];
      // A vertex in the middle of the tessellated edge lies on the edge itself.
      const mid = grp.start + Math.floor(grp.count / 4) * 2;
      const p0 = new Vector3().fromArray(data.lines, mid * 3);
      const p1 = new Vector3().fromArray(data.lines, mid * 3 + 3);
      const pt = grp.count > 2 ? p0 : p0.add(p1).multiplyScalar(0.5);
      return { edgeId: grp.edgeId, point: [pt.x, pt.y, pt.z] };
    }
    if (!hit || hit.faceIndex == null || !hit.face) return null;
    const idx = hit.faceIndex * 3;
    const grp = data.faceGroups.find((g) => idx >= g.start && idx < g.start + g.count);
    if (!grp) return null;
    const n0 = new Vector3().fromArray(data.normals, data.indices[grp.start] * 3);
    let planar = true;
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    const n = new Vector3();
    const v = new Vector3();
    for (let i = grp.start; i < grp.start + grp.count; i++) {
      const vi = data.indices[i] * 3;
      if (planar && n.fromArray(data.normals, vi).dot(n0) < 0.9999) planar = false;
      v.fromArray(data.positions, vi);
      min.min(v);
      max.max(v);
    }
    const tri = [hit.face.a, hit.face.b, hit.face.c].map((i) => new Vector3().fromArray(data.positions, i * 3));
    const on = tri[0].add(tri[1]).add(tri[2]).multiplyScalar(1 / 3);
    const centre = min.add(max).multiplyScalar(0.5);
    return {
      faceId: grp.faceId,
      point: [on.x, on.y, on.z],
      center: [centre.x, centre.y, centre.z],
      normal: [n0.x, n0.y, n0.z],
      planar,
    };
  }

  /** Background colour is CSS; this only tints the clear colour for snapshots. */
  setBackground(color: string) {
    this.renderer.setClearColor(new Color(color), 0);
  }
}

let instance: Viewport | null = null;
export const viewport = () => instance;
export function createViewport(container: HTMLElement): Viewport {
  instance ??= new Viewport(container);
  return instance;
}

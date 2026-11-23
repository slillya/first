// 2D sketch geometry that does not need the CAD kernel: plane frames,
// profile outlines for drawing and picking, hole nesting, and the offline
// recogniser that turns a finger stroke into a clean profile.
import type { PlaneRef, Profile, Vec2, Vec3 } from "./schema";

export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  n: Vec3;
}

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** Right-handed frame (x, y, n) of a sketch plane, y = n × x. */
export function planeFrame(plane: PlaneRef): Frame {
  if ("base" in plane) {
    const off = plane.offset ?? 0;
    const f: Record<string, [Vec3, Vec3]> = {
      XY: [
        [1, 0, 0],
        [0, 0, 1],
      ],
      XZ: [
        [1, 0, 0],
        [0, -1, 0],
      ],
      YZ: [
        [0, 1, 0],
        [1, 0, 0],
      ],
    };
    const [x, n] = f[plane.base];
    return { origin: v3.scale(n, off), x, y: v3.cross(n, x), n };
  }
  const n = v3.norm(plane.normal as Vec3);
  // Re-orthogonalise xDir against the normal so a slightly-off input still works.
  let x = plane.xDir as Vec3;
  x = v3.sub(x, v3.scale(n, v3.dot(x, n)));
  if (v3.len(x) < 1e-9) x = Math.abs(n[2]) < 0.9 ? v3.cross([0, 0, 1], n) : [1, 0, 0];
  x = v3.norm(x);
  return { origin: plane.origin as Vec3, x, y: v3.cross(n, x), n };
}

export function toWorld(f: Frame, p: Vec2): Vec3 {
  return [
    f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1],
    f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1],
    f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1],
  ];
}

export function toPlane(f: Frame, p: Vec3): Vec2 {
  const d = v3.sub(p, f.origin);
  return [v3.dot(d, f.x), v3.dot(d, f.y)];
}

/** A natural sketch frame for a planar face given a point on it and its outward normal. */
export function frameForFace(point: Vec3, normal: Vec3): Frame {
  const n = v3.norm(normal);
  // Keep sketch "up" as close to world Z as the face allows (world Y for horizontal faces).
  const upRef: Vec3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const x = v3.norm(v3.cross(upRef, n));
  return { origin: point, x, y: v3.cross(n, x), n };
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const clean = (v: number) => Math.round(v * 1e4) / 1e4;

/** Closed outline of a profile as a polygon (curves tessellated). */
export function profilePolygon(p: Profile, segs = 48): Vec2[] {
  switch (p.type) {
    case "circle": {
      const r = p.d / 2;
      return Array.from({ length: segs }, (_, i) => {
        const a = (i / segs) * Math.PI * 2;
        return [p.cx + r * Math.cos(a), p.cy + r * Math.sin(a)] as Vec2;
      });
    }
    case "rect": {
      const hw = p.w / 2;
      const hh = p.h / 2;
      const r = Math.min(p.r ?? 0, hw, hh);
      let pts: Vec2[] = [];
      if (r > 1e-9) {
        const q = Math.max(3, Math.round(segs / 4));
        const corners: [number, number, number][] = [
          [hw - r, hh - r, 0],
          [-hw + r, hh - r, 90],
          [-hw + r, -hh + r, 180],
          [hw - r, -hh + r, 270],
        ];
        for (const [cx, cy, a0] of corners)
          for (let i = 0; i <= q; i++) {
            const a = ((a0 + (90 * i) / q) * Math.PI) / 180;
            pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
          }
      } else
        pts = [
          [hw, hh],
          [-hw, hh],
          [-hw, -hh],
          [hw, -hh],
        ];
      const a = ((p.angle ?? 0) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return pts.map(([x, y]) => [p.cx + x * c - y * s, p.cy + x * s + y * c] as Vec2);
    }
    case "polygon":
      return p.points.map((q) => [q[0], q[1]] as Vec2);
    case "slot": {
      const dx = p.x2 - p.x1;
      const dy = p.y2 - p.y1;
      const base = Math.atan2(dy, dx);
      const r = p.w / 2;
      const q = Math.max(4, Math.round(segs / 2));
      const pts: Vec2[] = [];
      for (let i = 0; i <= q; i++) {
        const a = base - Math.PI / 2 + (Math.PI * i) / q;
        pts.push([p.x2 + r * Math.cos(a), p.y2 + r * Math.sin(a)]);
      }
      for (let i = 0; i <= q; i++) {
        const a = base + Math.PI / 2 + (Math.PI * i) / q;
        pts.push([p.x1 + r * Math.cos(a), p.y1 + r * Math.sin(a)]);
      }
      return pts;
    }
  }
}

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function distToOutline(p: Vec2, pts: Vec2[], closed = true): number {
  let d = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) d = Math.min(d, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}

/**
 * How deeply each profile is nested inside the others. Even depth = material,
 * odd depth = hole, which is how a sketch with a circle inside a rectangle
 * extrudes to a plate with a hole.
 */
export function nestingDepths(profiles: Profile[]): number[] {
  const polys = profiles.map((p) => profilePolygon(p, 32));
  const areas = polys.map((p) => Math.abs(polygonArea(p)));
  return polys.map((poly, i) => {
    let depth = 0;
    for (let j = 0; j < polys.length; j++) {
      if (j === i || areas[j] <= areas[i]) continue;
      // Nested only if every sampled vertex is inside the bigger profile.
      const step = Math.max(1, Math.floor(poly.length / 8));
      let all = true;
      for (let k = 0; k < poly.length; k += step)
        if (!pointInPolygon(poly[k], polys[j])) {
          all = false;
          break;
        }
      if (all) depth++;
    }
    return depth;
  });
}

export function moveProfile(p: Profile, dx: number, dy: number): Profile {
  switch (p.type) {
    case "rect":
    case "circle":
      return { ...p, cx: clean(p.cx + dx), cy: clean(p.cy + dy) };
    case "polygon":
      return { ...p, points: p.points.map((q) => [clean(q[0] + dx), clean(q[1] + dy)]) };
    case "slot":
      return { ...p, x1: clean(p.x1 + dx), y1: clean(p.y1 + dy), x2: clean(p.x2 + dx), y2: clean(p.y2 + dy) };
  }
}

export function profileCenter(p: Profile): Vec2 {
  if (p.type === "rect" || p.type === "circle") return [p.cx, p.cy];
  if (p.type === "slot") return [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2];
  const n = p.points.length;
  return [p.points.reduce((s, q) => s + q[0], 0) / n, p.points.reduce((s, q) => s + q[1], 0) / n];
}

// ---------------------------------------------------------------------------
// Stroke recognition

/** Ramer–Douglas–Peucker simplification of an open polyline. */
export function simplify(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (idx >= 0 && worst > eps) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Best guess at what a single finger stroke was meant to be. Returns null for
 * strokes that are not a closed shape (those stay as ink for Claude to read).
 */
export function recognizeStroke(raw: Vec2[], snap = 1): Profile | null {
  if (raw.length < 6) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of raw) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < snap * 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.3 * diag) return null;

  // Circle: radius from the centroid is nearly constant.
  const cx = raw.reduce((s, p) => s + p[0], 0) / raw.length;
  const cy = raw.reduce((s, p) => s + p[1], 0) / raw.length;
  const radii = raw.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  const rMean = radii.reduce((s, r) => s + r, 0) / radii.length;
  const rDev = Math.sqrt(radii.reduce((s, r) => s + (r - rMean) ** 2, 0) / radii.length) / rMean;
  const aspect = Math.min(w, h) / Math.max(w, h);

  // Corners of the stroke treated as a closed loop.
  let corners = simplify([...raw, first], diag * 0.07);
  corners.pop();
  if (corners.length > 3) {
    const a = corners[0];
    const b = corners[corners.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < diag * 0.12) corners.pop();
  }
  // Drop vertices that sit on a nearly straight run.
  corners = corners.filter((p, i) => {
    const a = corners[(i - 1 + corners.length) % corners.length];
    const b = corners[(i + 1) % corners.length];
    const ang = Math.abs(
      Math.atan2(
        (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]),
        (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]),
      ),
    );
    return ang > 0.35;
  });

  if (rDev < 0.1 && aspect > 0.75 && corners.length !== 4) {
    const d = Math.max(snap, round(rMean * 2, snap));
    return { type: "circle", cx: round(cx, snap), cy: round(cy, snap), d };
  }

  if (corners.length === 4) {
    const edges = corners.map((p, i) => {
      const q = corners[(i + 1) % 4];
      return [q[0] - p[0], q[1] - p[1]] as Vec2;
    });
    const square = edges.every((e, i) => {
      const f = edges[(i + 1) % 4];
      const cos = (e[0] * f[0] + e[1] * f[1]) / (Math.hypot(...e) * Math.hypot(...f));
      return Math.abs(cos) < 0.35;
    });
    if (square) {
      let ang = (Math.atan2(edges[0][1], edges[0][0]) * 180) / Math.PI;
      ang = ((ang % 90) + 90) % 90;
      if (ang > 45) ang -= 90;
      if (Math.abs(ang) < 12)
        return {
          type: "rect",
          cx: round((minX + maxX) / 2, snap / 2),
          cy: round((minY + maxY) / 2, snap / 2),
          w: Math.max(snap, round(w, snap)),
          h: Math.max(snap, round(h, snap)),
        };
      const l0 = (Math.hypot(...edges[0]) + Math.hypot(...edges[2])) / 2;
      const l1 = (Math.hypot(...edges[1]) + Math.hypot(...edges[3])) / 2;
      const along = Math.abs(Math.atan2(edges[0][1], edges[0][0]) - (ang * Math.PI) / 180) % Math.PI;
      const xFirst = along < Math.PI / 4 || along > (3 * Math.PI) / 4;
      return {
        type: "rect",
        cx: round(corners.reduce((s, p) => s + p[0], 0) / 4, snap / 2),
        cy: round(corners.reduce((s, p) => s + p[1], 0) / 4, snap / 2),
        w: Math.max(snap, round(xFirst ? l0 : l1, snap)),
        h: Math.max(snap, round(xFirst ? l1 : l0, snap)),
        angle: Math.round(ang / 5) * 5,
      };
    }
  }

  if (rDev < 0.14 && aspect > 0.75 && corners.length > 6) {
    const d = Math.max(snap, round(rMean * 2, snap));
    return { type: "circle", cx: round(cx, snap), cy: round(cy, snap), d };
  }

  if (corners.length >= 3 && corners.length <= 16) {
    const pts = corners.map((p) => [round(p[0], snap), round(p[1], snap)]);
    // Snap nearly-horizontal / nearly-vertical edges square.
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const dx = Math.abs(pts[j][0] - pts[i][0]);
      const dy = Math.abs(pts[j][1] - pts[i][1]);
      if (dx && dx < 0.12 * dy) pts[j][0] = pts[i][0];
      else if (dy && dy < 0.12 * dx) pts[j][1] = pts[i][1];
    }
    if (Math.abs(polygonArea(pts as Vec2[])) < snap * snap) return null;
    return { type: "polygon", points: pts };
  }
  return null;
}

/** Grid/snap step (mm) that stays comfortably visible at the current zoom. */
export function niceStep(pxPerMm: number, minPx = 5): number {
  for (const s of [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 500, 1000]) if (s * pxPerMm >= minPx) return s;
  return 1000;
}

export function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

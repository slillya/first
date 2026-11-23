// Recovers the geometric meaning of tessellated faces and edges: is this face
// flat or round, where is its axis, is this edge straight or a circle. Mates
// and sketch references need that, and the mesh is all the UI thread has.
import type { MeshData } from "../kernel/protocol";
import { v3 } from "../model/geom2d";
import type { Vec3 } from "../model/schema";

export type FaceInfo =
  | { kind: "plane"; origin: Vec3; normal: Vec3; center: Vec3 }
  | { kind: "cylinder"; origin: Vec3; axis: Vec3; radius: number; center: Vec3 }
  | { kind: "other"; center: Vec3 };

export type EdgeInfo =
  | { kind: "line"; origin: Vec3; dir: Vec3; mid: Vec3; a: Vec3; b: Vec3 }
  | { kind: "circle"; center: Vec3; axis: Vec3; radius: number; mid: Vec3; a: Vec3; b: Vec3 }
  | { kind: "other"; mid: Vec3; a: Vec3; b: Vec3 };

const at = (arr: Float32Array, i: number): Vec3 => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];

export function faceInfo(data: MeshData, group: { start: number; count: number }): FaceInfo {
  const idx: number[] = [];
  const seen = new Set<number>();
  for (let i = group.start; i < group.start + group.count; i++) {
    const v = data.indices[i];
    if (!seen.has(v)) {
      seen.add(v);
      idx.push(v);
    }
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of idx) {
    const p = at(data.positions, v);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  const center = v3.scale(v3.add(min, max), 0.5);
  const n0 = v3.norm(at(data.normals, idx[0]));
  if (idx.every((v) => v3.dot(v3.norm(at(data.normals, v)), n0) > 0.99995)) return { kind: "plane", origin: at(data.positions, idx[0]), normal: n0, center };

  // Cylinder: every normal is square to one axis, and stepping back along the normal by the radius lands on it.
  let other: Vec3 | null = null;
  let otherAt = -1;
  for (const v of idx) {
    const n = v3.norm(at(data.normals, v));
    if (Math.abs(v3.dot(n, n0)) < 0.95) {
      other = n;
      otherAt = v;
      break;
    }
  }
  if (other) {
    const axis = v3.norm(v3.cross(n0, other));
    if (idx.every((v) => Math.abs(v3.dot(v3.norm(at(data.normals, v)), axis)) < 2e-3)) {
      const flat = (p: Vec3) => v3.sub(p, v3.scale(axis, v3.dot(p, axis)));
      const dp = flat(v3.sub(at(data.positions, idx[0]), at(data.positions, otherAt)));
      const dn = v3.sub(n0, other);
      // Signed radius: positive for a boss (normals point away from the axis), negative for a hole.
      const rs = v3.dot(dp, dn) / v3.dot(dn, dn);
      const origin = v3.sub(at(data.positions, idx[0]), v3.scale(n0, rs));
      const ok = idx.every((v) => {
        const d = flat(v3.sub(at(data.positions, v), origin));
        return Math.abs(v3.len(d) - Math.abs(rs)) < 1e-3 * (1 + Math.abs(rs));
      });
      if (ok && Math.abs(rs) > 1e-6) return { kind: "cylinder", origin, axis, radius: Math.abs(rs), center };
    }
  }
  return { kind: "other", center };
}

export function edgeInfo(data: MeshData, group: { start: number; count: number }): EdgeInfo {
  const a = at(data.lines, group.start);
  const b = at(data.lines, group.start + group.count - 1);
  const segs = group.count / 2;
  const midSeg = group.start + Math.floor(segs / 2) * 2;
  const mid = segs === 1 ? v3.scale(v3.add(a, b), 0.5) : at(data.lines, midSeg);
  if (segs === 1) return { kind: "line", origin: a, dir: v3.norm(v3.sub(b, a)), mid, a, b };
  // Three well-spread points give the circle; the rest must lie on it.
  const p1 = a;
  const p2 = at(data.lines, group.start + Math.floor(segs / 3) * 2);
  const p3 = at(data.lines, group.start + Math.floor((2 * segs) / 3) * 2);
  const u = v3.sub(p2, p1);
  const w = v3.sub(p3, p1);
  const n = v3.cross(u, w);
  const n2 = v3.dot(n, n);
  if (n2 > 1e-12) {
    const toCenter = v3.scale(v3.add(v3.scale(v3.cross(n, u), v3.dot(w, w)), v3.scale(v3.cross(w, n), v3.dot(u, u))), 1 / (2 * n2));
    const center = v3.add(p1, toCenter);
    const radius = v3.len(toCenter);
    const axis = v3.norm(n);
    let ok = true;
    for (let i = group.start; i < group.start + group.count; i++) {
      const d = v3.sub(at(data.lines, i), center);
      if (Math.abs(v3.len(d) - radius) > 2e-3 * (1 + radius) || Math.abs(v3.dot(d, axis)) > 2e-3 * (1 + radius)) ok = false;
    }
    if (ok) return { kind: "circle", center, axis, radius, mid, a, b };
  }
  return { kind: "other", mid, a, b };
}

/**
 * The model's pickable corners: places where a straight edge ends, or where
 * three or more edges meet. The joint between the two arcs that make up a
 * round rim is not a corner and is left out.
 */
export function meshVertices(data: MeshData): Vec3[] {
  const seen = new Map<string, { p: Vec3; edges: number; straight: boolean }>();
  for (const g of data.edgeGroups) {
    const ends = [g.start, g.start + g.count - 1].map((i) => at(data.lines, i));
    const keys = ends.map((p) => p.map((c) => Math.round(c * 1e4)).join(","));
    if (keys[0] === keys[1]) continue; // a closed curve has no ends
    ends.forEach((p, i) => {
      const v = seen.get(keys[i]) ?? { p, edges: 0, straight: false };
      v.edges++;
      if (g.count === 2) v.straight = true;
      seen.set(keys[i], v);
    });
  }
  return [...seen.values()].filter((v) => v.straight || v.edges >= 3).map((v) => v.p);
}

export function faceGroupAt(data: MeshData, triangle: number) {
  const idx = triangle * 3;
  return data.faceGroups.find((g) => idx >= g.start && idx < g.start + g.count);
}

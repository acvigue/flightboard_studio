// Pure path editing: open polylines (LineFeature.pts) and closed rings (PolyFeature.rings). Everything here is
// unit-agnostic (the store works in metres and converts mm tolerances with the board scale). Rings are handled
// without the repeated closing point; `normRing` strips one if present.
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js'
import type { Pt } from './model'
import * as gm from './geom'

export interface PathRef {
  id: string
  ring: number
  idx: number // vertex index, or the segment idx -> idx+1 (wrapping on rings)
}
export const refKey = (r: PathRef): string => `${r.id}:${r.ring}:${r.idx}`
export const sameRef = (a: PathRef, b: PathRef): boolean => a.id === b.id && a.ring === b.ring && a.idx === b.idx

const eq = (a: Pt, b: Pt, eps = 1e-9): boolean => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps

/** Ring without the repeated closing point. */
export function normRing(r: Pt[]): Pt[] {
  return r.length > 3 && eq(r[0], r[r.length - 1]) ? r.slice(0, -1) : r.slice()
}
export const segCount = (pts: Pt[], closed: boolean): number => (closed ? pts.length : Math.max(0, pts.length - 1))
export const segEnd = (pts: Pt[], i: number, closed: boolean): Pt => pts[closed ? (i + 1) % pts.length : i + 1]
export function segPoint(pts: Pt[], i: number, t: number, closed: boolean): Pt {
  const a = pts[i]
  const b = segEnd(pts, i, closed)
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}
export function segMid(pts: Pt[], i: number, closed: boolean): Pt {
  return segPoint(pts, i, 0.5, closed)
}
/** Nearest segment of a path to p: index, parameter along it, the foot point and its distance. */
export function nearestSegment(p: Pt, pts: Pt[], closed: boolean): { idx: number; t: number; q: Pt; d: number } | null {
  let best: { idx: number; t: number; q: Pt; d: number } | null = null
  const n = segCount(pts, closed)
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = segEnd(pts, i, closed)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy || 1e-12
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    const q: Pt = [a[0] + t * dx, a[1] + t * dy]
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (!best || d < best.d) best = { idx: i, t, q, d }
  }
  return best
}
export function pathLength(pts: Pt[], closed: boolean): number {
  let s = 0
  const n = segCount(pts, closed)
  for (let i = 0; i < n; i++) {
    const b = segEnd(pts, i, closed)
    s += Math.hypot(b[0] - pts[i][0], b[1] - pts[i][1])
  }
  return s
}
export function ringArea(r: Pt[]): number {
  let a = 0
  for (let i = 0; i < r.length; i++) {
    const p = r[i]
    const q = r[(i + 1) % r.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a) / 2
}
export function polyArea(rings: Pt[][]): number {
  return rings.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * ringArea(normRing(r)), 0)
}

// ---------------------------------------------------------------- vertex level
/** Insert p after vertex idx. */
export function insertVertex(pts: Pt[], idx: number, p: Pt): Pt[] {
  const out = pts.slice()
  out.splice(idx + 1, 0, p)
  return out
}
export function removeVertices(pts: Pt[], idxs: number[]): Pt[] {
  const drop = new Set(idxs)
  return pts.filter((_, i) => !drop.has(i))
}
/** Remove the vertices strictly between the lowest and highest selected index (open path). */
export function straightenOpen(pts: Pt[], idxs: number[]): Pt[] {
  if (idxs.length < 2) return pts.slice()
  const lo = Math.min(...idxs)
  const hi = Math.max(...idxs)
  return pts.filter((_, i) => i <= lo || i >= hi)
}
/** Ring: remove the vertices on the shorter arc between the two extreme selected vertices. */
export function straightenRing(ring: Pt[], idxs: number[]): Pt[] {
  if (idxs.length < 2) return ring.slice()
  const n = ring.length
  const s = [...new Set(idxs)].sort((a, b) => a - b)
  // largest gap between consecutive selected indices (cyclic) is the arc we keep
  let bestGap = -1
  let start = 0
  for (let k = 0; k < s.length; k++) {
    const a = s[k]
    const b = s[(k + 1) % s.length]
    const gap = ((b - a) % n + n) % n || n
    if (gap > bestGap) {
      bestGap = gap
      start = b
    }
  }
  // keep from `start` going forward bestGap steps (inclusive both ends), drop the rest that is not selected
  const keep = new Set<number>()
  for (let k = 0; k <= bestGap; k++) keep.add((start + k) % n)
  for (const i of s) keep.add(i)
  return ring.filter((_, i) => keep.has(i))
}

// ---------------------------------------------------------------- segment level
/** Remove segment idx of an open path: the two remaining pieces (single-vertex pieces are dropped). */
export function removeSegmentOpen(pts: Pt[], idx: number): Pt[][] {
  const a = pts.slice(0, idx + 1)
  const b = pts.slice(idx + 1)
  return [a, b].filter((x) => x.length >= 2)
}
/** Remove segment idx of a ring: the ring opened into a path starting at idx+1 and ending at idx. */
export function removeSegmentRing(ring: Pt[], idx: number): Pt[] {
  const n = ring.length
  const out: Pt[] = []
  for (let k = 1; k <= n; k++) out.push(ring[(idx + k) % n])
  return out
}
/** Disconnect an open path at vertex idx: two paths sharing that point. */
export function splitAtVertexOpen(pts: Pt[], idx: number): Pt[][] {
  if (idx <= 0 || idx >= pts.length - 1) return [pts.slice()]
  return [pts.slice(0, idx + 1), pts.slice(idx)]
}
/** Open a ring at vertex idx: path that starts and ends at that vertex (shape unchanged). */
export function openRingAtVertex(ring: Pt[], idx: number): Pt[] {
  const n = ring.length
  const out: Pt[] = []
  for (let k = 0; k <= n; k++) out.push(ring[(idx + k) % n])
  return out
}
/** Cut an open path on segment idx at parameter t. */
export function cutOpenAt(pts: Pt[], idx: number, t: number): Pt[][] {
  if (t <= 1e-6) return splitAtVertexOpen(pts, idx)
  if (t >= 1 - 1e-6) return splitAtVertexOpen(pts, idx + 1)
  const p = segPoint(pts, idx, t, false)
  return [[...pts.slice(0, idx + 1), p], [p, ...pts.slice(idx + 1)]]
}
/** Open a ring at a point on segment idx. */
export function cutRingAt(ring: Pt[], idx: number, t: number): Pt[] {
  if (t <= 1e-6) return openRingAtVertex(ring, idx)
  if (t >= 1 - 1e-6) return openRingAtVertex(ring, (idx + 1) % ring.length)
  const p = segPoint(ring, idx, t, true)
  const n = ring.length
  const out: Pt[] = [p]
  for (let k = 1; k <= n; k++) out.push(ring[(idx + k) % n])
  out.push(p)
  return out
}
export const reversePts = (pts: Pt[]): Pt[] => pts.slice().reverse()

/** Join two open paths at their closest endpoints; reverses as needed. `bridge` false merges coincident ends. */
export function joinOpen(a: Pt[], b: Pt[], eps: number): { pts: Pt[]; gap: number } {
  const ends: [Pt, Pt, number, number][] = [
    [a[a.length - 1], b[0], 0, 0], // a end -> b start
    [a[a.length - 1], b[b.length - 1], 0, 1], // a end -> b end (reverse b)
    [a[0], b[0], 1, 0], // a start -> b start (reverse a)
    [a[0], b[b.length - 1], 1, 1] // a start -> b end (reverse both)
  ]
  let best = ends[0]
  let bd = Infinity
  for (const e of ends) {
    const d = Math.hypot(e[0][0] - e[1][0], e[0][1] - e[1][1])
    if (d < bd) {
      bd = d
      best = e
    }
  }
  const A = best[2] ? reversePts(a) : a.slice()
  const B = best[3] ? reversePts(b) : b.slice()
  const pts = bd <= eps ? [...A, ...B.slice(1)] : [...A, ...B]
  return { pts, gap: bd }
}
/** Close an open path into a ring (drops a duplicated end point). */
export function closeToRing(pts: Pt[]): Pt[] {
  return normRing(pts)
}
/** Ring to an open path with the shape preserved (closing point repeated). */
export function ringToOpen(ring: Pt[]): Pt[] {
  const r = normRing(ring)
  return [...r, r[0]]
}

// ---------------------------------------------------------------- smoothing / simplification
/** Chaikin corner cutting; end points of open paths are kept. */
export function chaikin(pts: Pt[], iters: number, closed: boolean): Pt[] {
  let cur = pts.slice()
  for (let it = 0; it < iters; it++) {
    const out: Pt[] = []
    const n = cur.length
    if (n < 3) return cur
    if (!closed) out.push(cur[0])
    const m = closed ? n : n - 1
    for (let i = 0; i < m; i++) {
      const a = cur[i]
      const b = cur[(i + 1) % n]
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    if (!closed) out.push(cur[n - 1])
    cur = out
  }
  return cur
}
export function simplifyPts(pts: Pt[], tol: number, closed: boolean): Pt[] {
  if (closed) {
    const g = gm.simplify(gm.polygon([pts]), tol)
    const polys = gm.polygonsOf(g)
    return polys.length ? normRing(gm.ringsOf(polys[0])[0]) : pts.slice()
  }
  const g = gm.simplify(gm.lineString(pts), tol)
  return g.isEmpty() ? pts.slice() : gm.ptsOf(g)
}
export function averagePts(list: Pt[], axis: 'x' | 'y' | 'both'): Pt {
  const n = list.length || 1
  const mx = list.reduce((s, p) => s + p[0], 0) / n
  const my = list.reduce((s, p) => s + p[1], 0) / n
  void axis
  return [mx, my]
}

// ---------------------------------------------------------------- area operations (JSTS)
export type Rings = Pt[][] // one polygon: exterior + holes
const toRings = (g: gm.G): Rings[] => gm.polygonsOf(g).map((p) => gm.ringsOf(p).map(normRing))
const polyG = (rings: Rings): gm.G => gm.polygon(rings)

export interface OffsetOpts {
  join?: 'round' | 'mitre' | 'bevel'
}
export function offsetPolygon(rings: Rings, dist: number, o: OffsetOpts = {}): Rings[] {
  return toRings(gm.buffer(polyG(rings), dist, { join: o.join ?? 'mitre', segs: 8 }))
}
/** Outline an open path as a polygon of the given total width (round caps and joins). */
export function outlineLine(pts: Pt[], width: number, o: OffsetOpts & { cap?: 'round' | 'flat' | 'square' } = {}): Rings[] {
  return toRings(gm.buffer(gm.lineString(pts), width / 2, { cap: o.cap ?? 'round', join: o.join ?? 'round', segs: 8 }))
}
/** One-sided parallel copy of an open path (positive = left of travel), as an open path. */
export function parallelLine(pts: Pt[], dist: number): Pt[] {
  const out: Pt[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    out.push([pts[i][0] - (dy / l) * dist, pts[i][1] + (dx / l) * dist])
  }
  return out
}

export type BoolOp = 'unite' | 'subtract' | 'intersect' | 'exclude' | 'divide'
/** Pathfinder over a list of polygons (the first is the "back" object for subtract). */
export function pathfinder(op: BoolOp, polys: Rings[]): Rings[] {
  const gs = polys.map(polyG).filter((g) => !g.isEmpty())
  if (!gs.length) return []
  if (op === 'unite') return toRings(gm.union(gs))
  if (op === 'subtract') return toRings(gs[0].difference(gm.union(gs.slice(1))))
  if (op === 'intersect') return toRings(gs.slice(1).reduce((acc, g) => acc.intersection(g), gs[0]))
  if (op === 'exclude') return toRings(gs.slice(1).reduce((acc, g) => acc.symDifference(g), gs[0]))
  // divide: every face formed by all boundaries that lies inside at least one input
  const noded = gm.union(gs.map((g) => g.getBoundary()))
  const pz = new Polygonizer()
  pz.add(noded)
  const faces: gm.G[] = pz.getPolygons().toArray()
  return faces.filter((f) => gs.some((g) => g.contains(f.getInteriorPoint()))).map((f) => gm.ringsOf(f).map(normRing))
}

/** Slice a polygon with the straight line a-b; null when the line does not cross it. */
export function knifePolygon(rings: Rings, a: Pt, b: Pt): Rings[] | null {
  const g = polyG(rings)
  const cut = gm.lineString([a, b])
  if (!g.intersects(cut)) return null
  const noded = gm.union([g.getBoundary(), cut])
  const pz = new Polygonizer()
  pz.add(noded)
  const faces: gm.G[] = pz.getPolygons().toArray()
  const inside = faces.filter((f) => g.contains(f.getInteriorPoint()))
  if (inside.length < 2) return null
  return inside.map((f) => gm.ringsOf(f).map(normRing))
}
/** Split an open path at every crossing with the straight line a-b; null when it does not cross. */
export function knifeLine(pts: Pt[], a: Pt, b: Pt): Pt[][] | null {
  const g = gm.lineString(pts)
  const cut = gm.lineString([a, b])
  if (!g.intersects(cut)) return null
  const pieces = gm.linesOf(g.difference(cut))
  if (pieces.length < 2) return null
  return pieces.map((p) => gm.ptsOf(p))
}
/** Polygon parts: the exterior and each hole as its own polygon. */
export function explodePolygon(rings: Rings): Rings[] {
  return rings.map((r) => [normRing(r)])
}
export function cleanPolygon(rings: Rings): Rings[] {
  return toRings(polyG(rings))
}

// ---------------------------------------------------------------- corners (Altium track corners / Illustrator live corners)
/**
 * Round (fillet) or cut (chamfer) the corner at each vertex in `idxs`. `size` is the fillet radius or the chamfer
 * setback along each edge, clamped to half of the shorter adjacent edge. Open-path end points are left alone.
 */
export function roundCorners(pts: Pt[], idxs: number[], size: number, closed: boolean, mode: 'fillet' | 'chamfer', arcSegs = 8): Pt[] {
  const want = new Set(idxs)
  const n = pts.length
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const v = pts[i]
    const isEnd = !closed && (i === 0 || i === n - 1)
    if (!want.has(i) || isEnd || n < 3) {
      out.push(v)
      continue
    }
    const prev = pts[(i - 1 + n) % n]
    const next = pts[(i + 1) % n]
    const l1 = Math.hypot(prev[0] - v[0], prev[1] - v[1])
    const l2 = Math.hypot(next[0] - v[0], next[1] - v[1])
    if (l1 < 1e-9 || l2 < 1e-9) {
      out.push(v)
      continue
    }
    const u1: Pt = [(prev[0] - v[0]) / l1, (prev[1] - v[1]) / l1]
    const u2: Pt = [(next[0] - v[0]) / l2, (next[1] - v[1]) / l2]
    const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))
    const theta = Math.acos(cos) // interior angle between the two edges
    if (theta < 1e-3 || Math.PI - theta < 1e-3) {
      out.push(v) // straight or folded back: nothing to round
      continue
    }
    const maxT = Math.min(l1, l2) / 2
    if (mode === 'chamfer') {
      const t = Math.min(size, maxT)
      out.push([v[0] + u1[0] * t, v[1] + u1[1] * t], [v[0] + u2[0] * t, v[1] + u2[1] * t])
      continue
    }
    let r = size
    let t = r / Math.tan(theta / 2)
    if (t > maxT) {
      t = maxT
      r = t * Math.tan(theta / 2)
    }
    const p1: Pt = [v[0] + u1[0] * t, v[1] + u1[1] * t]
    const p2: Pt = [v[0] + u2[0] * t, v[1] + u2[1] * t]
    const bis: Pt = [u1[0] + u2[0], u1[1] + u2[1]]
    const bl = Math.hypot(bis[0], bis[1]) || 1
    const h = r / Math.sin(theta / 2)
    const c: Pt = [v[0] + (bis[0] / bl) * h, v[1] + (bis[1] / bl) * h]
    const a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0])
    let a2 = Math.atan2(p2[1] - c[1], p2[0] - c[0])
    let da = a2 - a1
    while (da > Math.PI) da -= 2 * Math.PI
    while (da < -Math.PI) da += 2 * Math.PI
    a2 = a1 + da
    const segs = Math.max(2, Math.round((arcSegs * Math.abs(da)) / (Math.PI / 2)))
    for (let k = 0; k <= segs; k++) {
      const a = a1 + (da * k) / segs
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
    }
  }
  return out
}

/** Move the end of segment i (vertex i+1) so the segment has the given length, keeping its direction. */
export function setSegmentLength(pts: Pt[], i: number, len: number, closed: boolean): Pt[] {
  const out = pts.slice()
  const j = closed ? (i + 1) % pts.length : i + 1
  const a = pts[i]
  const b = pts[j]
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  out[j] = [a[0] + ((b[0] - a[0]) / l) * len, a[1] + ((b[1] - a[1]) / l) * len]
  return out
}
/** Rotate the end of segment i about its start to the given math angle (radians, CCW from +x in the path's frame). */
export function setSegmentAngle(pts: Pt[], i: number, rad: number, closed: boolean): Pt[] {
  const out = pts.slice()
  const j = closed ? (i + 1) % pts.length : i + 1
  const a = pts[i]
  const b = pts[j]
  const l = Math.hypot(b[0] - a[0], b[1] - a[1])
  out[j] = [a[0] + Math.cos(rad) * l, a[1] + Math.sin(rad) * l]
  return out
}

// ---------------------------------------------------------------- primitive shapes (points in the caller's frame)
export function rectPts(a: Pt, b: Pt, cornerR = 0): Pt[] {
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1], b[1])
  const r: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  return cornerR > 0 ? roundCorners(r, [0, 1, 2, 3], cornerR, true, 'fillet') : r
}
export function ellipsePts(c: Pt, rx: number, ry: number, segs = 64): Pt[] {
  const out: Pt[] = []
  for (let k = 0; k < segs; k++) {
    const a = (2 * Math.PI * k) / segs
    out.push([c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)])
  }
  return out
}
/** Regular polygon (star when inner > 0) centred on c, first vertex pointing towards `toward`. */
export function regularPts(c: Pt, toward: Pt, sides: number, inner = 0): Pt[] {
  const r = Math.hypot(toward[0] - c[0], toward[1] - c[1])
  const a0 = Math.atan2(toward[1] - c[1], toward[0] - c[0])
  const out: Pt[] = []
  const n = Math.max(3, Math.round(sides))
  for (let k = 0; k < n; k++) {
    const a = a0 + (2 * Math.PI * k) / n
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
    if (inner > 0) {
      const b = a + Math.PI / n
      out.push([c[0] + r * inner * Math.cos(b), c[1] + r * inner * Math.sin(b)])
    }
  }
  return out
}

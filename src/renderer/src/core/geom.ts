// Thin wrapper over JSTS (the JS port of JTS, the same engine as shapely/GEOS the Python generator used).
import 'jsts/org/locationtech/jts/monkey.js'
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js'
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js'
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js'
import BufferParameters from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js'
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js'
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js'
import LengthIndexedLine from 'jsts/org/locationtech/jts/linearref/LengthIndexedLine.js'
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js'
import LineMerger from 'jsts/org/locationtech/jts/operation/linemerge/LineMerger.js'
import DouglasPeuckerSimplifier from 'jsts/org/locationtech/jts/simplify/DouglasPeuckerSimplifier.js'
import type { Pt } from './model'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type G = any
export const gf = new GeometryFactory()

export const coord = (p: Pt): Coordinate => new Coordinate(p[0], p[1])
export const point = (p: Pt): G => gf.createPoint(coord(p))
export function lineString(pts: Pt[]): G {
  return gf.createLineString(pts.map(coord))
}
export function ring(pts: Pt[]): G {
  const c = pts.map(coord)
  const f = c[0]
  const l = c[c.length - 1]
  if (f.x !== l.x || f.y !== l.y) c.push(new Coordinate(f.x, f.y))
  return gf.createLinearRing(c)
}
export function polygon(rings: Pt[][]): G {
  if (!rings.length || rings[0].length < 3) return gf.createPolygon()
  try {
    const p = gf.createPolygon(
      ring(rings[0]),
      rings.slice(1).filter((r) => r.length >= 3).map(ring)
    )
    return p.isValid() ? p : p.buffer(0)
  } catch {
    return gf.createPolygon()
  }
}
export function box(minx: number, miny: number, maxx: number, maxy: number): G {
  return polygon([
    [
      [minx, miny],
      [maxx, miny],
      [maxx, maxy],
      [minx, maxy]
    ]
  ])
}
export function empty(): G {
  return gf.createGeometryCollection([])
}

export function union(gs: G[]): G {
  const list = gs.filter((g) => g && !g.isEmpty())
  if (!list.length) return empty()
  if (list.length === 1) return list[0]
  return UnaryUnionOp.union(gf.createGeometryCollection(list))
}

export interface BufferOpts {
  cap?: 'round' | 'flat' | 'square'
  join?: 'round' | 'mitre' | 'bevel'
  segs?: number
}
export function buffer(g: G, dist: number, o: BufferOpts = {}): G {
  const cap = o.cap === 'flat' ? BufferParameters.CAP_FLAT : o.cap === 'square' ? BufferParameters.CAP_SQUARE : BufferParameters.CAP_ROUND
  const join = o.join === 'mitre' ? BufferParameters.JOIN_MITRE : o.join === 'bevel' ? BufferParameters.JOIN_BEVEL : BufferParameters.JOIN_ROUND
  const bp = new BufferParameters(o.segs ?? 8, cap, join, 5.0)
  return BufferOp.bufferOp(g, dist, bp)
}

export function flatten(g: G): G[] {
  if (!g || g.isEmpty()) return []
  const n = g.getNumGeometries()
  if (n <= 1 && g.getGeometryType() !== 'GeometryCollection') return [g]
  const out: G[] = []
  for (let i = 0; i < n; i++) out.push(...flatten(g.getGeometryN(i)))
  return out
}
export const polygonsOf = (g: G): G[] => flatten(g).filter((x) => x.getGeometryType() === 'Polygon' && !x.isEmpty())
export const linesOf = (g: G): G[] => flatten(g).filter((x) => x.getGeometryType() === 'LineString' && x.getNumPoints() > 1)
export const pointsOf = (g: G): G[] => flatten(g).filter((x) => x.getGeometryType() === 'Point')

export function ptsOf(line: G): Pt[] {
  return line.getCoordinates().map((c: Coordinate) => [c.x, c.y] as Pt)
}
export function ringsOf(poly: G): Pt[][] {
  const out: Pt[][] = [ptsOf(poly.getExteriorRing())]
  for (let i = 0; i < poly.getNumInteriorRing(); i++) out.push(ptsOf(poly.getInteriorRingN(i)))
  return out
}
export function simplify(g: G, tol: number): G {
  return DouglasPeuckerSimplifier.simplify(g, tol)
}
export function dropSmallHoles(g: G, minArea: number): G {
  const out: G[] = []
  for (const p of polygonsOf(g)) {
    if (p.getArea() < minArea) continue
    const holes: G[] = []
    for (let i = 0; i < p.getNumInteriorRing(); i++) {
      const r = p.getInteriorRingN(i)
      if (gf.createPolygon(r).getArea() >= minArea) holes.push(gf.createLinearRing(r.getCoordinates()))
    }
    out.push(gf.createPolygon(gf.createLinearRing(p.getExteriorRing().getCoordinates()), holes))
  }
  return union(out)
}

/** Length-indexed access to a line: position and tangent at a distance, projection of a point. */
export interface Indexed {
  length: number
  at: (d: number) => Pt
  project: (p: Pt) => number
  tangent: (d: number) => [number, number]
}
export function indexLine(line: G): Indexed {
  const lil = new LengthIndexedLine(line)
  const length = line.getLength()
  const at = (d: number): Pt => {
    const c = lil.extractPoint(Math.max(0, Math.min(length, d)))
    return [c.x, c.y]
  }
  return {
    length,
    at,
    project: (p) => lil.project(coord(p)),
    tangent: (d) => {
      const a = at(Math.max(0, d - 0.5))
      const b = at(Math.min(length, d + 0.5))
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const n = Math.hypot(dx, dy) || 1
      return [dx / n, dy / n]
    }
  }
}

/** Node a set of lines (split at every crossing/touch) and return the pieces between nodes. */
export function nodedLines(lines: G[]): G[] {
  return linesOf(union(lines))
}
export function mergeLines(lines: G[]): G[] {
  const m = new LineMerger()
  for (const l of lines) m.add(l)
  const out: G[] = []
  const it = m.getMergedLineStrings().iterator()
  while (it.hasNext()) out.push(it.next())
  return out
}

/** Spatial index over geometries. */
export class Tree<T> {
  private t = new STRtree()
  private items: T[] = []
  constructor(entries: [G, T][] = []) {
    for (const [g, item] of entries) this.insert(g, item)
  }
  insert(g: G, item: T): void {
    this.t.insert(g.getEnvelopeInternal(), this.items.length)
    this.items.push(item)
  }
  query(g: G, pad = 0): T[] {
    const e: Envelope = g.getEnvelopeInternal().copy()
    if (pad) e.expandBy(pad)
    const idx: number[] = this.t.query(e).toArray()
    return idx.map((i) => this.items[i])
  }
}

/** Uniform grid over points for incremental insert + radius queries (STRtree cannot be modified after a query). */
export class PointGrid<T> {
  private cells = new Map<string, { p: Pt; item: T }[]>()
  constructor(private cell: number) {}
  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`
  }
  insert(p: Pt, item: T): void {
    const k = this.key(p[0], p[1])
    const c = this.cells.get(k)
    if (c) c.push({ p, item })
    else this.cells.set(k, [{ p, item }])
  }
  near(p: Pt, r: number): { p: Pt; item: T }[] {
    const out: { p: Pt; item: T }[] = []
    const x0 = Math.floor((p[0] - r) / this.cell)
    const x1 = Math.floor((p[0] + r) / this.cell)
    const y0 = Math.floor((p[1] - r) / this.cell)
    const y1 = Math.floor((p[1] + r) / this.cell)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const c = this.cells.get(`${x},${y}`)
        if (!c) continue
        for (const e of c) if (Math.hypot(e.p[0] - p[0], e.p[1] - p[1]) <= r) out.push(e)
      }
    return out
  }
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1])
export const visDeg = (dx: number, dy: number): number => ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360

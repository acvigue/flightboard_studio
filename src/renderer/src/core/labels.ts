// Initial labels: runway names, taxiway signs, terminal names, road refs and the copper title block.
import type { Label, LineFeature, Project } from './model'
import { newId, type Led } from './model'
import * as gm from './geom'
import type { BoardTransform } from './transform'
import type { Fonts } from './export'
import { labelBox, labelCorners } from './edit'

function readable(deg: number): number {
  // keep text upright: rotate by 180 when it would read upside down
  let a = ((deg % 360) + 360) % 360
  if (a > 90 && a < 270) a = (a + 180) % 360
  return a
}

export function generateLabels(project: Project, tf: BoardTransform): Label[] {
  const k = tf.k
  const out: Label[] = []
  const mm = (v: number): number => v / k
  // runways
  for (const l of project.lines) {
    if (l.cls !== 'runway_cl' || l.sub !== 'axis' || !l.name) continue
    const ix = gm.indexLine(gm.lineString(l.pts))
    const mid = ix.length / 2
    const [tx, ty] = ix.tangent(mid)
    const c = ix.at(mid)
    const off = (l.widthM ?? 45) / 2 + mm(2.4)
    const [d1, d2] = l.name.split('/')
    out.push({ id: newId('t'), text: `RUNWAY ${d1}${d2 ? ' – ' + d2 : ''}`, pos: [c[0] - ty * off * -1, c[1] + tx * off * -1], heightM: mm(2.2), rotDeg: readable(gm.visDeg(tx, ty)), layer: 'silk', weight: 400, anchor: 'middle', kind: 'runway' })
  }
  // taxiway signs: one per named taxiway on its longest piece
  const byRef = new Map<string, LineFeature[]>()
  for (const l of project.lines) if (l.cls === 'taxiway' && l.name) byRef.set(l.name, [...(byRef.get(l.name) ?? []), l])
  for (const [ref, ls] of byRef) {
    const longest = ls.map((l) => gm.lineString(l.pts)).sort((a, b) => b.getLength() - a.getLength())[0]
    if (longest.getLength() < mm(12)) continue
    const ix = gm.indexLine(longest)
    out.push({ id: newId('t'), text: ref, pos: ix.at(ix.length / 2), heightM: mm(1.5), rotDeg: 0, layer: 'silk', weight: 600, anchor: 'middle', boxed: true, kind: 'taxiway' })
  }
  // terminals
  for (const p of project.polys) {
    if (p.cls !== 'terminal' || !p.name) continue
    const g = gm.polygon(p.rings)
    const c = g.getInteriorPoint()
    out.push({ id: newId('t'), text: p.name.toUpperCase(), pos: [c.getX(), c.getY()], heightM: mm(2.0), rotDeg: 0, layer: 'copper', weight: 600, anchor: 'middle', kind: 'terminal' })
  }
  // major road refs
  const seenRoad = new Set<string>()
  for (const l of project.lines) {
    if (l.cls !== 'road_major' || !l.name || seenRoad.has(l.name)) continue
    const g = gm.lineString(l.pts)
    if (g.getLength() < mm(40)) continue
    seenRoad.add(l.name)
    const ix = gm.indexLine(g)
    const [tx, ty] = ix.tangent(ix.length / 2)
    out.push({ id: newId('t'), text: l.name.toUpperCase(), pos: ix.at(ix.length / 2), heightM: mm(1.6), rotDeg: readable(gm.visDeg(tx, ty)), layer: 'silk', weight: 400, anchor: 'middle', kind: 'road' })
  }
  // title block (copper), bottom-left of the board
  const b = project.board
  const at = (xmm: number, ymm: number): [number, number] => tf.toM([xmm, ymm])
  out.push({ id: newId('t'), text: b.name.toUpperCase(), pos: at(b.marginMm + 4, b.heightMm - b.marginMm - 9), heightM: mm(4.5), rotDeg: 0, layer: 'copper', weight: 600, anchor: 'start', kind: 'title' })
  out.push({ id: newId('t'), text: `${b.icao}${b.iata ? ' · ' + b.iata : ''}   ELEV ${Math.round(b.elevationFt)} FT   SCALE 1:${Math.round(tf.scale).toLocaleString()}`, pos: at(b.marginMm + 4, b.heightMm - b.marginMm - 4), heightM: mm(2.0), rotDeg: 0, layer: 'copper', weight: 400, anchor: 'start', kind: 'title' })
  out.push({ id: newId('t'), text: 'N', pos: at(b.widthMm - b.marginMm - 8, b.heightMm - b.marginMm - 14), heightM: mm(2.6), rotDeg: 0, layer: 'copper', weight: 600, anchor: 'middle', kind: 'title' })
  return out
}

/** North arrow as a copper line feature (bottom-right). */
export function northArrow(project: Project, tf: BoardTransform): LineFeature {
  const b = project.board
  const x = b.widthMm - b.marginMm - 8
  const y0 = b.heightMm - b.marginMm - 4
  const y1 = y0 - 8
  const pts: [number, number][] = [
    [x, y0],
    [x, y1],
    [x - 1.6, y1 + 2.6],
    [x, y1],
    [x + 1.6, y1 + 2.6]
  ]
  return { id: newId('l'), cls: 'custom', name: 'north arrow', layer: 'copper', sub: 'arrow', widthMm: 0.35, pts: pts.map((p) => tf.toM(p)) }
}

// ---------------------------------------------------------------- collision avoidance
// Labels are moved (never resized) until their box overlaps no LED body and no higher-priority label; labels that
// cannot find a free spot within the search pattern are dropped. Priority: title, runway, designator, terminal,
// taxiway sign, road, custom.
const PRIORITY: Record<string, number> = { title: 0, runway: 1, designator: 2, terminal: 3, taxiway: 4, road: 5, custom: 6 }

function rect(corners: [number, number][]): gm.G {
  return gm.polygon([corners])
}

export interface CollisionResult {
  moved: number
  dropped: string[]
  unresolved: string[] // kept in place although they still touch an LED or another label
}

export function resolveLabelCollisions(project: Project, tf: BoardTransform, fonts: Fonts | null, opts: { dropUnplaceable?: boolean; ledClearMm?: number } = {}): CollisionResult {
  const ledClear = opts.ledClearMm ?? 0.5
  const leds: Led[] = project.leds
  const ledGrid = new gm.PointGrid<Led>(4)
  for (const l of leds) ledGrid.insert(tf.toMm(l.pos), l)
  const ledHits = (c: [number, number][]): boolean => {
    const xs = c.map((p) => p[0])
    const ys = c.map((p) => p[1])
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const r = Math.hypot(Math.max(...xs) - cx, Math.max(...ys) - cy) + 2
    const near = ledGrid.near([cx, cy], r)
    if (!near.length) return false
    const poly = rect(c)
    return near.some(({ p, item }) => poly.distance(gm.point(p)) < item.size / 2 + ledClear)
  }
  const placed: { g: gm.G; b: [number, number][] }[] = []
  const labelHits = (c: [number, number][]): boolean => {
    const poly = rect(c)
    return placed.some((p) => p.g.intersects(poly))
  }
  const board = gm.box(project.board.marginMm * 0.5, project.board.marginMm * 0.5, project.board.widthMm - project.board.marginMm * 0.5, project.board.heightMm - project.board.marginMm * 0.5)
  const order = [...project.labels].sort((a, b) => (PRIORITY[a.kind ?? 'custom'] ?? 6) - (PRIORITY[b.kind ?? 'custom'] ?? 6))
  let moved = 0
  const dropped: string[] = []
  const unresolved: string[] = []
  const keep = new Set<string>()
  for (const lb of order) {
    if (lb.layer === 'silkBack') {
      keep.add(lb.id) // back silk: no LEDs there and not competing with the front labels
      continue
    }
    const box = labelBox(lb, tf, fonts)
    const h = box.h
    const w = box.w
    const a = (-lb.rotDeg * Math.PI) / 180
    const ux = Math.cos(a)
    const uy = Math.sin(a)      // along the text
    const vx = -uy
    const vy = ux               // perpendicular
    // candidate offsets (mm) in the label's own frame: in place, then slide along, then across, then both
    const cands: [number, number][] = [[0, 0]]
    const alongSteps = [0.5, -0.5, 1, -1, 1.5, -1.5, 2.5, -2.5].map((k) => k * Math.max(2, w * 0.35))
    const acrossSteps = [1, -1, 2, -2].map((k) => k * (h * 0.9 + 0.6))
    for (const s of alongSteps) cands.push([s, 0])
    for (const t of acrossSteps) cands.push([0, t])
    for (const t of acrossSteps) for (const s of alongSteps) cands.push([s, t])
    let ok = false
    for (const [s, t] of cands) {
      const dx = ux * s + vx * t
      const dy = uy * s + vy * t
      const c = labelCorners({ ...box, ax: box.ax + dx, ay: box.ay + dy })
      if (!board.contains(rect(c))) continue
      if (lb.locked && (s || t)) break
      if (ledHits(c) || labelHits(c)) continue
      if (s || t) {
        const [mx, my] = tf.toMm(lb.pos)
        lb.pos = tf.toM([mx + dx, my + dy])
        moved++
      }
      placed.push({ g: rect(c), b: c })
      keep.add(lb.id)
      ok = true
      break
    }
    if (!ok) {
      if (lb.locked || !(opts.dropUnplaceable ?? true)) {
        placed.push({ g: rect(labelCorners(box)), b: labelCorners(box) })
        keep.add(lb.id)
        const c0 = labelCorners(box)
        if (ledHits(c0) || placed.slice(0, -1).some((q) => q.g.intersects(rect(c0)))) unresolved.push(lb.text)
      } else dropped.push(lb.text)
    }
  }
  if (opts.dropUnplaceable ?? true) project.labels = project.labels.filter((l) => keep.has(l.id))
  return { moved, dropped, unresolved }
}

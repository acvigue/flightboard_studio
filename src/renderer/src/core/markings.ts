// Runway marking generators: displaced-threshold arrows, blast-pad chevrons, designator labels, end chevrons with the
// designator inside (the 'chevrons' runway end style).
import type { EndChevronStyle, Label, LineFeature, Project, Pt } from './model'
import type { Fonts } from './export'
import { newId } from './model'
import * as gm from './geom'
import type { BoardTransform } from './transform'

export type ChevronKind = 'chevrons' | 'arrows'
export interface ChevronOpts {
  end: 0 | 1          // which end of the axis line the markings belong to (0 = first vertex)
  kind: ChevronKind
  lengthM: number     // how far from the end the marked zone extends
  count: number
  widthMm?: number    // stroke width on the board
}

/** Chevrons (blast pad) or arrows (displaced threshold) at one end of a runway axis, as marking lines in metres. */
export function runwayEndMarkings(axis: LineFeature, opts: ChevronOpts): LineFeature[] {
  const line = gm.lineString(axis.pts)
  const ix = gm.indexLine(line)
  const width = axis.widthM ?? 45
  const out: LineFeature[] = []
  const dir = opts.end === 0 ? 1 : -1               // travel direction from the end into the runway
  const at = (d: number): Pt => ix.at(opts.end === 0 ? d : ix.length - d)
  const tangent = (d: number): [number, number] => {
    const [tx, ty] = ix.tangent(opts.end === 0 ? d : ix.length - d)
    return [tx * dir, ty * dir]  // points into the runway
  }
  const step = opts.lengthM / opts.count
  for (let i = 0; i < opts.count; i++) {
    const d = step * (i + 0.5)
    const c = at(d)
    const [tx, ty] = tangent(d)
    const nx = -ty
    const ny = tx
    const name = `${axis.name} ${opts.kind}`
    if (opts.kind === 'chevrons') {
      // V pointing toward the threshold (against the travel direction), spanning the runway width
      const arm = width * 0.45
      const apex: Pt = [c[0] - tx * arm * 0.5, c[1] - ty * arm * 0.5]
      const l: Pt = [apex[0] + tx * arm + nx * arm, apex[1] + ty * arm + ny * arm]
      const r: Pt = [apex[0] + tx * arm - nx * arm, apex[1] + ty * arm - ny * arm]
      out.push({ id: newId('l'), cls: 'runway_cl', sub: 'marking', name, pts: [l, apex, r], widthMm: opts.widthMm ?? 0.3 })
    } else {
      // arrow along the centreline pointing toward the threshold
      const len = step * 0.7
      const tail: Pt = [c[0] + tx * len * 0.5, c[1] + ty * len * 0.5]
      const head: Pt = [c[0] - tx * len * 0.5, c[1] - ty * len * 0.5]
      const hw = Math.min(width * 0.18, len * 0.35)
      out.push({ id: newId('l'), cls: 'runway_cl', sub: 'marking', name, pts: [tail, head], widthMm: opts.widthMm ?? 0.35 })
      out.push({ id: newId('l'), cls: 'runway_cl', sub: 'marking', name, pts: [[head[0] + tx * hw + nx * hw, head[1] + ty * hw + ny * hw], head, [head[0] + tx * hw - nx * hw, head[1] + ty * hw - ny * hw]], widthMm: opts.widthMm ?? 0.35 })
    }
  }
  return out
}

/** Designator labels ("10L", "28R") just inside each end, reading from the approach. */
export function designatorLabels(axis: LineFeature, tf: BoardTransform): Label[] {
  if (!axis.name || !axis.name.includes('/')) return []
  const [d1, d2] = axis.name.split('/')
  const ix = gm.indexLine(gm.lineString(axis.pts))
  const out: Label[] = []
  const inset = 120
  for (const [name, d, sgn] of [
    [d1, inset, 1],
    [d2, ix.length - inset, -1]
  ] as [string, number, number][]) {
    const c = ix.at(d)
    const [tx, ty] = ix.tangent(d)
    // text reads along the runway toward the far end, i.e. as seen on approach to this end
    const rot = gm.visDeg(tx * sgn, ty * sgn) - 90
    out.push({ id: newId('t'), text: name, pos: c, heightM: 3.2 / tf.k, rotDeg: ((rot % 360) + 360) % 360, layer: 'silk', weight: 600, anchor: 'middle', kind: 'designator' })
  }
  return out
}

// ---------------------------------------------------------------- end chevrons with the designator inside
export interface EndChevronEnd {
  designator: string
  depthMm: number
  spanMm: number
  textMm: number        // designator cap height fitted inside
  clipped: boolean      // shrunk to stay on the board
  nearLeds: string[]    // LEDs whose silk keep-out the strokes touch (the export cuts the silk there)
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Which of the two designators belongs to an end: the one whose number matches the heading flown when landing there
 *  (bearing into the runway, true north; magnetic variation within +-20 degrees is fine). */
function designatorFor(names: string[], heading: number): string {
  let best = names[0]
  let bd = 1e9
  for (const nm of names) {
    const num = parseInt(nm, 10)
    if (!Number.isFinite(num)) continue
    const d = Math.abs(((num * 10 - heading + 540) % 360) - 180)
    if (d < bd) { bd = d; best = nm }
  }
  return best
}

/** Double-line chevrons past each runway end with the designator inside (number over side letter, reading from the
 *  approach). Works in board mm; the result is in metres like every feature. Needs the fonts to fit the text. */
export function endChevrons(project: Project, tf: BoardTransform, fonts: Fonts, st: EndChevronStyle): { lines: LineFeature[]; labels: Label[]; ends: EndChevronEnd[] } {
  const lines: LineFeature[] = []
  const labels: Label[] = []
  const ends: EndChevronEnd[] = []
  const W = project.board.widthMm
  const H = project.board.heightMm
  const inset = 0.8
  const font = fonts.semibold
  const widthOf = (text: string, h: number): number => font.getAdvanceWidth(text, h / fonts.capRatio)
  const mmLeds = project.leds.map((l) => ({ l, p: tf.toMm(l.pos) }))
  const dd = st.strokeMm + st.gapMm            // centreline spacing of the two strokes
  const mg = 0.15                               // clear space between the text and the inner stroke
  for (const axis of project.lines.filter((l) => l.cls === 'runway_cl' && l.sub === 'axis' && l.pts.length >= 2 && l.name)) {
    const names = axis.name!.split('/').map((x) => x.trim()).filter(Boolean)
    for (const end of [0, 1] as const) {
      const n = axis.pts.length
      const Em = axis.pts[end ? n - 1 : 0]
      const Pm = axis.pts[end ? n - 2 : 1]
      const um = [Em[0] - Pm[0], Em[1] - Pm[1]]
      const lm = Math.hypot(um[0], um[1]) || 1
      // landing heading at this end: into the runway (true bearing, clockwise from north)
      const heading = ((Math.atan2(-um[0] / lm, -um[1] / lm) * 180) / Math.PI + 360) % 360
      const des = designatorFor(names, heading)
      const num = des.replace(/[^0-9]/g, '')
      const letter = des.replace(/[0-9]/g, '')
      const E = tf.toMm(Em)
      const Pp = tf.toMm(Pm)
      const ul = Math.hypot(E[0] - Pp[0], E[1] - Pp[1]) || 1
      const u: Pt = [(E[0] - Pp[0]) / ul, (E[1] - Pp[1]) / ul] // outward, board mm
      const nv: Pt = [-u[1], u[0]]
      const at = (s: number, o: number): Pt => [E[0] + u[0] * s + nv[0] * o, E[1] + u[1] * s + nv[1] * o]
      const onBoard = (q: Pt): boolean => q[0] >= inset && q[0] <= W - inset && q[1] >= inset && q[1] <= H - inset
      let span = st.span * (axis.widthM ?? 45) * tf.k
      let depth = st.depth * span
      let clipped = false
      // room to the board edge along the axis
      let room = 1e9
      for (const c of [0, 1]) {
        if (u[c] > 1e-9) room = Math.min(room, ((c ? H : W) - inset - E[c]) / u[c])
        if (u[c] < -1e-9) room = Math.min(room, (inset - E[c]) / u[c])
      }
      if (depth > room - st.offsetMm) { depth = Math.max(1, room - st.offsetMm); clipped = true }
      // shrink until every corner is on the board (runway ends near a board corner)
      const corners = (): Pt[] => [at(st.offsetMm, span / 2), at(st.offsetMm, -span / 2), at(st.offsetMm + depth, span / 2), at(st.offsetMm + depth, -span / 2)]
      for (let i = 0; i < 20 && !corners().every(onBoard); i++) { span *= 0.93; depth *= 0.93; clipped = true }
      const half = span / 2
      const alpha = Math.atan2(half, depth) // half angle at the apex
      const out = st.direction === 'outward'
      // outer V (centreline), inner V shifted toward the opening by the stroke spacing
      const sOpen = out ? st.offsetMm : st.offsetMm + depth
      const sApex = out ? st.offsetMm + depth : st.offsetMm
      const shift = dd / Math.sin(alpha)
      const inHalf = half - dd / Math.cos(alpha)
      const sApexIn = sApex + (out ? -shift : shift)
      const outer = [at(sOpen, half), at(sApex, 0), at(sOpen, -half)]
      const inner = inHalf > 0.2 ? [at(sOpen, inHalf), at(sApexIn, 0), at(sOpen, -inHalf)] : []
      for (const pts of [outer, inner]) {
        if (pts.length) lines.push({ id: newId('l'), cls: 'runway_cl', sub: 'marking', name: `${des} end chevron`, src: 'rwy-end', pts: pts.map((q) => tf.toM(q)), widthMm: st.strokeMm, locked: true })
      }
      // free half-width inside the inner stroke at distance s past the end
      const edge = (dd + st.strokeMm / 2) / Math.cos(alpha)
      const hw = (s: number): number => (out ? half * (1 - (s - sOpen) / depth) : half * ((s - sApex) / depth)) - edge
      // text block: number row nearer the runway, letter row outward; fit the largest cap height that clears the arms
      const lg = 0.35 // line gap as a fraction of the cap height
      let textMm = 0
      let rows: { text: string; s: number }[] = []
      for (let h = st.textMaxMm; h >= 0.5; h -= 0.02) {
        const blockH = letter ? 2 * h + lg * h : h
        const a = out ? sOpen + mg : sOpen - mg - blockH // cap top of the number row (distance past the end)
        const rNum = { s0: a, s1: a + h, w: widthOf(num, h) }
        const rLet = letter ? { s0: a + h + lg * h, s1: a + blockH, w: widthOf(letter, h) } : null
        // the narrow end of each row: toward the apex
        const fits = (r: { s0: number; s1: number; w: number }): boolean => Math.min(hw(r.s0), hw(r.s1)) >= r.w / 2 + mg && r.s0 >= Math.min(sOpen, sApexIn) && r.s1 <= Math.max(sOpen, sApexIn)
        if (fits(rNum) && (!rLet || fits(rLet))) {
          textMm = h
          rows = [{ text: num, s: rNum.s1 }]
          if (rLet) rows.push({ text: letter, s: rLet.s1 })
          break
        }
      }
      // text up = toward the runway (-u in metres); baseline = up turned clockwise
      const vx = -um[0] / lm
      const vy = -um[1] / lm
      const rot = ((Math.atan2(-vx, vy) * 180) / Math.PI + 360) % 360
      for (const r of rows)
        labels.push({ id: newId('t'), text: r.text, pos: tf.toM(at(r.s, 0)), heightM: textMm / tf.k, rotDeg: Math.round(rot * 100) / 100, layer: 'silk', weight: 600, anchor: 'middle', kind: 'designator', locked: true, src: 'rwy-end' })
      // LEDs whose silk keep-out (body + 0.4 mm) the strokes touch
      const segs = [outer, inner].filter((x) => x.length).flatMap((pts) => [[pts[0], pts[1]], [pts[1], pts[2]]] as [Pt, Pt][])
      const nearLeds = mmLeds
        .filter(({ l, p }) => segs.some(([a, b]) => segDist(p, a, b) < l.size * 0.71 + 0.4 + st.strokeMm / 2))
        .map(({ l }) => l.label || l.feature || l.cls)
      ends.push({ designator: des, depthMm: Math.round(depth * 100) / 100, spanMm: Math.round(span * 100) / 100, textMm: Math.round(textMm * 100) / 100, clipped, nearLeds })
    }
  }
  return { lines, labels, ends }
}

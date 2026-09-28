// Exports: top silkscreen SVG, top copper SVG, bottom silkscreen SVG, edge cuts SVG, board.json, lights.json.
// SVGs are sized to the board (width/height in mm, viewBox 0 0 W H, y down, origin top-left). Text is converted to
// outlines (KiCad's SVG import has no text support). Silkscreen is cut around LED bodies and around exposed copper.
import * as opentype from 'opentype.js'
// inlined as data URLs: works in the page and in the compute worker, in dev and in a packaged app (no fetch of file://)
import regularData from '../assets/fonts/Jost-Regular.ttf?inline'
import semiboldData from '../assets/fonts/Jost-SemiBold.ttf?inline'
import { LINE_WIDTH, type Label, type Led, type Project } from './model'
import * as gm from './geom'
import { makeTransform, type BoardTransform } from './transform'
import { hatchLines } from './hatch'
import { labelBox, labelCorners } from './edit'
import { DEFAULT_HATCH } from './model'
import { utmFor } from './geo'
import { backArtPolys } from './backart'

export interface Fonts {
  regular: opentype.Font
  semibold: opentype.Font
  capRatio: number
}
let fonts: Fonts | null = null
export async function loadFonts(): Promise<Fonts> {
  if (fonts) return fonts
  const r = dataUrlBytes(regularData)
  const s = dataUrlBytes(semiboldData)
  const regular = opentype.parse(r)
  const semibold = opentype.parse(s)
  const os2 = (regular.tables as Record<string, { sCapHeight?: number }>).os2
  const capRatio = os2?.sCapHeight ? os2.sCapHeight / regular.unitsPerEm : 0.7
  fonts = { regular, semibold, capRatio }
  return fonts
}

function dataUrlBytes(u: string): ArrayBuffer {
  const bin = atob(u.slice(u.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

const f2 = (v: number): string => (Math.round(v * 1000) / 1000).toString()

/** SVG path data of a label in board mm, rotation applied (rotDeg = visual CCW). */
export function labelPathD(fs: Fonts, lb: Label, tf: BoardTransform): { d: string; box: [number, number, number, number] } {
  const font = lb.weight === 600 ? fs.semibold : fs.regular
  const hMm = lb.heightM * tf.k
  const size = hMm / fs.capRatio
  const [ax, ay] = tf.toMm(lb.pos)
  // letter spacing: opentype adds it after every glyph (the last one too), the label width excludes the trailing gap
  const track = (lb.tracking ?? 0) * hMm
  const opt = track ? { letterSpacing: track / size } : {}
  const adv = font.getAdvanceWidth(lb.text, size, opt) - (track ? track : 0)
  const ox = lb.anchor === 'middle' ? -adv / 2 : lb.anchor === 'end' ? -adv : 0
  const path = font.getPath(lb.text, ox, 0, size, opt)
  const a = (-lb.rotDeg * Math.PI) / 180 // SVG y-down: visual CCW is a negative angle
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const m = lb.layer === 'silkBack' ? -1 : 1 // back silk reads from the back: mirrored about the anchor
  const T = (x: number, y: number): string => `${f2(ax + m * (x * ca - y * sa))} ${f2(ay + x * sa + y * ca)}`
  let d = ''
  for (const c of path.commands) {
    if (c.type === 'M') d += `M${T(c.x, c.y)}`
    else if (c.type === 'L') d += `L${T(c.x, c.y)}`
    else if (c.type === 'C') d += `C${T(c.x1, c.y1)} ${T(c.x2, c.y2)} ${T(c.x, c.y)}`
    else if (c.type === 'Q') d += `Q${T(c.x1, c.y1)} ${T(c.x, c.y)}`
    else if (c.type === 'Z') d += 'Z'
  }
  const bb = path.getBoundingBox()
  return { d, box: m < 0 ? [ax - bb.x2, ay + bb.y1, ax - bb.x1, ay + bb.y2] : [ax + bb.x1, ay + bb.y1, ax + bb.x2, ay + bb.y2] }
}

/** The area a font renderer paints for a set of contours (nonzero winding): every point whose contours' windings do
 *  not cancel. Built up contour by contour as regions per winding number, so overlapping strokes (Jost's R, E, K),
 *  counters, and islands inside counters (the tail of Q, the a of @) all come out as drawn. */
function nonzeroFill(contours: { g: gm.G; s: number }[]): gm.G {
  let byW = new Map<number, gm.G>()
  const add = (m: Map<number, gm.G>, w: number, g: gm.G): void => {
    if (w === 0 || g.isEmpty()) return
    const prev = m.get(w)
    m.set(w, prev ? gm.union([prev, g]) : g)
  }
  for (const c of contours) {
    const next = new Map<number, gm.G>()
    let covered: gm.G | null = null
    for (const [w, g] of byW) {
      covered = covered ? gm.union([covered, g]) : g
      if (!g.intersects(c.g)) {
        add(next, w, g)
        continue
      }
      add(next, w + c.s, g.intersection(c.g))
      add(next, w, g.difference(c.g))
    }
    add(next, c.s, covered ? c.g.difference(covered) : c.g)
    byW = next
  }
  return gm.union([...byW.values()])
}

/** A label as filled polygons in board mm (curves flattened, counters as holes): the area a font renderer paints
 *  (nonzero winding), glyph by glyph. (Deciding holes by containment cut the legs off R and the bars off E: "O'HARE"
 *  came out as "O'HAPL".) */
export function labelPolys(fs: Fonts, lb: Label, tf: BoardTransform): gm.G[] {
  const font = lb.weight === 600 ? fs.semibold : fs.regular
  const hMm = lb.heightM * tf.k
  const size = hMm / fs.capRatio
  const [ax, ay] = tf.toMm(lb.pos)
  const track = (lb.tracking ?? 0) * hMm
  const opt = track ? { letterSpacing: track / size } : {}
  const adv = font.getAdvanceWidth(lb.text, size, opt) - (track ? track : 0)
  const ox = lb.anchor === 'middle' ? -adv / 2 : lb.anchor === 'end' ? -adv : 0
  const a = (-lb.rotDeg * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const m = lb.layer === 'silkBack' ? -1 : 1 // back silk reads from the back: mirrored about the anchor
  const T = (x: number, y: number): [number, number] => [ax + m * (x * ca - y * sa), ay + x * sa + y * ca]
  const N = 6
  const signed = (r: [number, number][]): number => r.reduce((s2, p, i) => { const q = r[(i + 1) % r.length]; return s2 + p[0] * q[1] - q[0] * p[1] }, 0) / 2
  const valid = (r: [number, number][]): gm.G => {
    const g = gm.polygon([r])
    return g.isValid() ? g : gm.buffer(g, 0)
  }
  const out: gm.G[] = []
  for (const path of font.getPaths(lb.text, ox, 0, size, opt)) {
    // flatten this glyph into contours
    const contours: [number, number][][] = []
    let cur: [number, number][] = []
    let px = 0
    let py = 0
    for (const c of path.commands) {
      if (c.type === 'M') {
        if (cur.length >= 3) contours.push(cur)
        cur = [T(c.x, c.y)]
        px = c.x
        py = c.y
      } else if (c.type === 'L') {
        cur.push(T(c.x, c.y))
        px = c.x
        py = c.y
      } else if (c.type === 'Q') {
        for (let i = 1; i <= N; i++) {
          const t = i / N
          const u = 1 - t
          cur.push(T(u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y))
        }
        px = c.x
        py = c.y
      } else if (c.type === 'C') {
        for (let i = 1; i <= N; i++) {
          const t = i / N
          const u = 1 - t
          cur.push(T(u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y))
        }
        px = c.x
        py = c.y
      } else if (c.type === 'Z') {
        if (cur.length >= 3) contours.push(cur)
        cur = []
      }
    }
    if (cur.length >= 3) contours.push(cur)
    const cs = contours.map((r) => ({ r, s: signed(r) })).filter((c) => Math.abs(c.s) > 1e-6)
    if (!cs.length) continue
    for (const q of gm.polygonsOf(nonzeroFill(cs.map((c) => ({ g: valid(c.r), s: Math.sign(c.s) }))))) if (!q.isEmpty()) out.push(q)
  }
  return out
}

function pathOfPolys(g: gm.G): string {
  let d = ''
  for (const p of gm.polygonsOf(g)) {
    for (const r of gm.ringsOf(p)) d += 'M' + r.map(([x, y]) => `${f2(x)} ${f2(y)}`).join('L') + 'Z'
  }
  return d
}

interface Ctx {
  project: Project
  tf: BoardTransform
  keepout: gm.G                 // mm-space union of areas silk must avoid (used for envelope tests)
  keepTree: gm.Tree<gm.G> | null // the same areas as individual polygons, spatially indexed
}
function makeCtx(project: Project, tf: BoardTransform, keepout: gm.G): Ctx {
  const parts = gm.polygonsOf(keepout)
  return { project, tf, keepout, keepTree: parts.length ? new gm.Tree<gm.G>(parts.map((p) => [p, p])) : null }
}

function mmLine(pts: [number, number][], tf: BoardTransform): gm.G {
  return gm.lineString(pts.map((p) => tf.toMm(p)))
}
function mmPoly(rings: [number, number][][], tf: BoardTransform): gm.G {
  return gm.polygon(rings.map((r) => r.map((p) => tf.toMm(p))))
}

/** Where generated artwork goes: SVG path strings (the export) or polygons (the Altium job). */
export interface ArtSink {
  geom(g: gm.G): void
  label(lb: Label): void
}
function svgSink(out: string[], texts: string[], fs: Fonts, tf: BoardTransform): ArtSink {
  return {
    geom: (g) => {
      const d = pathOfPolys(g)
      if (d) out.push(`<path d="${d}"/>`)
    },
    label: (lb) => texts.push(`<path d="${labelPathD(fs, lb, tf).d}"/>`)
  }
}

/** Stroke a line/ring set into filled polygons (mm), minus keepouts. */
function strokeToPaths(g: gm.G, w: number, ctx: Ctx, out: string[] | ArtSink): void {
  if (g.isEmpty()) return
  let s = gm.buffer(g, w / 2, { cap: 'round', join: 'round', segs: 4 })
  if (ctx.keepTree) {
    // subtract only the keepout pieces near this element (a full-board difference per element is very slow)
    const near = ctx.keepTree.query(s, 0.05).filter((k) => k.getEnvelopeInternal().intersects(s.getEnvelopeInternal()))
    if (near.length) {
      try {
        s = s.difference(gm.union(near))
      } catch {
        /* robustness failure: keep the uncut stroke rather than losing the element */
      }
    }
  }
  if (!Array.isArray(out)) {
    if (!s.isEmpty()) out.geom(s)
    return
  }
  const d = pathOfPolys(s)
  if (d) out.push(`<path d="${d}"/>`)
}

function ledKeepout(leds: Led[], tf: BoardTransform, clearance: number): gm.G {
  return gm.union(leds.map((l) => gm.buffer(gm.point(tf.toMm(l.pos)), l.size * 0.71 + clearance, { segs: 4 })))
}

/** Emit one polygon's outline / fill / hatch on its layer. */
function emitPoly(poly: import('./model').PolyFeature, ctx: Ctx, out: string[] | ArtSink, extraCut?: gm.G): void {
  const tf = ctx.tf
  const g = mmPoly(poly.rings, tf)
  const stroke = poly.strokeMm ?? LINE_WIDTH[poly.cls] ?? 0.15
  const fill = poly.fill ?? (poly.cls === 'terminal' ? 'hatch' : 'none')
  if (stroke > 0) {
    let b = g.getBoundary()
    if (extraCut && !extraCut.isEmpty()) b = b.difference(extraCut)
    strokeToPaths(b, stroke, ctx, out)
  }
  if (fill === 'solid') {
    let s = g
    if (ctx.keepTree) {
      const near = ctx.keepTree.query(s, 0.05)
      if (near.length) s = s.difference(gm.union(near))
    }
    if (!Array.isArray(out)) {
      if (!s.isEmpty()) out.geom(s)
    } else {
      const d = pathOfPolys(s)
      if (d) out.push(`<path d="${d}"/>`)
    }
  } else if (fill === 'hatch') {
    const spec = poly.hatch ?? DEFAULT_HATCH
    strokeToPaths(hatchLines(g, spec, 0.25), spec.widthMm, ctx, out)
  }
}

function svgHead(p: Project, title: string): string {
  const W = p.board.widthMm
  const H = p.board.heightMm
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n<title>${title}</title>\n`
}

export function copperArtMm(p: Project, tf: BoardTransform): gm.G {
  // the copper polygons' footprints (terminal outlines with their hatch)
  return gm.union(p.polys.filter((x) => (x.layer ?? (x.cls === 'terminal' ? 'copper' : 'silk')) === 'copper').map((x) => mmPoly(x.rings, tf)))
}

/** Where the silkscreen must not go because exposed copper art is there (copper wins over silk): the copper polygons
 *  plus 0.5 mm, and the copper lines and labels (north arrow, title block, terminal names) plus 0.35 mm. */
export function copperKeepout(p: Project, tf: BoardTransform, fs: Fonts): gm.G {
  const vis = (key: string): boolean => p.layerVisibility[key] !== false
  const strokes: gm.G[] = []
  for (const l of p.lines) if (l.layer === 'copper') strokes.push(gm.buffer(mmLine(l.pts, tf), (l.widthMm ?? LINE_WIDTH[l.cls] ?? 0.15) / 2, { cap: 'round', join: 'round', segs: 4 }))
  for (const lb of p.labels) if (lb.layer === 'copper' && vis('labels')) strokes.push(...labelPolys(fs, lb, tf))
  return gm.union([gm.buffer(copperArtMm(p, tf), 0.5), gm.buffer(gm.union(strokes), 0.35)])
}

/** Top silkscreen artwork into a sink (outlines, lines, hatches, labels, sign boxes), cut around LEDs and copper. */
export function collectTopSilk(p: Project, tf: BoardTransform, fs: Fonts, sink: ArtSink): void {
  const vis = (key: string): boolean => p.layerVisibility[key] !== false
  const cuKeep = copperKeepout(p, tf, fs)
  const keep = gm.union([ledKeepout(p.leds, tf, 0.4), cuKeep])
  const ctx = makeCtx(p, tf, keep)
  const cuParts = gm.polygonsOf(cuKeep)
  const cuTree = cuParts.length ? new gm.Tree<gm.G>(cuParts.map((q) => [q, q])) : null
  const rwyU = gm.union(p.polys.filter((x) => x.cls === 'runway').map((x) => mmPoly(x.rings, tf)))
  const pav = gm.union(p.polys.filter((x) => x.cls === 'pavement').map((x) => mmPoly(x.rings, tf)))
  for (const poly of p.polys) {
    if (!vis(poly.cls) || (poly.layer ?? (poly.cls === 'terminal' ? 'copper' : 'silk')) !== 'silk') continue
    let cut: gm.G | undefined
    if (poly.cls === 'pavement' && !rwyU.isEmpty()) cut = gm.buffer(rwyU, 0.05)
    if (poly.cls === 'building' && !pav.isEmpty()) cut = gm.buffer(pav, -0.1)
    emitPoly(poly, ctx, sink, cut)
  }
  for (const l of p.lines) {
    if ((l.layer ?? 'silk') !== 'silk' || !vis(l.cls)) continue
    if (l.cls === 'runway_cl' && l.sub === 'axis') continue
    strokeToPaths(mmLine(l.pts, tf), l.widthMm ?? LINE_WIDTH[l.cls], ctx, sink)
  }
  if (vis('labels')) {
    for (const lb of p.labels) {
      if (lb.layer !== 'silk') continue
      if (lb.boxed) {
        // taxiway sign: an outlined box (0.15 mm stroke as a filled ring) around the text, like the ORD silk. Same
        // rotated box as the editor and the collision checks (the text sits on its baseline at the label position).
        const outer = gm.polygon([labelCorners(labelBox(lb, tf, fs))])
        let box = outer.difference(gm.buffer(outer, -0.15, { join: 'mitre' }))
        const hit = cuTree?.query(outer, 0.05) ?? []
        if (hit.length) box = box.difference(gm.union(hit))
        if (!box.isEmpty()) sink.geom(box)
      }
      // a label over copper art loses the part that would print on the copper
      const hit = cuTree?.query(gm.polygon([labelCorners(labelBox(lb, tf, fs))]), 0.05) ?? []
      if (!hit.length) sink.label(lb)
      else {
        const g = gm.union(labelPolys(fs, lb, tf)).difference(gm.union(hit))
        if (!g.isEmpty()) sink.geom(g)
      }
    }
  }
}

export async function exportTopSilk(p: Project): Promise<string> {
  const tf = makeTransform(p.board, p.frame)
  const fs = await loadFonts()
  const out: string[] = []
  const texts: string[] = []
  const sink = svgSink(out, texts, fs, tf)
  // sign boxes are even-odd rings: keep them with the geometry group
  collectTopSilk(p, tf, fs, sink)
  return svgHead(p, `${p.board.icao} top silkscreen`) + `<g fill="#000" fill-rule="evenodd" stroke="none">\n${out.join('\n')}\n</g>\n<g fill="#000" fill-rule="nonzero">\n${texts.join('\n')}\n</g>\n</svg>\n`
}

/** Exposed-copper artwork into a sink (copper polygons, lines and labels), clear of the LEDs. */
export function collectTopCopper(p: Project, tf: BoardTransform, sink: ArtSink): void {
  const ctx = makeCtx(p, tf, ledKeepout(p.leds, tf, 0.45))
  for (const poly of p.polys) {
    if ((poly.layer ?? (poly.cls === 'terminal' ? 'copper' : 'silk')) !== 'copper') continue
    emitPoly(poly, ctx, sink)
  }
  for (const l of p.lines) if (l.layer === 'copper') strokeToPaths(mmLine(l.pts, tf), l.widthMm ?? LINE_WIDTH[l.cls], ctx, sink)
  for (const lb of p.labels) if (lb.layer === 'copper') sink.label(lb)
}

export async function exportTopCopper(p: Project): Promise<string> {
  const tf = makeTransform(p.board, p.frame)
  const fs = await loadFonts()
  const out: string[] = []
  const texts: string[] = []
  collectTopCopper(p, tf, svgSink(out, texts, fs, tf))
  return svgHead(p, `${p.board.icao} top copper (exposed)`) + `<g fill="#000" fill-rule="evenodd" stroke="none">\n${out.join('\n')}\n</g>\n<g fill="#000" fill-rule="nonzero">\n${texts.join('\n')}\n</g>\n</svg>\n`
}

/** Is the back silk exported? The Layers "Back silk" toggle covers the imported art and the drawn back features. */
export const backSilkOn = (p: Project): boolean => p.layerVisibility.backsilk !== false

/** Drawn back silk (polygons, lines and labels on layer silkBack) into a sink, labels mirrored to read from the back.
 *  Nothing on the back to keep clear of: the LEDs and exposed copper are on the top. */
export function collectBackSilk(p: Project, tf: BoardTransform, fs: Fonts, sink: ArtSink): number {
  if (!backSilkOn(p)) return 0
  const vis = (key: string): boolean => p.layerVisibility[key] !== false
  const ctx = makeCtx(p, tf, gm.empty())
  let n = 0
  for (const poly of p.polys) {
    if (poly.layer !== 'silkBack' || !vis(poly.cls)) continue
    emitPoly(poly, ctx, sink)
    n++
  }
  for (const l of p.lines) {
    if (l.layer !== 'silkBack' || !vis(l.cls)) continue
    strokeToPaths(mmLine(l.pts, tf), l.widthMm ?? LINE_WIDTH[l.cls], ctx, sink)
    n++
  }
  if (vis('labels'))
    for (const lb of p.labels) {
      if (lb.layer !== 'silkBack') continue
      if (lb.boxed) {
        const outer = gm.polygon([labelCorners(labelBox(lb, tf, fs))])
        sink.geom(outer.difference(gm.buffer(outer, -0.15, { join: 'mitre' })))
      }
      sink.label(lb)
      n++
    }
  return n
}

/** Bottom silkscreen: the imported back art and the drawn back silk, in board coordinates seen from the top (the same
 *  frame as the other layers and the PCB: text on it reads mirrored here and correctly on the back of the board). */
export async function exportBottomSilk(p: Project): Promise<string> {
  const tf = makeTransform(p.board, p.frame)
  const fs = await loadFonts()
  const out: string[] = []
  const texts: string[] = []
  let imported = 0
  if (p.backArt && p.backArt.visible && backSilkOn(p)) {
    for (const poly of backArtPolys(p.backArt)) out.push(`<path d="${poly.map((r) => 'M' + r.map(([x, y]) => `${f2(x)} ${f2(y)}`).join('L') + 'Z').join('')}"/>`)
    imported = p.backArt.count
  }
  const drawn = collectBackSilk(p, tf, fs, svgSink(out, texts, fs, tf))
  const note = `bottom silkscreen, ${imported} imported polygon${imported === 1 ? '' : 's'} + ${drawn} drawn item${drawn === 1 ? '' : 's'}; board coordinates seen from the top (mirror to view from the back)`
  return svgHead(p, `${p.board.icao} bottom silkscreen`) + `<!-- ${note} -->\n<g fill="#000" fill-rule="evenodd" stroke="none">\n${out.join('\n')}\n</g>\n<g fill="#000" fill-rule="nonzero">\n${texts.join('\n')}\n</g>\n</svg>\n`
}

export function exportEdgeCuts(p: Project): string {
  const W = p.board.widthMm
  const H = p.board.heightMm
  const r = p.board.cornerRadiusMm
  return svgHead(p, `${p.board.icao} edge cuts`) + `<rect x="0" y="0" width="${W}" height="${H}" rx="${r}" ry="${r}" fill="none" stroke="#000" stroke-width="0.1"/>\n</svg>\n`
}

export function exportBoardJson(p: Project): string {
  const tf = makeTransform(p.board, p.frame)
  const prj = utmFor(p.board.refLat, p.board.refLon)
  const [clon, clat] = prj.inverse(...tf.toM([p.board.widthMm / 2, p.board.heightMm / 2]))
  const tl = prj.inverse(...tf.toM([0, 0]))
  const br = prj.inverse(...tf.toM([p.board.widthMm, p.board.heightMm]))
  return JSON.stringify(
    {
      schema: 'flightboard-board/1',
      id: p.board.id,
      name: p.board.name,
      icao: p.board.icao,
      iata: p.board.iata,
      elevation_ft: p.board.elevationFt,
      board_mm: { w: p.board.widthMm, h: p.board.heightMm, corner_radius: p.board.cornerRadiusMm, margin: p.board.marginMm },
      scale: Math.round(tf.scale),
      mm_per_m: tf.k,
      projection: { epsg: prj.epsg, utm_zone: prj.zone, north: prj.north },
      frame_m: p.frame,
      transform: { fx0: tf.fx0, fy0: tf.fy0, minx: p.frame.minx, maxy: p.frame.maxy, note: 'x_mm = fx0 + (x - minx) * mm_per_m; y_mm = fy0 + (maxy - y) * mm_per_m' },
      origin: { lat: clat, lon: clon },
      corners: { top_left: { lat: tl[1], lon: tl[0] }, bottom_right: { lat: br[1], lon: br[0] } },
      artwork: { top_silk: 'top_silk.svg', top_copper: 'top_copper.svg', bottom_silk: 'bottom_silk.svg', edge_cuts: 'edge_cuts.svg' },
      lights: 'lights.json',
      generated: new Date().toISOString(),
      generator: 'flightboard-studio'
    },
    null,
    2
  )
}

export function exportLightsJson(p: Project): string {
  const tf = makeTransform(p.board, p.frame)
  const prj = utmFor(p.board.refLat, p.board.refLon)
  const packages: Record<string, { count: number }> = {}
  const lights = p.leds.map((l, i) => {
    const [x, y] = tf.toMm(l.pos)
    const [lon, lat] = prj.inverse(l.pos[0], l.pos[1])
    packages[String(l.size)] = { count: (packages[String(l.size)]?.count ?? 0) + 1 }
    return {
      id: i + 1,
      ref: `D${i + 1}`,
      x_mm: Math.round(x * 1000) / 1000,
      y_mm: Math.round(y * 1000) / 1000,
      rot_deg: Math.round(l.rotDeg * 100) / 100,
      size_mm: l.size,
      class: l.cls,
      role: l.role,
      feature: l.feature ?? '',
      label: l.label ?? '',
      lat: Math.round(lat * 1e7) / 1e7,
      lon: Math.round(lon * 1e7) / 1e7
    }
  })
  return JSON.stringify(
    {
      schema: 'flightboard-lights/1',
      board_id: p.board.id,
      count: lights.length,
      coordinates: 'x_mm/y_mm from the board top-left corner, y down; rot_deg visual counter-clockwise from +x (the LED square edges follow this direction)',
      packages,
      lights
    },
    null,
    1
  )
}

export async function exportAll(p: Project): Promise<{ name: string; content: string }[]> {
  return [
    { name: 'board.json', content: exportBoardJson(p) },
    { name: 'lights.json', content: exportLightsJson(p) },
    { name: 'top_silk.svg', content: await exportTopSilk(p) },
    { name: 'top_copper.svg', content: await exportTopCopper(p) },
    { name: 'bottom_silk.svg', content: await exportBottomSilk(p) },
    { name: 'edge_cuts.svg', content: exportEdgeCuts(p) }
  ]
}

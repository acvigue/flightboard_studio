// Configurable OSM data sources: a tag filter selects elements, a style turns each into editable line features
// (edges, centre lines, lane dashes, ticks, dashes) or polygon outlines, the way the O'Hare generator drew its
// landside. Applying sources regenerates only the features they produced (locked ones are kept).
import type { OsmElement } from './osm'
import type { Projection } from './geo'
import { newId, DEFAULT_SOURCES, type LineFeature, type PolyFeature, type Project, type Pt, type SourceSpec } from './model'
import * as gm from './geom'
import LengthIndexedLine from 'jsts/org/locationtech/jts/linearref/LengthIndexedLine.js'

// ---------------------------------------------------------------- tag filters: parse the Overpass bracket syntax
interface Clause {
  key: string
  op: '=' | '!=' | '~' | '!~' | 'exists' | 'missing'
  value?: string
  re?: RegExp
}
export function parseFilter(filter: string): Clause[] {
  const out: Clause[] = []
  const re = /\[\s*(!?)\s*"?([^"\]=!~\s]+)"?\s*(?:(=|!=|~|!~)\s*"?([^"\]]*)"?)?\s*\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(filter))) {
    const neg = m[1] === '!'
    const key = m[2]
    const op = m[3] as Clause['op'] | undefined
    const value = m[4]
    if (!op) out.push({ key, op: neg ? 'missing' : 'exists' })
    else if (op === '~' || op === '!~') out.push({ key, op, value, re: new RegExp(value ?? '') })
    else out.push({ key, op, value })
  }
  return out
}
export function matches(tags: Record<string, string>, clauses: Clause[]): boolean {
  for (const c of clauses) {
    const v = tags[c.key]
    switch (c.op) {
      case 'exists': if (v === undefined) return false; break
      case 'missing': if (v !== undefined) return false; break
      case '=': if (v !== c.value) return false; break
      case '!=': if (v === c.value) return false; break
      case '~': if (v === undefined || !c.re!.test(v)) return false; break
      case '!~': if (v !== undefined && c.re!.test(v)) return false; break
    }
  }
  return clauses.length > 0
}
function dropped(tags: Record<string, string>, dropTags?: string): boolean {
  if (!dropTags) return false
  for (const part of dropTags.split(';')) {
    const [k, vs] = part.split('=')
    if (!k || !vs) continue
    const v = tags[k.trim()]
    if (v !== undefined && vs.split('|').map((s) => s.trim()).includes(v)) return true
  }
  return false
}

/** Overpass union body for the enabled sources inside a bbox string "s,w,n,e". */
export function overpassBody(specs: SourceSpec[], bbox: string): string {
  return specs
    .filter((s) => s.enabled && s.filter.trim())
    // polygons as closed ways only: multipolygon relations (lakes, large complexes) can be enormous
    .map((s) => `way${s.filter}(${bbox});`)
    .join('')
}
export function sourcesHash(specs: SourceSpec[]): string {
  const s = specs.filter((x) => x.enabled).map((x) => `${x.kind}:${x.filter}`).join('|')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ---------------------------------------------------------------- geometry helpers (metres)
function lanesOf(tags: Record<string, string>, dflt: number): number {
  const n = parseInt(String(tags.lanes ?? '').split(';')[0], 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
/** Parallel offset of a polyline (positive = left of travel), miter joins with a limit. */
export function offsetPolyline(pts: Pt[], d: number): Pt[] {
  if (pts.length < 2) return pts
  const segs: { nx: number; ny: number }[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1][0] - pts[i][0]
    const dy = pts[i + 1][1] - pts[i][1]
    const l = Math.hypot(dx, dy) || 1
    segs.push({ nx: -dy / l, ny: dx / l })
  }
  const out: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = segs[Math.max(0, i - 1)]
    const b = segs[Math.min(segs.length - 1, i)]
    let nx = a.nx + b.nx
    let ny = a.ny + b.ny
    const l = Math.hypot(nx, ny)
    if (l < 1e-6) {
      nx = b.nx
      ny = b.ny
    } else {
      nx /= l
      ny /= l
    }
    const cos = Math.max(0.35, nx * b.nx + ny * b.ny) // miter limit
    out.push([pts[i][0] + (nx * d) / cos, pts[i][1] + (ny * d) / cos])
  }
  return out
}
function dashes(pts: Pt[], dash: number, gap: number): Pt[][] {
  const line = gm.lineString(pts)
  const lil = new LengthIndexedLine(line)
  const L = line.getLength()
  const out: Pt[][] = []
  for (let d = 0; d < L; d += dash + gap) {
    const seg = lil.extractLine(d, Math.min(L, d + dash))
    if (seg.getLength() > 0.3) out.push(gm.ptsOf(seg))
  }
  return out
}
function ticks(pts: Pt[], pitch: number, half: number): Pt[][] {
  const ix = gm.indexLine(gm.lineString(pts))
  const out: Pt[][] = []
  for (let d = pitch / 2; d < ix.length; d += pitch) {
    const p = ix.at(d)
    const [tx, ty] = ix.tangent(d)
    out.push([[p[0] - ty * half, p[1] + tx * half], [p[0] + ty * half, p[1] - tx * half]])
  }
  return out
}

// ---------------------------------------------------------------- apply
export interface ApplyContext {
  prj: Projection
  frame: gm.G          // metres
  aerodrome: gm.G      // metres (may be empty)
  airside: gm.G        // pavement ∪ terminals ∪ buildings buffered: landside features are cut under it
  pavement: gm.G
}
function wayPts(e: OsmElement, prj: Projection): Pt[] {
  return (e.geometry ?? []).filter((g) => g && Number.isFinite(g.lat)).map((g) => prj.forward(g.lon, g.lat))
}
function areaOf(e: OsmElement, prj: Projection): gm.G | null {
  if (e.type === 'way' && e.geometry && e.geometry.length > 3) return gm.polygon([wayPts(e, prj)])
  if (e.type === 'relation' && e.members) {
    const outers = e.members.filter((m) => m.role === 'outer' && m.geometry && m.geometry.length > 1).map((m) => gm.lineString(m.geometry!.map((g) => prj.forward(g.lon, g.lat))))
    const polys: gm.G[] = []
    for (const l of gm.mergeLines(outers)) {
      const c = gm.ptsOf(l)
      if (c.length > 3) polys.push(gm.polygon([c]))
    }
    if (!polys.length) return null
    const inners = e.members.filter((m) => m.role === 'inner' && m.geometry && m.geometry.length > 3).map((m) => gm.polygon([m.geometry!.map((g) => prj.forward(g.lon, g.lat))]))
    let g = gm.union(polys)
    if (inners.length) g = g.difference(gm.union(inners))
    return g
  }
  return null
}

export function applySources(specs: SourceSpec[], elements: OsmElement[], ctx: ApplyContext): { lines: LineFeature[]; polys: PolyFeature[]; counts: Record<string, number> } {
  const lines: LineFeature[] = []
  const polys: PolyFeature[] = []
  const counts: Record<string, number> = {}
  const parsed = specs.filter((s) => s.enabled).map((s) => ({ spec: s, clauses: parseFilter(s.filter) }))
  const used = new Set<string>()
  for (const e of elements) {
    const tags = e.tags ?? {}
    const k = `${e.type}${e.id}`
    if (used.has(k)) continue
    const hit = parsed.find(({ spec, clauses }) => (spec.kind === 'polygon' ? e.type !== 'node' : e.type === 'way') && matches(tags, clauses))
    if (!hit) continue
    const spec = hit.spec
    if (dropped(tags, spec.dropTags)) continue
    if (tags.tunnel === 'yes' && spec.kind === 'line') continue
    if (tags.layer && Number(String(tags.layer).split(';')[0]) < 0) continue
    used.add(k)
    const st = spec.style
    const clip = (g: gm.G): gm.G => {
      let c = g.intersection(ctx.frame)
      if (spec.clipAirside && !ctx.airside.isEmpty() && c.getEnvelopeInternal().intersects(ctx.airside.getEnvelopeInternal())) {
        try {
          c = c.difference(ctx.airside)
        } catch {
          /* keep unclipped */
        }
      }
      return c
    }
    const push = (pts: Pt[], part: LineFeature['part'], widthMm: number): void => {
      for (const seg of gm.linesOf(clip(gm.lineString(pts)))) {
        const p = gm.ptsOf(seg)
        if (p.length > 1) lines.push({ id: newId('l'), cls: spec.key, src: spec.key, part, name: tags.ref ?? tags.name, pts: p, layer: spec.layer, widthMm })
      }
    }
    if (spec.kind === 'polygon') {
      const g = areaOf(e, ctx.prj)
      if (!g || g.isEmpty() || g.getArea() < (spec.minAreaM2 ?? 0)) continue
      const c = clip(g)
      for (const p of gm.polygonsOf(c)) polys.push({ id: newId('p'), cls: spec.key, src: spec.key, name: tags.name, rings: gm.ringsOf(p), layer: spec.layer, fill: 'none', strokeMm: st.widthMm })
      counts[spec.key] = (counts[spec.key] ?? 0) + 1
      continue
    }
    if (!e.geometry || e.geometry.length < 2) continue
    const pts = wayPts(e, ctx.prj)
    const line = gm.lineString(pts)
    if (line.getLength() < (spec.minLengthM ?? 0)) continue
    if (spec.landsideOnly && !ctx.aerodrome.isEmpty()) {
      const inside = line.intersection(ctx.aerodrome).getLength()
      if (inside > 0.5 * line.getLength()) continue
      if (line.distance(ctx.pavement) < 80 && line.intersection(gm.buffer(ctx.pavement, 30)).getLength() > 0.3 * line.getLength()) continue
    }
    counts[spec.key] = (counts[spec.key] ?? 0) + 1
    const oneway = tags.oneway === 'yes'
    switch (st.mode) {
      case 'single':
        push(pts, 'line', st.widthMm)
        break
      case 'dashed':
      case 'dotted': {
        const [d, g] = st.dashM ?? [3, 6]
        for (const seg of dashes(pts, d, g)) push(seg, 'dash', st.widthMm)
        break
      }
      case 'ticks': {
        push(pts, 'line', st.widthMm)
        const [pitch, half] = st.tickM ?? [20, 6]
        for (const t of ticks(pts, pitch, half)) push(t, 'tick', st.widthMm)
        break
      }
      case 'edges':
      case 'edges+centre': {
        const n = lanesOf(tags, st.defaultLanes ?? (oneway ? 1 : 2))
        const laneM = st.laneM ?? 3.5
        const w = Math.max(n * laneM, st.minWidthM ?? 6)
        push(offsetPolyline(pts, -w / 2), 'edge', st.edgeWidthMm ?? st.widthMm)
        push(offsetPolyline(pts, w / 2), 'edge', st.edgeWidthMm ?? st.widthMm)
        if (st.laneDashes && n > 1) {
          const [d, g] = st.dashM ?? [3, 9]
          for (let k = 1; k < n; k++) for (const seg of dashes(offsetPolyline(pts, -w / 2 + k * laneM), d, g)) push(seg, 'dash', st.widthMm)
        } else if (st.mode === 'edges+centre' && n >= 2 && !oneway) push(pts, 'centre', st.widthMm)
        break
      }
      case 'outline':
        push(pts, 'line', st.widthMm)
        break
    }
  }
  return { lines, polys, counts }
}

export function sourcesOf(p: Project): SourceSpec[] {
  return p.sources && p.sources.length ? p.sources : DEFAULT_SOURCES.map((s) => ({ ...s, style: { ...s.style } }))
}

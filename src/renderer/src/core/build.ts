// Turns raw OSM (+ FAA) data into a Project: projection, map frame, board size, art layers.
import type { Airport } from './airports'
import type { FaaData, GeoJSONFeature } from './faa'
import type { OsmData, OsmElement, LLBox } from './osm'
import { utmFor, type Projection } from './geo'
import { DEFAULT_PLACEMENT, DEFAULT_SOURCES, newId, type LineFeature, type PolyFeature, type Project, type Pt, type SourceSpec } from './model'
import { applySources } from './sources'
import * as gm from './geom'
import { fitBoard } from './transform'

export interface BuildOptions {
  maxWidthMm: number
  maxHeightMm: number
  marginMm: number
  padM: number // ground margin around the runways that defines the map frame
}
export const DEFAULT_BUILD: BuildOptions = { maxWidthMm: 400, maxHeightMm: 500, marginMm: 5, padM: 100 }

// ---------------------------------------------------------------- OSM helpers
function wayPts(e: OsmElement, prj: Projection): Pt[] {
  return (e.geometry ?? []).filter((g) => g && Number.isFinite(g.lat)).map((g) => prj.forward(g.lon, g.lat))
}
function areaGeom(e: OsmElement, prj: Projection): gm.G | null {
  if (e.type === 'way' && e.geometry && e.geometry.length > 3) {
    const pts = wayPts(e, prj)
    return gm.polygon([pts])
  }
  if (e.type === 'relation' && e.members) {
    const outers: gm.G[] = []
    const inners: gm.G[] = []
    // outer ways may be split into several segments: merge them first
    const outerLines = e.members.filter((m) => m.role === 'outer' && m.geometry && m.geometry.length > 1).map((m) => gm.lineString(m.geometry!.map((g) => prj.forward(g.lon, g.lat))))
    for (const l of gm.mergeLines(outerLines)) {
      const c = l.getCoordinates()
      if (c.length > 3) outers.push(gm.polygon([c.map((q: { x: number; y: number }) => [q.x, q.y] as Pt)]))
    }
    for (const m of e.members.filter((m) => m.role === 'inner' && m.geometry && m.geometry.length > 3))
      inners.push(gm.polygon([m.geometry!.map((g) => prj.forward(g.lon, g.lat))]))
    if (!outers.length) return null
    let g = gm.union(outers)
    if (inners.length) g = g.difference(gm.union(inners))
    return g
  }
  return null
}

function faaPolys(faa: FaaData | null, layer: string, prj: Projection): { g: gm.G; props: Record<string, unknown> }[] {
  if (!faa || !faa[layer]) return []
  const out: { g: gm.G; props: Record<string, unknown> }[] = []
  for (const f of faa[layer] as GeoJSONFeature[]) {
    if (!f.geometry) continue
    const polys: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]] : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][]) : []
    const gs = polys.map((rings) => gm.polygon(rings.map((r) => r.map(([lon, lat]) => prj.forward(lon, lat)))))
    const g = gm.union(gs)
    if (!g.isEmpty()) out.push({ g, props: f.properties })
  }
  return out
}

export interface Runway {
  ref: string
  line: gm.G
  widthM: number
}

export interface BuildResult {
  project: Project
  runways: Runway[]
  log: string[]
}

export function buildProject(airport: Airport, osm: OsmData, faa: FaaData | null, opts: BuildOptions = DEFAULT_BUILD, specs: SourceSpec[] = DEFAULT_SOURCES, onLog?: (s: string) => void): BuildResult {
  // lines are collected for the result and streamed to onLog (progress in the busy overlay when run in the worker)
  const logLines: string[] = []
  const log = { push: (s: string): void => { logLines.push(s); onLog?.(s) } }
  const prj = utmFor(airport.lat, airport.lon)

  // ---- OSM aeroway features
  const runways: Runway[] = []
  const taxi: { kind: 'taxiway' | 'taxilane'; ref: string; line: gm.G }[] = []
  const aprons: gm.G[] = []
  const terminals: { name: string; g: gm.G }[] = []
  const gates: { ref: string; p: Pt }[] = []
  let aerodrome: gm.G | null = null
  const osmBuildings: gm.G[] = []
  for (const e of osm.aero) {
    const t = e.tags ?? {}
    const a = t.aeroway
    if (a === 'runway' && e.type === 'way' && e.geometry && e.geometry.length > 1) {
      runways.push({ ref: t.ref ?? '', line: gm.lineString(wayPts(e, prj)), widthM: Number(t.width) || 45.72 })
    } else if ((a === 'taxiway' || a === 'taxilane') && e.type === 'way' && e.geometry && e.geometry.length > 1) {
      taxi.push({ kind: a, ref: t.ref ?? '', line: gm.lineString(wayPts(e, prj)) })
    } else if (a === 'apron') {
      const g = areaGeom(e, prj)
      if (g && !g.isEmpty()) aprons.push(g)
    } else if (a === 'terminal') {
      const g = areaGeom(e, prj)
      if (g && !g.isEmpty()) terminals.push({ name: t.name ?? '', g })
    } else if (a === 'gate' && e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
      gates.push({ ref: t.ref ?? t.name ?? '', p: prj.forward(e.lon, e.lat) })
    } else if (a === 'aerodrome') {
      const g = areaGeom(e, prj)
      if (g && !g.isEmpty() && (!aerodrome || g.getArea() > aerodrome.getArea())) aerodrome = g
    } else if (t.building && !a) {
      const g = areaGeom(e, prj)
      if (g && !g.isEmpty() && g.getArea() >= 600) osmBuildings.push(g)
    }
  }
  // ---- keep only this airport: the aerodrome polygon around the reference point, else the runway cluster nearest it
  const refPt = gm.point(prj.forward(airport.lon, airport.lat))
  const aeroCands: gm.G[] = []
  for (const e of osm.aero) {
    if (e.tags?.aeroway !== 'aerodrome') continue
    const g = areaGeom(e, prj)
    if (g && !g.isEmpty() && g.getArea() > 20000) aeroCands.push(g)
  }
  let home: gm.G | null = aeroCands.filter((g) => g.contains(refPt)).sort((a, b) => b.getArea() - a.getArea())[0] ?? null
  if (!home) {
    const near = aeroCands.filter((g) => g.distance(refPt) < 3000).sort((a, b) => a.distance(refPt) - b.distance(refPt))
    home = near[0] ?? null
  }
  aerodrome = home
  let zone: gm.G
  if (home) zone = gm.buffer(home, 400)
  else {
    // no usable aerodrome polygon: grow a cluster of runways from the one nearest the reference point
    const sorted = [...runways].sort((a, b) => a.line.distance(refPt) - b.line.distance(refPt))
    const cluster: gm.G[] = sorted.length ? [sorted[0].line] : []
    let grown = true
    while (grown) {
      grown = false
      const cu = gm.union(cluster)
      for (const r of sorted) if (!cluster.includes(r.line) && r.line.distance(cu) < 1500) { cluster.push(r.line); grown = true }
    }
    zone = cluster.length ? gm.buffer(gm.union(cluster), 1500) : gm.buffer(refPt, 3000)
  }
  const before = { runways: runways.length, taxi: taxi.length, gates: gates.length }
  const keepRw = runways.filter((r) => r.line.intersects(zone))
  runways.length = 0
  runways.push(...keepRw)
  const keepTaxi = taxi.filter((t) => t.line.intersects(zone))
  taxi.length = 0
  taxi.push(...keepTaxi)
  const keepApr = aprons.filter((a) => a.intersects(zone))
  aprons.length = 0
  aprons.push(...keepApr)
  const keepTerm = terminals.filter((t) => t.g.intersects(zone))
  terminals.length = 0
  terminals.push(...keepTerm)
  const keepGates = gates.filter((g) => zone.contains(gm.point(g.p)))
  gates.length = 0
  gates.push(...keepGates)
  const dropped = before.runways - runways.length + before.taxi - taxi.length + before.gates - gates.length
  if (dropped) log.push(`dropped ${before.runways - runways.length} runway, ${before.taxi - taxi.length} taxiway and ${before.gates - gates.length} gate ways that belong to other airfields nearby`)
  log.push(`OSM: ${runways.length} runways, ${taxi.length} taxiway/lane ways, ${aprons.length} aprons, ${terminals.length} terminals, ${gates.length} gates, ${osmBuildings.length} buildings${home ? ' (inside the aerodrome boundary)' : ' (runway cluster, no aerodrome polygon)'}`)

  // ---- map frame from the runways (fallback: aerodrome, then everything)
  let extent: gm.G
  if (runways.length) extent = gm.union(runways.map((r) => r.line))
  else if (aerodrome) extent = aerodrome
  else extent = gm.union([...taxi.map((t) => t.line), ...aprons])
  const env = extent.getEnvelopeInternal()
  const frame = { minx: env.getMinX() - opts.padM, miny: env.getMinY() - opts.padM, maxx: env.getMaxX() + opts.padM, maxy: env.getMaxY() + opts.padM }
  const fit = fitBoard(frame, opts.maxWidthMm, opts.maxHeightMm, opts.marginMm)
  const frameBox = gm.box(frame.minx, frame.miny, frame.maxx, frame.maxy)
  log.push(`frame ${(frame.maxx - frame.minx).toFixed(0)} x ${(frame.maxy - frame.miny).toFixed(0)} m -> board ${fit.w} x ${fit.h} mm at 1:${fit.scale}`)

  // ---- pavement: FAA polygons when available, else OSM buffered centrelines + aprons + runway strips
  const faaTwy = faaPolys(faa, 'AM_Taxiway', prj)
  const faaApr = faaPolys(faa, 'AM_Apron', prj)
  const faaRwy = faaPolys(faa, 'AM_Runway', prj)
  const faaBld = faaPolys(faa, 'AM_Building', prj)
  const faaStp = faaPolys(faa, 'AM_Stopway', prj)
  const useFaa = faaTwy.length > 0 && faaRwy.length > 0
  const rwyStrips = runways.map((r) => gm.buffer(r.line, r.widthM / 2, { cap: 'flat', join: 'mitre' }))
  let rwyPolys: gm.G[] = useFaa ? faaRwy.map((x) => x.g) : rwyStrips
  const rwyUnion = gm.union(rwyPolys)
  let pavement: gm.G
  if (useFaa) {
    pavement = gm.union([...faaTwy, ...faaApr, ...faaRwy, ...faaStp].map((x) => x.g))
    log.push(`FAA airport mapping used: ${faaTwy.length} taxiway, ${faaApr.length} apron, ${faaRwy.length} runway, ${faaBld.length} building, ${faaStp.length} stopway polygons`)
  } else {
    const twBuf = taxi.map((t) => gm.buffer(t.line, (t.kind === 'taxiway' ? 23 : 15) / 2, { cap: 'round', join: 'round', segs: 6 }))
    pavement = gm.union([...twBuf, ...aprons, ...rwyStrips])
    pavement = gm.buffer(gm.buffer(pavement, 2), -2)
    log.push('OSM pavement (buffered centrelines + aprons)')
  }
  pavement = gm.dropSmallHoles(gm.simplify(pavement, 0.8), 2500)
  const stopUnion = gm.union(faaStp.map((x) => x.g))

  // ---- terminals (hatched copper) and other buildings
  const termUnion = gm.union(terminals.map((t) => t.g))
  let termArt: gm.G = termUnion
  if (useFaa && faaBld.length) {
    const tb = faaBld.filter((b) => b.g.intersects(termUnion)).map((b) => b.g)
    if (tb.length) termArt = gm.union(tb)
  }
  let buildings = osmBuildings.filter((b) => b.intersection(termUnion).getArea() < 0.5 * b.getArea() && b.distance(pavement) < 50)
  if (useFaa && faaBld.length) {
    const fb = faaBld.map((b) => b.g).filter((b) => !b.intersects(termArt))
    buildings = [...fb, ...buildings.filter((b) => !fb.some((f) => f.intersects(b)))]
  }

  // ---- landside: roads, rail, parking (clipped to the frame; airside service roads dropped)
  const lines: LineFeature[] = []
  const polys: PolyFeature[] = []
  const addPolys = (cls: PolyFeature['cls'], g: gm.G, name?: string): void => {
    for (const p of gm.polygonsOf(g.intersection(frameBox))) polys.push({ id: newId('p'), cls, name, rings: gm.ringsOf(p) })
  }
  addPolys('pavement', pavement)
  for (const r of rwyPolys) addPolys('runway', r)
  if (!stopUnion.isEmpty()) addPolys('stopway', stopUnion.difference(rwyUnion))
  addPolys('terminal', termArt)
  for (const p of polys) if (p.cls === 'terminal') Object.assign(p, { layer: 'copper', fill: 'hatch' })
  for (const b of buildings) addPolys('building', gm.simplify(b, 1.0))

  // ---- landside from the configurable sources (roads, rail, parking, water), cut under airside features
  const airsideCut = gm.union([gm.buffer(pavement, 5), gm.buffer(termArt, 3), ...buildings.map((b) => gm.buffer(b, 2))])
  const src = applySources(specs, osm.landside, { prj, frame: frameBox, aerodrome: aerodrome ?? gm.empty(), airside: airsideCut, pavement })
  lines.push(...src.lines)
  polys.push(...src.polys)
  log.push(`landside: ${Object.entries(src.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`)

  // ---- taxiway centrelines (stop short of runway pavement and inside terminals)
  const cut = gm.union([gm.buffer(rwyUnion, 8), gm.buffer(termArt, 0.3)])
  for (const t of taxi) {
    for (const pts of gm.linesOf(t.line.difference(cut).intersection(frameBox)).map(gm.ptsOf)) lines.push({ id: newId('l'), cls: t.kind, name: t.ref, pts })
  }
  // runway centrelines carry the runway identity for LED placement and markings
  for (const r of runways) lines.push({ id: newId('l'), cls: 'runway_cl', sub: 'axis', name: r.ref, pts: gm.ptsOf(r.line), widthM: r.widthM, widthMm: 0.15 })
  // runway markings: threshold bars and centreline dashes
  for (const r of runways) {
    const ix = gm.indexLine(r.line)
    const w = r.widthM
    for (const [s0, dir] of [
      [0, 1],
      [ix.length, -1]
    ] as [number, number][]) {
      for (let k = 0; k < 2; k++) {
        const d = s0 + dir * (60 + k * 25)
        const c = ix.at(d)
        const [tx, ty] = ix.tangent(d)
        const nx = -ty
        const ny = tx
        const half = w * 0.42
        lines.push({ id: newId('l'), cls: 'runway_cl', sub: 'marking', name: `${r.ref} threshold`, pts: [[c[0] + nx * half, c[1] + ny * half], [c[0] - nx * half, c[1] - ny * half]], widthMm: 0.45 })
      }
    }
    for (let d = 180; d < ix.length - 180; d += 60) {
      lines.push({ id: newId('l'), cls: 'runway_cl', sub: 'marking', name: `${r.ref} centreline`, pts: [ix.at(d), ix.at(Math.min(ix.length - 180, d + 30))], widthMm: 0.18 })
    }
  }

  const project: Project = {
    version: 1,
    board: {
      id: (airport.icao || airport.ident).toLowerCase(),
      name: airport.name,
      icao: airport.icao || airport.ident,
      iata: airport.iata,
      elevationFt: airport.elevFt,
      widthMm: fit.w,
      heightMm: fit.h,
      marginMm: opts.marginMm,
      cornerRadiusMm: 5,
      refLat: airport.lat,
      refLon: airport.lon,
      utmZone: prj.zone,
      north: prj.north
    },
    frame,
    polys,
    lines,
    leds: [],
    labels: [],
    placement: { ...DEFAULT_PLACEMENT },
    layerVisibility: {},
    sources: specs.map((x) => ({ ...x, style: { ...x.style } })),
    aerodrome: aerodrome ? gm.polygonsOf(gm.simplify(aerodrome, 2)).map((g) => gm.ringsOf(g)[0]) : undefined,
    source: {
      osmFetchedAt: osm.fetchedAt,
      osmElements: osm.aero.length + osm.landside.length,
      overpassUrl: osm.url,
      faaFetchedAt: faa ? new Date().toISOString() : undefined,
      faaLayers: faa ? Object.fromEntries(Object.entries(faa).map(([k, v]) => [k, v.length])) : undefined
    }
  }
  ;(project as Project & { gates?: { ref: string; p: Pt }[] }).gates = gates
  return { project, runways, log: logLines }
}

/** Lon/lat bounding box of a frame, padded, for the landside query. */
export function frameLLBox(frame: { minx: number; miny: number; maxx: number; maxy: number }, prj: Projection, padM = 200): LLBox {
  const c = [
    prj.inverse(frame.minx - padM, frame.miny - padM),
    prj.inverse(frame.maxx + padM, frame.miny - padM),
    prj.inverse(frame.maxx + padM, frame.maxy + padM),
    prj.inverse(frame.minx - padM, frame.maxy + padM)
  ]
  return {
    south: Math.min(...c.map((q) => q[1])),
    north: Math.max(...c.map((q) => q[1])),
    west: Math.min(...c.map((q) => q[0])),
    east: Math.max(...c.map((q) => q[0]))
  }
}

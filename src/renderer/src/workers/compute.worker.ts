/// <reference lib="webworker" />
// Compute worker: everything CPU-heavy (JSTS geometry, placement, label fitting, SVG export) runs here so the editor
// never freezes. The page talks to it through services/compute.ts; progress lines stream back to the busy overlay.
import { buildProject } from '../core/build'
import { placeAll, ledSummary } from '../core/place'
import { generateLabels, northArrow, resolveLabelCollisions } from '../core/labels'
import { designatorLabels } from '../core/markings'
import { applySources, sourcesOf } from '../core/sources'
import { exportAll, loadFonts } from '../core/export'
import { buildPcbJob } from '../core/pcbjob'
import { makeBackArt, parseBackArt } from '../core/backart'
import { makeTransform } from '../core/transform'
import { utmFor } from '../core/geo'
import * as gm from '../core/geom'
import type { Project } from '../core/model'
import type { ComputeOps, FromWorker, OpName, ToWorker } from './compute-types'

type Handler<K extends OpName> = (args: ComputeOps[K]['args'], log: (s: string) => void) => Promise<ComputeOps[K]['result']> | ComputeOps[K]['result']

const ops: { [K in OpName]: Handler<K> } = {
  build: ({ airport, osm, faa, opts, specs }, log) => {
    log('building the airport geometry…')
    const res = buildProject(airport, osm, faa, opts, specs, log)
    return { project: res.project, log: res.log }
  },
  place: ({ project, gates }, log) => {
    log('placing LEDs…')
    const t0 = performance.now()
    const { leds, merged } = placeAll(project, makeTransform(project.board, project.frame), gates)
    const m = Object.entries(merged)
    const summary = `${ledSummary(leds)}${m.length ? `; merged as too close: ${m.map(([k, v]) => `${v} ${k}`).join(', ')}` : ''} (${((performance.now() - t0) / 1000).toFixed(1)} s)`
    log(summary)
    return { leds, summary, merged }
  },
  labels: async ({ project }, log) => {
    const fonts = await loadFonts()
    const t = makeTransform(project.board, project.frame)
    log('generating labels…')
    const kept = project.labels.filter((l) => l.locked)
    // runway end style 'chevrons': the designators live in the chevrons (kept, locked) and the name labels may be off
    const chev = project.runwayMarkings?.endStyle === 'chevrons'
    const dropNames = chev && project.runwayMarkings?.removeRunwayNames !== false
    const labels = [...kept, ...generateLabels(project, t).filter((g) => !kept.some((k) => k.kind === g.kind && k.text === g.text) && !(dropNames && g.kind === 'runway'))]
    if (!chev) for (const l of project.lines.filter((x) => x.cls === 'runway_cl' && x.sub === 'axis')) labels.push(...designatorLabels(l, t))
    const arrow = northArrow(project, t)
    log(`resolving collisions between ${labels.length} labels and ${project.leds.length} LEDs…`)
    const p2: Project = { ...project, labels }
    const result = resolveLabelCollisions(p2, t, fonts)
    return { labels: p2.labels, northArrow: arrow, result }
  },
  resolve: async ({ project, dropUnplaceable }, log) => {
    const fonts = await loadFonts()
    log(`resolving collisions between ${project.labels.length} labels and ${project.leds.length} LEDs…`)
    const result = resolveLabelCollisions(project, makeTransform(project.board, project.frame), fonts, { dropUnplaceable })
    return { labels: project.labels, result }
  },
  sources: ({ project: p, elements }, log) => {
    log(`drawing the landside from ${elements.length.toLocaleString()} OSM elements…`)
    const prj = utmFor(p.board.refLat, p.board.refLon)
    const frame = gm.box(p.frame.minx, p.frame.miny, p.frame.maxx, p.frame.maxy)
    const polyU = (cls: string[]): gm.G => gm.union(p.polys.filter((x) => cls.includes(x.cls) && !x.src).map((x) => gm.polygon(x.rings)))
    const pavement = polyU(['pavement'])
    log('airside mask (pavement, terminals, buildings)…')
    const airside = gm.union([gm.buffer(pavement, 5), gm.buffer(polyU(['terminal']), 3), gm.buffer(polyU(['building']), 2)])
    const aerodrome = p.aerodrome?.length ? gm.union(p.aerodrome.map((r) => gm.polygon([r]))) : gm.empty()
    const res = applySources(sourcesOf(p as Project), elements, { prj, frame, aerodrome, airside, pavement })
    return res
  },
  pcbjob: ({ project }, log) => buildPcbJob(project, log),
  backart: ({ text, name, prev }, log) => {
    log(`parsing ${(text.length / 1e6).toFixed(1)} MB…`)
    const r = parseBackArt(text, name)
    if (r.art) return { art: { ...r.art, source: r.source }, notes: r.notes, boardMm: r.boardMm }
    log(`${r.polys.length.toLocaleString()} polygons: encoding…`)
    const art = makeBackArt(r.polys, r.source, prev)
    return { art, notes: r.notes, boardMm: r.boardMm }
  },
  export: async ({ project }, log) => {
    log('writing board.json, lights.json and the artwork SVGs…')
    return exportAll(project)
  }
}

const post = (m: FromWorker): void => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

self.onmessage = async (ev: MessageEvent<ToWorker>): Promise<void> => {
  const { id, op, args } = ev.data
  const log = (msg: string): void => post({ id, type: 'progress', msg })
  const t0 = performance.now()
  try {
    const handler = ops[op] as Handler<OpName>
    if (!handler) throw new Error(`unknown op ${op}`)
    const result = await handler(args as never, log)
    post({ id, type: 'done', result, ms: performance.now() - t0 })
  } catch (e) {
    post({ id, type: 'error', error: String((e as Error)?.message ?? e), stack: (e as Error)?.stack })
  }
}

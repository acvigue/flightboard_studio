// Studio project -> generator job (pcbgen-job/1, see pcbgen gen/Job.cs): LEDs, block poses, user chain edits and the
// artwork as polygons (the same geometry as the SVG export: strokes buffered, hatches, text flattened with holes).
// Back silk = the imported back art plus the drawn silkBack features (labels mirrored to read from the back).
// Board mm, origin top-left, y down. Runs in the compute worker (JSTS work on the whole board).
import * as gm from './geom'
import { makeTransform } from './transform'
import { utmFor } from './geo'
import { backSilkOn, collectBackSilk, collectTopCopper, collectTopSilk, labelPolys, loadFonts, type ArtSink } from './export'
import { backArtPolys } from './backart'
import type { PcbBlockPose, Project } from './model'

type Ring = [number, number][]
type Poly = Ring[]
export interface PcbJob {
  schema: 'pcbgen-job/1'
  name: string
  board: { w: number; h: number; cornerR: number }
  leds: { id: string; x: number; y: number; rot: number; size: number; feature?: string; chain?: number; index?: number; lat?: number; lon?: number }[]
  art: { silk: Poly[]; silkBack: Poly[]; copper: Poly[] }
  blocks: PcbBlockPose[]
  options: { channels: number; routeData: boolean; ledArtMargin: number; backSilkClearVias: boolean }
  meta: Record<string, unknown>
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4
function pushPolys(g: gm.G, out: Poly[]): void {
  for (const p of gm.polygonsOf(g)) {
    const rings = gm.ringsOf(p).map((r) => {
      const pts = r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r
      return pts.map(([x, y]) => [r4(x), r4(y)] as [number, number])
    })
    if (rings[0]?.length >= 3) out.push(rings)
  }
}

/** The job's LEDs (board mm, y down; hand chain edits as chain / index). Also what the live route preview sends. */
export function pcbJobLeds(p: Project): PcbJob['leds'] {
  const tf = makeTransform(p.board, p.frame)
  const prj = utmFor(p.board.refLat, p.board.refLon)
  return p.leds.map((l) => {
    const [x, y] = tf.toMm(l.pos)
    const [lon, lat] = prj.inverse(l.pos[0], l.pos[1])
    const o: PcbJob['leds'][number] = { id: l.id, x: r4(x), y: r4(y), rot: Math.round(l.rotDeg * 100) / 100, size: l.size >= 1.25 ? 1.5 : 1.0, lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7 }
    const f = l.feature || l.label
    if (f) o.feature = f
    if (l.chainUser && l.chain) {
      o.chain = l.chain
      if (l.chainLocked && l.chainIndex !== undefined) o.index = l.chainIndex
    }
    return o
  })
}

/** Project name for the Altium files: IATA code when known, else the ICAO / board id. */
export const pcbName = (p: Project): string => (p.board.iata || p.board.icao || p.board.id || 'BOARD').toUpperCase().replace(/[^A-Z0-9_-]/g, '')

export async function buildPcbJob(p: Project, log: (s: string) => void = () => undefined): Promise<PcbJob> {
  const tf = makeTransform(p.board, p.frame)
  const fs = await loadFonts()
  const silk: Poly[] = []
  const copper: Poly[] = []
  const sink = (out: Poly[]): ArtSink => ({ geom: (g) => pushPolys(g, out), label: (lb) => { for (const g of labelPolys(fs, lb, tf)) pushPolys(g, out) } })
  log('top silkscreen as polygons…')
  collectTopSilk(p, tf, fs, sink(silk))
  log('exposed copper as polygons…')
  collectTopCopper(p, tf, sink(copper))
  const silkBack: Poly[] = []
  if (p.backArt && p.backArt.visible && backSilkOn(p)) {
    log(`back art: ${p.backArt.count.toLocaleString()} imported polygons…`)
    for (const poly of backArtPolys(p.backArt)) silkBack.push(poly)
  }
  const drawn = collectBackSilk(p, tf, fs, sink(silkBack))
  if (drawn) log(`back silk: ${drawn} drawn items as polygons`)
  const leds = pcbJobLeds(p)
  log(`job: ${leds.length} LEDs, ${silk.length} silk, ${silkBack.length} back silk and ${copper.length} copper polygons`)
  return {
    schema: 'pcbgen-job/1',
    name: pcbName(p),
    board: { w: p.board.widthMm, h: p.board.heightMm, cornerR: p.board.cornerRadiusMm },
    leds,
    art: { silk, silkBack, copper },
    blocks: (p.pcb?.blocks ?? []).map((b) => ({ ...b })),
    options: { channels: p.pcb?.channels ?? 7, routeData: p.pcb?.routeData ?? true, ledArtMargin: p.pcb?.ledArtMargin ?? 0.1, backSilkClearVias: p.pcb?.backSilkClearVias ?? false },
    meta: { generator: 'flightboard-studio', board: p.board.id, icao: p.board.icao, iata: p.board.iata, name: p.board.name, scale: Math.round(tf.scale) }
  }
}

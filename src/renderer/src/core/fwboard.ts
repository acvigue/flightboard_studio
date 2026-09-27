// Firmware board definition for ../flightboard (boards/<id>.json, schema 1; tools/gen_board_hpp.py turns it into the
// constexpr header). Built from the studio project plus the Altium generator's final chains (chain / index /
// designator per LED id), so the firmware drives exactly the chain order that was routed on the PCB.
import { makeTransform } from './transform'
import { utmFor } from './geo'
import type { Led, Project, Pt } from './model'

export interface ChainOf {
  id: string
  chain: number
  index: number
  designator: string
}

const r7 = (v: number): number => Math.round(v * 1e7) / 1e7
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3
const bearing = (p: Pt, q: Pt): number => ((Math.atan2(q[0] - p[0], q[1] - p[1]) * 180) / Math.PI + 360) % 360   // UTM x east, y north
// wire colour order per part (datasheets: MEIHUA MHP1515ICRGBDT Rev.1 RGB, OPSCO SK6805-EC10 Rev.A0 GRB)
const ORDER: Record<string, 'RGB' | 'GRB'> = { MHP1515ICRGBDT: 'RGB', 'SK6805-EC10-000': 'GRB' }
// the part the generator places per size class: MHP1515 cell for 1.5 mm, the SK6805-EC10 cell for everything under
// 1.25 mm (pcbgen Job.ToLeds: Small = size < 1.25)
const PART: Record<string, string> = { '1.5': 'MHP1515ICRGBDT', '1.1': 'SK6805-EC10-000', '1': 'SK6805-EC10-000', '1.0': 'SK6805-EC10-000' }

function expandGate(label: string): string[] {
  let prefix = ''
  return label.split('/').map((p) => {
    const m = /^([A-Z]+)?(\d+[A-Z]?)$/.exec(p.trim())
    if (!m) return p.trim()
    if (m[1]) prefix = m[1]
    return prefix + m[2]
  })
}

export interface GpioOf {
  chain: number
  gpio: number
}

/** gpios: the MCU data pin of every chain (from the generator's report); a chain without one is an error. */
export function buildFirmwareBoard(p: Project, chains: ChainOf[], opts: { id?: string; name?: string; bboxMarginDeg?: number; gpios: GpioOf[]; statusGpio?: number; spareGpios?: number[] }): Record<string, unknown> {
  const tf = makeTransform(p.board, p.frame)
  const prj = utmFor(p.board.refLat, p.board.refLon)
  const ll = (x: number, y: number): [number, number] => {
    const [lon, lat] = prj.inverse(x, y)
    return [lat, lon]
  }
  const mmLL = (mm: Pt): [number, number] => {
    const m = tf.toM(mm)
    return ll(m[0], m[1])
  }
  const byId = new Map(chains.map((c) => [c.id, c]))
  const chainNos = [...new Set(chains.map((c) => c.chain))].sort((a, b) => a - b)
  const chainDefs: { name: string; start: number; count: number; gpio: number }[] = []
  let start = 0
  for (const k of chainNos) {
    const count = chains.filter((c) => c.chain === k).length
    const pins = opts.gpios.filter((g) => g.chain === k)
    if (pins.length !== 1) throw new Error(`firmware board: CH${k} has ${pins.length ? 'several data pins' : 'no data pin'} in the generator report`)
    chainDefs.push({ name: `CH${k}`, start, count, gpio: pins[0].gpio })
    start += count
  }
  const used = chainDefs.map((c) => c.gpio).concat(opts.statusGpio !== undefined ? [opts.statusGpio] : [])
  if (new Set(used).size !== used.length) throw new Error(`firmware board: a GPIO drives two chains (${used.join(', ')})`)
  const startOf = new Map(chainNos.map((k, i) => [k, chainDefs[i].start]))

  type FwLed = { ref: string; chain: number; idx: number; g: number; x: number; y: number; lat: number; lon: number; kind: string; role: string; name: string; rot: number; pkg: number; cap: string; feature?: number; _led: Led }
  const leds: FwLed[] = []
  for (const l of p.leds) {
    const c = byId.get(l.id)
    if (!c) continue
    const [x, y] = tf.toMm(l.pos)
    const [lat, lon] = ll(l.pos[0], l.pos[1])
    const kind = l.cls === 'ramp' ? 'taxiway' : l.cls
    const name = l.cls === 'ramp' ? 'ramp' : l.cls === 'gate' ? l.label || l.feature || '' : l.feature || ''
    leds.push({
      ref: c.designator, chain: chainNos.indexOf(c.chain), idx: c.index, g: (startOf.get(c.chain) ?? 0) + c.index,
      x: r3(x), y: r3(y), lat: r7(lat), lon: r7(lon), kind, role: l.role || '', name, rot: Math.round(l.rotDeg * 100) / 100,
      pkg: l.size, cap: c.designator.replace(/^D/, 'C'), _led: l
    })
  }
  leds.sort((a, b) => a.g - b.g)

  // features: runways (LEDs ordered along the axis, ends named from the designators), taxiways by name, one per gate
  const features: Record<string, unknown>[] = []
  const featIndex = new Map<string, number>()
  const add = (f: Record<string, unknown>): void => {
    featIndex.set(`${f.kind}|${f.name}`, features.length)
    features.push(f)
  }
  const axes = new Map(p.lines.filter((l) => l.cls === 'runway_cl' && l.sub === 'axis' && l.name).map((l) => [l.name!, l.pts]))
  for (const name of [...new Set(leds.filter((l) => l.kind === 'runway').map((l) => l.name))].sort()) {
    const pts = axes.get(name)
    // a runway-crossing LED belongs to both runways (its own feature is the first one)
    const idxs = leds.filter((l) => l.kind === 'runway' && (l.name === name || (l._led.alsoFeatures ?? []).includes(name)))
    if (!pts || pts.length < 2) {
      add({ kind: 'runway', name, leds: idxs.map((l) => l.g) })
      continue
    }
    const [d1, d2] = name.split('/')
    let p0 = pts[0]
    let p1 = pts[pts.length - 1]
    const h1 = ((Number((d1 ?? '').replace(/\D/g, '')) || 0) % 36) * 10
    if (Math.abs(((bearing(p0, p1) - h1 + 540) % 360) - 180) > 90) [p0, p1] = [p1, p0]
    const brg = bearing(p0, p1)
    const ux = Math.sin((brg * Math.PI) / 180)
    const uy = Math.cos((brg * Math.PI) / 180)
    const along = (l: FwLed): number => (l._led.pos[0] - p0[0]) * ux + (l._led.pos[1] - p0[1]) * uy
    const ordered = [...idxs].sort((a, b) => along(a) - along(b)).map((l) => l.g)
    const [la0, lo0] = ll(p0[0], p0[1])
    const [la1, lo1] = ll(p1[0], p1[1])
    add({
      kind: 'runway', name, heading: Math.round(brg * 10) / 10, length_m: Math.round(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])),
      ends: [
        { name: d1, lat: r7(la0), lon: r7(lo0), heading: Math.round(brg * 10) / 10 },
        { name: d2 ?? '', lat: r7(la1), lon: r7(lo1), heading: Math.round(((brg + 180) % 360) * 10) / 10 }
      ],
      leds: ordered
    })
  }
  for (const name of [...new Set(leds.filter((l) => l.kind === 'taxiway').map((l) => l.name))].sort((a, b) => Number(a === '') - Number(b === '') || a.length - b.length || a.localeCompare(b)))
    add({ kind: 'taxiway', name, leds: leds.filter((l) => l.kind === 'taxiway' && l.name === name).map((l) => l.g) })
  for (const l of leds.filter((q) => q.kind === 'gate')) {
    const names = expandGate(l.name)
    add({ kind: 'gate', name: l.name, names, concourse: /^[A-Z]*/.exec(names[0] ?? '')?.[0] ?? '', leds: [l.g] })
  }
  for (const l of leds) l.feature = featIndex.get(`${l.kind}|${l.name}`) ?? 0

  const W = p.board.widthMm
  const H = p.board.heightMm
  const tl = mmLL([0, 0])
  const br = mmLL([W, H])
  const c = mmLL([W / 2, H / 2])
  const m = opts.bboxMarginDeg ?? 0.12
  const packages: Record<string, { count: number; part: string; gain: number; order: 'RGB' | 'GRB' }> = {}
  for (const l of leds) {
    const k = l.pkg === 1 ? '1.0' : String(l.pkg)
    packages[k] = packages[k] ?? { count: 0, part: PART[k] ?? '', gain: 1.0, order: ORDER[PART[k] ?? ''] ?? 'GRB' }
    packages[k].count++
  }
  const polysOf = (cls: string[]): number[][][] =>
    p.polys.filter((x) => cls.includes(x.cls) && !x.src).map((x) => x.rings[0].map((q) => tf.toMm(q)).map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]))
  return {
    schema: 1,
    id: opts.id ?? p.board.id,
    name: opts.name ?? p.board.name,
    icao: p.board.icao,
    iata: p.board.iata,
    elevation_ft: p.board.elevationFt,
    origin: { lat: r7(c[0]), lon: r7(c[1]) },
    board_mm: { w: W, h: H },
    geo: { scale: Math.round(tf.scale), mm_per_m: tf.k, epsg: prj.epsg, fx0: tf.fx0, fy0: tf.fy0, minx: p.frame.minx, maxy: p.frame.maxy, corners: { top_left: { lat: r7(tl[0]), lon: r7(tl[1]) }, bottom_right: { lat: r7(br[0]), lon: r7(br[1]) } } },
    feed_bbox: { north: Math.round((Math.max(tl[0], br[0]) + m) * 1e4) / 1e4, south: Math.round((Math.min(tl[0], br[0]) - m) * 1e4) / 1e4, west: Math.round((Math.min(tl[1], br[1]) - m * 1.3) * 1e4) / 1e4, east: Math.round((Math.max(tl[1], br[1]) + m * 1.3) * 1e4) / 1e4 },
    chains: chainDefs,
    status_gpio: opts.statusGpio ?? -1,
    spare_gpios: (opts.spareGpios ?? []).filter((g) => !used.includes(g)),
    packages,
    leds: leds.map(({ _led, ...rest }) => { void _led; return rest }),
    features,
    backdrop: { pavement: polysOf(['pavement']), runways: polysOf(['runway']), buildings: polysOf(['building', 'terminal']) },
    generator: 'flightboard-studio'
  }
}

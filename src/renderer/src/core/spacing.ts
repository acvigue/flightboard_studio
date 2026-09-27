// Pad-safe LED spacing. Each LED's copper is modelled as its footprint square rotated with the LED: 1.9 mm for the
// 1.5 mm part (MHP1515 cell: pads 0.70 x 0.65 at the corners), 1.05 mm for the 1.0 / 1.1 mm parts (SK6805-EC10 cell),
// the same envelopes pcbgen uses. The squares enclose the pads, so two LEDs whose squares keep PAD_GAP_MM apart never
// show up in the generator's ledsTooClose check (pads under 0.15 mm apart).
import type { Led, Pt } from './model'
import type { BoardTransform } from './transform'

export const PAD_GAP_MM = 0.15
export const footprintMm = (size: number): number => (size >= 1.25 ? 1.9 : 1.05)
/** Largest centre distance at which two footprints can still be too close, board mm. */
const REACH_MM = (1.9 * Math.SQRT2) / 2 * 2 + PAD_GAP_MM

function square(l: Led, tf: BoardTransform): Pt[] {
  const [cx, cy] = tf.toMm(l.pos)
  const h = footprintMm(l.size) / 2
  const a = (-l.rotDeg * Math.PI) / 180   // visual CCW rotation; board mm are y down
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h]
  ].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as Pt)
}
function inside(poly: Pt[], p: Pt): boolean {
  let pos = 0
  let neg = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if (cr > 0) pos++
    else if (cr < 0) neg++
  }
  return pos === 0 || neg === 0
}
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
/** Gap between the two LEDs' footprint squares in board mm (0 when they overlap). */
export function footprintGapMm(a: Led, b: Led, tf: BoardTransform): number {
  const pa = square(a, tf)
  const pb = square(b, tf)
  if (pa.some((p) => inside(pb, p)) || pb.some((p) => inside(pa, p))) return 0
  let d = Infinity
  for (let i = 0; i < 4; i++) for (const p of pb) d = Math.min(d, segDist(p, pa[i], pa[(i + 1) % 4]))
  for (let i = 0; i < 4; i++) for (const p of pa) d = Math.min(d, segDist(p, pb[i], pb[(i + 1) % 4]))
  return d
}

function grid(leds: Led[], tf: BoardTransform): (l: Led) => Led[] {
  const cell = REACH_MM
  const m = new Map<string, Led[]>()
  const key = (x: number, y: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  for (const l of leds) {
    const [x, y] = tf.toMm(l.pos)
    const k = key(x, y)
    const arr = m.get(k)
    if (arr) arr.push(l)
    else m.set(k, [l])
  }
  return (l) => {
    const [x, y] = tf.toMm(l.pos)
    const i = Math.floor(x / cell)
    const j = Math.floor(y / cell)
    const out: Led[] = []
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(...(m.get(`${i + di},${j + dj}`) ?? []))
    return out
  }
}
const centreMm = (a: Led, b: Led, tf: BoardTransform): number => {
  const [ax, ay] = tf.toMm(a.pos)
  const [bx, by] = tf.toMm(b.pos)
  return Math.hypot(ax - bx, ay - by)
}

/** Every pair of LEDs whose footprints are under PAD_GAP_MM apart, closest first. */
export function tooClosePairs(leds: Led[], tf: BoardTransform): { a: Led; b: Led; gapMm: number }[] {
  const near = grid(leds, tf)
  const out: { a: Led; b: Led; gapMm: number }[] = []
  const index = new Map(leds.map((l, i) => [l, i]))
  for (const a of leds)
    for (const b of near(a)) {
      if (index.get(b)! <= index.get(a)! || centreMm(a, b, tf) > REACH_MM) continue
      const g = footprintGapMm(a, b, tf)
      if (g < PAD_GAP_MM) out.push({ a, b, gapMm: g })
    }
  return out.sort((p, q) => p.gapMm - q.gapMm)
}

const CLASS_RANK: Record<Led['cls'], number> = { runway: 0, taxiway: 1, ramp: 2, gate: 3 }
const rank = (l: Led): number => (l.locked ? -10 : 0) + CLASS_RANK[l.cls] * 2 + (l.role ? 0 : 1)

/** After automatic placement: LEDs too close to keep both are merged. The higher-priority one stays (locked, then
 *  runway > taxiway > ramp > gate, then junction / entry / hold over plain, then the one placed first); two gates merge
 *  like the gate rule (one LED for both stands, labels joined, halfway between). Two locked LEDs are left as they are
 *  (they show up in the too-close list). */
export function spacingPass(leds: Led[], tf: BoardTransform): { leds: Led[]; merged: Record<string, number> } {
  const order = leds.map((l, i) => ({ l, i })).sort((p, q) => rank(p.l) - rank(q.l) || p.i - q.i)
  const kept: Led[] = []
  const cell = REACH_MM
  const m = new Map<string, Led[]>()
  const key = (p: Pt): [number, number] => {
    const [x, y] = tf.toMm(p)
    return [Math.floor(x / cell), Math.floor(y / cell)]
  }
  const cellOf = new Map<Led, string>()
  const add = (l: Led): void => {
    const [i, j] = key(l.pos)
    const k = `${i},${j}`
    const arr = m.get(k)
    if (arr) arr.push(l)
    else m.set(k, [l])
    cellOf.set(l, k)
  }
  const remove = (l: Led): void => {
    const k = cellOf.get(l)
    const arr = k ? m.get(k) : undefined
    if (arr) arr.splice(arr.indexOf(l), 1)
    cellOf.delete(l)
  }
  const neighbours = (l: Led): Led[] => {
    const [i, j] = key(l.pos)
    const out: Led[] = []
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) out.push(...(m.get(`${i + di},${j + dj}`) ?? []))
    return out
  }
  const merged: Record<string, number> = {}
  for (const { l } of order) {
    const clash = neighbours(l).find((o) => centreMm(o, l, tf) <= REACH_MM && footprintGapMm(o, l, tf) < PAD_GAP_MM && !(o.locked && l.locked))
    if (!clash) {
      kept.push(l)
      add(l)
      continue
    }
    merged[l.cls] = (merged[l.cls] ?? 0) + 1
    if (l.cls === 'gate' && clash.cls === 'gate' && !clash.locked) {
      // the gate rule: one LED for both stands
      const refs = new Set([...(clash.label ?? '').split('/'), ...(l.label ?? '').split('/')].filter(Boolean))
      clash.label = [...refs].sort().join('/')
      const mid: Pt = [(clash.pos[0] + l.pos[0]) / 2, (clash.pos[1] + l.pos[1]) / 2]
      // move halfway only if that does not bring it too close to another kept LED
      const old = clash.pos
      remove(clash)
      clash.pos = mid
      if (neighbours(clash).some((o) => o !== clash && footprintGapMm(o, clash, tf) < PAD_GAP_MM)) clash.pos = old
      add(clash)
    }
  }
  // keep the original order of the survivors
  const keep = new Set(kept)
  return { leds: leds.filter((l) => keep.has(l)), merged }
}

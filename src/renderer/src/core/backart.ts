// Imported back silkscreen art (Bottom Overlay): parsing the files it comes in, the compact encoding kept in the
// project, and the forms the editor, the SVG export and the Altium job need.
//
// Coordinates are board mm, origin top-left, y down, as printed on the Bottom Overlay in the board's own (top view)
// coordinates: text in the art reads mirrored from the front and correctly from the back.
//
// Encoding 'um-varint/1' (BackArt.data, base64 of a byte stream of LEB128 varints): the polygon count, then per polygon
// its ring count (exterior first, then holes), per ring its point count and the points as zigzag deltas in whole
// micrometres (x then y) from the previous point; the first point of the stream is relative to 0,0. The ORD street map
// (11,995 polygons, 299k points) is 1.2 MB this way against 15 MB as JSON.
import type { BackArt, Pt } from './model'

export type Ring = Pt[]
export type Poly = Ring[]

// ---------------------------------------------------------------- encoding
class Writer {
  buf = new Uint8Array(1 << 16)
  n = 0
  u(v: number): void {
    if (this.n + 6 > this.buf.length) {
      const b = new Uint8Array(this.buf.length * 2)
      b.set(this.buf)
      this.buf = b
    }
    while (v >= 0x80) {
      this.buf[this.n++] = (v & 0x7f) | 0x80
      v = Math.floor(v / 128)
    }
    this.buf[this.n++] = v
  }
  s(v: number): void {
    this.u(v < 0 ? -2 * v - 1 : 2 * v)
  }
}
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodePolys(polys: Poly[]): string {
  const w = new Writer()
  let px = 0
  let py = 0
  w.u(polys.length)
  for (const poly of polys) {
    w.u(poly.length)
    for (const ring of poly) {
      w.u(ring.length)
      for (const [x, y] of ring) {
        const ix = Math.round(x * 1000)
        const iy = Math.round(y * 1000)
        w.s(ix - px)
        w.s(iy - py)
        px = ix
        py = iy
      }
    }
  }
  return toBase64(w.buf.subarray(0, w.n))
}

/** Decoded art: per polygon its rings as interleaved x, y in mm (offset not applied). */
export function decodeRings(data: string): Float64Array[][] {
  const b = fromBase64(data)
  let i = 0
  const u = (): number => {
    let v = 0
    let m = 1
    for (;;) {
      const c = b[i++]
      v += (c & 0x7f) * m
      if (c < 0x80) return v
      m *= 128
    }
  }
  const s = (): number => {
    const v = u()
    return v % 2 ? -(v + 1) / 2 : v / 2
  }
  let px = 0
  let py = 0
  const np = u()
  const out: Float64Array[][] = []
  for (let k = 0; k < np; k++) {
    const nr = u()
    const rings: Float64Array[] = []
    for (let r = 0; r < nr; r++) {
      const n = u()
      const a = new Float64Array(n * 2)
      for (let j = 0; j < n; j++) {
        px += s()
        py += s()
        a[2 * j] = px / 1000
        a[2 * j + 1] = py / 1000
      }
      rings.push(a)
    }
    out.push(rings)
  }
  return out
}

function signedArea(a: Float64Array): number {
  let s = 0
  const n = a.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) s += a[2 * j] * a[2 * i + 1] - a[2 * i] * a[2 * j + 1]
  return s / 2
}

/** Polygons in board mm with the offset applied (the job's art.silkBack, the SVG export). */
export function backArtPolys(art: BackArt): Poly[] {
  const [ox, oy] = art.offset
  return decodeRings(art.data).map((rings) =>
    rings.map((a) => {
      const ring: Ring = []
      for (let j = 0; j < a.length; j += 2) ring.push([Math.round((a[j] + ox) * 1e4) / 1e4, Math.round((a[j + 1] + oy) * 1e4) / 1e4])
      return ring
    })
  )
}

/** One SVG path for the editor (offset not applied: the editor translates the path). Exteriors and holes are
 *  oriented opposite ways so a nonzero fill shows overlapping polygons as a union and holes as holes. */
export function backArtPathD(art: BackArt): string {
  const parts: string[] = []
  for (const rings of decodeRings(art.data)) {
    rings.forEach((a, r) => {
      const n = a.length / 2
      if (n < 3) return
      const rev = (signedArea(a) < 0) !== (r > 0)
      let d = ''
      for (let k = 0; k < n; k++) {
        const j = rev ? n - 1 - k : k
        d += `${k ? 'L' : 'M'}${Math.round(a[2 * j] * 1000) / 1000} ${Math.round(a[2 * j + 1] * 1000) / 1000}`
      }
      parts.push(d + 'Z')
    })
  }
  return parts.join('')
}

// ---------------------------------------------------------------- building the project object
export function polysStats(polys: Poly[]): { count: number; points: number; areaMm2: number; bounds: [number, number, number, number] } {
  let points = 0
  let area = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const poly of polys)
    poly.forEach((ring, r) => {
      let s = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        const [x, y] = ring[i]
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      points += ring.length
      area += (r ? -1 : 1) * Math.abs(s / 2)
    })
  return { count: polys.length, points, areaMm2: Math.round(area * 10) / 10, bounds: points ? [x0, y0, x1, y1] : [0, 0, 0, 0] }
}

export function makeBackArt(polys: Poly[], source: string, prev?: Partial<BackArt>): BackArt {
  const st = polysStats(polys)
  return {
    source,
    format: 'um-varint/1',
    data: encodePolys(polys),
    ...st,
    offset: [0, 0],
    locked: prev?.locked ?? true,
    visible: prev?.visible ?? true,
    opacity: prev?.opacity ?? 0.35,
    importedAt: new Date().toISOString()
  }
}

/** Mirror left-right about the board's vertical centre line (for art that was drawn as seen from the back). */
export function mirrorBackArt(art: BackArt, boardW: number): BackArt {
  const polys = backArtPolys(art).map((poly) => poly.map((ring) => ring.map(([x, y]) => [Math.round((boardW - x) * 1e4) / 1e4, y] as Pt).reverse()))
  return { ...makeBackArt(polys, art.source, art), importedAt: art.importedAt }
}

/** The art's extent on the board (offset applied) and whether it leaves the board. */
export function backArtExtent(art: BackArt, boardW: number, boardH: number): { x0: number; y0: number; x1: number; y1: number; outside: boolean } {
  const [bx0, by0, bx1, by1] = art.bounds
  const [ox, oy] = art.offset
  const e = { x0: bx0 + ox, y0: by0 + oy, x1: bx1 + ox, y1: by1 + oy }
  return { ...e, outside: e.x0 < -1e-6 || e.y0 < -1e-6 || e.x1 > boardW + 1e-6 || e.y1 > boardH + 1e-6 }
}

// ---------------------------------------------------------------- import
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPt = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1])
const isRing = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && isPt(v[0])

function cleanRing(v: unknown[]): Ring | null {
  const r: Ring = []
  for (const p of v) {
    if (!isPt(p)) return null
    const q = p as number[]
    const last = r[r.length - 1]
    if (!last || last[0] !== q[0] || last[1] !== q[1]) r.push([q[0], q[1]])
  }
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop()
  return r.length >= 3 ? r : null
}
/** A list of polygons ([ring, hole...]) or of plain rings (each one polygon). */
function toPolys(list: unknown[], notes: string[]): Poly[] {
  const out: Poly[] = []
  let skipped = 0
  for (const item of list) {
    if (isRing(item)) {
      const r = cleanRing(item as unknown[])
      if (r) out.push([r])
      else skipped++
    } else if (Array.isArray(item) && item.length && isRing(item[0])) {
      const rings = (item as unknown[][]).map(cleanRing)
      if (rings[0]) out.push([rings[0], ...(rings.slice(1).filter(Boolean) as Ring[])])
      else skipped++
    } else skipped++
  }
  if (skipped) notes.push(`${skipped} entries were not polygons (fewer than 3 points or not [x, y] numbers) and were skipped`)
  return out
}

export interface BackArtImport {
  polys: Poly[]
  source: string
  notes: string[]
  boardMm?: [number, number]
  art?: BackArt            // taken over as it is (another studio project's back art)
}

/** Parse a back-art file: a pcbgen / Python build spec (silk_back: rings), a pcbgen job (art.silkBack: polygons), a
 *  flightboard project (its backArt), or a plain JSON list of polygons or rings in board mm. */
export function parseBackArt(text: string, fileName: string): BackArtImport {
  const notes: string[] = []
  const j = JSON.parse(text) as unknown
  const name = fileName.split('/').pop() ?? fileName
  if (Array.isArray(j)) return { polys: toPolys(j, notes), source: name, notes }
  const o = j as Record<string, unknown>
  if (Array.isArray(o.silk_back)) {
    const bw = o.board_w
    const bh = o.board_h
    return { polys: toPolys(o.silk_back, notes), source: `${name} silk_back`, notes, boardMm: isNum(bw) && isNum(bh) ? [bw, bh] : undefined }
  }
  const art = o.art as Record<string, unknown> | undefined
  if (art && Array.isArray(art.silkBack)) {
    const b = o.board as { w?: number; h?: number } | undefined
    return { polys: toPolys(art.silkBack, notes), source: `${name} art.silkBack`, notes, boardMm: b && isNum(b.w) && isNum(b.h) ? [b.w, b.h] : undefined }
  }
  const ba = o.backArt as BackArt | undefined
  if (ba && ba.format === 'um-varint/1' && typeof ba.data === 'string') {
    const b = o.board as { widthMm?: number; heightMm?: number } | undefined
    return { polys: [], source: `${name} backArt (${ba.source})`, notes, boardMm: b && isNum(b.widthMm) && isNum(b.heightMm) ? [b.widthMm, b.heightMm] : undefined, art: ba }
  }
  for (const k of ['polygons', 'polys', 'silkBack', 'silk_back']) if (Array.isArray(o[k])) return { polys: toPolys(o[k] as unknown[], notes), source: `${name} ${k}`, notes }
  throw new Error('no back art found: expected a list of polygons, a build spec with silk_back, a pcbgen job with art.silkBack or a flightboard project with backArt')
}

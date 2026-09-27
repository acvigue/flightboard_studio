// Pure editing math in board millimetres: item bounds, alignment, distribution, rotation, snapping.
import type { Label, Led, LineFeature, PolyFeature, Pt, SnapSettings } from './model'
import type { BoardTransform } from './transform'
import type { Fonts } from './export'

export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}
export const bcx = (b: Bounds): number => (b.x0 + b.x1) / 2
export const bcy = (b: Bounds): number => (b.y0 + b.y1) / 2
export function unionBounds(bs: Bounds[]): Bounds | null {
  if (!bs.length) return null
  return { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) }
}

export function ledBounds(l: Led, tf: BoardTransform): Bounds {
  const [x, y] = tf.toMm(l.pos)
  const h = l.size / 2
  return { x0: x - h, y0: y - h, x1: x + h, y1: y + h }
}

/** Label text box in mm: unrotated size + rotation about the anchor. Uses real font metrics when loaded. */
export interface LabelBox {
  ax: number // anchor
  ay: number
  x: number  // box origin relative to the anchor, unrotated
  y: number
  w: number
  h: number
  rot: number
  mirror?: boolean // back silk: drawn mirrored about the anchor so it reads from the back
}
export function labelBox(lb: Label, tf: BoardTransform, fonts: Fonts | null): LabelBox {
  const hMm = lb.heightM * tf.k
  const [ax, ay] = tf.toMm(lb.pos)
  let w: number
  if (fonts) {
    const font = lb.weight === 600 ? fonts.semibold : fonts.regular
    w = font.getAdvanceWidth(lb.text, hMm / fonts.capRatio)
  } else w = lb.text.length * (hMm / 0.7) * 0.58
  w += (lb.tracking ?? 0) * hMm * Math.max(0, [...lb.text].length - 1)
  const padX = lb.boxed ? 0.55 : 0.15
  const padY = lb.boxed ? 0.4 : 0.15
  const x = (lb.anchor === 'middle' ? -w / 2 : lb.anchor === 'end' ? -w : 0) - padX
  return { ax, ay, x, y: -hMm - padY, w: w + 2 * padX, h: hMm + 2 * padY, rot: lb.rotDeg, mirror: lb.layer === 'silkBack' }
}
export function labelCorners(b: LabelBox): Pt[] {
  const a = (-b.rot * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const m = b.mirror ? -1 : 1
  const corner = (x: number, y: number): Pt => [b.ax + m * (x * ca - y * sa), b.ay + x * sa + y * ca]
  return [corner(b.x, b.y), corner(b.x + b.w, b.y), corner(b.x + b.w, b.y + b.h), corner(b.x, b.y + b.h)]
}
export function labelBounds(lb: Label, tf: BoardTransform, fonts: Fonts | null): Bounds {
  const c = labelCorners(labelBox(lb, tf, fonts))
  return { x0: Math.min(...c.map((p) => p[0])), y0: Math.min(...c.map((p) => p[1])), x1: Math.max(...c.map((p) => p[0])), y1: Math.max(...c.map((p) => p[1])) }
}
export function ptsBounds(pts: Pt[]): Bounds {
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) }
}
export function lineBounds(l: LineFeature, tf: BoardTransform): Bounds {
  return ptsBounds(l.pts.map((q) => tf.toMm(q)))
}
export function polyBounds(p: PolyFeature, tf: BoardTransform): Bounds {
  return ptsBounds(p.rings.flat().map((q) => tf.toMm(q)))
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
/** Per-item offsets that align a set of bounds. */
export function alignOffsets(bs: Bounds[], mode: AlignMode): Pt[] {
  const u = unionBounds(bs)
  if (!u || bs.length < 2) return bs.map(() => [0, 0])
  return bs.map((b) => {
    switch (mode) {
      case 'left': return [u.x0 - b.x0, 0]
      case 'right': return [u.x1 - b.x1, 0]
      case 'hcenter': return [bcx(u) - bcx(b), 0]
      case 'top': return [0, u.y0 - b.y0]
      case 'bottom': return [0, u.y1 - b.y1]
      case 'vcenter': return [0, bcy(u) - bcy(b)]
    }
  })
}
/** Per-item offsets that space bounds evenly (equal gaps) between the two extreme items. */
export function distributeOffsets(bs: Bounds[], axis: 'h' | 'v'): Pt[] {
  if (bs.length < 3) return bs.map(() => [0, 0])
  const idx = bs.map((_, i) => i).sort((a, b) => (axis === 'h' ? bcx(bs[a]) - bcx(bs[b]) : bcy(bs[a]) - bcy(bs[b])))
  const size = (b: Bounds): number => (axis === 'h' ? b.x1 - b.x0 : b.y1 - b.y0)
  const lo = axis === 'h' ? bs[idx[0]].x0 : bs[idx[0]].y0
  const hi = axis === 'h' ? bs[idx[idx.length - 1]].x1 : bs[idx[idx.length - 1]].y1
  const total = idx.reduce((a, i) => a + size(bs[i]), 0)
  const gap = (hi - lo - total) / (idx.length - 1)
  const out: Pt[] = bs.map(() => [0, 0])
  let cursor = lo
  for (const i of idx) {
    const b = bs[i]
    const cur = axis === 'h' ? b.x0 : b.y0
    out[i] = axis === 'h' ? [cursor - cur, 0] : [0, cursor - cur]
    cursor += size(b) + gap
  }
  return out
}

export function rotatePt(p: Pt, pivot: Pt, deg: number): Pt {
  // visual CCW rotation in a y-down frame
  const a = (-deg * Math.PI) / 180
  const dx = p[0] - pivot[0]
  const dy = p[1] - pivot[1]
  return [pivot[0] + dx * Math.cos(a) - dy * Math.sin(a), pivot[1] + dx * Math.sin(a) + dy * Math.cos(a)]
}
export const norm360 = (d: number): number => ((d % 360) + 360) % 360
export function nearest90(deg: number): number {
  return norm360(Math.round(deg / 90) * 90)
}
export function snapAngle(deg: number, step: number): number {
  return norm360(Math.round(deg / step) * step)
}
/** Angle (visual CCW degrees) of the vector a -> b in mm (y down). */
export function angleOf(a: Pt, b: Pt): number {
  return norm360((Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI)
}

/** Nearest point on a polyline (mm) and its tangent angle. */
export function nearestOnPolyline(p: Pt, pts: Pt[]): { q: Pt; d: number; angle: number } | null {
  let best: { q: Pt; d: number; angle: number } | null = null
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy || 1e-9
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    const q: Pt = [a[0] + t * dx, a[1] + t * dy]
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (!best || d < best.d) best = { q, d, angle: angleOf(a, b) }
  }
  return best
}

export interface SnapResult {
  p: Pt
  kind: 'none' | 'grid' | 'object' | 'line' | 'guide'
  guideX?: number  // a vertical guide line at this x
  guideY?: number
  angle?: number   // tangent of the snapped line, for orientation
}
export interface SnapSources {
  points: (r: number, p: Pt) => Pt[]                       // object points within radius
  lines: (p: Pt, r: number) => { q: Pt; d: number; angle: number } | null
  guidePoints: (p: Pt, r: number) => Pt[]                  // points whose x or y may align
}
export function snapPoint(p: Pt, s: SnapSettings, tolMm: number, src: SnapSources): SnapResult {
  if (s.objects) {
    const pts = src.points(tolMm, p)
    let best: Pt | null = null
    let bd = tolMm
    for (const q of pts) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d < bd) {
        bd = d
        best = q
      }
    }
    if (best) return { p: best, kind: 'object' }
  }
  if (s.lines) {
    const n = src.lines(p, tolMm)
    if (n && n.d < tolMm) return { p: n.q, kind: 'line', angle: n.angle }
  }
  let out: SnapResult = { p, kind: 'none' }
  if (s.guides) {
    const gp = src.guidePoints(p, tolMm * 6)
    let gx: number | undefined
    let gy: number | undefined
    let bdx = tolMm
    let bdy = tolMm
    for (const q of gp) {
      const dx = Math.abs(q[0] - p[0])
      const dy = Math.abs(q[1] - p[1])
      if (dx < bdx) {
        bdx = dx
        gx = q[0]
      }
      if (dy < bdy) {
        bdy = dy
        gy = q[1]
      }
    }
    if (gx !== undefined || gy !== undefined) out = { p: [gx ?? p[0], gy ?? p[1]], kind: 'guide', guideX: gx, guideY: gy }
  }
  if (s.grid && out.kind === 'none') {
    const g = s.gridMm || 0.5
    out = { p: [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g], kind: 'grid' }
  }
  return out
}

// Hatch fills for closed polygons (mm space), used by the exporters. The editor draws the same spec as SVG patterns.
import * as gm from './geom'
import type { HatchSpec } from './model'

export function hatchLines(polyMm: gm.G, spec: HatchSpec, inset = 0.2): gm.G {
  const inner = inset > 0 ? gm.buffer(polyMm, -inset) : polyMm
  if (inner.isEmpty()) return gm.empty()
  const e = inner.getEnvelopeInternal()
  const cx = (e.getMinX() + e.getMaxX()) / 2
  const cy = (e.getMinY() + e.getMaxY()) / 2
  const r = Math.hypot(e.getMaxX() - e.getMinX(), e.getMaxY() - e.getMinY()) / 2 + spec.pitchMm
  const sets = spec.cross ? [spec.angleDeg, spec.angleDeg + 90] : [spec.angleDeg]
  const lines: gm.G[] = []
  for (const ang of sets) {
    const a = (-ang * Math.PI) / 180 // visual CCW in a y-down frame
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    const nx = -dy
    const ny = dx
    for (let s = -r; s <= r; s += spec.pitchMm) {
      lines.push(gm.lineString([[cx + nx * s - dx * r, cy + ny * s - dy * r], [cx + nx * s + dx * r, cy + ny * s + dy * r]]))
    }
  }
  // intersect line by line: a union of two crossing line sets trips JSTS's noding on shared intersection points
  const parts: gm.G[] = []
  for (const l of lines) {
    try {
      parts.push(...gm.linesOf(l.intersection(inner)))
    } catch {
      /* skip a degenerate line */
    }
  }
  return gm.gf.createMultiLineString(parts)
}

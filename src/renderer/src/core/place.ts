// Automatic LED placement (the ORD "P1" rules):
//  runways  : evenly along each runway axis, rotated along it
//  gates    : one LED per OSM gate stand, pushed off the terminal wall, merged when closer than the minimum pitch
//  taxiways : every LED aligned to its centreline; each junction gets a centre LED plus one at the entry of every
//             arm; even fill between junctions; hold-short LEDs outside the runway pavement. Apron lanes (OSM
//             taxilane) use the small part at a tighter pitch.
// Pitches are given in board millimetres and converted with the current scale, so they hold for any board size.
import type { Led, PlacementSettings, Project, Pt } from './model'
import { newId } from './model'
import * as gm from './geom'
import type { BoardTransform } from './transform'
import { spacingPass } from './spacing'

export interface GateNode {
  ref: string
  p: Pt
}

interface Cand {
  pos: Pt
  rot: number
  size: Led['size']
  role: Led['role'] | 'end' | 'fill'
  kind: 'twy' | 'lane'
}

function unionOf(project: Project, cls: string): gm.G {
  return gm.union(project.polys.filter((p) => p.cls === cls).map((p) => gm.polygon(p.rings)))
}

export function placeRunwayLeds(project: Project, tf: BoardTransform, s: PlacementSettings): Led[] {
  const out: Led[] = []
  const pitch = s.runwayPitchMm / tf.k
  const axes = project.lines.filter((l) => l.cls === 'runway_cl' && l.sub === 'axis' && l.pts.length >= 2)
  // where two runway axes cross: ONE LED on the crossing, belonging to both runways (each runway's own evenly spaced
  // LEDs keep half a pitch from it; before, each runway put its own LED there and the two touched)
  const crossings: { pos: Pt; a: (typeof axes)[number]; b: (typeof axes)[number] }[] = []
  for (let i = 0; i < axes.length; i++)
    for (let j = i + 1; j < axes.length; j++) {
      const g = gm.lineString(axes[i].pts).intersection(gm.lineString(axes[j].pts))
      for (const p of gm.pointsOf(g)) {
        const c = p.getCoordinate()
        crossings.push({ pos: [c.x, c.y], a: axes[i], b: axes[j] })
      }
    }
  for (const c of crossings) {
    const ix = gm.indexLine(gm.lineString(c.a.pts))
    const [tx, ty] = ix.tangent(ix.project(c.pos))
    out.push({ id: newId('d'), cls: 'runway', role: 'junction', size: s.sizeRunway, pos: c.pos, rotDeg: gm.visDeg(tx, ty), label: `RWY ${c.a.name} x ${c.b.name}`, feature: c.a.name, alsoFeatures: c.b.name ? [c.b.name] : undefined })
  }
  for (const l of axes) {
    const ix = gm.indexLine(gm.lineString(l.pts))
    const mine = crossings.filter((c) => c.a === l || c.b === l).map((c) => c.pos)
    const n = Math.max(1, Math.round(ix.length / pitch))
    const step = ix.length / n
    let i = 0
    for (let d = step / 2; d < ix.length; d += step, i++) {
      const p = ix.at(d)
      if (mine.some((q) => gm.dist(q, p) < pitch / 2)) continue
      const [tx, ty] = ix.tangent(d)
      out.push({ id: newId('d'), cls: 'runway', role: '', size: s.sizeRunway, pos: p, rotDeg: gm.visDeg(tx, ty), label: `RWY ${l.name} #${i + 1}`, feature: l.name })
    }
  }
  return out
}

export function placeGateLeds(project: Project, tf: BoardTransform, s: PlacementSettings, gates: GateNode[]): Led[] {
  const walls = project.polys.filter((p) => p.cls === 'terminal').flatMap((p) => p.rings.map((r) => gm.indexLine(gm.lineString([...r, r[0]]))))
  const placed: { pos: Pt; refs: string[]; rot: number }[] = []
  const minPitch = s.gateMinPitchMm / tf.k
  for (const g of gates) {
    let pos = g.p
    let rot = 0
    let best: { d: number; ix: gm.Indexed; at: number } | null = null
    for (const ix of walls) {
      const at = ix.project(g.p)
      const q = ix.at(at)
      const d = gm.dist(q, g.p)
      if (d < 150 && (!best || d < best.d)) best = { d, ix, at }
    }
    if (best) {
      const q = best.ix.at(best.at)
      const [tx, ty] = best.ix.tangent(best.at)
      let nx = g.p[0] - q[0]
      let ny = g.p[1] - q[1]
      const n = Math.hypot(nx, ny)
      if (n < 1) {
        nx = -ty
        ny = tx
      } else {
        nx /= n
        ny /= n
      }
      pos = [q[0] + nx * s.gateOffM, q[1] + ny * s.gateOffM]
      rot = gm.visDeg(tx, ty)
    }
    const near = placed.find((p) => gm.dist(p.pos, pos) < minPitch)
    if (near) {
      near.refs.push(g.ref)
      near.pos = [(near.pos[0] * (near.refs.length - 1) + pos[0]) / near.refs.length, (near.pos[1] * (near.refs.length - 1) + pos[1]) / near.refs.length]
    } else placed.push({ pos, refs: [g.ref], rot })
  }
  return placed.map((p) => ({
    id: newId('d'),
    cls: 'gate',
    role: '',
    size: s.sizeGate,
    pos: p.pos,
    rotDeg: p.rot,
    label: [...new Set(p.refs.filter(Boolean))].sort().join('/'),
    feature: p.refs[0]
  }))
}

export function placeTaxiwayLeds(project: Project, tf: BoardTransform, s: PlacementSettings, avoid: Led[]): Led[] {
  const k = tf.k
  const twyLines = project.lines.filter((l) => l.cls === 'taxiway' && l.pts.length > 1)
  const laneLines = project.lines.filter((l) => l.cls === 'taxilane' && l.pts.length > 1)
  if (!twyLines.length && !laneLines.length) return []
  const laneUnion = gm.union(laneLines.map((l) => gm.lineString(l.pts)))
  const named = twyLines.filter((l) => l.name).map((l) => ({ g: gm.lineString(l.pts), ref: l.name! }))
  const namedTree = new gm.Tree<{ g: gm.G; ref: string }>(named.map((n) => [n.g, n]))
  const twyRef = (p: Pt): string => {
    const pt = gm.point(p)
    let best = ''
    let bd = 3.0
    for (const n of namedTree.query(pt, 3.0)) {
      const d = n.g.distance(pt)
      if (d < bd) {
        bd = d
        best = n.ref
      }
    }
    return best
  }
  const rwyUnion = unionOf(project, 'runway')
  const termKeep = gm.buffer(unionOf(project, 'terminal'), 1.5 / k)
  const holdZone = rwyUnion.isEmpty() ? gm.empty() : gm.buffer(rwyUnion, s.holdOffM)
  const holdLine = holdZone.isEmpty() ? null : holdZone.getBoundary()
  const frame = gm.box(project.frame.minx, project.frame.miny, project.frame.maxx, project.frame.maxy)
  const frameIn = gm.buffer(frame, -2.5 / k)

  let net = gm.union([...twyLines, ...laneLines].map((l) => gm.lineString(l.pts))).intersection(frame)
  if (!holdZone.isEmpty()) net = net.difference(holdZone)
  net = net.difference(gm.buffer(unionOf(project, 'terminal'), 0.4 / k))
  const segs = gm.linesOf(net).filter((sg) => sg.getLength() > 0.05 / k)
  const kindOf = (sg: gm.G): 'twy' | 'lane' => (laneUnion.isEmpty() ? 'twy' : laneUnion.distance(gm.point(gm.indexLine(sg).at(sg.getLength() / 2))) < 0.5 ? 'lane' : 'twy')
  const segTree = new gm.Tree<gm.G>(segs.map((sg) => [sg, sg]))

  // junction nodes (degree >= 3) clustered within CLUSTER
  const key = (c: Pt): string => `${c[0].toFixed(2)},${c[1].toFixed(2)}`
  const deg = new Map<string, { n: number; p: Pt }>()
  for (const sg of segs) {
    const pts = gm.ptsOf(sg)
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const kk = key(p)
      const e = deg.get(kk)
      if (e) e.n++
      else deg.set(kk, { n: 1, p })
    }
  }
  const nodes = [...deg.values()].filter((e) => e.n >= 3).map((e) => e.p)
  const cluster = s.clusterMm / k
  const parent = nodes.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const nodeGrid = new gm.PointGrid<number>(Math.max(cluster, 1))
  nodes.forEach((p, i) => nodeGrid.insert(p, i))
  nodes.forEach((p, i) => {
    for (const { item: j } of nodeGrid.near(p, cluster)) if (j > i) parent[find(i)] = find(j)
  })
  const clusters = new Map<number, Pt[]>()
  nodes.forEach((p, i) => {
    const r = find(i)
    if (!clusters.has(r)) clusters.set(r, [])
    clusters.get(r)!.push(p)
  })

  const cands: Cand[] = []
  const zones: { zone: gm.G; c: Pt; kind: 'twy' | 'lane' }[] = []
  const rTwy = s.junctionRadiusTwyMm / k
  const rLane = s.junctionRadiusLaneMm / k
  for (const members of clusters.values()) {
    const cx = members.reduce((a, p) => a + p[0], 0) / members.length
    const cy = members.reduce((a, p) => a + p[1], 0) / members.length
    const c = members.reduce((best, p) => (gm.dist(p, [cx, cy]) < gm.dist(best, [cx, cy]) ? p : best), members[0])
    const cpt = gm.point(c)
    const near = segTree.query(cpt, cluster + 1).filter((sg) => members.some((m) => sg.distance(gm.point(m)) < 0.05))
    const kind: 'twy' | 'lane' = near.some((sg) => kindOf(sg) === 'twy') ? 'twy' : 'lane'
    const spread = Math.max(...members.map((m) => gm.dist(m, c)))
    const zone = gm.buffer(cpt, (kind === 'twy' ? rTwy : rLane) + Math.min(spread, 2.0 / k), { segs: 12 })
    zones.push({ zone, c, kind })
    // centre LED rotation: direction of the longest arm just outside the zone
    let rot = 0
    let bestLen = -1
    for (const sg of near) {
      const outside = sg.difference(zone)
      if (outside.isEmpty() || outside.getLength() <= bestLen) continue
      bestLen = outside.getLength()
      const pts = gm.ptsOf(sg)
      let pair: [Pt, Pt] | null = null
      const zb = gm.buffer(zone, 0.1 / k)
      for (let i = 0; i + 1 < pts.length; i++) if (!zb.contains(gm.point(pts[i])) && !zb.contains(gm.point(pts[i + 1]))) {
        pair = [pts[i], pts[i + 1]]
        break
      }
      if (!pair) pair = [pts[0], pts[pts.length - 1]]
      rot = gm.visDeg(pair[1][0] - pair[0][0], pair[1][1] - pair[0][1])
    }
    cands.push({ pos: c, rot, size: kind === 'twy' ? s.sizeTaxiway : s.sizeRamp, role: 'junction', kind })
  }
  // entry LEDs where the network crosses each zone boundary
  const entries: Cand[] = []
  for (const { zone, c } of zones) {
    const bnd = zone.getBoundary()
    for (const sg of segTree.query(zone)) {
      if (!sg.intersects(bnd)) continue
      const ix = gm.indexLine(sg)
      for (const q of gm.pointsOf(sg.intersection(bnd))) {
        let p: Pt = [q.getX(), q.getY()]
        const kind = kindOf(sg)
        const size = kind === 'lane' ? s.sizeRamp : s.sizeTaxiway
        const need = (size >= 1.5 ? s.minSepMm : s.minSepMm - 0.4) / k + 0.1 / k
        let d = ix.project(p)
        if (gm.dist(p, c) < need) {
          const inward = ix.project(c)
          d += (need - gm.dist(p, c)) * (d >= inward ? 1 : -1)
          p = ix.at(Math.max(0, Math.min(ix.length, d)))
        }
        const [tx, ty] = ix.tangent(d)
        entries.push({ pos: p, rot: gm.visDeg(tx, ty), size, role: 'entry', kind })
      }
    }
  }
  const ent: Cand[] = []
  for (const e of entries) if (!ent.some((f) => gm.dist(e.pos, f.pos) < 2.0 / k)) ent.push(e)
  cands.push(...ent)

  // pieces between zones: dead ends, hold-short points, even fill
  const zoneU = gm.union(zones.map((z) => z.zone))
  const rest = zoneU.isEmpty() ? net : net.difference(zoneU)
  const pieces = gm.linesOf(rest).filter((sg) => sg.getLength() > 0.3 / k)
  const anchors: Pt[] = cands.map((c) => c.pos)
  const gatePts = avoid.filter((l) => l.cls === 'gate').map((l) => l.pos)
  const nearAnchor = (p: Pt): boolean => anchors.some((a) => gm.dist(a, p) < 1.2 / k)
  for (const sg of pieces) {
    const kind = kindOf(sg)
    const size = kind === 'twy' ? s.sizeTaxiway : s.sizeRamp
    const pitch = (kind === 'twy' ? s.twyPitchMm : s.lanePitchMm) / k
    const ix = gm.indexLine(sg)
    const pts = gm.ptsOf(sg)
    for (const [tEnd, p] of [
      [0, pts[0]],
      [ix.length, pts[pts.length - 1]]
    ] as [number, Pt][]) {
      if (nearAnchor(p) || !frameIn.contains(gm.point(p))) continue
      const isHold = holdLine ? holdLine.distance(gm.point(p)) < 0.05 : false
      if (!isHold && ix.length < 1.5 / k) continue
      if (!isHold && kind === 'lane' && gatePts.some((g) => gm.dist(g, p) < 5.0 / k)) continue
      const [tx, ty] = ix.tangent(tEnd)
      const c: Cand = { pos: p, rot: gm.visDeg(tx, ty), size, role: isHold ? 'hold' : 'end', kind }
      cands.push(c)
      anchors.push(p)
    }
    const n = Math.max(1, Math.round(ix.length / pitch))
    for (let i = 1; i < n; i++) {
      const d = (ix.length * i) / n
      const [tx, ty] = ix.tangent(d)
      cands.push({ pos: ix.at(d), rot: gm.visDeg(tx, ty), size, role: 'fill', kind })
    }
  }

  // conflicts: priority junction > entry > hold > end > fill; minimum separation; clear of existing LEDs
  const prio: Record<string, number> = { junction: 0, entry: 1, hold: 2, end: 3, fill: 4 }
  cands.sort((a, b) => prio[a.role] - prio[b.role])
  const clear = 3.0 / k
  const avoidGrid = new gm.PointGrid<Led>(Math.max(clear, 1))
  for (const l of avoid) avoidGrid.insert(l.pos, l)
  const out: Led[] = []
  const outGrid = new gm.PointGrid<Led>(Math.max(s.minSepMm / k, 1))
  for (const c of cands) {
    const pt = gm.point(c.pos)
    if (!frameIn.contains(pt) || termKeep.contains(pt)) continue
    if (avoidGrid.near(c.pos, clear).length) continue
    const sep = (c.size >= 1.5 ? s.minSepMm : s.minSepMm - 0.4) / k
    if (outGrid.near(c.pos, sep).length) continue
    const role: Led['role'] = c.role === 'fill' || c.role === 'end' ? '' : c.role
    const ref = c.kind === 'twy' ? twyRef(c.pos) : ''
    const led: Led = {
      id: newId('d'),
      cls: c.kind === 'twy' ? 'taxiway' : 'ramp',
      role,
      size: c.size,
      pos: c.pos,
      rotDeg: c.rot,
      label: c.kind === 'twy' ? `TWY ${ref} ${role}`.replace(/\s+/g, ' ').trim() : `LANE ${role}`.trim(),
      feature: c.kind === 'twy' ? ref || '' : 'ramp'
    }
    out.push(led)
    outGrid.insert(c.pos, led)
  }
  return out
}

/** Full automatic placement. Locked LEDs are kept and avoided. A last pass merges LEDs whose pads would come under
 *  0.15 mm apart (core/spacing.ts); `merged` counts the LEDs dropped per class. */
export function placeAll(project: Project, tf: BoardTransform, gates: GateNode[]): { leds: Led[]; merged: Record<string, number> } {
  const s = project.placement
  const locked = project.leds.filter((l) => l.locked)
  const runway = placeRunwayLeds(project, tf, s).filter((l) => !locked.some((k) => gm.dist(k.pos, l.pos) < 2.6 / tf.k))
  const gate = placeGateLeds(project, tf, s, gates).filter((l) => !locked.some((k) => gm.dist(k.pos, l.pos) < 2.0 / tf.k))
  const fixed = [...locked, ...runway, ...gate]
  const twy = placeTaxiwayLeds(project, tf, s, fixed)
  return spacingPass([...locked, ...runway, ...gate, ...twy], tf)
}

export function ledSummary(leds: Led[]): string {
  const c: Record<string, number> = {}
  for (const l of leds) c[l.cls] = (c[l.cls] ?? 0) + 1
  const sizes: Record<string, number> = {}
  for (const l of leds) sizes[String(l.size)] = (sizes[String(l.size)] ?? 0) + 1
  return `${leds.length} LEDs: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}; ${Object.entries(sizes).map(([k, v]) => `${v} x ${k} mm`).join(', ')}`
}

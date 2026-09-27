// Shapes of the Altium generator sidecar's replies (pcbgen gen/Sidecar.cs). Board mm, top-left origin, y down;
// describeTemplate geometry in block-local mm (origin at the block's anchor, y down, template orientation).
import type { PcbBlockPose } from './model'

export type Edge = 'top' | 'bottom' | 'left' | 'right'
export interface PcbDescBlock {
  name: string
  kind: 'mcu' | 'usb' | 'dcdc' | 'status' | string
  rule: 'edge-antenna' | 'edge' | 'free'
  preferEdge?: Edge
  outDeg?: number
  edgeRot?: Record<Edge, number>
  size: { w: number; h: number }
  outline: [number, number][]
  bump?: [number, number][]
  bumpBase?: [number, number]
  channelPads?: { channel: number; xy: [number, number] }[]
  pads: { xy: [number, number]; w: number; h: number; rot: number }[]
}
export interface PcbDescribe {
  channels: number
  statusChannel: number
  blocks: PcbDescBlock[]
  notes: string[]
}
export interface PcbCheckBlock {
  name: string
  ok: boolean
  pose: PcbBlockPose
  footprint: [number, number][]
  bump?: [number, number][]
  channelPads?: { channel: number; x: number; y: number }[]
  ledOverlaps: string[]
  silkMm2: number
  copperMm2: number
  overlaps: string[]
  violations: string[]
  usbGapMm?: number
}
export interface PcbCheck {
  blocks: PcbCheckBlock[]
  unplaced: string[]
}
export interface PcbChainStat {
  chain: number
  count: number
  lengthMm: number
  feedMm: number
  longestHopMm: number
  userAssigned: number
}
export interface PcbGpio {
  chain: number
  gpio: number
  pin: string      // symbol pin name, e.g. "GPIO18" or "XTAL 32K P"
  pad: string      // e.g. "U1.24"
  shifter: string  // e.g. "U2.3"
}
export interface PcbReport {
  leds: number
  caps: number
  vias5sw: number
  viasSkipped: number
  capsMovedSide: number
  placedOverArt: { caps: number; vias: number }
  onArtAfterTrim: { caps: number; vias: number; dataViasUnderSilk: number }
  ledsInsideBlocks: number
  data?: { routed: number; failed: number; total: number; vias: number; topOnly: number; trackMm: number; failedNets: string[] }
  art: Record<string, { polygons: number; polygonsCut: number; regions: number; artMm2: number; removedMm2: number; cutShapesMm2: number } | undefined>
  chains: PcbChainStat[]
  capConflicts?: number
  capConflictList?: string[]
  ledsTooClose?: string[]
  /** MCU data pin of each LED channel, read from the generated board (level shifter input -> MCU pad -> symbol pin) */
  gpios: PcbGpio[]
  statusGpio?: PcbGpio
  /** MCU GPIOs with no net on this board (not strapping / flash / PSRAM / USB / UART0): WR / DC of the LED bus */
  spareGpios?: number[]
  blocks: PcbBlockPose[]
  dcdcToUsbGapMm?: number
  sheets: number
  seconds: number
  notes: string[]
}
/** Routed geometry for the preview overlay (board mm, y down); flat arrays: segments x1,y1,x2,y2 / points x,y. */
export interface PcbRoute {
  width: number
  viaDiameter: number
  powerViaDiameter: number
  top: number[]
  bottom: number[]
  vias: number[]
  powerVias: number[]
  caps: number[]          // x, y, rot (CCW from the top; SVG rotate(-rot))
  failed: { net: string; x1: number; y1: number; x2: number; y2: number }[]
  routed: number
  failedCount: number
  dataVias: number
  trackMm: number
  capConflicts?: string[]   // caps that could only go over another part ("C1782 (D1782)")
  ledsTooClose?: string[]   // LED pairs whose pads are under 0.15 mm apart ("D557/D556 0.00 mm")
}
export interface PcbRouteResult {
  route: PcbRoute
  session: string          // the generator keeps this board for live (incremental) updates
  seconds: number
  leds: number
  caps: number
  vias5sw: number
  capsMovedSide: number
  onArtAfterTrim: { caps: number; vias: number; dataViasUnderSilk: number }
  chainStats: PcbChainStat[]
  blocks: PcbBlockPose[]
  chains: { id: string; chain: number; index: number; designator: string }[]
}
/** Reply of routeUpdate: the preview updated in place, or why a full preview is needed. */
export interface PcbRouteUpdate {
  incremental: boolean
  reason?: string
  ms?: number              // time in the generator
  changed?: number         // LEDs changed since the last update
  replaced?: number        // LEDs placed again (changed + neighbours turned around)
  rerouted?: number        // hops routed again
  updates?: number         // incremental updates since the full preview
  route?: PcbRoute
  leds?: number
  caps?: number
  vias5sw?: number
  chainStats?: PcbChainStat[]
  chains?: { id: string; chain: number; index: number; designator: string }[]
}
export interface PcbExportResult {
  outDir: string
  zip?: string
  project: string
  lightMap: string
  files: string[]
  report: PcbReport
  chains: { id: string; chain: number; index: number; designator: string }[]
  route?: PcbRoute
}

/** Placed geometry of a block for a pose, from its template description (mirrors pcbgen BlockDesc). */
export function placeBlock(d: PcbDescBlock, pose: PcbBlockPose | undefined, W: number, H: number): { outline: [number, number][]; bump: [number, number][]; pads: { channel: number; x: number; y: number }[]; rot: number; anchor: [number, number] } {
  let rot: number
  let anchor: [number, number]
  if (d.rule !== 'free') {
    const edge: Edge = (pose?.edge as Edge) ?? d.preferEdge ?? 'bottom'
    rot = d.edgeRot?.[edge] ?? 0
    const t = pose?.t ?? (edge === 'top' || edge === 'bottom' ? W / 2 : H / 2)
    anchor = edge === 'top' ? [t, 0] : edge === 'bottom' ? [t, H] : edge === 'left' ? [0, t] : [W, t]
  } else {
    rot = pose?.rot ?? 0
    anchor = [pose?.x ?? W / 2, pose?.y ?? H / 2]
  }
  const a = (rot * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const M = ([lx, ly]: [number, number]): [number, number] => [anchor[0] + lx * c + ly * s, anchor[1] - lx * s + ly * c]
  return {
    outline: d.outline.map(M),
    bump: (d.bump ?? []).map(M),
    pads: (d.channelPads ?? []).map((p) => { const [x, y] = M(p.xy); return { channel: p.channel, x, y } }),
    rot,
    anchor
  }
}

/** The pose for dragging a block to board point (x, y): edge blocks snap to the nearest edge, free blocks follow. */
export function poseAt(d: PcbDescBlock, prev: PcbBlockPose | undefined, x: number, y: number, W: number, H: number, grid = 0.5): PcbBlockPose {
  const sn = (v: number): number => Math.round(v / grid) * grid
  if (d.rule !== 'free') {
    const cand: [Edge, number][] = [['top', y], ['bottom', H - y], ['left', x], ['right', W - x]]
    const edge = cand.reduce((b, q) => (q[1] < b[1] ? q : b))[0]
    return { name: d.name, edge, t: sn(edge === 'top' || edge === 'bottom' ? x : y) }
  }
  return { name: d.name, x: sn(x), y: sn(y), rot: prev?.rot ?? 0 }
}

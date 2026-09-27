<script setup lang="ts">
// 2D CAD canvas: multi-select (click, shift-click, marquee), snapping with smart guides, move / rotate tools,
// line and polygon drawing, path editing (node tool, pen, scissors, knife), measure tool, context menu.
// "View from back" mirrors the drawing left-right (board x -> W - x) so the back silk can be checked as it will read;
// every tool keeps working in board coordinates through screenToMm / mmToScreen.
// Heavy layers are memoized components; pointer-move state stays outside Vue reactivity where it can.
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useProject, type SelKind } from '../stores/project'
import type { Label, Led, LineFeature, PolyFeature, Pt } from '../core/model'
import * as ed from '../core/edit'
import * as pa from '../core/path'
import PolyLayer from './layers/PolyLayer.vue'
import LineLayer from './layers/LineLayer.vue'
import LedLayer from './layers/LedLayer.vue'
import LabelLayer from './layers/LabelLayer.vue'
import PcbLayer from './layers/PcbLayer.vue'
import { placeBlock, poseAt } from '../core/pcbtypes'
import { backArtPathD } from '../core/backart'

const store = useProject()
const svgEl = ref<SVGSVGElement | null>(null)
const hudEl = ref<HTMLSpanElement | null>(null)
const view = reactive({ x: 20, y: 20, z: 2.0 })
const strokeZ = ref(2.0)
const showAxes = ref(false)
let zoomTimer: ReturnType<typeof setTimeout> | null = null

// transient overlays (reactive, small)
const pending = ref<Pt[]>([])            // line / polygon / pen path being drawn (mm)
const pendingCursor = ref<Pt>([0, 0])
const penExt = ref<{ id: string; end: 'start' | 'end' } | null>(null) // pen: extending an existing line
const marquee = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
const guides = ref<{ x?: number; y?: number; p?: Pt }>({})
const measure = ref<{ a: Pt; b: Pt | null } | null>(null)
const rotateUi = ref<{ pivot: Pt; angle: number } | null>(null)
const knifeUi = ref<{ a: Pt; b: Pt } | null>(null)
const shapeUi = ref<Pt[] | null>(null) // rectangle / ellipse / polygon preview (mm)
const panning = ref(false)              // a pan drag is under way (grabbing cursor)

const tf = computed(() => store.tf)
const board = computed(() => {
  void store.rev.board
  return store.project?.board ?? null
})
const boardW = computed(() => board.value?.widthMm ?? 100)
const boardH = computed(() => board.value?.heightMm ?? 100)
const selIds = computed(() => store.selectedIds)
const srcColors = computed(() => Object.fromEntries(store.sources.map((s) => [s.key, s.color])))

// ---------------------------------------------------------------- front / back
const flip = computed(() => store.viewBack)
/** Board x as drawn on screen (mirrored in the back view); its own inverse. */
const dispX = (x: number): number => (flip.value ? boardW.value - x : x)
const backOn = computed(() => store.isVisible('backsilk'))
const isBack = (x: { layer?: string }): boolean => x.layer === 'silkBack'
const polys = computed(() => {
  void store.rev.polys
  void store.rev.vis
  return (store.project?.polys ?? []).filter((x) => store.isVisible(x.cls) && (backOn.value || !isBack(x)))
})
const lines = computed(() => {
  void store.rev.lines
  void store.rev.vis
  return (store.project?.lines ?? []).filter((x) => store.isVisible(x.cls) && (backOn.value || !isBack(x)))
})
const leds = computed(() => {
  void store.rev.leds
  void store.rev.vis
  return store.isVisible('leds') ? (store.project?.leds ?? []) : []
})
const labels = computed(() => {
  void store.rev.labels
  void store.rev.vis
  return store.isVisible('labels') ? (store.project?.labels ?? []).filter((x) => backOn.value || !isBack(x)) : []
})
const frontPolys = computed(() => polys.value.filter((x) => !isBack(x)))
const backPolys = computed(() => polys.value.filter(isBack))
const frontLines = computed(() => lines.value.filter((x) => !isBack(x)))
const backLines = computed(() => lines.value.filter(isBack))
const frontLabels = computed(() => labels.value.filter((x) => !isBack(x)))
const backLabels = computed(() => labels.value.filter(isBack))
// imported back art: one path, rebuilt only when its data changes (translate / opacity keep the path)
let backDKey = ''
let backDVal = ''
const backArtView = computed(() => {
  const a = store.backArt
  if (!a || !a.visible || !backOn.value) return null
  if (a.data !== backDKey) {
    backDKey = a.data
    backDVal = backArtPathD(a)
  }
  return { d: backDVal, tr: `translate(${a.offset[0]} ${a.offset[1]})`, opacity: flip.value ? 1 : a.opacity }
})
/** Front art and LEDs are faint in the back view, the back silk is faint in the front view (seen through the board). */
const frontOpacity = computed(() => (flip.value ? 0.28 : 1))
const backOpacity = computed(() => (flip.value ? 1 : (store.backArt?.opacity ?? 0.35)))
const flipTr = computed(() => (flip.value ? `translate(${boardW.value} 0) scale(-1 1)` : undefined))
/** Keep overlay text readable in the back view: mirror it back about its own x. */
const readable = (x: number): string | undefined => (flip.value ? `matrix(-1 0 0 1 ${2 * x} 0)` : undefined)
const single = computed(() => store.selected.single)
const singleKind = computed(() => store.selected.singleKind)
const pathTool = computed(() => store.tool === 'node' || store.tool === 'pen' || store.tool === 'scissors')
// Handles are drawn only for vertices inside the visible area (refreshed shortly after a pan / zoom), so a
// 20k-vertex pavement outline is editable once zoomed in.
const MAX_VISIBLE_HANDLES = 4000
const handlesCapped = ref(0) // vertices in view when over the cap
const cullBox = ref<ed.Bounds | null>(null)
let cullTimer: ReturnType<typeof setTimeout> | null = null
function updateCull(): void {
  const el = svgEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const x0 = -view.x / view.z
  const y0 = -view.y / view.z
  const w = r.width / view.z
  const h = r.height / view.z
  const a = x0 - w * 0.1
  const b = x0 + w * 1.1
  cullBox.value = { x0: Math.min(dispX(a), dispX(b)), y0: y0 - h * 0.1, x1: Math.max(dispX(a), dispX(b)), y1: y0 + h * 1.1 }
}
function scheduleCull(): void {
  if (cullTimer) clearTimeout(cullTimer)
  cullTimer = setTimeout(updateCull, 120)
}
watch(() => [view.x, view.y, view.z, store.viewBack], scheduleCull)
/** Paths that show vertex handles: the single selected path (select tool) or every selected path (path tools). */
interface HandlePath {
  id: string
  kind: 'line' | 'poly'
  rings: Pt[][]
  closed: boolean
}
const handlePaths = computed<HandlePath[]>(() => {
  void store.rev.lines
  void store.rev.polys
  void store.rev.sel
  const t = tf.value
  if (!t) return []
  const list = pathTool.value ? store.selectedPaths() : single.value && (singleKind.value === 'line' || singleKind.value === 'poly') ? [store.pathOf(single.value.id)!] : []
  const out: HandlePath[] = []
  for (const pi of list) {
    const nr = pi.kind === 'line' ? 1 : (pi.item as PolyFeature).rings.length
    const rings: Pt[][] = []
    for (let r = 0; r < nr; r++) rings.push(store.pathPts(pi, r).map((q) => t.toMm(q)))
    out.push({ id: pi.item.id, kind: pi.kind, rings, closed: pi.kind === 'poly' })
  }
  return out
})
interface HVert { key: string; id: string; ring: number; idx: number; p: Pt }
interface HSeg { key: string; id: string; ring: number; idx: number; a: Pt; b: Pt; mid: Pt }
const handles = computed<{ verts: HVert[]; segs: HSeg[] }>(() => {
  const box = cullBox.value
  const inBox = (p: Pt): boolean => !box || (p[0] >= box.x0 && p[0] <= box.x1 && p[1] >= box.y0 && p[1] <= box.y1)
  const verts: HVert[] = []
  const segs: HSeg[] = []
  let over = 0
  for (const hp of handlePaths.value)
    hp.rings.forEach((ring, ri) => {
      const n = ring.length
      for (let i = 0; i < n; i++) {
        if (!inBox(ring[i])) continue
        if (verts.length >= MAX_VISIBLE_HANDLES) {
          over++
          continue
        }
        verts.push({ key: `${hp.id}:${ri}:${i}`, id: hp.id, ring: ri, idx: i, p: ring[i] })
      }
      const ns = pa.segCount(ring, hp.closed)
      for (let i = 0; i < ns; i++) {
        const b = pa.segEnd(ring, i, hp.closed)
        if (!inBox(ring[i]) && !inBox(b)) continue
        segs.push({ key: `${hp.id}:${ri}:${i}`, id: hp.id, ring: ri, idx: i, a: ring[i], b, mid: [(ring[i][0] + b[0]) / 2, (ring[i][1] + b[1]) / 2] })
      }
    })
  handlesCapped.value = over ? verts.length + over : 0
  return over ? { verts: [], segs: [] } : { verts, segs }
})
const showMids = computed(() => store.tool === 'node' && handles.value.segs.length <= 2500)
const nodeKeys = computed(() => store.nodeKeys)
const segKeys = computed(() => store.segKeys)
const selBox = computed(() => (store.selected.count > 1 ? store.selectionBounds : null))

// ---------------------------------------------------------------- snapping sources (rebuilt when data changes)
interface SnapIndex {
  pts: { p: Pt; id: string }[]
  grid: Map<string, { p: Pt; id: string }[]>
  lines: { id: string; pts: Pt[]; b: ed.Bounds }[]
}
const snapIndex = shallowRef<SnapIndex>({ pts: [], grid: new Map(), lines: [] })
const CELL = 5
function rebuildSnapIndex(): void {
  const t = tf.value
  const p = store.project
  if (!t || !p) return
  const pts: { p: Pt; id: string }[] = []
  for (const l of p.leds) pts.push({ p: t.toMm(l.pos), id: l.id })
  for (const l of p.labels) pts.push({ p: t.toMm(l.pos), id: l.id })
  const linesIx: SnapIndex['lines'] = []
  const SNAP_CLASSES = new Set(['taxiway', 'taxilane', 'runway_cl', 'custom'])
  for (const l of p.lines) {
    if (!SNAP_CLASSES.has(l.cls) || (l.cls === 'runway_cl' && l.sub === 'marking')) continue
    const mm = l.pts.map((q) => t.toMm(q))
    linesIx.push({ id: l.id, pts: mm, b: ed.ptsBounds(mm) })
    for (const q of mm) pts.push({ p: q, id: l.id })
  }
  for (const pl of p.polys) {
    if (pl.cls !== 'custom' && pl.cls !== 'building' && pl.cls !== 'terminal') continue
    for (const r of pl.rings) {
      const mm = r.map((q) => t.toMm(q))
      linesIx.push({ id: pl.id, pts: [...mm, mm[0]], b: ed.ptsBounds(mm) })
      for (const q of mm) pts.push({ p: q, id: pl.id })
    }
  }
  const grid = new Map<string, { p: Pt; id: string }[]>()
  for (const e of pts) {
    const k = `${Math.floor(e.p[0] / CELL)},${Math.floor(e.p[1] / CELL)}`
    const c = grid.get(k)
    if (c) c.push(e)
    else grid.set(k, [e])
  }
  snapIndex.value = { pts, grid, lines: linesIx }
}
let snapDirty = true
watch(() => [store.version, store.tf], () => (snapDirty = true))
function ensureSnapIndex(): void {
  if (snapDirty) {
    rebuildSnapIndex()
    snapDirty = false
  }
}
function pointsNear(p: Pt, r: number, exclude: Set<string>): Pt[] {
  const out: Pt[] = []
  const g = snapIndex.value.grid
  for (let x = Math.floor((p[0] - r) / CELL); x <= Math.floor((p[0] + r) / CELL); x++)
    for (let y = Math.floor((p[1] - r) / CELL); y <= Math.floor((p[1] + r) / CELL); y++) {
      const c = g.get(`${x},${y}`)
      if (!c) continue
      for (const e of c) if (!exclude.has(e.id) && Math.hypot(e.p[0] - p[0], e.p[1] - p[1]) <= r) out.push(e.p)
    }
  return out
}
function lineNear(p: Pt, r: number, exclude: Set<string>): { q: Pt; d: number; angle: number } | null {
  let best: { q: Pt; d: number; angle: number } | null = null
  for (const l of snapIndex.value.lines) {
    if (exclude.has(l.id)) continue
    if (p[0] < l.b.x0 - r || p[0] > l.b.x1 + r || p[1] < l.b.y0 - r || p[1] > l.b.y1 + r) continue
    const n = ed.nearestOnPolyline(p, l.pts)
    if (n && n.d <= r && (!best || n.d < best.d)) best = n
  }
  return best
}
function snapMm(p: Pt, exclude: Set<string>, ev?: { altKey: boolean }): ed.SnapResult {
  if (ev?.altKey) return { p, kind: 'none' }
  ensureSnapIndex()
  const tol = store.snap.tolerancePx / view.z
  return ed.snapPoint(p, store.snap, tol, {
    points: (r, q) => pointsNear(q, r, exclude),
    lines: (q, r) => lineNear(q, r, exclude),
    guidePoints: (q, r) => pointsNear(q, r, exclude)
  })
}

// ---------------------------------------------------------------- coordinate helpers
/** Screen -> drawing coordinates (mm as laid out on screen, mirrored in the back view). */
function screenToView(ev: { clientX: number; clientY: number }): Pt {
  const r = svgEl.value!.getBoundingClientRect()
  return [(ev.clientX - r.left - view.x) / view.z, (ev.clientY - r.top - view.y) / view.z]
}
/** Screen -> board mm (top view, y down): what every tool works in. */
function screenToMm(ev: { clientX: number; clientY: number }): Pt {
  const [x, y] = screenToView(ev)
  return [dispX(x), y]
}
function fitView(): void {
  const el = svgEl.value
  if (!el || !board.value) return
  const r = el.getBoundingClientRect()
  const z = Math.min((r.width - 40) / boardW.value, (r.height - 40) / boardH.value)
  view.z = z
  strokeZ.value = z
  view.x = (r.width - boardW.value * z) / 2
  view.y = (r.height - boardH.value * z) / 2
  updateCull()
}
function zoomTo(cxMm: number, cyMm: number, z: number): void {
  const el = svgEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  view.z = z
  strokeZ.value = z
  view.x = r.width / 2 - dispX(cxMm) * z
  view.y = r.height / 2 - cyMm * z
  updateCull()
}
function zoomToBounds(b: ed.Bounds): void {
  const el = svgEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const w = Math.max(b.x1 - b.x0, 2)
  const h = Math.max(b.y1 - b.y0, 2)
  const z = Math.min(400, Math.min((r.width - 80) / w, (r.height - 80) / h))
  zoomTo((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, z)
}
watch(() => store.zoomRequest, (q) => q && zoomToBounds(q.b))
watch(() => board.value?.id, () => setTimeout(fitView, 0))
onMounted(() => {
  setTimeout(fitView, 0)
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
function mmToScreen(p: Pt): [number, number] {
  const r = svgEl.value!.getBoundingClientRect()
  return [r.left + view.x + dispX(p[0]) * view.z, r.top + view.y + p[1] * view.z]
}
defineExpose({ fitView, zoomTo, zoomToBounds, mmToScreen, svgEl })

// ---------------------------------------------------------------- interaction
type Drag =
  // right: a right-button press; it pans once it moves a few pixels, else it opens the context menu on release
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; right?: { hit: Hit; moved: boolean } }
  | { kind: 'move'; start: Pt; anchor: Pt; moved: boolean; exclude: Set<string> }
  | { kind: 'nodes'; start: Pt; anchor: Pt; moved: boolean; exclude: Set<string> }
  | { kind: 'marquee'; start: Pt; add: boolean; nodes: boolean }
  | { kind: 'knife'; a: Pt }
  | { kind: 'shape'; a: Pt; pts: Pt[] }
  | { kind: 'block'; name: string; off: Pt; moved: boolean }
let drag: Drag | null = null

function onWheel(ev: WheelEvent): void {
  ev.preventDefault()
  const [mx, my] = screenToView(ev)
  const f = Math.exp(-ev.deltaY * 0.0015)
  const z = Math.min(400, Math.max(0.05, view.z * f))
  const r = svgEl.value!.getBoundingClientRect()
  view.x = ev.clientX - r.left - mx * z
  view.y = ev.clientY - r.top - my * z
  view.z = z
  if (zoomTimer) clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => (strokeZ.value = view.z), 150)
}
type HitKind = SelKind | 'vertex' | 'seg' | 'mid' | 'block'
interface Hit {
  kind?: HitKind
  id?: string     // object id (led/label/line/poly)
  ref?: pa.PathRef // vertex / segment / midpoint reference
}
function hit(ev: PointerEvent | MouseEvent): Hit {
  const target = ev.target as SVGElement
  const kind = target.dataset.kind as HitKind | undefined
  if (kind === 'vertex' || kind === 'seg' || kind === 'mid') {
    return { kind, id: target.dataset.oid, ref: { id: target.dataset.oid!, ring: Number(target.dataset.ring), idx: Number(target.dataset.idx) } }
  }
  return { kind, id: target.dataset.id }
}
function anchorOf(kind: SelKind, id: string): Pt | null {
  const t = tf.value
  const p = store.project
  if (!t || !p) return null
  if (kind === 'led') { const l = p.leds.find((x) => x.id === id); return l ? t.toMm(l.pos) : null }
  if (kind === 'label') { const l = p.labels.find((x) => x.id === id); return l ? t.toMm(l.pos) : null }
  if (kind === 'line') { const l = p.lines.find((x) => x.id === id); return l ? t.toMm(l.pts[0]) : null }
  const l = p.polys.find((x) => x.id === id)
  return l ? t.toMm(l.rings[0][0]) : null
}
/** Nearest segment of a path (all rings) to a point in mm. */
function nearestSegOf(id: string, posMm: Pt): { ref: pa.PathRef; t: number; q: Pt; d: number } | null {
  const pi = store.pathOf(id)
  const t = tf.value
  if (!pi || !t) return null
  const nr = pi.kind === 'line' ? 1 : (pi.item as PolyFeature).rings.length
  let best: { ref: pa.PathRef; t: number; q: Pt; d: number } | null = null
  for (let r = 0; r < nr; r++) {
    const pts = store.pathPts(pi, r).map((q) => t.toMm(q))
    const n = pa.nearestSegment(posMm, pts, pi.kind === 'poly')
    if (n && (!best || n.d < best.d)) best = { ref: { id, ring: r, idx: n.idx }, t: n.t, q: n.q, d: n.d }
  }
  return best
}
function segParam(ref: pa.PathRef, posMm: Pt): { t: number; q: Pt } {
  const pi = store.pathOf(ref.id)
  const t = tf.value
  if (!pi || !t) return { t: 0.5, q: posMm }
  const pts = store.pathPts(pi, ref.ring).map((q) => t.toMm(q))
  const a = pts[ref.idx]
  const b = pa.segEnd(pts, ref.idx, pi.kind === 'poly')
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy || 1e-9
  const tt = Math.max(0, Math.min(1, ((posMm[0] - a[0]) * dx + (posMm[1] - a[1]) * dy) / l2))
  return { t: tt, q: [a[0] + tt * dx, a[1] + tt * dy] }
}
function nodeMm(ref: pa.PathRef): Pt | null {
  const pi = store.pathOf(ref.id)
  const t = tf.value
  if (!pi || !t) return null
  const q = store.pathPts(pi, ref.ring)[ref.idx]
  return q ? t.toMm(q) : null
}
function startNodeDrag(anchor: Pt, pos: Pt): void {
  store.beginTransform()
  drag = { kind: 'nodes', start: pos, anchor, moved: false, exclude: new Set(store.nodeSel.map((r) => r.id)) }
}
function onPointerDown(ev: PointerEvent): void {
  const el = svgEl.value!
  try {
    el.setPointerCapture(ev.pointerId)
  } catch {
    /* a pointer that is no longer active (or a synthetic event in the autotest) */
  }
  store.ctxMenu = null
  const pos = screenToMm(ev)
  const h = hit(ev)
  if (ev.button === 2) {
    // right-drag pans; a right-click without moving opens the context menu (on release, for what was under the press)
    drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, right: { hit: h, moved: false } }
    return
  }
  if (ev.button === 1 || store.tool === 'pan' || (ev.altKey && (store.tool === 'select' || store.tool === 'node') && !h.id)) {
    drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y }
    panning.value = true
    return
  }
  if (ev.button !== 0) return
  const t = tf.value
  const p = store.project
  if (!t || !p) return
  if (store.tool === 'addLed') {
    store.addLedAt(snapMm(pos, new Set(), ev).p)
    return
  }
  if (store.tool === 'addLabel') {
    store.addLabelAt(snapMm(pos, new Set(), ev).p)
    store.tool = 'select'
    return
  }
  if (store.tool === 'addLine' || store.tool === 'addPoly') {
    pending.value = [...pending.value, snapMm(pos, new Set(), ev).p]
    return
  }
  if (store.tool === 'measure') {
    const q = snapMm(pos, new Set(), ev).p
    measure.value = measure.value && !measure.value.b ? { a: measure.value.a, b: q } : { a: q, b: null }
    return
  }
  if (store.tool === 'rotate') {
    if (rotateUi.value) {
      store.endTransform(true)
      rotateUi.value = null
      store.tool = 'select'
    }
    return
  }
  if (store.tool === 'knife') {
    drag = { kind: 'knife', a: snapMm(pos, new Set(), ev).p }
    knifeUi.value = { a: drag.a, b: drag.a }
    return
  }
  if (store.tool === 'scissors') {
    onScissors(h, pos)
    return
  }
  if (store.tool === 'rect' || store.tool === 'ellipse' || store.tool === 'star') {
    drag = { kind: 'shape', a: snapMm(pos, new Set(), ev).p, pts: [] }
    shapeUi.value = null
    return
  }
  if (store.tool === 'pen') {
    onPen(h, pos, ev)
    return
  }
  // ---- PCB blocks (Altium generator): grab and drag; edge blocks snap to the nearest board edge
  if ((store.tool === 'select' || store.tool === 'node') && h.kind === 'block' && h.id) {
    const d = store.pcb.describe?.blocks.find((b) => b.name === h.id)
    const pose = store.project?.pcb?.blocks.find((b) => b.name === h.id)
    if (d && pose) {
      store.clearSelection()
      store.pcb.selectedBlock = h.id
      const g = placeBlock(d, pose, boardW.value, boardH.value)
      store.snapshot()
      drag = { kind: 'block', name: h.id, off: [pos[0] - g.anchor[0], pos[1] - g.anchor[1]], moved: false }
      return
    }
  }
  if (store.pcb.selectedBlock && h.kind !== 'block') store.pcb.selectedBlock = null
  // ---- node tool (direct selection)
  if (store.tool === 'node') {
    if (h.kind === 'vertex' && h.ref) {
      const selectedNode = store.nodeKeys.has(pa.refKey(h.ref))
      if (ev.shiftKey) store.selectNode(h.ref, 'toggle')
      else if (!selectedNode) store.selectNode(h.ref, 'replace')
      if (!store.nodeKeys.has(pa.refKey(h.ref))) return
      startNodeDrag(nodeMm(h.ref) ?? pos, pos)
      return
    }
    if (h.kind === 'mid' && h.ref) {
      const nr = store.insertNode(h.ref, t.toM(pos))
      if (nr) startNodeDrag(pos, pos)
      return
    }
    if (h.kind === 'seg' && h.ref) {
      const selectedSeg = store.segKeys.has(pa.refKey(h.ref))
      if (ev.shiftKey) store.selectSegment(h.ref, 'toggle')
      else if (!selectedSeg) store.selectSegment(h.ref, 'replace')
      if (!store.segKeys.has(pa.refKey(h.ref))) return
      startNodeDrag(pos, pos)
      return
    }
    if ((h.kind === 'line' || h.kind === 'poly') && h.id) {
      // path body: near the outline picks that segment, inside a fill selects (and drags) the whole path
      const ns = nearestSegOf(h.id, pos)
      if (ns && ns.d <= 8 / view.z) {
        if (!store.isSelected(h.id)) store.select(h.kind, h.id, ev.shiftKey ? 'add' : 'replace')
        store.selectSegment(ns.ref, ev.shiftKey ? 'add' : 'replace')
        startNodeDrag(pos, pos)
        return
      }
      if (ev.shiftKey) store.select(h.kind, h.id, 'toggle')
      else if (!store.isSelected(h.id)) store.select(h.kind, h.id, 'replace')
      if (!store.isSelected(h.id)) return
      store.clearSub()
      store.beginTransform()
      drag = { kind: 'move', start: pos, anchor: anchorOf(h.kind, h.id) ?? pos, moved: false, exclude: new Set(store.selectedIds) }
      return
    }
    if ((h.kind === 'led' || h.kind === 'label') && h.id) {
      if (ev.shiftKey) store.select(h.kind, h.id, 'toggle')
      else if (!store.isSelected(h.id)) store.select(h.kind, h.id, 'replace')
      if (!store.isSelected(h.id)) return
      store.beginTransform()
      drag = { kind: 'move', start: pos, anchor: anchorOf(h.kind, h.id) ?? pos, moved: false, exclude: new Set(store.selectedIds) }
      return
    }
    drag = { kind: 'marquee', start: pos, add: ev.shiftKey, nodes: true }
    marquee.value = { x0: pos[0], y0: pos[1], x1: pos[0], y1: pos[1] }
    return
  }
  // ---- select tool
  if (h.kind === 'vertex' && h.ref) {
    store.selectNode(h.ref, ev.shiftKey ? 'toggle' : store.nodeKeys.has(pa.refKey(h.ref)) ? 'add' : 'replace')
    if (!store.nodeKeys.has(pa.refKey(h.ref))) return
    startNodeDrag(nodeMm(h.ref) ?? pos, pos)
    return
  }
  // a segment or midpoint handle in the select tool acts on its whole path
  const objKind: SelKind | undefined = h.kind === 'seg' || h.kind === 'mid' ? store.pathOf(h.id!)?.kind : (h.kind as SelKind | undefined)
  if (objKind && h.id) {
    const already = store.isSelected(h.id)
    if (ev.shiftKey) store.select(objKind, h.id, 'toggle')
    else if (!already) store.select(objKind, h.id, 'replace')
    if (!store.isSelected(h.id)) return
    if (already && !ev.shiftKey) store.clearSub()
    const anchor = anchorOf(objKind, h.id) ?? pos
    store.beginTransform()
    drag = { kind: 'move', start: pos, anchor, moved: false, exclude: new Set(store.selectedIds) }
    return
  }
  // empty space: marquee (shift adds), plain click clears
  drag = { kind: 'marquee', start: pos, add: ev.shiftKey, nodes: false }
  marquee.value = { x0: pos[0], y0: pos[1], x1: pos[0], y1: pos[1] }
}
function onScissors(h: Hit, pos: Pt): void {
  if (h.kind === 'vertex' && h.ref) {
    store.cutAt(h.ref, 0)
    return
  }
  if ((h.kind === 'seg' || h.kind === 'mid') && h.ref) {
    store.cutAt(h.ref, segParam(h.ref, pos).t)
    return
  }
  if ((h.kind === 'line' || h.kind === 'poly') && h.id) {
    const ns = nearestSegOf(h.id, pos)
    if (ns && ns.d <= 8 / view.z) store.cutAt(ns.ref, ns.t)
  }
}
function onPen(h: Hit, pos: Pt, ev: PointerEvent): void {
  const t = tf.value!
  const tol = 6 / view.z
  const q = snapMm(pos, new Set(), ev).p
  // extending an existing line
  if (penExt.value) {
    const l = store.project!.lines.find((x) => x.id === penExt.value!.id)
    if (!l) { penExt.value = null; return }
    const otherIdx = penExt.value.end === 'end' ? 0 : l.pts.length - 1
    const curIdx = l.pts.length - 1 - otherIdx
    const other = t.toMm(l.pts[otherIdx])
    if (h.kind === 'vertex' && h.ref?.id === l.id && h.ref.idx === curIdx) {
      penExt.value = null // clicked the end being extended: finish
      return
    }
    if (l.pts.length >= 3 && (Math.hypot(other[0] - pos[0], other[1] - pos[1]) <= tol || (h.kind === 'vertex' && h.ref?.id === l.id && h.ref.idx === otherIdx))) {
      store.closeLine(l.id)
      penExt.value = null
      return
    }
    store.extendLine(l.id, penExt.value.end, t.toM(q))
    return
  }
  // drawing a new path
  if (pending.value.length) {
    const first = pending.value[0]
    if (pending.value.length >= 3 && Math.hypot(first[0] - pos[0], first[1] - pos[1]) <= tol) {
      store.addPoly(pending.value)
      pending.value = []
      return
    }
    pending.value = [...pending.value, q]
    return
  }
  if (h.kind === 'vertex' && h.ref) {
    const pi = store.pathOf(h.ref.id)
    if (pi?.kind === 'line') {
      const n = (pi.item as LineFeature).pts.length
      if (h.ref.idx === 0 || h.ref.idx === n - 1) {
        // continue the line from this end
        penExt.value = { id: h.ref.id, end: h.ref.idx === 0 ? 'start' : 'end' }
        store.selectNode(h.ref, 'replace')
        return
      }
    }
    store.selectNode(h.ref, 'replace')
    store.deleteNodes()
    return
  }
  if ((h.kind === 'seg' || h.kind === 'mid') && h.ref) {
    const sp = segParam(h.ref, pos)
    store.insertNode(h.ref, t.toM(sp.q))
    return
  }
  pending.value = [q]
}
function onPointerMove(ev: PointerEvent): void {
  const pos = screenToMm(ev)
  if (hudEl.value && tf.value) hudEl.value.textContent = `${pos[0].toFixed(2)}, ${pos[1].toFixed(2)} mm · 1:${Math.round(tf.value.scale).toLocaleString()} · zoom ${view.z.toFixed(2)}`
  if (pending.value.length || penExt.value || (measure.value && !measure.value.b)) pendingCursor.value = snapMm(pos, new Set(), ev).p
  if (store.tool === 'rotate' && rotateUi.value) {
    let a = ed.angleOf(rotateUi.value.pivot, pos) - rotateUi.value.angle
    if (store.snap.angle && !ev.altKey) a = ed.snapAngle(a, store.snap.angleStepDeg)
    if (ev.shiftKey) a = ed.snapAngle(a, 45)
    store.rotateSelectionTo(a, rotateUi.value.pivot)
    rotateUi.value = { ...rotateUi.value, angle: rotateUi.value.angle }
    liveAngle.value = ed.norm360(a)
    return
  }
  const d = drag
  const t = tf.value
  if (!d || !t) return
  if (d.kind === 'pan') {
    if (d.right && !d.right.moved) {
      if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return
      d.right.moved = true
      panning.value = true
      store.ctxMenu = null
    }
    view.x = d.vx + (ev.clientX - d.sx)
    view.y = d.vy + (ev.clientY - d.sy)
  } else if (d.kind === 'move' || d.kind === 'nodes') {
    let dx = pos[0] - d.start[0]
    let dy = pos[1] - d.start[1]
    if (ev.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0
      else dx = 0
    }
    const target: Pt = [d.anchor[0] + dx, d.anchor[1] + dy]
    const s = snapMm(target, d.exclude, ev)
    dx = s.p[0] - d.anchor[0]
    dy = s.p[1] - d.anchor[1]
    guides.value = { x: s.guideX, y: s.guideY, p: s.kind === 'object' || s.kind === 'line' ? s.p : undefined }
    d.moved = true
    if (d.kind === 'move') store.moveSelectionTo(dx, dy)
    else store.moveNodesTo(dx, dy)
  } else if (d.kind === 'marquee') {
    marquee.value = { x0: Math.min(d.start[0], pos[0]), y0: Math.min(d.start[1], pos[1]), x1: Math.max(d.start[0], pos[0]), y1: Math.max(d.start[1], pos[1]) }
  } else if (d.kind === 'block') {
    const desc = store.pcb.describe?.blocks.find((b) => b.name === d.name)
    const prev = store.project?.pcb?.blocks.find((b) => b.name === d.name)
    if (desc) {
      const pose = poseAt(desc, prev, pos[0] - d.off[0], pos[1] - d.off[1], boardW.value, boardH.value, ev.altKey ? 0.1 : 0.5)
      if (!prev || JSON.stringify(prev) !== JSON.stringify(pose)) {
        d.moved = true
        store.pcbSetBlockPose(pose, false)
      }
    }
  } else if (d.kind === 'shape') {
    d.pts = shapePts(d.a, snapMm(pos, new Set(), ev).p, ev.shiftKey, ev.altKey)
    shapeUi.value = d.pts
  } else if (d.kind === 'knife') {
    let b = snapMm(pos, new Set(), ev).p
    if (ev.shiftKey) {
      const dx = b[0] - d.a[0]
      const dy = b[1] - d.a[1]
      b = Math.abs(dx) > Math.abs(dy) ? [b[0], d.a[1]] : [d.a[0], b[1]]
    }
    knifeUi.value = { a: d.a, b }
  }
}
function onPointerUp(ev: PointerEvent): void {
  try {
    svgEl.value?.releasePointerCapture(ev.pointerId)
  } catch {
    /* not captured */
  }
  const d = drag
  drag = null
  guides.value = {}
  panning.value = false
  if (ev.button === 2) {
    if (d?.kind === 'pan' && d.right?.moved) return // it was a right-drag pan
    // the target of the press: pointer capture sends the release to the canvas itself
    const h = d?.kind === 'pan' && d.right ? d.right.hit : hit(ev)
    if (h.kind === 'vertex' && h.ref) {
      if (!store.nodeKeys.has(pa.refKey(h.ref))) store.selectNode(h.ref, store.isSelected(h.ref.id) && store.nodeSel.length ? 'add' : 'replace')
    } else if ((h.kind === 'seg' || h.kind === 'mid') && h.ref) {
      if (!store.segKeys.has(pa.refKey(h.ref))) store.selectSegment(h.ref, 'replace')
    } else if (h.kind && h.id && !store.isSelected(h.id)) store.select(h.kind as SelKind, h.id, 'replace')
    store.ctxMenu = { x: ev.clientX, y: ev.clientY }
    return
  }
  if (!d) return
  if (d.kind === 'block') {
    if (!d.moved) store.undo()
  } else if (d.kind === 'move' || d.kind === 'nodes') store.endTransform(d.moved)
  else if (d.kind === 'shape') {
    shapeUi.value = null
    if (d.pts.length >= 3) {
      const b = ed.ptsBounds(d.pts)
      if (b.x1 - b.x0 > 0.2 || b.y1 - b.y0 > 0.2) store.addShape(d.pts)
    }
  } else if (d.kind === 'knife') {
    const k = knifeUi.value
    knifeUi.value = null
    if (k && Math.hypot(k.b[0] - k.a[0], k.b[1] - k.a[1]) > 0.2) store.knife(k.a, k.b)
  } else if (d.kind === 'marquee') {
    const m = marquee.value
    marquee.value = null
    if (!m) return
    const tiny = m.x1 - m.x0 < 0.3 / view.z && m.y1 - m.y0 < 0.3 / view.z
    if (tiny) {
      if (!d.add) {
        if (d.nodes && store.nodeSel.length) store.clearSub()
        else store.clearSelection()
      }
      return
    }
    if (d.nodes) {
      marqueeNodes(m, d.add)
      return
    }
    const inside = (b: ed.Bounds | null): boolean => !!b && b.x0 >= m.x0 && b.x1 <= m.x1 && b.y0 >= m.y0 && b.y1 <= m.y1
    const centreIn = (b: ed.Bounds | null): boolean => !!b && ed.bcx(b) >= m.x0 && ed.bcx(b) <= m.x1 && ed.bcy(b) >= m.y0 && ed.bcy(b) <= m.y1
    const list = d.add ? [...store.selection] : []
    const seen = new Set(list.map((s) => s.id))
    const push = (kind: SelKind, id: string): void => {
      if (!seen.has(id)) {
        seen.add(id)
        list.push({ kind, id })
      }
    }
    for (const l of leds.value) if (centreIn(store.itemBounds('led', l))) push('led', l.id)
    for (const l of labels.value) if (centreIn(store.itemBounds('label', l))) push('label', l.id)
    for (const l of lines.value) if (inside(store.itemBounds('line', l))) push('line', l.id)
    for (const l of polys.value) if (l.cls === 'custom' && inside(store.itemBounds('poly', l))) push('poly', l.id)
    store.setSelection(list)
  }
}
/** Node-tool marquee: select the vertices inside the box (of the selected paths, else of every visible path). */
function marqueeNodes(m: { x0: number; y0: number; x1: number; y1: number }, add: boolean): void {
  const t = tf.value
  if (!t) return
  const overlaps = (b: ed.Bounds | null): boolean => !!b && b.x1 >= m.x0 && b.x0 <= m.x1 && b.y1 >= m.y0 && b.y0 <= m.y1
  let cands = store.selectedPaths()
  if (!cands.length) {
    cands = [
      ...lines.value.filter((l) => overlaps(store.itemBounds('line', l))).map((l) => ({ kind: 'line' as const, item: l })),
      ...polys.value.filter((l) => overlaps(store.itemBounds('poly', l))).map((l) => ({ kind: 'poly' as const, item: l }))
    ]
  }
  const nodes: pa.PathRef[] = add ? [...store.nodeSel] : []
  const seen = new Set(nodes.map(pa.refKey))
  const owners: { kind: SelKind; id: string }[] = add ? [...store.selection] : []
  const ownerIds = new Set(owners.map((o) => o.id))
  for (const pi of cands) {
    const nr = pi.kind === 'line' ? 1 : (pi.item as PolyFeature).rings.length
    let any = false
    for (let r = 0; r < nr; r++) {
      const pts = store.pathPts(pi, r)
      pts.forEach((q, idx) => {
        const mm = t.toMm(q)
        if (mm[0] < m.x0 || mm[0] > m.x1 || mm[1] < m.y0 || mm[1] > m.y1) return
        const ref = { id: pi.item.id, ring: r, idx }
        const k = pa.refKey(ref)
        if (!seen.has(k)) {
          seen.add(k)
          nodes.push(ref)
        }
        any = true
      })
    }
    if (any && !ownerIds.has(pi.item.id)) {
      ownerIds.add(pi.item.id)
      owners.push({ kind: pi.kind, id: pi.item.id })
    }
  }
  store.setSelection(owners)
  store.setNodeSel(nodes)
  store.setSegSel([])
}
/** Shape tool geometry in mm: drag a->b; shift = square / circle / upright, alt = from the centre. */
function shapePts(a: Pt, b: Pt, square: boolean, fromCentre: boolean): Pt[] {
  let dx = b[0] - a[0]
  let dy = b[1] - a[1]
  if (store.tool === 'star') {
    let tow: Pt = b
    if (square) {
      // snap the first vertex to straight up
      const r = Math.hypot(dx, dy)
      tow = [a[0], a[1] - r]
    }
    return pa.regularPts(a, tow, store.shapeOpts.sides, store.shapeOpts.inner)
  }
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * m
    dy = Math.sign(dy || 1) * m
  }
  const p0: Pt = fromCentre ? [a[0] - dx, a[1] - dy] : a
  const p1: Pt = [a[0] + dx, a[1] + dy]
  if (store.tool === 'rect') return pa.rectPts(p0, p1, store.shapeOpts.cornerMm)
  const c: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
  return pa.ellipsePts(c, Math.abs(p1[0] - p0[0]) / 2, Math.abs(p1[1] - p0[1]) / 2, 64)
}
function finishPending(): void {
  if ((store.tool === 'addLine' || store.tool === 'pen') && pending.value.length >= 2) store.addLine(pending.value)
  if (store.tool === 'addPoly' && pending.value.length >= 3) store.addPoly(pending.value)
  pending.value = []
  penExt.value = null
  if (store.tool !== 'pen') store.tool = 'select'
}
function onDblClick(ev: MouseEvent): void {
  if (store.tool === 'addLine' || store.tool === 'addPoly' || store.tool === 'pen') {
    // the double-click's own two clicks added one duplicate point: drop it
    if (pending.value.length > 1) pending.value = pending.value.slice(0, -1)
    if (store.tool === 'pen' && penExt.value) {
      penExt.value = null
      return
    }
    finishPending()
    return
  }
  const h = hit(ev)
  const t = tf.value
  if (!t) return
  const pos = screenToMm(ev)
  if ((h.kind === 'seg' || h.kind === 'mid') && h.ref) {
    store.insertNode(h.ref, t.toM(segParam(h.ref, pos).q))
    return
  }
  if ((h.kind === 'line' || h.kind === 'poly') && h.id && store.isSelected(h.id)) {
    const ns = nearestSegOf(h.id, pos)
    if (ns) store.insertNode(ns.ref, t.toM(ns.q))
  }
}
const liveAngle = ref(0)
function startRotateTool(): void {
  const b = store.selectionBounds
  if (!b || !store.selected.count) return
  store.beginTransform()
  const pivot: Pt = [ed.bcx(b), ed.bcy(b)]
  rotateUi.value = { pivot, angle: ed.angleOf(pivot, pendingCursor.value) }
  liveAngle.value = 0
  store.tool = 'rotate'
}
watch(() => store.tool, (t, old) => {
  if (old === 'rotate' && rotateUi.value) {
    store.endTransform(false)
    rotateUi.value = null
  }
  if (t === 'rotate' && !rotateUi.value) {
    if (!store.selected.count) store.tool = 'select'
    else {
      const b = store.selectionBounds!
      const pivot: Pt = [ed.bcx(b), ed.bcy(b)]
      store.beginTransform()
      rotateUi.value = { pivot, angle: ed.angleOf(pivot, [pivot[0] + 10, pivot[1]]) }
      liveAngle.value = 0
    }
  }
  if (t !== 'addLine' && t !== 'addPoly' && t !== 'pen') pending.value = []
  if (t !== 'pen') penExt.value = null
  if (t !== 'measure') measure.value = null
  if (t !== 'knife') knifeUi.value = null
  shapeUi.value = null
})
function onKey(ev: KeyboardEvent): void {
  if (store.task.active) {
    ev.preventDefault()
    return
  }
  const tag = (ev.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const meta = ev.metaKey || ev.ctrlKey
  const k = ev.key
  if (meta && k.toLowerCase() === 'z') {
    ev.preventDefault()
    if (ev.shiftKey) store.redo()
    else store.undo()
    return
  }
  if (meta && k.toLowerCase() === 'a') {
    ev.preventDefault()
    if (store.tool === 'node' && store.selected.single && (store.selected.singleKind === 'line' || store.selected.singleKind === 'poly')) store.selectPathNodes(store.selected.single.id)
    else store.selectAll(['led', 'label'])
    return
  }
  if (meta && k.toLowerCase() === 'd') {
    ev.preventDefault()
    store.duplicateSelection()
    return
  }
  if (meta && k.toLowerCase() === 'j') {
    ev.preventDefault()
    store.joinSelected()
    return
  }
  if (meta && k.toLowerCase() === 's') {
    ev.preventDefault()
    store.save(ev.shiftKey)
    return
  }
  if (meta && k.toLowerCase() === 'e') {
    ev.preventDefault()
    store.exportFiles()
    return
  }
  if (meta && k.toLowerCase() === 'o') {
    ev.preventDefault()
    store.open()
    return
  }
  if (k === 'Escape') {
    if (store.tool === 'rotate' && rotateUi.value) {
      store.endTransform(false)
      rotateUi.value = null
    }
    if (store.tool === 'pen' && (pending.value.length || penExt.value)) {
      pending.value = []
      penExt.value = null
      store.ctxMenu = null
      return
    }
    pending.value = []
    penExt.value = null
    knifeUi.value = null
    measure.value = null
    store.tool = 'select'
    store.ctxMenu = null
    return
  }
  const blk = store.pcb.selectedBlock
  if (blk && !store.selected.count) {
    const pose = store.project?.pcb?.blocks.find((b) => b.name === blk)
    const desc = store.pcb.describe?.blocks.find((b) => b.name === blk)
    if (pose && desc) {
      const step = ev.shiftKey ? 1 : 0.1
      const nudge = (dx0: number, dy: number): void => {
        const dx = flip.value ? -dx0 : dx0
        if (desc.rule !== 'free') {
          const along = pose.edge === 'top' || pose.edge === 'bottom' ? dx : dy
          if (along) store.pcbSetBlockPose({ ...pose, t: Math.round(((pose.t ?? 0) + along) * 1000) / 1000 })
        } else store.pcbSetBlockPose({ ...pose, x: Math.round(((pose.x ?? 0) + dx) * 1000) / 1000, y: Math.round(((pose.y ?? 0) + dy) * 1000) / 1000 })
      }
      if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); store.pcbClearBlockPose(blk); store.pcb.selectedBlock = null; return }
      if ((k === '[' || k === ']') && desc.rule === 'free') { store.pcbSetBlockPose({ ...pose, rot: (((pose.rot ?? 0) + (k === '[' ? 90 : -90)) % 360 + 360) % 360 }); return }
      if (k === 'ArrowLeft') { nudge(-step, 0); return }
      if (k === 'ArrowRight') { nudge(step, 0); return }
      if (k === 'ArrowUp') { nudge(0, -step); return }
      if (k === 'ArrowDown') { nudge(0, step); return }
    }
  }
  if (k === 'Escape' && store.pcb.selectedBlock) store.pcb.selectedBlock = null
  if (k === 'Enter' && (store.tool === 'addLine' || store.tool === 'addPoly' || store.tool === 'pen')) {
    finishPending()
    return
  }
  if (k === 'f') fitView()
  else if (k === 'v') store.tool = 'select'
  else if (k === 'a') store.tool = 'node'
  else if (k === 'h') store.tool = 'pan'
  else if (k === 'l') store.tool = 'addLed'
  else if (k === 'n') store.tool = 'addLine'
  else if (k === 'p') store.tool = 'addPoly'
  else if (k === 'e') store.tool = 'pen'
  else if (k === 'c') store.tool = 'scissors'
  else if (k === 'k') store.tool = 'knife'
  else if (k === 't') store.tool = 'addLabel'
  else if (k === 'b') store.tool = 'rect'
  else if (k === 'o') store.tool = 'ellipse'
  else if (k === 'y') store.tool = 'star'
  else if (k === 'm') store.tool = 'measure'
  else if (k === 'r' && store.selected.count) startRotateTool()
  else if (k === 'R' && store.selected.count) store.rotateSelectionBy(flip.value ? -90 : 90)
  if (k === 'Delete' || k === 'Backspace') {
    ev.preventDefault()
    if (store.segSel.length) store.removeSegments()
    else if (store.nodeSel.length) store.deleteNodes()
    else store.removeSelected()
    return
  }
  if (!store.selected.count) return
  const step = ev.shiftKey ? 1.0 : 0.1
  const turn = flip.value ? -1 : 1 // arrows and rotation keys follow the screen in the back view
  const nudge = (dx0: number, dy: number): void => {
    const dx = dx0 * turn
    if (store.nodeSel.length) {
      store.beginTransform()
      store.moveNodesTo(dx, dy)
      store.endTransform(true)
    } else store.nudgeSelection(dx, dy)
  }
  if (k === 'ArrowLeft') nudge(-step, 0)
  else if (k === 'ArrowRight') nudge(step, 0)
  else if (k === 'ArrowUp') nudge(0, -step)
  else if (k === 'ArrowDown') nudge(0, step)
  else if (k === '[') store.rotateSelectionBy(turn * (store.snap.angle ? store.snap.angleStepDeg : 15))
  else if (k === ']') store.rotateSelectionBy(-turn * (store.snap.angle ? store.snap.angleStepDeg : 15))
  else if ((k === '+' || k === '=') && store.selected.labels.length) for (const lb of store.selected.labels) store.updateLabel(lb.id, { heightM: lb.heightM * 1.1 }, lb === store.selected.labels[0])
  else if (k === '-' && store.selected.labels.length) for (const lb of store.selected.labels) store.updateLabel(lb.id, { heightM: lb.heightM / 1.1 }, lb === store.selected.labels[0])
}
const cursorStyle = computed(() => (panning.value ? 'grabbing' : store.tool === 'pan' ? 'grab' : store.tool === 'select' || store.tool === 'node' ? 'default' : 'crosshair'))
const shapeD = computed(() => (shapeUi.value ? 'M' + shapeUi.value.map(([x, y]) => `${x} ${y}`).join('L') + 'Z' : ''))
const pendingPts = computed(() => [...pending.value, pendingCursor.value].map(([x, y]) => `${x},${y}`).join(' '))
const penExtLine = computed<Pt | null>(() => {
  void store.rev.lines
  const t = tf.value
  const pe = penExt.value
  if (!pe || !t) return null
  const l = store.project?.lines.find((x) => x.id === pe.id)
  if (!l) return null
  return t.toMm(pe.end === 'end' ? l.pts[l.pts.length - 1] : l.pts[0])
})
const measureInfo = computed(() => {
  const m = measure.value
  if (!m || !tf.value) return null
  const b = m.b ?? pendingCursor.value
  const d = Math.hypot(b[0] - m.a[0], b[1] - m.a[1])
  return { a: m.a, b, d, m: d / tf.value.k, angle: ed.angleOf(m.a, b) }
})
const hint = computed(() => {
  switch (store.tool) {
    case 'node': return 'node tool · click a vertex / segment, drag to move, ⇧ adds, drag-box selects vertices, click a midpoint to add a node, Del removes nodes or segments'
    case 'pen': return 'pen · click to draw (click the first point to close) · click a segment to add a node, a node to remove it, a line end to continue it · Enter / double-click ends'
    case 'scissors': return 'scissors · click a path to cut it there (a polygon opens into a line)'
    case 'rect': return 'rectangle · drag · ⇧ square · ⌥ from centre · corner radius in the inspector'
    case 'ellipse': return 'ellipse · drag · ⇧ circle · ⌥ from centre'
    case 'star': return 'polygon / star · drag from the centre · ⇧ upright · sides and inner ratio in the inspector'
    case 'knife': return 'knife · drag a line across polygons / lines to slice them (⇧ axis) · applies to the selection, or everything under the cut'
    case 'select': return 'shift-click / drag-box to multi-select · right-drag pans, right-click for the menu · r rotate with cursor · [ ] rotate steps · ⌘A ⌘D ⌘J · A node tool · Esc'
    default: return store.tool
  }
})
const labelOf = (l: Led | Label): string => (l as Led).label ?? (l as Label).text ?? ''
void labelOf
</script>

<template>
  <div class="canvas-wrap">
    <svg
      ref="svgEl"
      class="canvas"
      :style="{ cursor: cursorStyle }"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDblClick"
      @contextmenu.prevent
    >
      <g :transform="`translate(${view.x} ${view.y}) scale(${view.z})`">
       <g :transform="flipTr">
        <template v-if="board && tf">
          <rect x="0" y="0" :width="boardW" :height="boardH" :rx="board.cornerRadiusMm" fill="#0b0d10" stroke="#3a4048" :stroke-width="Math.max(0.2, 0.9 / strokeZ)" />
          <rect :x="tf.fx0" :y="tf.fy0" :width="tf.frameWmm" :height="tf.frameHmm" fill="none" stroke="#2a3340" :stroke-width="Math.max(0.1, 0.6 / strokeZ)" :stroke-dasharray="`${2 / strokeZ} ${2 / strokeZ}`" />
          <!-- back silk under the front art in the front view (seen through the board) -->
          <g v-if="!flip && backOn" class="back-silk" :opacity="backOpacity">
            <path v-if="backArtView" :d="backArtView.d" :transform="backArtView.tr" fill="#b58cff" fill-rule="nonzero" pointer-events="none" />
            <PolyLayer :polys="backPolys" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.polys" :colors="srcColors" />
            <LineLayer :lines="backLines" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.lines" :show-axes="showAxes" :colors="srcColors" />
            <LabelLayer :labels="backLabels" :tf="tf" :selected="selIds" :rev="store.rev.labels" />
          </g>
          <g :opacity="frontOpacity">
            <PolyLayer :polys="frontPolys" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.polys" :colors="srcColors" />
            <LineLayer :lines="frontLines" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.lines" :show-axes="showAxes" :colors="srcColors" />
            <LabelLayer :labels="frontLabels" :tf="tf" :selected="selIds" :rev="store.rev.labels" />
            <LedLayer :leds="leds" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.leds" />
            <PcbLayer v-if="store.project?.pcb || store.pcb.chainStats.length" :tf="tf" :stroke-z="strokeZ" :W="boardW" :H="boardH" />
          </g>
          <!-- back view: the back silk on top at full strength, reading as it will on the board -->
          <g v-if="flip && backOn" class="back-silk" :opacity="backOpacity">
            <path v-if="backArtView" :d="backArtView.d" :transform="backArtView.tr" fill="#b58cff" fill-rule="nonzero" pointer-events="none" />
            <PolyLayer :polys="backPolys" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.polys" :colors="srcColors" />
            <LineLayer :lines="backLines" :tf="tf" :stroke-z="strokeZ" :selected="selIds" :rev="store.rev.lines" :show-axes="showAxes" :colors="srcColors" />
            <LabelLayer :labels="backLabels" :tf="tf" :selected="selIds" :rev="store.rev.labels" />
          </g>
          <!-- transient markers (audits): rings or dots, a fixed size on screen -->
          <g v-if="store.markers.length" pointer-events="none">
            <circle v-for="(m, i) in store.markers" :key="i" :cx="m.p[0]" :cy="m.p[1]" :r="(m.r ?? 6) / strokeZ" :fill="m.ring ? 'none' : (m.color ?? '#ff5c5c')" :stroke="m.ring ? (m.color ?? '#ff5c5c') : 'none'" :stroke-width="2 / strokeZ" />
          </g>
          <!-- path handles: segment targets, selected segments, midpoints, vertices -->
          <g v-if="handlePaths.length" class="handles">
            <template v-for="s in handles.segs" :key="s.key">
              <line :x1="s.a[0]" :y1="s.a[1]" :x2="s.b[0]" :y2="s.b[1]" stroke="transparent" :stroke-width="10 / strokeZ" data-kind="seg" :data-oid="s.id" :data-ring="String(s.ring)" :data-idx="String(s.idx)" />
              <line v-if="segKeys.has(s.key)" :x1="s.a[0]" :y1="s.a[1]" :x2="s.b[0]" :y2="s.b[1]" stroke="#ffb347" :stroke-width="3 / strokeZ" pointer-events="none" />
              <rect v-if="showMids" :x="s.mid[0] - 2.2 / strokeZ" :y="s.mid[1] - 2.2 / strokeZ" :width="4.4 / strokeZ" :height="4.4 / strokeZ" fill="#0b0d10" stroke="#8fb8ff" :stroke-width="1 / strokeZ" :transform="`rotate(45 ${s.mid[0]} ${s.mid[1]})`" data-kind="mid" :data-oid="s.id" :data-ring="String(s.ring)" :data-idx="String(s.idx)" />
            </template>
            <circle v-for="v in handles.verts" :key="v.key" :cx="v.p[0]" :cy="v.p[1]" :r="(nodeKeys.has(v.key) ? 4.5 : 3.6) / strokeZ" :fill="nodeKeys.has(v.key) ? '#4f9cff' : '#fff'" :stroke="nodeKeys.has(v.key) ? '#fff' : '#4f9cff'" :stroke-width="1.2 / strokeZ" data-kind="vertex" :data-oid="v.id" :data-ring="String(v.ring)" :data-idx="String(v.idx)" />
          </g>
          <!-- selection bounds -->
          <rect v-if="selBox" :x="selBox.x0 - 0.6" :y="selBox.y0 - 0.6" :width="selBox.x1 - selBox.x0 + 1.2" :height="selBox.y1 - selBox.y0 + 1.2" fill="none" stroke="#4f9cff" :stroke-width="1 / strokeZ" :stroke-dasharray="`${3 / strokeZ} ${2 / strokeZ}`" pointer-events="none" />
          <!-- drawing / marquee / guides / measure / rotate / knife overlays -->
          <polyline v-if="pending.length" :points="pendingPts" fill="none" stroke="#4f9cff" :stroke-width="Math.max(0.2, 0.9 / strokeZ)" stroke-dasharray="0.6 0.4" pointer-events="none" />
          <circle v-if="pending.length >= 3 && store.tool === 'pen'" :cx="pending[0][0]" :cy="pending[0][1]" :r="6 / strokeZ" fill="none" stroke="#4f9cff" :stroke-width="1 / strokeZ" pointer-events="none" />
          <line v-if="penExtLine" :x1="penExtLine[0]" :y1="penExtLine[1]" :x2="pendingCursor[0]" :y2="pendingCursor[1]" stroke="#4f9cff" :stroke-width="Math.max(0.2, 0.9 / strokeZ)" stroke-dasharray="0.6 0.4" pointer-events="none" />
          <rect v-if="marquee" :x="marquee.x0" :y="marquee.y0" :width="marquee.x1 - marquee.x0" :height="marquee.y1 - marquee.y0" fill="#4f9cff22" stroke="#4f9cff" :stroke-width="1 / strokeZ" pointer-events="none" />
          <line v-if="guides.x !== undefined" :x1="guides.x" :y1="-1000" :x2="guides.x" :y2="boardH + 1000" stroke="#ff5aa0" :stroke-width="1 / strokeZ" :stroke-dasharray="`${4 / strokeZ} ${3 / strokeZ}`" pointer-events="none" />
          <line v-if="guides.y !== undefined" :x1="-1000" :y1="guides.y" :x2="boardW + 1000" :y2="guides.y" stroke="#ff5aa0" :stroke-width="1 / strokeZ" :stroke-dasharray="`${4 / strokeZ} ${3 / strokeZ}`" pointer-events="none" />
          <g v-if="guides.p" pointer-events="none">
            <circle :cx="guides.p[0]" :cy="guides.p[1]" :r="5 / strokeZ" fill="none" stroke="#ffb347" :stroke-width="1.2 / strokeZ" />
          </g>
          <path v-if="shapeUi" :d="shapeD" fill="#4f9cff18" stroke="#4f9cff" :stroke-width="1 / strokeZ" pointer-events="none" />
          <g v-if="knifeUi" pointer-events="none">
            <line :x1="knifeUi.a[0]" :y1="knifeUi.a[1]" :x2="knifeUi.b[0]" :y2="knifeUi.b[1]" stroke="#ff5c5c" :stroke-width="1.2 / strokeZ" :stroke-dasharray="`${3 / strokeZ} ${2 / strokeZ}`" />
          </g>
          <g v-if="measureInfo" pointer-events="none">
            <line :x1="measureInfo.a[0]" :y1="measureInfo.a[1]" :x2="measureInfo.b[0]" :y2="measureInfo.b[1]" stroke="#ffb347" :stroke-width="1.2 / strokeZ" />
            <text :x="(measureInfo.a[0] + measureInfo.b[0]) / 2" :y="(measureInfo.a[1] + measureInfo.b[1]) / 2 - 3 / strokeZ" :transform="readable((measureInfo.a[0] + measureInfo.b[0]) / 2)" fill="#ffb347" :font-size="12 / strokeZ" text-anchor="middle" font-family="ui-monospace, monospace">{{ measureInfo.d.toFixed(2) }} mm · {{ measureInfo.m.toFixed(0) }} m · {{ measureInfo.angle.toFixed(1) }}°</text>
          </g>
          <g v-if="rotateUi" pointer-events="none">
            <circle :cx="rotateUi.pivot[0]" :cy="rotateUi.pivot[1]" :r="4 / strokeZ" fill="none" stroke="#ffb347" :stroke-width="1.2 / strokeZ" />
            <line :x1="rotateUi.pivot[0]" :y1="rotateUi.pivot[1]" :x2="pendingCursor[0]" :y2="pendingCursor[1]" stroke="#ffb347" :stroke-width="1 / strokeZ" stroke-dasharray="1 1" />
            <text :x="rotateUi.pivot[0] + 6 / strokeZ" :y="rotateUi.pivot[1] - 6 / strokeZ" :transform="readable(rotateUi.pivot[0] + 6 / strokeZ)" fill="#ffb347" :font-size="12 / strokeZ" font-family="ui-monospace, monospace">{{ liveAngle.toFixed(1) }}°</text>
          </g>
        </template>
       </g>
      </g>
    </svg>
    <div v-if="board" class="side-badge" :class="{ back: flip }" :title="flip ? 'Mirrored left-right: the board as seen from the back. Back silk reads as it will be printed; front art and LEDs are faint.' : 'The board as seen from the front. Back silk shows faint, as if seen through the board.'">
      <b>{{ flip ? 'Back view' : 'Front view' }}</b>
      <span>{{ flip ? 'mirrored · back silk reads as printed' : (store.backArt || backPolys.length || backLines.length || backLabels.length ? 'back silk seen through the board' : 'top side') }}</span>
      <button class="link" @click="store.viewBack = !store.viewBack">{{ flip ? 'show front' : 'view from back' }}</button>
    </div>
    <div class="hud mono">
      <span ref="hudEl"></span>
      <span class="muted"> · {{ hint }}</span>
      <span v-if="handlesCapped" class="warn"> · {{ handlesCapped.toLocaleString() }} vertices in view: zoom in to show node handles</span>
      <label class="small" style="margin-left: 8px"><input v-model="showAxes" type="checkbox" /> runway axes</label>
    </div>
  </div>
</template>

<style scoped>
.canvas-wrap { position: relative; height: 100%; overflow: hidden; background: var(--bg); }
.canvas { width: 100%; height: 100%; display: block; touch-action: none; }
.side-badge { position: absolute; left: 8px; top: 8px; display: flex; gap: 8px; align-items: baseline; font-size: 11px; background: #0f1114cc; color: var(--muted); padding: 3px 8px; border-radius: 4px; border: 1px solid #2a3340; }
.side-badge b { color: #e6e8ec; font-weight: 600; }
.side-badge.back { border-color: #b58cff; }
.side-badge.back b { color: #b58cff; }
.side-badge button.link { background: none; border: none; color: var(--accent); padding: 0; cursor: pointer; font-size: 11px; }
.hud { position: absolute; left: 8px; bottom: 6px; color: var(--muted); background: #0f1114cc; padding: 3px 8px; border-radius: 4px; pointer-events: none; font-size: 11px; max-width: calc(100% - 16px); }
.hud label { pointer-events: auto; }
.hud .warn { color: var(--accent2); }
.handles [data-kind='seg'] { pointer-events: stroke; }
.handles [data-kind='seg']:hover { stroke: #4f9cff55; }
.handles [data-kind='mid']:hover { fill: #8fb8ff; }
.handles [data-kind='vertex']:hover { stroke: #ffb347; }
</style>

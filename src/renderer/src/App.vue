<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useProject } from './stores/project'
import type { EndChevronStyle, Label, Led, LineFeature, PolyFeature, Project, Pt, RunwayMarkingStyle } from './core/model'
import type { PcbRoute } from './core/pcbtypes'
import Toolbar from './components/Toolbar.vue'
import AirportPanel from './components/AirportPanel.vue'
import LayersPanel from './components/LayersPanel.vue'
import PlacementPanel from './components/PlacementPanel.vue'
import RunwayPanel from './components/RunwayPanel.vue'
import SourcesPanel from './components/SourcesPanel.vue'
import Inspector from './components/Inspector.vue'
import EditorCanvas from './components/EditorCanvas.vue'
import ContextMenu from './components/ContextMenu.vue'
import BusyOverlay from './components/BusyOverlay.vue'
import PcbPanel from './components/PcbPanel.vue'

const store = useProject()
const tab = ref<'airport' | 'sources' | 'layers' | 'placement' | 'runways' | 'pcb'>('airport')
const canvas = ref<InstanceType<typeof EditorCanvas> | null>(null)

onMounted(async () => {
  const batch = new URLSearchParams(window.location.search).get('batch')
  if (batch) {
    await runBatch(batch)
    return
  }
  const q = new URLSearchParams(window.location.search).get('autotest')
  if (!q) return
  const { searchAirports } = await import('./core/airports')
  const hits = await searchAirports(q, 5)
  const a = hits.find((h) => h.icao === q.toUpperCase() || h.ident === q.toUpperCase()) ?? hits[0]
  if (!a) {
    console.log('AUTOTEST: no airport for', q, 'AUTOTEST DONE')
    return
  }
  console.log('AUTOTEST: building', a.icao, a.name)
  await store.buildFromAirport(a)
  for (const l of store.log) console.log('AUTOTEST log:', l)
  if (new URLSearchParams(window.location.search).get('pcb')) {
    await pcbFlow()
    console.log('AUTOTEST DONE')
    return
  }
  const { nextTick } = await import('vue')
  await new Promise((r) => setTimeout(r, 600))
  canvas.value?.fitView()
  const p = store.project!
  // exercise the editing operations
  const leds = p.leds.slice(0, 6)
  store.setSelection(leds.map((l) => ({ kind: 'led', id: l.id })))
  store.alignSelection('hcenter')
  store.distributeSelection('v')
  store.orientSelection('nearest90')
  store.rotateSelectionBy(45)
  store.duplicateSelection()
  console.log('AUTOTEST: edit ops ok, selected', store.selected.count, 'undo depth', store.undoDepth)
  const axis = p.lines.find((l) => l.cls === 'runway_cl' && l.sub === 'axis')
  if (axis) store.addRunwayMarkings(axis.id, { end: 0, kind: 'chevrons', lengthM: 300, count: 4 })
  if (axis) store.addRunwayMarkings(axis.id, { end: 1, kind: 'arrows', lengthM: 300, count: 4 })
  const c = store.tf!.toMm([p.frame.minx + 400, p.frame.maxy - 400])
  store.addPoly([[c[0], c[1]], [c[0] + 30, c[1]], [c[0] + 30, c[1] + 20], [c[0], c[1] + 20]])
  store.setSelectionProps({ fill: 'hatch', hatch: { angleDeg: 30, pitchMm: 1.2, cross: true, widthMm: 0.15 }, layer: 'copper' })
  await store.resolveCollisions()
  store.updateSourceStyle('road_local', { mode: 'edges+centre', widthMm: 0.1, edgeWidthMm: 0.12, laneM: 3.5, defaultLanes: 2, minWidthM: 6 })
  await store.applySourcesNow()
  console.log('AUTOTEST log:', store.log[store.log.length - 1])
  store.clearSelection()
  await nextTick()
  await new Promise((r) => setTimeout(r, 600))
  const dir = await store.exportFiles()
  console.log('AUTOTEST: exported to', dir)
  for (const l of store.log.slice(-4)) console.log('AUTOTEST log:', l)
  if (dir) await window.api.autotestShot(dir + '/screenshot.png')
  // background task cancel: the worker is terminated, nothing changes, the next task gets a fresh worker
  {
    const ledsBefore = store.project!.leds
    const run = store.placeLeds()
    for (let i = 0; i < 400 && !store.task.cancellable; i++) await new Promise((r) => setTimeout(r, 2))
    const wasActive = store.task.active && store.task.cancellable
    store.cancelCurrentTask()
    await run
    const unchanged = store.project!.leds === ledsBefore
    await store.placeLeds()
    console.log(`AUTOTEST cancel: task active ${wasActive}, LEDs unchanged after cancel ${unchanged}, overlay closed ${!store.task.active}, re-run placed ${store.project!.leds.length} LEDs`)
    // a fresh placement leaves no LED pair whose pads would come under 0.15 mm apart (runway crossings get one LED)
    const summary = store.task.lines.find((x) => x.includes(' LEDs: ')) ?? ''
    const close = store.ledsTooClose
    console.log(`AUTOTEST placement: ${summary}; too close pairs ${close.length}${close.length ? ` FAIL placement: ${close.slice(0, 5).map((c) => `${c.a.label}/${c.b.label} ${c.gapMm.toFixed(2)}`).join(', ')}` : ''}; runway crossings ${store.project!.leds.filter((l) => (l.alsoFeatures ?? []).length).map((l) => l.label).join(', ') || 'none'}`)
    // a failing task keeps the overlay open with the error until dismissed
    await store.runTask('Failing task', async (log) => {
      log('about to fail')
      throw new Error('synthetic failure')
    })
    const open1 = store.task.active
    const err = store.task.error
    store.dismissTask()
    console.log(`AUTOTEST task error: overlay kept open ${open1}, error "${err}", closed after dismiss ${!store.task.active}`)
  }
  const led = p.leds[Math.floor(p.leds.length / 2)]
  let t0 = performance.now()
  for (let i = 0; i < 30; i++) {
    store.updateLed(led.id, { pos: [led.pos[0] + 0.5, led.pos[1]] }, false)
    await nextTick()
  }
  console.log(`AUTOTEST perf: LED move ${((performance.now() - t0) / 30).toFixed(1)} ms per update`)
  t0 = performance.now()
  for (let i = 0; i < 10; i++) {
    canvas.value?.zoomTo(p.board.widthMm / 2, p.board.heightMm / 2, 2 + i * 0.7)
    await nextTick()
  }
  console.log(`AUTOTEST perf: zoom ${((performance.now() - t0) / 10).toFixed(1)} ms per step`)
  // synthetic pointer interactions: marquee select, drag an LED with snapping, rotate tool
  canvas.value?.zoomTo(p.board.widthMm * 0.55, p.board.heightMm * 0.55, 6)
  await nextTick()
  const svg = canvas.value!.svgEl as SVGSVGElement
  const ev = (type: string, target: Element, x: number, y: number, extra: PointerEventInit = {}): void => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true, ...extra }))
  }
  const cx = p.board.widthMm * 0.55
  const cy = p.board.heightMm * 0.55
  const [sx0, sy0] = canvas.value!.mmToScreen([cx - 25, cy - 20])
  const [sx1, sy1] = canvas.value!.mmToScreen([cx + 25, cy + 20])
  store.clearSelection()
  ev('pointerdown', svg, sx0, sy0)
  ev('pointermove', svg, (sx0 + sx1) / 2, (sy0 + sy1) / 2)
  ev('pointermove', svg, sx1, sy1)
  ev('pointerup', svg, sx1, sy1, { buttons: 0 })
  await nextTick()
  console.log('AUTOTEST interact: marquee selected', store.selected.count)
  const first = store.selected.leds[0]
  if (first) {
    const el = svg.querySelector(`[data-kind="led"][data-id="${first.id}"]`) as Element
    const [lx, ly] = canvas.value!.mmToScreen(store.tf!.toMm(first.pos))
    const before = store.tf!.toMm(first.pos)
    store.clearSelection()
    ev('pointerdown', el, lx, ly)
    ev('pointermove', svg, lx + 30, ly + 12)
    ev('pointermove', svg, lx + 60, ly + 24)
    ev('pointerup', svg, lx + 60, ly + 24, { buttons: 0 })
    await nextTick()
    const after = store.tf!.toMm(first.pos)
    console.log(`AUTOTEST interact: drag moved LED by ${(after[0] - before[0]).toFixed(2)}, ${(after[1] - before[1]).toFixed(2)} mm (60/24 px at zoom 6 = 10/4 mm before snapping), selected ${store.selected.count}, locked ${first.locked}`)
    // rotate tool: R starts it, cursor sets the angle, click confirms
    store.setSelection(p.leds.slice(10, 14).map((l) => ({ kind: 'led', id: l.id })))
    const rotBefore = p.leds[10].rotDeg
    store.tool = 'rotate'
    await nextTick()
    const b = store.selectionBounds!
    const [px, py] = canvas.value!.mmToScreen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2])
    ev('pointermove', svg, px + 100, py - 100, { buttons: 0 })
    await nextTick()
    ev('pointerdown', svg, px + 100, py - 100)
    ev('pointerup', svg, px + 100, py - 100, { buttons: 0 })
    await nextTick()
    console.log(`AUTOTEST interact: rotate tool ${rotBefore.toFixed(1)} -> ${p.leds[10].rotDeg.toFixed(1)} deg, tool now ${store.tool}, undo depth ${store.undoDepth}`)
  }
  store.setSelection(p.leds.slice(0, 40).map((l) => ({ kind: 'led', id: l.id })))
  await new Promise((r) => setTimeout(r, 600))
  if (dir) await window.api.autotestShot(dir + '/screenshot_zoom.png')
  try {
    await pathTests(dir)
  } catch (e) {
    console.log('AUTOTEST FAIL path tests', String(e), (e as Error).stack)
  }
  try {
    await backArtTests(dir)
  } catch (e) {
    console.log('AUTOTEST FAIL back art tests', String(e), (e as Error).stack)
  }
  try {
    await runwayStyleTests(dir)
  } catch (e) {
    console.log('AUTOTEST FAIL runway style tests', String(e), (e as Error).stack)
  }
  try {
    await panTests()
  } catch (e) {
    console.log('AUTOTEST FAIL pan tests', String(e), (e as Error).stack)
  }
  try {
    await textTests()
  } catch (e) {
    console.log('AUTOTEST FAIL text tests', String(e), (e as Error).stack)
  }
  console.log('AUTOTEST DONE')
})

/** Label outlines for the PCB (labelPolys) against the browser's own rasteriser filling the same text path: every
 *  sample the canvas paints solidly must be inside the polygons and every clearly empty one outside. (Holes decided
 *  by containment used to cut the legs off R and the bars off E: "O'HARE" came out as "O'HAPL".) */
async function textTests(): Promise<void> {
  const { labelPolys, labelPathD, loadFonts } = await import('./core/export')
  const gm = await import('./core/geom')
  const out = (s: string): void => console.log('AUTOTEST text:', s)
  const fs = await loadFonts()
  const t = store.tf!
  for (const [text, weight] of [["CHICAGO O'HARE INTERNATIONAL", 600], ['KORD ELEV 680 FT SCALE 1:11,744', 400], ['RENKXQ&%@8', 600]] as [string, 400 | 600][]) {
    const lb: Label = { id: 'x', text, pos: t.toM([60, 60]), heightM: 3 / t.k, rotDeg: 0, layer: 'copper', weight, anchor: 'start' }
    const polys = gm.union(labelPolys(fs, lb, t))
    const { d, box } = labelPathD(fs, lb, t)
    const S = 24 // px per mm
    const [x0, y0, x1, y1] = [box[0] - 0.2, box[1] - 0.2, box[2] + 0.2, box[3] + 0.2]
    const cv = document.createElement('canvas')
    cv.width = Math.ceil((x1 - x0) * S)
    cv.height = Math.ceil((y1 - y0) * S)
    const cx = cv.getContext('2d')!
    cx.setTransform(S, 0, 0, S, -x0 * S, -y0 * S)
    cx.fill(new Path2D(d), 'nonzero')
    const px = cx.getImageData(0, 0, cv.width, cv.height).data
    let solid = 0
    let missing = 0
    let extra = 0
    for (let j = 1; j < cv.height; j += 2)
      for (let i = 1; i < cv.width; i += 2) {
        const al = px[(j * cv.width + i) * 4 + 3]
        if (al > 20 && al < 235) continue // antialiased edge
        const inside = polys.contains(gm.point([x0 + (i + 0.5) / S, y0 + (j + 0.5) / S]))
        if (al >= 235) {
          solid++
          if (!inside) missing++
        } else if (inside) extra++
      }
    out(`"${text}": ${solid} painted samples, ${missing} missing from the polygons, ${extra} extra`)
    if (missing > solid * 0.001 || extra > solid * 0.001) out(`FAIL label outline "${text}" differs from the rendered text`)
  }
}

/** Canvas controls: a right-drag pans (no context menu), a right-click without moving opens the context menu. */
async function panTests(): Promise<void> {
  const { nextTick } = await import('vue')
  const out = (s: string): void => console.log('AUTOTEST pan:', s)
  const el = canvas.value!.svgEl as unknown as SVGSVGElement
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const fire = (type: string, cx: number, cy: number, button: number, buttons: number): void => {
    el.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, button, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }))
  }
  store.ctxMenu = null
  const at = (): [number, number] => canvas.value!.mmToScreen([100, 100])
  const a0 = at()
  fire('pointerdown', x, y, 2, 2)
  fire('pointermove', x + 30, y + 20, -1, 2)
  fire('pointermove', x + 60, y + 40, -1, 2)
  fire('pointerup', x + 60, y + 40, 2, 0)
  await nextTick()
  const a1 = at()
  const panned = Math.abs(a1[0] - a0[0] - 60) < 0.5 && Math.abs(a1[1] - a0[1] - 40) < 0.5
  const noMenu = store.ctxMenu === null
  out(`right-drag by (60, 40) px: view moved (${(a1[0] - a0[0]).toFixed(1)}, ${(a1[1] - a0[1]).toFixed(1)}), context menu ${noMenu ? 'not opened' : 'OPENED'}`)
  if (!panned || !noMenu) out('FAIL right-drag should pan without opening the context menu')
  fire('pointerdown', x, y, 2, 2)
  fire('pointermove', x + 2, y + 1, -1, 2)
  fire('pointerup', x + 2, y + 1, 2, 0)
  await nextTick()
  const a2 = at()
  const menu = store.ctxMenu !== null
  out(`right-click (2 px jitter): context menu ${menu ? 'opened' : 'NOT opened'}, view moved ${Math.hypot(a2[0] - a1[0], a2[1] - a1[1]).toFixed(1)} px`)
  if (!menu || Math.hypot(a2[0] - a1[0], a2[1] - a1[1]) > 0.01) out('FAIL right-click should open the context menu and not pan')
  store.ctxMenu = null
  fire('pointerdown', x, y, 1, 4)
  fire('pointermove', x - 25, y + 10, -1, 4)
  fire('pointerup', x - 25, y + 10, 1, 0)
  await nextTick()
  const a3 = at()
  out(`middle-drag by (-25, 10) px: view moved (${(a3[0] - a2[0]).toFixed(1)}, ${(a3[1] - a2[1]).toFixed(1)})`)
  if (Math.abs(a3[0] - a2[0] + 25) > 0.5 || Math.abs(a3[1] - a2[1] - 10) > 0.5) out('FAIL middle-drag pan')
}

/** Runway end style: chevrons (two strokes and a designator per end, stopways and runway text gone), both directions,
 *  label regeneration keeps them, and back to classic. */
async function runwayStyleTests(dir: string | null): Promise<void> {
  const { DEFAULT_RUNWAY_MARKINGS, DEFAULT_END_CHEVRON } = await import('./core/model')
  const out = (s: string): void => console.log('AUTOTEST runway:', s)
  const p = (): Project => store.project!
  const axes = p().lines.filter((l) => l.cls === 'runway_cl' && l.sub === 'axis' && l.name)
  const expectEnds = axes.length * 2
  for (const direction of ['inward', 'outward'] as const) {
    store.applyRunwayStyle({ ...DEFAULT_RUNWAY_MARKINGS, endStyle: 'chevrons', chevron: { ...DEFAULT_END_CHEVRON, direction } })
    const r = store.runwayResult!
    const chevronLines = p().lines.filter((l) => l.src === 'rwy-end').length
    const des = p().labels.filter((l) => l.src === 'rwy-end')
    const onRunway = p().labels.filter((l) => l.kind === 'designator' && l.src !== 'rwy-end').length
    out(`${direction}: ${r.ends.length} ends for ${axes.length} runways, ${chevronLines} chevron lines, ${des.length} designator labels (${r.ends.map((e) => `${e.designator} ${e.textMm} mm`).join(', ')}); stopways left ${p().polys.filter((x) => x.cls === 'stopway').length}, runway name labels left ${p().labels.filter((l) => l.kind === 'runway').length}, other designators ${onRunway}`)
    if (r.ends.length !== expectEnds || chevronLines !== 2 * expectEnds || des.length < expectEnds || r.ends.some((e) => e.textMm < 0.5) || onRunway) out('FAIL runway end chevrons')
  }
  // Regenerate labels keeps the chevron designators and adds no on-runway ones
  await store.generateLabelsNow()
  const after = p().labels.filter((l) => l.src === 'rwy-end').length
  const extra = p().labels.filter((l) => l.kind === 'designator' && l.src !== 'rwy-end').length
  out(`after Regenerate labels: ${after} chevron designators, ${extra} on-runway designators, ${p().labels.filter((l) => l.kind === 'runway').length} runway name labels`)
  if (!after || extra) out('FAIL label regeneration with chevrons')
  canvas.value?.fitView()
  if (dir) await window.api.autotestShot(dir + '/screenshot_runway_chevrons.png')
  store.applyRunwayStyle({ ...DEFAULT_RUNWAY_MARKINGS, endStyle: 'classic' })
  const back = p().labels.filter((l) => l.kind === 'designator').length
  out(`classic again: chevron lines ${p().lines.filter((l) => l.src === 'rwy-end').length}, designators on the runway ${back}`)
  if (p().lines.some((l) => l.src === 'rwy-end') || !back) out('FAIL back to classic')
}

// A small back-art file: an "F" (58 mm2, reads differently mirrored), a square with a square hole (84 mm2), and
// optionally a triangle that leaves the board at its bottom-right corner.
function backArtSample(W: number, H: number, outside: boolean): string {
  const F = [[[10, 10], [20, 10], [20, 12], [12, 12], [12, 15], [18, 15], [18, 17], [12, 17], [12, 25], [10, 25]]]
  const donut = [[[30, 10], [40, 10], [40, 20], [30, 20]], [[33, 13], [37, 13], [37, 17], [33, 17]]]
  return JSON.stringify(outside ? [F, donut, [[W - 5, H - 5], [W + 2, H - 5], [W + 2, H + 1]]] : [F, donut])
}

/** Back silk: import (with the off-board warning), encoding round trip, undo, move / mirror, a mirrored back label,
 *  the bottom silkscreen SVG, the generator job and a back-view screenshot. */
async function backArtTests(dir: string | null): Promise<void> {
  const { nextTick } = await import('vue')
  const { backArtPolys } = await import('./core/backart')
  const { labelPolys, loadFonts } = await import('./core/export')
  const { compute } = await import('./services/compute')
  const gm = await import('./core/geom')
  const out = (s: string): void => console.log('AUTOTEST back:', s)
  const fail = (s: string): void => console.log('AUTOTEST back: FAIL', s)
  const p = store.project!
  const W = p.board.widthMm
  const H = p.board.heightMm
  const art = await store.importBackArtText(backArtSample(W, H, true), 'autotest_back.json')
  out(`import: ${art?.count} polygons, ${art?.points} points, ${art?.areaMm2} mm2, notes ${JSON.stringify(store.backArtNotes)}`)
  if (!art || art.count !== 3 || !store.backArtNotes.some((n) => n.includes('outside the board'))) fail('import or the off-board warning')
  // the triangle is a plain ring in the file (a list may mix rings and polygons): the import makes it a polygon
  const src = (JSON.parse(backArtSample(W, H, true)) as unknown[]).map((x) => (typeof (x as number[][])[0][0] === 'number' ? [x] : x)) as number[][][][]
  const got = backArtPolys(art!)
  const same = got.length === src.length && got.every((poly, i) => poly.length === src[i].length && poly.every((r, j) => r.length === src[i][j].length && r.every((q, k) => Math.abs(q[0] - src[i][j][k][0]) < 1e-3 && Math.abs(q[1] - src[i][j][k][1]) < 1e-3)))
  out(`encoding round trip exact: ${same}`)
  if (!same) fail('encoding round trip')
  store.undo()
  const gone = !store.project!.backArt
  store.redo()
  const again = store.project!.backArt?.count === 3
  out(`undo removes the import: ${gone}, redo restores it: ${again}`)
  if (!gone || !again) fail('undo / redo of the import')
  store.translateBackArt(1, 2)
  const lockedStays = store.project!.backArt!.offset[0] === 0
  store.patchBackArt({ locked: false })
  store.translateBackArt(1, 2)
  const moved = backArtPolys(store.project!.backArt!)
  const movedOk = Math.abs(moved[0][0][0][0] - 11) < 1e-6 && Math.abs(moved[0][0][0][1] - 12) < 1e-6
  store.mirrorBackArt()
  const mir = backArtPolys(store.project!.backArt!)
  const mirOk = Math.abs(Math.max(...mir[0][0].map((q) => q[0])) - (W - 11)) < 1e-3
  store.mirrorBackArt()
  const twice = JSON.stringify(backArtPolys(store.project!.backArt!).map((poly) => poly.map((r) => [...r].sort()))) === JSON.stringify(moved.map((poly) => poly.map((r) => [...r].sort())))
  out(`locked art does not move: ${lockedStays}; moved by (1, 2): ${movedOk}; mirror puts the F at x ${W - 11}: ${mirOk}; mirror twice restores it: ${twice}`)
  if (!lockedStays || !movedOk || !mirOk || !twice) fail('move / mirror')
  // a drawn back label reads from the back: its outline is the front label's mirrored about the anchor
  store.addPreset.layer = 'silkBack'
  const lb = store.addLabelAt([W / 2, H / 2], 'BACK F')!
  store.addPreset.layer = 'silk'
  const fs = await loadFonts()
  const env = (g: import('./core/geom').G[]): number[] => { const e = gm.union(g).getEnvelopeInternal(); return [e.getMinX(), e.getMaxX()] }
  const [bx0, bx1] = env(labelPolys(fs, lb, store.tf!))
  const [fx0, fx1] = env(labelPolys(fs, { ...lb, layer: 'silk' }, store.tf!))
  const ax = store.tf!.toMm(lb.pos)[0]
  const labelOk = Math.abs(bx0 - (2 * ax - fx1)) < 1e-6 && Math.abs(bx1 - (2 * ax - fx0)) < 1e-6
  out(`back label mirrored about its anchor: ${labelOk} (front x ${fx0.toFixed(2)}..${fx1.toFixed(2)}, back ${bx0.toFixed(2)}..${bx1.toFixed(2)})`)
  if (!labelOk) fail('back label mirroring')
  // exports: bottom_silk.svg and the generator job carry the art (the job also carries the via option)
  store.pcbSetOptions({ backSilkClearVias: true })
  const files = await compute('export', { project: store.project! }).promise
  const svg = files.find((f) => f.name === 'bottom_silk.svg')?.content ?? ''
  const job = await compute('pcbjob', { project: store.project! }).promise
  const svgPaths = (svg.match(/<path /g) ?? []).length
  out(`bottom_silk.svg: ${svgPaths} paths (${svg.match(/<!-- (.*) -->/)?.[1] ?? 'no note'}); job: ${job.art.silkBack.length} back silk polygons, backSilkClearVias ${job.options.backSilkClearVias}`)
  if (svgPaths < 4 || job.art.silkBack.length < 4 || !job.options.backSilkClearVias) fail('bottom silk export or job')
  store.pcbSetOptions({ backSilkClearVias: false })
  // hidden in Layers = not exported
  store.setLayerVisible('backsilk', false)
  const hidden = await compute('pcbjob', { project: store.project! }).promise
  store.setLayerVisible('backsilk', true)
  out(`back silk hidden: job has ${hidden.art.silkBack.length} back polygons`)
  if (hidden.art.silkBack.length) fail('hidden back silk was exported')
  store.viewBack = true
  canvas.value?.zoomTo(30, 25, 12)
  await nextTick()
  await new Promise((r) => setTimeout(r, 700))
  if (dir) await window.api.autotestShot(dir + '/screenshot_back_view.png')
  store.viewBack = false
  canvas.value?.fitView()
}

/**
 * Scripted runs (FB_BATCH=<job.json>): for each job open a project, optionally let the labels marked `_resolve`
 * move clear of LEDs and other labels (everything else stays where it is), save, take screenshots, export.
 * job.json: { "jobs": [{ "name", "in", "out"?, "resolve"?, "backArt"?, "shots"?: [{ "file", "view"?: "fit" | [cxMm, cyMm, zoom], "back"? }],
 *   "exportDir"?, "pcbExport"? }] }
 * backArt: a back-art file imported (File › Import back art…) before saving; shots with back: true are taken in the back
 * view; pcbExport: the PCB tab end to end (prepare, auto-place blocks, preview routing, export to FB_AUTOTEST_DIR/altium).
 * spacing: the placement's spacing pass over the LEDs as they are (too-close pairs merged by class priority, locked
 * LEDs kept); pcbChains: prepare, auto-place blocks, Assign chains and Preview routing (before "out" is saved).
 */
interface BatchJob {
  name?: string
  in: string
  out?: string
  resolve?: boolean
  backArt?: string
  shots?: { file: string; view?: 'fit' | [number, number, number]; back?: boolean; select?: string[]; markers?: { p: [number, number]; color?: string; r?: number; ring?: boolean }[] }[]
  exportDir?: string
  pcbExport?: boolean
  spacing?: boolean
  pcbChains?: boolean
  pcbPreview?: boolean
  runwayStyle?: Partial<Omit<RunwayMarkingStyle, 'chevron'>> & { chevron?: Partial<EndChevronStyle> }
  perf?: string[]
}
/** Main-thread blocking per operation: wall time, longest long task (>50 ms) and their sum. */
async function perfSuite(name: string, ops: string[], text: string): Promise<void> {
  const { nextTick } = await import('vue')
  const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const tasks: { start: number; dur: number }[] = []
  const obs = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) tasks.push({ start: e.startTime, dur: e.duration })
  })
  obs.observe({ type: 'longtask', buffered: false })
  const measure = async (op: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    await sleep(400)
    tasks.length = 0
    const t0 = performance.now()
    let err = ''
    try {
      await fn()
    } catch (e) {
      err = ' ERROR ' + String(e)
    }
    await nextTick()
    await raf()
    await raf()
    const wall = performance.now() - t0
    // wait for the busy overlay to close (async tasks) and anything scheduled after the op
    for (let i = 0; i < 600 && (store as unknown as { task?: { active: boolean } }).task?.active; i++) await sleep(50)
    await sleep(300)
    const mine = tasks.filter((t) => t.start >= t0 - 5)
    const max = mine.reduce((m, t) => Math.max(m, t.dur), 0)
    const sum = mine.reduce((m, t) => m + t.dur, 0)
    console.log(`PERF ${name} ${op.padEnd(12)} wall ${wall.toFixed(0).padStart(6)} ms · longest block ${max.toFixed(0).padStart(5)} ms · blocked ${sum.toFixed(0).padStart(6)} ms in ${mine.length} tasks${err}`)
  }
  const p = (): Project => store.project!
  for (const op of ops) {
    if (op === 'open') await measure(op, () => store.loadProject(JSON.parse(text) as Project, null))
    else if (op === 'viewBack' || op === 'viewFront') await measure(op, async () => {
      store.viewBack = op === 'viewBack'
      await nextTick()
      await raf()
    })
    else if (op === 'place') await measure(op, () => store.placeLeds())
    else if (op === 'labels') await measure(op, () => store.generateLabelsNow())
    else if (op === 'resolve') await measure(op, () => store.resolveCollisions())
    else if (op === 'sources') await measure(op, () => store.fetchAndApplySources())
    else if (op === 'export') await measure(op + ' (worker)', async () => {
      const { compute } = await import('./services/compute')
      await compute('export', { project: p() }).promise
    })
    else if (op === 'undo') await measure(op, () => store.undo())
    else if (op === 'dragLed') {
      const led = p().leds[100]
      store.setSelection([{ kind: 'led', id: led.id }])
      await measure(op + ' x20', async () => {
        store.beginTransform()
        for (let i = 1; i <= 20; i++) {
          store.moveSelectionTo(i * 0.1, 0)
          await nextTick()
          await raf()
        }
        store.endTransform(true)
      })
    } else if (op === 'dragVertex') {
      const ln = p().lines.find((l) => l.cls === 'taxiway')!
      store.setSelection([{ kind: 'line', id: ln.id }])
      store.selectNode({ id: ln.id, ring: 0, idx: 0 })
      await measure(op + ' x20', async () => {
        store.beginTransform()
        for (let i = 1; i <= 20; i++) {
          store.moveNodesTo(i * 0.1, 0)
          await nextTick()
          await raf()
        }
        store.endTransform(true)
      })
    } else if (op === 'build') {
      const { searchAirports } = await import('./core/airports')
      const a = (await searchAirports('KORD', 5)).find((h) => h.icao === 'KORD')!
      await measure(op, () => store.buildFromAirport(a))
    } else if (op.startsWith('overlay:')) {
      // screenshot the busy overlay part-way through an airport build (cached downloads, then the worker)
      const { searchAirports } = await import('./core/airports')
      const a = (await searchAirports('KORD', 5)).find((h) => h.icao === 'KORD')!
      const run = store.buildFromAirport(a)
      await sleep(6000)
      await window.api.autotestShot(op.slice(8))
      await run
    } else if (op === 'zoom') {
      await measure(op + ' x10', async () => {
        for (let i = 0; i < 10; i++) {
          canvas.value?.zoomTo(p().board.widthMm / 2, p().board.heightMm / 2, 2 + i * 0.5)
          await nextTick()
          await raf()
        }
      })
    }
  }
  obs.disconnect()
}
/** Chain maker on the open project (batch): prepare, auto-place the blocks, Assign chains, Preview routing. */
async function batchPcbChains(name: string): Promise<void> {
  const out = (s: string): void => console.log(`BATCH ${name} chains: ${s}`)
  const dump = (): void => {
    for (const l of store.task.lines.slice(-20)) console.log(`BATCH ${name} chains log: ${l}`)
    if (store.task.error) out('TASK ERROR ' + store.task.error)
  }
  tab.value = 'pcb'
  await store.pcbPrepare()
  dump()
  if (!store.pcb.jobId) return out('FAIL no job')
  await store.pcbAutoplace()
  await store.pcbAssignChains()
  dump()
  const cs = store.pcb.chainStats
  out(`chains: ${cs.map((c) => `CH${c.chain} ${c.count} LEDs ${(c.lengthMm / 1000).toFixed(2)} m longest hop ${c.longestHopMm.toFixed(1)} mm`).join('; ')}`)
  out(`longest hop overall ${Math.max(...cs.map((c) => c.longestHopMm)).toFixed(1)} mm; LEDs on chains ${cs.reduce((s, c) => s + c.count, 0)}`)
  const t0 = performance.now()
  const pr = await store.pcbPreviewRoute()
  dump()
  if (!pr) return out('FAIL preview returned nothing')
  const g = pr.route
  out(`preview (${((performance.now() - t0) / 1000).toFixed(1)} s): ${g.routed}/${g.routed + g.failedCount} hops routed, ${g.dataVias} data vias, ${(g.trackMm / 1000).toFixed(2)} m of track, unrouted ${JSON.stringify(g.failed.map((f) => f.net))}, caps over a part ${JSON.stringify(g.capConflicts ?? [])}, LED pads too close ${JSON.stringify(g.ledsTooClose ?? [])}`)
}
/** PCB tab end to end on the open project (batch): prepare, auto-place the blocks, preview, export. */
async function batchPcbExport(name: string): Promise<void> {
  const out = (s: string): void => console.log(`BATCH ${name} pcb: ${s}`)
  const dump = (): void => {
    for (const l of store.task.lines.slice(-30)) console.log(`BATCH ${name} pcb log: ${l}`)
    if (store.task.error) out('TASK ERROR ' + store.task.error)
  }
  tab.value = 'pcb'
  out(`back silk to export: ${JSON.stringify(store.backSilkSummary)}`)
  await store.pcbPrepare()
  dump()
  if (!store.pcb.jobId) return out('FAIL no job')
  await store.pcbAutoplace()
  dump()
  const t0 = performance.now()
  const pr = await store.pcbPreviewRoute()
  dump()
  if (pr) out(`preview (${((performance.now() - t0) / 1000).toFixed(1)} s): ${pr.route.routed}/${pr.route.routed + pr.route.failedCount} hops, ${pr.route.dataVias} data vias`)
  const t1 = performance.now()
  const r = await store.pcbExport()
  dump()
  if (!r) return out('FAIL export returned nothing')
  const rp = r.report
  out(`export (${((performance.now() - t1) / 1000).toFixed(1)} s): ${r.outDir}; ${rp.leds} LEDs, data ${rp.data?.routed}/${rp.data?.total} hops, ${rp.data?.vias} vias; unrouted ${rp.data?.failed ?? 0}, caps over a part ${rp.capConflicts ?? 0}, LED pads too close ${JSON.stringify(rp.ledsTooClose ?? [])}`)
  out(`art: ${JSON.stringify(rp.art)}`)
  out(`files: ${r.files.join(' ')}`)
}
async function runBatch(jobPath: string): Promise<void> {
  const { nextTick } = await import('vue')
  const { resolveLabelCollisions } = await import('./core/labels')
  const { loadFonts } = await import('./core/export')
  const { compute } = await import('./services/compute')
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    const fonts = await loadFonts()
    store.fonts = fonts
    const job = JSON.parse(await window.api.readFile(jobPath)) as { jobs: BatchJob[] }
    for (const j of job.jobs) {
      const name = j.name ?? j.in
      try {
        const text = await window.api.readFile(j.in)
        const p = JSON.parse(text) as Project
        store.loadProject(p, j.out ?? j.in)
        await nextTick()
        await sleep(300)
        canvas.value?.fitView()
        {
          const close = store.ledsTooClose
          console.log(`BATCH ${name}: ${p.leds.length} LEDs, LED pairs too close ${close.length}${close.length ? ': ' + close.map((c) => `${c.a.label || c.a.feature || c.a.cls}/${c.b.label || c.b.feature || c.b.cls} ${c.gapMm.toFixed(2)} mm`).join(', ') : ''}; back art ${p.backArt ? `${p.backArt.count} polygons, ${p.backArt.areaMm2} mm2 (${p.backArt.source})` : 'none'}`)
        }
        if (j.spacing) {
          const { spacingPass } = await import('./core/spacing')
          const before = store.project!.leds
          const r = spacingPass(before, store.tf!)
          const kept = new Set(r.leds.map((l) => l.id))
          const gone = before.filter((l) => !kept.has(l.id))
          store.project!.leds = r.leds
          store.rev.leds++
          await nextTick()
          console.log(`BATCH ${name}: spacing pass: merged ${JSON.stringify(r.merged)}, removed ${gone.map((l) => `${l.label || l.feature || l.cls} (${l.cls}${l.role ? ' ' + l.role : ''})`).join(', ') || 'none'}; LEDs ${r.leds.length}; LED pairs too close now ${store.ledsTooClose.length}`)
        }
        if (j.runwayStyle) {
          const { DEFAULT_RUNWAY_MARKINGS, DEFAULT_END_CHEVRON } = await import('./core/model')
          store.applyRunwayStyle({ ...DEFAULT_RUNWAY_MARKINGS, ...j.runwayStyle, chevron: { ...DEFAULT_END_CHEVRON, ...(j.runwayStyle.chevron ?? {}) } })
          const r = store.runwayResult
          console.log(`BATCH ${name}: runway ends ${r?.style}: removed ${JSON.stringify(r?.removed)}, added ${JSON.stringify(r?.added)}`)
          for (const e of r?.ends ?? []) console.log(`BATCH ${name}: end ${e.designator}: span ${e.spanMm} mm, depth ${e.depthMm} mm, text ${e.textMm} mm${e.clipped ? ', shrunk to fit the board' : ''}${e.nearLeds.length ? `, strokes touch the silk keep-out of ${e.nearLeds.join(', ')}` : ''}`)
          await nextTick()
        }
        if (j.pcbChains) await batchPcbChains(name)
        if (j.pcbPreview) {
          tab.value = 'pcb'
          await store.pcbPrepare()
          const pr = await store.pcbPreviewRoute()
          for (const l of store.task.lines.slice(-4)) console.log(`BATCH ${name} preview log: ${l}`)
          if (pr) console.log(`BATCH ${name}: preview: ${pr.route.routed}/${pr.route.routed + pr.route.failedCount} hops routed, ${pr.route.dataVias} data vias, unrouted ${JSON.stringify(pr.route.failed.map((f) => f.net))}, caps over a part ${JSON.stringify(pr.route.capConflicts ?? [])}, LED pads too close ${JSON.stringify(pr.route.ledsTooClose ?? [])}`)
          else console.log(`BATCH ${name}: FAIL preview returned nothing`)
        }
        if (j.backArt) {
          const art = await store.importBackArtText(await window.api.readFile(j.backArt), j.backArt)
          for (const l of store.task.lines.slice(-6)) console.log(`BATCH ${name} log: ${l}`)
          console.log(`BATCH ${name}: ${art ? `imported back art: ${art.count} polygons, ${art.points} points, ${art.areaMm2} mm2, bounds ${art.bounds.join(', ')}, stored ${(art.data.length / 1e6).toFixed(2)} MB` : 'FAIL back art import ' + store.task.error}`)
          await nextTick()
          await sleep(300)
        }
        if (j.resolve) {
          type Marked = Label & { _resolve?: boolean }
          const marked = (p.labels as Marked[]).filter((l) => l._resolve)
          for (const l of marked) l.locked = false
          const r = resolveLabelCollisions(p, store.tf!, fonts, { dropUnplaceable: false })
          for (const l of marked) {
            l.locked = true
            delete l._resolve
          }
          store.rev.labels++
          console.log(`BATCH ${name}: ${p.labels.length} labels, ${marked.length} free to move, ${r.moved} moved, ${r.unresolved.length} still overlap${r.unresolved.length ? ': ' + r.unresolved.join(' | ') : ''}`)
        }
        if (j.out) {
          await window.api.writeFile(j.out, JSON.stringify(p))
          console.log(`BATCH ${name}: saved ${j.out} (${p.lines.length} lines, ${p.polys.length} polygons, ${p.leds.length} LEDs, ${p.labels.length} labels)`)
        }
        for (const s of j.shots ?? []) {
          store.viewBack = !!s.back
          // select: LED ids to highlight (e.g. audit outliers)
          if (s.select) store.selectLeds(s.select)
          else store.clearSelection()
          store.markers = s.markers ?? []
          await nextTick()
          if (!s.view || s.view === 'fit') canvas.value?.fitView()
          else canvas.value?.zoomTo(s.view[0], s.view[1], s.view[2])
          await nextTick()
          await sleep(s.back ? 1200 : 800)
          await window.api.autotestShot(s.file)
        }
        store.viewBack = false
        store.clearSelection()
        store.markers = []
        if (j.perf) await perfSuite(name, j.perf, text)
        if (j.pcbExport) await batchPcbExport(name)
        if (j.exportDir) {
          const t0 = performance.now()
          const files = await compute('export', { project: p }).promise
          for (const f of files) await window.api.writeFile(`${j.exportDir}/${f.name}`, f.content)
          console.log(`BATCH ${name}: exported ${files.map((f) => f.name).join(', ')} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
        }
      } catch (e) {
        console.log(`BATCH FAIL ${name}: ${String(e)} ${(e as Error).stack ?? ''}`)
      }
    }
  } catch (e) {
    console.log(`BATCH FAIL job ${jobPath}: ${String(e)}`)
  }
  console.log('BATCH DONE')
}

/** PCB tab end to end on a fresh board: generator, blocks, live checks, chains, screenshots, Altium export. */
async function pcbFlow(): Promise<void> {
  const { nextTick } = await import('vue')
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const out = (s: string): void => console.log('AUTOTEST pcb:', s)
  const dumpTask = (): void => { for (const l of store.task.lines.slice(-40)) console.log('AUTOTEST pcb log:', l); if (store.task.error) out('TASK ERROR ' + store.task.error) }
  const dir = await window.api.pickDir('autotest')
  {
    const close = store.ledsTooClose
    const crossings = store.project!.leds.filter((l) => (l.alsoFeatures ?? []).length).map((l) => l.label)
    out(`placement: ${store.project!.leds.length} LEDs, too close pairs ${close.length}, runway crossings ${crossings.length ? crossings.join(', ') : 'none'}`)
    if (close.length) out(`FAIL placement: ${close.slice(0, 5).map((c) => `${c.a.label}/${c.b.label} ${c.gapMm.toFixed(2)} mm`).join(', ')}`)
  }
  // back silk through the export: the sample art (142 mm2 in 2 polygons) and a back label
  await store.importBackArtText(backArtSample(store.project!.board.widthMm, store.project!.board.heightMm, false), 'autotest_back.json')
  store.addPreset.layer = 'silkBack'
  store.addLabelAt([store.project!.board.widthMm / 2, store.project!.board.heightMm / 2], 'BACK')
  store.addPreset.layer = 'silk'
  tab.value = 'pcb'
  const t0 = performance.now()
  await store.pcbPrepare()
  dumpTask()
  out(`prepare: generator ${store.pcb.info?.exe ?? 'none'}, ${store.pcb.describe?.blocks.length ?? 0} blocks, job ${store.pcb.jobId || 'none'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  if (!store.pcb.jobId) return
  await store.pcbAutoplace()
  dumpTask()
  for (const b of store.pcb.check?.blocks ?? []) out(`check ${b.name}: ${b.ok ? 'ok' : 'FAIL'} ${JSON.stringify(b.pose)} LEDs under ${b.ledOverlaps.length}, art ${b.silkMm2}+${b.copperMm2} mm2${b.usbGapMm !== undefined ? `, ${b.usbGapMm} mm from USB-C` : ''} ${b.violations.join('; ')}`)
  // a live check on a bad pose: DCDC dragged onto the middle of the board, then back
  const dc = store.project!.pcb!.blocks.find((b) => b.name === 'DCDC')
  if (dc) {
    const keep = { ...dc }
    store.pcbSetBlockPose({ ...dc, x: store.project!.board.widthMm / 2, y: store.project!.board.heightMm / 2 }, false)
    await sleep(900)
    const c = store.pcb.check?.blocks.find((b) => b.name === 'DCDC')
    out(`live check after moving DCDC to the board centre: ok ${c?.ok}, ${c?.violations.join('; ')}`)
    store.pcb.selectedBlock = 'DCDC'
    canvas.value?.zoomTo(store.project!.board.widthMm / 2, store.project!.board.heightMm / 2, 4)
    await nextTick()
    await sleep(600)
    if (dir) await window.api.autotestShot(dir + '/pcb_check_fail.png')
    store.pcb.selectedBlock = null
    store.pcbSetBlockPose(keep, false)
    await sleep(900)
  }
  await store.pcbAssignChains()
  dumpTask()
  out(`chains: ${store.pcb.chainStats.map((c) => `CH${c.chain} ${c.count}`).join(', ')}`)
  canvas.value?.fitView()
  await nextTick()
  await sleep(700)
  if (dir) await window.api.autotestShot(dir + '/pcb_tab.png')
  const mcu = store.pcb.check?.blocks.find((b) => b.name === 'MCU')
  if (mcu) {
    const xs = mcu.footprint.map((q) => q[0])
    const ys = mcu.footprint.map((q) => q[1])
    canvas.value?.zoomTo((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 7)
    await nextTick()
    await sleep(700)
    if (dir) await window.api.autotestShot(dir + '/pcb_mcu.png')
  }
  // route preview: place + route in memory, overlay, zoomed look at the MCU fan-out and at a data via
  const tr = performance.now()
  const pr = await store.pcbPreviewRoute()
  dumpTask()
  if (pr) {
    const g = pr.route
    out(`route preview (${((performance.now() - tr) / 1000).toFixed(1)} s): ${g.routed}/${g.routed + g.failedCount} hops, ${g.dataVias} data vias, ${(g.trackMm / 1000).toFixed(2)} m, top ${g.top.length / 4} / bottom ${g.bottom.length / 4} segments, ${g.powerVias.length / 2} 5SW vias, ${g.caps.length / 3} caps, stale ${store.pcbRouteStale}`)
    canvas.value?.fitView()
    await nextTick()
    await sleep(800)
    if (dir) await window.api.autotestShot(dir + '/pcb_route.png')
    if (mcu) {
      const xs = mcu.footprint.map((q) => q[0])
      const ys = mcu.footprint.map((q) => q[1])
      canvas.value?.zoomTo((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 5)
      await nextTick()
      await sleep(700)
      if (dir) await window.api.autotestShot(dir + '/pcb_route_mcu.png')
    }
    if (g.vias.length >= 2) {
      canvas.value?.zoomTo(g.vias[0], g.vias[1], 14)
      await nextTick()
      await sleep(700)
      if (dir) await window.api.autotestShot(dir + '/pcb_route_via.png')
    }
    // moving a block makes the preview stale
    const dcb = store.project!.pcb!.blocks.find((b) => b.name === 'DCDC')
    if (dcb) {
      const keep = { ...dcb }
      store.pcbSetBlockPose({ ...dcb, x: (dcb.x ?? 0) + 1 }, false)
      await sleep(300)
      out(`after nudging DCDC: route stale ${store.pcbRouteStale}`)
      store.pcbSetBlockPose(keep, false)
      await sleep(300)
      out(`after moving it back: route stale ${store.pcbRouteStale}`)
    }
    await liveRouteTests(dir, out)
  } else out('route preview returned nothing')
  // the export keeps the chains of a current preview: every LED must come back on the chain and position it had
  const keeps = store.pcbExportKeepsChains
  const before = store.pcbPinnedChains()
  const previewVias = store.pcb.route?.dataVias
  const t1 = performance.now()
  const r = await store.pcbExport()
  dumpTask()
  if (r && before) {
    const got = new Map(r.chains.map((c) => [c.id, `${c.chain}:${c.index}`]))
    const moved = before.filter((c) => got.get(c.id) !== `${c.chain}:${c.index}`).length
    out(`export ${keeps ? 'kept the preview chains' : 'assigned chains'}: ${moved} of ${before.length} LEDs on a different chain position; data vias ${r.report.data?.vias} (preview ${previewVias})`)
    if (keeps && moved > 0) out(`FAIL export: ${moved} LEDs changed chain position although the preview was current`)
  }
  // the panel's export result (amber when something needs attention), scrolled into view
  {
    const left = document.querySelector('aside.panel.left') as HTMLElement | null
    if (left) left.scrollTop = left.scrollHeight
    await nextTick()
    await sleep(400)
    if (dir) await window.api.autotestShot(dir + '/pcb_export_panel.png')
    if (left) left.scrollTop = 0
  }
  if (r) {
    const rp = r.report
    out(`export problems: unrouted ${rp.data?.failed ?? 0}, caps over a part ${rp.capConflicts ?? 0}, LED pads too close ${JSON.stringify(rp.ledsTooClose ?? [])}`)
    out(`export: ${r.outDir} (${((performance.now() - t1) / 1000).toFixed(1)} s): ${rp.leds} LEDs, ${rp.caps} caps, ${rp.vias5sw} 5SW vias (${rp.viasSkipped} skipped), data ${rp.data?.routed}/${rp.data?.total} hops, ${rp.data?.vias} vias, on art after trim ${JSON.stringify(rp.onArtAfterTrim)}, LEDs in blocks ${rp.ledsInsideBlocks}, DCDC gap ${rp.dcdcToUsbGapMm} mm, sheets ${rp.sheets}`)
    out(`art: ${JSON.stringify(rp.art)}`)
    const bk = rp.art.back
    out(`back silk: ${bk?.polygons ?? 0} polygons (${bk?.regions ?? 0} regions, ${bk?.artMm2 ?? 0} mm2, ${bk?.removedMm2 ?? 0} mm2 cut)`)
    if (!bk || bk.polygons < 3 || bk.artMm2 < 142 || bk.removedMm2 !== 0) out('FAIL back silk: the sample art and the back label must reach the Bottom Overlay uncut')
    out(`files: ${r.files.join(' ')}`)
    const fw = store.pcb.lastFirmware
    out(fw ? `firmware: ${fw.path} (${fw.leds} LEDs, ${fw.chains} chains)` : 'firmware: not written')
    // install into a flightboard checkout given by FB_AUTOTEST_FWREPO (a scratch copy: this writes boards/<id>.json there)
    const repo = new URLSearchParams(window.location.search).get('fwrepo')
    if (repo && fw) {
      await store.pcbInstallFirmware(repo)
      dumpTask()
      out(`firmware install: ${store.pcb.lastFirmware?.installed ?? 'FAILED'}`)
    }
  } else out('export returned nothing')
}

/** Live (incremental) route preview after a full preview: five kinds of LED edit, each routed in place, then the
 *  exact-geometry check on the generator's board and a full preview of the same state (chains pinned) to compare. */
async function liveRouteTests(dir: string | null, out: (s: string) => void): Promise<void> {
  const { nextTick } = await import('vue')
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const p = store.project!
  const tf = store.tf!
  const mm = (l: Led): Pt => tf.toMm(l.pos)
  const gap = (l: Led): number => Math.min(...p.leds.filter((o) => o !== l).map((o) => Math.hypot(mm(o)[0] - mm(l)[0], mm(o)[1] - mm(l)[1])))
  const chain = (k: number): Led[] => p.leds.filter((l) => l.chain === k).sort((a, b) => (a.chainIndex ?? 0) - (b.chainIndex ?? 0))
  const roomy = (k: number): Led | undefined => chain(k).slice(5).find((l) => gap(l) >= 3.5)
  store.pcb.routeLive = false   // driven explicitly below; the live path is tested at the end
  const times: number[] = []
  let last: PcbRoute | null = null
  const step = async (label: string): Promise<void> => {
    const t = performance.now()
    const r = await store.pcbRouteIncremental()
    const trip = performance.now() - t
    if (!r || !r.incremental || !r.route) { out(`FAIL live ${label}: ${r?.reason ?? 'no reply'}`); return }
    last = r.route
    times.push(r.ms ?? 0)
    out(`live ${label}: ${r.ms} ms in the generator (${trip.toFixed(0)} ms round trip), ${r.changed} changed, ${r.replaced} placed again, ${r.rerouted} hops rerouted; routed ${r.route.routed}/${p.leds.length}, failed ${r.route.failedCount}, ${r.route.dataVias} vias`)
    if (r.route.routed + r.route.failedCount !== p.leds.length) out(`FAIL live ${label}: ${r.route.routed + r.route.failedCount} hops for ${p.leds.length} LEDs`)
    if (r.route.failedCount > 0) out(`FAIL live ${label}: unrouted ${r.route.failed.map((f) => f.net).join(', ')}`)
    if ((r.ms ?? 0) > 1000) out(`FAIL live ${label}: over 1 s`)
  }
  const a = roomy(3)
  if (a) { const [x, y] = mm(a); store.updateLed(a.id, { pos: tf.toM([x + 0.8, y]) }); await step('move 0.8 mm') }
  const b = roomy(5)
  if (b) { store.updateLed(b.id, { rotDeg: (b.rotDeg + 90) % 360 }); await step('rotate 90') }
  const c = roomy(2)
  if (c) { store.select('led', c.id); store.removeSelected(); await step('delete') }
  const ch6 = chain(6)
  const hop = ch6.findIndex((l, i) => i + 1 < ch6.length && Math.hypot(mm(ch6[i + 1])[0] - mm(l)[0], mm(ch6[i + 1])[1] - mm(l)[1]) >= 6)
  if (hop >= 0) {
    const u = mm(ch6[hop]), v = mm(ch6[hop + 1])
    const n = store.addLedAt([(u[0] + v[0]) / 2, (u[1] + v[1]) / 2])
    if (n) { store.updateLed(n.id, { rotDeg: ch6[hop].rotDeg, size: ch6[hop].size }, false); await step('add') }
  }
  const d = roomy(1)
  if (d) { store.pcbAssignLeds([d.id], 7); await step('hand chain edit (CH1 -> CH7)') }
  store.clearSelection()
  if (a) {
    const [x, y] = mm(a)
    canvas.value?.zoomTo(x, y, 14)
    await nextTick()
    await sleep(700)
    if (dir) await window.api.autotestShot(dir + '/pcb_route_live.png')
  }
  if (times.length) out(`live timings: max ${Math.max(...times).toFixed(1)} ms, mean ${(times.reduce((s, t) => s + t, 0) / times.length).toFixed(1)} ms over ${times.length} edits`)
  const chk = await store.pcbRouteCheck()
  if (chk) {
    out(`live datacheck: ${chk.summary}; violations ${chk.count}`)
    if (chk.count > 0) out(`FAIL live datacheck: ${chk.violations.slice(0, 5).join(' | ')}`)
  }
  const cmp = await store.pcbRouteCompare()
  if (cmp) {
    const i = cmp.incremental, f = cmp.full
    const ok = i.routed === f.routed && i.failed <= f.failed && Math.abs(i.vias - f.vias) <= 0.05 * Math.max(1, f.vias)
    out(`live vs full with the same chains (${cmp.seconds} s): routed ${i.routed} / ${f.routed}, failed ${i.failed} / ${f.failed}, vias ${i.vias} / ${f.vias} (${(((i.vias - f.vias) / Math.max(1, f.vias)) * 100).toFixed(1)}%), track ${(i.trackMm / 1000).toFixed(2)} / ${(f.trackMm / 1000).toFixed(2)} m -> ${ok ? 'match' : 'FAIL compare'}`)
  }
  // the live path itself: an edit, the debounced update, the overlay current again
  store.pcb.routeLive = true
  const e = roomy(4)
  if (e) {
    const [x, y] = mm(e)
    store.updateLed(e.id, { pos: tf.toM([x, y + 0.5]) })
    for (let k = 0; k < 40 && (store.pcb.routePending || store.pcbRouteStale); k++) await sleep(100)
    out(`live watcher: ${store.pcb.routeFrom}, stale ${store.pcbRouteStale}, ${store.pcb.routeUpdates} updates${store.pcb.routeInc ? `, last ${store.pcb.routeInc.ms} ms` : ''}`)
    if (store.pcbRouteStale) out('FAIL live watcher: preview still out of date')
  }
  void last
}

/** Path editing: store operations, then the same through synthetic pointer events. */
async function pathTests(dir: string | null): Promise<void> {
  const { nextTick } = await import('vue')
  const p = store.project!
  const tf = store.tf!
  const out: string[] = []
  const ok = (name: string, cond: boolean, info = ''): void => {
    out.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${info ? ' · ' + info : ''}`)
  }
  const o = tf.toMm([p.frame.minx + 300, p.frame.maxy - 1300]) // a quiet corner of the map, mm
  const R = (x: number, y: number, w: number, h: number): [number, number][] => [[o[0] + x, o[1] + y], [o[0] + x + w, o[1] + y], [o[0] + x + w, o[1] + y + h], [o[0] + x, o[1] + y + h]]
  const areaOf = (id: string): number => store.pathStats(store.pathOf(id)!).areaMm2
  const vertsOf = (id: string): number => store.pathStats(store.pathOf(id)!).verts
  const lastPoly = (): PolyFeature => p.polys[p.polys.length - 1]
  const lastLine = (): LineFeature => p.lines[p.lines.length - 1]

  // fillet a rectangle corner
  const r1 = store.addShape(R(0, 0, 20, 10))!
  store.selectNode({ id: r1.id, ring: 0, idx: 0 })
  store.roundNodes(2, 'fillet')
  ok('fillet corner', vertsOf(r1.id) > 4, `${vertsOf(r1.id)} vertices, area ${areaOf(r1.id).toFixed(2)} (200 - 0.86 expected)`)
  // the fillet replaced corner 0 by an arc, so the original corner 2 is now the second-last vertex
  store.selectNode({ id: r1.id, ring: 0, idx: vertsOf(r1.id) - 2 })
  store.roundNodes(2, 'chamfer')
  ok('chamfer corner', Math.abs(areaOf(r1.id) - (200 - 0.858 - 2)) < 0.05, `area ${areaOf(r1.id).toFixed(3)}`)

  // remove a segment of an open line, then join the pieces back
  let ln = store.addLine([[o[0], o[1] + 20], [o[0] + 10, o[1] + 20], [o[0] + 20, o[1] + 25], [o[0] + 30, o[1] + 20]])!
  store.selectSegment({ id: ln.id, ring: 0, idx: 1 })
  const nLines0 = p.lines.length
  store.removeSegments()
  ok('remove segment splits the line', p.lines.length === nLines0 + 1 && store.selected.lines.length === 2, `${store.selected.lines.map((l) => l.pts.length).join('+')} vertices`)
  store.joinSelected()
  ok('join bridges the gap', store.selected.lines.length === 1 && store.selected.lines[0].pts.length === 4)
  ln = store.selected.lines[0]
  store.selectNode({ id: ln.id, ring: 0, idx: 2 })
  store.disconnectAtNodes()
  ok('disconnect at node', store.selected.lines.length === 2, store.selected.lines.map((l) => l.pts.length).join('+'))
  store.joinSelected()
  ln = store.selected.lines[0]
  ok('join coincident ends merges the node', ln.pts.length === 4, `${ln.pts.length} vertices`)
  store.joinSelected() // single open line: closes
  ok('join on one line closes it', store.selected.polys.length === 1)
  store.openSelected()
  ok('open polygon into a line', store.selected.lines.length === 1 && store.selected.lines[0].pts.length === 5)

  // polygon: remove a segment opens it, scissors on a ring opens it
  const r2 = store.addShape(R(40, 0, 10, 10))!
  store.selectSegment({ id: r2.id, ring: 0, idx: 0 })
  store.removeSegments()
  ok('remove segment of a polygon opens it', store.selected.lines.length === 1 && store.selected.lines[0].pts.length === 4)
  const r3 = store.addShape(R(55, 0, 10, 10))!
  store.cutAt({ id: r3.id, ring: 0, idx: 1 }, 0.5)
  ok('scissors on a polygon', store.selected.lines.length === 1 && store.selected.lines[0].pts.length === 6)

  // pathfinder
  const pf = (op: 'unite' | 'subtract' | 'intersect' | 'exclude' | 'divide'): { n: number; area: number } => {
    const a = store.addShape(R(0, 40, 10, 10))!
    const b = store.addShape(R(5, 45, 10, 10))!
    store.setSelection([{ kind: 'poly', id: a.id }, { kind: 'poly', id: b.id }])
    store.pathfinderOp(op)
    const res = store.selected.polys
    const area = res.reduce((s, x) => s + areaOf(x.id), 0)
    store.removeSelected()
    return { n: res.length, area }
  }
  const u = pf('unite'); ok('pathfinder unite', u.n === 1 && Math.abs(u.area - 175) < 0.01, `${u.n} · ${u.area.toFixed(2)} mm²`)
  const s = pf('subtract'); ok('pathfinder subtract', s.n === 1 && Math.abs(s.area - 75) < 0.01, `${s.n} · ${s.area.toFixed(2)}`)
  const i = pf('intersect'); ok('pathfinder intersect', i.n === 1 && Math.abs(i.area - 25) < 0.01, `${i.n} · ${i.area.toFixed(2)}`)
  const x = pf('exclude'); ok('pathfinder exclude', x.n === 2 && Math.abs(x.area - 150) < 0.01, `${x.n} · ${x.area.toFixed(2)}`)
  const d = pf('divide'); ok('pathfinder divide', d.n === 3 && Math.abs(d.area - 175) < 0.01, `${d.n} · ${d.area.toFixed(2)}`)

  // offset, simplify, smooth, outline, knife
  const r4 = store.addShape(R(20, 40, 10, 10))!
  store.setSelection([{ kind: 'poly', id: r4.id }])
  store.offsetSelected(1, 'mitre')
  ok('offset polygon', Math.abs(areaOf(lastPoly().id) - 144) < 0.05, `${areaOf(lastPoly().id).toFixed(2)} mm² (144 expected)`)
  store.setSelection([{ kind: 'poly', id: r4.id }])
  store.smoothSelected(2)
  ok('smooth', vertsOf(r4.id) === 16, `${vertsOf(r4.id)} vertices`)
  store.simplifySelected(0.5)
  ok('simplify', vertsOf(r4.id) < 16, `${vertsOf(r4.id)} vertices`)
  const l2 = store.addLine([[o[0] + 40, o[1] + 40], [o[0] + 60, o[1] + 40]])!
  store.setSelection([{ kind: 'line', id: l2.id }])
  store.outlineSelected(1)
  ok('outline stroke', store.selected.polys.length === 1 && Math.abs(areaOf(store.selected.polys[0].id) - (20 + Math.PI * 0.25)) < 0.05, `${areaOf(store.selected.polys[0].id).toFixed(3)} mm²`)
  const r5 = store.addShape(R(70, 40, 10, 10))!
  store.setSelection([{ kind: 'poly', id: r5.id }])
  store.knife([o[0] + 75, o[1] + 35], [o[0] + 75, o[1] + 55])
  ok('knife slices a polygon', store.selected.polys.length === 2, store.selected.polys.map((q) => areaOf(q.id).toFixed(1)).join(' + '))
  // segment length / angle
  const l3 = store.addLine([[o[0] + 90, o[1] + 40], [o[0] + 100, o[1] + 40]])!
  store.setSegment({ id: l3.id, ring: 0, idx: 0 }, { angleDeg: 90 })
  store.setSegment({ id: l3.id, ring: 0, idx: 0 }, { lengthMm: 5 })
  const si = store.segmentInfo({ id: l3.id, ring: 0, idx: 0 })!
  ok('segment length and angle', Math.abs(si.lengthMm - 5) < 1e-6 && Math.abs(si.angleDeg - 90) < 1e-6, `${si.lengthMm.toFixed(3)} mm at ${si.angleDeg.toFixed(2)}°`)
  // undo restores
  const before = p.polys.length
  store.undo()
  ok('undo', store.project!.lines.find((l) => l.id === l3.id) !== undefined && store.project!.polys.length === before)

  // ---- pointer interactions
  canvas.value?.zoomTo(o[0] + 40, o[1] + 25, 12)
  store.clearSelection()
  await nextTick()
  const svg = canvas.value!.svgEl as SVGSVGElement
  const S = (q: [number, number]): [number, number] => canvas.value!.mmToScreen(q)
  const ev = (type: string, target: Element, xy: [number, number], extra: PointerEventInit = {}): void => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: xy[0], clientY: xy[1], pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, ...extra }))
  }
  const q = (sel: string): Element => svg.querySelector(sel) as Element
  const r6 = store.addShape(R(0, 60, 16, 10))!
  store.tool = 'node'
  await nextTick()
  // drag-box around the two left vertices
  ev('pointerdown', svg, S([o[0] - 2, o[1] + 58]))
  ev('pointermove', svg, S([o[0] + 2, o[1] + 72]))
  ev('pointerup', svg, S([o[0] + 2, o[1] + 72]))
  await nextTick()
  ok('node marquee', store.nodeSel.length === 2, `${store.nodeSel.length} nodes`)
  // drag one vertex: both selected move together
  const v0 = q(`[data-kind="vertex"][data-oid="${r6.id}"][data-idx="0"]`)
  ev('pointerdown', v0, S([o[0], o[1] + 60]), { altKey: true })
  ev('pointermove', svg, S([o[0] - 3, o[1] + 60]), { altKey: true })
  ev('pointerup', svg, S([o[0] - 3, o[1] + 60]), { altKey: true })
  await nextTick()
  ok('drag selected nodes', Math.abs(areaOf(r6.id) - 190) < 0.05, `${areaOf(r6.id).toFixed(2)} mm² (190 expected)`)
  // click the midpoint handle of the top edge: inserts a node
  const nv = vertsOf(r6.id)
  const mid = q(`[data-kind="mid"][data-oid="${r6.id}"][data-idx="0"]`)
  ok('midpoint handles shown', !!mid)
  if (mid) {
    const [mx, my] = [Number(mid.getAttribute('x')) + Number(mid.getAttribute('width')) / 2, Number(mid.getAttribute('y')) + Number(mid.getAttribute('height')) / 2]
    ev('pointerdown', mid, S([mx, my]))
    ev('pointerup', svg, S([mx, my]))
    await nextTick()
    ok('click midpoint adds a node', vertsOf(r6.id) === nv + 1, `${nv} -> ${vertsOf(r6.id)}`)
  }
  // Delete key on a clicked segment
  const seg = q(`[data-kind="seg"][data-oid="${r6.id}"][data-idx="2"]`)
  if (seg) {
    ev('pointerdown', seg, S([o[0] + 10, o[1] + 70]))
    ev('pointerup', svg, S([o[0] + 10, o[1] + 70]))
    await nextTick()
    ok('click segment selects it', store.segSel.length === 1 && store.nodeSel.length === 2)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await nextTick()
    ok('Delete removes the segment (polygon opens)', store.selected.lines.length === 1)
  }
  // pen: three clicks and a click on the first point closes a polygon
  store.clearSelection()
  store.tool = 'pen'
  await nextTick()
  const nPolys = p.polys.length
  for (const pt of [[30, 60], [40, 60], [40, 70], [30, 60]] as [number, number][]) {
    ev('pointerdown', svg, S([o[0] + pt[0], o[1] + pt[1]]), { altKey: true })
    ev('pointerup', svg, S([o[0] + pt[0], o[1] + pt[1]]), { altKey: true })
    await nextTick()
  }
  ok('pen closes a polygon on the first point', store.project!.polys.length === nPolys + 1 && Math.abs(areaOf(store.project!.polys[store.project!.polys.length - 1].id) - 50) < 0.05)
  // rectangle tool drag with shift = square
  store.tool = 'rect'
  await nextTick()
  ev('pointerdown', svg, S([o[0] + 50, o[1] + 60]), { altKey: true })
  ev('pointermove', svg, S([o[0] + 58, o[1] + 64]), { altKey: true, shiftKey: true })
  ev('pointerup', svg, S([o[0] + 58, o[1] + 64]), { altKey: true, shiftKey: true })
  await nextTick()
  const sq = store.project!.polys[store.project!.polys.length - 1]
  ok('rectangle tool (⇧ square, ⌥ from centre)', Math.abs(areaOf(sq.id) - 256) < 0.05, `${areaOf(sq.id).toFixed(2)} mm² (16 x 16 expected)`)
  // knife drag across the square with nothing selected
  store.clearSelection()
  store.tool = 'knife'
  await nextTick()
  const np0 = store.project!.polys.length
  ev('pointerdown', svg, S([o[0] + 54, o[1] + 49]), { altKey: true })
  ev('pointermove', svg, S([o[0] + 54, o[1] + 71]), { altKey: true })
  ev('pointerup', svg, S([o[0] + 54, o[1] + 71]), { altKey: true })
  await nextTick()
  const halves = store.selected.polys.map((x) => areaOf(x.id))
  ok('knife tool drag', !store.project!.polys.some((x) => x.id === sq.id) && store.project!.polys.length > np0 && halves.some((a) => Math.abs(a - 192) < 0.05), `${np0} -> ${store.project!.polys.length} polygons, pieces ${halves.map((a) => a.toFixed(0)).join(' + ')}`)
  // the largest generated polygon: handles suppressed at full view, available once zoomed in
  const big = [...store.project!.polys].sort((a, b) => b.rings.reduce((n, r) => n + r.length, 0) - a.rings.reduce((n, r) => n + r.length, 0))[0]
  const bigN = big.rings.reduce((n, r) => n + r.length, 0)
  store.tool = 'node'
  store.setSelection([{ kind: 'poly', id: big.id }])
  canvas.value?.fitView()
  await nextTick()
  const atFit = svg.querySelectorAll(`[data-kind="vertex"][data-oid="${big.id}"]`).length
  const v0m = tf.toMm(big.rings[0][0])
  let t0 = performance.now()
  canvas.value?.zoomTo(v0m[0], v0m[1], 25)
  await nextTick()
  const zoomMs = performance.now() - t0
  const inView = svg.querySelectorAll(`[data-kind="vertex"][data-oid="${big.id}"]`).length
  const hv = svg.querySelector(`[data-kind="vertex"][data-oid="${big.id}"][data-idx="0"][data-ring="0"]`)
  if (hv) {
    ev('pointerdown', hv, S(v0m))
    ev('pointerup', svg, S(v0m))
    await nextTick()
  }
  ok(`big polygon (${big.cls}, ${bigN} vertices)`, inView > 0 && inView <= 4000 && (bigN <= 4000 || atFit === 0) && store.nodeSel.length === 1, `${atFit} handles at fit, ${inView} in view at zoom 25 (${zoomMs.toFixed(0)} ms), node selected ${store.nodeSel.length}`)
  t0 = performance.now()
  for (let k = 0; k < 10; k++) {
    store.beginTransform()
    store.moveNodesTo(0.05 * k, 0)
    store.endTransform(true)
    await nextTick()
  }
  ok('drag a node of the big polygon', true, `${((performance.now() - t0) / 10).toFixed(1)} ms per step`)
  // leave a node-editing state on screen for the screenshot
  store.tool = 'node'
  store.setSelection([{ kind: 'poly', id: r1.id }, { kind: 'line', id: lastLine().id }])
  store.selectNode({ id: r1.id, ring: 0, idx: 1 }, 'add')
  store.selectSegment({ id: r1.id, ring: 0, idx: 3 }, 'add')
  canvas.value?.zoomTo(o[0] + 30, o[1] + 30, 9)
  await nextTick()
  await new Promise((r) => setTimeout(r, 500))
  if (dir) await window.api.autotestShot(dir + '/screenshot_paths.png')
  const fails = out.filter((l) => l.startsWith('FAIL')).length
  for (const l of out) console.log('AUTOTEST path:', l)
  console.log(`AUTOTEST path: ${out.length - fails}/${out.length} passed`)
}

</script>

<template>
  <div class="app">
    <Toolbar @fit="canvas?.fitView()" />
    <aside class="panel left">
      <div class="tabs">
        <button :class="{ active: tab === 'airport' }" @click="tab = 'airport'">Airport</button>
        <button :class="{ active: tab === 'sources' }" @click="tab = 'sources'">Sources</button>
        <button :class="{ active: tab === 'layers' }" @click="tab = 'layers'">Layers</button>
        <button :class="{ active: tab === 'placement' }" @click="tab = 'placement'">LEDs</button>
        <button :class="{ active: tab === 'runways' }" @click="tab = 'runways'">Runways</button>
        <button :class="{ active: tab === 'pcb' }" @click="tab = 'pcb'">PCB</button>
      </div>
      <AirportPanel v-show="tab === 'airport'" />
      <SourcesPanel v-show="tab === 'sources'" />
      <LayersPanel v-show="tab === 'layers'" />
      <PlacementPanel v-show="tab === 'placement'" />
      <RunwayPanel v-show="tab === 'runways'" />
      <PcbPanel v-if="tab === 'pcb'" />
    </aside>
    <main class="main">
      <EditorCanvas ref="canvas" />
    </main>
    <aside class="panel right">
      <Inspector />
    </aside>
    <ContextMenu />
    <BusyOverlay />
  </div>
</template>

<style scoped>
.app { display: grid; grid-template-columns: 300px 1fr 290px; grid-template-rows: 42px 1fr; height: 100%; }
.main { min-width: 0; min-height: 0; }
</style>

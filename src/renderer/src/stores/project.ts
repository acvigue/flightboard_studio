import { defineStore } from 'pinia'
import { computed, nextTick, reactive, ref, shallowRef, toRaw, triggerRef, watch } from 'vue'
import type { Airport } from '../core/airports'
import { frameLLBox, DEFAULT_BUILD, type BuildOptions } from '../core/build'
import { fetchAeroway, fetchBuildings, fetchLandside, findAerodrome, type OsmElement } from '../core/osm'
import { sourcesOf } from '../core/sources'
import { fetchFaa, type FaaData } from '../core/faa'
import { utmFor } from '../core/geo'
import { makeTransform, type BoardTransform } from '../core/transform'
import type { GateNode } from '../core/place'
import { loadFonts, type Fonts } from '../core/export'
import { compute, CancelledError } from '../services/compute'
import { pcbJobLeds, pcbName } from '../core/pcbjob'
import { tooClosePairs } from '../core/spacing'
import { buildFirmwareBoard } from '../core/fwboard'
import { backArtExtent, mirrorBackArt as mirrorArt } from '../core/backart'
import type { PcbChainStat, PcbCheck, PcbDescribe, PcbExportResult, PcbRoute, PcbRouteResult, PcbRouteUpdate } from '../core/pcbtypes'
import { runwayEndMarkings, designatorLabels, endChevrons, type ChevronOpts, type EndChevronEnd } from '../core/markings'
import * as ed from '../core/edit'
import * as gm from '../core/geom'
import * as pa from '../core/path'
import {
  DEFAULT_HATCH, DEFAULT_SNAP, DEFAULT_SOURCES, DEFAULT_RUNWAY_MARKINGS, DEFAULT_END_CHEVRON, LINE_WIDTH, newId, type ArtLayer, type RunwayMarkingStyle, type BackArt, type PcbBlockPose, type PcbSettings,
  type HatchSpec, type Label, type Led, type LedClass, type LedSize, type LineClass, type LineFeature, type PolyFeature, type Project, type Pt, type SnapSettings, type SourceSpec
} from '../core/model'

export type Tool = 'select' | 'pan' | 'addLed' | 'addLine' | 'addPoly' | 'addLabel' | 'rotate' | 'measure' | 'node' | 'pen' | 'scissors' | 'knife' | 'rect' | 'ellipse' | 'star'
export type SelKind = 'led' | 'label' | 'line' | 'poly'
export interface Selection {
  kind: SelKind
  id: string
}
export type Item = Led | Label | LineFeature | PolyFeature

const MAX_UNDO = 80
const SNAP_KEY = 'flightboard.snap'

export const useProject = defineStore('project', () => {
  // The project is a shallow ref: geometry arrays are plain objects (no proxy cost on 100k coordinates).
  // Mutations go through the actions below, which bump the matching revision so views re-render precisely.
  const project = shallowRef<Project | null>(null)
  const rev = reactive({ leds: 0, lines: 0, polys: 0, labels: 0, board: 0, vis: 0, sel: 0, pcb: 0, back: 0 })
  const version = computed(() => rev.leds + rev.lines + rev.polys + rev.labels + rev.board + rev.vis + rev.back)
  let projectSerial = 0   // changes whenever a different project object is loaded (keys the generator job)
  function bumpAll(): void {
    rev.leds++; rev.lines++; rev.polys++; rev.labels++; rev.board++; rev.vis++; rev.pcb++; rev.back++
    triggerRef(project)
  }
  const gates = ref<GateNode[]>([])
  const selection = ref<Selection[]>([])
  const tool = ref<Tool>('select')
  const addPreset = reactive<{ cls: LedClass; size: LedSize; lineCls: LineClass; layer: ArtLayer; polyFill: 'none' | 'solid' | 'hatch'; hatch: HatchSpec; lineWidthMm: number }>({
    cls: 'taxiway', size: 1.5, lineCls: 'custom', layer: 'silk', polyFill: 'none', hatch: { ...DEFAULT_HATCH }, lineWidthMm: 0.15
  })
  const shapeOpts = reactive({ cornerMm: 0, sides: 6, inner: 0, filletMm: 1.0, offsetMm: 0.5, simplifyMm: 0.05 })
  const snap = reactive<SnapSettings>({ ...DEFAULT_SNAP, ...(JSON.parse(localStorage.getItem(SNAP_KEY) ?? '{}') as Partial<SnapSettings>) })
  function saveSnap(): void {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap))
  }
  // data sources: the project carries its own list; new builds start from the user's defaults (localStorage)
  const SOURCES_KEY = 'flightboard.sources'
  const defaultSources = ref<SourceSpec[]>(JSON.parse(localStorage.getItem(SOURCES_KEY) ?? 'null') ?? DEFAULT_SOURCES.map((s) => ({ ...s, style: { ...s.style } })))
  const landsideRaw = ref<OsmElement[]>([])
  const landsideAirport = ref<{ icao: string; lat: number; lon: number } | null>(null)
  const sources = computed<SourceSpec[]>(() => {
    void rev.vis
    return project.value ? sourcesOf(project.value) : defaultSources.value
  })
  const fonts = ref<Fonts | null>(null)
  loadFonts().then((f) => (fonts.value = f)).catch(() => undefined)
  const ctxMenu = ref<{ x: number; y: number } | null>(null)
  const log = ref<string[]>([])
  const busy = ref(false)
  const filePath = ref<string | null>(null)
  const dirty = ref(false)
  const buildOpts = reactive<BuildOptions & { useFaa: boolean; landside: boolean }>({ ...DEFAULT_BUILD, useFaa: true, landside: true })
  // undo entries: the project as JSON without the imported back art (megabytes, replaced as a whole on every change),
  // which is kept by reference instead
  interface UndoEntry { s: string; back?: BackArt }
  const undoStack: UndoEntry[] = []
  const redoStack: UndoEntry[] = []
  const undoDepth = ref(0)
  const redoDepth = ref(0)

  const tf = computed<BoardTransform | null>(() => {
    void rev.board
    return project.value ? makeTransform(project.value.board, project.value.frame) : null
  })

  // ---------------------------------------------------------------- selection
  const selectedIds = computed(() => {
    void rev.sel
    return new Set(selection.value.map((s) => s.id))
  })
  const selected = computed(() => {
    void version.value
    void rev.sel
    const p = project.value
    const out = { leds: [] as Led[], labels: [] as Label[], lines: [] as LineFeature[], polys: [] as PolyFeature[], count: 0, single: null as Item | null, singleKind: null as SelKind | null }
    if (!p) return out
    const ids = new Set(selection.value.map((s) => s.id))
    out.leds = p.leds.filter((l) => ids.has(l.id))
    out.labels = p.labels.filter((l) => ids.has(l.id))
    out.lines = p.lines.filter((l) => ids.has(l.id))
    out.polys = p.polys.filter((l) => ids.has(l.id))
    out.count = out.leds.length + out.labels.length + out.lines.length + out.polys.length
    if (out.count === 1) {
      if (out.leds.length) { out.single = out.leds[0]; out.singleKind = 'led' }
      else if (out.labels.length) { out.single = out.labels[0]; out.singleKind = 'label' }
      else if (out.lines.length) { out.single = out.lines[0]; out.singleKind = 'line' }
      else { out.single = out.polys[0]; out.singleKind = 'poly' }
    }
    return out
  })
  function isSelected(id: string): boolean {
    return selectedIds.value.has(id)
  }
  function setSelection(list: Selection[]): void {
    selection.value = list
    const ids = new Set(list.map((s) => s.id))
    if (nodeSel.value.some((r) => !ids.has(r.id))) nodeSel.value = nodeSel.value.filter((r) => ids.has(r.id))
    if (segSel.value.some((r) => !ids.has(r.id))) segSel.value = segSel.value.filter((r) => ids.has(r.id))
    rev.sel++
  }
  function select(kind: SelKind, id: string, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    if (mode === 'replace') setSelection([{ kind, id }])
    else if (mode === 'add') {
      if (!isSelected(id)) setSelection([...selection.value, { kind, id }])
    } else setSelection(isSelected(id) ? selection.value.filter((s) => s.id !== id) : [...selection.value, { kind, id }])
  }
  function clearSelection(): void {
    if (selection.value.length) setSelection([])
  }
  function selectAll(kinds: SelKind[] = ['led', 'label']): void {
    const p = project.value
    if (!p) return
    const list: Selection[] = []
    if (kinds.includes('led')) for (const l of p.leds) list.push({ kind: 'led', id: l.id })
    if (kinds.includes('label')) for (const l of p.labels) list.push({ kind: 'label', id: l.id })
    if (kinds.includes('line')) for (const l of p.lines) list.push({ kind: 'line', id: l.id })
    if (kinds.includes('poly')) for (const l of p.polys) list.push({ kind: 'poly', id: l.id })
    setSelection(list)
  }
  function itemBounds(kind: SelKind, item: Item): ed.Bounds | null {
    const t = tf.value
    if (!t) return null
    if (kind === 'led') return ed.ledBounds(item as Led, t)
    if (kind === 'label') return ed.labelBounds(item as Label, t, fonts.value)
    if (kind === 'line') return ed.lineBounds(item as LineFeature, t)
    return ed.polyBounds(item as PolyFeature, t)
  }
  const selectionBounds = computed<ed.Bounds | null>(() => {
    const s = selected.value
    const bs: ed.Bounds[] = []
    for (const l of s.leds) bs.push(itemBounds('led', l)!)
    for (const l of s.labels) bs.push(itemBounds('label', l)!)
    for (const l of s.lines) bs.push(itemBounds('line', l)!)
    for (const l of s.polys) bs.push(itemBounds('poly', l)!)
    return ed.unionBounds(bs.filter(Boolean))
  })

  function say(s: string): void {
    log.value.push(s)
    if (log.value.length > 400) log.value.splice(0, log.value.length - 400)
  }

  // ---------------------------------------------------------------- long-running tasks (busy overlay)
  // Heavy work runs in the compute worker; the page shows a fullscreen overlay (it blocks input at once and fades in
  // after a short delay, so quick tasks do not flash) with a live status log, elapsed time and Cancel.
  const task = reactive({ active: false, title: '', lines: [] as string[], started: 0, error: '', cancellable: false })
  let cancelTask: (() => void) | null = null
  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
  function taskLog(s: string): void {
    task.lines.push(s)
    if (task.lines.length > 500) task.lines.splice(0, task.lines.length - 500)
    say(s)
  }
  /** Run `fn` as the one long-running task. Returns undefined when busy, cancelled or failed (the overlay shows why). */
  async function runTask<T>(title: string, fn: (log: (s: string) => void) => Promise<T>): Promise<T | undefined> {
    if (task.active) {
      say(`busy with "${task.title}": "${title}" ignored`)
      return undefined
    }
    Object.assign(task, { active: true, title, lines: [], started: performance.now(), error: '', cancellable: false })
    busy.value = true
    await nextTick()
    await frame() // let the overlay take the input before any main-thread work starts
    try {
      const r = await fn(taskLog)
      // keep the overlay while the result renders (the heavy Vue patch happens on this tick)
      await nextTick()
      await frame()
      await frame()
      task.active = false
      return r
    } catch (e) {
      if (e instanceof CancelledError) {
        say(`${title}: cancelled`)
        task.active = false
      } else {
        const msg = String((e as Error)?.message ?? e)
        say(`ERROR ${title}: ${msg}`)
        console.error(e)
        task.error = msg // the overlay stays open with the log until dismissed
      }
      return undefined
    } finally {
      cancelTask = null
      task.cancellable = false
      busy.value = false
    }
  }
  /** Worker call inside a task: progress goes to the overlay log, Cancel terminates the worker. */
  function work<K extends Parameters<typeof compute>[0]>(op: K, args: Parameters<typeof compute<K>>[1], log: (s: string) => void): ReturnType<typeof compute<K>>['promise'] {
    const c = compute(op, args, log)
    cancelTask = c.cancel
    task.cancellable = true
    return c.promise.finally(() => {
      if (cancelTask === c.cancel) {
        cancelTask = null
        task.cancellable = false
      }
    })
  }
  function cancelCurrentTask(): void {
    cancelTask?.()
  }
  function dismissTask(): void {
    task.active = false
    task.error = ''
  }
  /** Plain data for the worker (strips Vue proxies from nested settings). */
  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(toRaw(v)))

  // ---------------------------------------------------------------- undo
  function entry(): UndoEntry {
    const { backArt, ...rest } = project.value!
    return { s: JSON.stringify(rest), back: backArt }
  }
  function snapshot(): void {
    if (!project.value) return
    undoStack.push(entry())
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    redoStack.length = 0
    undoDepth.value = undoStack.length
    redoDepth.value = 0
    dirty.value = true
  }
  function restore(e: UndoEntry): void {
    project.value = JSON.parse(e.s)
    if (e.back) project.value!.backArt = e.back
    const ids = new Set([...project.value!.leds, ...project.value!.labels, ...project.value!.lines, ...project.value!.polys].map((x) => x.id))
    setSelection(selection.value.filter((x) => ids.has(x.id)))
    bumpAll()
  }
  function undo(): void {
    const s = undoStack.pop()
    if (!s || !project.value) return
    redoStack.push(entry())
    restore(s)
    undoDepth.value = undoStack.length
    redoDepth.value = redoStack.length
  }
  function redo(): void {
    const s = redoStack.pop()
    if (!s || !project.value) return
    undoStack.push(entry())
    restore(s)
    undoDepth.value = undoStack.length
    redoDepth.value = redoStack.length
  }

  // ---------------------------------------------------------------- build from public data
  async function buildFromAirport(a: Airport, force = false): Promise<void> {
    log.value = []
    const icao = a.icao || a.ident
    await runTask(`Building ${a.name} (${icao})`, async (say) => {
      say(`Building ${a.name} (${icao})`)
      const osm = await fetchAeroway(icao, a.lat, a.lon, 9000, say, force)
      let faa: FaaData | null = null
      if (buildOpts.useFaa) {
        try {
          faa = await fetchFaa(icao, say, force)
        } catch (e) {
          say('FAA fetch failed: ' + String(e))
        }
      }
      const specs = plain(defaultSources.value)
      const opts = plain(buildOpts)
      // first pass only to learn the map frame, which bounds the buildings and landside downloads
      const first = await work('build', { airport: plain(a), osm, faa, opts, specs }, () => undefined)
      const prj = utmFor(a.lat, a.lon)
      const bb = frameLLBox(first.project.frame, prj)
      try {
        const bld = await fetchBuildings(icao, findAerodrome(osm.aero, a.lat, a.lon), bb, say, force)
        osm.aero = [...osm.aero.filter((e) => !(e.tags?.building && !e.tags?.aeroway)), ...bld]
      } catch (e) {
        say('buildings fetch failed: ' + String(e))
      }
      if (buildOpts.landside) {
        try {
          osm.landside = await fetchLandside(icao, bb, specs, say, force)
        } catch (e) {
          say('landside fetch failed: ' + String(e))
        }
      }
      const res = await work('build', { airport: plain(a), osm, faa, opts, specs }, say)
      const built = res.project
      const g = built.gates ?? []
      delete built.gates
      // LEDs and labels on the new project before it is shown
      const placed = await work('place', { project: built, gates: g }, say)
      built.leds = placed.leds
      const lab = await work('labels', { project: built }, say)
      built.labels = lab.labels
      built.lines = [...built.lines.filter((l) => l.sub !== 'arrow'), lab.northArrow]
      say(`${built.labels.length} labels (${lab.result.moved} moved for collisions${lab.result.dropped.length ? `, dropped: ${lab.result.dropped.join(', ')}` : ''})`)
      say('drawing the board…')
      landsideRaw.value = osm.landside
      landsideAirport.value = { icao, lat: a.lat, lon: a.lon }
      gates.value = g
      loadProject(built, null)
      say(`Board ${built.board.widthMm} x ${built.board.heightMm} mm, scale 1:${Math.round(tf.value!.scale)}`)
      dirty.value = true
    })
  }

  // ---------------------------------------------------------------- automatic placement, labels, markings
  async function placeLeds(): Promise<void> {
    if (!project.value) return
    await runTask('Placing LEDs', async (say) => {
      const p = project.value!
      const r = await work('place', { project: p, gates: toRaw(gates.value) }, say)
      snapshot()
      p.leds = r.leds
      rev.leds++
      setSelection(selection.value.filter((s) => s.kind !== 'led'))
    })
  }
  async function generateLabelsNow(): Promise<void> {
    if (!project.value) return
    await runTask('Regenerating labels', async (say) => {
      const p = project.value!
      const r = await work('labels', { project: p }, say)
      snapshot()
      p.labels = r.labels
      p.lines = [...p.lines.filter((l) => l.sub !== 'arrow'), r.northArrow]
      rev.labels++
      rev.lines++
      say(`${p.labels.length} labels (${r.result.moved} moved for collisions${r.result.dropped.length ? `, dropped: ${r.result.dropped.join(', ')}` : ''})`)
      setSelection(selection.value.filter((s) => s.kind !== 'label'))
    })
  }
  async function resolveCollisions(): Promise<void> {
    if (!project.value) return
    await runTask('Resolving label collisions', async (say) => {
      const p = project.value!
      const r = await work('resolve', { project: p, dropUnplaceable: false }, say)
      snapshot()
      p.labels = r.labels
      rev.labels++
      const u = r.result.unresolved
      say(`collisions: ${r.result.moved} labels moved${u.length ? `, ${u.length} still overlap (${u.slice(0, 8).join(', ')}${u.length > 8 ? '…' : ''})` : ''}`)
    })
  }
  function addRunwayMarkings(axisId: string, opts: ChevronOpts): void {
    const p = project.value
    const axis = p?.lines.find((l) => l.id === axisId)
    if (!p || !axis) return
    snapshot()
    const added = runwayEndMarkings(axis, opts)
    p.lines.push(...added)
    rev.lines++
    say(`${added.length} ${opts.kind} added to ${axis.name} end ${opts.end + 1}`)
  }
  /** The project's runway end style with defaults filled in. */
  const runwayStyle = computed<RunwayMarkingStyle>(() => {
    void rev.lines
    void rev.board
    const r = project.value?.runwayMarkings
    return { ...DEFAULT_RUNWAY_MARKINGS, ...(r ?? {}), chevron: { ...DEFAULT_END_CHEVRON, ...(r?.chevron ?? {}) } }
  })
  const runwayResult = ref<null | { style: string; ends: EndChevronEnd[]; removed: { stopways: number; designators: number; runwayNames: number; chevronLines: number; pavementM2: number }; added: { chevronLines: number; designators: number } }>(null)
  /** Set the runway end style and regenerate the end markings. 'chevrons': double chevrons past each end with the
   *  designator inside; the on-runway designators go, and (as set) the stopway outlines and the runway name labels.
   *  'classic': the chevrons go and the designators return to the runway (removed stopways need a rebuild or undo). */
  function applyRunwayStyle(style: RunwayMarkingStyle): void {
    const p = project.value
    const t = tf.value
    const f = fonts.value
    if (!p || !t || !f) return
    snapshot()
    p.runwayMarkings = JSON.parse(JSON.stringify(style)) as RunwayMarkingStyle
    const nLines = p.lines.length
    p.lines = p.lines.filter((l) => l.src !== 'rwy-end')
    const removed = { stopways: 0, designators: 0, runwayNames: 0, chevronLines: nLines - p.lines.length, pavementM2: 0 }
    const added = { chevronLines: 0, designators: 0 }
    let ends: EndChevronEnd[] = []
    if (style.endStyle === 'chevrons') {
      removed.designators = p.labels.filter((l) => l.kind === 'designator' && l.src !== 'rwy-end').length
      p.labels = p.labels.filter((l) => l.kind !== 'designator')
      if (style.removeRunwayNames) {
        removed.runwayNames = p.labels.filter((l) => l.kind === 'runway').length
        p.labels = p.labels.filter((l) => l.kind !== 'runway')
      }
      if (style.removeStopways) {
        // the stopway outlines, and their area in the pavement (the build unions FAA stopways into it, so the box
        // outline would stay); 1 m extra so no sliver is left along the simplified pavement edge
        const stop = p.polys.filter((x) => x.cls === 'stopway')
        removed.stopways = stop.length
        if (stop.length) {
          const cut = gm.buffer(gm.union(stop.map((x) => gm.polygon(x.rings))), 1.0, { join: 'mitre' })
          const next: PolyFeature[] = []
          for (const x of p.polys) {
            if (x.cls === 'stopway') continue
            const g = x.cls === 'pavement' ? gm.polygon(x.rings) : null
            if (!g || !g.intersects(cut)) { next.push(x); continue }
            const d = g.difference(cut)
            removed.pavementM2 += g.getArea() - d.getArea()
            gm.polygonsOf(d).filter((q) => q.getArea() > 50).forEach((q, i) => next.push({ ...x, id: i ? newId('p') : x.id, rings: gm.ringsOf(q) }))
          }
          p.polys = next
          removed.pavementM2 = Math.round(removed.pavementM2)
        }
      }
      const r = endChevrons(p, t, f, style.chevron)
      p.lines.push(...r.lines)
      p.labels.push(...r.labels)
      added.chevronLines = r.lines.length
      added.designators = r.labels.length
      ends = r.ends
    } else {
      p.labels = p.labels.filter((l) => l.src !== 'rwy-end')
      if (!p.labels.some((l) => l.kind === 'designator'))
        for (const a of p.lines.filter((l) => l.cls === 'runway_cl' && l.sub === 'axis')) {
          const d = designatorLabels(a, t)
          p.labels.push(...d)
          added.designators += d.length
        }
    }
    rev.lines++
    rev.labels++
    rev.polys++
    runwayResult.value = { style: style.endStyle, ends, removed, added }
    say(`runway ends: ${style.endStyle}; removed ${removed.stopways} stopway outlines (${removed.pavementM2} m² cut from the pavement outline), ${removed.designators} designators, ${removed.runwayNames} runway name labels, ${removed.chevronLines} old chevron lines; added ${added.chevronLines} chevron lines and ${added.designators} designator labels${ends.some((e) => e.clipped) ? `; shrunk to fit the board: ${ends.filter((e) => e.clipped).map((e) => e.designator).join(', ')}` : ''}`)
  }
  function addDesignators(axisId: string): void {
    const p = project.value
    const t = tf.value
    const axis = p?.lines.find((l) => l.id === axisId)
    if (!p || !t || !axis) return
    snapshot()
    p.labels.push(...designatorLabels(axis, t))
    rev.labels++
  }

  // ---------------------------------------------------------------- data sources
  function updateSource(key: string, patch: Partial<SourceSpec>): void {
    const list = project.value ? sourcesOf(project.value) : defaultSources.value
    const s = list.find((x) => x.key === key)
    if (!s) return
    Object.assign(s, patch)
    if (project.value) {
      project.value.sources = list
      dirty.value = true
    }
    rev.vis++
  }
  function updateSourceStyle(key: string, patch: Partial<SourceSpec['style']>): void {
    const list = project.value ? sourcesOf(project.value) : defaultSources.value
    const s = list.find((x) => x.key === key)
    if (!s) return
    Object.assign(s.style, patch)
    if (project.value) project.value.sources = list
    rev.vis++
  }
  function addSource(spec: SourceSpec): void {
    const list = project.value ? sourcesOf(project.value) : defaultSources.value
    let key = spec.key.replace(/\W+/g, '_').toLowerCase() || 'source'
    while (list.some((x) => x.key === key)) key += '_2'
    list.push({ ...spec, key })
    if (project.value) project.value.sources = list
    rev.vis++
  }
  function removeSource(key: string): void {
    const list = (project.value ? sourcesOf(project.value) : defaultSources.value).filter((x) => x.key !== key)
    if (project.value) {
      project.value.sources = list
      snapshot()
      project.value.lines = project.value.lines.filter((l) => l.src !== key)
      project.value.polys = project.value.polys.filter((l) => l.src !== key)
      rev.lines++; rev.polys++
    } else defaultSources.value = list
    rev.vis++
  }
  function resetSources(): void {
    const list = DEFAULT_SOURCES.map((s) => ({ ...s, style: { ...s.style } }))
    if (project.value) project.value.sources = list
    else defaultSources.value = list
    rev.vis++
  }
  function saveSourcesAsDefault(): void {
    defaultSources.value = sources.value.map((s) => ({ ...s, style: { ...s.style } }))
    localStorage.setItem(SOURCES_KEY, JSON.stringify(defaultSources.value))
    say('sources saved as defaults for new boards')
  }
  /** Regenerate the features produced by the sources from the cached OSM elements (locked features are kept). */
  async function applySourcesCore(say: (s: string) => void): Promise<void> {
    const p = project.value!
    const specs = sourcesOf(p)
    const r = await work('sources', { project: { board: p.board, frame: p.frame, polys: p.polys.filter((x) => !x.src), aerodrome: p.aerodrome, sources: plain(specs) }, elements: toRaw(landsideRaw.value) }, say)
    snapshot()
    p.lines = [...p.lines.filter((l) => !l.src || l.locked), ...r.lines]
    p.polys = [...p.polys.filter((l) => !l.src || l.locked), ...r.polys]
    p.sources = specs
    rev.lines++; rev.polys++; rev.vis++
    say(`sources applied: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing matched'}`)
  }
  async function applySourcesNow(): Promise<void> {
    if (!project.value) return
    if (!landsideRaw.value.length) {
      say('no cached landside data for this board: use Fetch & apply')
      return
    }
    await runTask('Applying sources', applySourcesCore)
  }
  async function fetchAndApplySources(force = false): Promise<void> {
    if (!project.value) return
    await runTask(force ? 'Re-downloading the landside' : 'Fetching the landside', async (say) => {
      const p = project.value!
      const prj = utmFor(p.board.refLat, p.board.refLon)
      const bb = frameLLBox(p.frame, prj)
      landsideRaw.value = await fetchLandside(p.board.icao, bb, sourcesOf(p), say, force)
      landsideAirport.value = { icao: p.board.icao, lat: p.board.refLat, lon: p.board.refLon }
      await applySourcesCore(say)
    })
  }

  // ---------------------------------------------------------------- board
  function setBoard(patch: Partial<Project['board']>): void {
    if (!project.value) return
    snapshot()
    Object.assign(project.value.board, patch)
    rev.board++
  }

  // ---------------------------------------------------------------- single-item edits
  function updateLed(id: string, patch: Partial<Led>, commit = true): void {
    const l = project.value?.leds.find((x) => x.id === id)
    if (!l) return
    if (commit) snapshot()
    Object.assign(l, patch)
    rev.leds++
  }
  function addLedAt(posMm: Pt): Led | null {
    const t = tf.value
    if (!project.value || !t) return null
    snapshot()
    const led: Led = { id: newId('d'), cls: addPreset.cls, role: '', size: addPreset.size, pos: t.toM(posMm), rotDeg: 0, label: '', feature: '', locked: true }
    project.value.leds.push(led)
    rev.leds++
    select('led', led.id)
    return led
  }
  function updateLabel(id: string, patch: Partial<Label>, commit = true): void {
    const l = project.value?.labels.find((x) => x.id === id)
    if (!l) return
    if (commit) snapshot()
    Object.assign(l, patch)
    rev.labels++
  }
  function addLabelAt(posMm: Pt, text = 'LABEL'): Label | null {
    const t = tf.value
    if (!project.value || !t) return null
    snapshot()
    const lb: Label = { id: newId('t'), text, pos: t.toM(posMm), heightM: 2.0 / t.k, rotDeg: 0, layer: addPreset.layer, weight: 400, anchor: 'middle', kind: 'custom', locked: true }
    project.value.labels.push(lb)
    rev.labels++
    select('label', lb.id)
    return lb
  }
  function updateLine(id: string, patch: Partial<LineFeature>, commit = true): void {
    const l = project.value?.lines.find((x) => x.id === id)
    if (!l) return
    if (commit) snapshot()
    Object.assign(l, patch)
    rev.lines++
  }
  function addLine(ptsMm: Pt[]): LineFeature | null {
    const t = tf.value
    if (!project.value || !t || ptsMm.length < 2) return null
    snapshot()
    const l: LineFeature = { id: newId('l'), cls: addPreset.lineCls, layer: addPreset.layer, widthMm: addPreset.lineWidthMm, pts: ptsMm.map((p) => t.toM(p)), locked: true }
    project.value.lines.push(l)
    rev.lines++
    select('line', l.id)
    return l
  }
  function updatePoly(id: string, patch: Partial<PolyFeature>, commit = true): void {
    const l = project.value?.polys.find((x) => x.id === id)
    if (!l) return
    if (commit) snapshot()
    Object.assign(l, patch)
    rev.polys++
  }
  function addPoly(ptsMm: Pt[]): PolyFeature | null {
    const t = tf.value
    if (!project.value || !t || ptsMm.length < 3) return null
    snapshot()
    const poly: PolyFeature = { id: newId('p'), cls: 'custom', rings: [ptsMm.map((p) => t.toM(p))], layer: addPreset.layer, fill: addPreset.polyFill, hatch: { ...addPreset.hatch }, strokeMm: addPreset.lineWidthMm, locked: true }
    project.value.polys.push(poly)
    rev.polys++
    select('poly', poly.id)
    return poly
  }
  function setLayerVisible(key: string, on: boolean): void {
    if (!project.value) return
    project.value.layerVisibility[key] = on
    rev.vis++
  }
  function isVisible(key: string): boolean {
    void rev.vis
    return project.value?.layerVisibility[key] !== false
  }

  // ---------------------------------------------------------------- selection edits (mm deltas; positions kept in metres)
  interface Orig {
    leds: Map<string, Pt>
    labels: Map<string, Pt>
    lines: Map<string, Pt[]>
    polys: Map<string, Pt[][]>
    rot: Map<string, number>
  }
  let orig: Orig | null = null
  /** Bump only the layers a selection touches (dragging one LED must not re-derive 12k road lines per frame). */
  function bumpFor(s: { leds: unknown[]; labels: unknown[]; lines: unknown[]; polys: unknown[] }): void {
    if (s.leds.length) rev.leds++
    if (s.labels.length) rev.labels++
    if (s.lines.length) rev.lines++
    if (s.polys.length) rev.polys++
  }
  function captureOrig(): void {
    const s = selected.value
    orig = {
      leds: new Map(s.leds.map((l) => [l.id, l.pos])),
      labels: new Map(s.labels.map((l) => [l.id, l.pos])),
      lines: new Map(s.lines.map((l) => [l.id, l.pts])),
      polys: new Map(s.polys.map((l) => [l.id, l.rings])),
      rot: new Map([...s.leds.map((l) => [l.id, l.rotDeg] as [string, number]), ...s.labels.map((l) => [l.id, l.rotDeg] as [string, number])])
    }
  }
  function beginTransform(): void {
    snapshot()
    captureOrig()
  }
  function endTransform(changed: boolean): void {
    if (!changed) undo()
    orig = null
  }
  /** Move the whole selection by (dx, dy) mm relative to where it was at beginTransform. */
  function moveSelectionTo(dx: number, dy: number): void {
    const t = tf.value
    const p = project.value
    if (!t || !p || !orig) return
    const sh = (q: Pt): Pt => {
      const m = t.toMm(q)
      return t.toM([m[0] + dx, m[1] + dy])
    }
    for (const l of selected.value.leds) if (!l.locked || true) { l.pos = sh(orig.leds.get(l.id)!); l.locked = true }
    for (const l of selected.value.labels) l.pos = sh(orig.labels.get(l.id)!)
    for (const l of selected.value.lines) l.pts = orig.lines.get(l.id)!.map(sh)
    for (const l of selected.value.polys) l.rings = orig.polys.get(l.id)!.map((r) => r.map(sh))
    bumpFor(selected.value)
  }
  /** Rotate the selection by delta degrees about a pivot (mm) relative to beginTransform. */
  function rotateSelectionTo(delta: number, pivotMm: Pt): void {
    const t = tf.value
    if (!t || !orig) return
    const rp = (q: Pt): Pt => t.toM(ed.rotatePt(t.toMm(q), pivotMm, delta))
    for (const l of selected.value.leds) { l.pos = rp(orig.leds.get(l.id)!); l.rotDeg = ed.norm360(orig.rot.get(l.id)! + delta); l.locked = true }
    // a back label's rotation is the one seen from the back: turning the board-frame selection one way turns it the other
    for (const l of selected.value.labels) { l.pos = rp(orig.labels.get(l.id)!); l.rotDeg = ed.norm360(orig.rot.get(l.id)! + (l.layer === 'silkBack' ? -delta : delta)) }
    for (const l of selected.value.lines) l.pts = orig.lines.get(l.id)!.map(rp)
    for (const l of selected.value.polys) l.rings = orig.polys.get(l.id)!.map((r) => r.map(rp))
    bumpFor(selected.value)
  }
  function nudgeSelection(dx: number, dy: number): void {
    if (!selected.value.count) return
    beginTransform()
    moveSelectionTo(dx, dy)
    endTransform(true)
  }
  function rotateSelectionBy(delta: number): void {
    const b = selectionBounds.value
    if (!b) return
    beginTransform()
    rotateSelectionTo(delta, [ed.bcx(b), ed.bcy(b)])
    endTransform(true)
  }
  function applyOffsets(items: { kind: SelKind; item: Item }[], offs: Pt[]): void {
    const t = tf.value
    if (!t) return
    items.forEach(({ kind, item }, i) => {
      const [dx, dy] = offs[i]
      if (!dx && !dy) return
      const sh = (q: Pt): Pt => {
        const m = t.toMm(q)
        return t.toM([m[0] + dx, m[1] + dy])
      }
      if (kind === 'led') { const l = item as Led; l.pos = sh(l.pos); l.locked = true }
      else if (kind === 'label') { const l = item as Label; l.pos = sh(l.pos) }
      else if (kind === 'line') { const l = item as LineFeature; l.pts = l.pts.map(sh) }
      else { const l = item as PolyFeature; l.rings = l.rings.map((r) => r.map(sh)) }
    })
    bumpFor({ leds: items.filter((x) => x.kind === 'led'), labels: items.filter((x) => x.kind === 'label'), lines: items.filter((x) => x.kind === 'line'), polys: items.filter((x) => x.kind === 'poly') })
  }
  function selectedItems(): { kind: SelKind; item: Item }[] {
    const s = selected.value
    return [...s.leds.map((i) => ({ kind: 'led' as SelKind, item: i as Item })), ...s.labels.map((i) => ({ kind: 'label' as SelKind, item: i as Item })), ...s.lines.map((i) => ({ kind: 'line' as SelKind, item: i as Item })), ...s.polys.map((i) => ({ kind: 'poly' as SelKind, item: i as Item }))]
  }
  function alignSelection(mode: ed.AlignMode): void {
    const items = selectedItems()
    if (items.length < 2) return
    snapshot()
    applyOffsets(items, ed.alignOffsets(items.map((x) => itemBounds(x.kind, x.item)!), mode))
  }
  function distributeSelection(axis: 'h' | 'v'): void {
    const items = selectedItems()
    if (items.length < 3) return
    snapshot()
    applyOffsets(items, ed.distributeOffsets(items.map((x) => itemBounds(x.kind, x.item)!), axis))
  }
  /** Orientation helpers for LEDs (and labels): match the first selected, snap to 90, follow the nearest line, or set. */
  function orientSelection(mode: 'match' | 'nearest90' | 'line' | 'set', deg = 0): void {
    const s = selected.value
    const t = tf.value
    const p = project.value
    if (!t || !p || (!s.leds.length && !s.labels.length)) return
    snapshot()
    const ref = s.leds[0]?.rotDeg ?? s.labels[0]?.rotDeg ?? 0
    const lineList = p.lines.filter((l) => ['taxiway', 'taxilane', 'runway_cl', 'custom'].includes(l.cls) && l.sub !== 'marking')
    const nearestAngle = (pos: Pt): number | null => {
      const m = t.toMm(pos)
      let best: { d: number; angle: number } | null = null
      for (const l of lineList) {
        const b = ed.lineBounds(l, t)
        if (m[0] < b.x0 - 5 || m[0] > b.x1 + 5 || m[1] < b.y0 - 5 || m[1] > b.y1 + 5) continue
        const n = ed.nearestOnPolyline(m, l.pts.map((q) => t.toMm(q)))
        if (n && (!best || n.d < best.d)) best = { d: n.d, angle: n.angle }
      }
      return best && best.d < 6 ? best.angle : null
    }
    const apply = (item: Led | Label): void => {
      if (mode === 'match') item.rotDeg = ref
      else if (mode === 'nearest90') item.rotDeg = ed.nearest90(item.rotDeg)
      else if (mode === 'set') item.rotDeg = ed.norm360(deg)
      else {
        const a = nearestAngle(item.pos)
        if (a !== null) item.rotDeg = a
      }
    }
    for (const l of s.leds) { apply(l); l.locked = true }
    for (const l of s.labels) apply(l)
    rev.leds++; rev.labels++
  }
  function lockSelection(locked: boolean): void {
    const s = selected.value
    if (!s.count) return
    snapshot()
    for (const l of [...s.leds, ...s.labels, ...s.lines, ...s.polys]) l.locked = locked
    bumpFor(s)
  }
  function duplicateSelection(): void {
    const p = project.value
    const t = tf.value
    const s = selected.value
    if (!p || !t || !s.count) return
    snapshot()
    const sh = (q: Pt): Pt => {
      const m = t.toMm(q)
      return t.toM([m[0] + 2, m[1] + 2])
    }
    const list: Selection[] = []
    for (const l of s.leds) { const c: Led = { ...l, id: newId('d'), pos: sh(l.pos), locked: true }; p.leds.push(c); list.push({ kind: 'led', id: c.id }) }
    for (const l of s.labels) { const c: Label = { ...l, id: newId('t'), pos: sh(l.pos), locked: true }; p.labels.push(c); list.push({ kind: 'label', id: c.id }) }
    for (const l of s.lines) { const c: LineFeature = { ...l, id: newId('l'), pts: l.pts.map(sh), locked: true }; p.lines.push(c); list.push({ kind: 'line', id: c.id }) }
    for (const l of s.polys) { const c: PolyFeature = { ...l, id: newId('p'), rings: l.rings.map((r) => r.map(sh)), locked: true }; p.polys.push(c); list.push({ kind: 'poly', id: c.id }) }
    bumpFor(s)
    setSelection(list)
  }
  function setSelectionProps(patch: Record<string, unknown>): void {
    const s = selected.value
    if (!s.count) return
    snapshot()
    for (const l of s.leds) Object.assign(l, pick(patch, ['cls', 'size', 'role', 'rotDeg', 'label', 'feature', 'locked']))
    for (const l of s.labels) Object.assign(l, pick(patch, ['heightM', 'rotDeg', 'layer', 'weight', 'anchor', 'boxed', 'tracking', 'locked']))
    for (const l of s.lines) Object.assign(l, pick(patch, ['cls', 'name', 'layer', 'widthMm', 'locked']))
    for (const l of s.polys) Object.assign(l, pick(patch, ['cls', 'name', 'layer', 'fill', 'hatch', 'strokeMm', 'locked']))
    bumpFor(s)
  }
  function pick<T extends object>(o: T, keys: string[]): Partial<T> {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (k in o && (o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k]
    return out as Partial<T>
  }
  function removeSelected(): void {
    const p = project.value
    if (!p || !selection.value.length) return
    snapshot()
    const ids = selectedIds.value
    const n = { leds: p.leds.length, labels: p.labels.length, lines: p.lines.length, polys: p.polys.length }
    p.leds = p.leds.filter((x) => !ids.has(x.id))
    p.labels = p.labels.filter((x) => !ids.has(x.id))
    p.lines = p.lines.filter((x) => !ids.has(x.id))
    p.polys = p.polys.filter((x) => !ids.has(x.id))
    setSelection([])
    // bump only what changed: an LED delete must not look like an artwork change (the live route preview stays incremental)
    if (p.leds.length !== n.leds) rev.leds++
    if (p.labels.length !== n.labels) rev.labels++
    if (p.lines.length !== n.lines) rev.lines++
    if (p.polys.length !== n.polys) rev.polys++
    rev.pcb++
    triggerRef(project)
  }

  // ---------------------------------------------------------------- path editing: nodes, segments, join/cut, pathfinder
  const nodeSel = ref<pa.PathRef[]>([])
  const segSel = ref<pa.PathRef[]>([])
  const nodeKeys = computed(() => {
    void rev.sel
    return new Set(nodeSel.value.map(pa.refKey))
  })
  const segKeys = computed(() => {
    void rev.sel
    return new Set(segSel.value.map(pa.refKey))
  })
  function setNodeSel(list: pa.PathRef[]): void {
    nodeSel.value = list
    rev.sel++
  }
  function setSegSel(list: pa.PathRef[]): void {
    segSel.value = list
    rev.sel++
  }
  function clearSub(): void {
    if (nodeSel.value.length || segSel.value.length) {
      nodeSel.value = []
      segSel.value = []
      rev.sel++
    }
  }
  /** Select a node (and make sure its path is selected). */
  function selectNode(r: pa.PathRef, mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
    const pi = pathOf(r.id)
    if (!pi) return
    if (!isSelected(r.id)) select(pi.kind, r.id, mode === 'replace' ? 'replace' : 'add')
    const has = nodeKeys.value.has(pa.refKey(r))
    if (mode === 'replace') { nodeSel.value = [r]; segSel.value = [] }
    else if (mode === 'add') { if (!has) nodeSel.value = [...nodeSel.value, r] }
    else nodeSel.value = has ? nodeSel.value.filter((x) => !pa.sameRef(x, r)) : [...nodeSel.value, r]
    rev.sel++
  }
  /** Select a segment: the segment plus its two end nodes. */
  function selectSegment(r: pa.PathRef, mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
    const pi = pathOf(r.id)
    if (!pi) return
    if (!isSelected(r.id)) select(pi.kind, r.id, mode === 'replace' ? 'replace' : 'add')
    const pts = pathPts(pi, r.ring)
    const closed = pi.kind === 'poly'
    const n2: pa.PathRef = { id: r.id, ring: r.ring, idx: closed ? (r.idx + 1) % pts.length : r.idx + 1 }
    const has = segKeys.value.has(pa.refKey(r))
    if (mode === 'replace') { segSel.value = [r]; nodeSel.value = [r, n2] }
    else if (mode === 'toggle' && has) {
      segSel.value = segSel.value.filter((x) => !pa.sameRef(x, r))
      nodeSel.value = nodeSel.value.filter((x) => !pa.sameRef(x, r) && !pa.sameRef(x, n2))
    } else {
      if (!has) segSel.value = [...segSel.value, r]
      const nk = nodeKeys.value
      nodeSel.value = [...nodeSel.value, ...[r, n2].filter((x) => !nk.has(pa.refKey(x)))]
    }
    rev.sel++
  }
  function selectPathNodes(id: string): void {
    const pi = pathOf(id)
    if (!pi) return
    if (!isSelected(id)) select(pi.kind, id, 'add')
    const list: pa.PathRef[] = []
    const rings = pi.kind === 'line' ? 1 : (pi.item as PolyFeature).rings.length
    for (let ring = 0; ring < rings; ring++) pathPts(pi, ring).forEach((_, idx) => list.push({ id, ring, idx }))
    nodeSel.value = [...nodeSel.value.filter((x) => x.id !== id), ...list]
    rev.sel++
  }

  interface PathItem { kind: 'line' | 'poly'; item: LineFeature | PolyFeature }
  function pathOf(id: string): PathItem | null {
    const p = project.value
    if (!p) return null
    const l = p.lines.find((x) => x.id === id)
    if (l) return { kind: 'line', item: l }
    const pl = p.polys.find((x) => x.id === id)
    return pl ? { kind: 'poly', item: pl } : null
  }
  function pathPts(pi: PathItem, ring: number): Pt[] {
    return pi.kind === 'line' ? (pi.item as LineFeature).pts : pa.normRing((pi.item as PolyFeature).rings[ring] ?? [])
  }
  function setPathPts(pi: PathItem, ring: number, pts: Pt[]): void {
    if (pi.kind === 'line') (pi.item as LineFeature).pts = pts
    else {
      const pl = pi.item as PolyFeature
      const rings = pl.rings.slice()
      rings[ring] = pts
      pl.rings = rings
    }
    pi.item.locked = true
  }
  /** Selected lines and polygons in selection order (the first one is the "back" object for subtract). */
  function selectedPaths(): PathItem[] {
    const out: PathItem[] = []
    for (const s of selection.value) {
      if (s.kind !== 'line' && s.kind !== 'poly') continue
      const pi = pathOf(s.id)
      if (pi) out.push(pi)
    }
    return out
  }
  // Pieces keep their source's properties (class, layer, width, src tag) and are locked, so "apply sources"
  // keeps the edited geometry instead of regenerating the original on top of it.
  function lineFrom(src: LineFeature | PolyFeature, pts: Pt[]): LineFeature {
    if ((src as LineFeature).pts) return { ...(src as LineFeature), id: newId('l'), pts, locked: true }
    const s = src as PolyFeature
    const l: LineFeature = { id: newId('l'), cls: s.cls === 'custom' ? 'custom' : s.cls, pts, layer: s.layer, widthMm: s.strokeMm || undefined, locked: true }
    if (s.src) l.src = s.src
    if (s.name) l.name = s.name
    return l
  }
  function polyFrom(src: LineFeature | PolyFeature, rings: Pt[][]): PolyFeature {
    if ((src as PolyFeature).rings) return { ...(src as PolyFeature), id: newId('p'), rings, locked: true }
    const s = src as LineFeature
    const pl: PolyFeature = { id: newId('p'), cls: 'custom', rings, layer: s.layer, fill: addPreset.polyFill, hatch: { ...addPreset.hatch }, strokeMm: s.widthMm ?? addPreset.lineWidthMm, locked: true }
    if (s.name) pl.name = s.name
    return pl
  }
  /** Replace paths by new items, select the new ones, bump revisions. */
  function replacePaths(removeIds: string[], add: (LineFeature | PolyFeature)[]): void {
    const p = project.value
    if (!p) return
    const rm = new Set(removeIds)
    p.lines = p.lines.filter((x) => !rm.has(x.id))
    p.polys = p.polys.filter((x) => !rm.has(x.id))
    const list: Selection[] = []
    for (const it of add) {
      if ((it as PolyFeature).rings) { p.polys.push(it as PolyFeature); list.push({ kind: 'poly', id: it.id }) }
      else { p.lines.push(it as LineFeature); list.push({ kind: 'line', id: it.id }) }
    }
    nodeSel.value = []
    segSel.value = []
    setSelection(list)
    rev.lines++; rev.polys++
  }
  function groupRefs(refs: pa.PathRef[]): Map<string, { pi: PathItem; ring: number; idxs: number[] }> {
    const m = new Map<string, { pi: PathItem; ring: number; idxs: number[] }>()
    for (const r of refs) {
      const pi = pathOf(r.id)
      if (!pi) continue
      const k = `${r.id}:${r.ring}`
      const g = m.get(k)
      if (g) g.idxs.push(r.idx)
      else m.set(k, { pi, ring: r.ring, idxs: [r.idx] })
    }
    return m
  }
  const mmToM = (mm: number): number => mm / (tf.value?.k ?? 1)
  function pathStats(pi: PathItem): { verts: number; lengthMm: number; areaMm2: number } {
    const k = tf.value?.k ?? 1
    if (pi.kind === 'line') {
      const pts = (pi.item as LineFeature).pts
      return { verts: pts.length, lengthMm: pa.pathLength(pts, false) * k, areaMm2: 0 }
    }
    const rings = (pi.item as PolyFeature).rings
    return { verts: rings.reduce((a, r) => a + pa.normRing(r).length, 0), lengthMm: pa.pathLength(pa.normRing(rings[0]), true) * k, areaMm2: pa.polyArea(rings) * k * k }
  }

  /** Insert a node after `ref.idx` at p (metres); selects the new node. */
  function insertNode(ref: pa.PathRef, p: Pt, commit = true): pa.PathRef | null {
    const pi = pathOf(ref.id)
    if (!pi) return null
    if (commit) snapshot()
    setPathPts(pi, ref.ring, pa.insertVertex(pathPts(pi, ref.ring), ref.idx, p))
    rev.lines++; rev.polys++
    const nr = { id: ref.id, ring: ref.ring, idx: ref.idx + 1 }
    nodeSel.value = [nr]
    segSel.value = []
    rev.sel++
    return nr
  }
  /** Insert a node at the midpoint of every selected segment. */
  function insertMidpoints(): void {
    if (!segSel.value.length) return
    snapshot()
    const added: pa.PathRef[] = []
    for (const g of groupRefs(segSel.value)) {
      const { pi, ring, idxs } = g[1]
      let pts = pathPts(pi, ring)
      const closed = pi.kind === 'poly'
      for (const i of [...new Set(idxs)].sort((a, b) => b - a)) {
        pts = pa.insertVertex(pts, i, pa.segMid(pts, i, closed))
      }
      setPathPts(pi, ring, pts)
      const sorted = [...new Set(idxs)].sort((a, b) => a - b)
      sorted.forEach((i, k) => added.push({ id: pi.item.id, ring, idx: i + 1 + k }))
    }
    rev.lines++; rev.polys++
    nodeSel.value = added
    segSel.value = []
    rev.sel++
    say(`${added.length} node(s) inserted`)
  }
  /** Delete the selected nodes; paths that get too short are removed. */
  function deleteNodes(): void {
    if (!nodeSel.value.length) return
    snapshot()
    const removeIds: string[] = []
    let n = 0
    for (const g of groupRefs(nodeSel.value)) {
      const { pi, ring, idxs } = g[1]
      const pts = pa.removeVertices(pathPts(pi, ring), idxs)
      n += idxs.length
      if (pi.kind === 'line') {
        if (pts.length < 2) removeIds.push(pi.item.id)
        else setPathPts(pi, ring, pts)
      } else {
        const pl = pi.item as PolyFeature
        if (pts.length < 3) {
          if (ring === 0) removeIds.push(pl.id)
          else pl.rings = pl.rings.filter((_, i) => i !== ring)
        } else setPathPts(pi, ring, pts)
      }
    }
    if (removeIds.length) replacePaths(removeIds, [])
    nodeSel.value = []
    segSel.value = []
    rev.sel++
    rev.lines++; rev.polys++
    say(`${n} node(s) deleted${removeIds.length ? `, ${removeIds.length} path(s) removed` : ''}`)
  }
  /** Remove the selected segments: open paths split, rings open up (holes of an opened polygon are dropped). */
  function removeSegments(): void {
    if (!segSel.value.length) return
    snapshot()
    const removeIds: string[] = []
    const add: (LineFeature | PolyFeature)[] = []
    for (const g of groupRefs(segSel.value)) {
      const { pi, ring, idxs } = g[1]
      const src = pi.item
      let pts = pathPts(pi, ring)
      let segs = [...new Set(idxs)].sort((a, b) => a - b)
      if (pi.kind === 'poly') {
        if (ring !== 0) { say('remove segment: select a segment on the exterior ring'); continue }
        const n = pts.length
        const s0 = segs[0]
        pts = pa.removeSegmentRing(pts, s0)
        segs = segs.slice(1).map((j) => ((j - s0 - 1) % n + n) % n)
      }
      // open path: split at every removed segment (descending keeps indices valid)
      let pieces: Pt[][] = [pts]
      for (const j of segs.sort((a, b) => b - a)) {
        const last = pieces.shift()!
        pieces = [...pa.removeSegmentOpen(last, j), ...pieces]
      }
      removeIds.push(src.id)
      for (const pc of pieces) add.push(lineFrom(src, pc))
    }
    replacePaths(removeIds, add)
    say(`segment(s) removed: ${add.length} path(s) result`)
  }
  /** Disconnect the paths at the selected nodes (Illustrator "cut at anchor" / Altium "break track"). */
  function disconnectAtNodes(): void {
    if (!nodeSel.value.length) return
    snapshot()
    const removeIds: string[] = []
    const add: (LineFeature | PolyFeature)[] = []
    for (const g of groupRefs(nodeSel.value)) {
      const { pi, ring, idxs } = g[1]
      const src = pi.item
      let pts = pathPts(pi, ring)
      let at = [...new Set(idxs)].sort((a, b) => a - b)
      if (pi.kind === 'poly') {
        if (ring !== 0) { say('disconnect: select a node on the exterior ring'); continue }
        const n = pts.length
        const i0 = at[0]
        pts = pa.openRingAtVertex(pts, i0)
        at = at.slice(1).map((j) => ((j - i0) % n + n) % n)
      }
      let pieces: Pt[][] = [pts]
      for (const j of at.sort((a, b) => b - a)) {
        const last = pieces.shift()!
        pieces = [...pa.splitAtVertexOpen(last, j), ...pieces]
      }
      if (pi.kind === 'line' && pieces.length < 2) continue
      removeIds.push(src.id)
      for (const pc of pieces) add.push(lineFrom(src, pc))
    }
    if (removeIds.length) replacePaths(removeIds, add)
    say(`disconnected into ${add.length} path(s)`)
  }
  /** Scissors: cut a path at parameter t on segment ref.idx (t = 0 cuts at the vertex). */
  function cutAt(ref: pa.PathRef, t: number): void {
    const pi = pathOf(ref.id)
    if (!pi) return
    snapshot()
    const pts = pathPts(pi, ref.ring)
    if (pi.kind === 'line') {
      const pieces = pa.cutOpenAt(pts, ref.idx, t)
      if (pieces.length < 2) { undo(); say('cut: the end of a line'); return }
      replacePaths([ref.id], pieces.map((pc) => lineFrom(pi.item, pc)))
    } else {
      if (ref.ring !== 0) { undo(); say('cut: select a point on the exterior ring'); return }
      const pl = pi.item as PolyFeature
      if (pl.rings.length > 1) say('cut: holes dropped when opening the polygon')
      replacePaths([ref.id], [lineFrom(pl, pa.cutRingAt(pts, ref.idx, t))])
    }
    say('path cut')
  }
  /** Knife: slice every crossed polygon into pieces and split crossed lines (selected paths, else everything visible). */
  function knife(aMm: Pt, bMm: Pt): void {
    const t = tf.value
    const p = project.value
    if (!t || !p) return
    const a = t.toM(aMm)
    const b = t.toM(bMm)
    const bx0 = Math.min(aMm[0], bMm[0]) - 0.01
    const bx1 = Math.max(aMm[0], bMm[0]) + 0.01
    const by0 = Math.min(aMm[1], bMm[1]) - 0.01
    const by1 = Math.max(aMm[1], bMm[1]) + 0.01
    const hitsBox = (bd: ed.Bounds): boolean => bd.x1 >= bx0 && bd.x0 <= bx1 && bd.y1 >= by0 && bd.y0 <= by1
    let targets = selectedPaths()
    if (!targets.length) {
      targets = [
        ...p.polys.filter((x) => isVisible(x.cls) && hitsBox(ed.polyBounds(x, t))).map((x) => ({ kind: 'poly' as const, item: x })),
        ...p.lines.filter((x) => isVisible(x.cls) && hitsBox(ed.lineBounds(x, t))).map((x) => ({ kind: 'line' as const, item: x }))
      ]
    }
    snapshot()
    const removeIds: string[] = []
    const add: (LineFeature | PolyFeature)[] = []
    for (const pi of targets) {
      if (pi.kind === 'poly') {
        const pieces = pa.knifePolygon((pi.item as PolyFeature).rings, a, b)
        if (!pieces) continue
        removeIds.push(pi.item.id)
        for (const rings of pieces) add.push(polyFrom(pi.item, rings))
      } else {
        const pieces = pa.knifeLine((pi.item as LineFeature).pts, a, b)
        if (!pieces) continue
        removeIds.push(pi.item.id)
        for (const pts of pieces) add.push(lineFrom(pi.item, pts))
      }
    }
    if (!removeIds.length) { undo(); say('knife: nothing crossed'); return }
    replacePaths(removeIds, add)
    say(`knife: ${removeIds.length} path(s) cut into ${add.length}`)
  }
  /** Join: two or more open lines end to end (closest ends; two selected end nodes pick the ends), one line closes. */
  function joinSelected(): void {
    const t = tf.value
    if (!t) return
    const lines = selectedPaths().filter((x) => x.kind === 'line').map((x) => x.item as LineFeature)
    if (!lines.length) return
    if (lines.length === 1) { closeSelected(); return }
    snapshot()
    const eps = mmToM(0.05)
    const ends = nodeSel.value.filter((r) => { const l = lines.find((x) => x.id === r.id); return l && (r.idx === 0 || r.idx === l.pts.length - 1) })
    let cur: Pt[]
    let rest: LineFeature[]
    if (ends.length === 2 && ends[0].id !== ends[1].id) {
      const la = lines.find((x) => x.id === ends[0].id)!
      const lb = lines.find((x) => x.id === ends[1].id)!
      const A = ends[0].idx === 0 ? pa.reversePts(la.pts) : la.pts.slice()
      const B = ends[1].idx === 0 ? lb.pts.slice() : pa.reversePts(lb.pts)
      const gap = Math.hypot(A[A.length - 1][0] - B[0][0], A[A.length - 1][1] - B[0][1])
      cur = gap <= eps ? [...A, ...B.slice(1)] : [...A, ...B]
      rest = lines.filter((x) => x.id !== la.id && x.id !== lb.id)
    } else {
      cur = lines[0].pts.slice()
      rest = lines.slice(1)
    }
    let bridged = 0
    while (rest.length) {
      let bi = 0
      let best: { pts: Pt[]; gap: number } | null = null
      rest.forEach((l, i) => {
        const j = pa.joinOpen(cur, l.pts, eps)
        if (!best || j.gap < best.gap) { best = j; bi = i }
      })
      if (best!.gap > eps) bridged++
      cur = best!.pts
      rest.splice(bi, 1)
    }
    replacePaths(lines.map((l) => l.id), [lineFrom(lines[0], cur)])
    say(`joined ${lines.length} lines${bridged ? ` (${bridged} bridged)` : ''}`)
  }
  function closeSelected(): void {
    const lines = selectedPaths().filter((x) => x.kind === 'line').map((x) => x.item as LineFeature)
    const ok = lines.filter((l) => pa.closeToRing(l.pts).length >= 3)
    if (!ok.length) return
    snapshot()
    replacePaths(ok.map((l) => l.id), ok.map((l) => polyFrom(l, [pa.closeToRing(l.pts)])))
    say(`${ok.length} line(s) closed into polygons`)
  }
  function openSelected(): void {
    const polys = selectedPaths().filter((x) => x.kind === 'poly').map((x) => x.item as PolyFeature)
    if (!polys.length) return
    snapshot()
    const add: LineFeature[] = []
    for (const pl of polys) for (const r of pl.rings) add.push(lineFrom(pl, pa.ringToOpen(r)))
    replacePaths(polys.map((l) => l.id), add)
    say(`${polys.length} polygon(s) opened into ${add.length} line(s)`)
  }
  function reverseSelected(): void {
    const paths = selectedPaths()
    if (!paths.length) return
    snapshot()
    for (const pi of paths) {
      if (pi.kind === 'line') (pi.item as LineFeature).pts = pa.reversePts((pi.item as LineFeature).pts)
      else (pi.item as PolyFeature).rings = (pi.item as PolyFeature).rings.map((r) => pa.reversePts(pa.normRing(r)))
    }
    nodeSel.value = []
    segSel.value = []
    rev.sel++
    rev.lines++; rev.polys++
  }
  function straightenNodes(): void {
    const groups = [...groupRefs(nodeSel.value).values()].filter((g) => g.idxs.length >= 2)
    if (!groups.length) return
    snapshot()
    for (const { pi, ring, idxs } of groups) {
      const pts = pathPts(pi, ring)
      setPathPts(pi, ring, pi.kind === 'line' ? pa.straightenOpen(pts, idxs) : pa.straightenRing(pts, idxs))
    }
    nodeSel.value = []
    segSel.value = []
    rev.sel++
    rev.lines++; rev.polys++
  }
  function averageNodes(axis: 'x' | 'y' | 'both'): void {
    if (nodeSel.value.length < 2) return
    const pts: Pt[] = []
    for (const r of nodeSel.value) { const pi = pathOf(r.id); if (pi) pts.push(pathPts(pi, r.ring)[r.idx]) }
    const m = pa.averagePts(pts, axis)
    snapshot()
    for (const g of groupRefs(nodeSel.value).values()) {
      const cur = pathPts(g.pi, g.ring).slice()
      for (const i of g.idxs) cur[i] = [axis === 'y' ? cur[i][0] : m[0], axis === 'x' ? cur[i][1] : m[1]]
      setPathPts(g.pi, g.ring, cur)
    }
    rev.lines++; rev.polys++
  }
  function simplifySelected(tolMm: number): void {
    const paths = selectedPaths()
    if (!paths.length || !(tolMm > 0)) return
    snapshot()
    const tol = mmToM(tolMm)
    let before = 0
    let after = 0
    for (const pi of paths) {
      if (pi.kind === 'line') {
        const l = pi.item as LineFeature
        before += l.pts.length
        l.pts = pa.simplifyPts(l.pts, tol, false)
        after += l.pts.length
      } else {
        const pl = pi.item as PolyFeature
        before += pl.rings.reduce((a, r) => a + r.length, 0)
        pl.rings = pl.rings.map((r) => pa.simplifyPts(pa.normRing(r), tol, true)).filter((r) => r.length >= 3)
        after += pl.rings.reduce((a, r) => a + r.length, 0)
      }
      pi.item.locked = true
    }
    clearSub()
    rev.lines++; rev.polys++
    say(`simplified: ${before} -> ${after} vertices`)
  }
  function smoothSelected(iters = 1): void {
    const paths = selectedPaths()
    if (!paths.length) return
    snapshot()
    for (const pi of paths) {
      if (pi.kind === 'line') (pi.item as LineFeature).pts = pa.chaikin((pi.item as LineFeature).pts, iters, false)
      else (pi.item as PolyFeature).rings = (pi.item as PolyFeature).rings.map((r) => pa.chaikin(pa.normRing(r), iters, true))
      pi.item.locked = true
    }
    clearSub()
    rev.lines++; rev.polys++
  }
  /** Offset path: parallel copies (polygons grow/shrink, lines get a parallel line). */
  function offsetSelected(distMm: number, join: 'round' | 'mitre' | 'bevel' = 'mitre'): void {
    const paths = selectedPaths()
    if (!paths.length || !distMm) return
    snapshot()
    const d = mmToM(distMm)
    const add: (LineFeature | PolyFeature)[] = []
    for (const pi of paths) {
      if (pi.kind === 'poly') for (const rings of pa.offsetPolygon((pi.item as PolyFeature).rings, d, { join })) add.push(polyFrom(pi.item, rings))
      else add.push(lineFrom(pi.item, pa.parallelLine((pi.item as LineFeature).pts, d)))
    }
    replacePaths([], add)
    say(`offset ${distMm} mm: ${add.length} path(s) created`)
  }
  /** Outline stroke: replace lines by polygons of their width. */
  function outlineSelected(widthMm?: number): void {
    const lines = selectedPaths().filter((x) => x.kind === 'line').map((x) => x.item as LineFeature)
    if (!lines.length) return
    snapshot()
    const add: PolyFeature[] = []
    for (const l of lines) {
      const w = mmToM(widthMm || l.widthMm || LINE_WIDTH[l.cls] || 0.15)
      for (const rings of pa.outlineLine(l.pts, w)) add.push({ ...polyFrom(l, rings), fill: 'solid', strokeMm: 0 })
    }
    replacePaths(lines.map((l) => l.id), add)
    say(`${lines.length} line(s) outlined`)
  }
  /** Pathfinder on the selected polygons (selection order: the first is the back object for subtract). */
  function pathfinderOp(op: pa.BoolOp): void {
    const polys = selectedPaths().filter((x) => x.kind === 'poly').map((x) => x.item as PolyFeature)
    if (polys.length < 2) { say('pathfinder: select two or more polygons'); return }
    snapshot()
    const out = pa.pathfinder(op, polys.map((p) => p.rings))
    replacePaths(polys.map((p) => p.id), out.map((rings) => polyFrom(polys[0], rings)))
    say(`${op}: ${polys.length} polygons -> ${out.length}`)
  }
  function explodeSelected(): void {
    const polys = selectedPaths().filter((x) => x.kind === 'poly').map((x) => x.item as PolyFeature).filter((p) => p.rings.length > 1)
    if (!polys.length) return
    snapshot()
    const add: PolyFeature[] = []
    for (const pl of polys) for (const rings of pa.explodePolygon(pl.rings)) add.push(polyFrom(pl, rings))
    replacePaths(polys.map((p) => p.id), add)
    say(`exploded into ${add.length} polygons`)
  }
  function removeHoles(): void {
    const polys = selectedPaths().filter((x) => x.kind === 'poly').map((x) => x.item as PolyFeature).filter((p) => p.rings.length > 1)
    if (!polys.length) return
    snapshot()
    for (const pl of polys) { pl.rings = [pl.rings[0]]; pl.locked = true }
    clearSub()
    rev.polys++
  }
  function removeRing(id: string, ring: number): void {
    const pl = project.value?.polys.find((x) => x.id === id)
    if (!pl || ring <= 0 || ring >= pl.rings.length) return
    snapshot()
    pl.rings = pl.rings.filter((_, i) => i !== ring)
    pl.locked = true
    clearSub()
    rev.polys++
  }
  /** Move the selected nodes by (dx, dy) mm relative to beginTransform. */
  function moveNodesTo(dx: number, dy: number): void {
    const t = tf.value
    if (!t || !orig) return
    const sh = (q: Pt): Pt => {
      const m = t.toMm(q)
      return t.toM([m[0] + dx, m[1] + dy])
    }
    for (const g of groupRefs(nodeSel.value).values()) {
      const base = g.pi.kind === 'line' ? orig.lines.get(g.pi.item.id) : orig.polys.get(g.pi.item.id)?.[g.ring]
      if (!base) continue
      const src = g.pi.kind === 'line' ? base : pa.normRing(base)
      const cur = src.slice()
      for (const i of g.idxs) if (cur[i]) cur[i] = sh(src[i])
      setPathPts(g.pi, g.ring, cur)
    }
    rev.lines++; rev.polys++
  }
  function setNodePos(r: pa.PathRef, mm: Pt, commit = true): void {
    const t = tf.value
    const pi = pathOf(r.id)
    if (!t || !pi) return
    if (commit) snapshot()
    const cur = pathPts(pi, r.ring).slice()
    if (!cur[r.idx]) return
    cur[r.idx] = t.toM(mm)
    setPathPts(pi, r.ring, cur)
    rev.lines++; rev.polys++
  }
  /** Pen: append a point to one end of an open line. */
  function extendLine(id: string, end: 'start' | 'end', p: Pt, commit = true): void {
    const l = project.value?.lines.find((x) => x.id === id)
    if (!l) return
    if (commit) snapshot()
    l.pts = end === 'end' ? [...l.pts, p] : [p, ...l.pts]
    l.locked = true
    rev.lines++
    nodeSel.value = [{ id, ring: 0, idx: end === 'end' ? l.pts.length - 1 : 0 }]
    rev.sel++
  }
  function closeLine(id: string): void {
    const l = project.value?.lines.find((x) => x.id === id)
    if (!l || pa.closeToRing(l.pts).length < 3) return
    snapshot()
    replacePaths([id], [polyFrom(l, [pa.closeToRing(l.pts)])])
    say('path closed')
  }
  /** Fillet or chamfer the selected nodes (size in board mm). */
  function roundNodes(sizeMm: number, mode: 'fillet' | 'chamfer'): void {
    if (!nodeSel.value.length || !(sizeMm > 0)) return
    snapshot()
    const size = mmToM(sizeMm)
    let n = 0
    for (const g of groupRefs(nodeSel.value).values()) {
      const pts = pathPts(g.pi, g.ring)
      setPathPts(g.pi, g.ring, pa.roundCorners(pts, g.idxs, size, g.pi.kind === 'poly', mode))
      n += g.idxs.length
    }
    nodeSel.value = []
    segSel.value = []
    rev.sel++
    rev.lines++; rev.polys++
    say(`${mode}: ${n} corner(s), ${sizeMm} mm`)
  }
  /** Segment length (mm) and visual angle (degrees CCW from +x on the board). */
  function segmentInfo(r: pa.PathRef): { lengthMm: number; angleDeg: number; a: Pt; b: Pt } | null {
    const t = tf.value
    const pi = pathOf(r.id)
    if (!t || !pi) return null
    const pts = pathPts(pi, r.ring)
    if (!pts[r.idx]) return null
    const a = t.toMm(pts[r.idx])
    const b = t.toMm(pa.segEnd(pts, r.idx, pi.kind === 'poly'))
    return { lengthMm: Math.hypot(b[0] - a[0], b[1] - a[1]), angleDeg: ed.angleOf(a, b), a, b }
  }
  function setSegment(r: pa.PathRef, patch: { lengthMm?: number; angleDeg?: number }): void {
    const pi = pathOf(r.id)
    if (!pi) return
    snapshot()
    let pts = pathPts(pi, r.ring)
    const closed = pi.kind === 'poly'
    // metres are x east / y north, the same handedness as the visual CCW angle
    if (patch.angleDeg !== undefined) pts = pa.setSegmentAngle(pts, r.idx, (patch.angleDeg * Math.PI) / 180, closed)
    if (patch.lengthMm !== undefined && patch.lengthMm > 0) pts = pa.setSegmentLength(pts, r.idx, mmToM(patch.lengthMm), closed)
    setPathPts(pi, r.ring, pts)
    rev.lines++; rev.polys++
  }
  /** Add a polygon from board-mm points (shape tools). */
  function addShape(ptsMm: Pt[]): PolyFeature | null {
    return addPoly(ptsMm)
  }
  const zoomRequest = ref<{ b: ed.Bounds; n: number } | null>(null)
  function requestZoom(b: ed.Bounds): void {
    zoomRequest.value = { b, n: (zoomRequest.value?.n ?? 0) + 1 }
  }

  // ---------------------------------------------------------------- PCB: the Altium generator (pcbgen sidecar)
  // The job (LEDs + art polygons, tens of MB) is built in the compute worker and loaded into the sidecar once per
  // geometry revision; placement checks, chains and builds then send only the block poses and the user's chain edits.
  const pcb = reactive({
    info: null as null | { exe: string | null; template: string | null; running: boolean; version: string | null; candidates: string[] },
    describe: null as PcbDescribe | null,
    describedTemplate: '',
    check: null as PcbCheck | null,
    checking: false,
    chainStats: [] as PcbChainStat[],
    channelPads: [] as { channel: number; x: number; y: number }[],
    jobId: '',
    jobKey: '',
    selectedBlock: null as string | null,
    showBlocks: true,
    showChains: true,
    lastExport: null as PcbExportResult | null,
    lastFirmware: null as null | { path: string; id: string; leds: number; chains: number; installed?: string },
    // route preview: geometry of the last preview or export, the inputs it was made from, and its numbers
    route: null as PcbRoute | null,
    routeKey: '',
    routeFrom: '' as '' | 'preview' | 'export' | 'incremental',
    // live preview: the generator keeps the board of the last full preview (session) and updates it as LEDs change
    routeSession: '',
    routeBase: '',          // everything but the LEDs at the last full preview
    routeLive: true,
    routeUpdates: 0,
    routePending: false,
    routeNeedFull: '',
    routeInc: null as null | { ms: number; trip: number; changed: number; replaced: number; rerouted: number },
    designators: {} as Record<string, string>,   // designator -> LED id (last preview / export), to select LEDs the generator names
    routeInfo: null as null | { seconds: number; caps: number; vias5sw: number; onArt: { caps: number; vias: number; dataViasUnderSilk: number } },
    showRoute: true,
    error: ''
  })
  function pcbSettings(): PcbSettings {
    const p = project.value!
    if (!p.pcb) p.pcb = { blocks: [] }
    return p.pcb
  }
  const pcbTemplate = computed(() => {
    void rev.pcb
    return project.value?.pcb?.template || pcb.info?.template || ''
  })
  /** Geometry revision of the job: LEDs, art and board (chains and block poses travel as overrides). */
  function pcbJobKey(): string {
    return `${projectSerial}:${rev.leds}:${rev.lines}:${rev.polys}:${rev.labels}:${rev.board}:${rev.vis}:${rev.back}:${project.value?.pcb?.channels ?? 7}:${project.value?.pcb?.routeData ?? true}:${project.value?.pcb?.ledArtMargin ?? 0.1}:${project.value?.pcb?.backSilkClearVias ?? false}`
  }
  /** What the routing depends on besides the LEDs: art, board, options, block poses, template. */
  function pcbRouteBase(): string {
    const s = project.value?.pcb
    return `${projectSerial}:${rev.lines}:${rev.polys}:${rev.labels}:${rev.board}:${rev.vis}:${s?.channels ?? 7}:${s?.routeData ?? true}:${s?.ledArtMargin ?? 0.1}|${JSON.stringify(pcbBlocks())}|${pcbTemplate.value}`
  }
  /** Everything the routing depends on: the base plus the LEDs and the hand chain edits. */
  function pcbRouteKey(): string {
    return `${pcbRouteBase()}|${rev.leds}|${JSON.stringify(pcbChainEdits())}`
  }
  /** LED pairs whose pads would come under 0.15 mm apart (footprint squares, core/spacing.ts), live as LEDs change. */
  const ledsTooClose = computed(() => {
    void rev.leds
    void rev.board
    const p = project.value
    const t = tf.value
    if (!p || !t) return [] as { a: Led; b: Led; gapMm: number }[]
    return tooClosePairs(p.leds, t)
  })
  function selectLeds(ids: string[]): void {
    setSelection(ids.map((id) => ({ kind: 'led' as const, id })))
  }
  const pcbRouteStale = computed(() => {
    void version.value
    void rev.pcb
    void rev.leds
    return !!pcb.route && pcb.routeKey !== pcbRouteKey()
  })
  const pcbJobStale = computed(() => {
    void version.value
    void rev.pcb
    return !pcb.jobId || pcb.jobKey !== pcbJobKey()
  })
  /** One sidecar call; progress lines go to `log`; inside a task, Cancel stops the generator. */
  async function pcbCall<T>(cmd: string, args: Record<string, unknown>, log?: (s: string) => void, cancellable = false): Promise<T> {
    const key = `${cmd}-${Math.random().toString(36).slice(2)}`
    const off = log ? window.api.onPcbgenProgress((m) => { if (m.key === key) log(m.message) }) : null
    if (cancellable) {
      cancelTask = () => { void window.api.pcbgenCancel() }
      task.cancellable = true
    }
    try {
      return await window.api.pcbgenCall<T>(cmd, JSON.parse(JSON.stringify(args)) as Record<string, unknown>, key)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'pcbgen:call': (Error: )?/, '')
      if (/cancelled/.test(msg)) {
        pcb.jobId = ''
        throw new CancelledError()
      }
      if (/unknown jobId/.test(msg)) pcb.jobId = ''
      throw new Error(msg)
    } finally {
      off?.()
      if (cancellable) {
        cancelTask = null
        task.cancellable = false
      }
    }
  }
  function pcbBlocks(): PcbBlockPose[] {
    return (project.value?.pcb?.blocks ?? []).map((b) => ({ ...b }))
  }
  function pcbChainEdits(): { id: string; chain: number; index?: number }[] {
    return (project.value?.leds ?? []).filter((l) => l.chainUser && l.chain).map((l) => (l.chainLocked && l.chainIndex !== undefined ? { id: l.id, chain: l.chain!, index: l.chainIndex } : { id: l.id, chain: l.chain! }))
  }
  async function pcbInfo(): Promise<void> {
    pcb.info = await window.api.pcbgenInfo()
  }
  /** The job in the sidecar for the current geometry (built in the worker when the project changed). */
  async function pcbEnsureJob(log: (s: string) => void): Promise<string> {
    const key = pcbJobKey()
    if (pcb.jobId && pcb.jobKey === key) return pcb.jobId
    log('building the generator job (LEDs, artwork polygons)…')
    const job = await work('pcbjob', { project: project.value! }, log)
    log(`loading the job into the generator (${job.leds.length} LEDs, ${job.art.silk.length} silk / ${job.art.silkBack.length} back silk / ${job.art.copper.length} copper polygons)…`)
    const r = await pcbCall<{ jobId: string }>('loadJob', { job }, log)
    pcb.jobId = r.jobId
    pcb.jobKey = key
    rev.pcb++
    return r.jobId
  }
  /** Run a sidecar command that needs the job, reloading it once if the generator was restarted meanwhile. */
  async function pcbWithJob<T>(cmd: string, args: Record<string, unknown>, log: (s: string) => void, cancellable = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const jobId = await pcbEnsureJob(log)
      try {
        return await pcbCall<T>(cmd, { ...args, jobId, template: pcbTemplate.value || undefined }, log, cancellable)
      } catch (e) {
        if (attempt === 0 && !pcb.jobId && !(e instanceof CancelledError)) continue
        throw e
      }
    }
  }
  async function pcbDescribe(): Promise<void> {
    const tpl = pcbTemplate.value
    if (!tpl) return
    pcb.describe = await pcbCall<PcbDescribe>('describeTemplate', { template: tpl })
    pcb.describedTemplate = tpl
    rev.pcb++
  }
  /** Prepare the PCB tab: generator info, template description, job, first check. */
  async function pcbPrepare(): Promise<void> {
    if (!project.value) return
    await runTask('Preparing the Altium generator', async (say) => {
      await pcbInfo()
      if (!pcb.info?.exe) throw new Error('the Altium generator was not found: ' + (pcb.info?.candidates ?? []).join(', '))
      say(`generator: ${pcb.info.exe}`)
      if (pcb.describedTemplate !== pcbTemplate.value || !pcb.describe) {
        say(`template: ${pcbTemplate.value}`)
        await pcbDescribe()
      }
      await pcbEnsureJob(say)
      await pcbCheckNow(say)
    })
  }
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let checkAgain = false
  /** Live placement check (no busy overlay): debounced, one in flight at a time. */
  function pcbScheduleCheck(): void {
    if (!pcb.jobId || pcbJobStale.value) return
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(() => {
      checkTimer = null
      if (pcb.checking) {
        checkAgain = true
        return
      }
      void pcbCheckNow().catch((e) => { pcb.error = String((e as Error)?.message ?? e) })
    }, 120)
  }
  async function pcbCheckNow(log?: (s: string) => void): Promise<void> {
    if (!pcb.jobId) return
    pcb.checking = true
    try {
      pcb.check = await pcbCall<PcbCheck>('checkPlacement', { jobId: pcb.jobId, template: pcbTemplate.value || undefined, blocks: pcbBlocks() }, log)
      pcb.error = ''
      rev.pcb++
    } finally {
      pcb.checking = false
      if (checkAgain) {
        checkAgain = false
        pcbScheduleCheck()
      }
    }
  }
  async function pcbAutoplace(): Promise<void> {
    if (!project.value) return
    await runTask('Auto-placing the blocks', async (say) => {
      const r = await pcbWithJob<{ blocks: PcbBlockPose[]; ledsInsideBlocks: number; notes: string[] }>('autoplace', { keep: false }, say, true)
      snapshot()
      pcbSettings().blocks = r.blocks
      rev.pcb++
      for (const b of r.blocks) say(`${b.name}: ${b.edge ? `${b.edge} edge at ${b.t} mm` : `(${b.x}, ${b.y}) rot ${b.rot}`}`)
      await pcbCheckNow(say)
    })
  }
  function applyChains(list: { id: string; chain: number; index: number; designator?: string }[]): void {
    const byId = new Map(list.map((c) => [c.id, c]))
    if (list.some((c) => c.designator)) pcb.designators = Object.fromEntries(list.filter((c) => c.designator).map((c) => [c.designator!, c.id]))
    for (const l of project.value!.leds) {
      const c = byId.get(l.id)
      if (!c) continue
      l.chain = c.chain
      l.chainIndex = c.index
    }
    rev.pcb++
  }
  /** Lines for the task log: what must not ship unnoticed (the files are written anyway). */
  function pcbIssues(unrouted: string[], caps: string[], tooClose: string[]): string[] {
    const out: string[] = []
    if (unrouted.length) out.push(`NEEDS ATTENTION: ${unrouted.length} unrouted hop(s): ${unrouted.slice(0, 12).join(', ')}`)
    if (caps.length) out.push(`NEEDS ATTENTION: ${caps.length} cap(s) over another part: ${caps.slice(0, 12).join(', ')}`)
    if (tooClose.length) out.push(`NEEDS ATTENTION: ${tooClose.length} LED pair(s) with pads under 0.15 mm apart: ${tooClose.slice(0, 12).join(', ')}`)
    return out
  }
  /** Select the LEDs the generator names by designator (D557, ...). */
  function pcbSelectDesignators(des: string[]): void {
    const ids = des.map((d) => pcb.designators[d]).filter((x): x is string => !!x)
    setSelection(ids.map((id) => ({ kind: 'led' as const, id })))
  }
  async function pcbAssignChains(): Promise<void> {
    if (!project.value) return
    // new chains: the preview no longer shows what will be routed, and the live session is for the old ones
    pcb.routeKey = ''
    pcb.routeSession = ''
    await runTask('Assigning the LED chains', async (say) => {
      const r = await pcbWithJob<{ leds: { id: string; chain: number; index: number }[]; chains: PcbChainStat[]; channelPads: { channel: number; x: number; y: number }[]; controller: string }>('chain', { blocks: pcbBlocks(), chains: pcbChainEdits() }, say, true)
      applyChains(r.leds)
      pcb.chainStats = r.chains
      pcb.channelPads = r.channelPads
      pcb.showChains = true
      for (const c of r.chains) say(`chain ${c.chain}: ${c.count} LEDs, ${(c.lengthMm / 1000).toFixed(2)} m, longest hop ${c.longestHopMm.toFixed(1)} mm${c.userAssigned ? `, ${c.userAssigned} assigned by hand` : ''}`)
    })
  }
  function pcbSetBlockPose(pose: PcbBlockPose, commit = true): void {
    if (!project.value) return
    if (commit) snapshot()
    const s = pcbSettings()
    const i = s.blocks.findIndex((b) => b.name === pose.name)
    if (i >= 0) s.blocks[i] = pose
    else s.blocks.push(pose)
    rev.pcb++
    pcbScheduleCheck()
  }
  function pcbClearBlockPose(name: string): void {
    if (!project.value?.pcb) return
    snapshot()
    project.value.pcb.blocks = project.value.pcb.blocks.filter((b) => b.name !== name)
    rev.pcb++
    pcbScheduleCheck()
  }
  function pcbSetOptions(patch: Partial<PcbSettings>): void {
    if (!project.value) return
    Object.assign(pcbSettings(), patch)
    dirty.value = true
    rev.pcb++
  }
  /** Put LEDs on a chain by hand (null = back to automatic); the order inside the chain stays automatic. */
  function pcbAssignLeds(ids: string[], chain: number | null): void {
    const p = project.value
    if (!p) return
    snapshot()
    const set = new Set(ids)
    for (const l of p.leds) {
      if (!set.has(l.id)) continue
      if (chain === null) { l.chainUser = false; l.chainLocked = false } else { l.chain = chain; l.chainUser = true; l.chainLocked = false }
    }
    rev.pcb++
  }
  /** Keep (or release) the LEDs' current position in their chain. */
  function pcbLockLeds(ids: string[], lock: boolean): void {
    const p = project.value
    if (!p) return
    snapshot()
    const set = new Set(ids)
    for (const l of p.leds) {
      if (!set.has(l.id) || !l.chain) continue
      l.chainLocked = lock
      if (lock) l.chainUser = true
    }
    rev.pcb++
  }
  /** Route preview: the generator places and routes the board in memory (nothing written) and returns the tracks,
   *  vias and caps for the overlay, plus the chains as routed. */
  /** Every LED's chain and position as the studio has them (last preview, live update or Assign chains) when complete
   *  and consistent, else null. Given to the generator, it routes exactly this topology. */
  function pcbPinnedChains(): { id: string; chain: number; index: number }[] | null {
    const p = project.value
    if (!p || !p.leds.length) return null
    const channels = p.pcb?.channels ?? 7
    const seen = new Set<string>()
    const count = new Map<number, number>()
    for (const l of p.leds) {
      if (!l.chain || l.chain > channels || l.chainIndex === undefined) return null
      const k = `${l.chain}:${l.chainIndex}`
      if (seen.has(k)) return null
      seen.add(k)
      count.set(l.chain, (count.get(l.chain) ?? 0) + 1)
    }
    if (p.leds.some((l) => l.chainIndex! >= count.get(l.chain!)!)) return null
    return p.leds.map((l) => ({ id: l.id, chain: l.chain!, index: l.chainIndex! }))
  }
  /** The export keeps the chains of a current preview (what the overlay shows); without one it assigns chains itself. */
  const pcbExportKeepsChains = computed(() => {
    void rev.pcb
    void rev.leds
    void version.value
    return !!pcb.route && !pcbRouteStale.value && pcbPinnedChains() !== null
  })
  /** Route preview. rechain = false keeps the LEDs' current chains when they are complete (Preview again); true lets the
   *  generator assign chains again (Re-chain + preview; hand chain edits are kept). */
  async function pcbPreviewRoute(rechain = false): Promise<PcbRouteResult | null> {
    if (!project.value) return null
    const r = await runTask(rechain ? 'Re-chaining and routing' : 'Routing preview', async (say) => {
      const key = pcbRouteKey()
      const pinned = rechain ? null : pcbPinnedChains()
      say(`placing and routing in memory (no files are written); ${pinned ? 'keeping the current chains' : 'assigning chains'}…`)
      const res = await pcbWithJob<PcbRouteResult>('route', { blocks: pcbBlocks(), chains: pinned ?? pcbChainEdits() }, say, true)
      if (Array.isArray(res.chains)) applyChains(res.chains)
      if (Array.isArray(res.chainStats)) pcb.chainStats = res.chainStats
      pcb.route = res.route
      pcb.routeKey = key
      pcb.routeFrom = 'preview'
      pcb.routeSession = res.session ?? ''
      pcb.routeBase = pcbRouteBase()
      pcb.routeUpdates = 0
      pcb.routeNeedFull = ''
      pcb.routeInc = null
      pcb.routeInfo = { seconds: res.seconds, caps: res.caps, vias5sw: res.vias5sw, onArt: res.onArtAfterTrim }
      pcb.showRoute = true
      rev.pcb++
      const g = res.route
      for (const line of pcbIssues(g.failed.map((f) => f.net), g.capConflicts ?? [], g.ledsTooClose ?? [])) say(line)
      say(`routed ${g.routed}/${g.routed + g.failedCount} hops, ${g.dataVias} data vias, ${(g.trackMm / 1000).toFixed(2)} m of track${g.failedCount ? `; unrouted: ${g.failed.map((f) => f.net).slice(0, 12).join(', ')}` : ''} (${res.seconds} s)`)
      return res
    })
    return r ?? null
  }
  // ---------------------------------------------------------------- live route preview (incremental)
  let routeTimer: ReturnType<typeof setTimeout> | null = null
  let routeBusy = false
  let routeAgain = false
  /** After an edit: update the preview in place (debounced) when only LEDs / hand chain edits changed since it. */
  function pcbScheduleRouteUpdate(): void {
    if (!pcb.route || !pcb.routeSession || pcb.routeFrom === 'export' || !project.value) return
    if (pcbRouteBase() !== pcb.routeBase) {
      pcb.routeNeedFull = 'the artwork, the board, the blocks or the template changed'
      pcb.routePending = false
      return
    }
    if (!pcb.routeLive || pcb.routeKey === pcbRouteKey()) return
    pcb.routePending = true
    if (routeTimer) clearTimeout(routeTimer)
    routeTimer = setTimeout(() => {
      routeTimer = null
      void pcbRouteIncremental()
    }, 150)
  }
  /** One incremental update of the route preview (no fullscreen loader: KORD single-LED edits take ~30-60 ms). */
  async function pcbRouteIncremental(): Promise<PcbRouteUpdate | null> {
    if (routeBusy) {
      routeAgain = true
      return null
    }
    if (!project.value || !pcb.routeSession) return null
    if (task.active) {
      routeAgain = true
      return null
    }
    routeBusy = true
    try {
      const key = pcbRouteKey()
      const t0 = performance.now()
      const res = await pcbCall<PcbRouteUpdate>('routeUpdate', { session: pcb.routeSession, template: pcbTemplate.value || undefined, leds: pcbJobLeds(project.value), chains: pcbChainEdits(), blocks: pcbBlocks() })
      if (!res.incremental || !res.route) {
        pcb.routeNeedFull = res.reason || 'the generator needs a full preview'
        rev.pcb++
        return res
      }
      pcb.route = res.route
      pcb.routeKey = key
      pcb.routeFrom = 'incremental'
      pcb.routeUpdates = res.updates ?? pcb.routeUpdates + 1
      pcb.routeNeedFull = ''
      pcb.routeInc = { ms: res.ms ?? 0, trip: Math.round(performance.now() - t0), changed: res.changed ?? 0, replaced: res.replaced ?? 0, rerouted: res.rerouted ?? 0 }
      if (pcb.routeInfo) pcb.routeInfo = { ...pcb.routeInfo, seconds: Math.round((res.ms ?? 0) / 100) / 10, caps: res.caps ?? pcb.routeInfo.caps, vias5sw: res.vias5sw ?? pcb.routeInfo.vias5sw }
      if (Array.isArray(res.chains)) applyChains(res.chains)
      if (Array.isArray(res.chainStats)) pcb.chainStats = res.chainStats
      rev.pcb++
      return res
    } catch (e) {
      pcb.routeNeedFull = String((e as Error)?.message ?? e)
      return null
    } finally {
      routeBusy = false
      pcb.routePending = false
      if (routeAgain) {
        routeAgain = false
        pcbScheduleRouteUpdate()
      }
    }
  }
  watch(() => [rev.leds, rev.pcb, rev.lines, rev.polys, rev.labels, rev.board, rev.vis, version.value], () => pcbScheduleRouteUpdate())
  /** datacheck (exact geometry) on the board the generator holds for the live preview. */
  async function pcbRouteCheck(): Promise<{ summary: string; count: number; violations: string[] } | null> {
    if (!pcb.routeSession) return null
    return pcbCall('routeCheck', {})
  }
  /** Correctness check: a full preview of the live preview's state with every LED pinned to its chain and position. */
  async function pcbRouteCompare(): Promise<{ seconds: number; incremental: { routed: number; failed: number; vias: number; trackMm: number; failedNets: string[] }; full: { routed: number; failed: number; vias: number; trackMm: number; failedNets: string[] } } | null> {
    if (!pcb.routeSession) return null
    return pcbCall('routeCompare', {})
  }
  /** Write the last export's firmware board definition into the flightboard repo and generate its header. */
  async function pcbInstallFirmware(repo?: string): Promise<void> {
    const res = pcb.lastExport
    if (!project.value || !res) return
    await runTask('Installing the firmware board definition', async (say) => {
      const fwId = project.value!.pcb?.fwId || project.value!.board.id
      const fw = buildFirmwareBoard(project.value!, res.chains, { id: fwId, gpios: res.report.gpios ?? [], statusGpio: res.report.statusGpio?.gpio, spareGpios: res.report.spareGpios })
      const r = await window.api.firmwareInstall(JSON.stringify(fw), fwId, repo)
      say(`wrote ${r.json}`)
      for (const line of r.output.split('\n').filter(Boolean)) say(line)
      say(`generated ${r.hpp}`)
      if (pcb.lastFirmware) pcb.lastFirmware.installed = r.json
    })
  }
  /** P3: the complete Altium project (+ zip, firmware light map) into a folder the user picks. */
  async function pcbExport(): Promise<PcbExportResult | null> {
    if (!project.value) return null
    const r = await runTask('Exporting the Altium project', async (say) => {
      const s = pcbSettings()
      const base = await window.api.pickDir('Folder for the Altium project', s.outDir)
      if (!base) {
        say('no folder chosen')
        return null
      }
      const name = pcbName(project.value!)
      const outDir = `${base}/${name}`
      say(`building ${name} into ${outDir}…`)
      const routeKey = pcbRouteKey()
      // the export routes what the preview shows: a current preview's chains are kept; otherwise chains are assigned
      const pinned = pcbExportKeepsChains.value ? pcbPinnedChains() : null
      say(pinned ? 'using the chains of the current preview' : 'assigning chains (no current preview)')
      const res = await pcbWithJob<PcbExportResult>('build', { blocks: pcbBlocks(), chains: pinned ?? pcbChainEdits(), outDir, name, zip: s.zip === false ? undefined : `${base}/${name}_Altium.zip` }, say, true)
      s.outDir = base
      applyChains(res.chains)
      pcb.lastExport = res
      if (res.route) {
        pcb.route = res.route
        pcb.routeKey = routeKey
        pcb.routeFrom = 'export'
        pcb.routeSession = ''   // the live preview belongs to the last full preview; after an export start again from it
        pcb.routeInc = null
        pcb.routeInfo = { seconds: res.report.seconds, caps: res.report.caps, vias5sw: res.report.vias5sw, onArt: res.report.onArtAfterTrim }
        rev.pcb++
      }
      // firmware board definition with the routed chain order (install it into ../flightboard from the PCB tab)
      const fwId = s.fwId || project.value!.board.id
      const fw = buildFirmwareBoard(project.value!, res.chains, { id: fwId, gpios: res.report.gpios ?? [], statusGpio: res.report.statusGpio?.gpio, spareGpios: res.report.spareGpios })
      const fwPath = `${res.outDir}/${fwId}_firmware_board.json`
      await window.api.writeFile(fwPath, JSON.stringify(fw))
      pcb.lastFirmware = { path: fwPath, id: fwId, leds: (fw.leds as unknown[]).length, chains: (fw.chains as unknown[]).length }
      say(`firmware board definition: ${fwPath} (${pcb.lastFirmware.leds} LEDs, ${pcb.lastFirmware.chains} chains)`)
      const rp = res.report
      say(`done: ${rp.leds} LEDs, ${rp.caps} caps, ${rp.vias5sw} 5SW vias; data ${rp.data?.routed ?? 0}/${rp.data?.total ?? 0} hops (${rp.data?.vias ?? 0} vias); left on art after trimming: ${rp.onArtAfterTrim.caps} caps, ${rp.onArtAfterTrim.vias} vias`)
      for (const line of pcbIssues(rp.data?.failedNets ?? [], rp.capConflictList ?? [], rp.ledsTooClose ?? [])) say(line)
      say(`files: ${res.outDir}${res.zip ? ` and ${res.zip}` : ''}`)
      return res
    })
    return r ?? null
  }

  // ---------------------------------------------------------------- back silk (Bottom Overlay)
  // The editor can show the board from the back (mirrored left-right) to check that the back art reads correctly.
  const viewBack = ref(false)
  /** Transient canvas markers (board mm): audit outliers, reference points. Not saved. */
  const markers = shallowRef<{ p: Pt; color?: string; r?: number; ring?: boolean }[]>([])
  const backArtNotes = ref<string[]>([])   // notes from the last import (skipped entries, board size mismatch)
  const backArt = computed(() => {
    void rev.back
    return project.value?.backArt ?? null
  })
  /** The imported art's extent with the offset, and whether it leaves the board. */
  const backArtExtentNow = computed(() => {
    void rev.board
    const a = backArt.value
    const p = project.value
    return a && p ? backArtExtent(a, p.board.widthMm, p.board.heightMm) : null
  })
  /** What the export will put on the Bottom Overlay. */
  const backSilkSummary = computed(() => {
    void version.value
    const p = project.value
    const on = !!p && p.layerVisibility.backsilk !== false
    const drawn = p ? p.polys.filter((x) => x.layer === 'silkBack').length + p.lines.filter((x) => x.layer === 'silkBack').length + p.labels.filter((x) => x.layer === 'silkBack').length : 0
    const imported = p?.backArt?.visible ? p.backArt.count : 0
    return { on, imported: on ? imported : 0, drawn: on ? drawn : 0, hiddenImported: !!p?.backArt && (!on || !p.backArt.visible), hiddenDrawn: !on ? drawn : 0 }
  })
  function setBackArt(art: BackArt | undefined, commit = true): void {
    if (!project.value) return
    if (commit) snapshot()
    if (art) project.value.backArt = art
    else delete project.value.backArt
    rev.back++
  }
  /** Parse a back-art file (in the worker) and put it on the project, replacing any imported art. */
  async function importBackArtText(text: string, name: string): Promise<BackArt | null> {
    const p = project.value
    if (!p) return null
    const r = await runTask(`Importing back art from ${name.split('/').pop()}`, async (say) => {
      const res = await work('backart', { text, name, prev: p.backArt ? { locked: p.backArt.locked, opacity: p.backArt.opacity } : undefined }, say)
      const notes = [...res.notes]
      if (res.boardMm && (Math.abs(res.boardMm[0] - p.board.widthMm) > 0.01 || Math.abs(res.boardMm[1] - p.board.heightMm) > 0.01))
        notes.push(`the file is for a ${res.boardMm[0]} x ${res.boardMm[1]} mm board, this one is ${p.board.widthMm} x ${p.board.heightMm} mm: check the position`)
      setBackArt(res.art)
      const e = backArtExtent(res.art, p.board.widthMm, p.board.heightMm)
      if (e.outside) notes.push(`the art reaches outside the board: x ${e.x0.toFixed(2)}..${e.x1.toFixed(2)}, y ${e.y0.toFixed(2)}..${e.y1.toFixed(2)} mm on a ${p.board.widthMm} x ${p.board.heightMm} mm board`)
      backArtNotes.value = notes
      say(`back art: ${res.art.count.toLocaleString()} polygons, ${res.art.points.toLocaleString()} points, ${res.art.areaMm2.toLocaleString()} mm², x ${e.x0.toFixed(2)}..${e.x1.toFixed(2)}, y ${e.y0.toFixed(2)}..${e.y1.toFixed(2)} mm (${(res.art.data.length / 1e6).toFixed(1)} MB stored)`)
      for (const n of notes) say(`warning: ${n}`)
      return res.art
    })
    return r ?? null
  }
  async function importBackArt(): Promise<void> {
    if (!project.value) return
    const f = await window.api.openFile([{ name: 'Back art (JSON polygons, build spec, pcbgen job, flightboard project)', extensions: ['json'] }])
    if (f) await importBackArtText(f.text, f.path)
  }
  function translateBackArt(dx: number, dy: number): void {
    const a = project.value?.backArt
    if (!a || a.locked || (!dx && !dy)) return
    setBackArt({ ...a, offset: [Math.round((a.offset[0] + dx) * 1e4) / 1e4, Math.round((a.offset[1] + dy) * 1e4) / 1e4] })
  }
  function mirrorBackArt(): void {
    const p = project.value
    const a = p?.backArt
    if (!p || !a || a.locked) return
    setBackArt(mirrorArt(a, p.board.widthMm))
    say(`back art mirrored left-right about the board centre (x = ${p.board.widthMm / 2} mm)`)
  }
  function clearBackArt(): void {
    const a = project.value?.backArt
    if (!a || a.locked) return
    setBackArt(undefined)
    backArtNotes.value = []
    say('back art cleared (undo brings it back)')
  }
  function patchBackArt(patch: Partial<Pick<BackArt, 'locked' | 'visible' | 'opacity'>>, commit = true): void {
    const a = project.value?.backArt
    if (!a) return
    setBackArt({ ...a, ...patch }, commit)
  }

  // ---------------------------------------------------------------- files
  async function save(as = false): Promise<void> {
    if (!project.value) return
    const text = JSON.stringify(project.value)
    if (filePath.value && !as) {
      await window.api.writeFile(filePath.value, text)
    } else {
      const p = await window.api.saveFile(`${project.value.board.id}.flightboard.json`, text, [{ name: 'Flightboard project', extensions: ['json'] }])
      if (!p) return
      filePath.value = p
    }
    dirty.value = false
    say(`saved ${filePath.value}`)
  }
  function loadProject(p: Project, path: string | null): void {
    if (p.version !== 1 || !p.board) throw new Error('not a flightboard project')
    project.value = p
    projectSerial++
    pcb.jobId = ''
    pcb.check = null
    pcb.chainStats = []
    pcb.selectedBlock = null
    pcb.lastExport = null
    pcb.route = null
    pcb.routeKey = ''
    if (pcb.routeSession) void window.api.pcbgenCall('routeDrop', {}, 'drop').catch(() => undefined)
    pcb.routeSession = ''
    pcb.routeInc = null
    pcb.routeNeedFull = ''
    gates.value = []
    backArtNotes.value = []
    filePath.value = path
    nodeSel.value = []
    segSel.value = []
    setSelection([])
    undoStack.length = 0
    redoStack.length = 0
    undoDepth.value = redoDepth.value = 0
    dirty.value = false
    bumpAll()
  }
  async function open(): Promise<void> {
    const r = await window.api.openFile([{ name: 'Flightboard project', extensions: ['json'] }])
    if (!r) return
    await runTask(`Opening ${r.path.split('/').pop()}`, async (say) => {
      say(`reading ${(r.text.length / 1e6).toFixed(1)} MB…`)
      const p = JSON.parse(r.text) as Project
      say(`${p.leds?.length ?? 0} LEDs, ${p.lines?.length ?? 0} lines, ${p.polys?.length ?? 0} polygons, ${p.labels?.length ?? 0} labels: drawing…`)
      loadProject(p, r.path)
      say(`opened ${r.path}`)
    })
  }
  async function exportFiles(): Promise<string | null> {
    if (!project.value) return null
    const r = await runTask('Exporting', async (say) => {
      const t0 = performance.now()
      const files = await work('export', { project: project.value! }, say)
      say(`${files.length} files ready (${((performance.now() - t0) / 1000).toFixed(1)} s): choose the folder…`)
      const dir = await window.api.exportDir(files, project.value!.board.id)
      if (dir) say(`exported ${files.map((f) => f.name).join(', ')} to ${dir}`)
      else say('export cancelled')
      return dir
    })
    return r ?? null
  }

  return {
    project, rev, version, gates, selection, selectedIds, selected, selectionBounds, tool, addPreset, shapeOpts, snap, saveSnap, fonts, ctxMenu, log, busy, filePath, dirty, buildOpts, tf, undoDepth, redoDepth,
    sources, landsideRaw, updateSource, updateSourceStyle, addSource, removeSource, resetSources, saveSourcesAsDefault, applySourcesNow, fetchAndApplySources,
    say, snapshot, undo, redo, buildFromAirport, placeLeds, generateLabelsNow, resolveCollisions, addRunwayMarkings, addDesignators, setBoard, runwayStyle, runwayResult, applyRunwayStyle,
    isSelected, setSelection, select, clearSelection, selectAll, itemBounds,
    updateLed, addLedAt, updateLabel, addLabelAt, updateLine, addLine, updatePoly, addPoly, setLayerVisible, isVisible,
    beginTransform, endTransform, moveSelectionTo, rotateSelectionTo, nudgeSelection, rotateSelectionBy, alignSelection, distributeSelection, orientSelection, lockSelection, duplicateSelection, setSelectionProps, removeSelected,
    nodeSel, segSel, nodeKeys, segKeys, setNodeSel, setSegSel, clearSub, selectNode, selectSegment, selectPathNodes, pathOf, pathPts, selectedPaths, pathStats,
    insertNode, insertMidpoints, deleteNodes, removeSegments, disconnectAtNodes, cutAt, knife, joinSelected, closeSelected, openSelected, reverseSelected, straightenNodes, averageNodes,
    simplifySelected, smoothSelected, offsetSelected, outlineSelected, pathfinderOp, explodeSelected, removeHoles, removeRing, moveNodesTo, setNodePos, extendLine, closeLine, zoomRequest, requestZoom,
    roundNodes, segmentInfo, setSegment, addShape,
    save, open, loadProject, exportFiles, task, runTask, cancelCurrentTask, dismissTask,
    viewBack, markers, backArt, backArtNotes, backArtExtentNow, backSilkSummary, importBackArt, importBackArtText, translateBackArt, mirrorBackArt, clearBackArt, patchBackArt,
    pcb, pcbTemplate, pcbJobStale, pcbInfo, pcbPrepare, pcbDescribe, pcbScheduleCheck, pcbCheckNow, pcbAutoplace, pcbAssignChains, pcbSetBlockPose, pcbClearBlockPose, pcbSetOptions, pcbAssignLeds, pcbLockLeds, pcbExport, pcbInstallFirmware, pcbPreviewRoute, pcbRouteStale, pcbRouteIncremental, pcbRouteCheck, pcbRouteCompare, pcbExportKeepsChains, pcbPinnedChains, pcbSelectDesignators, ledsTooClose, selectLeds
  }
})

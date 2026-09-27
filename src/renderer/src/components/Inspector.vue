<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProject } from '../stores/project'
import { DEFAULT_HATCH, type ArtLayer, type Label, type Led, type LineFeature, type PolyFeature } from '../core/model'
import Icon from './Icon.vue'
import PathMenu from './PathMenu.vue'
import * as pa from '../core/path'

const store = useProject()
const p = computed(() => {
  void store.version
  return store.project
})
const tf = computed(() => store.tf)
const sel = computed(() => store.selected)
const led = computed(() => (sel.value.singleKind === 'led' ? (sel.value.single as Led) : null))
const label = computed(() => (sel.value.singleKind === 'label' ? (sel.value.single as Label) : null))
const line = computed(() => (sel.value.singleKind === 'line' ? (sel.value.single as LineFeature) : null))
const poly = computed(() => (sel.value.singleKind === 'poly' ? (sel.value.single as PolyFeature) : null))
const multi = computed(() => sel.value.count > 1)

const num = (ev: Event): number => Number((ev.target as HTMLInputElement).value)
const str = (ev: Event): string => (ev.target as HTMLInputElement).value
const chk = (ev: Event): boolean => (ev.target as HTMLInputElement).checked

function ledMm(axis: 0 | 1): number {
  return led.value && tf.value ? Math.round(tf.value.toMm(led.value.pos)[axis] * 1000) / 1000 : 0
}
function setLedMm(axis: 0 | 1, v: number): void {
  if (!led.value || !tf.value) return
  const m = tf.value.toMm(led.value.pos)
  m[axis] = v
  store.updateLed(led.value.id, { pos: tf.value.toM(m), locked: true })
}
function labelMm(axis: 0 | 1): number {
  return label.value && tf.value ? Math.round(tf.value.toMm(label.value.pos)[axis] * 100) / 100 : 0
}
function setLabelMm(axis: 0 | 1, v: number): void {
  if (!label.value || !tf.value) return
  const m = tf.value.toMm(label.value.pos)
  m[axis] = v
  store.updateLabel(label.value.id, { pos: tf.value.toM(m) })
}
const labelHeightMm = computed(() => (label.value && tf.value ? Math.round(label.value.heightM * tf.value.k * 100) / 100 : 0))
function setLabelHeight(v: number): void {
  if (!label.value || !tf.value || !(v > 0)) return
  store.updateLabel(label.value.id, { heightM: v / tf.value.k })
}
function setBoardSize(w: number, h: number): void {
  if (!(w > 20 && h > 20)) return
  store.setBoard({ widthMm: w, heightMm: h })
}
// polygon hatch editing (local copy applied on change)
const hatch = ref({ ...DEFAULT_HATCH })
watch(poly, (pl) => { if (pl) hatch.value = { ...(pl.hatch ?? DEFAULT_HATCH) } }, { immediate: true })
function applyHatch(): void {
  if (poly.value) store.updatePoly(poly.value.id, { hatch: { ...hatch.value } })
}
const bounds = computed(() => store.selectionBounds)

// ---- path editing
const pathItem = computed(() => (line.value ? store.pathOf(line.value.id) : poly.value ? store.pathOf(poly.value.id) : null))
const stats = computed(() => {
  void store.version
  return pathItem.value ? store.pathStats(pathItem.value) : null
})
const oneNode = computed(() => {
  void store.rev.sel
  void store.version
  if (store.nodeSel.length !== 1 || !tf.value) return null
  const r = store.nodeSel[0]
  const pi = store.pathOf(r.id)
  const q = pi ? store.pathPts(pi, r.ring)[r.idx] : null
  return q ? { r, mm: tf.value.toMm(q) } : null
})
const oneSeg = computed(() => {
  void store.rev.sel
  void store.version
  if (store.segSel.length !== 1) return null
  const r = store.segSel[0]
  const info = store.segmentInfo(r)
  return info ? { r, ...info } : null
})
function setNode(axis: 0 | 1, v: number): void {
  const n = oneNode.value
  if (!n || !Number.isFinite(v)) return
  const mm: [number, number] = [n.mm[0], n.mm[1]]
  mm[axis] = v
  store.setNodePos(n.r, mm)
}
const pathTools = computed(() => ['node', 'pen', 'scissors', 'knife'].includes(store.tool))
const shapeTool = computed(() => ['rect', 'ellipse', 'star'].includes(store.tool))
const nodeCount = computed(() => {
  void store.rev.sel
  return store.nodeSel.length
})
const r2 = (v: number): number => Math.round(v * 1000) / 1000

// ---- PCB: the selected generator block and LED chains
const blockName = computed(() => (sel.value.count ? null : store.pcb.selectedBlock))
const blockDesc = computed(() => store.pcb.describe?.blocks.find((b) => b.name === blockName.value) ?? null)
const blockPose = computed(() => {
  void store.rev.pcb
  return store.project?.pcb?.blocks.find((b) => b.name === blockName.value) ?? null
})
const blockCheck = computed(() => store.pcb.check?.blocks.find((b) => b.name === blockName.value) ?? null)
function setPose(patch: Record<string, unknown>): void {
  if (!blockPose.value) return
  store.pcbSetBlockPose({ ...blockPose.value, ...patch } as typeof blockPose.value & { name: string })
}
const ledIds = computed(() => sel.value.leds.map((l) => l.id))
const chainOf = computed(() => {
  void store.rev.pcb
  const ls = sel.value.leds
  if (!ls.length) return null
  const chains = new Set(ls.map((l) => (l.chainUser ? l.chain : 0)))
  return { user: chains.size === 1 ? [...chains][0] ?? 0 : -1, locked: ls.every((l) => l.chainLocked), any: ls.some((l) => l.chain) }
})
void pa
</script>

<template>
  <div v-if="p && tf">
    <!-- PCB block (Altium generator) -->
    <template v-if="blockName && blockDesc">
      <h3>Block <span class="muted">{{ blockName }}</span></h3>
      <div class="small muted">{{ blockDesc.rule === 'free' ? 'anywhere on the board, LED-free' : blockDesc.rule === 'edge-antenna' ? 'on a board edge, antenna pointing out' : 'on a board edge (connector side out)' }} · {{ blockDesc.size.w.toFixed(1) }} × {{ blockDesc.size.h.toFixed(1) }} mm</div>
      <template v-if="blockPose">
        <template v-if="blockDesc.rule !== 'free'">
          <label class="row"><span>Edge</span><select :value="blockPose.edge ?? 'bottom'" @change="setPose({ edge: str($event) })"><option value="top">top</option><option value="bottom">bottom</option><option value="left">left</option><option value="right">right</option></select></label>
          <label class="row"><span>Along edge mm</span><input type="number" step="0.5" :value="blockPose.t ?? 0" @change="setPose({ t: num($event) })" /></label>
        </template>
        <template v-else>
          <label class="row"><span>X mm</span><input type="number" step="0.5" :value="blockPose.x ?? 0" @change="setPose({ x: num($event) })" /></label>
          <label class="row"><span>Y mm</span><input type="number" step="0.5" :value="blockPose.y ?? 0" @change="setPose({ y: num($event) })" /></label>
          <label class="row"><span>Rotation °</span><select :value="blockPose.rot ?? 0" @change="setPose({ rot: num($event) })"><option :value="0">0</option><option :value="90">90</option><option :value="180">180</option><option :value="270">270</option></select></label>
        </template>
        <div v-if="blockCheck" class="small">
          <div :class="blockCheck.ok ? 'ok' : 'bad'">{{ blockCheck.ok ? 'placement OK' : 'placement problems:' }}</div>
          <div v-for="v in blockCheck.violations" :key="v" class="bad">· {{ v }}</div>
          <div class="muted">art under the block (cut away): silk {{ blockCheck.silkMm2 }} mm², copper {{ blockCheck.copperMm2 }} mm²<template v-if="blockCheck.usbGapMm !== undefined"> · {{ blockCheck.usbGapMm }} mm from the USB-C block</template></div>
        </div>
        <div class="btns"><button title="Let the generator place it" @click="store.pcbClearBlockPose(blockName!)">Automatic</button><button v-if="blockDesc.rule === 'free'" @click="setPose({ rot: (((blockPose.rot ?? 0) + 90) % 360) })"><Icon name="rotate" /> 90°</button></div>
      </template>
      <div v-else class="small muted">placed automatically (auto-place or drag it to fix a pose)</div>
    </template>
    <!-- tool options -->
    <div v-if="pathTools || shapeTool || nodeCount" class="toolopts">
      <h3>Tool options</h3>
      <template v-if="store.tool === 'rect'">
        <label class="row"><span>Corner R mm</span><input v-model.number="store.shapeOpts.cornerMm" type="number" step="0.25" min="0" /></label>
      </template>
      <template v-if="store.tool === 'star'">
        <label class="row"><span>Sides / points</span><input v-model.number="store.shapeOpts.sides" type="number" step="1" min="3" max="64" /></label>
        <label class="row"><span>Inner ratio</span><input v-model.number="store.shapeOpts.inner" type="number" step="0.05" min="0" max="1" title="0 = regular polygon, otherwise a star" /></label>
      </template>
      <template v-if="shapeTool">
        <label class="row"><span>New shape</span><select v-model="store.addPreset.polyFill"><option value="none">outline</option><option value="solid">solid</option><option value="hatch">hatch</option></select></label>
        <label class="row"><span>Layer</span><select v-model="store.addPreset.layer"><option value="silk">silkscreen</option><option value="copper">copper</option><option value="silkBack">back silkscreen</option></select></label>
        <label class="row"><span>Outline mm</span><input v-model.number="store.addPreset.lineWidthMm" type="number" step="0.05" min="0" /></label>
      </template>
      <template v-if="pathTools || nodeCount">
        <label class="row"><span>Fillet / chamfer</span><input v-model.number="store.shapeOpts.filletMm" type="number" step="0.25" min="0.05" title="Radius of a fillet or setback of a chamfer, mm" /></label>
        <label class="row"><span>Offset mm</span><input v-model.number="store.shapeOpts.offsetMm" type="number" step="0.1" min="0.01" /></label>
        <label class="row"><span>Simplify mm</span><input v-model.number="store.shapeOpts.simplifyMm" type="number" step="0.01" min="0.005" /></label>
      </template>
    </div>
    <!-- multi selection -->
    <template v-if="multi">
      <h3>{{ sel.count }} items selected</h3>
      <div class="small muted">{{ sel.leds.length }} LEDs · {{ sel.labels.length }} labels · {{ sel.lines.length }} lines · {{ sel.polys.length }} polygons</div>
      <div v-if="bounds" class="small muted">bounds {{ (bounds.x1 - bounds.x0).toFixed(2) }} × {{ (bounds.y1 - bounds.y0).toFixed(2) }} mm</div>
      <h3>Align</h3>
      <div class="row6">
        <button title="Left" @click="store.alignSelection('left')"><Icon name="alignLeft" /></button>
        <button title="H centres" @click="store.alignSelection('hcenter')"><Icon name="alignHCenter" /></button>
        <button title="Right" @click="store.alignSelection('right')"><Icon name="alignRight" /></button>
        <button title="Top" @click="store.alignSelection('top')"><Icon name="alignTop" /></button>
        <button title="V centres" @click="store.alignSelection('vcenter')"><Icon name="alignVCenter" /></button>
        <button title="Bottom" @click="store.alignSelection('bottom')"><Icon name="alignBottom" /></button>
      </div>
      <div class="btns">
        <button :disabled="sel.count < 3" @click="store.distributeSelection('h')"><Icon name="distH" /> Space H</button>
        <button :disabled="sel.count < 3" @click="store.distributeSelection('v')"><Icon name="distV" /> Space V</button>
      </div>
      <h3>Orientation</h3>
      <div class="btns">
        <button @click="store.orientSelection('match')">Match first</button>
        <button @click="store.orientSelection('nearest90')">Nearest 90°</button>
        <button @click="store.orientSelection('line')">Follow line</button>
        <button @click="store.tool = 'rotate'"><Icon name="rotate" /> Cursor</button>
      </div>
      <label class="row"><span>Set rotation °</span><input type="number" step="1" placeholder="apply to all" @change="store.orientSelection('set', num($event))" /></label>
      <template v-if="sel.lines.length || sel.polys.length">
        <h3>Paths</h3>
        <PathMenu compact />
      </template>
      <template v-if="sel.leds.length">
        <h3>LEDs</h3>
        <label class="row"><span>Size</span><select @change="store.setSelectionProps({ size: Number(str($event)) as Led['size'] })"><option value="">—</option><option :value="1.5">1.5 mm</option><option :value="1.1">1.1 mm</option><option :value="1.0">1.0 mm</option></select></label>
        <label class="row"><span>Class</span><select @change="store.setSelectionProps({ cls: str($event) as Led['cls'] })"><option value="">—</option><option value="runway">runway</option><option value="taxiway">taxiway</option><option value="ramp">ramp</option><option value="gate">gate</option></select></label>
        <label class="row"><span>Role</span><select @change="store.setSelectionProps({ role: str($event) as Led['role'] })"><option value="">plain</option><option value="junction">junction</option><option value="entry">entry</option><option value="hold">hold</option></select></label>
      </template>
      <template v-if="sel.leds.length && chainOf">
        <h3>Data chain</h3>
        <label class="row"><span>Chain</span><select :value="chainOf.user >= 0 ? chainOf.user : ''" @change="store.pcbAssignLeds(ledIds, Number(str($event)) || null)"><option v-if="chainOf.user < 0" value="">mixed</option><option :value="0">automatic</option><option v-for="k in 7" :key="k" :value="k">CH{{ k }}</option></select></label>
        <label class="row"><span>Keep positions</span><input type="checkbox" :checked="chainOf.locked" :disabled="!chainOf.any" @change="store.pcbLockLeds(ledIds, chk($event))" /></label>
      </template>
      <template v-if="sel.labels.length">
        <h3>Labels</h3>
        <label class="row"><span>Height mm</span><input type="number" step="0.1" @change="store.setSelectionProps({ heightM: num($event) / tf.k })" /></label>
        <label class="row"><span>Layer</span><select @change="store.setSelectionProps({ layer: str($event) as Label['layer'] })"><option value="">—</option><option value="silk">silkscreen</option><option value="copper">copper</option><option value="silkBack">back silkscreen</option></select></label>
        <label class="row"><span>Letter spacing</span><input type="number" step="0.02" min="0" placeholder="apply to all" @change="store.setSelectionProps({ tracking: num($event) })" /></label>
      </template>
      <div class="btns">
        <button @click="store.lockSelection(true)"><Icon name="lock" /> Lock</button>
        <button @click="store.lockSelection(false)"><Icon name="unlock" /> Unlock</button>
        <button @click="store.duplicateSelection()"><Icon name="copy" /> Duplicate</button>
        <button @click="store.removeSelected()"><Icon name="trash" /> Delete</button>
      </div>
    </template>
    <!-- single LED -->
    <template v-else-if="led">
      <h3>LED <span class="muted">{{ led.locked ? '· locked' : '' }}</span></h3>
      <label class="row"><span>Class</span><select :value="led.cls" @change="store.updateLed(led.id, { cls: str($event) as Led['cls'], locked: true })"><option value="runway">runway</option><option value="taxiway">taxiway</option><option value="ramp">ramp</option><option value="gate">gate</option></select></label>
      <label class="row"><span>Size</span><select :value="led.size" @change="store.updateLed(led.id, { size: Number(str($event)) as Led['size'], locked: true })"><option :value="1.5">1.5 mm</option><option :value="1.1">1.1 mm</option><option :value="1.0">1.0 mm</option></select></label>
      <label class="row"><span>Role</span><select :value="led.role" @change="store.updateLed(led.id, { role: str($event) as Led['role'], locked: true })"><option value="">plain</option><option value="junction">junction</option><option value="entry">entry</option><option value="hold">hold</option></select></label>
      <label class="row"><span>Rotation °</span><input type="number" step="1" :value="Math.round(led.rotDeg * 100) / 100" @change="store.updateLed(led.id, { rotDeg: num($event), locked: true })" /></label>
      <div class="btns"><button @click="store.orientSelection('nearest90')">Nearest 90°</button><button @click="store.orientSelection('line')">Follow line</button><button @click="store.tool = 'rotate'"><Icon name="rotate" /></button></div>
      <label class="row"><span>X mm</span><input type="number" step="0.1" :value="ledMm(0)" @change="setLedMm(0, num($event))" /></label>
      <label class="row"><span>Y mm</span><input type="number" step="0.1" :value="ledMm(1)" @change="setLedMm(1, num($event))" /></label>
      <label class="row"><span>Label</span><input :value="led.label" @change="store.updateLed(led.id, { label: str($event) })" /></label>
      <label class="row"><span>Feature</span><input :value="led.feature" @change="store.updateLed(led.id, { feature: str($event) })" /></label>
      <label class="row"><span>Locked</span><input type="checkbox" :checked="!!led.locked" @change="store.updateLed(led.id, { locked: chk($event) })" /></label>
      <div class="btns"><button @click="store.duplicateSelection()"><Icon name="copy" /> Duplicate</button><button @click="store.removeSelected()"><Icon name="trash" /> Delete</button></div>
      <h3>Data chain</h3>
      <div class="small muted">{{ led.chain ? `CH${led.chain}, position ${(led.chainIndex ?? 0) + 1}` : 'not assigned yet (PCB tab: Assign chains)' }}{{ led.chainUser ? ' · assigned by hand' : '' }}</div>
      <label class="row"><span>Chain</span><select :value="led.chainUser ? led.chain : 0" @change="store.pcbAssignLeds([led.id], Number(str($event)) || null)"><option :value="0">automatic</option><option v-for="k in 7" :key="k" :value="k">CH{{ k }}</option></select></label>
      <label class="row"><span>Keep position</span><input type="checkbox" :checked="!!led.chainLocked" :disabled="!led.chain" title="Keep this LED's position in its chain when chains are assigned again" @change="store.pcbLockLeds([led.id], chk($event))" /></label>
    </template>
    <!-- single label -->
    <template v-else-if="label">
      <h3>Label</h3>
      <label class="row"><span>Text</span><input :value="label.text" @change="store.updateLabel(label.id, { text: str($event) })" /></label>
      <label class="row"><span>Height mm</span><input type="number" step="0.1" :value="labelHeightMm" @change="setLabelHeight(num($event))" /></label>
      <label class="row"><span>Rotation °</span><input type="number" step="1" :value="Math.round(label.rotDeg * 100) / 100" @change="store.updateLabel(label.id, { rotDeg: num($event) })" /></label>
      <div v-if="label.layer === 'silkBack'" class="small muted">Back silk: printed mirrored so it reads from the back. The rotation is as seen from the back; X / Y are board coordinates from the top.</div>
      <label class="row"><span>X mm</span><input type="number" step="0.1" :value="labelMm(0)" @change="setLabelMm(0, num($event))" /></label>
      <label class="row"><span>Y mm</span><input type="number" step="0.1" :value="labelMm(1)" @change="setLabelMm(1, num($event))" /></label>
      <label class="row"><span>Layer</span><select :value="label.layer" @change="store.updateLabel(label.id, { layer: str($event) as Label['layer'] })"><option value="silk">silkscreen</option><option value="copper">copper</option><option value="silkBack">back silkscreen</option></select></label>
      <label class="row"><span>Weight</span><select :value="label.weight" @change="store.updateLabel(label.id, { weight: Number(str($event)) as Label['weight'] })"><option :value="400">regular</option><option :value="600">semibold</option></select></label>
      <label class="row"><span>Anchor</span><select :value="label.anchor" @change="store.updateLabel(label.id, { anchor: str($event) as Label['anchor'] })"><option value="start">start</option><option value="middle">middle</option><option value="end">end</option></select></label>
      <label class="row"><span>Letter spacing</span><input type="number" step="0.02" min="0" :value="label.tracking ?? 0" title="Extra space between letters as a fraction of the cap height (0.18 = the ORD board's map labels)" @change="store.updateLabel(label.id, { tracking: num($event) || undefined })" /></label>
      <label class="row"><span>Boxed sign</span><input type="checkbox" :checked="!!label.boxed" @change="store.updateLabel(label.id, { boxed: chk($event) })" /></label>
      <label class="row"><span>Locked</span><input type="checkbox" :checked="!!label.locked" @change="store.updateLabel(label.id, { locked: chk($event) })" title="Locked labels are kept by 'Regenerate labels' and never moved by collision resolution" /></label>
      <div class="btns"><button @click="store.duplicateSelection()"><Icon name="copy" /> Duplicate</button><button @click="store.removeSelected()"><Icon name="trash" /> Delete</button></div>
    </template>
    <!-- single line -->
    <template v-else-if="line">
      <h3>Line</h3>
      <label class="row"><span>Class</span><select :value="line.cls" @change="store.updateLine(line.id, { cls: str($event) as LineFeature['cls'] })"><option value="taxiway">taxiway</option><option value="taxilane">apron lane</option><option value="runway_cl">runway marking</option><option value="road_major">motorway</option><option value="road">road</option><option value="road_minor">minor road</option><option value="rail">rail</option><option value="custom">custom</option></select></label>
      <label class="row"><span>Name</span><input :value="line.name ?? ''" @change="store.updateLine(line.id, { name: str($event) })" /></label>
      <label class="row"><span>Layer</span><select :value="line.layer ?? 'silk'" @change="store.updateLine(line.id, { layer: str($event) as ArtLayer })"><option value="silk">silkscreen</option><option value="copper">copper</option><option value="silkBack">back silkscreen</option></select></label>
      <label class="row"><span>Width mm</span><input type="number" step="0.05" :value="line.widthMm ?? ''" placeholder="class default" @change="store.updateLine(line.id, { widthMm: num($event) || undefined })" /></label>
      <label v-if="line.cls === 'runway_cl'" class="row"><span>Runway axis</span><input type="checkbox" :checked="line.sub === 'axis'" @change="store.updateLine(line.id, { sub: chk($event) ? 'axis' : 'marking' })" title="Axis lines drive runway LED placement and markings" /></label>
      <div class="btns"><button @click="store.duplicateSelection()"><Icon name="copy" /> Duplicate</button><button @click="store.removeSelected()"><Icon name="trash" /> Delete</button></div>
      <template v-if="stats">
        <h3>Path</h3>
        <div class="small muted">{{ stats.verts }} vertices · length {{ stats.lengthMm.toFixed(2) }} mm ({{ (stats.lengthMm / tf.k).toFixed(0) }} m)</div>
        <div class="btns"><button :class="{ active: store.tool === 'node' }" @click="store.tool = 'node'"><Icon name="node" /> Edit nodes</button><button @click="store.tool = 'node'; store.selectPathNodes(line.id)">Select all nodes</button></div>
        <template v-if="oneNode">
          <label class="row"><span>Node X mm</span><input type="number" step="0.1" :value="r2(oneNode.mm[0])" @change="setNode(0, num($event))" /></label>
          <label class="row"><span>Node Y mm</span><input type="number" step="0.1" :value="r2(oneNode.mm[1])" @change="setNode(1, num($event))" /></label>
        </template>
        <template v-if="oneSeg">
          <label class="row"><span>Segment mm</span><input type="number" step="0.1" min="0.01" :value="r2(oneSeg.lengthMm)" @change="store.setSegment(oneSeg.r, { lengthMm: num($event) })" /></label>
          <label class="row"><span>Angle °</span><input type="number" step="1" :value="Math.round(oneSeg.angleDeg * 100) / 100" @change="store.setSegment(oneSeg.r, { angleDeg: num($event) })" /></label>
        </template>
        <PathMenu compact />
      </template>
    </template>
    <!-- single polygon -->
    <template v-else-if="poly">
      <h3>Polygon <span class="muted">{{ poly.cls }}</span></h3>
      <label class="row"><span>Name</span><input :value="poly.name ?? ''" @change="store.updatePoly(poly.id, { name: str($event) })" /></label>
      <label class="row"><span>Layer</span><select :value="poly.layer ?? (poly.cls === 'terminal' ? 'copper' : 'silk')" @change="store.updatePoly(poly.id, { layer: str($event) as ArtLayer })"><option value="silk">silkscreen</option><option value="copper">copper</option><option value="silkBack">back silkscreen</option></select></label>
      <label class="row"><span>Fill</span><select :value="poly.fill ?? (poly.cls === 'terminal' ? 'hatch' : 'none')" @change="store.updatePoly(poly.id, { fill: str($event) as PolyFeature['fill'] })"><option value="none">outline only</option><option value="solid">solid</option><option value="hatch">hatch</option></select></label>
      <label class="row"><span>Outline mm</span><input type="number" step="0.05" :value="poly.strokeMm ?? ''" placeholder="class default (0 = none)" @change="store.updatePoly(poly.id, { strokeMm: str($event) === '' ? undefined : num($event) })" /></label>
      <h3>Hatch</h3>
      <label class="row"><span>Angle °</span><input v-model.number="hatch.angleDeg" type="number" step="15" @change="applyHatch" /></label>
      <label class="row"><span>Pitch mm</span><input v-model.number="hatch.pitchMm" type="number" step="0.1" min="0.2" @change="applyHatch" /></label>
      <label class="row"><span>Line mm</span><input v-model.number="hatch.widthMm" type="number" step="0.05" min="0.05" @change="applyHatch" /></label>
      <label class="row"><span>Cross</span><input v-model="hatch.cross" type="checkbox" @change="applyHatch" /></label>
      <div class="btns"><button @click="store.duplicateSelection()"><Icon name="copy" /> Duplicate</button><button @click="store.removeSelected()"><Icon name="trash" /> Delete</button></div>
      <template v-if="stats">
        <h3>Path</h3>
        <div class="small muted">{{ poly.rings.length }} ring(s) · {{ stats.verts }} vertices · perimeter {{ stats.lengthMm.toFixed(2) }} mm · area {{ stats.areaMm2.toFixed(2) }} mm²</div>
        <div class="btns"><button :class="{ active: store.tool === 'node' }" @click="store.tool = 'node'"><Icon name="node" /> Edit nodes</button><button @click="store.tool = 'node'; store.selectPathNodes(poly.id)">Select all nodes</button></div>
        <div v-for="(r, ri) in poly.rings.slice(1)" :key="ri" class="ring small"><span class="muted">hole {{ ri + 1 }} · {{ r.length }} vertices</span><button title="Remove this hole" @click="store.removeRing(poly.id, ri + 1)"><Icon name="trash" /></button></div>
        <template v-if="oneNode">
          <label class="row"><span>Node X mm</span><input type="number" step="0.1" :value="r2(oneNode.mm[0])" @change="setNode(0, num($event))" /></label>
          <label class="row"><span>Node Y mm</span><input type="number" step="0.1" :value="r2(oneNode.mm[1])" @change="setNode(1, num($event))" /></label>
        </template>
        <template v-if="oneSeg">
          <label class="row"><span>Segment mm</span><input type="number" step="0.1" min="0.01" :value="r2(oneSeg.lengthMm)" @change="store.setSegment(oneSeg.r, { lengthMm: num($event) })" /></label>
          <label class="row"><span>Angle °</span><input type="number" step="1" :value="Math.round(oneSeg.angleDeg * 100) / 100" @change="store.setSegment(oneSeg.r, { angleDeg: num($event) })" /></label>
        </template>
        <PathMenu compact />
      </template>
    </template>
    <!-- nothing selected: board -->
    <template v-else>
      <h3>Board</h3>
      <label class="row"><span>Name</span><input :value="p.board.name" @change="store.setBoard({ name: str($event) })" /></label>
      <label class="row"><span>ID</span><input :value="p.board.id" @change="store.setBoard({ id: str($event) })" /></label>
      <label class="row"><span>Width mm</span><input type="number" step="1" :value="p.board.widthMm" @change="setBoardSize(num($event), p.board.heightMm)" /></label>
      <label class="row"><span>Height mm</span><input type="number" step="1" :value="p.board.heightMm" @change="setBoardSize(p.board.widthMm, num($event))" /></label>
      <label class="row"><span>Margin mm</span><input type="number" step="0.5" :value="p.board.marginMm" @change="store.setBoard({ marginMm: num($event) })" /></label>
      <label class="row"><span>Corner R mm</span><input type="number" step="0.5" :value="p.board.cornerRadiusMm" @change="store.setBoard({ cornerRadiusMm: num($event) })" /></label>
      <p class="muted small">Scale 1:{{ Math.round(tf.scale).toLocaleString() }} · {{ tf.k.toFixed(4) }} mm/m · map frame {{ tf.frameWmm.toFixed(1) }} × {{ tf.frameHmm.toFixed(1) }} mm. Changing the size rescales all map elements; LED bodies keep their physical size, so re-run placement to restore the pitch.</p>
      <h3>Counts</h3>
      <div class="small">{{ p.leds.length }} LEDs ({{ p.leds.filter((l) => l.size === 1.5).length }} × 1.5, {{ p.leds.filter((l) => l.size === 1.1).length }} × 1.1, {{ p.leds.filter((l) => l.size === 1.0).length }} × 1.0) · {{ p.labels.length }} labels · {{ p.lines.length }} lines · {{ p.polys.length }} polygons</div>
      <h3>Source</h3>
      <div class="small muted">OSM {{ p.source.osmElements }} elements ({{ p.source.osmFetchedAt?.slice(0, 16) }})<br />FAA: {{ p.source.faaLayers ? Object.entries(p.source.faaLayers).map(([k, v]) => `${k.replace('AM_', '')} ${v}`).join(', ') : 'not used' }}</div>
    </template>
  </div>
  <div v-else class="muted">Search for an airport and build a board.</div>
</template>

<style scoped>
.row6 { display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; }
.row6 button { padding: 5px 0; display: inline-flex; justify-content: center; }
.btns button { display: inline-flex; align-items: center; gap: 4px; }
.toolopts { border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-bottom: 4px; }
.ok { color: #3fb950; }
.bad { color: var(--danger); }
.ring { display: flex; align-items: center; justify-content: space-between; padding: 2px 0; }
.ring button { padding: 2px 6px; }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProject, type Tool } from '../stores/project'
import Icon from './Icon.vue'
import MenuButton from './MenuButton.vue'
import PathMenu from './PathMenu.vue'

const store = useProject()
const emit = defineEmits<{ (e: 'fit'): void }>()
interface ToolDef { id: Tool; icon: string; label: string; key: string }
// grouped like Illustrator's tool bar: selection, drawing, cutting / transform
const toolGroups: ToolDef[][] = [
  [
    { id: 'select', icon: 'cursor', label: 'Select', key: 'V' },
    { id: 'node', icon: 'node', label: 'Node (direct select)', key: 'A' },
    { id: 'pan', icon: 'hand', label: 'Pan', key: 'H' }
  ],
  [
    { id: 'addLed', icon: 'led', label: 'LED', key: 'L' },
    { id: 'addLine', icon: 'line', label: 'Line', key: 'N' },
    { id: 'addPoly', icon: 'polygon', label: 'Polygon (click points)', key: 'P' },
    { id: 'pen', icon: 'pen', label: 'Pen: draw, add / remove nodes, continue lines', key: 'E' },
    { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'B' },
    { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
    { id: 'star', icon: 'star', label: 'Polygon / star', key: 'Y' },
    { id: 'addLabel', icon: 'text', label: 'Label', key: 'T' }
  ],
  [
    { id: 'scissors', icon: 'scissors', label: 'Scissors: cut a path at a point', key: 'C' },
    { id: 'knife', icon: 'knife', label: 'Knife: slice across paths', key: 'K' },
    { id: 'rotate', icon: 'rotate', label: 'Rotate with cursor', key: 'R' },
    { id: 'measure', icon: 'ruler', label: 'Measure', key: 'M' }
  ]
]
const allTools = toolGroups.flat()
const activeLabel = computed(() => allTools.find((t) => t.id === store.tool)?.label.split(':')[0].split(' (')[0] ?? '')
const pathMenu = ref<InstanceType<typeof MenuButton> | null>(null)
const sel = computed(() => store.selected)
const snapOn = computed(() => store.snap.grid || store.snap.objects || store.snap.lines || store.snap.guides)
const has = computed(() => !!store.project)
</script>

<template>
  <header class="tb">
    <div class="brand">Flightboard<span>Studio</span></div>
    <MenuButton label="File" title="Open, save, export">
      <div class="mi" @click="store.open()"><Icon name="open" /> Open project… <span class="k">⌘O</span></div>
      <div class="mi" :class="{ dis: !has }" @click="has && store.save(false)"><Icon name="save" /> Save <span class="k">⌘S</span></div>
      <div class="mi" :class="{ dis: !has }" @click="has && store.save(true)"><Icon name="save" /> Save as…</div>
      <div class="sep" />
      <div class="mi" :class="{ dis: !has }" @click="has && store.exportFiles()"><Icon name="export" /> Export board, lights and artwork… <span class="k">⌘E</span></div>
      <div class="sep" />
      <div class="mi" :class="{ dis: !has }" title="Bottom Overlay art: a list of polygons in board mm, a pcbgen / Python build spec (silk_back), a pcbgen job or another flightboard project. Replaces the imported back art." @click="has && store.importBackArt()"><Icon name="open" /> Import back art…</div>
    </MenuButton>
    <span class="vsep" />
    <div class="tools">
      <template v-for="(g, gi) in toolGroups" :key="gi">
        <span v-if="gi" class="tsep" />
        <button v-for="t in g" :key="t.id" :class="{ active: store.tool === t.id }" :title="`${t.label} (${t.key})`" @click="store.tool = t.id">
          <Icon :name="t.icon" />
        </button>
      </template>
      <span class="toolname">{{ activeLabel }}</span>
    </div>
    <span class="vsep" />
    <MenuButton label="Arrange" title="Align, distribute, orient the selection" :active="sel.count > 1">
      <div class="grp">Align ({{ sel.count }} selected)</div>
      <div class="row">
        <button :disabled="sel.count < 2" title="Left" @click="store.alignSelection('left')"><Icon name="alignLeft" /></button>
        <button :disabled="sel.count < 2" title="Horizontal centres" @click="store.alignSelection('hcenter')"><Icon name="alignHCenter" /></button>
        <button :disabled="sel.count < 2" title="Right" @click="store.alignSelection('right')"><Icon name="alignRight" /></button>
        <button :disabled="sel.count < 2" title="Top" @click="store.alignSelection('top')"><Icon name="alignTop" /></button>
        <button :disabled="sel.count < 2" title="Vertical centres" @click="store.alignSelection('vcenter')"><Icon name="alignVCenter" /></button>
        <button :disabled="sel.count < 2" title="Bottom" @click="store.alignSelection('bottom')"><Icon name="alignBottom" /></button>
      </div>
      <div class="grp">Distribute</div>
      <div class="row">
        <button :disabled="sel.count < 3" @click="store.distributeSelection('h')"><Icon name="distH" /> Horizontally</button>
        <button :disabled="sel.count < 3" @click="store.distributeSelection('v')"><Icon name="distV" /> Vertically</button>
      </div>
      <div class="grp">Orientation</div>
      <div class="mi" @click="store.orientSelection('match')"><Icon name="compass" /> Match first selected</div>
      <div class="mi" @click="store.orientSelection('nearest90')"><Icon name="compass" /> Orient to nearest 90°</div>
      <div class="mi" @click="store.orientSelection('line')"><Icon name="compass" /> Follow nearest centreline</div>
      <div class="mi" @click="store.rotateSelectionBy(90)"><Icon name="rotate" /> Rotate 90° CCW <span class="k">⇧R</span></div>
      <div class="mi" @click="store.rotateSelectionBy(-90)"><Icon name="rotate" /> Rotate 90° CW</div>
      <div class="sep" />
      <div class="mi" @click="store.duplicateSelection()"><Icon name="copy" /> Duplicate <span class="k">⌘D</span></div>
      <div class="mi" @click="store.lockSelection(true)"><Icon name="lock" /> Lock</div>
      <div class="mi" @click="store.lockSelection(false)"><Icon name="unlock" /> Unlock</div>
      <div class="mi" @click="store.removeSelected()"><Icon name="trash" /> Delete <span class="k">Del</span></div>
    </MenuButton>
    <MenuButton ref="pathMenu" label="Path" title="Node, segment and path operations, pathfinder" :active="store.tool === 'node' || store.tool === 'pen'">
      <PathMenu @done="pathMenu?.close()" />
    </MenuButton>
    <MenuButton label="Snap" title="Snapping while moving and rotating" :active="snapOn" @pick="store.saveSnap()">
      <label class="ck"><input v-model="store.snap.objects" type="checkbox" /> <Icon name="magnet" /> Object centres and vertices</label>
      <label class="ck"><input v-model="store.snap.lines" type="checkbox" /> <Icon name="line" /> Points on centrelines and edges</label>
      <label class="ck"><input v-model="store.snap.guides" type="checkbox" /> <Icon name="alignHCenter" /> Smart alignment guides</label>
      <label class="ck"><input v-model="store.snap.grid" type="checkbox" /> <Icon name="grid" /> Grid</label>
      <label class="row2"><span>Grid mm</span><input v-model.number="store.snap.gridMm" type="number" step="0.1" min="0.05" /></label>
      <label class="ck"><input v-model="store.snap.angle" type="checkbox" /> <Icon name="rotate" /> Rotation steps</label>
      <label class="row2"><span>Step °</span><input v-model.number="store.snap.angleStepDeg" type="number" step="1" min="1" /></label>
      <label class="row2"><span>Tolerance px</span><input v-model.number="store.snap.tolerancePx" type="number" step="1" min="1" /></label>
      <p class="hint">Hold ⌥ while dragging to disable snapping, ⇧ to constrain to an axis.</p>
    </MenuButton>
    <MenuButton label="Labels" title="Automatic label tools">
      <div class="mi" @click="store.resolveCollisions()"><Icon name="target" /> Resolve label collisions</div>
      <div class="mi" @click="store.generateLabelsNow()"><Icon name="text" /> Regenerate all labels</div>
    </MenuButton>
    <span class="vsep" />
    <button :disabled="!store.undoDepth" title="Undo (⌘Z)" @click="store.undo()"><Icon name="undo" /></button>
    <button :disabled="!store.redoDepth" title="Redo (⇧⌘Z)" @click="store.redo()"><Icon name="redo" /></button>
    <button :disabled="!has" title="Fit board (F)" @click="emit('fit')"><Icon name="fit" /></button>
    <button :disabled="!has" class="side" :class="{ active: store.viewBack }" :title="store.viewBack ? 'Showing the board from the back (mirrored left-right): click for the front' : 'Showing the board from the front: click to view it from the back (mirrored), to check the back silk reads correctly'" @click="store.viewBack = !store.viewBack">{{ store.viewBack ? 'Back view' : 'Front view' }}</button>
    <span class="grow" />
    <span v-if="store.project" class="status" :data-rev="store.version">
      {{ store.project.board.icao }} · {{ store.project.board.widthMm }} × {{ store.project.board.heightMm }} mm · {{ store.project.leds.length }} LEDs · {{ sel.count }} selected{{ store.dirty ? ' · unsaved' : '' }}
    </span>
    <span v-if="store.busy" class="busy">working…</span>
  </header>
</template>

<style scoped>
.tb { grid-column: 1 / -1; display: flex; align-items: center; gap: 4px; padding: 0 8px; background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { font-weight: 600; margin-right: 8px; letter-spacing: 0.02em; }
.brand span { color: var(--accent); margin-left: 4px; font-weight: 400; }
.vsep { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }
.tools { display: flex; gap: 2px; }
.tools { align-items: center; }
.tools button { display: inline-flex; align-items: center; justify-content: center; padding: 4px 6px; min-width: 30px; }
.tsep { width: 1px; height: 18px; background: var(--line); margin: 0 3px; }
.toolname { font-size: 12px; color: var(--muted); margin-left: 6px; min-width: 64px; }
.grow { flex: 1; }
.side { font-size: 12px; padding: 3px 8px; }
.side.active { border-color: #b58cff; color: #b58cff; }
.status { color: var(--muted); font-size: 12px; }
.busy { color: var(--accent2); margin-left: 8px; }
.mi { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.mi:hover { background: #2a3a55; }
.mi.dis { opacity: 0.4; cursor: default; }
.k { margin-left: auto; color: var(--muted); font-size: 11px; }
.sep { height: 1px; background: var(--line); margin: 4px 0; }
.grp { padding: 4px 8px 2px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.row { display: flex; gap: 3px; padding: 2px 6px; }
.row button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 5px; }
.ck { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 12px; cursor: pointer; }
.ck input { width: auto; }
.row2 { display: grid; grid-template-columns: 1fr 70px; align-items: center; gap: 6px; padding: 3px 8px 3px 30px; font-size: 12px; color: var(--muted); }
.hint { color: var(--muted); font-size: 11px; padding: 4px 8px; margin: 0; }
</style>

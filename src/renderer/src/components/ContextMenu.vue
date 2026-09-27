<script setup lang="ts">
// Right-click menu on the canvas: selection operations in the Altium style.
import { computed, onMounted, onUnmounted } from 'vue'
import { useProject } from '../stores/project'
import Icon from './Icon.vue'
import PathMenu from './PathMenu.vue'
const store = useProject()
const sel = computed(() => store.selected)
const hasPath = computed(() => {
  void store.rev.sel
  return sel.value.lines.length + sel.value.polys.length > 0 || store.nodeSel.length > 0
})
// open upwards when clicked in the lower part of the window so the menu stays on screen
const pos = computed(() => {
  const m = store.ctxMenu
  if (!m) return {}
  const h = window.innerHeight
  const left = Math.min(m.x, window.innerWidth - 280) + 'px'
  return m.y > h * 0.55 ? { left, bottom: h - m.y + 'px', maxHeight: m.y - 8 + 'px' } : { left, top: m.y + 'px', maxHeight: h - m.y - 8 + 'px' }
})
const multi = computed(() => sel.value.count >= 2)
const many = computed(() => sel.value.count >= 3)
const hasOri = computed(() => sel.value.leds.length + sel.value.labels.length > 0)
function close(): void {
  store.ctxMenu = null
}
function run(fn: () => void): void {
  fn()
  close()
}
function onDoc(ev: MouseEvent): void {
  const el = document.getElementById('ctxmenu')
  if (el && !el.contains(ev.target as Node)) close()
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div v-if="store.ctxMenu" id="ctxmenu" class="ctx" :style="pos">
    <div class="hdr">{{ sel.count ? `${sel.count} selected` : 'Nothing selected' }}</div>
    <template v-if="multi">
      <div class="grp">Align</div>
      <div class="row">
        <button title="Left edges" @click="run(() => store.alignSelection('left'))"><Icon name="alignLeft" /></button>
        <button title="Horizontal centres" @click="run(() => store.alignSelection('hcenter'))"><Icon name="alignHCenter" /></button>
        <button title="Right edges" @click="run(() => store.alignSelection('right'))"><Icon name="alignRight" /></button>
        <button title="Top edges" @click="run(() => store.alignSelection('top'))"><Icon name="alignTop" /></button>
        <button title="Vertical centres" @click="run(() => store.alignSelection('vcenter'))"><Icon name="alignVCenter" /></button>
        <button title="Bottom edges" @click="run(() => store.alignSelection('bottom'))"><Icon name="alignBottom" /></button>
      </div>
      <div class="grp">Distribute</div>
      <div class="row">
        <button :disabled="!many" title="Equal horizontal spacing" @click="run(() => store.distributeSelection('h'))"><Icon name="distH" /> Horizontally</button>
        <button :disabled="!many" title="Equal vertical spacing" @click="run(() => store.distributeSelection('v'))"><Icon name="distV" /> Vertically</button>
      </div>
    </template>
    <template v-if="hasOri">
      <div class="grp">Orientation</div>
      <div class="item" @click="run(() => store.orientSelection('match'))">Match first selected</div>
      <div class="item" @click="run(() => store.orientSelection('nearest90'))">Orient to nearest 90°</div>
      <div class="item" @click="run(() => store.orientSelection('line'))">Follow nearest centreline</div>
      <div class="item" @click="run(() => store.rotateSelectionBy(90))">Rotate 90° CCW</div>
      <div class="item" @click="run(() => store.rotateSelectionBy(-90))">Rotate 90° CW</div>
      <div class="item" @click="run(() => (store.tool = 'rotate'))">Rotate with cursor <span class="k">R</span></div>
    </template>
    <PathMenu v-if="hasPath" compact @done="close" />
    <template v-if="sel.count">
      <div class="grp">Edit</div>
      <div class="item" @click="run(() => store.duplicateSelection())">Duplicate <span class="k">⌘D</span></div>
      <div class="item" @click="run(() => store.lockSelection(true))">Lock</div>
      <div class="item" @click="run(() => store.lockSelection(false))">Unlock</div>
      <div class="item danger" @click="run(() => store.removeSelected())">Delete <span class="k">Del</span></div>
    </template>
    <template v-else>
      <div class="item" @click="run(() => store.selectAll(['led']))">Select all LEDs</div>
      <div class="item" @click="run(() => store.selectAll(['label']))">Select all labels</div>
      <div class="item" @click="run(() => store.selectAll(['led', 'label', 'line', 'poly']))">Select everything</div>
    </template>
  </div>
</template>

<style scoped>
.ctx { position: fixed; z-index: 100; min-width: 230px; overflow: auto; background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 4px; box-shadow: 0 8px 24px #000a; font-size: 12px; }
.hdr { padding: 4px 8px; color: var(--muted); border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.grp { padding: 4px 8px 2px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.item { padding: 5px 8px; border-radius: 4px; cursor: pointer; display: flex; justify-content: space-between; }
.item:hover { background: #2a3a55; }
.item.danger:hover { background: #4a2a2a; }
.k { color: var(--muted); font-size: 11px; }
.row { display: flex; gap: 3px; padding: 2px 6px; }
.row button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 5px; }
</style>

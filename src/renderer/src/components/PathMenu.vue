<script setup lang="ts">
// Path operations (shared by the toolbar's Path menu and the right-click menu). Emits `done` after an action so
// a containing menu can close.
import { computed } from 'vue'
import { useProject } from '../stores/project'
import Icon from './Icon.vue'

defineProps<{ compact?: boolean }>()
const emit = defineEmits<{ (e: 'done'): void }>()
const store = useProject()
const sel = computed(() => store.selected)
const nNodes = computed(() => {
  void store.rev.sel
  return store.nodeSel.length
})
const nSegs = computed(() => {
  void store.rev.sel
  return store.segSel.length
})
const nLines = computed(() => sel.value.lines.length)
const nPolys = computed(() => sel.value.polys.length)
const nPaths = computed(() => nLines.value + nPolys.value)
const holes = computed(() => sel.value.polys.some((p) => p.rings.length > 1))
function run(fn: () => void): void {
  fn()
  emit('done')
}
</script>

<template>
  <div class="pm">
    <template v-if="nNodes || nSegs">
      <div class="grp">Nodes ({{ nNodes }}) · segments ({{ nSegs }})</div>
      <div class="mi" :class="{ dis: !nNodes }" @click="nNodes && run(() => store.deleteNodes())"><Icon name="delNode" /> Delete nodes <span class="k">Del</span></div>
      <div class="mi" :class="{ dis: !nSegs }" @click="nSegs && run(() => store.removeSegments())"><Icon name="split" /> Remove segments <span class="k">Del</span></div>
      <div class="mi" :class="{ dis: !nNodes }" @click="nNodes && run(() => store.disconnectAtNodes())"><Icon name="scissors" /> Disconnect at nodes</div>
      <div class="mi" :class="{ dis: !nSegs }" @click="nSegs && run(() => store.insertMidpoints())"><Icon name="addNode" /> Add node at segment midpoints</div>
      <div class="mi" :class="{ dis: nNodes < 2 }" @click="nNodes >= 2 && run(() => store.straightenNodes())"><Icon name="straighten" /> Straighten between nodes</div>
      <div class="row">
        <button :disabled="nNodes < 2" title="Align nodes on one vertical (same X)" @click="run(() => store.averageNodes('x'))"><Icon name="alignNodesX" /></button>
        <button :disabled="nNodes < 2" title="Align nodes on one horizontal (same Y)" @click="run(() => store.averageNodes('y'))"><Icon name="alignNodesY" /></button>
        <button :disabled="nNodes < 2" title="Collapse nodes to their average" @click="run(() => store.averageNodes('both'))"><Icon name="collapse" /></button>
        <button :disabled="!nNodes" :title="`Fillet corners (${store.shapeOpts.filletMm} mm)`" @click="run(() => store.roundNodes(store.shapeOpts.filletMm, 'fillet'))"><Icon name="fillet" /></button>
        <button :disabled="!nNodes" :title="`Chamfer corners (${store.shapeOpts.filletMm} mm)`" @click="run(() => store.roundNodes(store.shapeOpts.filletMm, 'chamfer'))"><Icon name="chamfer" /></button>
      </div>
    </template>
    <div class="grp">Paths</div>
    <div class="mi" :class="{ dis: !nLines }" @click="nLines && run(() => store.joinSelected())"><Icon name="join" /> {{ nLines === 1 ? 'Close line' : 'Join lines' }} <span class="k">⌘J</span></div>
    <div class="mi" :class="{ dis: !nLines }" @click="nLines && run(() => store.closeSelected())"><Icon name="close" /> Close into polygon</div>
    <div class="mi" :class="{ dis: !nPolys }" @click="nPolys && run(() => store.openSelected())"><Icon name="split" /> Open polygon into line</div>
    <div class="mi" :class="{ dis: !nPaths }" @click="nPaths && run(() => store.reverseSelected())"><Icon name="reverse" /> Reverse direction</div>
    <div class="mi" :class="{ dis: !nLines }" @click="nLines && run(() => store.outlineSelected())"><Icon name="outline" /> Outline stroke</div>
    <div class="mi" :class="{ dis: !nPaths }" @click="nPaths && run(() => store.offsetSelected(store.shapeOpts.offsetMm))"><Icon name="offset" /> Offset path {{ store.shapeOpts.offsetMm }} mm</div>
    <div class="mi" :class="{ dis: !nPaths }" @click="nPaths && run(() => store.offsetSelected(-store.shapeOpts.offsetMm))"><Icon name="offset" /> Inset path {{ store.shapeOpts.offsetMm }} mm</div>
    <div class="mi" :class="{ dis: !nPaths }" @click="nPaths && run(() => store.simplifySelected(store.shapeOpts.simplifyMm))"><Icon name="simplify" /> Simplify ({{ store.shapeOpts.simplifyMm }} mm)</div>
    <div class="mi" :class="{ dis: !nPaths }" @click="nPaths && run(() => store.smoothSelected(1))"><Icon name="smooth" /> Smooth</div>
    <div class="mi" :class="{ dis: !holes }" @click="holes && run(() => store.explodeSelected())"><Icon name="explode" /> Split holes into polygons</div>
    <div class="mi" :class="{ dis: !holes }" @click="holes && run(() => store.removeHoles())"><Icon name="hole" /> Remove holes</div>
    <div class="grp">Pathfinder ({{ nPolys }} polygons)</div>
    <div class="row">
      <button :disabled="nPolys < 2" title="Unite" @click="run(() => store.pathfinderOp('unite'))"><Icon name="unite" /></button>
      <button :disabled="nPolys < 2" title="Subtract: the first selected minus the others" @click="run(() => store.pathfinderOp('subtract'))"><Icon name="subtract" /></button>
      <button :disabled="nPolys < 2" title="Intersect" @click="run(() => store.pathfinderOp('intersect'))"><Icon name="intersect" /></button>
      <button :disabled="nPolys < 2" title="Exclude overlap" @click="run(() => store.pathfinderOp('exclude'))"><Icon name="exclude" /></button>
      <button :disabled="nPolys < 2" title="Divide into every overlap region" @click="run(() => store.pathfinderOp('divide'))"><Icon name="divide" /></button>
    </div>
    <p v-if="!compact" class="hint">Node tool (A): click or drag-box vertices, click a segment, drag to move, click a ◇ midpoint to add a node. Pen (E), scissors (C), knife (K). Sizes are set in the inspector.</p>
  </div>
</template>

<style scoped>
.pm { min-width: 250px; }
.mi { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.mi:hover { background: #2a3a55; }
.mi.dis { opacity: 0.4; cursor: default; }
.mi.dis:hover { background: none; }
.k { margin-left: auto; color: var(--muted); font-size: 11px; }
.grp { padding: 6px 8px 2px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.row { display: flex; gap: 3px; padding: 2px 6px 4px; }
.row button { flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 5px; }
.hint { color: var(--muted); font-size: 11px; padding: 4px 8px; margin: 0; max-width: 260px; }
</style>

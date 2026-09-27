<script setup lang="ts">
import { computed, ref } from 'vue'
import { LAYER_NAMES } from '../core/model'
import { useProject } from '../stores/project'
const store = useProject()
const layers = computed(() => {
  void store.version
  return [...LAYER_NAMES, ...store.sources.map((s) => ({ key: s.key, label: s.label, color: s.color }))]
})
const counts = computed(() => {
  void store.version
  const p = store.project
  const c: Record<string, number> = {}
  if (!p) return c
  for (const x of p.polys) c[x.cls] = (c[x.cls] ?? 0) + 1
  for (const x of p.lines) c[x.cls] = (c[x.cls] ?? 0) + 1
  c.labels = p.labels.length
  c.leds = p.leds.length
  c.backsilk = (p.backArt?.count ?? 0) + drawnBack.value
  return c
})
const drawnBack = computed(() => {
  void store.version
  const p = store.project
  return p ? p.polys.filter((x) => x.layer === 'silkBack').length + p.lines.filter((x) => x.layer === 'silkBack').length + p.labels.filter((x) => x.layer === 'silkBack').length : 0
})
function setAll(on: boolean): void {
  for (const l of layers.value) store.setLayerVisible(l.key, on)
}
const art = computed(() => store.backArt)
const ext = computed(() => store.backArtExtentNow)
const move = ref<[number, number]>([0, 0])
const r2 = (v: number): string => (Math.round(v * 100) / 100).toFixed(2)
</script>

<template>
  <div>
    <h3>Layers</h3>
    <div class="btns"><button @click="setAll(true)">All on</button><button @click="setAll(false)">All off</button></div>
    <label v-for="l in layers" :key="l.key" class="row" style="grid-template-columns: 20px 12px 1fr auto">
      <input type="checkbox" :checked="store.isVisible(l.key)" @change="store.setLayerVisible(l.key, ($event.target as HTMLInputElement).checked)" />
      <span class="sw" :style="{ background: l.key === 'backsilk' ? '#b58cff' : ((l as { color?: string }).color ?? 'transparent') }"></span>
      <span>{{ l.label }}</span>
      <span class="muted small">{{ counts[l.key] ?? 0 }}</span>
    </label>

    <h3>Back silk</h3>
    <label class="row" style="grid-template-columns: 20px 1fr">
      <input type="checkbox" :checked="store.viewBack" @change="store.viewBack = ($event.target as HTMLInputElement).checked" />
      <span>View from back <span class="muted small">(mirrors the canvas left-right)</span></span>
    </label>
    <p class="small muted">
      {{ store.viewBack ? 'Back view: the board as seen from the back. The back silk reads as it will be printed; the front art and LEDs are faint.' : 'Front view: the back silk shows faint, as if seen through the board, so its text reads mirrored.' }}
      Hidden layers are not exported.
    </p>
    <div v-if="!store.isVisible('backsilk') && (art || drawnBack)" class="attention small">Back silk is switched off in the list above: it will not be exported.</div>

    <template v-if="art">
      <div class="small">
        <b>Imported art</b> <span class="muted">{{ art.source }}</span><br />
        {{ art.count.toLocaleString() }} polygons · {{ art.points.toLocaleString() }} points · {{ art.areaMm2.toLocaleString() }} mm²<br />
        <span v-if="ext">x {{ r2(ext.x0) }}…{{ r2(ext.x1) }} · y {{ r2(ext.y0) }}…{{ r2(ext.y1) }} mm<span v-if="art.offset[0] || art.offset[1]"> (moved {{ r2(art.offset[0]) }}, {{ r2(art.offset[1]) }})</span></span>
      </div>
      <div v-if="ext?.outside" class="attention small">The art reaches outside the {{ store.project?.board.widthMm }} × {{ store.project?.board.heightMm }} mm board.</div>
      <div v-for="(n, i) in store.backArtNotes" :key="i" class="attention small">{{ n }}</div>
      <label class="row"><span>Show and export</span><input type="checkbox" :checked="art.visible" @change="store.patchBackArt({ visible: ($event.target as HTMLInputElement).checked })" /></label>
      <label class="row"><span>Front-view opacity</span><input type="range" min="0.05" max="1" step="0.05" :value="art.opacity" @input="store.patchBackArt({ opacity: Number(($event.target as HTMLInputElement).value) }, false)" /></label>
      <label class="row"><span>Locked</span><input type="checkbox" :checked="art.locked" title="Unlock to move, mirror or clear the imported art" @change="store.patchBackArt({ locked: ($event.target as HTMLInputElement).checked })" /></label>
      <template v-if="!art.locked">
        <label class="row"><span>Move x / y mm</span><span class="pair"><input v-model.number="move[0]" type="number" step="0.1" /><input v-model.number="move[1]" type="number" step="0.1" /></span></label>
        <div class="btns">
          <button :disabled="!move[0] && !move[1]" @click="store.translateBackArt(move[0], move[1]); move = [0, 0]">Move</button>
          <button title="Mirror left-right about the board centre (for art drawn as seen from the back)" @click="store.mirrorBackArt()">Mirror</button>
          <button @click="store.clearBackArt()">Clear</button>
        </div>
      </template>
      <div class="btns"><button title="Import another file in place of this art" @click="store.importBackArt()">Replace…</button></div>
    </template>
    <template v-else>
      <p class="small muted">No imported back art. File › Import back art… takes a list of polygons in board mm (as printed on the Bottom Overlay, seen from the top), a pcbgen / Python build spec (silk_back), a pcbgen job or another flightboard project.</p>
      <div class="btns"><button :disabled="!store.project" @click="store.importBackArt()">Import back art…</button></div>
    </template>
    <p class="small muted">Drawn back silk: {{ drawnBack }} item{{ drawnBack === 1 ? '' : 's' }}. Set a line, polygon or label to the <i>back silkscreen</i> layer (inspector, or the LEDs tab's add presets for new ones); back labels are printed mirrored so they read from the back.</p>
  </div>
</template>

<style scoped>
.sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.attention { border: 1px solid #b0561b; background: #b0561b1f; border-radius: 4px; padding: 5px 7px; margin: 6px 0; line-height: 1.45; color: #f0925a; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
</style>

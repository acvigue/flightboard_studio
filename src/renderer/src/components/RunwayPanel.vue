<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useProject } from '../stores/project'
import type { ChevronKind } from '../core/markings'
import type { RunwayMarkingStyle } from '../core/model'
const store = useProject()
// runway end style: edited here, applied (and saved in the project) by Regenerate
const style = reactive<RunwayMarkingStyle>(JSON.parse(JSON.stringify(store.runwayStyle)))
watch(() => store.project, () => Object.assign(style, JSON.parse(JSON.stringify(store.runwayStyle))))
const res = computed(() => store.runwayResult)
const axes = computed(() => {
  void store.version
  return (store.project?.lines ?? []).filter((l) => l.cls === 'runway_cl' && l.sub === 'axis')
})
const opts = reactive<{ kind: ChevronKind; lengthM: number; count: number; widthMm: number }>({ kind: 'chevrons', lengthM: 300, count: 4, widthMm: 0.3 })
function ends(name?: string): [string, string] {
  const [a, b] = (name ?? '?/?').split('/')
  return [a ?? '?', b ?? '?']
}
</script>

<template>
  <div>
    <h3>Runway ends</h3>
    <label class="row"><span>Style</span><select v-model="style.endStyle"><option value="classic">Classic (thresholds, stopways, designators on the runway)</option><option value="chevrons">End chevrons (designator inside)</option></select></label>
    <template v-if="style.endStyle === 'chevrons'">
      <label class="row"><span>Direction</span><select v-model="style.chevron.direction"><option value="outward">apex outward (away from the runway)</option><option value="inward">apex inward (toward the runway)</option></select></label>
      <label class="row"><span>Stroke mm</span><input v-model.number="style.chevron.strokeMm" type="number" step="0.02" min="0.1" /></label>
      <label class="row"><span>Gap mm</span><input v-model.number="style.chevron.gapMm" type="number" step="0.02" min="0.05" /></label>
      <label class="row"><span>Span × width</span><input v-model.number="style.chevron.span" type="number" step="0.05" min="0.5" title="Opening width as a multiple of the runway width" /></label>
      <label class="row"><span>Depth × span</span><input v-model.number="style.chevron.depth" type="number" step="0.1" min="0.5" title="Apex to opening, as a multiple of the span (shortened near the board edge)" /></label>
      <label class="row"><span>Offset mm</span><input v-model.number="style.chevron.offsetMm" type="number" step="0.1" min="0" title="Space between the pavement end and the chevron" /></label>
      <label class="row"><span>Text max mm</span><input v-model.number="style.chevron.textMaxMm" type="number" step="0.1" min="0.6" title="Largest designator cap height; smaller where it would not fit" /></label>
      <label class="row"><span>Remove stopways</span><input v-model="style.removeStopways" type="checkbox" title="Drop the EMAS / blast-pad outlines at the runway ends" /></label>
      <label class="row"><span>Remove name labels</span><input v-model="style.removeRunwayNames" type="checkbox" title="Drop the RUNWAY 09C – 27C labels beside the runways" /></label>
    </template>
    <div class="btns"><button class="primary" :disabled="!store.project || !store.fonts" @click="store.applyRunwayStyle(JSON.parse(JSON.stringify(style)))">Regenerate end markings</button></div>
    <div v-if="res" class="small muted">
      {{ res.style }}: removed {{ res.removed.stopways }} stopway outlines, {{ res.removed.designators }} designators, {{ res.removed.runwayNames }} name labels; added {{ res.added.chevronLines }} chevron lines, {{ res.added.designators }} designator labels.
      <div v-for="e in res.ends" :key="e.designator" :class="{ warn: e.clipped || e.nearLeds.length || e.textMm < 0.9 }">{{ e.designator }}: text {{ e.textMm }} mm, depth {{ e.depthMm }} mm<span v-if="e.clipped"> · shrunk to fit the board</span><span v-if="e.nearLeds.length"> · near LEDs {{ e.nearLeds.join(', ') }}</span></div>
    </div>
    <p class="muted small">New boards use the classic style. Regenerating replaces the end chevrons and their designators; undo restores removed outlines.</p>
    <h3>Runway markings</h3>
    <label class="row"><span>Type</span><select v-model="opts.kind"><option value="chevrons">Blast-pad chevrons</option><option value="arrows">Displaced-threshold arrows</option></select></label>
    <label class="row"><span>Zone length m</span><input v-model.number="opts.lengthM" type="number" step="10" /></label>
    <label class="row"><span>Count</span><input v-model.number="opts.count" type="number" step="1" min="1" /></label>
    <label class="row"><span>Line width mm</span><input v-model.number="opts.widthMm" type="number" step="0.05" /></label>
    <p class="muted small">Markings are added as editable runway-marking lines at the chosen end (the end named first is the axis start).</p>
    <div v-for="a in axes" :key="a.id" class="rw">
      <b>{{ a.name || '(unnamed)' }}</b>
      <div class="btns">
        <button @click="store.addRunwayMarkings(a.id, { end: 0, kind: opts.kind, lengthM: opts.lengthM, count: opts.count, widthMm: opts.widthMm })">at {{ ends(a.name)[0] }}</button>
        <button @click="store.addRunwayMarkings(a.id, { end: 1, kind: opts.kind, lengthM: opts.lengthM, count: opts.count, widthMm: opts.widthMm })">at {{ ends(a.name)[1] }}</button>
        <button title="Designator labels at both ends" @click="store.addDesignators(a.id)">designators</button>
        <button title="Select the axis line" @click="store.select('line', a.id)">select axis</button>
      </div>
    </div>
    <p v-if="!axes.length" class="muted">No runway axes (build a board first, or draw a line and set its class to runway marking).</p>
  </div>
</template>

<style scoped>
.rw { border-top: 1px solid var(--line); padding: 6px 0; }
.warn { color: #f0925a; }
</style>

<script setup lang="ts">
// Configurable OSM data sources: what to fetch (Overpass tag filter) and how to draw it.
import { computed, reactive, ref } from 'vue'
import { useProject } from '../stores/project'
import type { SourceSpec, StyleMode } from '../core/model'
import Icon from './Icon.vue'
import { getMirrors, setMirrors, DEFAULT_MIRRORS } from '../core/osm'
const mirrors = ref(getMirrors().join('\n'))
function saveMirrors(): void {
  setMirrors(mirrors.value.split('\n'))
  mirrors.value = getMirrors().join('\n')
}
function resetMirrors(): void {
  setMirrors(DEFAULT_MIRRORS)
  mirrors.value = getMirrors().join('\n')
}

const store = useProject()
const specs = computed(() => store.sources)
const open = ref<string | null>(null)
const modes: { id: StyleMode; label: string }[] = [
  { id: 'single', label: 'single line' },
  { id: 'edges', label: 'two edges (+ lane dashes)' },
  { id: 'edges+centre', label: 'edges + centre line' },
  { id: 'dashed', label: 'dashed' },
  { id: 'dotted', label: 'dotted' },
  { id: 'ticks', label: 'line with ticks (rail)' },
  { id: 'outline', label: 'outline' }
]
const draft = reactive<SourceSpec>({ key: '', label: '', enabled: true, kind: 'line', filter: '["highway"="pedestrian"]', color: '#9aa1ad', layer: 'silk', style: { mode: 'single', widthMm: 0.12 }, clipAirside: true })
const adding = ref(false)
function add(): void {
  if (!draft.label || !draft.filter) return
  store.addSource({ ...draft, key: draft.label, style: { ...draft.style } })
  adding.value = false
}
const num = (ev: Event): number => Number((ev.target as HTMLInputElement).value)
const str = (ev: Event): string => (ev.target as HTMLInputElement).value
function pair(ev: Event): [number, number] {
  const [a, b] = str(ev).split(/[\/,\s]+/).map(Number)
  return [a || 1, b || 1]
}
</script>

<template>
  <div>
    <h3>Data sources</h3>
    <p class="muted small">Each source is an Overpass tag filter fetched inside the map frame and a drawing style. Edit, then <b>Apply</b> (uses the cached download) or <b>Fetch & apply</b> when filters changed.</p>
    <div class="btns">
      <button class="primary" :disabled="!store.project || store.busy" @click="store.applySourcesNow()">Apply</button>
      <button :disabled="!store.project || store.busy" @click="store.fetchAndApplySources(false)">Fetch & apply</button>
      <button :disabled="!store.project || store.busy" title="Ignore the cache" @click="store.fetchAndApplySources(true)">Re-download</button>
    </div>
    <div v-for="s in specs" :key="s.key" class="src" :class="{ off: !s.enabled }">
      <div class="head">
        <input type="checkbox" :checked="s.enabled" @change="store.updateSource(s.key, { enabled: ($event.target as HTMLInputElement).checked })" />
        <span class="sw" :style="{ background: s.color }"></span>
        <span class="lbl" @click="open = open === s.key ? null : s.key">{{ s.label }}</span>
        <span class="muted small">{{ s.kind }} · {{ s.style.mode }}</span>
        <button class="mini" :title="open === s.key ? 'collapse' : 'edit'" @click="open = open === s.key ? null : s.key"><Icon name="chevron" :size="12" /></button>
      </div>
      <div v-if="open === s.key" class="body">
        <label class="row"><span>Label</span><input :value="s.label" @change="store.updateSource(s.key, { label: str($event) })" /></label>
        <label class="row"><span>Overpass filter</span><input :value="s.filter" class="mono" @change="store.updateSource(s.key, { filter: str($event) })" /></label>
        <label class="row"><span>Kind</span><select :value="s.kind" @change="store.updateSource(s.key, { kind: str($event) as 'line' | 'polygon' })"><option value="line">line</option><option value="polygon">polygon</option></select></label>
        <label class="row"><span>Layer</span><select :value="s.layer" @change="store.updateSource(s.key, { layer: str($event) as 'silk' | 'copper' })"><option value="silk">silkscreen</option><option value="copper">copper</option></select></label>
        <label class="row"><span>Colour</span><input type="color" :value="s.color" @change="store.updateSource(s.key, { color: str($event) })" /></label>
        <label class="row"><span>Style</span><select :value="s.style.mode" @change="store.updateSourceStyle(s.key, { mode: str($event) as StyleMode })"><option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option></select></label>
        <label class="row"><span>Line mm</span><input type="number" step="0.01" :value="s.style.widthMm" @change="store.updateSourceStyle(s.key, { widthMm: num($event) })" /></label>
        <template v-if="s.style.mode === 'edges' || s.style.mode === 'edges+centre'">
          <label class="row"><span>Edge mm</span><input type="number" step="0.01" :value="s.style.edgeWidthMm ?? s.style.widthMm" @change="store.updateSourceStyle(s.key, { edgeWidthMm: num($event) })" /></label>
          <label class="row"><span>Lane width m</span><input type="number" step="0.1" :value="s.style.laneM ?? 3.5" @change="store.updateSourceStyle(s.key, { laneM: num($event) })" /></label>
          <label class="row"><span>Default lanes</span><input type="number" step="1" :value="s.style.defaultLanes ?? 2" @change="store.updateSourceStyle(s.key, { defaultLanes: num($event) })" /></label>
          <label class="row"><span>Min width m</span><input type="number" step="0.5" :value="s.style.minWidthM ?? 6" @change="store.updateSourceStyle(s.key, { minWidthM: num($event) })" /></label>
          <label class="row"><span>Lane dashes</span><input type="checkbox" :checked="!!s.style.laneDashes" @change="store.updateSourceStyle(s.key, { laneDashes: ($event.target as HTMLInputElement).checked })" /></label>
        </template>
        <label v-if="['dashed', 'dotted', 'edges', 'edges+centre'].includes(s.style.mode)" class="row"><span>Dash / gap m</span><input :value="(s.style.dashM ?? [3, 6]).join(' / ')" @change="store.updateSourceStyle(s.key, { dashM: pair($event) })" /></label>
        <label v-if="s.style.mode === 'ticks'" class="row"><span>Tick pitch / half m</span><input :value="(s.style.tickM ?? [20, 6]).join(' / ')" @change="store.updateSourceStyle(s.key, { tickM: pair($event) })" /></label>
        <label class="row"><span>Min length m</span><input type="number" step="10" :value="s.minLengthM ?? 0" @change="store.updateSource(s.key, { minLengthM: num($event) })" /></label>
        <label v-if="s.kind === 'polygon'" class="row"><span>Min area m²</span><input type="number" step="500" :value="s.minAreaM2 ?? 0" @change="store.updateSource(s.key, { minAreaM2: num($event) })" /></label>
        <label class="row"><span>Drop tags</span><input :value="s.dropTags ?? ''" class="mono" placeholder="key=v1|v2;key2=v" @change="store.updateSource(s.key, { dropTags: str($event) || undefined })" /></label>
        <label class="row"><span>Landside only</span><input type="checkbox" :checked="!!s.landsideOnly" @change="store.updateSource(s.key, { landsideOnly: ($event.target as HTMLInputElement).checked })" /></label>
        <label class="row"><span>Cut under airside</span><input type="checkbox" :checked="!!s.clipAirside" @change="store.updateSource(s.key, { clipAirside: ($event.target as HTMLInputElement).checked })" /></label>
        <div class="btns"><button @click="store.removeSource(s.key)"><Icon name="trash" /> Remove source</button></div>
      </div>
    </div>
    <div class="btns">
      <button @click="adding = !adding">+ Add source</button>
      <button @click="store.resetSources()">Reset to defaults</button>
      <button title="Use the current list for every new board" @click="store.saveSourcesAsDefault()">Save as my defaults</button>
    </div>
    <h3>Overpass endpoints</h3>
    <p class="muted small">Tried in order (the last one that answered is tried first). One URL per line; a private instance with a token works well here.</p>
    <textarea v-model="mirrors" rows="5" class="mono" spellcheck="false"></textarea>
    <div class="btns"><button @click="saveMirrors">Save endpoints</button><button @click="resetMirrors">Defaults</button></div>
    <div v-if="adding" class="src body">
      <label class="row"><span>Label</span><input v-model="draft.label" placeholder="Footpaths" /></label>
      <label class="row"><span>Overpass filter</span><input v-model="draft.filter" class="mono" /></label>
      <label class="row"><span>Kind</span><select v-model="draft.kind"><option value="line">line</option><option value="polygon">polygon</option></select></label>
      <label class="row"><span>Style</span><select v-model="draft.style.mode"><option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option></select></label>
      <label class="row"><span>Line mm</span><input v-model.number="draft.style.widthMm" type="number" step="0.01" /></label>
      <label class="row"><span>Colour</span><input v-model="draft.color" type="color" /></label>
      <label class="row"><span>Layer</span><select v-model="draft.layer"><option value="silk">silkscreen</option><option value="copper">copper</option></select></label>
      <div class="btns"><button class="primary" @click="add">Add</button><button @click="adding = false">Cancel</button></div>
      <p class="muted small">Examples: <code>["highway"="pedestrian"]</code>, <code>["landuse"="industrial"]</code> (polygon), <code>["natural"="wood"]</code> (polygon), <code>["power"="line"]</code>.</p>
    </div>
  </div>
</template>

<style scoped>
.src { border-top: 1px solid var(--line); padding: 4px 0; }
.src.off .lbl { color: var(--muted); }
.head { display: flex; align-items: center; gap: 6px; }
.head input[type='checkbox'] { width: auto; margin: 0; }
.sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.lbl { flex: 1; cursor: pointer; }
.mini { padding: 1px 4px; }
.body { padding: 4px 0 4px 6px; }
.body label.row { grid-template-columns: 110px 1fr; }
code { font-family: ui-monospace, monospace; font-size: 11px; }
</style>

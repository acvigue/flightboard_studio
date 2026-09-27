<script setup lang="ts">
import { ref, watch } from 'vue'
import { searchAirports, type Airport } from '../core/airports'
import { useProject } from '../stores/project'

const store = useProject()
const q = ref('')
const results = ref<Airport[]>([])
const picked = ref<Airport | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => (results.value = await searchAirports(q.value)), 150)
})
async function build(force = false): Promise<void> {
  if (!picked.value) return
  await store.buildFromAirport(picked.value, force)
}
</script>

<template>
  <div>
    <h3>Airport</h3>
    <input v-model="q" placeholder="ICAO, IATA, name or city" />
    <div v-if="results.length" class="list" style="margin-top: 6px">
      <div v-for="a in results" :key="a.ident" :class="{ sel: picked?.ident === a.ident }" @click="picked = a">
        <b>{{ a.icao || a.ident }}</b> <span class="muted">{{ a.iata }}</span> · {{ a.name }} <span class="muted small">{{ a.city }}, {{ a.country }}</span>
      </div>
    </div>
    <div v-if="picked" style="margin-top: 8px">
      <div><b>{{ picked.name }}</b></div>
      <div class="muted small">{{ picked.icao || picked.ident }} / {{ picked.iata || '—' }} · {{ picked.lat.toFixed(4) }}, {{ picked.lon.toFixed(4) }} · {{ picked.elevFt }} ft</div>
      <h3>Build options</h3>
      <label class="row"><span>FAA mapping</span><input v-model="store.buildOpts.useFaa" type="checkbox" title="Use the FAA airport-mapping polygons (US airports) for pavement and buildings" /></label>
      <label class="row"><span>Landside</span><input v-model="store.buildOpts.landside" type="checkbox" title="Roads, rail and parking around the airport" /></label>
      <label class="row"><span>Max width mm</span><input v-model.number="store.buildOpts.maxWidthMm" type="number" /></label>
      <label class="row"><span>Max height mm</span><input v-model.number="store.buildOpts.maxHeightMm" type="number" /></label>
      <label class="row"><span>Margin mm</span><input v-model.number="store.buildOpts.marginMm" type="number" step="0.5" /></label>
      <label class="row"><span>Frame pad m</span><input v-model.number="store.buildOpts.padM" type="number" /></label>
      <div class="btns">
        <button class="primary" :disabled="store.busy" @click="build(false)">Build board</button>
        <button :disabled="store.busy" title="Ignore cached OSM/FAA data" @click="build(true)">Re-fetch</button>
      </div>
    </div>
    <h3>Log</h3>
    <div class="log mono">{{ store.log.join('\n') }}</div>
  </div>
</template>

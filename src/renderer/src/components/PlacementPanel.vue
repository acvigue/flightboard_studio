<script setup lang="ts">
import TooCloseList from './TooCloseList.vue'
import { computed } from 'vue'
import { useProject } from '../stores/project'
const store = useProject()
const sizes = [1.5, 1.1, 1.0]
const pl = computed(() => {
  void store.version
  return store.project?.placement ?? null
})
</script>

<template>
  <div v-if="pl">
    <h3>LED placement</h3>
    <label class="row"><span>Runway pitch mm</span><input v-model.number="pl.runwayPitchMm" type="number" step="0.5" /></label>
    <label class="row"><span>Taxiway pitch mm</span><input v-model.number="pl.twyPitchMm" type="number" step="0.5" /></label>
    <label class="row"><span>Ramp pitch mm</span><input v-model.number="pl.lanePitchMm" type="number" step="0.5" /></label>
    <label class="row"><span>Junction R twy</span><input v-model.number="pl.junctionRadiusTwyMm" type="number" step="0.1" /></label>
    <label class="row"><span>Junction R ramp</span><input v-model.number="pl.junctionRadiusLaneMm" type="number" step="0.1" /></label>
    <label class="row"><span>Cluster mm</span><input v-model.number="pl.clusterMm" type="number" step="0.5" /></label>
    <label class="row"><span>Hold-short m</span><input v-model.number="pl.holdOffM" type="number" step="5" /></label>
    <label class="row"><span>Gate offset m</span><input v-model.number="pl.gateOffM" type="number" step="0.5" title="How far a gate LED sits off its terminal wall, in ground metres (default 37, beyond the stand's nose; the ORD gates Aiden aligned by hand sit about 13.6 m off, between the wall and the nose)" /></label>
    <label class="row"><span>Gate min pitch</span><input v-model.number="pl.gateMinPitchMm" type="number" step="0.1" /></label>
    <label class="row"><span>Min separation</span><input v-model.number="pl.minSepMm" type="number" step="0.1" /></label>
    <label class="row"><span>Runway LED</span><select v-model.number="pl.sizeRunway"><option v-for="s in sizes" :key="s" :value="s">{{ s }} mm</option></select></label>
    <label class="row"><span>Taxiway LED</span><select v-model.number="pl.sizeTaxiway"><option v-for="s in sizes" :key="s" :value="s">{{ s }} mm</option></select></label>
    <label class="row"><span>Ramp LED</span><select v-model.number="pl.sizeRamp"><option v-for="s in sizes" :key="s" :value="s">{{ s }} mm</option></select></label>
    <label class="row"><span>Gate LED</span><select v-model.number="pl.sizeGate"><option v-for="s in sizes" :key="s" :value="s">{{ s }} mm</option></select></label>
    <div class="btns">
      <button class="primary" :disabled="store.busy" @click="store.placeLeds()">Place LEDs</button>
      <button :disabled="store.busy" @click="store.generateLabelsNow()">Regenerate labels</button>
    </div>
    <p class="muted small">Placement replaces all unlocked LEDs. LEDs you add or edit by hand are locked (white outline) and kept.</p>
    <TooCloseList />
    <h3>Add tool presets</h3>
    <label class="row"><span>New LED class</span><select v-model="store.addPreset.cls"><option value="taxiway">taxiway</option><option value="ramp">ramp</option><option value="runway">runway</option><option value="gate">gate</option></select></label>
    <label class="row"><span>New LED size</span><select v-model.number="store.addPreset.size"><option v-for="s in sizes" :key="s" :value="s">{{ s }} mm</option></select></label>
    <label class="row"><span>New line class</span><select v-model="store.addPreset.lineCls"><option value="custom">custom</option><option value="taxiway">taxiway</option><option value="taxilane">apron lane</option><option value="runway_cl">runway marking</option><option value="road">road</option><option value="rail">rail</option></select></label>
    <label class="row"><span>Layer</span><select v-model="store.addPreset.layer"><option value="silk">silkscreen</option><option value="copper">copper</option><option value="silkBack">back silkscreen</option></select></label>
    <label class="row"><span>Line width mm</span><input v-model.number="store.addPreset.lineWidthMm" type="number" step="0.05" /></label>
    <label class="row"><span>Polygon fill</span><select v-model="store.addPreset.polyFill"><option value="none">outline only</option><option value="solid">solid</option><option value="hatch">hatch</option></select></label>
    <label class="row"><span>Hatch angle °</span><input v-model.number="store.addPreset.hatch.angleDeg" type="number" step="15" /></label>
    <label class="row"><span>Hatch pitch mm</span><input v-model.number="store.addPreset.hatch.pitchMm" type="number" step="0.1" /></label>
    <label class="row"><span>Cross hatch</span><input v-model="store.addPreset.hatch.cross" type="checkbox" /></label>
  </div>
</template>

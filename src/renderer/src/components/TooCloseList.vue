<script setup lang="ts">
// LED pairs whose pads would come under 0.15 mm apart (live, from the footprint squares in core/spacing.ts). Shown in
// the LEDs tab and the PCB tab so a hand edit that packs two LEDs too tightly is visible at once.
import { computed } from 'vue'
import { useProject } from '../stores/project'
import type { Led } from '../core/model'

const store = useProject()
const pairs = computed(() => store.ledsTooClose)
const name = (l: Led): string => l.label || l.feature || l.cls
</script>

<template>
  <div v-if="pairs.length" class="attention small">
    <b>{{ pairs.length }} LED pair{{ pairs.length === 1 ? '' : 's' }} too close (pads under 0.15 mm apart)</b>
    <div v-for="(p, i) in pairs.slice(0, 12)" :key="i" class="pair">
      <span>{{ name(p.a) }} / {{ name(p.b) }} · {{ p.gapMm.toFixed(2) }} mm</span>
      <button class="link" @click="store.selectLeds([p.a.id, p.b.id])">select</button>
    </div>
    <div v-if="pairs.length > 12" class="muted">… and {{ pairs.length - 12 }} more</div>
    <div class="muted">Move or delete one LED of each pair. Place LEDs merges such pairs automatically; hand-placed (locked) LEDs are left as they are.</div>
  </div>
</template>

<style scoped>
.attention { border: 1px solid #b0561b; background: #b0561b1f; border-radius: 4px; padding: 5px 7px; margin: 6px 0; line-height: 1.45; }
.attention b { color: #f0925a; display: block; }
.pair { display: flex; justify-content: space-between; gap: 6px; }
button.link { background: none; border: none; color: var(--accent); padding: 0; cursor: pointer; }
</style>

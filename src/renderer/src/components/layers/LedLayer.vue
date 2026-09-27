<script setup lang="ts">
import { computed } from 'vue'
import type { Led } from '../../core/model'
import type { BoardTransform } from '../../core/transform'

const props = defineProps<{ leds: Led[]; tf: BoardTransform; strokeZ: number; selected: Set<string>; rev: number }>()
const fill: Record<string, string> = { runway: '#6fb0ff', taxiway: '#f2a93b', ramp: '#3ee6d8', gate: '#ff5aa0' }
const items = computed(() => {
  void props.rev
  const t = props.tf
  return props.leds.map((l) => {
    const [x, y] = t.toMm(l.pos)
    return { id: l.id, tr: `translate(${x.toFixed(3)} ${y.toFixed(3)}) rotate(${(-l.rotDeg).toFixed(2)})`, s: l.size, fill: fill[l.cls] ?? '#fff', locked: !!l.locked, junction: l.role === 'junction' }
  })
})
</script>

<template>
  <g>
    <g v-for="it in items" :key="it.id" v-memo="[it.tr, it.s, it.fill, it.locked, it.junction, selected.has(it.id), strokeZ]" :transform="it.tr" data-kind="led" :data-id="it.id">
      <rect :x="-it.s / 2" :y="-it.s / 2" :width="it.s" :height="it.s" :fill="it.fill" :stroke="selected.has(it.id) ? '#ffffff' : it.locked ? '#ffffff88' : 'none'" :stroke-width="Math.max(0.12, 0.9 / strokeZ)" data-kind="led" :data-id="it.id" />
      <line x1="0" y1="0" :x2="it.s * 0.75" y2="0" stroke="#0b0d10" :stroke-width="it.s * 0.14" data-kind="led" :data-id="it.id" />
      <circle v-if="it.junction" r="0.22" fill="#fff" data-kind="led" :data-id="it.id" />
    </g>
  </g>
</template>

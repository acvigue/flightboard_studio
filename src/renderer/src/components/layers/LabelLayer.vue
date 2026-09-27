<script setup lang="ts">
import { computed } from 'vue'
import type { Label } from '../../core/model'
import type { BoardTransform } from '../../core/transform'

const props = defineProps<{ labels: Label[]; tf: BoardTransform; selected: Set<string>; rev: number }>()
const items = computed(() => {
  void props.rev
  const t = props.tf
  return props.labels.map((lb) => {
    const [x, y] = t.toMm(lb.pos)
    const fs = (lb.heightM * t.k) / 0.7
    const ls = (lb.tracking ?? 0) * lb.heightM * t.k
    const w = lb.text.length * fs * 0.58 + 1.1 + ls * Math.max(0, lb.text.length - 1)
    const h = fs * 0.7 + 0.8
    const bx = lb.anchor === 'middle' ? -w / 2 : lb.anchor === 'end' ? -w : 0
    // back silk is mirrored about its anchor so it reads from the back (rotDeg is the rotation seen from the back)
    const back = lb.layer === 'silkBack'
    const color = lb.layer === 'copper' ? '#d9b34a' : back ? '#b58cff' : '#e6e8ec'
    return {
      id: lb.id,
      tr: `translate(${x.toFixed(3)} ${y.toFixed(3)})${back ? ' scale(-1 1)' : ''} rotate(${(-lb.rotDeg).toFixed(2)})`,
      text: lb.text,
      fs,
      ls,
      // SVG letter-spacing also follows the last glyph: shift so the ink stays centred / right-aligned
      dx: lb.anchor === 'middle' ? ls / 2 : lb.anchor === 'end' ? ls : 0,
      weight: lb.weight,
      anchor: lb.anchor,
      boxed: !!lb.boxed,
      box: { x: bx, y: -h + 0.4, w, h },
      color,
      boxFill: color
    }
  })
})
</script>

<template>
  <g style="user-select: none">
    <g v-for="it in items" :key="it.id" v-memo="[it.tr, it.text, it.fs, it.ls, it.weight, it.anchor, it.boxed, it.color, selected.has(it.id)]" :transform="it.tr" data-kind="label" :data-id="it.id">
      <rect v-if="it.boxed" :x="it.box.x" :y="it.box.y" :width="it.box.w" :height="it.box.h" fill="#0b0d10" :stroke="it.boxFill" stroke-width="0.15" data-kind="label" :data-id="it.id" />
      <text :x="it.dx" :letter-spacing="it.ls || undefined" :font-size="it.fs" :font-weight="it.weight" :text-anchor="it.anchor" font-family="Jost, sans-serif" :fill="it.color" :stroke="selected.has(it.id) ? '#4f9cff' : 'none'" stroke-width="0.12" data-kind="label" :data-id="it.id">{{ it.text }}</text>
    </g>
  </g>
</template>

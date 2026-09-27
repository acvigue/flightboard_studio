<script setup lang="ts">
import { computed } from 'vue'
import { LINE_WIDTH, type LineFeature, type Pt } from '../../core/model'
import type { BoardTransform } from '../../core/transform'

const props = defineProps<{ lines: LineFeature[]; tf: BoardTransform; strokeZ: number; selected: Set<string>; rev: number; showAxes: boolean; colors?: Record<string, string> }>()
const color: Record<string, string> = {
  taxiway: '#bfc4cc', taxilane: '#8f95a0', runway_cl: '#e6e8ec', road_major: '#8a9098', road: '#6f757f', road_minor: '#565c66', rail: '#7a6f5a', custom: '#c9ccd2'
}
// projected point strings, cached by geometry identity (edits always replace the pts array): a zoom step or a
// single-line edit no longer re-projects every line on the board
let cacheTf: BoardTransform | null = null
let cache = new WeakMap<Pt[], string>()
function ptsStr(pts: Pt[]): string {
  const t = props.tf
  if (t !== cacheTf) {
    cacheTf = t
    cache = new WeakMap()
  }
  let v = cache.get(pts)
  if (v === undefined) {
    v = pts.map((q) => t.toMm(q)).map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')
    cache.set(pts, v)
  }
  return v
}
const items = computed(() => {
  void props.rev
  const out: { id: string; pts: string; stroke: string; w: number; dash: string | undefined }[] = []
  for (const l of props.lines) {
    if (l.cls === 'runway_cl' && l.sub === 'axis' && !props.showAxes) continue
    out.push({
      id: l.id,
      pts: ptsStr(l.pts),
      stroke: l.layer === 'copper' ? '#d9b34a' : l.layer === 'silkBack' ? '#b58cff' : (props.colors?.[l.cls] ?? color[l.cls] ?? '#ccc'),
      w: Math.max(l.widthMm ?? LINE_WIDTH[l.cls] ?? 0.15, 0.9 / props.strokeZ),
      dash: l.cls === 'runway_cl' && l.sub === 'axis' ? `${1 / props.strokeZ} ${1 / props.strokeZ}` : undefined
    })
  }
  return out
})
</script>

<template>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round" class="lines">
    <polyline
      v-for="it in items"
      :key="it.id"
      v-memo="[it.pts, it.w, selected.has(it.id)]"
      :points="it.pts"
      :stroke="selected.has(it.id) ? '#4f9cff' : it.stroke"
      :stroke-width="selected.has(it.id) ? it.w + 0.15 : it.w"
      :stroke-dasharray="it.dash"
      data-kind="line"
      :data-id="it.id"
    />
  </g>
</template>

<style scoped>
.lines polyline:hover { stroke: #ffffff; }
</style>

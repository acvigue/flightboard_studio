<script setup lang="ts">
import { computed } from 'vue'
import { DEFAULT_HATCH, LINE_WIDTH, type ArtLayer, type HatchSpec, type PolyFeature, type Pt } from '../../core/model'
import type { BoardTransform } from '../../core/transform'

const props = defineProps<{ polys: PolyFeature[]; tf: BoardTransform; strokeZ: number; selected: Set<string>; rev: number; colors?: Record<string, string> }>()
const style: Record<string, { fill: string; stroke: string }> = {
  pavement: { fill: '#20242a', stroke: '#c9ccd2' },
  runway: { fill: '#2b3038', stroke: '#e6e8ec' },
  stopway: { fill: 'none', stroke: '#8d919a' },
  apron: { fill: '#20242a', stroke: '#c9ccd2' },
  terminal: { fill: 'none', stroke: '#d9b34a' },
  building: { fill: 'none', stroke: '#9aa1ad' },
  parking: { fill: 'none', stroke: '#6d7380' },
  custom: { fill: 'none', stroke: '#c9ccd2' }
}
const layerOf = (p: PolyFeature): ArtLayer => p.layer ?? (p.cls === 'terminal' ? 'copper' : 'silk')
const layerColor = (layer: ArtLayer): string | null => (layer === 'copper' ? '#d9b34a' : layer === 'silkBack' ? '#b58cff' : null)
const fillOf = (p: PolyFeature): 'none' | 'solid' | 'hatch' => p.fill ?? (p.cls === 'terminal' ? 'hatch' : 'none')
const hatchId = (h: HatchSpec, layer: string): string => `h_${layer}_${Math.round(h.angleDeg)}_${h.pitchMm.toFixed(2)}_${h.cross ? 'x' : 'l'}_${h.widthMm.toFixed(2)}`.replace(/\./g, 'p')
const patterns = computed(() => {
  void props.rev
  const m = new Map<string, { id: string; h: HatchSpec; color: string }>()
  for (const p of props.polys) {
    if (fillOf(p) !== 'hatch') continue
    const h = p.hatch ?? DEFAULT_HATCH
    const layer = layerOf(p)
    const id = hatchId(h, layer)
    if (!m.has(id)) m.set(id, { id, h, color: layerColor(layer) ?? '#e6e8ec' })
  }
  return [...m.values()]
})
// path data cached by rings identity (edits always replace the rings array)
let cacheTf: BoardTransform | null = null
let cache = new WeakMap<Pt[][], string>()
function ringsD(rings: Pt[][]): string {
  const t = props.tf
  if (t !== cacheTf) {
    cacheTf = t
    cache = new WeakMap()
  }
  let v = cache.get(rings)
  if (v === undefined) {
    v = rings.map((r) => 'M' + r.map((q) => t.toMm(q)).map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L') + 'Z').join('')
    cache.set(rings, v)
  }
  return v
}
const items = computed(() => {
  void props.rev
  return props.polys.map((p) => {
    const layer = layerOf(p)
    const fill = fillOf(p)
    const color = layerColor(layer) ?? props.colors?.[p.cls] ?? style[p.cls]?.stroke ?? '#c9ccd2'
    const stroke = p.strokeMm ?? LINE_WIDTH[p.cls] ?? 0.15
    return {
      id: p.id,
      d: ringsD(p.rings),
      fill: fill === 'solid' ? color : fill === 'hatch' ? `url(#${hatchId(p.hatch ?? DEFAULT_HATCH, layer)})` : (style[p.cls]?.fill ?? 'none'),
      stroke: stroke > 0 ? color : 'none',
      w: Math.max(stroke, 0.9 / props.strokeZ),
      locked: !!p.locked
    }
  })
})
</script>

<template>
  <g>
    <defs>
      <pattern v-for="pt in patterns" :id="pt.id" :key="pt.id" patternUnits="userSpaceOnUse" :width="pt.h.pitchMm" :height="pt.h.pitchMm" :patternTransform="`rotate(${-pt.h.angleDeg})`">
        <line x1="0" y1="0" :x2="0" :y2="pt.h.pitchMm" :stroke="pt.color" :stroke-width="pt.h.widthMm" />
        <line v-if="pt.h.cross" x1="0" :y1="0" :x2="pt.h.pitchMm" y2="0" :stroke="pt.color" :stroke-width="pt.h.widthMm" />
      </pattern>
    </defs>
    <path
      v-for="it in items"
      :key="it.id"
      v-memo="[it.d, it.w, it.fill, it.stroke, selected.has(it.id)]"
      :d="it.d"
      :fill="it.fill"
      :stroke="selected.has(it.id) ? '#4f9cff' : it.stroke"
      :stroke-width="selected.has(it.id) ? it.w + 0.15 : it.w"
      fill-rule="evenodd"
      data-kind="poly"
      :data-id="it.id"
    />
  </g>
</template>

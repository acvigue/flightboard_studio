<script setup lang="ts">
// PCB overlay: the generator's blocks at their poses (green = checks pass, red = a rule fails, with the antenna bump
// and the controller's channel pads), the LED data chains (one colour per channel, arrows along the data flow) and
// the route preview (data tracks top red / bottom blue, data vias, 5SW vias, caps, unrouted hops magenta).
// The route is drawn as a handful of <path>s so 10k segments stay cheap.
import { computed } from 'vue'
import { useProject } from '../../stores/project'
import { placeBlock } from '../../core/pcbtypes'
import type { BoardTransform } from '../../core/transform'

const props = defineProps<{ tf: BoardTransform; strokeZ: number; W: number; H: number }>()
const store = useProject()
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45']
const ptsStr = (pts: [number, number][]): string => pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')

const blocks = computed(() => {
  void store.rev.pcb
  const d = store.pcb.describe
  const s = store.project?.pcb
  if (!d || !s || !store.pcb.showBlocks) return []
  return d.blocks
    .map((b) => {
      const pose = s.blocks.find((x) => x.name === b.name)
      if (!pose) return null
      const g = placeBlock(b, pose, props.W, props.H)
      const chk = store.pcb.check?.blocks.find((x) => x.name === b.name)
      const ok = chk ? chk.ok : true
      const cx = g.outline.reduce((a, q) => a + q[0], 0) / g.outline.length
      const cy = g.outline.reduce((a, q) => a + q[1], 0) / g.outline.length
      return { name: b.name, outline: ptsStr(g.outline), bump: g.bump.length ? ptsStr(g.bump) : '', pads: g.pads, ok, stale: !chk, cx, cy, sel: store.pcb.selectedBlock === b.name }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
})

const route = computed(() => {
  void store.rev.pcb
  const g = store.pcb.route
  if (!g || !store.pcb.showRoute) return null
  const f = (v: number): string => v.toFixed(3)
  const segs = (a: number[]): string => {
    const out: string[] = []
    for (let i = 0; i + 3 < a.length; i += 4) out.push(`M${f(a[i])} ${f(a[i + 1])}L${f(a[i + 2])} ${f(a[i + 3])}`)
    return out.join('')
  }
  const dots = (a: number[], r: number): string => {
    const out: string[] = []
    for (let i = 0; i + 1 < a.length; i += 2) out.push(`M${f(a[i] - r)} ${f(a[i + 1])}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`)
    return out.join('')
  }
  const caps: string[] = []
  for (let i = 0; i + 2 < g.caps.length; i += 3) {   // 0402 body, 1.0 x 0.5 mm, rotated CCW as seen from the top
    const x = g.caps[i], y = g.caps[i + 1], a = (-g.caps[i + 2] * Math.PI) / 180
    const c = Math.cos(a), s = Math.sin(a)
    const pt = (u: number, v: number): string => `${f(x + u * c - v * s)} ${f(y + u * s + v * c)}`
    caps.push(`M${pt(-0.5, -0.25)}L${pt(0.5, -0.25)}L${pt(0.5, 0.25)}L${pt(-0.5, 0.25)}Z`)
  }
  // while a live update is on its way the old routing is shown as is (no flicker to "out of date" on every drag)
  return { top: segs(g.top), bottom: segs(g.bottom), vias: dots(g.vias, g.viaDiameter / 2), pvias: dots(g.powerVias, g.powerViaDiameter / 2), caps: caps.join(''), failed: g.failed, width: g.width, stale: store.pcbRouteStale && !store.pcb.routePending }
})

const chains = computed(() => {
  void store.rev.pcb
  void store.rev.leds
  const p = store.project
  if (!p || !store.pcb.showChains) return []
  const t = props.tf
  const by = new Map<number, { i: number; x: number; y: number }[]>()
  for (const l of p.leds) {
    if (!l.chain || l.chainIndex === undefined) continue
    const [x, y] = t.toMm(l.pos)
    const arr = by.get(l.chain) ?? []
    arr.push({ i: l.chainIndex, x, y })
    by.set(l.chain, arr)
  }
  return [...by.entries()].map(([k, arr]) => {
    arr.sort((a, b) => a.i - b.i)
    const pad = store.pcb.channelPads.find((c) => c.channel === k)
    const pts: [number, number][] = [...(pad ? [[pad.x, pad.y] as [number, number]] : []), ...arr.map((q) => [q.x, q.y] as [number, number])]
    // arrows every ~10 hops, at the hop midpoint, pointing along the data flow
    const arrows: string[] = []
    for (let i = 1; i < pts.length; i += 10) {
      const [ax, ay] = pts[i - 1]
      const [bx, by2] = pts[i]
      const mx = (ax + bx) / 2
      const my = (ay + by2) / 2
      const ang = (Math.atan2(by2 - ay, bx - ax) * 180) / Math.PI
      arrows.push(`translate(${mx.toFixed(3)} ${my.toFixed(3)}) rotate(${ang.toFixed(1)})`)
    }
    return { k, color: COLORS[(k - 1) % COLORS.length], line: ptsStr(pts), dots: arr, arrows }
  })
})
</script>

<template>
  <g class="pcb">
    <g v-for="c in chains" :key="c.k" pointer-events="none" :opacity="route && !route.stale ? 0.3 : 1">
      <polyline :points="c.line" fill="none" :stroke="c.color" :stroke-width="Math.max(0.12, 1.1 / strokeZ)" stroke-opacity="0.8" stroke-linejoin="round" />
      <circle v-for="(d, i) in c.dots" :key="i" :cx="d.x" :cy="d.y" :r="0.45" :fill="c.color" />
      <path v-for="(a, i) in c.arrows" :key="'a' + i" :transform="a" :d="`M${-1.2} ${-0.9}L0.6 0L${-1.2} 0.9`" fill="none" :stroke="c.color" :stroke-width="Math.max(0.15, 1.2 / strokeZ)" />
    </g>
    <g v-if="route" pointer-events="none" :opacity="route.stale ? 0.4 : 1">
      <path :d="route.caps" fill="#c9d1d9" fill-opacity="0.55" />
      <path :d="route.bottom" fill="none" stroke="#4f9cff" :stroke-width="Math.max(route.width, 0.9 / strokeZ)" stroke-linecap="round" stroke-opacity="0.85" />
      <path :d="route.top" fill="none" stroke="#ff5c5c" :stroke-width="Math.max(route.width, 0.9 / strokeZ)" stroke-linecap="round" stroke-opacity="0.9" />
      <path :d="route.pvias" fill="#a371f7" fill-opacity="0.8" />
      <path :d="route.vias" fill="#e3b341" />
      <line v-for="h in route.failed" :key="h.net" :x1="h.x1" :y1="h.y1" :x2="h.x2" :y2="h.y2" stroke="#ff00ff" :stroke-width="2.5 / strokeZ" :stroke-dasharray="`${4 / strokeZ} ${3 / strokeZ}`" />
    </g>
    <g v-for="b in blocks" :key="b.name">
      <polygon :points="b.outline" :fill="b.ok ? '#3fb95022' : '#ff5c5c33'" :stroke="b.sel ? '#4f9cff' : b.ok ? '#3fb950' : '#ff5c5c'" :stroke-width="(b.sel ? 2 : 1.2) / strokeZ" :stroke-dasharray="b.stale ? `${3 / strokeZ} ${2 / strokeZ}` : undefined" data-kind="block" :data-id="b.name" class="blk" />
      <polyline v-if="b.bump" :points="b.bump" fill="none" :stroke="b.ok ? '#3fb950' : '#ff5c5c'" :stroke-width="1 / strokeZ" :stroke-dasharray="`${2 / strokeZ} ${1.5 / strokeZ}`" pointer-events="none" />
      <circle v-for="pd in b.pads" :key="pd.channel" :cx="pd.x" :cy="pd.y" :r="0.35" :fill="COLORS[(pd.channel - 1) % COLORS.length]" pointer-events="none" />
      <text :x="b.cx" :y="b.cy" :font-size="Math.max(1.6, 12 / strokeZ)" text-anchor="middle" dominant-baseline="middle" :fill="b.ok ? '#3fb950' : '#ff8080'" font-family="ui-sans-serif, system-ui" pointer-events="none">{{ b.name }}</text>
    </g>
  </g>
</template>

<style scoped>
.blk { cursor: move; }
.blk:hover { fill-opacity: 0.35; }
</style>

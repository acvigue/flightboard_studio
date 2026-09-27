<script setup lang="ts">
// PCB tab: the Altium generator. Template, block placement (auto + live checks), LED chains, export options and the
// Altium project export. Blocks are dragged on the canvas; edge blocks snap to the nearest board edge.
import { computed, onMounted } from 'vue'
import { useProject } from '../stores/project'
import type { PcbBlockPose } from '../core/model'
import TooCloseList from './TooCloseList.vue'

const store = useProject()
const p = computed(() => {
  void store.version
  void store.rev.pcb
  return store.project
})
const s = computed(() => {
  void store.rev.pcb
  return p.value?.pcb
})
const describe = computed(() => store.pcb.describe)
const checkOf = (name: string) => store.pcb.check?.blocks.find((b) => b.name === name)
const poseOf = (name: string): PcbBlockPose | undefined => s.value?.blocks.find((b) => b.name === name)
const poseText = (b: PcbBlockPose | undefined): string => (!b ? 'auto' : b.edge ? `${b.edge} edge, ${b.t?.toFixed(1)} mm` : `(${b.x?.toFixed(1)}, ${b.y?.toFixed(1)}) ${b.rot ?? 0}°`)
const chainColors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45']
const num = (ev: Event): number => Number((ev.target as HTMLInputElement).value)
const chk = (ev: Event): boolean => (ev.target as HTMLInputElement).checked
const chainsTotal = computed(() => store.pcb.chainStats.reduce((a, c) => a + c.lengthMm, 0))
const exp = computed(() => store.pcb.lastExport)
const back = computed(() => store.backSilkSummary)
const expIssues = computed(() => {
  const r = exp.value?.report
  return !!r && ((r.data?.failed ?? 0) > 0 || (r.capConflictList?.length ?? 0) > 0 || (r.ledsTooClose?.length ?? 0) > 0)
})
// "by hand" = LEDs the user put on a chain (a preview that keeps chains pins every LED; that is not by hand)
const byHand = computed(() => {
  void store.rev.pcb
  void store.rev.leds
  const m: Record<number, number> = {}
  for (const l of p.value?.leds ?? []) if (l.chainUser && l.chain) m[l.chain] = (m[l.chain] ?? 0) + 1
  return m
})
const selectPair = (pr: string): void => store.pcbSelectDesignators(pr.split(' ')[0].split('/'))
const rt = computed(() => {
  void store.rev.pcb
  return store.pcb.route
})
onMounted(() => {
  if (!store.pcb.info) void store.pcbInfo()
})
const openFolder = (dir: string): void => { void window.api.openPath(dir) }
async function pickTemplate(): Promise<void> {
  const dir = await window.api.pickDir('Altium template project folder', store.pcbTemplate || undefined)
  if (!dir) return
  store.pcbSetOptions({ template: dir })
  await store.pcbPrepare()
}
</script>

<template>
  <div v-if="p">
    <h3>Altium generator</h3>
    <div class="small muted">
      <template v-if="store.pcb.info">
        <div v-if="store.pcb.info.exe">{{ store.pcb.info.exe.split('/').slice(-4).join('/') }}{{ store.pcb.info.version ? ` · ${store.pcb.info.version}` : '' }}</div>
        <div v-else class="err">not found: build pcbgen (dotnet publish) or set FB_PCBGEN</div>
      </template>
      <div class="tpl">template: {{ store.pcbTemplate ? store.pcbTemplate.split('/').slice(-2).join('/') : '—' }} <button class="link" @click="pickTemplate">change…</button></div>
      <div>job: {{ store.pcb.jobId ? (store.pcbJobStale ? 'out of date (the board changed)' : 'loaded') : 'not loaded' }}</div>
    </div>
    <div class="btns">
      <button class="primary" :disabled="store.busy" @click="store.pcbPrepare()">{{ store.pcb.jobId && !store.pcbJobStale ? 'Refresh' : 'Prepare' }}</button>
      <button :disabled="store.busy" title="Place every block automatically (MCU on an edge with the antenna out, USB-C on an edge, DCDC next to it)" @click="store.pcbAutoplace()">Auto-place blocks</button>
    </div>
    <p v-if="store.pcb.error" class="small err">{{ store.pcb.error }}</p>

    <h3>Blocks <label class="small inl"><input v-model="store.pcb.showBlocks" type="checkbox" /> show</label></h3>
    <div v-if="!describe" class="small muted">Prepare to load the template's blocks.</div>
    <div v-for="b in describe?.blocks ?? []" :key="b.name" class="blk" :class="{ sel: store.pcb.selectedBlock === b.name, bad: checkOf(b.name) && !checkOf(b.name)!.ok }" @click="store.pcb.selectedBlock = b.name">
      <div class="row1">
        <span class="dot" :class="!poseOf(b.name) ? 'auto' : checkOf(b.name)?.ok ? 'ok' : 'bad'"></span>
        <b>{{ b.name }}</b>
        <span class="muted small">{{ b.rule === 'free' ? 'anywhere' : b.rule === 'edge-antenna' ? 'edge, antenna out' : 'edge' }}</span>
      </div>
      <div class="small muted">{{ poseText(poseOf(b.name)) }}<template v-if="checkOf(b.name)"> · art {{ (checkOf(b.name)!.silkMm2 + checkOf(b.name)!.copperMm2).toFixed(0) }} mm²<template v-if="checkOf(b.name)!.usbGapMm !== undefined"> · {{ checkOf(b.name)!.usbGapMm!.toFixed(0) }} mm from USB-C</template></template></div>
      <div v-for="v in checkOf(b.name)?.violations ?? []" :key="v" class="small err">{{ v }}</div>
    </div>
    <p class="small muted">Drag a block on the board: edge blocks snap to the nearest edge, the DCDC block moves freely ([ ] rotate). Del returns a block to automatic placement.</p>

    <h3>Chains <label class="small inl"><input v-model="store.pcb.showChains" type="checkbox" /> show</label></h3>
    <div class="btns">
      <button :disabled="store.busy" @click="store.pcbAssignChains()">Assign chains</button>
    </div>
    <table v-if="store.pcb.chainStats.length" class="small tbl">
      <tr><th></th><th>LEDs</th><th>length</th><th>longest hop</th><th>by hand</th></tr>
      <tr v-for="c in store.pcb.chainStats" :key="c.chain">
        <td><span class="sw" :style="{ background: chainColors[(c.chain - 1) % chainColors.length] }"></span>CH{{ c.chain }}</td>
        <td>{{ c.count }}</td>
        <td>{{ (c.lengthMm / 1000).toFixed(2) }} m</td>
        <td>{{ c.longestHopMm.toFixed(0) }} mm</td>
        <td>{{ byHand[c.chain] || '' }}</td>
      </tr>
      <tr><td></td><td>{{ store.pcb.chainStats.reduce((a, c) => a + c.count, 0) }}</td><td>{{ (chainsTotal / 1000).toFixed(2) }} m</td><td></td><td></td></tr>
    </table>
    <p class="small muted">Select LEDs to put them on a chain by hand or keep their position (inspector). The generator balances the rest.</p>

    <TooCloseList />
    <h3>Routing <label class="small inl"><input v-model="store.pcb.showRoute" type="checkbox" /> show</label><label class="small inl" title="After a full preview, LED edits update the routing in place (chains kept as routed; export always runs in full)"><input v-model="store.pcb.routeLive" type="checkbox" /> live</label></h3>
    <div class="btns">
      <button :disabled="store.busy" title="Place the caps and 5SW vias and route every data line in memory, like the export, without writing files. The LEDs keep their current chains when every LED has one." @click="store.pcbPreviewRoute(false)">{{ store.pcb.route ? 'Preview again' : 'Preview routing' }}</button>
      <button v-if="store.pcb.route" :disabled="store.busy" title="Assign the chains again (hand chain edits are kept), then place and route" @click="store.pcbPreviewRoute(true)">Re-chain + preview</button>
    </div>
    <div v-if="rt" class="small exp">
      <div><b>{{ store.pcb.routeFrom === 'export' ? 'as exported' : store.pcb.routeFrom === 'incremental' ? 'live preview' : 'preview' }}</b><template v-if="store.pcb.routeFrom !== 'incremental' && store.pcb.routeInfo"> · {{ store.pcb.routeInfo.seconds }} s</template><span v-if="store.pcb.routePending" class="muted"> · updating…</span></div>
      <div v-if="store.pcb.routeFrom === 'incremental' && store.pcb.routeInc" class="muted">last edit: {{ store.pcb.routeInc.changed }} LED{{ store.pcb.routeInc.changed === 1 ? '' : 's' }} changed, {{ store.pcb.routeInc.replaced }} placed again, {{ store.pcb.routeInc.rerouted }} hops rerouted in {{ store.pcb.routeInc.ms.toFixed(0) }} ms ({{ store.pcb.routeInc.trip }} ms round trip) · {{ store.pcb.routeUpdates }} update{{ store.pcb.routeUpdates === 1 ? '' : 's' }} since the full preview; chains kept as routed</div>
      <div v-if="store.pcb.routeUpdates >= 20 && !store.pcbRouteStale" class="warn">many edits since the full preview: preview again to re-chain the LEDs like the export will</div>
      <div v-if="store.pcb.routeNeedFull && store.pcbRouteStale" class="warn">full preview needed: {{ store.pcb.routeNeedFull }}</div>
      <div v-else-if="store.pcbRouteStale && !store.pcb.routePending" class="warn">out of date: the board, the blocks or the chains changed since</div>
      <div>{{ rt.routed }}/{{ rt.routed + rt.failedCount }} hops · {{ rt.dataVias }} data vias · {{ (rt.trackMm / 1000).toFixed(2) }} m<span v-if="rt.failedCount" class="err"> · {{ rt.failedCount }} unrouted</span></div>
      <div v-if="store.pcb.routeInfo">{{ store.pcb.routeInfo.caps }} caps · {{ store.pcb.routeInfo.vias5sw }} 5SW vias · on art after trimming {{ store.pcb.routeInfo.onArt.caps }} caps, {{ store.pcb.routeInfo.onArt.vias }} vias</div>
      <div v-for="f in rt.failed.slice(0, 8)" :key="f.net" class="err">unrouted {{ f.net }}</div>
      <div v-if="rt.failedCount || rt.capConflicts?.length || rt.ledsTooClose?.length" class="attention">
        <b>Needs attention</b>
        <div v-if="rt.failedCount">{{ rt.failedCount }} unrouted hop{{ rt.failedCount === 1 ? '' : 's' }}: {{ rt.failed.map((f) => f.net).slice(0, 8).join(', ') }}</div>
        <div v-if="rt.capConflicts?.length">{{ rt.capConflicts.length }} cap{{ rt.capConflicts.length === 1 ? '' : 's' }} over another part: {{ rt.capConflicts.slice(0, 8).join(', ') }}</div>
        <div v-for="pr in (rt.ledsTooClose ?? []).slice(0, 8)" :key="pr">LED pads too close: {{ pr }} <button class="link" @click="selectPair(pr)">select</button></div>
      </div>
      <div class="legend"><span style="background:#ff5c5c"></span>top <span style="background:#4f9cff"></span>bottom <span class="dot" style="background:#e3b341"></span>data via <span class="dot" style="background:#a371f7"></span>5SW via <span style="background:#c9d1d9"></span>cap</div>
    </div>

    <h3>Export</h3>
    <label class="row"><span>Channels</span><input type="number" min="1" max="7" :value="s?.channels ?? 7" @change="store.pcbSetOptions({ channels: Math.max(1, Math.min(7, num($event))) })" /></label>
    <label class="row"><span>Route data lines</span><input type="checkbox" :checked="s?.routeData ?? true" @change="store.pcbSetOptions({ routeData: chk($event) })" /></label>
    <label class="row"><span>Silk off LEDs mm</span><input type="number" min="0" step="0.05" :value="s?.ledArtMargin ?? 0.1" title="Silk printed over an LED body is removed with this clearance (0 = only the body itself)" @change="store.pcbSetOptions({ ledArtMargin: Math.max(0, num($event)) })" /></label>
    <label class="row"><span>Firmware board id</span><input :value="s?.fwId ?? ''" :placeholder="p.board.id" title="boards/<id>.json in the flightboard firmware (ohare replaces the current O'Hare definition)" @change="store.pcbSetOptions({ fwId: ($event.target as HTMLInputElement).value.trim() || undefined })" /></label>
    <label class="row"><span>Clear back art around vias</span><input type="checkbox" :checked="s?.backSilkClearVias ?? false" title="Cut the Bottom Overlay art around every via. Off: the back silk is printed as drawn (the vias are tented)." @change="store.pcbSetOptions({ backSilkClearVias: chk($event) })" /></label>
    <label class="row"><span>Also write a zip</span><input type="checkbox" :checked="s?.zip ?? true" @change="store.pcbSetOptions({ zip: chk($event) })" /></label>
    <p class="small muted">Back silk (Bottom Overlay): {{ back.imported || back.drawn ? `${back.imported.toLocaleString()} imported polygons${back.drawn ? ` + ${back.drawn} drawn item${back.drawn === 1 ? '' : 's'}` : ''}` : 'none' }}<span v-if="back.hiddenImported || back.hiddenDrawn" class="warn"> · hidden in Layers, not exported</span></p>
    <div class="btns"><button class="primary" :disabled="store.busy" @click="store.pcbExport()">Export Altium project…</button></div>
    <p class="small" :class="store.pcbExportKeepsChains ? 'muted' : 'warn'">{{ store.pcbExportKeepsChains ? 'Export uses the chains of this preview (what the routing shows).' : 'Export will assign chains (no current preview): preview first to see what will be routed.' }}</p>
    <div v-if="exp" class="small exp" :class="{ amber: expIssues }">
      <div v-if="expIssues" class="attention">
        <b>Needs attention: the files were written, fix these before ordering</b>
        <div v-if="exp.report.data?.failed">{{ exp.report.data.failed }} unrouted hop{{ exp.report.data.failed === 1 ? '' : 's' }}: {{ exp.report.data.failedNets.slice(0, 8).join(', ') }}</div>
        <div v-if="exp.report.capConflictList?.length">{{ exp.report.capConflictList.length }} cap{{ exp.report.capConflictList.length === 1 ? '' : 's' }} over another part: {{ exp.report.capConflictList.slice(0, 8).join(', ') }}</div>
        <div v-for="pr in (exp.report.ledsTooClose ?? []).slice(0, 8)" :key="pr">LED pads too close: {{ pr }} <button class="link" @click="selectPair(pr)">select</button></div>
      </div>
      <div><b>{{ exp.project.split('/').pop() }}</b> · {{ exp.report.seconds }} s</div>
      <div>{{ exp.report.leds }} LEDs · {{ exp.report.caps }} caps · {{ exp.report.vias5sw }} 5SW vias</div>
      <div v-if="exp.report.data">data {{ exp.report.data.routed }}/{{ exp.report.data.total }} hops · {{ exp.report.data.vias }} vias · {{ (exp.report.data.trackMm / 1000).toFixed(1) }} m<span v-if="exp.report.data.failed" class="err"> · {{ exp.report.data.failed }} unrouted</span></div>
      <div>on art after trimming: {{ exp.report.onArtAfterTrim.caps }} caps, {{ exp.report.onArtAfterTrim.vias }} vias · LEDs under blocks {{ exp.report.ledsInsideBlocks }}</div>
      <div v-if="exp.report.gpios?.length" title="MCU data pin of each chain, read from the generated board">pins: {{ exp.report.gpios.map((g) => `CH${g.chain} GPIO${g.gpio}`).join(' · ') }}<template v-if="exp.report.statusGpio"> · status GPIO{{ exp.report.statusGpio.gpio }}</template></div>
      <div v-if="store.pcb.lastFirmware">firmware: {{ store.pcb.lastFirmware.id }}_firmware_board.json · {{ store.pcb.lastFirmware.leds }} LEDs, {{ store.pcb.lastFirmware.chains }} chains<span v-if="store.pcb.lastFirmware.installed"> · installed</span></div>
      <div class="btns"><button @click="openFolder(exp.outDir)">Open folder</button><button :disabled="store.busy" title="Write boards/<id>.json into ../flightboard and run tools/gen_board_hpp.py" @click="store.pcbInstallFirmware()">Install into flightboard</button></div>
    </div>
  </div>
  <div v-else class="muted">Build or open a board first.</div>
</template>

<style scoped>
.err { color: var(--danger); }
.tpl { display: flex; gap: 6px; align-items: center; }
button.link { background: none; border: none; color: var(--accent); padding: 0; }
.inl { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 6px; }
.inl input { width: auto; }
.blk { border: 1px solid var(--line); border-radius: 5px; padding: 5px 7px; margin: 4px 0; cursor: pointer; }
.blk.sel { border-color: var(--accent); }
.blk.bad { border-color: #7a3030; }
.row1 { display: flex; align-items: center; gap: 6px; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dot.ok { background: #3fb950; } .dot.bad { background: var(--danger); } .dot.auto { background: var(--muted); }
.tbl { width: 100%; border-collapse: collapse; margin: 4px 0; }
.tbl td, .tbl th { padding: 2px 4px; text-align: right; }
.tbl td:first-child, .tbl th:first-child { text-align: left; }
.sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-right: 5px; }
.exp { border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; margin-top: 6px; line-height: 1.5; }
.warn { color: #e3b341; }
.attention { border: 1px solid #b0561b; background: #b0561b1f; color: var(--text, inherit); border-radius: 4px; padding: 5px 7px; margin: 4px 0; line-height: 1.45; }
.attention b { color: #f0925a; display: block; }
.exp.amber { border-color: #b0561b; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin-top: 2px; }
.legend span { display: inline-block; width: 12px; height: 3px; margin-right: -4px; }
.legend span.dot { width: 7px; height: 7px; border-radius: 50%; }
</style>

<script setup lang="ts">
// Fullscreen loader for long-running tasks: blocks input as soon as a task starts, becomes visible after a short
// delay (quick tasks do not flash), shows a live status log, the elapsed time and Cancel. On failure it stays open
// with the error and the log until dismissed. The spinner is a compositor animation, so it keeps turning even if
// the page is busy rendering.
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useProject } from '../stores/project'

const store = useProject()
const t = computed(() => store.task)
const logEl = ref<HTMLElement | null>(null)
const now = ref(performance.now())
let timer: ReturnType<typeof setInterval> | null = null
watch(
  () => t.value.active,
  (on) => {
    if (on && !timer) timer = setInterval(() => (now.value = performance.now()), 100)
    if (!on && timer) {
      clearInterval(timer)
      timer = null
    }
  },
  { immediate: true }
)
onUnmounted(() => timer && clearInterval(timer))
const elapsed = computed(() => Math.max(0, (now.value - t.value.started) / 1000))
watch(
  () => t.value.lines.length,
  async () => {
    await nextTick()
    const el = logEl.value
    if (el) el.scrollTop = el.scrollHeight
  }
)
const last = computed(() => t.value.lines[t.value.lines.length - 1] ?? '')
</script>

<template>
  <div v-if="t.active" class="busy-overlay" :class="{ failed: !!t.error }" @contextmenu.prevent @wheel.prevent>
    <div class="card" role="status" aria-live="polite">
      <div class="head">
        <div v-if="!t.error" class="spinner" aria-hidden="true"></div>
        <div v-else class="err-dot" aria-hidden="true">!</div>
        <div class="titles">
          <div class="title">{{ t.title }}</div>
          <div class="sub mono">{{ t.error ? 'failed: ' + t.error : last || 'working…' }}</div>
        </div>
        <div class="time mono">{{ elapsed.toFixed(1) }} s</div>
      </div>
      <div ref="logEl" class="log mono">
        <div v-for="(l, i) in t.lines" :key="i" :class="{ errline: l.startsWith('ERROR') }">{{ l }}</div>
        <div v-if="!t.lines.length" class="muted">starting…</div>
      </div>
      <div class="actions">
        <button v-if="t.error" class="primary" @click="store.dismissTask()">Close</button>
        <button v-else :disabled="!t.cancellable" title="Stop the background computation (nothing is changed)" @click="store.cancelCurrentTask()">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.busy-overlay {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  background: rgba(8, 10, 13, 0.72); backdrop-filter: blur(3px); cursor: progress;
  animation: fade-in 0.18s ease-out 0.2s both;
}
.busy-overlay.failed { animation-delay: 0s; cursor: default; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.card {
  width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column; gap: 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; box-shadow: 0 20px 60px #000c;
  cursor: default;
}
.head { display: flex; align-items: center; gap: 14px; }
.titles { flex: 1; min-width: 0; }
.title { font-size: 15px; font-weight: 600; }
.sub { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.time { color: var(--muted); font-variant-numeric: tabular-nums; }
.spinner {
  width: 26px; height: 26px; border-radius: 50%; border: 3px solid #2a3a55; border-top-color: var(--accent);
  animation: spin 0.8s linear infinite; will-change: transform; flex: none;
}
@keyframes spin { to { transform: rotate(360deg); } }
.err-dot { width: 26px; height: 26px; border-radius: 50%; background: var(--danger); color: #fff; display: grid; place-items: center; font-weight: 700; flex: none; }
.log {
  flex: 1; min-height: 140px; max-height: 46vh; overflow: auto; background: #0f1114; border: 1px solid var(--line);
  border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; line-height: 1.45; color: #c9ccd2;
}
.errline { color: var(--danger); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

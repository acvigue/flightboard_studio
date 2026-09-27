<script setup lang="ts">
// A toolbar button that opens a dropdown panel; closes on outside click or Escape.
import { onMounted, onUnmounted, ref } from 'vue'
defineProps<{ label?: string; icon?: string; title?: string; active?: boolean }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
function onDoc(ev: MouseEvent): void {
  if (root.value && !root.value.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDoc)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDoc)
  document.removeEventListener('keydown', onKey)
})
defineExpose({ close: () => (open.value = false) })
</script>

<template>
  <div ref="root" class="mb">
    <button :class="{ active: open || active }" :title="title" @click="open = !open">
      <slot name="button"><span v-if="icon" class="ic"><Icon :name="icon" /></span>{{ label }}<span class="caret">▾</span></slot>
    </button>
    <div v-if="open" class="menu" @click="$emit('pick')">
      <slot />
    </div>
  </div>
</template>

<script lang="ts">
import Icon from './Icon.vue'
export default { components: { Icon } }
</script>

<style scoped>
.mb { position: relative; display: inline-block; }
.menu { position: absolute; top: 100%; left: 0; z-index: 50; min-width: 220px; background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 4px; box-shadow: 0 8px 24px #0009; margin-top: 4px; }
.caret { margin-left: 4px; font-size: 10px; color: var(--muted); }
.ic { display: inline-flex; vertical-align: -3px; margin-right: 4px; }
</style>

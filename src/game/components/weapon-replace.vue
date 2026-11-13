<template>
  <div class="weapon-replace">
    <div class="weapon-replace__panel">
      <h2 class="weapon-replace__title">空投：{{ choice.name }}</h2>
      <p class="weapon-replace__lead">背包已有 2 把武器，选择要替换的一把</p>
      <div class="weapon-replace__slots">
        <button
          v-for="(w, i) in hud.weapons"
          :key="`${i}-${w.id}`"
          class="weapon-replace__slot"
          @click="hudActions.resolveWeaponChoice(i)"
        >
          <span class="weapon-replace__slot-key">槽位 {{ i + 1 }}</span>
          <span class="weapon-replace__slot-name">{{ w.name }}</span>
          <span class="weapon-replace__slot-ammo">{{ w.mag }} / {{ w.reserve }}</span>
          <span class="weapon-replace__slot-action">替换为 {{ choice.name }}</span>
        </button>
      </div>
      <button class="weapon-replace__cancel" @click="hudActions.resolveWeaponChoice(null)">放弃，保留现有武器</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { hud, hudActions } from '../core/state'

defineProps<{
  /** 箱内的新武器 */
  choice: { name: string }
}>()
</script>

<style scoped>
@reference "@/style.css";

.weapon-replace {
  @apply pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 text-slate-100 backdrop-blur-sm select-none;
}

.weapon-replace__panel {
  @apply flex w-[min(90vw,560px)] flex-col items-center gap-3 rounded-2xl border border-slate-700/80 bg-slate-900/95 px-6 py-7;
}

.weapon-replace__title {
  @apply text-2xl font-bold text-amber-300;
}

.weapon-replace__lead {
  @apply text-sm text-slate-300;
}

.weapon-replace__slots {
  @apply mt-2 grid w-full grid-cols-2 gap-3;
}

.weapon-replace__slot {
  @apply flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-slate-600/70 bg-slate-800/70 p-3 text-left text-slate-100 transition-colors hover:border-amber-400;
}

.weapon-replace__slot-key {
  @apply text-xs text-slate-400;
}

.weapon-replace__slot-name {
  @apply text-lg font-bold;
}

.weapon-replace__slot-ammo {
  @apply text-sm text-slate-300 tabular-nums;
}

.weapon-replace__slot-action {
  @apply mt-1 text-xs text-amber-300;
}

.weapon-replace__cancel {
  @apply mt-2 cursor-pointer rounded-lg border border-slate-600 bg-transparent px-5 py-2 text-sm text-slate-300 hover:border-slate-400 hover:text-slate-100;
}
</style>

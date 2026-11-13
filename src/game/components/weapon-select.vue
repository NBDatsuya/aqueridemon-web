<template>
  <div class="weapon-select">
    <div class="weapon-select__panel">
      <p class="weapon-select__eyebrow">CHAOS IN SCHOOL 2 PROLOGUE</p>
      <h1 class="weapon-select__title">选择你的武器</h1>
      <p class="weapon-select__lead">
        感染爆发的校园足球场。你是 Samuel，和三名队友守住绿茵场，击败阿奎尔巨兽，带着样本全员登上直升机。
      </p>

      <div class="weapon-select__grid">
        <button v-for="w in weapons" :key="w.id" class="weapon-select__card" @click="hudActions.selectWeapon(w.id)">
          <span class="weapon-select__kind">{{ w.kind }}</span>
          <span class="weapon-select__name">{{ w.name }}</span>
          <span class="weapon-select__trait">{{ w.trait }}</span>
          <span v-for="s in w.stats" :key="s.label" class="weapon-select__stat">
            <span class="weapon-select__stat-label">{{ s.label }}</span>
            <span class="weapon-select__stat-bar">
              <span class="weapon-select__stat-fill" :style="{ width: `${s.ratio * 100}%` }" />
            </span>
            <span class="weapon-select__stat-value">{{ s.value }}</span>
          </span>
        </button>
      </div>

      <p class="weapon-select__keys">
        WASD 移动 · Shift 冲刺 · 空格 跳跃 · 左键 射击 · R 换弹 · 1/2 或滚轮 切枪 · E 交互 · ESC 暂停
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { WEAPONS, WEAPON_ORDER } from '../core/config'
import { hudActions } from '../core/state'

const weapons = WEAPON_ORDER.map((id) => {
  const def = WEAPONS[id]
  const dps = Math.round(def.damage * (def.rpm / 60))
  return {
    id,
    name: def.name,
    kind: def.kind,
    trait: def.trait,
    stats: [
      { label: '伤害', value: `${def.damage}`, ratio: def.damage / 40 },
      { label: '射速', value: `${def.rpm}`, ratio: def.rpm / 900 },
      { label: '秒伤', value: `${dps}`, ratio: dps / 400 },
      { label: '弹匣', value: `${def.magSize}/${def.reserveMax}`, ratio: def.magSize / 100 },
      { label: '换弹', value: `${def.reloadTime}s`, ratio: 1 - def.reloadTime / 5 },
    ],
  }
})
</script>

<style scoped>
@reference "@/style.css";

.weapon-select {
  @apply pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 text-slate-100 backdrop-blur-sm select-none;
}

.weapon-select__panel {
  @apply flex w-[min(94vw,1080px)] flex-col items-center gap-4 px-4;
}

.weapon-select__eyebrow {
  @apply text-xs font-bold tracking-[0.4em] text-amber-500/80;
}

.weapon-select__title {
  @apply text-4xl font-extrabold tracking-[0.3em] text-amber-400;
}

.weapon-select__lead {
  @apply max-w-2xl text-center text-sm text-slate-300;
}

.weapon-select__grid {
  @apply mt-2 grid w-full grid-cols-2 gap-4 lg:grid-cols-4;
}

.weapon-select__card {
  @apply flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border border-slate-600/70 bg-slate-900/80 p-4 text-left text-slate-100 transition-all duration-150 hover:-translate-y-1 hover:border-amber-400 hover:bg-slate-800/90;
}

.weapon-select__kind {
  @apply text-xs tracking-widest text-slate-400;
}

.weapon-select__name {
  @apply text-xl font-bold text-amber-300;
}

.weapon-select__trait {
  @apply mb-2 text-sm text-slate-300;
}

.weapon-select__stat {
  @apply flex items-center gap-2 text-xs;
}

.weapon-select__stat-label {
  @apply w-8 text-slate-400;
}

.weapon-select__stat-bar {
  @apply h-1.5 flex-1 overflow-hidden rounded-sm bg-slate-700/80;
}

.weapon-select__stat-fill {
  @apply block h-full bg-amber-400;
}

.weapon-select__stat-value {
  @apply w-14 text-right text-slate-200 tabular-nums;
}

.weapon-select__keys {
  @apply mt-2 text-center text-xs text-slate-400;
}
</style>

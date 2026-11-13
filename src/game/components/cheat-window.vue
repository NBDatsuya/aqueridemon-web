<template>
  <div class="cheat-window" @click.self="focusInput">
    <div class="cheat-window__panel">
      <div class="cheat-window__head">
        <span class="cheat-window__dot" />
        <span class="cheat-window__title">CHEAT CONSOLE</span>
        <span class="cheat-window__hint">` 切换 · Enter 执行 · Esc 关闭</span>
      </div>
      <div class="cheat-window__row">
        <span class="cheat-window__prompt">&gt;</span>
        <input
          ref="input"
          v-model="code"
          class="cheat-window__input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="输入指令…"
        />
        <button type="button" class="cheat-window__run" @click="submit">执行</button>
      </div>
      <p v-if="hud.cheatError" class="cheat-window__error">{{ hud.cheatError }}</p>
      <div class="cheat-window__help">
        <span class="cheat-window__cmd">boss</span>
        <span class="cheat-window__cmd-desc">清场并在 5 秒后召唤阿奎尔巨兽</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { hud, hudActions } from '../core/state'

const input = ref<HTMLInputElement | null>(null)
const code = ref('')

/**
 * 控制台打开期间，所有按键都归控制台。
 * 在 window 捕获阶段 stopPropagation：外壳的 ESC 会开暂停菜单、游戏输入系统会记按键，
 * 两者都挂在冒泡阶段，这里截断后它们一律收不到事件。
 */
function onKeyDown(e: KeyboardEvent): void {
  e.stopPropagation()
  // 中文输入法组词阶段的 Enter / Esc 不算操作
  if (e.isComposing) return
  if (e.code === 'Backquote' || e.key === 'Escape') hudActions.closeCheat()
  else if (e.key === 'Enter') submit()
}

onMounted(() => {
  input.value?.focus()
  window.addEventListener('keydown', onKeyDown, true)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown, true)
})

function focusInput(): void {
  input.value?.focus()
}

function submit(): void {
  hudActions.submitCheat(code.value)
  code.value = ''
}
</script>

<style scoped>
@reference "@/style.css";

.cheat-window {
  @apply pointer-events-auto absolute inset-0 z-40 flex items-start justify-center bg-slate-950/60 pt-[16vh] text-emerald-100 backdrop-blur-sm select-none;
}

.cheat-window__panel {
  @apply flex w-[min(92vw,560px)] flex-col gap-2 rounded-xl border border-emerald-500/50 bg-slate-950/95 px-5 py-4 font-mono shadow-[0_0_40px_rgb(16_185_129/0.15)];
}

.cheat-window__head {
  @apply flex items-center gap-2 border-b border-emerald-500/30 pb-2;
}

.cheat-window__dot {
  @apply h-2.5 w-2.5 rounded-full bg-emerald-400;
  box-shadow: 0 0 8px rgb(52 211 153 / 0.9);
}

.cheat-window__title {
  @apply text-sm font-bold tracking-[0.3em] text-emerald-300;
}

.cheat-window__hint {
  @apply ml-auto text-xs text-slate-500;
}

.cheat-window__row {
  @apply flex items-center gap-2;
}

.cheat-window__prompt {
  @apply text-lg font-bold text-emerald-400;
}

.cheat-window__input {
  @apply min-w-0 flex-1 bg-transparent text-base text-emerald-100 caret-emerald-400 outline-none placeholder:text-slate-600;
}

.cheat-window__run {
  @apply cursor-pointer rounded border border-emerald-500/60 bg-emerald-500/10 px-4 py-1 text-sm text-emerald-200 transition-colors hover:bg-emerald-500/25;
}

.cheat-window__error {
  @apply m-0 text-sm text-red-400;
}

.cheat-window__help {
  @apply flex items-center gap-3 border-t border-emerald-500/30 pt-2 text-xs text-slate-400;
}

.cheat-window__cmd {
  @apply rounded bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-300;
}

.cheat-window__cmd-desc {
  @apply text-slate-400;
}
</style>

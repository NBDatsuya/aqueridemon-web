<template>
  <Transition name="loading-overlay" appear @after-enter="emit('shown')" @after-leave="emit('hidden')">
    <div v-if="active" class="loading-overlay" role="status" aria-live="polite" :aria-busy="true">
      <div class="loading-overlay__panel">
        <!-- 没有确定进度时才转圈：转圈只改 transform，主线程被同步计算卡住时合成器线程仍能继续转动 -->
        <div v-if="progressValue === null" class="loading-overlay__spinner" aria-hidden="true">
          <span class="loading-overlay__ring" />
          <span class="loading-overlay__arc" />
        </div>
        <p class="loading-overlay__label">{{ label }}</p>
        <div v-if="progressValue !== null" class="loading-overlay__progress" aria-hidden="true">
          <p class="loading-overlay__percent">
            {{ percent }}<span class="loading-overlay__percent-sign">%</span>
          </p>
          <div class="loading-overlay__track">
            <div class="loading-overlay__bar" :style="{ transform: `scaleX(${progressValue})` }" />
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  /** 提示文案 */
  label?: string;
  /** 进度 0..1；不传则不显示进度条 */
  progress?: number;
  /** 是否显示；切换时带淡入淡出 */
  active?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  label: '加载中',
  progress: undefined,
  active: true,
});

const emit = defineEmits<{
  /** 淡入完成，遮罩已经完全盖住底下的内容 */
  shown: [];
  /** 淡出完成 */
  hidden: [];
}>();

/** 夹到 0..1；未提供或不是有限数时返回 null */
const progressValue = computed<number | null>(() => {
  const value = props.progress;
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
});

/** 进度百分比文案 */
const percent = computed<number>(() => Math.round((progressValue.value ?? 0) * 100));
</script>

<style scoped>
@reference "../styles/hud.css";

/* 固定定位并给高层级：盖住菜单、游戏画面、暂停按钮与选枪界面 */
.loading-overlay {
  @apply fixed inset-0 z-[200] flex items-center justify-center bg-(--color-bg-page) bg-radial from-slate-800 via-slate-900 to-slate-950 select-none;
}

.loading-overlay__panel {
  @apply flex flex-col items-center gap-5;
}

.loading-overlay__spinner {
  @apply relative h-14 w-14;
}

.loading-overlay__ring {
  @apply absolute inset-0 rounded-full border-4 border-(--color-border-subtle);
}

.loading-overlay__arc {
  @apply absolute inset-0 rounded-full border-4 border-transparent border-t-(--color-accent) border-r-(--color-accent)/40;
  will-change: transform;
  animation: loading-overlay-spin 0.9s linear infinite;
}

.loading-overlay__label {
  @apply text-sm font-semibold tracking-[0.3em] text-(--color-text-secondary) uppercase;
  animation: loading-overlay-pulse 1.6s ease-in-out infinite;
}

.loading-overlay__progress {
  @apply flex flex-col items-center gap-4;
}

.loading-overlay__track {
  @apply h-1.5 w-72 overflow-hidden rounded-full bg-(--color-bg-surface);
}

.loading-overlay__percent {
  @apply text-5xl leading-none font-extrabold tracking-[0.05em] text-(--color-text-primary) tabular-nums;
}

.loading-overlay__percent-sign {
  @apply ml-1 text-lg font-semibold tracking-normal text-(--color-text-secondary);
}

.loading-overlay__bar {
  @apply h-full w-full origin-left bg-(--color-accent);
  transition: transform 0.15s ease-out;
}

@keyframes loading-overlay-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes loading-overlay-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.loading-overlay-enter-active,
.loading-overlay-leave-active {
  transition: opacity 0.3s ease;
}

.loading-overlay-enter-from,
.loading-overlay-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .loading-overlay__arc {
    animation-duration: 2.4s;
  }

  .loading-overlay__label {
    animation: none;
  }
}
</style>

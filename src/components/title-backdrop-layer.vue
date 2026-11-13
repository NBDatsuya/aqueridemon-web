<template>
  <!-- 菜单类页面共用的实时 3D 背景：挂在 App 根部，切换页面时不卸载，只切换暗角 -->
  <div class="title-backdrop" aria-hidden="true">
    <div
      ref="host"
      class="title-backdrop__canvas"
      :class="{ 'title-backdrop__fade--visible': shown }"
    />
    <!-- 菜单暗角常驻；内容页的压暗叠在它上面单独淡入淡出，亮度单向变化，不会两层交叉淡化时先变亮再变暗 -->
    <div
      class="title-backdrop__scrim title-backdrop__scrim--menu"
      :class="{ 'title-backdrop__fade--visible': shown }"
    />
    <div
      class="title-backdrop__scrim title-backdrop__scrim--page"
      :class="{ 'title-backdrop__fade--visible': shown && variant === 'page' }"
    />
  </div>
</template>

<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref } from 'vue';

interface Props {
  /** menu：左侧压暗衬托标题菜单；page：整体压暗，衬托设置、关于等内容页 */
  variant?: 'menu' | 'page';
}

withDefaults(defineProps<Props>(), {
  variant: 'menu',
});

/** 首帧画完、背景可见 */
const shown = defineModel<boolean>('shown', { default: false });
/** 背景仍在创建，父级据此显示加载遮罩 */
const loading = defineModel<boolean>('loading', { default: false });

/**
 * 可选：把实时背景挂进容器的函数，首帧画完后 resolve 出卸载函数
 * （游戏侧在 main.ts 提供，HUD 层不直接依赖游戏代码）
 */
const mountTitleBackdrop = inject<((host: HTMLElement) => Promise<() => void>) | null>(
  'jam:mount-title-backdrop',
  null,
);

const host = ref<HTMLElement | null>(null);
let unmounted = false;
let pendingFrame = 0;
let release: (() => void) | null = null;

// 重新挂载（例如从游戏页返回）时从未显示状态开始
shown.value = false;
loading.value = false;

onMounted(() => {
  const el = host.value;
  if (!mountTitleBackdrop || !el) return;
  let settled = false;
  // 已创建过时几毫秒内就能画出首帧，不显示遮罩，避免闪一下；下一帧仍未完成才显示
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    if (!settled && !unmounted) loading.value = true;
  });
  // 包一层 Promise：提供方同步抛错也走静默回退
  Promise.resolve()
    .then(() => mountTitleBackdrop(el))
    .then((cleanup) => {
      if (unmounted) {
        cleanup();
        return;
      }
      release = cleanup;
      shown.value = true;
    })
    .catch(() => {
      // 静默回退到纯色背景
    })
    .finally(() => {
      settled = true;
      if (!unmounted) loading.value = false;
    });
});

onUnmounted(() => {
  unmounted = true;
  if (pendingFrame) cancelAnimationFrame(pendingFrame);
  release?.();
  release = null;
});
</script>

<style scoped>
@reference "../styles/hud.css";

/* 叠在页面内容之下：父级需要 isolate 建立层叠上下文 */
.title-backdrop {
  @apply pointer-events-none fixed inset-0 -z-10;
}

.title-backdrop__canvas,
.title-backdrop__scrim {
  @apply absolute inset-0 opacity-0 transition-opacity duration-700;
}

.title-backdrop__fade--visible {
  @apply opacity-100;
}

/* 标题菜单：左侧压暗衬托菜单，右侧保留场地；上下边缘略暗 */
.title-backdrop__scrim--menu {
  background:
    linear-gradient(to right, rgb(2 6 23 / 0.88) 0%, rgb(2 6 23 / 0.6) 28%, rgb(2 6 23 / 0.25) 55%, rgb(2 6 23 / 0.4) 100%),
    linear-gradient(to bottom, rgb(2 6 23 / 0.45), transparent 25%, transparent 75%, rgb(2 6 23 / 0.6));
}

/* 内容页：叠在菜单暗角之上再整体压暗，保证卡片与正文可读；切页时只淡这一层，时间更短 */
.title-backdrop__scrim--page {
  @apply duration-300 ease-out;
  background:
    radial-gradient(ellipse at center, rgb(15 23 42 / 0.7) 0%, rgb(2 6 23 / 0.82) 100%);
}
</style>

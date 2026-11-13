<template>
  <div class="app-shell" :class="{ 'app-shell--backdrop': backdropActive }">
    <TitleBackdropLayer
      v-if="backdropEnabled"
      v-model:shown="backdropShown"
      v-model:loading="backdropLoading"
      v-model:progress="backdropProgress"
      v-model:label="backdropLabel"
      :variant="route.name === 'home' ? 'menu' : 'page'"
    />
    <RouterView />
    <!-- 全局只有这一个加载遮罩，跨路由常驻：从点击开始游戏一直盖到游戏准备完毕，中途不会露出底下的页面 -->
    <LoadingOverlay
      :active="overlayActive"
      :label="overlayLabel"
      :progress="overlayProgress"
      @shown="notifyLoadingScreenShown"
      @hidden="notifyLoadingScreenHidden"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { loadingScreen, notifyLoadingScreenHidden, notifyLoadingScreenShown } from '@/core';
import { useSettingsStore } from '@/hud';
import LoadingOverlay from './components/loading-overlay.vue';
import TitleBackdropLayer from './components/title-backdrop-layer.vue';

interface MenuMusicHandle {
  unlock(): void;
  setEnabled(enabled: boolean): void;
  setVolume(volume: number, muted: boolean): void;
}

const { locale } = useI18n();
const settings = useSettingsStore();
const route = useRoute();
const router = useRouter();

/** 播放标题 BGM 的菜单类页面；游戏页有自己的音频，音乐鉴赏页放自己的曲目 */
const MENU_ROUTES: readonly string[] = ['home', 'how-to-play', 'settings', 'about-us'];

const loadMenuMusic = inject<(() => Promise<{ createMenuMusic(): MenuMusicHandle }>) | null>(
  'jam:load-menu-music',
  null,
);
let menuMusic: MenuMusicHandle | null = null;
let menuMusicTask: Promise<void> | null = null;

function syncMenuMusic(): void {
  if (!menuMusic) return;
  menuMusic.setEnabled(MENU_ROUTES.includes(String(route.name)));
  menuMusic.setVolume(settings.bgmVolume / 100, settings.muted);
}

/** 首次点击 / 按键时加载并解锁；之后路由与音量变化直接同步 */
function ensureMenuMusic(): void {
  if (menuMusicTask || !loadMenuMusic) return;
  menuMusicTask = loadMenuMusic()
    .then((module) => {
      menuMusic = module.createMenuMusic();
      menuMusic.unlock();
      syncMenuMusic();
    })
    .catch(() => {
      menuMusicTask = null;
    });
}

watch(() => route.name, syncMenuMusic);
watch(() => [settings.bgmVolume, settings.muted], syncMenuMusic);

onMounted(() => {
  window.addEventListener('pointerdown', ensureMenuMusic, { capture: true });
  window.addEventListener('keydown', ensureMenuMusic, { capture: true });
});

onUnmounted(() => {
  window.removeEventListener('pointerdown', ensureMenuMusic, { capture: true });
  window.removeEventListener('keydown', ensureMenuMusic, { capture: true });
});

// 首次导航完成前 route 还是初始占位，等确定不是游戏页再创建背景，避免直开 /game 时白建一次
const routerReady = ref(false);
router.isReady().then(() => {
  routerReady.value = true;
});

/** 3D 背景只在菜单类页面存在；进入游戏页时卸载（main.ts 里同时释放渲染器） */
const backdropEnabled = computed(() => routerReady.value && route.name !== 'game');
const backdropShown = ref(false);
const backdropLoading = ref(false);
const backdropProgress = ref(0);
const backdropLabel = ref('');
const backdropActive = computed(() => backdropEnabled.value && backdropShown.value);

/** 背景还没回报阶段文案时的兜底 */
const BACKDROP_LABEL = '正在准备场景…';

/** 游戏侧的加载优先：进入游戏时它比背景遮罩先打开，且跨路由不断开 */
const overlayActive = computed(() => loadingScreen.active || (backdropEnabled.value && backdropLoading.value));
const overlayLabel = computed(() => {
  if (loadingScreen.active && loadingScreen.label) return loadingScreen.label;
  return backdropLabel.value || BACKDROP_LABEL;
});
const overlayProgress = computed(() => (loadingScreen.active ? loadingScreen.progress : backdropProgress.value));

watchEffect(() => {
  locale.value = settings.language;
  document.documentElement.lang = settings.language;
});
</script>

<style scoped>
/* isolate：让背景层的负 z-index 停在本层叠上下文里，位于页面内容之下 */
.app-shell {
  position: relative;
  isolation: isolate;
}

/* 背景可见时页面底色改为透明，露出 3D 背景（各页用 bg-(--color-bg-page) 取底色） */
.app-shell--backdrop {
  --color-bg-page: transparent;
}
</style>

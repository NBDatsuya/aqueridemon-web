<template>
  <div class="app-shell" :class="{ 'app-shell--backdrop': backdropActive }">
    <TitleBackdropLayer
      v-if="backdropEnabled"
      v-model:shown="backdropShown"
      v-model:loading="backdropLoading"
      :variant="route.name === 'home' ? 'menu' : 'page'"
    />
    <RouterView />
    <LoadingOverlay :active="backdropEnabled && backdropLoading" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
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
const backdropActive = computed(() => backdropEnabled.value && backdropShown.value);

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

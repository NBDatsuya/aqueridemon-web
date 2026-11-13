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
import { computed, ref, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/hud';
import LoadingOverlay from './components/loading-overlay.vue';
import TitleBackdropLayer from './components/title-backdrop-layer.vue';

const { locale } = useI18n();
const settings = useSettingsStore();
const route = useRoute();
const router = useRouter();

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

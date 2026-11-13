<template>
  <!-- 3D 背景由 App 根部的 TitleBackdropLayer 常驻提供，本页底色在背景可见时为透明 -->
  <div class="home-page">
    <!-- CS 1.6 式布局：标题在左上，纯文字菜单靠左 -->
    <header class="home-page__header">
      <h1 class="home-page__title">{{ t('meta.game.title') }}</h1>
      <p v-if="subtitleVisible" class="home-page__subtitle">
        {{ t('meta.game.subtitle') }}
      </p>
    </header>

    <nav class="home-page__menu">
      <button
        v-for="item in menuItems"
        :key="item.label"
        type="button"
        class="home-page__item"
        :class="{ 'home-page__item--group': item.groupStart }"
        @click="item.onClick"
      >
        {{ t(item.label) }}
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

const router = useRouter();
const { t } = useI18n();

/** groupStart：与上一项之间留出分组间距（CS 1.6 菜单按功能分组） */
const menuItems = [
  {
    label: 'home.startGame',
    groupStart: false,
    onClick: () => router.push({ name: 'how-to-play', query: { from: 'start' } }),
  },
  {
    label: 'home.howToPlay',
    groupStart: false,
    onClick: () => router.push({ name: 'how-to-play', query: { from: 'menu' } }),
  },
  {
    label: 'home.settings',
    groupStart: true,
    onClick: () => router.push({ name: 'settings' }),
  },
  {
    label: 'home.aboutUs',
    groupStart: false,
    onClick: () => router.push({ name: 'about-us' }),
  },
  {
    label: 'home.exitGame',
    groupStart: true,
    onClick: () => {
      window.close();
      window.location.href = 'about:blank';
    },
  },
] as const;

const subtitleVisible = computed(() => {
  try {
    return t('meta.game.subtitle') !== 'meta.game.subtitle' && t('meta.game.subtitle') !== '';
  } catch {
    return false;
  }
});
</script>

<style scoped>
@reference "../styles/hud.css";

.home-page {
  @apply relative h-screen w-screen overflow-hidden bg-(--color-bg-page) select-none;
}

/* CS 1.6 风格：Verdana / Tahoma 一类的窄 UI 字体，硬边投影，不用圆角与色块 */
.home-page__header,
.home-page__menu {
  font-family: Verdana, Tahoma, 'Microsoft YaHei', sans-serif;
}

.home-page__header {
  @apply absolute top-[7vh] left-[6vw] flex flex-col items-start gap-1 pr-[6vw];
}

.home-page__title {
  @apply text-4xl font-bold tracking-wider text-(--color-accent-light);
  text-shadow: 2px 2px 0 rgb(0 0 0 / 0.85);
}

.home-page__subtitle {
  @apply text-sm tracking-wide text-(--color-text-secondary);
  text-shadow: 1px 1px 0 rgb(0 0 0 / 0.85);
}

.home-page__menu {
  @apply absolute top-[28vh] left-[6vw] flex flex-col items-start;
}

/* 纯文字菜单项：常态灰白，悬停 / 键盘聚焦变全白，按下偏琥珀色 */
.home-page__item {
  @apply cursor-pointer bg-transparent py-1.5 text-left text-lg tracking-wide text-(--color-text-bright)/70 transition-colors duration-75 outline-none;
  text-shadow: 1px 1px 0 rgb(0 0 0 / 0.9);
}

.home-page__item:hover,
.home-page__item:focus-visible {
  @apply text-(--color-text-bright);
}

.home-page__item:active {
  @apply text-(--color-accent-light);
}

.home-page__item--group {
  @apply mt-5;
}
</style>

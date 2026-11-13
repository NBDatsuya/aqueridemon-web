<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import momakoLogo from '../assets/momako-logo.webp';

interface Tech {
  label: string;
  url?: string;
}

interface Props {
  repoUrl?: string;
  technologies?: Tech[];
}

const props = withDefaults(defineProps<Props>(), {
  repoUrl: 'https://github.com/momakoding/momako',
  technologies: () => [
    { label: 'Vue 3', url: 'https://vuejs.org' },
    { label: 'TypeScript', url: 'https://www.typescriptlang.org' },
    { label: 'Tailwind CSS v4', url: 'https://tailwindcss.com' },
    { label: 'Vite', url: 'https://vitejs.dev' },
  ],
});

const { t } = useI18n();
</script>

<template>
  <div class="mmkd-credit">
    <div class="mmkd-credit__header">
      <a :href="props.repoUrl" target="_blank" rel="noopener noreferrer" class="mmkd-credit__logo-link">
        <img :src="momakoLogo" alt="Momako" class="mmkd-credit__logo" draggable="false" />
      </a>
      <div class="mmkd-credit__title-group">
        <a :href="props.repoUrl" target="_blank" rel="noopener noreferrer" class="mmkd-credit__name">
          Momako
        </a>
        <p class="mmkd-credit__desc">{{ t('credit.desc') }}</p>
      </div>
    </div>

    <ul class="mmkd-credit__badges">
      <a
        v-for="tech in props.technologies"
        :key="tech.label"
        :href="tech.url"
        target="_blank"
        rel="noopener noreferrer"
        class="mmkd-credit__badge"
      >
        {{ tech.label }}
      </a>
    </ul>
  </div>
</template>

<style scoped>
@reference "../styles/hud.css";

.mmkd-credit {
  @apply flex flex-col gap-4 rounded-xl border border-amber-500/30 bg-amber-950/20 px-5 py-4;
}

.mmkd-credit__header {
  @apply flex items-center gap-4;
}

/* 原图是白底插画，放在白色圆角底板上 */
.mmkd-credit__logo-link {
  @apply shrink-0 overflow-hidden rounded-lg bg-white ring-1 ring-amber-500/30 transition-shadow hover:ring-amber-400;
}

.mmkd-credit__logo {
  @apply block h-20 w-20 object-contain select-none;
}

.mmkd-credit__title-group {
  @apply flex flex-col gap-1;
}

.mmkd-credit__name {
  @apply text-lg font-bold text-amber-400 no-underline transition-colors hover:text-amber-200;
}

.mmkd-credit__desc {
  @apply text-xs text-slate-500;
}

.mmkd-credit__badges {
  @apply flex flex-wrap gap-2 m-0 p-0 list-none;
}

.mmkd-credit__badge {
  @apply rounded-full bg-slate-900/60 border border-slate-600/50 px-2.5 py-0.5 text-xs text-slate-300 no-underline transition-all hover:border-amber-500 hover:text-white;
}
</style>

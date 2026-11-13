<template>
  <div ref="root" class="music-page">
    <!-- 随节拍变亮的氛围光：叠在 3D 背景之上、内容之下，滤色混合只提亮不遮挡 -->
    <div class="music-page__glow" aria-hidden="true" />

    <ScrollableContent>
      <div class="music-content">
        <header class="music-page__hero">
          <p class="music-page__eyebrow">{{ t('musicGallery.eyebrow') }}</p>
          <h2 class="music-page__title">{{ t('musicGallery.title') }}</h2>
          <div class="music-page__line" aria-hidden="true" />
        </header>

        <ol v-if="tracks.length" class="track-list">
          <li v-for="(track, index) in tracks" :key="track.id">
            <button
              type="button"
              class="track"
              :class="{ 'track--active': track.id === currentId }"
              :aria-pressed="track.id === currentId && state === 'playing'"
              @pointerenter="playHover"
              @click="onTrackClick(track.id)"
            >
              <span class="track__index">
                <AudioLines v-if="track.id === currentId && state === 'playing'" class="track__icon" />
                <LoaderCircle v-else-if="track.id === currentId && state === 'loading'" class="track__icon track__icon--spin" />
                <template v-else>{{ String(index + 1).padStart(2, '0') }}</template>
              </span>
              <span class="track__body">
                <span class="track__title">{{ t(`meta.soundtrack.${track.id}.title`) }}</span>
                <span class="track__desc">{{ t(`meta.soundtrack.${track.id}.desc`) }}</span>
              </span>
              <span class="track__time">{{ formatTime(track.duration) }}</span>
            </button>
          </li>
        </ol>

        <section class="player">
          <div class="player__head">
            <button
              type="button"
              class="player__toggle"
              :disabled="!canToggle"
              :aria-label="state === 'playing' ? t('musicGallery.pause') : t('musicGallery.play')"
              @click="onToggle"
            >
              <LoaderCircle v-if="state === 'loading'" class="player__toggle-icon track__icon--spin" />
              <Pause v-else-if="state === 'playing'" class="player__toggle-icon" />
              <Play v-else class="player__toggle-icon player__toggle-icon--play" />
            </button>
            <div class="player__info">
              <p class="player__title">
                {{ currentTrack ? t(`meta.soundtrack.${currentTrack.id}.title`) : t('musicGallery.hint') }}
              </p>
              <p class="player__status">{{ statusText }}</p>
            </div>
          </div>

          <div class="player__seek">
            <span class="player__time">{{ formatTime(shownTime) }}</span>
            <input
              class="player__range"
              type="range"
              min="0"
              :max="duration"
              step="0.1"
              :value="shownTime"
              :disabled="!canSeek"
              :aria-label="t('musicGallery.seek')"
              :style="{ '--progress': `${progress * 100}%` }"
              @input="onScrub"
              @change="onSeekCommit"
            />
            <span class="player__time">{{ formatTime(duration) }}</span>
          </div>
        </section>

        <div class="music-page__actions">
          <GameButton :label="t('common.backHome')" variant="primary" @click="router.push({ name: 'home' })" />
        </div>
      </div>
    </ScrollableContent>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { AudioLines, LoaderCircle, Pause, Play } from '@lucide/vue';
import type { GalleryPlayer, GalleryState, GalleryTrack, GalleryTrackId } from '@/game/generators/audio/gallery';
import GameButton from '../components/game-button.vue';
import ScrollableContent from '../components/scrollable-content.vue';
import { useUiSound } from '../composables/use-ui-sound';
import { useSettingsStore } from '../stores';

type GalleryModule = typeof import('@/game/generators/audio/gallery');

/** 亮度上升的平滑时间常数（秒）：起音几乎立刻点亮，只滤掉逐帧抖动 */
const PULSE_RISE = 0.025;
/** 亮度回落的平滑时间常数（秒）：回落放慢一些，避免一明一暗地闪 */
const PULSE_FALL = 0.22;

const router = useRouter();
const { t } = useI18n();
const settings = useSettingsStore();
const { playHover } = useUiSound();

/** 游戏侧在 main.ts 提供：HUD 层不静态依赖游戏代码 */
const loadGallery = inject<(() => Promise<GalleryModule>) | null>('jam:load-music-gallery', null);
const setBackdropPulse = inject<((level: number) => void) | null>('jam:set-backdrop-pulse', null);

const root = ref<HTMLElement | null>(null);
const tracks = shallowRef<readonly GalleryTrack[]>([]);
const currentId = ref<GalleryTrackId | null>(null);
const state = ref<GalleryState>('idle');
const position = ref(0);
/** 拖动进度条时的预览位置；松手才真正跳转 */
const scrubbing = ref<number | null>(null);

let player: GalleryPlayer | null = null;
let gallery: GalleryModule | null = null;
let frame = 0;
let lastFrameAt = 0;
let glow = 0;
let unmounted = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const currentTrack = computed(() => tracks.value.find((track) => track.id === currentId.value) ?? null);
const duration = computed(() => currentTrack.value?.duration ?? 0);
const shownTime = computed(() => scrubbing.value ?? position.value);
const progress = computed(() => (duration.value > 0 ? Math.min(1, shownTime.value / duration.value) : 0));
const canToggle = computed(() => state.value === 'playing' || state.value === 'paused');
const canSeek = computed(() => canToggle.value);

const statusText = computed(() => {
  switch (state.value) {
    case 'loading':
      return t('musicGallery.loading');
    case 'error':
      return t('musicGallery.error');
    default:
      return '';
  }
});

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function syncFromPlayer(): void {
  if (!player) return;
  currentId.value = player.current;
  state.value = player.state;
  position.value = player.position();
}

function applyVolume(): void {
  player?.setVolume(settings.bgmVolume / 100, settings.muted);
}

/** 同一首：暂停 / 继续；换曲：从头播放。都在点击回调里同步调用，浏览器才允许出声 */
function onTrackClick(id: GalleryTrackId): void {
  if (!player) return;
  if (id === player.current && (player.state === 'playing' || player.state === 'paused')) {
    player.toggle();
    return;
  }
  void player.select(id);
}

function onToggle(): void {
  player?.toggle();
}

function onScrub(event: Event): void {
  scrubbing.value = Number((event.target as HTMLInputElement).value);
}

function onSeekCommit(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  scrubbing.value = null;
  player?.seek(value);
  position.value = value;
}

/** 每帧：读播放位置，把节拍亮度平滑后写到页面光层与 3D 背景 */
function tick(now: number): void {
  const dt = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 0;
  lastFrameAt = now;
  if (player) {
    if (player.state === 'playing') position.value = player.position();
    const target = reducedMotion ? 0 : player.pulse();
    const tau = target > glow ? PULSE_RISE : PULSE_FALL;
    glow += (target - glow) * (1 - Math.exp(-dt / tau));
    root.value?.style.setProperty('--pulse', glow.toFixed(3));
    setBackdropPulse?.(glow);
  }
  frame = requestAnimationFrame(tick);
}

watch(() => [settings.bgmVolume, settings.muted], applyVolume);

onMounted(() => {
  if (!loadGallery) {
    state.value = 'error';
    return;
  }
  loadGallery()
    .then((module) => {
      if (unmounted) return;
      gallery = module;
      tracks.value = module.GALLERY_TRACKS;
      player = module.createGalleryPlayer(syncFromPlayer);
      applyVolume();
      frame = requestAnimationFrame(tick);
    })
    .catch(() => {
      if (!unmounted) state.value = 'error';
    });
});

onUnmounted(() => {
  unmounted = true;
  if (frame) cancelAnimationFrame(frame);
  player?.dispose();
  player = null;
  gallery?.clearGalleryCache();
  setBackdropPulse?.(0);
});
</script>

<style scoped>
@reference "../styles/hud.css";

.music-page {
  --pulse: 0;
  @apply relative h-screen w-screen bg-(--color-bg-page);
}

/* 两团暖色光：常态微亮，节拍到来时整体提亮；screen 混合只会让下面的背景变亮 */
.music-page__glow {
  @apply pointer-events-none absolute inset-0;
  background:
    radial-gradient(ellipse 70% 55% at 50% 0%, rgb(251 191 36 / 0.55), transparent 70%),
    radial-gradient(ellipse 60% 45% at 50% 100%, rgb(245 158 11 / 0.35), transparent 70%),
    radial-gradient(ellipse 90% 80% at 50% 50%, rgb(254 243 199 / 0.12), transparent 75%);
  mix-blend-mode: screen;
  opacity: calc(0.1 + var(--pulse) * 0.22);
}

.music-content {
  @apply relative flex flex-col items-center gap-8 px-6 py-14 max-w-3xl mx-auto;
}

.music-page__hero {
  @apply page-hero;
}

.music-page__eyebrow {
  @apply page-eyebrow;
}

.music-page__title {
  @apply page-title;
}

.music-page__line {
  @apply page-hero-line;
}

.track-list {
  @apply w-full list-none m-0 p-0 flex flex-col gap-3;
}

.track {
  @apply w-full cursor-pointer rounded-xl border border-(--color-border-subtle)/70 bg-(--color-bg-surface)/50 px-5 py-4 flex items-center gap-4 text-left transition-colors duration-150 outline-none;
}

.track:hover,
.track:focus-visible {
  @apply border-(--color-text-muted) bg-(--color-bg-surface)/70;
}

.track--active {
  @apply border-(--color-accent)/70 bg-(--color-bg-surface)/80;
}

.track__index {
  @apply w-8 shrink-0 flex justify-center font-hud text-lg font-bold text-(--color-text-muted) tabular-nums;
}

.track--active .track__index {
  @apply text-(--color-accent-light);
}

.track__icon {
  @apply size-5;
}

.track__icon--spin {
  @apply animate-spin;
}

.track__body {
  @apply flex min-w-0 flex-1 flex-col gap-1;
}

.track__title {
  @apply text-base font-bold text-(--color-text-primary);
}

.track--active .track__title {
  @apply text-(--color-accent-light);
}

.track__desc {
  @apply text-xs leading-relaxed text-(--color-text-secondary);
}

.track__time {
  @apply shrink-0 font-hud text-sm text-(--color-text-muted) tabular-nums;
}

.player {
  @apply w-full rounded-xl border border-(--color-border-subtle)/70 bg-slate-950/60 p-5 flex flex-col gap-4;
}

.player__head {
  @apply flex items-center gap-4;
}

.player__toggle {
  @apply size-12 shrink-0 cursor-pointer rounded-full bg-(--color-accent) text-(--color-text-dark) flex items-center justify-center transition-colors duration-150 hover:bg-(--color-accent-light) active:bg-(--color-accent-dim) disabled:cursor-default disabled:bg-(--color-bg-surface) disabled:text-(--color-text-muted);
}

.player__toggle-icon {
  @apply size-5;
}

/* 三角形的视觉重心偏左，往右挪一点才显得居中 */
.player__toggle-icon--play {
  @apply translate-x-px;
}

.player__info {
  @apply flex min-w-0 flex-col gap-0.5;
}

.player__title {
  @apply truncate text-base font-bold text-(--color-text-primary);
}

.player__status {
  @apply min-h-4 text-xs text-(--color-text-muted);
}

.player__seek {
  @apply flex items-center gap-3;
}

.player__time {
  @apply w-10 shrink-0 text-center font-hud text-sm text-(--color-text-secondary) tabular-nums;
}

/* 进度条：已播放部分用强调色填充（--progress 由模板写入） */
.player__range {
  --progress: 0%;
  @apply h-1.5 flex-1 cursor-pointer appearance-none rounded-full outline-none disabled:cursor-default disabled:opacity-50;
  background: linear-gradient(
    to right,
    var(--color-accent) 0%,
    var(--color-accent) var(--progress),
    var(--color-slate-700) var(--progress),
    var(--color-slate-700) 100%
  );
}

.player__range::-webkit-slider-thumb {
  @apply size-3.5 appearance-none rounded-full border-0 bg-(--color-accent-light);
  box-shadow: 0 0 0 3px rgb(0 0 0 / 0.35);
}

.player__range::-moz-range-thumb {
  @apply size-3.5 rounded-full border-0 bg-(--color-accent-light);
  box-shadow: 0 0 0 3px rgb(0 0 0 / 0.35);
}

.player__range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px var(--color-accent-dim);
}

.music-page__actions {
  @apply mt-2;
}
</style>

<template>
  <div class="ending-screen" :class="`ending-screen--${tone}`">
    <div class="ending-screen__panel">
      <p class="ending-screen__tag">{{ tag }}</p>
      <h1 class="ending-screen__title">{{ title }}</h1>
      <p v-for="line in lines" :key="line" class="ending-screen__line">{{ line }}</p>

      <div v-if="ending.lastWords.length > 0" class="ending-screen__words">
        <p v-for="w in ending.lastWords" :key="w.speaker">{{ w.speaker }}：“{{ w.text }}”</p>
      </div>

      <div class="ending-screen__stats">
        <h2 class="ending-screen__stats-title">战斗统计</h2>
        <dl class="ending-screen__list">
          <dt>结局</dt>
          <dd>{{ tag }}</dd>
          <dt>{{ ending.kind === 'BE' ? '生存时间' : '通关时间' }}</dt>
          <dd>{{ formatTime(ending.time) }}</dd>
          <dt>总击杀数</dt>
          <dd>{{ ending.totalKills }}</dd>
          <dt class="ending-screen__sub">普通丧尸</dt>
          <dd class="ending-screen__sub">{{ ending.kills.common }}</dd>
          <dt class="ending-screen__sub">快速丧尸</dt>
          <dd class="ending-screen__sub">{{ ending.kills.runner }}</dd>
          <dt class="ending-screen__sub">坦克丧尸</dt>
          <dd class="ending-screen__sub">{{ ending.kills.tank }}</dd>
          <dt>命中率</dt>
          <dd>{{ Math.round(ending.accuracy * 100) }}%</dd>
          <dt>爆头数</dt>
          <dd>{{ ending.headshots }}</dd>
          <dt>Boss样本</dt>
          <dd>{{ ending.hasSample ? '✅ 已携带' : '❌ 遗失' }}</dd>
        </dl>
        <ul class="ending-screen__squad">
          <li v-for="m in ending.squad" :key="m.id">
            {{ m.survived ? '✅' : '❌' }} {{ m.name }}{{ m.isPlayer ? '（主控）' : '' }}{{ m.survived ? '' : '（阵亡）' }}
          </li>
        </ul>
      </div>

      <div class="ending-screen__actions">
        <GameButton label="再来一局" variant="primary" @click="restart" />
        <GameButton label="制作人员" variant="secondary" @click="goCredits" />
        <GameButton label="退出" variant="secondary" @click="exit" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { EVENT_KEYS, useEventBus } from '@/core'
import { GameButton } from '@/hud'
import { CHARACTERS, PLAYER_ID } from '../core/config'
import { hud } from '../core/state'
import type { HudEnding } from '../core/state'
import { formatTime } from '../utils/math'

const props = defineProps<{
  /** 结局数据 */
  ending: HudEnding
}>()

const router = useRouter()
const eventBus = useEventBus()

const survivors = computed(() => props.ending.squad.filter((m) => m.survived).map((m) => m.name))
const fallen = computed(() => props.ending.squad.filter((m) => !m.survived).map((m) => m.name))

const tone = computed(() => {
  switch (props.ending.kind) {
    case 'HE':
      return 'he'
    case 'NE_CASUALTY':
      return 'ne-casualty'
    case 'NE_NO_SAMPLE':
      return 'ne-sample'
    default:
      return 'be'
  }
})

const tag = computed(() => {
  if (props.ending.kind === 'HE') return 'HE · Happy Ending'
  if (props.ending.kind === 'BE') return 'BE · Bad Ending'
  return 'NE · Normal Ending'
})

const title = computed(() => {
  switch (props.ending.kind) {
    case 'HE':
      return '完美撤离'
    case 'NE_CASUALTY':
      return '撤离成功'
    case 'NE_NO_SAMPLE':
      return '全员撤离'
    default:
      return '任务失败'
  }
})

const lines = computed(() => {
  switch (props.ending.kind) {
    case 'HE':
      return ['阿奎尔样本已到手', '所有队员安全撤离', `生存者：${survivors.value.join(', ')}`]
    case 'NE_CASUALTY':
      return [`阵亡者：${fallen.value.join(', ')}`, `幸存者：${survivors.value.join(', ')}`, '代价惨重']
    case 'NE_NO_SAMPLE':
      return ['但关键样本遗失', '无法分析病毒源头', '样本遗失，研究无法继续...']
    default:
      return [`${CHARACTERS[PLAYER_ID].name}阵亡`, '感染继续蔓延...']
  }
})

/** 重新开始一局（场景组件监听该事件并重建引擎） */
function restart(): void {
  // 先收起结局界面：重建引擎期间加载遮罩正在淡入，留着它会从半透明的遮罩后面露出来
  hud.ending = null
  eventBus.emit(EVENT_KEYS.GAME_RESTART)
}

/** 返回标题页 */
function exit(): void {
  router.push({ name: 'home' })
}

/** 跳到制作人员页（关于我们：团队、游戏与开源技术鸣谢） */
function goCredits(): void {
  router.push({ name: 'about-us' })
}
</script>

<style scoped>
@reference "@/style.css";

.ending-screen {
  @apply pointer-events-auto absolute inset-0 z-30 flex items-center justify-center overflow-y-auto text-slate-100 select-none;
  animation: ending-in 2.2s ease-out both;
}

.ending-screen--he {
  background: radial-gradient(ellipse at 50% 20%, rgb(251 191 36 / 0.55), rgb(120 53 15 / 0.82) 55%, rgb(15 23 42 / 0.94));
}

.ending-screen--ne-casualty {
  background: linear-gradient(180deg, rgb(82 82 91 / 0.86), rgb(24 24 27 / 0.95));
  backdrop-filter: grayscale(1);
}

.ending-screen--ne-sample {
  background: linear-gradient(180deg, rgb(30 58 138 / 0.8), rgb(2 6 23 / 0.95));
}

.ending-screen--be {
  background: radial-gradient(ellipse at center, rgb(69 10 10 / 0.88), rgb(0 0 0 / 0.97) 75%);
  backdrop-filter: blur(3px);
}

.ending-screen__panel {
  @apply flex w-[min(92vw,560px)] flex-col items-center gap-2 py-6 text-center;
}

.ending-screen__tag {
  @apply text-xs font-bold tracking-[0.4em] text-slate-300;
}

.ending-screen__title {
  @apply mb-2 text-4xl font-extrabold tracking-widest;
}

.ending-screen--he .ending-screen__title {
  @apply text-amber-200;
}

.ending-screen--be .ending-screen__title {
  @apply text-red-400;
}

.ending-screen__line {
  @apply text-base text-slate-200;
}

.ending-screen__words {
  @apply mt-2 text-sm text-slate-400 italic;
}

.ending-screen__stats {
  @apply mt-4 w-full rounded-xl border border-slate-500/50 bg-slate-950/60 px-6 py-4 text-left;
}

.ending-screen__stats-title {
  @apply mb-3 text-center text-sm font-bold tracking-[0.4em] text-slate-300;
}

.ending-screen__list {
  @apply grid grid-cols-2 gap-x-4 gap-y-1 text-sm;
}

.ending-screen__list dt {
  @apply text-slate-400;
}

.ending-screen__list dd {
  @apply text-right font-semibold tabular-nums;
}

.ending-screen__list .ending-screen__sub {
  @apply text-xs font-normal text-slate-400;
}

.ending-screen__list dt.ending-screen__sub {
  @apply pl-4;
}

.ending-screen__squad {
  @apply mt-3 grid list-none grid-cols-2 gap-1 border-t border-slate-600/50 p-0 pt-3 text-sm;
}

.ending-screen__actions {
  @apply mt-5 flex gap-4;
}

@keyframes ending-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>

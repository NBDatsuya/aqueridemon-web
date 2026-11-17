<template>
  <div class="game-hud">
    <!-- 全屏反馈层 -->
    <div v-if="hud.damage.serial > 0" :key="`dmg-${hud.damage.serial}`" class="game-hud__damage" />
    <div v-if="lowHp" class="game-hud__low-hp" />
    <Transition name="slowmo">
      <div v-if="hud.slowMo" class="game-hud__slow-mo" />
    </Transition>
    <div v-if="hud.status === 'downed' || hud.status === 'dead'" class="game-hud__downed-edge" />

    <!-- 左上：任务信息 -->
    <div class="game-hud__top-left">
      <div v-if="hud.phase === 'wave'" class="game-hud__wave">
        第 {{ hud.wave }} 波 · 击杀 {{ hud.waveKilled }}/{{ hud.waveTotal }}
      </div>
      <div class="game-hud__objective">{{ hud.objective }}</div>
    </div>

    <!-- 顶部中央：回合、击杀、计时、剩余 NPC -->
    <div v-if="hud.phase !== 'ending'" class="game-hud__top-center">
      <div class="game-hud__round">{{ roundLabel }}</div>
      <div class="game-hud__stats">
        <span class="game-hud__stat"><b>{{ playerScore.toLocaleString('en-US') }}</b><i>分数</i></span>
        <span class="game-hud__clock">{{ formatTime(hud.elapsed) }}</span>
        <span class="game-hud__stat"><b>{{ hud.enemiesAlive }}</b><i>剩余NPC</i></span>
      </div>
    </div>

    <!-- 右上：个人排名（小队四人按分数排序；分数变动时条目上下滑动、分数滚动） -->
    <div v-if="hud.phase !== 'ending'" class="game-hud__squad">
      <TransitionGroup name="rank" tag="ul" class="game-hud__squad-list">
        <li
          v-for="(m, i) in scoreboard"
          :key="m.id"
          class="game-hud__mate"
          :class="[`game-hud__mate--${m.status}`, { 'game-hud__mate--self': m.isPlayer }]"
          :style="{ borderLeftColor: m.color }"
        >
          <div class="game-hud__mate-head">
            <span class="game-hud__mate-rank">{{ i + 1 }}</span>
            <span class="game-hud__mate-name">{{ m.name }}</span>
            <span class="game-hud__mate-state">{{ mateState(m) }}</span>
            <span class="game-hud__mate-score-box">
              <Transition name="score-roll">
                <span :key="m.score" class="game-hud__mate-score">{{ m.score.toLocaleString('en-US') }}</span>
              </Transition>
            </span>
          </div>
          <div class="game-hud__bar game-hud__bar--thin">
            <div class="game-hud__bar-fill game-hud__bar-fill--ally" :style="{ width: `${hpPercent(m.hp)}%` }" />
          </div>
          <div class="game-hud__mate-weapon">{{ m.weapon }}<span v-if="m.ammoLow"> · 弹药不足</span></div>
        </li>
      </TransitionGroup>
    </div>

    <!-- 右上：样本图标（位于排名面板下方） -->
    <div v-if="hud.hasSample" class="game-hud__sample">
      <span class="game-hud__sample-orb" />
      阿奎尔样本
    </div>

    <!-- 顶部：Boss 血条 -->
    <div v-if="hud.boss.active && hud.boss.alive" class="game-hud__boss">
      <div class="game-hud__boss-name">
        {{ hud.boss.name }}<span v-if="hud.boss.phase === 2" class="game-hud__boss-rage"> · 狂暴</span>
      </div>
      <div class="game-hud__bar game-hud__bar--boss">
        <div
          class="game-hud__bar-fill"
          :class="hud.boss.phase === 2 ? 'game-hud__bar-fill--rage' : 'game-hud__bar-fill--boss'"
          :style="{ width: `${(hud.boss.hp / hud.boss.maxHp) * 100}%` }"
        />
        <div class="game-hud__boss-half" />
      </div>
      <div v-if="hud.boss.warning" class="game-hud__boss-warning" :class="{ 'game-hud__boss-warning--weak': hud.boss.weak !== 'none' }">
        {{ hud.boss.warning }}
      </div>
    </div>

    <!-- 直升机血量条（落地后受丧尸攻击） -->
    <div v-if="hud.heli === 'landed' && hud.phase === 'evac'" class="game-hud__heli" :class="{ 'game-hud__heli--low': heliLow }">
      <div class="game-hud__heli-name">救援直升机 {{ hud.heliHp }} / {{ hud.heliMaxHp }}</div>
      <div class="game-hud__bar game-hud__bar--boss">
        <div class="game-hud__bar-fill game-hud__bar-fill--heli" :style="{ width: `${heliPercent}%` }" />
      </div>
    </div>

    <!-- 补给提示 -->
    <div v-if="hud.canResupply && hud.status === 'alive'" class="game-hud__resupply">
      按 F 领取弹夹（剩 {{ hud.resupplyLeft }} 个）
    </div>

    <!-- 撤离倒计时 -->
    <div v-if="hud.evacCountdown >= 0 && hud.heli === 'landed'" class="game-hud__evac" :class="{ 'game-hud__evac--urgent': hud.evacCountdown <= 10 }">
      <div class="game-hud__evac-label">撤离倒计时</div>
      <div class="game-hud__evac-number">{{ hud.evacCountdown }}</div>
    </div>

    <!-- 作弊生效倒计时 -->
    <div v-if="hud.cheatCountdown >= 0" class="game-hud__cheat">
      <div class="game-hud__cheat-label">阿奎尔巨兽逼近</div>
      <div class="game-hud__cheat-number">{{ hud.cheatCountdown }}</div>
    </div>

    <!-- 横幅 -->
    <Transition name="banner">
      <div v-if="hud.banner" :key="hud.banner.id" class="game-hud__banner" :class="`game-hud__banner--${hud.banner.tone}`">
        <div class="game-hud__banner-title">{{ hud.banner.title }}</div>
        <div v-if="hud.banner.sub" class="game-hud__banner-sub">{{ hud.banner.sub }}</div>
      </div>
    </Transition>

    <!-- 准星与命中标记 -->
    <div v-if="showCrosshair" class="game-hud__crosshair" :class="{ 'game-hud__crosshair--hot': hud.crosshairHot }">
      <span class="game-hud__cross game-hud__cross--h" :style="{ transform: `translate(${-crossGap - 9}px, -1px)` }" />
      <span class="game-hud__cross game-hud__cross--h" :style="{ transform: `translate(${crossGap}px, -1px)` }" />
      <span class="game-hud__cross game-hud__cross--v" :style="{ transform: `translate(-1px, ${-crossGap - 9}px)` }" />
      <span class="game-hud__cross game-hud__cross--v" :style="{ transform: `translate(-1px, ${crossGap}px)` }" />
      <span class="game-hud__cross-dot" />
      <span
        v-if="hud.hitMarker.serial > 0"
        :key="`hit-${hud.hitMarker.serial}`"
        class="game-hud__hit"
        :class="{
          'game-hud__hit--head': hud.hitMarker.headshot || hud.hitMarker.weak,
          'game-hud__hit--kill': hud.hitMarker.kill,
        }"
      />
    </div>

    <!-- 准星指向队友：一行蓝字 -->
    <Transition name="aim">
      <div v-if="aimTarget && showCrosshair" :key="aimTarget.id" class="game-hud__aim">
        Name: {{ aimTarget.name }} HP: {{ Math.round(hpPercent(aimTarget.hp)) }}%
      </div>
    </Transition>

    <!-- 倒地 / 眩晕提示 -->
    <div v-if="hud.status === 'downed'" class="game-hud__center-alert">
      <div class="game-hud__alert-title">需要救援！</div>
      <div class="game-hud__alert-number">{{ hud.downedTimer }}</div>
      <div class="game-hud__alert-sub">WASD 缓慢爬向队友</div>
    </div>
    <div v-else-if="hud.stunned && hud.status === 'alive'" class="game-hud__center-alert">
      <div class="game-hud__alert-title">眩晕</div>
    </div>

    <!-- 交互提示 -->
    <div v-if="hud.interaction && hud.status === 'alive'" class="game-hud__interact">
      <div class="game-hud__interact-text">{{ hud.interaction.text }}</div>
      <div v-if="hud.interaction.progress > 0" class="game-hud__bar game-hud__bar--interact">
        <div class="game-hud__bar-fill game-hud__bar-fill--interact" :style="{ width: `${hud.interaction.progress * 100}%` }" />
      </div>
    </div>

    <!-- 指针未锁定：提示点一下画面接管鼠标（开局没有菜单，进游戏时通常还没锁定） -->
    <div v-if="showLockHint" class="game-hud__lock-hint">点击画面锁定鼠标</div>

    <!-- 字幕 -->
    <TransitionGroup name="subtitle" tag="div" class="game-hud__subtitles">
      <div v-for="s in hud.subtitles" :key="s.id" class="game-hud__subtitle">
        <span class="game-hud__subtitle-speaker" :style="{ color: s.color }">{{ s.speaker }}：</span>{{ s.text }}
      </div>
    </TransitionGroup>

    <!-- 左下：生命（CF 风格） -->
    <div class="game-hud__health">
      <div class="game-hud__health-row">
        <span class="game-hud__health-name">{{ playerName }} <i class="game-hud__health-label">HP</i></span>
        <span class="game-hud__health-value" :style="{ color: hpColor(hud.hp) }">{{ hud.hp }}</span>
      </div>
      <div class="game-hud__bar">
        <div class="game-hud__bar-fill" :style="{ width: `${hpPercent(hud.hp)}%`, background: hpColor(hud.hp) }" />
      </div>
    </div>

    <!-- 右下：武器与弹药（CF 风格） -->
    <div class="game-hud__weapons">
      <div v-if="hud.reloadProgress >= 0" class="game-hud__reload">
        <span>换弹中</span>
        <div class="game-hud__bar game-hud__bar--thin">
          <div class="game-hud__bar-fill game-hud__bar-fill--interact" :style="{ width: `${hud.reloadProgress * 100}%` }" />
        </div>
      </div>
      <div
        v-for="(w, i) in hud.weapons"
        :key="`${i}-${w.id}`"
        class="game-hud__weapon"
        :class="{ 'game-hud__weapon--active': w.active }"
      >
        <span class="game-hud__weapon-slot">{{ i + 1 }}</span>
        <span class="game-hud__weapon-name">{{ w.name }}</span>
        <span v-if="w.active" class="game-hud__weapon-ammo-label">AMMO</span>
        <span class="game-hud__ammo" :class="{ 'game-hud__ammo--empty': w.mag === 0 }">
          <b>{{ w.mag }}</b> / {{ w.reserve }}
        </span>
      </div>
      <div v-if="activeEmpty" class="game-hud__no-ammo">{{ activeDry ? '弹药耗尽，寻找空投' : '按 R 换弹' }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { CHARACTERS, PLAYER, PLAYER_ID, WAVES } from '../core/config'
import { hud } from '../core/state'
import type { HudSquadMember } from '../core/state'
import { formatTime } from '../utils/math'

/** 主控名字取自 CHARACTERS 里的 profile */
const playerName = CHARACTERS[PLAYER_ID].name
const aimTarget = computed(() => hud.aimTarget)
const lowHp = computed(() => hud.status === 'alive' && hud.hp <= 30)
const showCrosshair = computed(() => hud.status === 'alive' && hud.phase !== 'ending')
/** 指针还没锁定时提示玩家点一下画面；暂停菜单、换枪界面与结局界面自己会接管点击 */
const showLockHint = computed(
  () =>
    !hud.locked &&
    hud.status === 'alive' &&
    hud.phase !== 'ending' &&
    !hud.paused &&
    !hud.cheatOpen &&
    hud.weaponChoice === null,
)
/** 准星开合（像素）随散布变化 */
const crossGap = computed(() => 4 + hud.spread * 520)
/** 右上角个人排名：按分数降序；分数变动引起换位时由 TransitionGroup 上下滑动 */
const scoreboard = computed(() => hud.squad.slice().sort((a, b) => b.score - a.score))
/** 主控个人分数（顶部中央 topbar 显示） */
const playerScore = computed(() => hud.squad.find((m) => m.isPlayer)?.score ?? 0)
const heliPercent = computed(() => (hud.heliMaxHp > 0 ? Math.min(100, (hud.heliHp / hud.heliMaxHp) * 100) : 0))
const heliLow = computed(() => heliPercent.value < 30)
const activeWeapon = computed(() => hud.weapons.find((w) => w.active))
const activeEmpty = computed(() => !!activeWeapon.value && activeWeapon.value.mag === 0 && hud.reloadProgress < 0)
const activeDry = computed(() => !!activeWeapon.value && activeWeapon.value.reserve === 0)
/** 顶部中央的回合标签（对齐 CF 的 ROUND x / y） */
const roundLabel = computed(() => {
  if (hud.phase === 'boss') return 'BOSS'
  if (hud.phase === 'evac') return 'EVAC'
  if (hud.phase === 'prep') return `ROUND 1 / ${WAVES.length}`
  return `ROUND ${hud.wave} / ${WAVES.length}`
})

/** 血量占最大值的百分比（超过上限时按 100% 显示） */
function hpPercent(hp: number): number {
  return Math.max(0, Math.min(100, (hp / PLAYER.maxHp) * 100))
}

/** 血量对应的颜色 */
function hpColor(hp: number): string {
  if (hp > PLAYER.maxHp) return '#67e8f9'
  if (hp > 60) return '#4ade80'
  if (hp > 30) return '#facc15'
  return '#f87171'
}

/** 队友状态文案 */
function mateState(m: HudSquadMember): string {
  if (m.status === 'downed') return `倒地 ${m.downedTimer}s`
  if (m.status === 'dead') return '阵亡'
  if (m.status === 'boarded') return '已登机'
  return `${m.hp}`
}
</script>

<style scoped>
@reference "@/style.css";

.game-hud {
  @apply pointer-events-none absolute inset-0 z-10 overflow-hidden font-sans text-slate-100 select-none;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.85);
}

/* ── 全屏反馈 ── */
.game-hud__damage {
  @apply absolute inset-0;
  background: radial-gradient(ellipse at center, transparent 45%, rgb(220 38 38 / 0.6) 100%);
  animation: hud-fade-out 0.6s ease-out forwards;
}

.game-hud__low-hp {
  @apply absolute inset-0;
  background: radial-gradient(ellipse at center, transparent 55%, rgb(185 28 28 / 0.45) 100%);
  animation: hud-pulse 1.1s ease-in-out infinite;
}

.game-hud__slow-mo {
  @apply absolute inset-0;
  background: radial-gradient(ellipse at center, transparent 50%, rgb(255 255 255 / 0.18) 100%);
}

.slowmo-enter-active,
.slowmo-leave-active {
  transition: opacity 0.14s ease;
}

.slowmo-enter-from,
.slowmo-leave-to {
  opacity: 0;
}

.game-hud__downed-edge {
  @apply absolute inset-0;
  background: radial-gradient(ellipse at center, rgb(127 29 29 / 0.15) 20%, rgb(127 29 29 / 0.8) 100%);
}

/* ── 左上 ── */
.game-hud__top-left {
  @apply absolute top-4 left-5 flex flex-col gap-1;
}

.game-hud__wave {
  @apply text-sm font-semibold text-amber-300;
}

.game-hud__objective {
  @apply text-sm text-slate-200;
}

/* ── 顶部中央（CF 风格回合栏） ── */
.game-hud__top-center {
  @apply absolute top-3 left-1/2 flex w-[480px] -translate-x-1/2 flex-col items-center gap-1.5;
}

.game-hud__round {
  @apply font-tech w-full text-center text-[1.35rem] leading-none font-extrabold text-transparent;
  letter-spacing: 0.45em;
  /* 抵消末字符字距，保持视觉居中 */
  padding-left: 0.45em;
  background: linear-gradient(180deg, #f0f9ff 25%, #7dd3fc 60%, #38bdf8 100%);
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 0 10px rgb(56 189 248 / 0.45));
}

.game-hud__stats {
  @apply font-hud relative flex w-full items-center justify-between py-1.5 pl-9 pr-9 text-sky-100;
  background:
    linear-gradient(180deg, rgb(12 28 52 / 0.82), rgb(3 10 24 / 0.88)) padding-box,
    linear-gradient(180deg, rgb(125 211 252 / 0.65), rgb(56 189 248 / 0.15) 45%, rgb(14 116 144 / 0.55)) border-box;
  border: 1px solid transparent;
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 14px);
  box-shadow: inset 0 0 18px rgb(14 165 233 / 0.14);
}

/* 两侧伸出的斜线翼装饰 */
.game-hud__stats::before,
.game-hud__stats::after {
  content: '';
  @apply absolute top-1/2 h-px w-7;
  background: linear-gradient(90deg, transparent, rgb(125 211 252 / 0.75));
}

.game-hud__stats::before {
  right: -28px;
}

.game-hud__stats::after {
  left: -28px;
  transform: scaleX(-1);
}

.game-hud__stat {
  @apply flex items-baseline gap-1.5;
}

.game-hud__stat b {
  @apply min-w-14 text-right text-xl leading-none font-bold text-white tabular-nums;
  text-shadow: 0 0 8px rgb(125 211 252 / 0.65);
}

.game-hud__stat i {
  @apply text-[11px] font-semibold not-italic tracking-wider text-sky-300/90;
}

.game-hud__clock {
  @apply font-tech text-2xl leading-none font-bold text-sky-100 tabular-nums;
  letter-spacing: 0.08em;
  text-shadow:
    0 0 10px rgb(56 189 248 / 0.75),
    0 0 2px rgb(255 255 255 / 0.6);
}

/* ── 右上：个人排名（合并小队状态栏） ── */
.game-hud__squad {
  @apply font-hud absolute top-[3.6rem] right-4 w-56;
}

.game-hud__squad-list {
  @apply m-0 flex list-none flex-col gap-1.5 p-0;
}

.game-hud__mate {
  border-left: 3px solid transparent;
  clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%);
  @apply border-y border-sky-400/15 bg-slate-950/60 px-2.5 py-1.5;
  background-image: linear-gradient(180deg, rgb(12 28 52 / 0.55), rgb(3 10 24 / 0.7));
  background-clip: padding-box;
}

.game-hud__mate--self {
  @apply border-sky-400/45;
}

.game-hud__mate--downed {
  @apply border-red-500/80 bg-red-950/60;
  animation: hud-pulse 0.8s ease-in-out infinite;
}

.game-hud__mate--dead {
  @apply opacity-45;
}

.game-hud__mate--boarded {
  @apply border-emerald-500/60;
}

.game-hud__mate-head {
  @apply mb-1 flex items-center justify-between gap-1.5 text-sm;
}

.game-hud__mate-rank {
  @apply w-3.5 shrink-0 text-center text-xs font-bold text-sky-300/85 tabular-nums;
}

.game-hud__mate-name {
  @apply min-w-0 flex-1 truncate font-semibold text-white;
}

.game-hud__mate-state {
  @apply shrink-0 text-xs font-semibold text-sky-300/90 tabular-nums;
}

/* 分数滚动窗口：新旧数值上下滑动交替 */
.game-hud__mate-score-box {
  @apply relative h-5 w-16 shrink-0 overflow-hidden;
}

.game-hud__mate-score {
  @apply block text-right text-sm font-bold text-white tabular-nums;
  text-shadow: 0 0 8px rgb(125 211 252 / 0.55);
}

.game-hud__mate--self .game-hud__mate-score {
  @apply text-amber-300;
}

.game-hud__mate-weapon {
  @apply mt-1 text-[11px] tracking-wide text-slate-400;
}

/* 分数变动引起名次变化时，条目整体上下滑动 */
.rank-move {
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}

.score-roll-enter-active,
.score-roll-leave-active {
  transition:
    transform 0.22s ease,
    opacity 0.22s ease;
}

.score-roll-enter-from {
  transform: translateY(110%);
  opacity: 0;
}

.score-roll-leave-to {
  transform: translateY(-110%);
  opacity: 0;
}

.score-roll-leave-active {
  @apply absolute inset-0;
}

/* ── 通用进度条 ── */
.game-hud__bar {
  @apply relative h-2.5 w-full overflow-hidden rounded-sm bg-slate-900/70;
}

.game-hud__bar--thin {
  @apply h-1.5;
}

.game-hud__bar--boss {
  @apply h-4 border border-slate-500/60;
}

.game-hud__bar--interact {
  @apply mt-2 h-2 w-64;
}

.game-hud__bar-fill {
  @apply h-full;
  transition: width 0.12s linear;
}

.game-hud__bar-fill--boss {
  background: linear-gradient(90deg, #7e22ce, #c026d3);
}

.game-hud__bar-fill--rage {
  background: linear-gradient(90deg, #991b1b, #ef4444);
}

.game-hud__bar-fill--interact {
  @apply bg-amber-400;
  transition: none;
}

/* CF 风格的友军红条 */
.game-hud__bar-fill--ally {
  background: linear-gradient(90deg, #7f1d1d, #ef4444 70%, #fca5a5);
  box-shadow: 0 0 8px rgb(239 68 68 / 0.55);
}

/* ── 样本 ── */
.game-hud__sample {
  @apply font-hud absolute top-[22.6rem] right-4 flex items-center gap-2 rounded-md border border-sky-400/70 bg-sky-950/60 px-3 py-1.5 text-sm font-semibold text-sky-200;
}

.game-hud__sample-orb {
  @apply inline-block h-3 w-3 rounded-full bg-sky-300;
  box-shadow: 0 0 10px 3px rgb(125 211 252 / 0.8);
}

/* ── Boss ── */
.game-hud__boss {
  @apply absolute top-[4.5rem] left-1/2 flex w-[min(46vw,640px)] -translate-x-1/2 flex-col items-center gap-1;
}

.game-hud__boss-name {
  @apply text-base font-bold tracking-widest text-fuchsia-200;
}

.game-hud__boss-rage {
  @apply text-red-400;
}

.game-hud__boss-half {
  @apply absolute top-0 bottom-0 left-1/2 w-px bg-white/60;
}

.game-hud__boss-warning {
  @apply mt-1 rounded bg-red-900/70 px-3 py-0.5 text-sm font-bold text-red-100;
  animation: hud-pulse 0.5s ease-in-out infinite;
}

.game-hud__boss-warning--weak {
  @apply bg-amber-500/80 text-slate-950;
  text-shadow: none;
}

/* ── 直升机血量 ── */
.game-hud__heli {
  @apply absolute top-[4.5rem] left-1/2 flex w-[min(40vw,520px)] -translate-x-1/2 flex-col items-center gap-1;
}

.game-hud__heli-name {
  @apply text-sm font-bold tracking-widest text-sky-200;
}

.game-hud__bar-fill--heli {
  background: linear-gradient(90deg, #0369a1, #38bdf8);
}

.game-hud__heli--low .game-hud__heli-name {
  @apply text-red-400;
  animation: hud-pulse 0.6s ease-in-out infinite;
}

.game-hud__heli--low .game-hud__bar-fill--heli {
  background: linear-gradient(90deg, #991b1b, #ef4444);
  animation: hud-pulse 0.6s ease-in-out infinite;
}

/* ── 补给提示 ── */
.game-hud__resupply {
  @apply absolute top-[72%] left-1/2 -translate-x-1/2 rounded bg-slate-950/70 px-4 py-1.5 text-base font-semibold text-emerald-200;
}

/* ── 撤离倒计时 ── */
.game-hud__evac {
  @apply absolute top-[19%] left-1/2 flex -translate-x-1/2 flex-col items-center text-red-500;
}

.game-hud__evac-label {
  @apply text-sm font-bold tracking-[0.4em] text-red-300;
}

.game-hud__evac-number {
  @apply text-7xl leading-none font-black tabular-nums;
}
.game-hud__evac--urgent .game-hud__evac-number {

  animation: hud-pulse 1s ease-in-out infinite;

}

/* ── 作弊倒计时 ── */

.game-hud__cheat {

  @apply absolute top-[19%] left-1/2 flex -translate-x-1/2 flex-col items-center text-emerald-300;

}

.game-hud__cheat-label {

  @apply text-sm font-bold tracking-[0.4em] text-emerald-200;

}

.game-hud__cheat-number {

  @apply text-7xl leading-none font-black tabular-nums;

  animation: hud-pulse 1s ease-in-out infinite;

}
/* ── 横幅 ── */
.game-hud__banner {
  @apply absolute top-[30%] left-1/2 -translate-x-1/2 border-y px-12 py-2 text-center;
  background: linear-gradient(90deg, transparent, rgb(2 6 23 / 0.75) 20%, rgb(2 6 23 / 0.75) 80%, transparent);
}

.game-hud__banner--info {
  @apply border-sky-400/60 text-sky-100;
}

.game-hud__banner--danger {
  @apply border-red-500/70 text-red-200;
}

.game-hud__banner--success {
  @apply border-emerald-400/70 text-emerald-200;
}

.game-hud__banner-title {
  @apply text-2xl font-extrabold tracking-[0.25em] whitespace-nowrap;
}

.game-hud__banner-sub {
  @apply mt-0.5 text-sm whitespace-nowrap text-slate-200;
}

.banner-enter-active,
.banner-leave-active {
  transition: opacity 0.3s ease;
}

.banner-enter-from,
.banner-leave-to {
  opacity: 0;
}

/* ── 准星 ── */
.game-hud__crosshair {
  @apply absolute top-1/2 left-1/2 h-0 w-0;
}

.game-hud__cross {
  @apply absolute top-0 left-0 bg-white/90;
  box-shadow: 0 0 2px rgb(0 0 0 / 0.9);
  transition: background-color 0.1s ease, box-shadow 0.1s ease;
}

.game-hud__cross--h {
  @apply h-0.5 w-[9px];
}

.game-hud__cross--v {
  @apply h-[9px] w-0.5;
}

.game-hud__cross-dot {
  @apply absolute -top-px -left-px h-0.5 w-0.5 bg-white/80;
  transition: background-color 0.1s ease;
}

/* 瞄准敌人并开火：准星变红 */
.game-hud__crosshair--hot .game-hud__cross,
.game-hud__crosshair--hot .game-hud__cross-dot {
  @apply bg-red-500;
  box-shadow: 0 0 4px rgb(239 68 68 / 0.9);
}

.game-hud__hit {
  @apply absolute -top-3 -left-3 h-6 w-6;
  background:
    linear-gradient(45deg, transparent 46%, #fff 46%, #fff 54%, transparent 54%),
    linear-gradient(-45deg, transparent 46%, #fff 46%, #fff 54%, transparent 54%);
  -webkit-mask: radial-gradient(circle, transparent 5px, #000 6px);
  mask: radial-gradient(circle, transparent 5px, #000 6px);
  animation: hud-hit 0.22s ease-out forwards;
}

.game-hud__hit--head {
  background:
    linear-gradient(45deg, transparent 44%, #fbbf24 44%, #fbbf24 56%, transparent 56%),
    linear-gradient(-45deg, transparent 44%, #fbbf24 44%, #fbbf24 56%, transparent 56%);
}

.game-hud__hit--kill {
  @apply -top-4 -left-4 h-8 w-8;
  background:
    linear-gradient(45deg, transparent 44%, #ef4444 44%, #ef4444 56%, transparent 56%),
    linear-gradient(-45deg, transparent 44%, #ef4444 44%, #ef4444 56%, transparent 56%);
}

/* ── 指向队友：一行蓝字 ── */
.game-hud__aim {
  @apply font-hud absolute top-1/2 left-1/2 ml-6 -translate-y-1/2 text-sm font-semibold whitespace-nowrap text-sky-400 tabular-nums;
}

.aim-enter-active,
.aim-leave-active {
  transition: opacity 0.15s ease;
}

.aim-enter-from,
.aim-leave-to {
  opacity: 0;
}

/* ── 中央提示 ── */
.game-hud__center-alert {
  @apply absolute top-[36%] left-1/2 flex -translate-x-1/2 flex-col items-center text-red-300;
}

.game-hud__alert-title {
  @apply text-4xl font-black tracking-[0.3em];
  animation: hud-pulse 0.9s ease-in-out infinite;
}

.game-hud__alert-number {
  @apply text-8xl leading-none font-black text-red-500 tabular-nums;
}

.game-hud__alert-sub {
  @apply mt-2 text-sm text-slate-200;
}

/* ── 交互 ── */
.game-hud__interact {
  @apply absolute top-[62%] left-1/2 flex -translate-x-1/2 flex-col items-center;
}

.game-hud__interact-text {
  @apply rounded bg-slate-950/60 px-4 py-1.5 text-base font-semibold text-amber-200;
}

/* ── 指针锁定提示 ── */
.game-hud__lock-hint {
  @apply absolute top-[68%] left-1/2 -translate-x-1/2 rounded bg-slate-950/70 px-4 py-1.5 text-sm font-semibold tracking-wider text-slate-200;
  animation: hud-pulse 1.6s ease-in-out infinite;
}

/* ── 字幕 ── */
.game-hud__subtitles {
  @apply absolute bottom-28 left-1/2 flex w-[min(80vw,720px)] -translate-x-1/2 flex-col items-center gap-1;
}

.game-hud__subtitle {
  @apply font-hud w-full px-4 py-1 text-center text-sm;
  background: linear-gradient(180deg, rgb(15 32 60 / 0.72), rgb(4 12 26 / 0.8));
  border-top: 1px solid rgb(125 211 252 / 0.4);
  border-bottom: 1px solid rgb(125 211 252 / 0.4);
}

.game-hud__subtitle-speaker {
  @apply font-bold text-sky-200;
}

.subtitle-enter-active,
.subtitle-leave-active {
  transition: opacity 0.25s ease;
}

.subtitle-enter-from,
.subtitle-leave-to {
  opacity: 0;
}

/* ── 生命 ── */
.game-hud__health {
  @apply font-hud absolute bottom-6 left-5 w-64;
}

.game-hud__health-row {
  @apply mb-1 flex items-end justify-between;
}

.game-hud__health-name {
  @apply text-sm font-semibold tracking-wider text-slate-300;
}

.game-hud__health-label {
  @apply ml-1 text-xs font-bold not-italic tracking-[0.2em] text-slate-400;
}

.game-hud__health-value {
  @apply text-4xl leading-none font-bold tabular-nums;
  text-shadow: 0 0 10px rgb(255 255 255 / 0.3);
}

/* ── 武器 ── */
.game-hud__weapons {
  @apply font-hud absolute right-5 bottom-6 flex w-64 flex-col items-stretch gap-1.5;
}

.game-hud__reload {
  @apply flex flex-col gap-1 text-right text-xs text-amber-200;
}

.game-hud__weapon {
  @apply flex items-center gap-2 bg-slate-950/45 px-2.5 py-1 text-sm text-slate-400;
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%);
}

.game-hud__weapon--active {
  @apply border-y border-sky-400/50 py-2 text-slate-50;
  background-image: linear-gradient(180deg, rgb(12 28 52 / 0.75), rgb(3 10 24 / 0.85));
  background-clip: padding-box;
}

.game-hud__weapon-slot {
  @apply flex h-5 w-5 items-center justify-center bg-slate-700/80 text-xs font-bold;
  clip-path: polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px);
}

.game-hud__weapon-name {
  @apply flex-1 truncate font-semibold;
}

.game-hud__weapon--active .game-hud__weapon-name {
  @apply font-bold text-white;
}

.game-hud__weapon-ammo-label {
  @apply text-[10px] font-bold tracking-[0.2em] text-sky-300;
}

.game-hud__ammo {
  @apply tabular-nums;
}

.game-hud__weapon--active .game-hud__ammo b {
  @apply text-2xl font-bold text-sky-100;
  text-shadow: 0 0 10px rgb(56 189 248 / 0.6);
}

.game-hud__ammo--empty b {
  @apply text-red-400;
}

.game-hud__no-ammo {
  @apply text-right text-sm font-bold text-red-300;
  animation: hud-pulse 0.8s ease-in-out infinite;
}

@keyframes hud-fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes hud-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

@keyframes hud-hit {
  from {
    opacity: 1;
    transform: scale(1.25);
  }
  to {
    opacity: 0;
    transform: scale(0.9);
  }
}
</style>

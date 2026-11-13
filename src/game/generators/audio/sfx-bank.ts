/**
 * 音效表：每个 SfxId 对应的合成函数与播放参数（优先级、节流、距离衰减、混响、失真）。
 * 调音量 / 手感只需要改这张表。
 */

import type { SfxId, WeaponId } from '../../core/types'
import type { Rng } from '../../utils/random'
import {
  renderBossCharge,
  renderBossDie,
  renderBossHurt,
  renderBossRoar,
  renderBossShockwave,
  renderBossSpit,
  renderBossStab,
  renderBossSummon,
  renderBossSweep,
  renderRunnerAttack,
  renderRunnerHurt,
  renderRunnerScreech,
  renderTankDie,
  renderTankHurt,
  renderTankRoar,
  renderTankSlam,
  renderTankStep,
  renderZombieAlert,
  renderZombieAttack,
  renderZombieDie,
  renderZombieGroan,
  renderZombieHurt,
  renderZombieStep,
} from './creatures'
import {
  renderBodyFall,
  renderClick,
  renderCrateLand,
  renderDownedAlert,
  renderFootstep,
  renderHeadshot,
  renderHeartbeat,
  renderHit,
  renderHurt,
  renderPickup,
  renderPlane,
  renderRevive,
  renderTick,
  renderWaveClear,
  renderWaveStart,
} from './feedback'
import { GUN_SOUNDS, renderDry, renderReload, renderShell, renderSwitch, synthesizeGunshot } from './gunshot'
import type { Rendered } from './synth'

/** 合成函数：返回单声道或 [左, 右] 样本。variant 为变体序号（0 起） */
export type SfxRenderer = (sr: number, rng: Rng, variant: number) => Rendered

/** 优先级：3 关键（受伤、Boss 技能、UI）；2 枪声、丧尸叫声与重要世界事件；1 脚步、弹壳 */
export type SfxPriority = 1 | 2 | 3

/** 发声分组：同组共享一个同时发声上限（见 audio/index.ts 的 GROUP_VOICES），满了先顶掉最轻（通常最远）的 */
export type SfxGroup = 'zombie'

export interface SfxDef {
  /** 合成函数；external 条目没有合成实现，声音来自加载的音频文件 */
  render?: SfxRenderer
  priority: SfxPriority
  /** 基础音量 */
  gain: number
  /** 同一 id 两次触发的最小间隔（秒） */
  throttle: number
  /** 同一 id 同时发声数上限 */
  maxVoices: number
  /** 参考距离（米）：此距离内不衰减 */
  refDistance: number
  /** 最大可闻距离（米）：超出直接丢弃 */
  maxDistance: number
  /** 衰减斜率：增益 = ref / (ref + rolloff × (距离 − ref))；1 为反比，越小越传得远 */
  rolloff: number
  /** 发声分组（可选） */
  group?: SfxGroup
  /** 混响发送量 0..1 */
  reverb: number
  /** 是否经过 WaveShaper 失真（怪物的咆哮） */
  distortion: boolean
  /** 每次播放的随机变调幅度（比例） */
  jitter: number
  /** 预渲染的变体数量，播放时随机选一个 */
  variants: number
  /** 声音来自外部音频文件（预生成资源），不参与合成预渲染，缓存未命中时静默跳过 */
  external?: boolean
}

type SfxTuning = Partial<Omit<SfxDef, 'render' | 'priority' | 'gain'>>

function def(render: SfxRenderer, priority: SfxPriority, gain: number, tuning: SfxTuning = {}): SfxDef {
  return {
    render,
    priority,
    gain,
    throttle: 0.05,
    maxVoices: 3,
    refDistance: 4,
    maxDistance: 60,
    rolloff: 1,
    reverb: 0,
    distortion: false,
    jitter: 0,
    variants: 1,
    ...tuning,
  }
}

function shot(weapon: WeaponId, gain: number, throttle: number): SfxDef {
  return def((sr, rng) => synthesizeGunshot(sr, rng, GUN_SOUNDS[weapon]), 2, gain, {
    throttle,
    maxVoices: 4,
    refDistance: 8,
    maxDistance: 160,
    reverb: 0.18,
    jitter: 0.03,
  })
}

/** 外部音频条目：不合成，只在资源加载成功后发声 */
function externalDef(priority: SfxPriority, gain: number, tuning: SfxTuning = {}): SfxDef {
  return {
    priority,
    gain,
    throttle: 0.05,
    maxVoices: 3,
    refDistance: 4,
    maxDistance: 60,
    rolloff: 1,
    reverb: 0,
    distortion: false,
    jitter: 0,
    variants: 1,
    external: true,
    ...tuning,
  }
}

/** Boss 音效的公共参数：全场可闻 */
const BOSS: SfxTuning = { refDistance: 18, maxDistance: 400, maxVoices: 2 }

/**
 * 丧尸叫声的公共参数：参考距离 4 米、衰减斜率 0.5，20 米约 −10 dB、35 米约 −14 dB，55 米外静音；
 * 归入 zombie 组，组内按响度（近的优先）抢占
 */
const ZOMBIE: SfxTuning = { refDistance: 4, maxDistance: 55, rolloff: 0.5, maxVoices: 3, group: 'zombie' }

/** 全部音效定义 */
export const SFX: Record<SfxId, SfxDef> = {
  // 武器
  shot_ak47: shot('ak47', 0.8, 0.04),
  shot_mg3: shot('mg3', 0.85, 0.035),
  shot_mp5: shot('mp5', 0.7, 0.03),
  shot_qbz95: shot('qbz95', 0.75, 0.035),
  dry: def(renderDry, 2, 0.5, { throttle: 0.12, refDistance: 2, maxDistance: 15 }),
  reload: def(renderReload, 2, 0.6, { throttle: 0.3, maxVoices: 2, refDistance: 2, maxDistance: 18 }),
  shell: def(renderShell, 1, 0.3, { throttle: 0.06, refDistance: 1.5, maxDistance: 12, jitter: 0.12 }),
  switch: def(renderSwitch, 2, 0.5, { throttle: 0.1, maxVoices: 2, refDistance: 2, maxDistance: 15 }),

  // UI 与反馈
  pickup: def(renderPickup, 3, 0.6, { throttle: 0.1 }),
  click: def(renderClick, 3, 0.5, { throttle: 0.04 }),
  hit: def(renderHit, 3, 0.5, { throttle: 0.03, jitter: 0.04 }),
  headshot: def(renderHeadshot, 3, 0.65, { throttle: 0.05 }),
  // 爆头击杀语音：Qwen-Audio-TTS 预生成（public/audio/headshot-kill.wav）；增益高于枪声，报点要压得住场
  voice_headshot_kill: externalDef(3, 1.35, { throttle: 1.2, maxVoices: 1, jitter: 0.04 }),

  // 小队成员
  footstep: def(renderFootstep, 1, 0.35, {
    throttle: 0.07,
    maxVoices: 4,
    refDistance: 2,
    maxDistance: 20,
    jitter: 0.1,
    variants: 3,
  }),
  hurt: def(renderHurt, 3, 0.8, { throttle: 0.15, refDistance: 3, maxDistance: 40 }),
  body_fall: def(renderBodyFall, 2, 0.7, { throttle: 0.1, refDistance: 3, maxDistance: 35 }),
  downed_alert: def(renderDownedAlert, 3, 0.6, { throttle: 0.5, maxVoices: 1 }),
  revive: def(renderRevive, 3, 0.6, { throttle: 0.3, maxVoices: 2 }),

  // 普通丧尸：叫声归入 zombie 组（组内上限、近的优先），衰减放缓到 30–40 米仍可闻
  zombie_groan: def(renderZombieGroan, 2, 0.9, {
    ...ZOMBIE,
    throttle: 0.2,
    maxVoices: 4,
    reverb: 0.3,
    jitter: 0.08,
    variants: 6,
  }),
  zombie_alert: def(renderZombieAlert, 2, 1, { ...ZOMBIE, throttle: 0.25, reverb: 0.3, jitter: 0.06, variants: 3 }),
  zombie_hurt: def(renderZombieHurt, 2, 0.75, {
    ...ZOMBIE,
    throttle: 0.08,
    maxDistance: 40,
    reverb: 0.12,
    jitter: 0.08,
    variants: 4,
  }),
  zombie_step: def(renderZombieStep, 1, 0.45, {
    throttle: 0.05,
    maxVoices: 4,
    refDistance: 2.5,
    maxDistance: 24,
    rolloff: 0.8,
    group: 'zombie',
    jitter: 0.1,
    variants: 4,
  }),
  zombie_attack: def(renderZombieAttack, 2, 0.9, { ...ZOMBIE, throttle: 0.1, reverb: 0.15, jitter: 0.08, variants: 3 }),
  zombie_die: def(renderZombieDie, 2, 0.85, { ...ZOMBIE, throttle: 0.08, reverb: 0.2, jitter: 0.08, variants: 3 }),

  // 快速丧尸
  runner_screech: def(renderRunnerScreech, 2, 0.75, {
    ...ZOMBIE,
    throttle: 0.35,
    maxVoices: 2,
    maxDistance: 60,
    reverb: 0.3,
    jitter: 0.06,
    variants: 3,
  }),
  runner_attack: def(renderRunnerAttack, 2, 0.8, { ...ZOMBIE, throttle: 0.1, jitter: 0.08, variants: 2 }),
  runner_hurt: def(renderRunnerHurt, 2, 0.7, { ...ZOMBIE, throttle: 0.08, maxDistance: 40, jitter: 0.08, variants: 3 }),

  // 坦克丧尸
  tank_roar: def(renderTankRoar, 2, 0.9, {
    ...ZOMBIE,
    throttle: 0.8,
    maxVoices: 2,
    refDistance: 6,
    maxDistance: 90,
    reverb: 0.35,
    distortion: true,
    jitter: 0.06,
    variants: 2,
  }),
  tank_hurt: def(renderTankHurt, 2, 0.8, { ...ZOMBIE, throttle: 0.15, maxVoices: 2, refDistance: 5, distortion: true, variants: 2 }),
  tank_step: def(renderTankStep, 1, 0.7, {
    throttle: 0.12,
    refDistance: 5,
    maxDistance: 50,
    rolloff: 0.7,
    group: 'zombie',
    jitter: 0.08,
  }),
  tank_slam: def(renderTankSlam, 2, 0.9, { ...ZOMBIE, throttle: 0.2, refDistance: 6, maxDistance: 80, reverb: 0.2 }),
  tank_die: def(renderTankDie, 2, 0.85, { ...ZOMBIE, throttle: 0.3, maxVoices: 2, refDistance: 6, maxDistance: 80, reverb: 0.3 }),

  // Boss
  boss_roar: def(renderBossRoar, 3, 0.9, { ...BOSS, throttle: 1, reverb: 0.45, distortion: true }),
  boss_sweep: def(renderBossSweep, 3, 0.85, { ...BOSS, throttle: 0.2, reverb: 0.15 }),
  boss_stab: def(renderBossStab, 3, 0.9, { ...BOSS, throttle: 0.15, reverb: 0.15 }),
  boss_spit: def(renderBossSpit, 3, 0.8, { ...BOSS, throttle: 0.3, reverb: 0.2 }),
  boss_summon: def(renderBossSummon, 3, 0.75, { ...BOSS, throttle: 1, reverb: 0.5, distortion: true }),
  boss_charge: def(renderBossCharge, 3, 0.85, { ...BOSS, throttle: 1, maxVoices: 1, reverb: 0.2 }),
  boss_shockwave: def(renderBossShockwave, 3, 1, { ...BOSS, throttle: 0.5, reverb: 0.4, distortion: true }),
  boss_hurt: def(renderBossHurt, 3, 0.6, { ...BOSS, throttle: 0.25, reverb: 0.2, distortion: true, jitter: 0.08 }),
  boss_die: def(renderBossDie, 3, 0.9, { ...BOSS, throttle: 2, maxVoices: 1, reverb: 0.5, distortion: true }),

  // 世界与流程
  plane: def(renderPlane, 2, 0.7, { throttle: 2, maxVoices: 1, refDistance: 40, maxDistance: 1000 }),
  crate_land: def(renderCrateLand, 2, 0.8, { throttle: 0.15, refDistance: 5, maxDistance: 90, reverb: 0.2 }),
  tick: def(renderTick, 3, 0.45, { throttle: 0.15, maxVoices: 2 }),
  heartbeat: def(renderHeartbeat, 3, 0.9, { throttle: 0.25, maxVoices: 2 }),
  wave_clear: def(renderWaveClear, 3, 0.6, { throttle: 1, maxVoices: 1 }),
  wave_start: def(renderWaveStart, 3, 0.7, { throttle: 1, maxVoices: 1, reverb: 0.3 }),
}

/** 预渲染顺序：先渲染最可能立刻用到的（UI、枪），长的 Boss 音效排在后面 */
export const SFX_IDS: readonly SfxId[] = [
  'click',
  'pickup',
  'switch',
  'shot_ak47',
  'shot_mg3',
  'shot_mp5',
  'shot_qbz95',
  'dry',
  'reload',
  'shell',
  'hit',
  'headshot',
  'footstep',
  'hurt',
  'wave_start',
  // 丧尸在第一波开场就会出声，排在枪声之后立刻渲染
  'zombie_groan',
  'zombie_alert',
  'zombie_step',
  'zombie_hurt',
  'zombie_attack',
  'zombie_die',
  'wave_clear',
  'tick',
  'heartbeat',
  'runner_screech',
  'runner_attack',
  'runner_hurt',
  'body_fall',
  'downed_alert',
  'revive',
  'tank_roar',
  'tank_step',
  'tank_slam',
  'tank_hurt',
  'tank_die',
  'plane',
  'crate_land',
  'boss_roar',
  'boss_sweep',
  'boss_stab',
  'boss_spit',
  'boss_summon',
  'boss_charge',
  'boss_shockwave',
  'boss_hurt',
  'boss_die',
]

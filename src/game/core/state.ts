/**
 * HUD 响应式状态（模块级单例）。
 * 只有引擎（systems/engine.ts）写入；Vue 组件只读，并通过 hudActions 把操作交还给引擎。
 */

import { reactive } from 'vue'
import { BOSS, CHARACTERS, EVAC, PLAYER, SQUAD_ORDER } from './config'
import type {
  ActorStatus,
  BossWeakWindow,
  CharacterId,
  EndingKind,
  EnemyType,
  GamePhase,
  HeliState,
  WeaponId,
} from './types'

export interface HudWeapon {
  id: WeaponId
  name: string
  mag: number
  magSize: number
  reserve: number
  active: boolean
}

export interface HudSquadMember {
  id: CharacterId
  name: string
  /** CSS 颜色 */
  color: string
  isPlayer: boolean
  status: ActorStatus
  hp: number
  /** 倒地剩余秒数 */
  downedTimer: number
  /** 当前武器名称 */
  weapon: string
  /** 弹药是否不足 25% */
  ammoLow: boolean
  /** 个人累计得分（右上角排名用） */
  score: number
}

/** 准星指向的队友信息 */
export interface HudAimTarget {
  id: CharacterId
  name: string
  /** CSS 颜色 */
  color: string
  status: ActorStatus
  hp: number
  /** 倒地剩余秒数 */
  downedTimer: number
  /** 当前武器名称 */
  weapon: string
  /** 与主控的距离（米） */
  distance: number
}

export interface HudSubtitle {
  id: number
  speaker: string
  color: string
  text: string
}

export interface HudBanner {
  /** 每次新横幅 +1，用作过渡动画的 key */
  id: number
  title: string
  sub: string
  tone: 'info' | 'danger' | 'success'
}

export interface HudEndingMember {
  id: CharacterId
  name: string
  isPlayer: boolean
  /** 是否登机生还 */
  survived: boolean
  /** 个人累计得分 */
  score: number
}

/** BE 的原因：主控阵亡 / 直升机被毁 */
export type HudEndingReason = 'death' | 'heliDestroyed'

export interface HudEnding {
  kind: EndingKind
  /** BE 的原因；缺省按主控阵亡处理 */
  reason?: HudEndingReason
  /** 通关 / 生存时间（秒） */
  time: number
  kills: Record<EnemyType, number>
  totalKills: number
  /** 主控命中率 0..1 */
  accuracy: number
  headshots: number
  squad: HudEndingMember[]
  hasSample: boolean
  /** 全队个人分数之和（撤离加成前） */
  baseScore: number
  /** 直升机撤离血量加成 */
  heliBonus: number
  /** 小队最终总分 = baseScore + heliBonus，结尾评级按此分档 */
  finalScore: number
  /** BE 时仍存活队友的喊话 */
  lastWords: { speaker: string; text: string }[]
}

export interface HudState {
  phase: GamePhase
  /** 指针是否已锁定（未锁定时只有键盘可用，鼠标视角与射击要等锁定） */
  locked: boolean
  /** 每次游戏中失去指针锁定（按 ESC、切走窗口）+1，游戏页据此打开暂停菜单 */
  pauseRequest: number
  /** 是否被外壳暂停菜单暂停 */
  paused: boolean
  /** 游戏内已流逝秒数 */
  elapsed: number
  /** 当前目标的一句话说明 */
  objective: string

  wave: number
  waveTotal: number
  waveKilled: number
  /** 场上存活丧尸数 */
  enemiesAlive: number

  hp: number
  maxHp: number
  status: ActorStatus
  downedTimer: number
  stunned: boolean
  weapons: HudWeapon[]
  /** 换弹进度 0..1；未在换弹为 -1 */
  reloadProgress: number
  /** 准星散布（弧度） */
  spread: number
  /** 准星高亮：瞄准敌人并正在开火时为 true（准星变红） */
  crosshairHot: boolean
  interaction: { text: string; progress: number } | null
  hasSample: boolean
  /** 全队总击杀 */
  kills: number

  squad: HudSquadMember[]
  /** 准星指向的队友；没有指向时为 null */
  aimTarget: HudAimTarget | null

  boss: {
    active: boolean
    alive: boolean
    name: string
    hp: number
    maxHp: number
    phase: 1 | 2
    weak: BossWeakWindow
    warning: string
  }
  heli: HeliState
  /** 撤离倒计时剩余秒数；未开始为 -1 */
  evacCountdown: number
  /** 直升机当前血量 / 上限 */
  heliHp: number
  heliMaxHp: number
  /** 主控剩余可领弹夹数 */
  resupplyLeft: number
  /** 主控此刻能否按 F 领弹夹 */
  canResupply: boolean

  /** 命中反馈：serial 每次命中 +1 */
  hitMarker: { serial: number; headshot: boolean; kill: boolean; weak: boolean }
  /** 受伤反馈：serial 每次受伤 +1 */
  damage: { serial: number; amount: number }
  slowMo: boolean

  banner: HudBanner | null
  subtitles: HudSubtitle[]
  /** 主控需要选择替换哪把武器（游戏暂停） */
  weaponChoice: { weapon: WeaponId; name: string } | null
  ending: HudEnding | null

  /** 作弊控制台是否打开（按 ` 切换；打开时游戏冻结） */
  cheatOpen: boolean
  /** 上一次提交的报错信息；空串表示无报错 */
  cheatError: string
  /** 作弊倒计时剩余秒数；没有进行中的作弊为 -1 */
  cheatCountdown: number
}

/** 开局时的小队状态 */
function initialSquad(): HudSquadMember[] {
  return SQUAD_ORDER.map((id) => {
    const def = CHARACTERS[id]
    return {
      id,
      name: def.name,
      color: def.hudColor,
      isPlayer: def.isPlayer,
      status: 'alive' as ActorStatus,
      hp: PLAYER.maxHp,
      downedTimer: 0,
      weapon: '',
      ammoLow: false,
      score: 0,
    }
  })
}

/** 生成一份全新的 HUD 初始状态 */
function initialState(): HudState {
  return {
    phase: 'prep',
    locked: false,
    pauseRequest: 0,
    paused: false,
    elapsed: 0,
    objective: '',
    wave: 0,
    waveTotal: 0,
    waveKilled: 0,
    enemiesAlive: 0,
    hp: PLAYER.maxHp,
    maxHp: PLAYER.maxHp,
    status: 'alive',
    downedTimer: 0,
    stunned: false,
    weapons: [],
    reloadProgress: -1,
    spread: 0,
    crosshairHot: false,
    interaction: null,
    hasSample: false,
    kills: 0,
    squad: initialSquad(),
    aimTarget: null,
    boss: {
      active: false,
      alive: false,
      name: BOSS.name,
      hp: BOSS.maxHp,
      maxHp: BOSS.maxHp,
      phase: 1,
      weak: 'none',
      warning: '',
    },
    heli: 'absent',
    evacCountdown: -1,
    heliHp: EVAC.heli.maxHp,
    heliMaxHp: EVAC.heli.maxHp,
    resupplyLeft: EVAC.resupply.magsPerPerson,
    canResupply: false,
    hitMarker: { serial: 0, headshot: false, kill: false, weak: false },
    damage: { serial: 0, amount: 0 },
    slowMo: false,
    banner: null,
    subtitles: [],
    weaponChoice: null,
    ending: null,
    cheatOpen: false,
    cheatError: '',
    cheatCountdown: -1,
  }
}

/** HUD 响应式状态 */
export const hud = reactive<HudState>(initialState())

/** 把 HUD 状态恢复到开局（重新开始时调用） */
export function resetHud(): void {
  // pauseRequest 是事件计数器：写回 0 会制造一次假变化，游戏页的 watch 会误开暂停菜单
  const pauseRequest = hud.pauseRequest
  Object.assign(hud, initialState())
  hud.pauseRequest = pauseRequest
}

/** HUD 交还给引擎的操作 */
export interface HudActions {
  /** 武器替换界面：选定被替换的槽位；null 表示放弃 */
  resolveWeaponChoice(slot: number | null): void
  /** 提交作弊指令（控制台打开时有效） */
  submitCheat(code: string): void
  /** 关闭作弊控制台 */
  closeCheat(): void
}

const NOOP_ACTIONS: HudActions = {
  resolveWeaponChoice: () => {},
  submitCheat: () => {},
  closeCheat: () => {},
}

/** HUD 组件调用的操作入口；引擎创建后绑定真实实现 */
export const hudActions: HudActions = { ...NOOP_ACTIONS }

/**
 * 绑定引擎提供的操作实现。
 * @param actions 引擎实现；传 null 恢复为空操作（引擎销毁时）
 */
export function bindHudActions(actions: HudActions | null): void {
  Object.assign(hudActions, actions ?? NOOP_ACTIONS)
}

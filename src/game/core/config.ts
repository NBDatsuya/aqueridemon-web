/**
 * 全部玩法数值（来自 SPEC.md）。纯数据，无引擎依赖。
 * SPEC 没有给出的数值（射程米数、散布、Boss 部位倍率等）在注释里标明“补充”。
 */

import type {
  CharacterDef,
  CharacterId,
  EnemyDef,
  EnemyType,
  SpawnPoint,
  TeammateAiDef,
  TeammateId,
  WaveDef,
  WeaponDef,
  WeaponId,
} from './types'

/** 单帧时间步长上限（秒），防止切页后的巨大 delta 造成穿透 */
export const MAX_DELTA_TIME = 0.05

/** 程序化生成的基础种子 */
export const GAME_SEED = 20261112

/* ── 场地 ── */

/** 足球场 100m × 70m：长边沿 X（东西），短边沿 Z（南北） */
export const FIELD = { halfX: 50, halfZ: 35 } as const

/** 小队可活动范围（含场边区域）；再往外是边界封锁物与刷新盲区 */
export const PLAY_BOUNDS = { halfX: 57, halfZ: 43 } as const

/** 中圈停机坪：半径 5m 内可登机 */
export const PAD = { x: 0, z: 0, radius: 5 } as const

/** 主控出生点与初始朝向（朝北，面向后山） */
export const PLAYER_START = { x: 0, z: 8, yaw: Math.PI } as const

/** 8 个刷新点：场地边缘外约 15-18m，每侧 2 个 */
export const SPAWN_POINTS: readonly SpawnPoint[] = [
  { id: 'N1', side: 'north', x: 30, z: -53 },
  { id: 'N2', side: 'north', x: -30, z: -53 },
  { id: 'E1', side: 'east', x: 68, z: -15 },
  { id: 'E2', side: 'east', x: 68, z: 15 },
  { id: 'S1', side: 'south', x: -30, z: 53 },
  { id: 'S2', side: 'south', x: 30, z: 53 },
  { id: 'W1', side: 'west', x: -68, z: -15 },
  { id: 'W2', side: 'west', x: -68, z: 15 },
]

/** 6 个预设空投点 A-F */
export const AIRDROP_POINTS: readonly { id: string; x: number; z: number }[] = [
  { id: 'A', x: 0, z: -10 },
  { id: 'B', x: 30, z: 0 },
  { id: 'C', x: -30, z: 0 },
  { id: 'D', x: 0, z: 30 },
  { id: 'E', x: 32, z: -22 },
  { id: 'F', x: -32, z: -22 },
]

/** 四角掩体点中心 */
export const CORNER_COVER = {
  northEast: { x: 39, z: -26 },
  southEast: { x: 39, z: 26 },
  southWest: { x: -39, z: 26 },
  northWest: { x: -39, z: -26 },
} as const

/** 北侧看台：3 级台阶，每级 0.5m，最高 1.5m；最低一级靠场内（南） */
export const BLEACHERS = { minX: -26, maxX: -10, minZ: -42.5, maxZ: -38, steps: 3, stepHeight: 0.5 } as const

/** Boss 从后山爬出：起点、撕开围栏的位置与缺口半宽 */
export const BOSS_ENTRY = { startX: 0, startZ: -64, breachZ: -45, breachHalfWidth: 8, arriveZ: -30 } as const

/* ── 主控 / 小队成员 ── */

export const PLAYER = {
  maxHp: 100,
  /** 医疗包可超过最大血量的上限（补充） */
  overhealMax: 150,
  walkSpeed: 4,
  sprintSpeed: 7,
  crawlSpeed: 1,
  jumpHeight: 1.2,
  /** 重力加速度（补充）。起跳速度 = sqrt(2 * gravity * jumpHeight) */
  gravity: 20,
  eyeHeight: 1.65,
  radius: 0.4,
  height: 1.8,
  /** 不跳跃也能踏上的台阶高度（补充） */
  stepHeight: 0.55,
  maxWeapons: 2,
  switchTime: 0.5,
  downedDuration: 15,
  reviveHp: 30,
  reviveInvuln: 2,
  /** 鼠标灵敏度：弧度 / 像素（补充） */
  mouseSensitivity: 0.0022,
  /** 击退速度衰减率 1/秒（补充）。初速 = 距离 × 该值 */
  knockbackDecay: 8,
} as const

export const INTERACT = {
  rescueRange: 2,
  rescueTime: 3,
  /** 拾取空投：距箱心的距离（SPEC 为靠近 1m，箱体本身约 1m 宽） */
  airdropRange: 2.2,
  sampleRange: 3,
  sampleTime: 3,
  boardTime: 2,
} as const

export const HEADSHOT = {
  multiplier: 2,
  slowMoDuration: 0.2,
  /** 慢动作期间的时间缩放（补充） */
  slowMoScale: 0.35,
} as const

export const CHARACTERS: Record<CharacterId, CharacterDef> = {
  samuel: {
    id: 'samuel',
    name: 'Samuel',
    isPlayer: true,
    bodyColor: 0x4a6a8f,
    legColor: 0x3a4250,
    headColor: 0xd9b99b,
    accentColor: 0x8a94a3,
    bodyScale: 1,
    hudColor: '#7aa2d6',
  },
  football: {
    id: 'football',
    name: 'Football Master',
    isPlayer: false,
    bodyColor: 0xd9432b,
    legColor: 0x2a2a2e,
    headColor: 0xc99a78,
    accentColor: 0xffc22e,
    bodyScale: 1.1,
    hudColor: '#f0623f',
  },
  manman: {
    id: 'manman',
    name: 'Manman',
    isPlayer: false,
    bodyColor: 0xf2f4f7,
    legColor: 0x8fb4dc,
    headColor: 0xe6c6aa,
    accentColor: 0x3b2a20,
    bodyScale: 0.9,
    hudColor: '#a9cdf2',
  },
  z91: {
    id: 'z91',
    name: '91Z先生',
    isPlayer: false,
    bodyColor: 0x1e1f24,
    legColor: 0x2b2d33,
    headColor: 0xcfae90,
    accentColor: 0x0d0d10,
    bodyScale: 1,
    hudColor: '#9aa0aa',
  },
}

/** 小队顺序（HUD 与 ctx.combatants 均按此顺序） */
export const SQUAD_ORDER: readonly CharacterId[] = ['samuel', 'football', 'manman', 'z91']

/** AI 队友差异化参数 */
export const TEAMMATE_AI: Record<TeammateId, TeammateAiDef> = {
  football: {
    engageRange: 30,
    headshotRate: 0.15,
    rescueEnemyLimit: 2,
    reloadThreshold: 0.3,
    preferredWeapons: ['ak47', 'mg3'],
    style: 'aggressive',
    followRight: 0,
    followForward: 8,
    moveSpeed: 6.2,
  },
  manman: {
    engageRange: 25,
    headshotRate: 0.2,
    rescueEnemyLimit: Infinity,
    reloadThreshold: 0.3,
    preferredWeapons: ['qbz95', 'mp5'],
    style: 'support',
    followRight: 4,
    followForward: -5,
    moveSpeed: 6,
  },
  z91: {
    engageRange: 28,
    headshotRate: 0.35,
    rescueEnemyLimit: 3,
    reloadThreshold: 0.4,
    preferredWeapons: ['ak47', 'mg3', 'mp5', 'qbz95'],
    style: 'flank',
    followRight: -8,
    followForward: 1,
    moveSpeed: 6,
  },
}

/** AI 射击精度与节奏 */
export const AI_SHOOTING = {
  hitStill: 0.7,
  hitMoving: 0.5,
  hitRunner: 0.35,
  /** 打 Boss 时命中弱点的概率（其余命中打在身体上） */
  hitBossWeak: 0.2,
  /** 打 Boss 身体的命中率（补充：目标巨大） */
  hitBossBody: 0.75,
  burstMin: 3,
  burstMax: 5,
  burstPause: 0.5,
  /** 发现敌人的最远距离（行为树 P3） */
  detectRange: 25,
  /** 队友倒地且距离小于该值时前往救援（行为树 P2） */
  rescueRange: 15,
  /** 统计“周围敌人”的半径（补充） */
  threatRadius: 8,
  /** 弹药低于该比例时主动前往空投（行为树 P4） */
  airdropAmmoRatio: 0.5,
  followMin: 5,
  followMax: 10,
} as const

/* ── 武器 ── */

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ak47: {
    id: 'ak47',
    name: 'AK-47',
    kind: '突击步枪',
    trait: '平衡全能，可靠',
    damage: 35,
    rpm: 600,
    magSize: 30,
    reserveMax: 120,
    reloadTime: 2.5,
    falloffStart: 40,
    falloffEnd: 70,
    falloffMin: 0.6,
    recoil: 1,
    spread: 0.012,
    moveMul: 1,
  },
  mg3: {
    id: 'mg3',
    name: 'MG3 银色杀手',
    kind: '轻机枪',
    trait: '火力压制，移动 -20%',
    damage: 25,
    rpm: 900,
    magSize: 100,
    reserveMax: 200,
    reloadTime: 4,
    falloffStart: 50,
    falloffEnd: 85,
    falloffMin: 0.6,
    recoil: 1.5,
    spread: 0.02,
    moveMul: 0.8,
  },
  mp5: {
    id: 'mp5',
    name: 'MP5',
    kind: '冲锋枪',
    trait: '灵活机动，近战优',
    damage: 20,
    rpm: 800,
    magSize: 30,
    reserveMax: 150,
    reloadTime: 1.8,
    falloffStart: 25,
    falloffEnd: 50,
    falloffMin: 0.5,
    recoil: 0.6,
    spread: 0.016,
    moveMul: 1,
  },
  qbz95: {
    id: 'qbz95',
    name: 'QBZ-95',
    kind: '突击步枪',
    trait: '精准射击，稳定',
    damage: 32,
    rpm: 650,
    magSize: 30,
    reserveMax: 120,
    reloadTime: 2.2,
    falloffStart: 50,
    falloffEnd: 85,
    falloffMin: 0.65,
    recoil: 0.6,
    spread: 0.008,
    moveMul: 1,
  },
}

export const WEAPON_ORDER: readonly WeaponId[] = ['ak47', 'mg3', 'mp5', 'qbz95']

/** 子弹最大检测距离 */
export const MAX_SHOT_DISTANCE = 160

/* ── 丧尸 ── */

export const ENEMIES: Record<EnemyType, EnemyDef> = {
  common: {
    type: 'common',
    name: '普通丧尸',
    hp: 100,
    speed: 2,
    damage: 20,
    attackInterval: 1.5,
    windup: 0.45,
    attackReach: 0.9,
    knockback: 0,
    radius: 0.4,
    height: 1.8,
    scale: 1,
  },
  runner: {
    type: 'runner',
    name: '快速丧尸',
    hp: 70,
    speed: 6,
    damage: 15,
    attackInterval: 1,
    windup: 0.3,
    attackReach: 1.1,
    knockback: 0,
    radius: 0.35,
    height: 1.75,
    scale: 0.97,
  },
  tank: {
    type: 'tank',
    name: '坦克丧尸',
    hp: 300,
    speed: 1,
    damage: 40,
    attackInterval: 2.5,
    windup: 0.9,
    attackReach: 1.4,
    knockback: 3,
    radius: 0.8,
    height: 2.5,
    scale: 1.39,
  },
}

/** 快速丧尸每秒触发左右摆动躲避的概率 */
export const RUNNER_DODGE_CHANCE = 0.1

/**
 * 对数强化系数。
 * @param progress 当前波进度 0..1（已刷出数 / 本波总数）
 */
export function waveScaling(progress: number): number {
  return 1 + 0.25 * Math.log(1 + progress * 2)
}

/** 强化系数对移动速度的影响比例：速度 = 基础 × [1 + (系数 - 1) × 0.3] */
export const SCALING_SPEED_RATIO = 0.3

/**
 * 三波共 15 / 25 / 30 只。波次间不留间歇：上一波清完空投即落、下一波立即开始。
 * 各波怪物比例沿用原设计：第 1 波全普通；第 2 波 普通:快速 ≈ 2:1；第 3 波 普通:快速:坦克 ≈ 14:12:4。
 */
export const WAVES: readonly WaveDef[] = [
  {
    wave: 1,
    stages: [
      { at: 0, spawn: { common: 8 } },
      { at: 30, spawn: { common: 7 } },
    ],
    airdrops: 1,
  },
  {
    wave: 2,
    stages: [
      { at: 0, spawn: { common: 11, runner: 6 } },
      { at: 45, spawn: { common: 6, runner: 2 } },
    ],
    airdrops: 2,
  },
  {
    wave: 3,
    stages: [
      { at: 0, spawn: { common: 7, runner: 6 } },
      { at: 40, spawn: { common: 5, runner: 5, tank: 3 } },
      { at: 100, spawn: { common: 2, runner: 1, tank: 1 } },
    ],
    airdrops: 0,
  },
]

export const SPAWN_RULES = {
  /** 同屏敌人上限 */
  maxConcurrent: 15,
  /** 刷新点距离所有小队成员的最小距离 */
  minPlayerDistance: 15,
  /** 每个刷新点的冷却 */
  pointCooldown: 3,
  /** 场上存活数不超过该值时提前投入下一批（补充，保持压力） */
  earlyStageAtAlive: 1,
  /** 波次开始时随机选定的主刷新方向被选中的概率（补充） */
  mainSideBias: 0.6,
  /** 远处敌人每 N 帧更新一次 AI */
  farUpdateEvery: 3,
  farDistance: 30,
} as const

/** 选完武器到第 1 波开始的准备时间（SPEC 的 0:00-0:30 含选枪时间，这里取选枪后的部分） */
export const PREP_DURATION = 10

/* ── Boss：阿奎尔巨兽 ── */

export const BOSS = {
  name: '阿奎尔巨兽',
  maxHp: 3000,
  /** 血量比例降到该值进入狂暴 */
  phase2Ratio: 0.5,
  speed: 1.5,
  speedEnraged: 2.5,
  /** 狂暴后招式时长倍率（攻击间隔缩短 20%） */
  enragedTimeMul: 0.8,
  radius: 3,
  height: 3,
  tentacles: 8,
  tentacleLength: 5,
  /** 登场爬出耗时（补充） */
  emergeTime: 6,
  sweep: { duration: 5, windup: 0.8, damage: 50, knockback: 5, arcDeg: 120, radius: 8 },
  stab: { duration: 3, windup: 0.5, damage: 80, repeats: 2, range: 14, width: 1.4 },
  spit: {
    duration: 6,
    windup: 1,
    pools: 3,
    poolRadius: 2,
    poolDps: 10,
    poolLife: 5,
    /** 毒池伤害结算间隔（补充，避免逐帧跳伤害） */
    poolTick: 0.5,
    minRange: 5,
    maxRange: 18,
  },
  summon: { interval: 30, count: 2, type: 'runner' as EnemyType },
  stagger: { duration: 2 },
  roar: { duration: 3 },
  shockwave: {
    interval: 25,
    windup: 2,
    damage: 50,
    stun: 1.5,
    radius: 20,
    /** 波环从中心扩散到最大半径的时间（补充） */
    expandTime: 0.7,
    /** 脚底离地超过该高度视为跳跃躲过（补充） */
    dodgeHeight: 0.3,
    proneDuration: 3,
  },
  /**
   * 部位伤害倍率。SPEC 只规定弱点窗口：硬直期头部核心 ×2、趴倒时背部核心 ×3。
   * 其余为补充：厚皮与触手大幅减伤、未暴露的头部核心减伤，让 Boss 战时长落在 60-90 秒。
   */
  damageMul: { body: 0.12, tentacle: 0.12, headCoreClosed: 0.6, headCoreOpen: 2, backCoreOpen: 3 },
  /** 死亡倒地演出时长（补充） */
  deathTime: 3,
  /** 靠近到该距离后停步出招（补充） */
  preferredRange: 6.5,
} as const

/* ── 空投 ── */

export const AIRDROP = {
  /** 按后来的要求不再空投武器，只投弹药和医疗包（SPEC 原为 70% / 20% / 10%） */
  weaponChance: 0,
  ammoChance: 0.6,
  medkitChance: 0.4,
  fallTime: 3,
  /** 起始高度（补充） */
  startHeight: 45,
  medkitHeal: 50,
  /** 每次空投的箱数（落点被未拾取的箱子占满时会少投） */
  perDrop: 4,
  /** Boss 登场时立即投下的箱数 */
  atBoss: 4,
  /** Boss 战期间每隔多少秒再投一次 */
  bossInterval: 20,
} as const

/** Boss 各招式的预警文案（HUD 显示；队友 AI 也靠它判断该怎么躲） */
export const BOSS_WARNING = {
  sweep: '触手横扫！横向闪避',
  stab: '触手突刺！左右闪避',
  spit: '毒液喷射！',
  stagger: '弱点暴露！集火头部核心',
  shock: '冲击波！跳跃躲避',
  prone: '背部核心暴露！',
} as const

/* ── 撤离 ── */

export const EVAC = {
  /** Boss 出现后多少秒直升机到达场地上方 */
  arriveAfter: 15,
  /** Boss 出现后多少秒开始缓慢下降 */
  descendAfter: 30,
  /** 悬停高度（补充） */
  hoverHeight: 32,
  /** Boss 战中缓降的最低高度（补充） */
  holdHeight: 14,
  /** 缓降速度 m/s（补充） */
  slowDescent: 0.25,
  /** Boss 死亡后多少秒降落完成 */
  landAfterBossDeath: 10,
  countdown: 60,
  /** 最后 N 秒每秒滴答 */
  tickFrom: 10,
  /** 最后 N 秒叠加心跳 */
  heartbeatFrom: 5,
  /** 起飞拉升演出时长（补充） */
  departTime: 6,
} as const

/* ── 喊话文案 ── */

export const VOICE = {
  downed: {
    samuel: '需要支援！',
    football: '该死，我中弹了！',
    manman: '救救我...',
    z91: '掩护我...',
  } satisfies Record<CharacterId, string>,
  /** 主控阵亡时仍存活的队友的喊话 */
  playerDeath: {
    football: '不！撑住！',
    manman: 'Samuel！',
    z91: '该死...',
  } satisfies Record<TeammateId, string>,
  rescuing: {
    football: '别动，我拉你起来！',
    manman: '坚持住，我来了。',
    z91: '我来。',
  } satisfies Record<TeammateId, string>,
  lowAmmo: {
    football: '他妈的子弹呢？',
    manman: '快没子弹了！',
    z91: '子弹快打空了！',
  } satisfies Record<TeammateId, string>,
  bossSpawn: {
    football: '那是什么鬼东西？！',
    manman: '打它头上发光的地方！',
    z91: '大家伙来了。',
  } satisfies Record<TeammateId, string>,
  heliLanded: {
    football: '直升机到了，快上！',
    manman: '快上飞机！',
    z91: '该走了。',
  } satisfies Record<TeammateId, string>,
} as const

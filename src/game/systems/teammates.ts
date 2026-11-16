/**
 * AI 队友系统：编号 1..3 的三名 AI 队友（名字见 config 的 CHARACTERS）。
 *
 * 结构：
 * - 决策层（每 0.15–0.3 秒一次，三人错开）：选目标、评估威胁、按 SPEC 行为树的优先级定出当前意图
 *   P1 倒地爬行 → P2 救援 →（撤离）→ P3 战斗 → P4 空投 → P5 跟随。
 * - 执行层（每帧）：按意图算出移动目标并移动，独立的射击层负责瞄准、点射与换弹，最后驱动人形动画。
 *
 * 每帧路径只使用工厂内预先建好的临时向量与复用对象，不分配新对象。
 */

import { Vector3 } from 'three'
import { CombatantBase, ammoRatio } from '../core/combatant'
import {
  AI_SHOOTING,
  BOSS,
  BOSS_WARNING,
  HEADSHOT,
  INTERACT,
  MAX_SHOT_DISTANCE,
  PAD,
  PLAYER,
  PLAY_BOUNDS,
  SQUAD_START,
  TEAMMATE_AI,
  TEAMMATE_IDS,
  TEAMMATE_TACTICS,
  VOICE,
  WEAPONS,
  WEAPON_CRATES,
} from '../core/config'
import type {
  AirdropCrate,
  BossZone,
  Combatant,
  DamageInfo,
  EnemyActor,
  GameContext,
  HumanoidAnimInput,
  HumanoidPose,
  HumanoidRig,
  SfxId,
  SfxOptions,
  TeammateAiDef,
  TeammateId,
  TeammateSystem,
  WeaponDef,
  WeaponId,
  WeaponRig,
  WeaponState,
} from '../core/types'
import { clamp, damp, dampAngle, distXZ, distXZSq, invLerp, lerp, wrapAngle, yawOf } from '../utils/math'
import { createTeammateNav, type TeammateNav } from './teammate-nav'
import { createSeatedRig, type SeatedRig } from './evac-seating'

const TT = TEAMMATE_TACTICS

/* ── 常量 ── */

/** 队友顺序（与 ctx.combatants 的后三位一致） */
const TEAMMATE_ORDER = TEAMMATE_IDS

const SHOT_SFX: Record<WeaponId, SfxId> = {
  ak47: 'shot_ak47',
  mg3: 'shot_mg3',
  mp5: 'shot_mp5',
  qbz95: 'shot_qbz95',
  barrett: 'shot_barrett',
}

/*
 * 以下是 config.ts 没有收录的 AI 行为参数（补充），取值来自任务说明里的约数。
 * 玩法数值（伤害、命中率、读条时间、速度等）一律读 config。
 */

/** 重新决策的间隔范围（秒） */
const THINK_MIN = 0.15
const THINK_MAX = 0.3
/** 弹药比例低于该值时喊一次“弹药不多了” */
const LOW_AMMO_RATIO = 0.25

/** 没有丧尸时，Boss 在该距离内才会被当作目标 */
const BOSS_ENGAGE_RANGE = 45
/** 与 Boss 保持的距离区间（三人按风格各取一个值） */
const BOSS_RANGE_MIN = 14
const BOSS_RANGE_MAX = 19
/** Boss 存活时，任何移动目标都不能落在 Boss 周围这个距离内（横扫半径 + 2m） */
const BOSS_KEEP_OUT = BOSS.sweep.radius + 2
/** 目标点被推出禁区时再多留的余量 */
const BOSS_KEEP_OUT_PAD = 1
/** 进入 BOSS_KEEP_OUT 就后撤，退到再远这么多才停（滞回） */
const BOSS_CLOSE_MARGIN = 2
/** 救援倒地成员时允许靠近到 Boss 身体半径 + 该值 */
const BOSS_RESCUE_CLEARANCE = 1.5
/** Boss 战站位偏离超过该值才重新走位（滞回） */
const BOSS_REPOSITION = 4
/** 冲击波预警：跑到冲击波半径 + 该值以外（队友不会跳） */
const BOSS_SHOCK_ESCAPE = 2.5
/** 横扫预警：退到横扫半径 + 该值以外 */
const BOSS_SWEEP_ESCAPE = 2
/** 突刺 / 毒液预警或踩到毒池时，沿 Boss 圆周切向横移的距离 */
const BOSS_SIDESTEP = 3
/** 突刺 / 毒液预警的横移最多持续多久（秒） */
const BOSS_SIDESTEP_TIME = 1
/** 受到毒池伤害后离开原地的持续时间（秒） */
const BOSS_POISON_DODGE = 1.2
/** 预警躲避的到达判定半径（比 ARRIVE 小，保证动起来） */
const BOSS_DODGE_ARRIVE = 0.4
/** 绕 Boss 的方位角至少与主控相差这么多（弧度），不站在主控枪线上 */
const BOSS_PLAYER_GAP = 0.7
/** 绕 Boss 的方位角至少与其他队友相差这么多（弧度） */
const BOSS_MATE_GAP = 0.55
/** 站位点被场地边界截断后离 Boss 太近时，沿圆周换角度的步长（弧度）与最多尝试次数 */
const BOSS_RING_STEP = 0.35
const BOSS_RING_TRIES = 9
/** 截断后的站位点离 Boss 至少要有站位距离减去该值 */
const BOSS_RING_SLACK = 3

/** 激进型前压：距离大于 FAR 时推进，推进到两者中点停下 */
const ADVANCE_NEAR = 8
const ADVANCE_FAR = 12
/** 侧翼型：相对“主控 → 敌人”连线的横向 / 前向偏移 */
const FLANK_OFFSET = 10
const FLANK_ADVANCE = 4
const FLANK_REPOSITION = 4

/** 后撤时每次取的目标步长；被包围时更长 */
const KITE_STEP = 5
const KITE_STEP_SURROUNDED = 7
/** 后撤方向里混入“回到站位”的权重，避免一路退到场边 */
const KITE_REGROUP_BIAS = 0.35
/** 后撤候选方向数（均分一圈） */
const ESCAPE_DIRS = 12
/** 评估某点危险度时考虑的丧尸半径（米） */
const SPOT_THREAT_RADIUS = 6
/** 交战中被拉回站位后，回到 leash 的这个比例以内才重新自由走位；激进型推进点也限制在这个范围内 */
const LEASH_RELEASE = 0.6
/** 激进型在激进前压时与目标保持的距离（米） */
const ADVANCE_STANDOFF = 9
/** 激进型选目标时，在自己一侧的丧尸可以比另一侧远这么多仍被优先（米） */
const FLANK_TARGET_BIAS = 8
/** 激进型身边这么近有丧尸时，只打最近的（米） */
const SELF_DEFENSE_RANGE = 8
/** 站位离主控的距离超出 postMax 这么多就不考虑（也是被拉回站位的距离） */
const POST_RANGE_SLACK = 4
/** 站位附近危险度超过该值就换站位 */
const POST_THREAT_LIMIT = 1.5
/** 站位评分权重：偏离偏好方位（每弧度）、落在视野锥 / 毒池、掩体、高处、危险度、队友间距、路程 */
const POST_BEARING_WEIGHT = 0.6
const POST_VIEW_PENALTY = 3
const POST_COVER_BONUS = 0.8
const POST_HIGH_BONUS = 0.4
const POST_THREAT_WEIGHT = 1.5
const POST_SPACING_WEIGHT = 1.5
const POST_TRAVEL_SCALE = 40
const POST_TRAVEL_WEIGHT = 0.5
/** 偏好方位两侧补充空地候选点的角度步长（弧度） */
const POST_FAN_STEP = 0.35
/** 弹匣剩余低于该比例且有丧尸靠近时边退边换弹 */
const RETREAT_MAG_RATIO = 0.15
/** 躲毒池的候选方向数 */
const POISON_DIRS = 8
/** 毒池半径与 BossPoisonPool.status 取值 */
const POOL_RADIUS = BOSS.spit.poolRadius
const POOL_FREE = 0
const POOL_FLYING = 1
/** 视野锥半角的正切 */
const VIEW_TAN = Math.tan(TEAMMATE_TACTICS.viewConeHalf)

/** 搜索已落地空投的最远距离 */
const AIRDROP_SEEK_RANGE = 60
/** 主控在该距离内正走向箱子时让给主控 */
const AIRDROP_YIELD_RANGE = 6
/** 判定“主控正走向箱子”的最小接近速度（m/s） */
const AIRDROP_YIELD_SPEED = 0.5
/** 治疗需求（补充）：HP 低于该值时医疗包才有用（PLAYER.maxHp 为 100） */
const HEAL_NEED_HP = 65
/** 紧急治疗（补充）：HP 低于该值时即使正在交战也先去拿医疗包 */
const HEAL_URGENT_HP = 35
/** 紧急弹药（补充）：弹药比例低于该值时即使正在交战也先去拿弹药箱 */
const AMMO_URGENT_RATIO = 0.25
/** Boss 存活时，离 Boss 不到“横扫半径 + 该值”的空投不去拿（补充） */
const AIRDROP_BOSS_MARGIN = 2

/** 撤离：倒计时不多于该值时无条件登机 */
const EVAC_RUSH_COUNTDOWN = 25
/** 撤离：主控离停机坪中心不超过该值时跟着登机 */
const EVAC_PLAYER_NEAR = 12

/** 到达判定半径（到达后要离开更远才会重新出发，见各 plan 函数） */
const ARRIVE = 1.2
/** 救援：走到 rescueRange 内再多靠近这么多才站定；读条中允许的额外距离 */
const RESCUE_APPROACH_MARGIN = 0.5
const RESCUE_CHANNEL_SLACK = 0.3
/** 倒地爬行：离队友多近就停下 */
const CRAWL_STOP = 1.5

/** 小队成员之间的最小间距 */
const SEPARATION = 1.2
/** 目标点离活动边界的余量 */
const BOUND_MARGIN = 1
/** 下台阶时的下落速度（m/s） */
const FALL_SPEED = 8

/** 卡住检测：实际位移低于预期的该比例视为受阻；持续 STUCK_TIME 秒后改走绕行点 */
const STUCK_RATIO = 0.25
const STUCK_TIME = 0.6
/** 连续这么久没有卡住就清零卡住次数（秒） */
const STUCK_FORGET = 2
/** 到达绕行点的判定半径 */
const DETOUR_ARRIVE = 0.6
/** 离目标点这么近开始减速（米），减速后的最低速度比例 */
const ARRIVE_SLOW = 0.8
const ARRIVE_MIN_SPEED = 0.35
/** 不想移动时的减速比加速快这么多倍 */
const STOP_ACCEL_MUL = 1.5
/** 平滑速度高于该值才按速度方向转身（m/s） */
const MOVE_DIR_MIN_SPEED = 0.3
/** 绕行点至少要能走出这么远（米） */
const DETOUR_MIN = 1

/** 避障采样：目标方向两侧的最大偏转角（弧度，约 100°） */
const STEER_SPREAD = 1.75
/** 避障评分权重：开阔度、贴近 world.steer 绕角建议、与上次方向一致、朝威胁中心走 */
const STEER_CLEAR_WEIGHT = 1.2
const STEER_HINT_WEIGHT = 0.4
const STEER_KEEP_WEIGHT = 0.35
const STEER_THREAT_WEIGHT = 0.6
/** 前方可走距离低于该值的方向视为走不通（米） */
const STEER_MIN_CLEAR = 0.3
/** 主控开火时，沿候选方向走这么远会进入视野锥就扣分 */
const STEER_LOF_PROBE = 1.5
const STEER_LOF_PENALTY = 0.8
/** 拥挤：前方夹角余弦大于 CROWD_AHEAD 的成员才算挡路；主控 / 队友的权重；总代价低于 CROWD_DIRECT 时仍直走 */
const CROWD_AHEAD = 0.3
const CROWD_PLAYER = 1.2
const CROWD_MATE = 0.8
const CROWD_DIRECT = 0.3
/** 站在目标点这么近的成员不算挡路（救援对象、爬向的队友） */
const CROWD_GOAL_SKIP = 1.5

/** 转身速率（1/秒） */
const TURN_RATE = 10
/** 动画速度的平滑速率（1/秒） */
const ANIM_SPEED_RATE = 12
/** 朝向与目标夹角小于该值才开火（弧度） */
const FIRE_CONE = 0.4
/** 目标移动速度低于该值视为“基本静止” */
const STILL_SPEED = 0.6
/** 目标速度估计的平滑速率（1/秒） */
const TARGET_SPEED_RATE = 8
/** 单帧最多补发的子弹数（防止卡帧后一口气打空） */
const MAX_SHOTS_PER_FRAME = 3

/** 打偏时落点的横向偏离（米）：取 [0.5, 1] × 该值 */
const MISS_SPREAD_ENEMY = 1.6
const MISS_SPREAD_BOSS = 7
/** 打在 Boss 身体上的落点散布（米） */
const BOSS_BODY_SCATTER = 0.8
/** 打偏且没有打到任何东西时的曳光长度 */
const MISS_TRACER_LENGTH = 60

const SHOT_VOLUME = 0.6
const RELOAD_VOLUME = 0.5
const SWITCH_VOLUME = 0.4
const MUZZLE_FLASH_SCALE = 0.8
/** 没有枪口挂点时的兜底：枪口在身前多远 */
const MUZZLE_FORWARD = 0.6
/** 开枪动画持续时间（秒） */
const SHOOT_ANIM_TIME = 0.12
/** 肩高占身高的比例（算瞄准俯仰） */
const SHOULDER_RATIO = 0.75

/* ── 内部状态 ── */

type Goal = 'follow' | 'rescue' | 'combat' | 'airdrop' | 'evac'
type Channel = 'none' | 'rescue' | 'board'

interface Mate {
  readonly id: TeammateId
  readonly index: number
  readonly def: TeammateAiDef
  readonly actor: CombatantBase
  readonly rig: HumanoidRig
  readonly anim: HumanoidAnimInput
  /** 当前移动目标（只用 x / z） */
  readonly dest: Vector3
  /** 当前瞄准点 */
  readonly aimPoint: Vector3
  readonly shoulderY: number
  /** Boss 战保持的距离 */
  readonly bossRange: number
  /** 侧翼方向：1 右 / -1 左 */
  readonly side: 1 | -1
  weaponRig: WeaponRig | null

  yaw: number
  moveYaw: number
  hasMoveDir: boolean
  animSpeed: number

  goal: Goal
  thinkTimer: number
  /** 是否正在走向目标点（到达滞回用） */
  moving: boolean
  kiting: boolean
  /** 离主控太远，被拉回阵型中 */
  leashed: boolean
  stuckTime: number
  /** 连续卡住的次数与距上次卡住的时间 */
  stuckCount: number
  unstuckTime: number
  /** 绕行点：卡住后先走到这里，再继续走向 dest */
  detourTimer: number
  detourX: number
  detourZ: number

  /** 平滑后的水平速度（m/s） */
  velX: number
  velZ: number
  /** 避障选出的行进方向（单位向量）与重新采样计时；direct 表示前方畅通、每帧直接朝目标 */
  steerX: number
  steerZ: number
  steerTimer: number
  steerDirect: boolean

  /** 自主站位点（不随主控逐帧移动） */
  hasPost: boolean
  postX: number
  postZ: number
  postTimer: number
  /** 自己站在主控视野锥里的持续时间 */
  viewTime: number

  /** 威胁场（决策层更新）：加权压力、远离加权中心的单位方向、是否被包围、离最危险丧尸“后撤圈”的余量 */
  danger: number
  escapeX: number
  escapeZ: number
  surrounded: boolean
  kiteGap: number
  /** 后撤目标点与重新评估计时 */
  escapeTimer: number
  avoidX: number
  avoidZ: number

  target: EnemyActor | null
  targetBoss: boolean
  targetVisible: boolean
  targetSpeed: number
  lastTargetX: number
  lastTargetZ: number
  /** 最近的丧尸（不要求视线），用于后撤判断 */
  threat: EnemyActor | null
  threatCount: number

  /** 本帧是否面向并瞄准目标 */
  facingTarget: boolean
  aimYaw: number
  aimPitch: number
  aimPitchTarget: number

  burstLeft: number
  shotTimer: number
  pauseTimer: number
  sinceShot: number
  reloadTimer: number
  reloadTotal: number

  rescueTarget: Combatant | null
  /** 已经为谁喊过救援台词（避免重复喊） */
  voicedRescue: Combatant | null
  channel: Channel
  channelTime: number
  /** 读条开始时的 damageSerial */
  channelSerial: number

  crate: AirdropCrate | null
  /** 拾取失败（needsChoice）的箱子，不再尝试 */
  skipCrateId: number

  /** Boss 战横移躲避（突刺 / 毒液 / 毒池）剩余时间与目标点 */
  dodgeTimer: number
  dodgeX: number
  dodgeZ: number
  /** 下一次横移的方向，每次横移后翻转 */
  dodgeSign: 1 | -1
  /** 本帧躲避是否需要移动 */
  dodgeMove: boolean
  /** 上一帧读到的 Boss 预警文案（判断预警刚出现） */
  lastWarning: string

  lowAmmoVoiced: boolean
  seenSerial: number
  wasDowned: boolean
  deadHandled: boolean
  /** 已登机并隐藏，不再更新 */
  gone: boolean
}

/** 伤害随距离的衰减倍率 */
function falloff(def: WeaponDef, dist: number): number {
  return lerp(1, def.falloffMin, invLerp(def.falloffStart, def.falloffEnd, dist))
}

/** 把跟随槽位（主控位置 + 按朝向旋转的右 / 前偏移）写入 out，y 置 0。只用于出生点与兜底 */
function writeSlot(def: TeammateAiDef, px: number, pz: number, yaw: number, out: Vector3): Vector3 {
  const fx = Math.sin(yaw)
  const fz = Math.cos(yaw)
  // 朝向 (fx, fz) 的右手方向是 (-fz, fx)
  return out.set(
    px - fz * def.followRight + fx * def.followForward,
    0,
    pz + fx * def.followRight + fz * def.followForward,
  )
}

/**
 * 创建 AI 队友系统：三名队友的状态、模型、行为树与射击。
 * actors 在工厂执行期间即建好，顺序为编号 1、2、3。
 * @param ctx 游戏上下文（工厂执行期间只使用 scene / rng / events / models / audio）
 */
export function createTeammates(ctx: GameContext): TeammateSystem {
  const { scene, rng, events, models, audio } = ctx

  /* 复用的临时对象 */
  const vDir = new Vector3()
  const vTmp = new Vector3()
  const vEye = new Vector3()
  const vAim = new Vector3()
  const vMuzzle = new Vector3()
  const vEnd = new Vector3()
  const vShot = new Vector3()
  const vHitPoint = new Vector3()
  const vHitDir = new Vector3()
  const sfxPos = new Vector3()
  const sfx: SfxOptions = { position: sfxPos, volume: 1, rate: 1 }
  const dmgInfo: DamageInfo = { attacker: null, headshot: false, point: vHitPoint, direction: vHitDir }

  const mates: Mate[] = []
  const actors: CombatantBase[] = []
  /** 场地查询（避障探测、站位点），init 时 world 可用后才建 */
  let nav: TeammateNav | null = null

  for (let i = 0; i < TEAMMATE_ORDER.length; i++) {
    const id = TEAMMATE_ORDER[i]
    if (id === undefined) continue
    const mate = createMate(id, i)
    mates.push(mate)
    actors.push(mate.actor)
  }

  // 踩到毒池：离开当前位置一小段时间（已在横移中就不改方向）
  const offDamaged = events.on('combatantDamaged', ({ who, source }) => {
    if (source !== 'bossPoison' || !bossFight()) return
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i]
      if (!m || m.actor !== who) continue
      if (m.dodgeTimer <= 0 && m.actor.status === 'alive') startSidestep(m, BOSS_POISON_DODGE)
      return
    }
  })

  /* ── 创建 ── */

  function createMate(id: TeammateId, index: number): Mate {
    const def = TEAMMATE_AI[id]
    const actor = new CombatantBase(id, events)
    // 开局手上没有枪：4 人按 SQUAD_ORDER 排成一排（主控占 slots[0]），正对自己那两箱主武器
    actor.position.set(SQUAD_START.slots[index + 1] ?? SQUAD_START.slots[0], 0, SQUAD_START.z)

    const rig = models.createCharacter(id)
    rig.root.position.copy(actor.position)
    rig.root.rotation.y = SQUAD_START.yaw
    scene.add(rig.root)

    const mid = (BOSS_RANGE_MIN + BOSS_RANGE_MAX) / 2
    const bossRange = def.style === 'aggressive' ? BOSS_RANGE_MIN + 1 : def.style === 'support' ? BOSS_RANGE_MAX - 1 : mid

    const mate: Mate = {
      id,
      index,
      def,
      actor,
      rig,
      anim: { speed: 0, pose: 'stand', action: 'none', actionProgress: 0, aiming: false, aimPitch: 0 },
      dest: new Vector3().copy(actor.position),
      aimPoint: new Vector3(),
      shoulderY: rig.height * SHOULDER_RATIO,
      bossRange,
      side: def.followRight < 0 ? -1 : 1,
      weaponRig: null,
      yaw: SQUAD_START.yaw,
      moveYaw: SQUAD_START.yaw,
      hasMoveDir: false,
      animSpeed: 0,
      goal: 'follow',
      // 三人的决策错开在不同帧
      thinkTimer: (THINK_MIN * (index + 1)) / TEAMMATE_ORDER.length,
      moving: false,
      kiting: false,
      leashed: false,
      stuckTime: 0,
      stuckCount: 0,
      unstuckTime: 0,
      detourTimer: 0,
      detourX: 0,
      detourZ: 0,
      velX: 0,
      velZ: 0,
      steerX: 0,
      steerZ: 1,
      steerTimer: 0,
      steerDirect: true,
      hasPost: false,
      postX: 0,
      postZ: 0,
      postTimer: 0,
      viewTime: 0,
      danger: 0,
      escapeX: 0,
      escapeZ: 0,
      surrounded: false,
      kiteGap: Infinity,
      escapeTimer: 0,
      avoidX: 0,
      avoidZ: 0,
      target: null,
      targetBoss: false,
      targetVisible: false,
      targetSpeed: 0,
      lastTargetX: 0,
      lastTargetZ: 0,
      threat: null,
      threatCount: 0,
      facingTarget: false,
      aimYaw: SQUAD_START.yaw,
      aimPitch: 0,
      aimPitchTarget: 0,
      burstLeft: 0,
      shotTimer: 0,
      pauseTimer: 0,
      sinceShot: 99,
      reloadTimer: 0,
      reloadTotal: 1,
      rescueTarget: null,
      voicedRescue: null,
      channel: 'none',
      channelTime: 0,
      channelSerial: 0,
      crate: null,
      skipCrateId: -1,
      dodgeTimer: 0,
      dodgeX: 0,
      dodgeZ: 0,
      dodgeSign: def.followRight < 0 ? -1 : 1,
      dodgeMove: false,
      lastWarning: '',
      lowAmmoVoiced: false,
      seenSerial: 0,
      wasDowned: false,
      deadHandled: false,
      gone: false,
    }
    syncWeaponModel(mate)
    return mate
  }

  /* ── 通用小工具 ── */

  function playSfx(id: SfxId, at: Vector3, volume: number, rate: number): void {
    sfxPos.copy(at)
    sfx.volume = volume
    sfx.rate = rate
    audio.play(id, sfx)
  }

  /** 把移动目标限制在活动范围内，并把 y 对齐到自己脚底 */
  function clampDest(m: Mate): void {
    const d = m.dest
    d.x = clamp(d.x, -PLAY_BOUNDS.halfX + BOUND_MARGIN, PLAY_BOUNDS.halfX - BOUND_MARGIN)
    d.z = clamp(d.z, -PLAY_BOUNDS.halfZ + BOUND_MARGIN, PLAY_BOUNDS.halfZ - BOUND_MARGIN)
    d.y = m.actor.position.y
  }

  /** 手上的武器模型与当前武器不一致时重建 */
  function syncWeaponModel(m: Mate): void {
    const w = m.actor.weapon
    const want = w ? w.id : null
    const have = m.weaponRig ? m.weaponRig.id : null
    if (want === have) return
    m.rig.attachWeapon(null)
    if (m.weaponRig) m.weaponRig.dispose()
    m.weaponRig = null
    if (want) {
      m.weaponRig = models.createWeapon(want)
      m.rig.attachWeapon(m.weaponRig)
    }
    // 换了枪：换弹与点射重新开始
    m.reloadTimer = 0
    m.burstLeft = 0
  }

  function switchWeapon(m: Mate, slot: number): void {
    m.actor.currentWeapon = slot
    m.reloadTimer = 0
    m.burstLeft = 0
    m.pauseTimer = Math.max(m.pauseTimer, PLAYER.switchTime)
    playSfx('switch', m.actor.position, SWITCH_VOLUME, 1)
  }

  /** 当前武器打空而另一把还有弹药时切过去 */
  function ensureUsableWeapon(m: Mate): void {
    const a = m.actor
    const w = a.weapon
    if (w && w.mag + w.reserve > 0) return
    for (let i = 0; i < a.weapons.length; i++) {
      const other = a.weapons[i]
      if (i === a.currentWeapon || !other) continue
      if (other.mag + other.reserve > 0) {
        switchWeapon(m, i)
        return
      }
    }
  }

  /** 拾取空投后换到弹药比例最高的那把 */
  function selectBestWeapon(m: Mate): void {
    const a = m.actor
    let best = a.currentWeapon
    let bestRatio = ammoRatio(a.weapon)
    for (let i = 0; i < a.weapons.length; i++) {
      const ratio = ammoRatio(a.weapons[i])
      if (ratio > bestRatio) {
        best = i
        bestRatio = ratio
      }
    }
    if (best !== a.currentWeapon) switchWeapon(m, best)
  }

  /* ── 救援 / 读条状态 ── */

  /** 放弃当前救援：归还占用标记并清掉读条 */
  function endRescue(m: Mate): void {
    const t = m.rescueTarget
    if (t && t.rescuer === m.id) t.rescuer = null
    m.rescueTarget = null
    if (m.channel === 'rescue') {
      m.channel = 'none'
      m.channelTime = 0
    }
  }

  /** 打断读条（受伤、眩晕），救援目标保留，之后重新开始 */
  function interruptChannel(m: Mate): void {
    if (m.channel === 'none') return
    const t = m.rescueTarget
    if (m.channel === 'rescue' && t && t.rescuer === m.id) t.rescuer = null
    m.channel = 'none'
    m.channelTime = 0
  }

  function setGoal(m: Mate, goal: Goal): void {
    if (m.goal === goal) return
    if (m.goal === 'rescue') endRescue(m)
    else if (m.goal === 'airdrop') m.crate = null
    else if (m.goal === 'evac' && m.channel === 'board') {
      m.channel = 'none'
      m.channelTime = 0
    }
    m.goal = goal
  }

  /** 倒地 / 阵亡 / 登机时清掉全部行动状态 */
  function resetActions(m: Mate): void {
    endRescue(m)
    m.channel = 'none'
    m.channelTime = 0
    m.crate = null
    m.goal = 'follow'
    m.reloadTimer = 0
    m.burstLeft = 0
    m.target = null
    m.targetBoss = false
    m.targetVisible = false
    m.threat = null
    m.facingTarget = false
    m.moving = false
    m.kiting = false
    m.leashed = false
    m.stuckTime = 0
    m.stuckCount = 0
    m.detourTimer = 0
    m.velX = 0
    m.velZ = 0
    m.steerTimer = 0
    m.hasPost = false
    m.viewTime = 0
    m.danger = 0
    m.surrounded = false
    m.kiteGap = Infinity
    m.escapeTimer = 0
    m.dodgeTimer = 0
    m.dodgeMove = false
  }

  /* ── 决策层 ── */

  function setTarget(m: Mate, enemy: EnemyActor | null): void {
    if (m.target === enemy) return
    m.target = enemy
    if (enemy) {
      m.lastTargetX = enemy.position.x
      m.lastTargetZ = enemy.position.z
      // 新目标先按“移动中”估计
      m.targetSpeed = STILL_SPEED * 2
    }
  }

  /** 选射击目标：最近且有视线的丧尸；没有丧尸时选 Boss */
  function pickTarget(m: Mate): void {
    const pos = m.actor.position
    const world = ctx.world
    vEye.set(pos.x, pos.y + PLAYER.eyeHeight, pos.z)

    let best: EnemyActor | null = null
    const near = m.threat
    const p = ctx.player.actor
    if (
      near &&
      m.def.style === 'aggressive' &&
      p.status === 'alive' &&
      distXZSq(pos, near.position) > SELF_DEFENSE_RANGE * SELF_DEFENSE_RANGE
    ) {
      // 激进型：身边暂时安全时优先清理主控“自己这一侧”的丧尸，另一侧留给别人
      const rx = -Math.cos(ctx.player.yaw)
      const rz = Math.sin(ctx.player.yaw)
      const list = ctx.enemies.active
      let bestCost = m.def.engageRange + FLANK_TARGET_BIAS
      for (let i = 0; i < list.length; i++) {
        const e = list[i]
        if (!e || !e.alive) continue
        const d = distXZ(pos, e.position)
        if (d >= m.def.engageRange) continue
        const lateral = (e.position.x - p.position.x) * rx + (e.position.z - p.position.z) * rz
        const cost = d + (lateral * m.side >= 0 ? 0 : FLANK_TARGET_BIAS)
        if (cost >= bestCost) continue
        if (!world.hasLineOfSight(vEye, e.aimCenter(vAim))) continue
        best = e
        bestCost = cost
      }
    } else if (near) {
      if (world.hasLineOfSight(vEye, near.aimCenter(vAim))) {
        best = near
      } else {
        // 最近的被挡住了：在其余丧尸里找最近且看得见的
        const list = ctx.enemies.active
        let bestSq = m.def.engageRange * m.def.engageRange
        for (let i = 0; i < list.length; i++) {
          const e = list[i]
          if (!e || !e.alive || e === near) continue
          const dSq = distXZSq(pos, e.position)
          if (dSq >= bestSq) continue
          if (!world.hasLineOfSight(vEye, e.aimCenter(vAim))) continue
          best = e
          bestSq = dSq
        }
      }
    }
    setTarget(m, best)
    m.targetBoss = false
    m.targetVisible = best !== null
    if (best) return

    const boss = ctx.boss
    if (boss.active && boss.alive && distXZ(pos, boss.position) < BOSS_ENGAGE_RANGE) {
      m.targetBoss = true
      m.targetVisible = world.hasLineOfSight(vEye, boss.aimPoint(vAim))
    }
  }

  /** P2：最近的、没被别人占用的倒地成员；周围敌人太多时放弃（2 号队友的上限是 Infinity） */
  function findRescueTarget(m: Mate): Combatant | null {
    const a = m.actor
    const list = ctx.combatants
    let best: Combatant | null = null
    let bestSq = AI_SHOOTING.rescueRange * AI_SHOOTING.rescueRange
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!c || c === a || c.status !== 'downed') continue
      if (c.rescuer !== null && c.rescuer !== m.id) continue
      const dSq = distXZSq(a.position, c.position)
      if (dSq < bestSq) {
        best = c
        bestSq = dSq
      }
    }
    if (!best) return null
    if (m.threatCount >= m.def.rescueEnemyLimit) return null
    return best
  }

  /** 撤离条件：直升机已降落，且主控已登机 / 倒计时所剩不多 / 主控已靠近停机坪 */
  function shouldEvacuate(): boolean {
    const evac = ctx.evac
    if (evac.heliState !== 'landed') return false
    const p = ctx.player.actor
    if (p.status === 'boarded') return true
    if (evac.countdown >= 0 && evac.countdown <= EVAC_RUSH_COUNTDOWN) return true
    return Math.hypot(p.position.x - PAD.x, p.position.z - PAD.z) <= EVAC_PLAYER_NEAR
  }

  /** 主控比自己更近，且已站在箱子旁或正朝箱子走过来：让给主控 */
  function playerClaims(crate: AirdropCrate, mine: number): boolean {
    const p = ctx.player.actor
    if (p.status !== 'alive') return false
    const tx = crate.position.x - p.position.x
    const tz = crate.position.z - p.position.z
    const theirs = Math.hypot(tx, tz)
    if (theirs >= mine) return false
    // 主控已经站在箱子旁
    if (theirs < INTERACT.airdropRange) return true
    // 主控在附近并且正朝箱子走
    return theirs < AIRDROP_YIELD_RANGE && p.velocity.x * tx + p.velocity.z * tz > theirs * AIRDROP_YIELD_SPEED
  }

  /** 别的队友已经认领了这个箱子 */
  function mateClaims(m: Mate, crate: AirdropCrate): boolean {
    for (let i = 0; i < mates.length; i++) {
      const o = mates[i]
      if (!o || o === m) continue
      if (o.goal === 'airdrop' && o.crate === crate && o.actor.status === 'alive') return true
    }
    return false
  }

  /**
   * 开局主武器箱是否正对自己：4 人一排、箱子一排，按 SQUAD_ORDER 每人分到正前方的
   * perPerson 个（主控占 slots[0]，队友依次后移），只开自己那份，不与别人争抢。
   */
  function inOwnLane(m: Mate, c: AirdropCrate): boolean {
    const points = WEAPON_CRATES.points
    const first = (m.index + 1) * WEAPON_CRATES.perPerson
    for (let k = 0; k < WEAPON_CRATES.perPerson; k++) {
      const p = points[first + k]
      if (p && Math.abs(c.position.x - p.x) < 0.01 && Math.abs(c.position.z - p.z) < 0.01) return true
    }
    return false
  }

  /**
   * 主武器槽位没满时挑一个主武器箱：优先自己偏好的型号，同级里取最近的。
   * 开局摆在地上的箱子只取正对自己那两个；空投下来的不限。
   * 跳过已经开满的人、别的队友认领的、主控正要拿的箱子。
   */
  function findWeaponCrate(m: Mate): AirdropCrate | null {
    const pos = m.actor.position
    const list = ctx.airdrops.crates
    const quotaUsed = ctx.airdrops.hasOpenedWeaponCrate(m.actor)
    let best: AirdropCrate | null = null
    let bestSq = AIRDROP_SEEK_RANGE * AIRDROP_SEEK_RANGE
    let bestPreferred = false
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!c || !c.landed || c.content.kind !== 'weapon' || c.id === m.skipCrateId) continue
      // 开局摆在地上的箱子：有每人限开次数，且只开正对自己的那份；空投下来的不限
      if (c.limited && (quotaUsed || !inOwnLane(m, c))) continue
      const preferred = m.def.preferredWeapons.includes(c.content.weapon)
      const dSq = distXZSq(pos, c.position)
      // 同为偏好（或同为非偏好）时比距离；已经选中偏好箱就不再换成别的
      if (preferred === bestPreferred ? dSq >= bestSq : !preferred) continue
      if (mateClaims(m, c) || playerClaims(c, Math.sqrt(dSq))) continue
      best = c
      bestSq = dSq
      bestPreferred = preferred
    }
    return best
  }

  /**
   * P4：挑一个对自己有用的已落地空投（弹药箱看弹药需求，医疗包看治疗需求）。
   * 跳过太远的、主控正要拿的、别的队友已认领的，以及 Boss 存活时离 Boss 太近的；取其中最近的一个。
   */
  function findCrate(m: Mate, needAmmo: boolean, needHeal: boolean): AirdropCrate | null {
    if (!needAmmo && !needHeal) return null
    const pos = m.actor.position
    const list = ctx.airdrops.crates
    const boss = ctx.boss
    const bossAlive = boss.active && boss.alive
    const bossMin = BOSS.sweep.radius + AIRDROP_BOSS_MARGIN
    let best: AirdropCrate | null = null
    let bestSq = AIRDROP_SEEK_RANGE * AIRDROP_SEEK_RANGE
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!c || !c.landed || c.id === m.skipCrateId) continue
      // 主武器箱只由 findWeaponCrate 处理，不当作弹药补给
      if (c.content.kind === 'weapon') continue
      if (!(c.content.kind === 'medkit' ? needHeal : needAmmo)) continue
      const dSq = distXZSq(pos, c.position)
      if (dSq >= bestSq) continue
      if (bossAlive && distXZSq(c.position, boss.position) < bossMin * bossMin) continue
      if (mateClaims(m, c) || playerClaims(c, Math.sqrt(dSq))) continue
      best = c
      bestSq = dSq
    }
    return best
  }

  function think(m: Mate): void {
    const a = m.actor
    const pos = a.position
    ensureUsableWeapon(m)

    m.threat = ctx.enemies.nearest(pos, m.def.engageRange)
    m.threatCount = ctx.enemies.countWithin(pos, AI_SHOOTING.threatRadius)
    assessThreat(m)
    pickTarget(m)
    refreshPost(m)

    const w = a.weapon
    const ratio = ammoRatio(w)
    if (w && ratio < LOW_AMMO_RATIO) {
      if (!m.lowAmmoVoiced) {
        m.lowAmmoVoiced = true
        events.emit('voice', { speaker: m.id, text: VOICE.lowAmmo[m.id] })
      }
    } else if (ratio >= AI_SHOOTING.airdropAmmoRatio) {
      // 补给之后重新武装这句台词
      m.lowAmmoVoiced = false
    }

    // 附近暂时没有威胁时主动换弹；弹匣快空时边退边换（后撤已拉开距离）
    if (w && m.reloadTimer <= 0 && m.channel === 'none' && w.reserve > 0) {
      const size = WEAPONS[w.id].magSize
      const frac = w.mag / size
      const calm = m.threatCount === 0 && frac < m.def.reloadThreshold
      const onRetreat = m.kiting && m.kiteGap > 0 && frac < m.def.reloadThreshold * 0.5
      if (w.mag < size && (calm || onRetreat)) startReload(m, w)
    }

    if (m.voicedRescue && m.voicedRescue.status !== 'downed') m.voicedRescue = null
    // 救援读条中不改主意（目标是否仍有效由执行层每帧检查）
    if (m.channel === 'rescue') return

    const rescue = findRescueTarget(m)
    if (rescue) {
      if (m.rescueTarget !== rescue) {
        endRescue(m)
        m.rescueTarget = rescue
        if (m.voicedRescue !== rescue) {
          m.voicedRescue = rescue
          events.emit('voice', { speaker: m.id, text: VOICE.rescuing[m.id] })
        }
      }
      setGoal(m, 'rescue')
      return
    }
    if (shouldEvacuate()) {
      setGoal(m, 'evac')
      return
    }
    // 开局手上还没有枪：先去开主武器箱；已有 1 把且周围暂时安全时再补第二把
    if (a.weapons.length === 0 || (a.weapons.length < PLAYER.maxWeapons && m.threat === null && !m.targetBoss)) {
      const crate = findWeaponCrate(m)
      if (crate) {
        setGoal(m, 'airdrop')
        m.crate = crate
        return
      }
    }
    // 紧急补给（弹药快打光或血量很低）：即使有战斗目标也先去拿，路上射击层照常开火
    const urgentAmmo = ratio < AMMO_URGENT_RATIO
    const urgentHeal = a.hp < HEAL_URGENT_HP
    if (urgentAmmo || urgentHeal) {
      const crate = findCrate(m, urgentAmmo, urgentHeal)
      if (crate) {
        setGoal(m, 'airdrop')
        m.crate = crate
        return
      }
    }
    const hasAmmo = w !== undefined && w.mag + w.reserve > 0
    if (hasAmmo && (m.target !== null || m.targetBoss)) {
      setGoal(m, 'combat')
      return
    }
    const crate = findCrate(m, ratio < AI_SHOOTING.airdropAmmoRatio, a.hp < HEAL_NEED_HP)
    if (crate) {
      setGoal(m, 'airdrop')
      m.crate = crate
      return
    }
    setGoal(m, 'follow')
  }

  /* ── 执行层：移动目标 ── */

  /** Boss 是否在场且存活（此时队友独立站位，不再跟随主控） */
  function bossFight(): boolean {
    return ctx.boss.active && ctx.boss.alive
  }

  /* ── 危险评估 ── */

  /**
   * 决策层：汇总 threatScan 内丧尸的加权压力（坦克远比普通丧尸危险，runner 更快）、
   * 远离加权中心的方向、8 个方位扇区的占用（判断被包围）与离最危险丧尸“后撤圈”的余量。
   */
  function assessThreat(m: Mate): void {
    const pos = m.actor.position
    const list = ctx.enemies.active
    const scan = TT.threatScan
    let sx = 0
    let sz = 0
    let total = 0
    let mask = 0
    let gap = Infinity
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e || !e.alive) continue
      const dx = e.position.x - pos.x
      const dz = e.position.z - pos.z
      const dSq = dx * dx + dz * dz
      if (dSq >= scan * scan) continue
      const d = Math.sqrt(dSq)
      const g = d - e.radius - TT.kiteStart[e.type]
      if (g < gap) gap = g
      if (d < 1e-3) continue
      const f = TT.threatWeight[e.type] * (1 - d / scan)
      total += f
      sx += (dx / d) * f
      sz += (dz / d) * f
      if (d < scan * 0.6) mask |= 1 << (Math.floor(((Math.atan2(dx, dz) + Math.PI) / (Math.PI * 2)) * 8) & 7)
    }
    let sectors = 0
    for (let k = 0; k < 8; k++) if (mask & (1 << k)) sectors++
    m.danger = total
    m.kiteGap = gap
    m.surrounded = sectors >= TT.surroundSectors
    const len = Math.hypot(sx, sz)
    m.escapeX = len > 1e-3 ? -sx / len : 0
    m.escapeZ = len > 1e-3 ? -sz / len : 0
  }

  /** (x, z) 周围 SPOT_THREAT_RADIUS 内丧尸的加权危险度 */
  function spotThreat(x: number, z: number): number {
    const list = ctx.enemies.active
    const r = SPOT_THREAT_RADIUS
    let total = 0
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e || !e.alive) continue
      const dx = e.position.x - x
      const dz = e.position.z - z
      const dSq = dx * dx + dz * dz
      if (dSq >= r * r) continue
      total += TT.threatWeight[e.type] * (1 - Math.sqrt(dSq) / r)
    }
    return total
  }

  /**
   * (x, z) 落进毒池（外扩 margin）的深度；不在任何毒池里返回 0。
   * 预警中的落点也算（提前躲开），flyingOnly 为 true 时只看还没落地的。
   */
  function poisonDepth(x: number, z: number, margin: number, flyingOnly: boolean): number {
    const boss = ctx.boss
    if (!boss.active) return 0
    const pools = boss.poisonPools
    const r = POOL_RADIUS + margin
    let depth = 0
    for (let i = 0; i < pools.length; i++) {
      const pl = pools[i]
      if (!pl || pl.status === POOL_FREE || (flyingOnly && pl.status !== POOL_FLYING)) continue
      const d = Math.hypot(x - pl.center.x, z - pl.center.z)
      if (d < r && r - d > depth) depth = r - d
    }
    return depth
  }

  /** Boss 存活时 (x, z) 进入 Boss 禁区的深度 */
  function bossDepth(x: number, z: number): number {
    if (!bossFight()) return 0
    const d = Math.hypot(x - ctx.boss.position.x, z - ctx.boss.position.z)
    return d < BOSS_KEEP_OUT ? BOSS_KEEP_OUT - d : 0
  }

  /** 沿单位方向 (dx, dz) 从 (x, z) 出发，最多走多远仍在活动范围内 */
  function boundsReach(x: number, z: number, dx: number, dz: number, max: number): number {
    const hx = PLAY_BOUNDS.halfX - BOUND_MARGIN
    const hz = PLAY_BOUNDS.halfZ - BOUND_MARGIN
    let t = max
    if (dx > 1e-6) t = Math.min(t, (hx - x) / dx)
    else if (dx < -1e-6) t = Math.min(t, (-hx - x) / dx)
    if (dz > 1e-6) t = Math.min(t, (hz - z) / dz)
    else if (dz < -1e-6) t = Math.min(t, (-hz - z) / dz)
    return Math.max(0, t)
  }

  /** 从自己位置沿 (dx, dz) 走 max 米：先被障碍挡、再被场地边界截断后的可达距离 */
  function reachAlong(m: Mate, dx: number, dz: number, max: number): number {
    const pos = m.actor.position
    const clear = nav ? nav.clearance(pos.x, pos.z, dx, dz, max, m.actor.radius, pos.y) : max
    return boundsReach(pos.x, pos.z, dx, dz, clear)
  }

  /* ── 主控视野锥 ── */

  /**
   * (x, z) 是否在主控视野锥内（主控前方 viewConeRange 内、半角 viewConeHalf、近处至少 viewConeMinWidth 宽）。
   * 在锥内时返回让开的一侧（1 右 / -1 左；几乎正对时取 side），否则返回 0。主控不是 alive 时恒为 0。
   */
  function viewSide(x: number, z: number, side: 1 | -1): number {
    const p = ctx.player.actor
    if (p.status !== 'alive') return 0
    const fx = Math.sin(ctx.player.yaw)
    const fz = Math.cos(ctx.player.yaw)
    const rx = x - p.position.x
    const rz = z - p.position.z
    const along = rx * fx + rz * fz
    if (along <= 0 || along > TT.viewConeRange) return 0
    // 右手方向 (-fz, fx)
    const lateral = -rx * fz + rz * fx
    const half = Math.max(TT.viewConeMinWidth, along * VIEW_TAN)
    if (Math.abs(lateral) >= half) return 0
    if (Math.abs(lateral) < 0.3) return side
    return lateral > 0 ? 1 : -1
  }

  /** 把落在视野锥内的点沿主控的左右方向横移到锥外；返回是否移动过 */
  function pushOutOfView(out: Vector3, side: 1 | -1): boolean {
    const s = viewSide(out.x, out.z, side)
    if (s === 0) return false
    const p = ctx.player.actor.position
    const fx = Math.sin(ctx.player.yaw)
    const fz = Math.cos(ctx.player.yaw)
    const rx = out.x - p.x
    const rz = out.z - p.z
    const along = rx * fx + rz * fz
    const lateral = -rx * fz + rz * fx
    const half = Math.max(TT.viewConeMinWidth, along * VIEW_TAN)
    const shift = s * (half + TT.viewConeExit) - lateral
    out.x += -fz * shift
    out.z += fx * shift
    return true
  }

  /**
   * 跟随 / 交战走位的后处理：移动目标不落在主控视野锥里；
   * 自己站在锥内超过 viewConeDelay（主控开火时立即）且原地不动时，横移出锥，不挡枪线。
   */
  function clearView(m: Mate, dt: number, want: boolean): boolean {
    if (m.kiting || (m.goal !== 'follow' && m.goal !== 'combat')) {
      m.viewTime = 0
      return want
    }
    if (pushOutOfView(m.dest, m.side)) clampDest(m)
    const pos = m.actor.position
    if (viewSide(pos.x, pos.z, m.side) === 0) {
      m.viewTime = 0
      return want
    }
    m.viewTime += dt
    if (want || (!ctx.player.firing && m.viewTime < TT.viewConeDelay)) return want
    m.dest.copy(pos)
    pushOutOfView(m.dest, m.side)
    clampDest(m)
    return true
  }

  /* ── 自主站位 ── */

  /** 决策层：站位过期或失效（离主控太远 / 太近、落入视野锥、变危险、有毒池）时重新挑选 */
  function refreshPost(m: Mate): void {
    if (bossFight()) {
      m.hasPost = false
      return
    }
    const p = ctx.player.actor
    // 主控已登机 / 阵亡：保留原站位
    if (p.status !== 'alive' && p.status !== 'downed') return
    if (!m.hasPost || m.postTimer <= 0) {
      choosePost(m)
      return
    }
    const def = m.def
    const d = Math.hypot(m.postX - p.position.x, m.postZ - p.position.z)
    if (
      d > def.postMax + POST_RANGE_SLACK ||
      d < def.postMin * 0.5 ||
      viewSide(m.postX, m.postZ, m.side) !== 0 ||
      spotThreat(m.postX, m.postZ) > POST_THREAT_LIMIT ||
      poisonDepth(m.postX, m.postZ, TT.poisonMargin, false) > 0
    ) {
      choosePost(m)
    }
  }

  /** 敌人加权中心，供掩体朝向评分（choosePost 内复用） */
  let enemyCx = 0
  let enemyCz = 0
  let enemyAny = false

  /** 站位评分：距离带、偏好方位、视野锥、掩体朝向、高处、危险度、毒池、与队友的间距、路程 */
  function scorePost(m: Mate, x: number, z: number, cover: boolean, nx: number, nz: number, high: boolean): number {
    const def = m.def
    const p = ctx.player.actor.position
    const dx = x - p.x
    const dz = z - p.z
    const d = Math.hypot(dx, dz)
    if (d < def.postMin * 0.6 || d > def.postMax + POST_RANGE_SLACK) return -Infinity
    const prefR = (def.postMin + def.postMax) / 2
    let s = -Math.abs(d - prefR) / prefR
    s -= Math.abs(wrapAngle(yawOf(dx, dz) - (ctx.player.yaw + def.postBearing))) * POST_BEARING_WEIGHT
    if (viewSide(x, z, m.side) !== 0) s -= POST_VIEW_PENALTY
    if (cover) {
      let facing = 0.5
      if (enemyAny) {
        const tx = enemyCx - x
        const tz = enemyCz - z
        const tl = Math.hypot(tx, tz)
        // 法线从掩体指向站位点：敌人在掩体那一侧时掩体才有用
        if (tl > 1e-3) facing = 0.5 + 0.5 * Math.max(0, -(nx * tx + nz * tz) / tl)
      }
      s += POST_COVER_BONUS * facing
    }
    if (high) s += POST_HIGH_BONUS
    s -= spotThreat(x, z) * POST_THREAT_WEIGHT
    if (poisonDepth(x, z, TT.poisonMargin, false) > 0) s -= POST_VIEW_PENALTY
    for (let i = 0; i < mates.length; i++) {
      const o = mates[i]
      if (!o || o === m || o.gone || o.actor.status !== 'alive') continue
      const ox = o.hasPost ? o.postX : o.actor.position.x
      const oz = o.hasPost ? o.postZ : o.actor.position.z
      const dd = Math.hypot(x - ox, z - oz)
      if (dd < TT.postSpacing) s -= (1 - dd / TT.postSpacing) * POST_SPACING_WEIGHT
    }
    s -= (Math.hypot(x - m.actor.position.x, z - m.actor.position.z) / POST_TRAVEL_SCALE) * POST_TRAVEL_WEIGHT
    return s
  }

  /**
   * 挑一个自主站位：候选为偏好方位附近的几个空地点 + 场地里预先算好的掩体 / 高处 / 网格点。
   * 当前站位额外加 postSwitchMargin，新点要明显更好才换（滞回，避免来回抖）。
   */
  function choosePost(m: Mate): void {
    m.postTimer = rng.range(TT.postIntervalMin, TT.postIntervalMax)
    const def = m.def
    const p = ctx.player.actor.position

    enemyCx = 0
    enemyCz = 0
    let wSum = 0
    const list = ctx.enemies.active
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e || !e.alive) continue
      const w = TT.threatWeight[e.type]
      enemyCx += e.position.x * w
      enemyCz += e.position.z * w
      wSum += w
    }
    enemyAny = wSum > 0
    if (enemyAny) {
      enemyCx /= wSum
      enemyCz /= wSum
    }

    let best = -Infinity
    let bestX = 0
    let bestZ = 0
    if (m.hasPost) {
      best = scorePost(m, m.postX, m.postZ, false, 0, 0, false) + TT.postSwitchMargin
      bestX = m.postX
      bestZ = m.postZ
    }
    // 偏好方位上的空地点（一定有候选，保证站位总能选出来）
    const prefR = (def.postMin + def.postMax) / 2
    const bearing = ctx.player.yaw + def.postBearing
    const hx = PLAY_BOUNDS.halfX - BOUND_MARGIN
    const hz = PLAY_BOUNDS.halfZ - BOUND_MARGIN
    for (let k = -2; k <= 2; k++) {
      const t = bearing + k * POST_FAN_STEP
      const x = clamp(p.x + Math.sin(t) * prefR, -hx, hx)
      const z = clamp(p.z + Math.cos(t) * prefR, -hz, hz)
      if (nav && nav.blocked(x, z, m.actor.radius + 0.2, 0)) continue
      const s = scorePost(m, x, z, false, 0, 0, false)
      if (s > best) {
        best = s
        bestX = x
        bestZ = z
      }
    }
    if (nav) {
      const maxR = def.postMax + POST_RANGE_SLACK
      const spots = nav.spots
      for (let i = 0; i < spots.length; i++) {
        const sp = spots[i]
        if (!sp || Math.abs(sp.x - p.x) > maxR || Math.abs(sp.z - p.z) > maxR) continue
        const s = scorePost(m, sp.x, sp.z, sp.cover, sp.nx, sp.nz, sp.high)
        if (s > best) {
          best = s
          bestX = sp.x
          bestZ = sp.z
        }
      }
    }
    if (best === -Infinity) {
      // 全部不合格（主控贴着场边等）：退回固定槽位
      writeSlot(def, p.x, p.z, ctx.player.yaw, vTmp)
      bestX = vTmp.x
      bestZ = vTmp.z
    }
    m.postX = bestX
    m.postZ = bestZ
    m.hasPost = true
  }

  /**
   * P5：走到自主站位。离站位超过 postArrive × postDepart（或离主控超过 startDist 与站位上限）才出发，到站位附近停下。
   * Boss 存活时改为各自绕 Boss 站位，不回到主控身边。
   */
  function planFollow(m: Mate, startDist: number): boolean {
    if (bossFight()) return planBoss(m)
    const pos = m.actor.position
    const p = ctx.player.actor.position
    if (!m.hasPost) choosePost(m)
    m.dest.set(m.postX, 0, m.postZ)
    clampDest(m)
    const dSq = distXZSq(pos, m.dest)
    const arrive = TT.postArrive
    const depart = arrive * TT.postDepart
    const far = Math.max(startDist, m.def.postMax + POST_RANGE_SLACK)
    if (m.moving) {
      if (dSq < arrive * arrive) m.moving = false
    } else if (dSq > depart * depart || distXZSq(pos, p) > far * far) {
      m.moving = true
    }
    return m.moving
  }

  /**
   * 后撤（边打边退）：最危险的丧尸进入按种类的后撤圈、威胁压力过大、被包围、
   * 换弹 / 没子弹时有丧尸靠近，或离 Boss 太近时生效。生效时写 dest 并返回 true。
   */
  function planAvoid(m: Mate): boolean {
    const pos = m.actor.position
    const margin = m.kiting ? TT.kiteStopMargin : 0
    let active = false
    // 最近的丧尸每帧都看（跟得上冲过来的 runner），其余用决策层的威胁场
    const t = m.threat
    if (t && t.alive && distXZ(pos, t.position) - t.radius < TT.kiteStart[t.type] + margin) active = true
    if (m.kiteGap < margin) active = true
    if (m.danger > (m.kiting ? TT.pressureKite * 0.6 : TT.pressureKite)) active = true
    if (m.surrounded) active = true
    const w = m.actor.weapon
    if (
      w &&
      t &&
      t.alive &&
      (m.reloadTimer > 0 || w.mag <= WEAPONS[w.id].magSize * RETREAT_MAG_RATIO) &&
      distXZSq(pos, t.position) < TT.reloadRetreatRange * TT.reloadRetreatRange
    ) {
      active = true
    }
    let bx = 0
    let bz = 0
    if (bossFight()) {
      const dx = pos.x - ctx.boss.position.x
      const dz = pos.z - ctx.boss.position.z
      const d = Math.hypot(dx, dz)
      if (d < (m.kiting ? BOSS_KEEP_OUT + BOSS_CLOSE_MARGIN : BOSS_KEEP_OUT)) {
        active = true
        if (d > 1e-4) {
          bx = dx / d
          bz = dz / d
        }
      }
    }
    if (!active) {
      m.kiting = false
      return false
    }
    const fresh = !m.kiting
    m.kiting = true
    if (fresh || m.escapeTimer <= 0 || Math.hypot(m.avoidX - pos.x, m.avoidZ - pos.z) < ARRIVE) {
      m.escapeTimer = TT.escapeInterval
      chooseEscape(m, bx, bz, fresh)
    }
    m.dest.set(m.avoidX, pos.y, m.avoidZ)
    clampDest(m)
    return true
  }

  /**
   * 选后撤点：一圈 ESCAPE_DIRS 个方向，按“远离威胁加权中心 / Boss、开阔（能走得远）、
   * 落点与途中的危险度、毒池、回拢站位、与上次方向一致”打分。
   */
  function chooseEscape(m: Mate, bx: number, bz: number, fresh: boolean): void {
    const pos = m.actor.position
    const ex = m.escapeX + bx * 1.5
    const ez = m.escapeZ + bz * 1.5
    let gx = 0
    let gz = 0
    if (!bossFight() && m.hasPost) {
      gx = m.postX - pos.x
      gz = m.postZ - pos.z
      const gl = Math.hypot(gx, gz)
      if (gl > 1) {
        gx /= gl
        gz /= gl
      } else {
        gx = 0
        gz = 0
      }
    }
    let px = 0
    let pz = 0
    if (!fresh) {
      px = m.avoidX - pos.x
      pz = m.avoidZ - pos.z
      const pl = Math.hypot(px, pz)
      if (pl > 0.5) {
        px /= pl
        pz /= pl
      } else {
        px = 0
        pz = 0
      }
    }
    const step = m.surrounded ? KITE_STEP_SURROUNDED : KITE_STEP
    let best = -Infinity
    let bestX = pos.x + ex * step
    let bestZ = pos.z + ez * step
    for (let k = 0; k < ESCAPE_DIRS; k++) {
      const ang = (k / ESCAPE_DIRS) * Math.PI * 2
      const dx = Math.sin(ang)
      const dz = Math.cos(ang)
      const reach = Math.max(0.5, reachAlong(m, dx, dz, step) - 0.3)
      const x = pos.x + dx * reach
      const z = pos.z + dz * reach
      let s = 1.4 * (dx * ex + dz * ez) + 0.8 * (reach / step)
      s += KITE_REGROUP_BIAS * (dx * gx + dz * gz) + 0.3 * (dx * px + dz * pz)
      if (reach < 1.5) s -= 2
      s -= spotThreat(x, z) * 1.2
      s -= spotThreat(pos.x + dx * reach * 0.5, pos.z + dz * reach * 0.5) * 0.8
      s -= poisonDepth(x, z, TT.poisonMargin, false) * 2
      s -= bossDepth(x, z) * 0.5
      if (s > best) {
        best = s
        bestX = x
        bestZ = z
      }
    }
    m.avoidX = bestX
    m.avoidZ = bestZ
  }

  /**
   * 主动躲毒池：站在毒池（含预警中的落点，外扩 poisonMargin）里时，挑一个离开毒池、不进 Boss 禁区的方向走出去。
   * flyingOnly 为 true（救援中）时只躲还没落地的。接管移动时写 dest 与 m.dodgeMove 并返回 true。
   */
  function planPoison(m: Mate, flyingOnly: boolean): boolean {
    const pos = m.actor.position
    if (poisonDepth(pos.x, pos.z, TT.poisonMargin, flyingOnly) <= 0) return false
    const pools = ctx.boss.poisonPools
    let ax = 0
    let az = 0
    for (let i = 0; i < pools.length; i++) {
      const pl = pools[i]
      if (!pl || pl.status === POOL_FREE) continue
      const dx = pos.x - pl.center.x
      const dz = pos.z - pl.center.z
      const d = Math.hypot(dx, dz)
      const r = POOL_RADIUS + TT.poisonMargin
      if (d >= r) continue
      if (d > 1e-3) {
        ax += (dx / d) * (r - d)
        az += (dz / d) * (r - d)
      } else {
        ax += m.side
      }
    }
    const al = Math.hypot(ax, az)
    if (al > 1e-4) {
      ax /= al
      az /= al
    }
    const step = POOL_RADIUS * 2 + TT.poisonMargin
    let best = -Infinity
    let bestX = pos.x
    let bestZ = pos.z
    for (let k = 0; k < POISON_DIRS; k++) {
      const ang = (k / POISON_DIRS) * Math.PI * 2
      const dx = Math.sin(ang)
      const dz = Math.cos(ang)
      const reach = reachAlong(m, dx, dz, step)
      const x = pos.x + dx * reach
      const z = pos.z + dz * reach
      let s = dx * ax + dz * az + reach / step
      s -= poisonDepth(x, z, TT.poisonMargin, false) * 3
      s -= bossDepth(x, z)
      s -= spotThreat(x, z) * 0.5
      if (s > best) {
        best = s
        bestX = x
        bestZ = z
      }
    }
    m.dest.set(bestX, 0, bestZ)
    clampDest(m)
    m.dodgeMove = distXZSq(pos, m.dest) > BOSS_DODGE_ARRIVE * BOSS_DODGE_ARRIVE
    return true
  }

  /** 把落进毒池（含预警中的落点）的移动目标沿径向推到池外 */
  function keepOutOfPools(m: Mate): void {
    const boss = ctx.boss
    if (!boss.active) return
    const pools = boss.poisonPools
    const r = POOL_RADIUS + TT.poisonMargin
    const d0 = m.dest
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < pools.length; i++) {
        const pl = pools[i]
        if (!pl || pl.status === POOL_FREE) continue
        const dx = d0.x - pl.center.x
        const dz = d0.z - pl.center.z
        const d = Math.hypot(dx, dz)
        if (d >= r) continue
        if (d < 1e-3) {
          d0.x = pl.center.x + r * m.side
        } else {
          d0.x = pl.center.x + (dx / d) * (r + 0.3)
          d0.z = pl.center.z + (dz / d) * (r + 0.3)
        }
      }
    }
    clampDest(m)
  }

  /** 自己相对 Boss 的方位角；与 Boss 重合时按编号取一个固定角度 */
  function bossBearing(m: Mate): number {
    const pos = m.actor.position
    const bp = ctx.boss.position
    const dx = pos.x - bp.x
    const dz = pos.z - bp.z
    return dx * dx + dz * dz > 1e-6 ? yawOf(dx, dz) : m.index * 2.1 + 0.5
  }

  /** 方位角 theta 与 at 相对 Boss 的方位相差不到 gap 时，绕 Boss 转开到恰好 gap */
  function pushBearing(theta: number, at: Vector3, gap: number, side: 1 | -1): number {
    const bp = ctx.boss.position
    const dx = at.x - bp.x
    const dz = at.z - bp.z
    if (dx * dx + dz * dz < 1) return theta
    const other = yawOf(dx, dz)
    const diff = wrapAngle(theta - other)
    if (Math.abs(diff) >= gap) return theta
    const sign = Math.abs(diff) < 1e-3 ? side : diff > 0 ? 1 : -1
    return wrapAngle(other + sign * gap)
  }

  /** 让自己的方位与主控、其他队友错开（跑两遍，减少推开一个又撞上另一个） */
  function spreadBearing(m: Mate, theta: number): number {
    const p = ctx.player.actor
    for (let pass = 0; pass < 2; pass++) {
      if (p.status === 'alive' || p.status === 'downed') theta = pushBearing(theta, p.position, BOSS_PLAYER_GAP, m.side)
      for (let i = 0; i < mates.length; i++) {
        const o = mates[i]
        if (!o || o === m || o.gone || o.actor.status !== 'alive') continue
        theta = pushBearing(theta, o.actor.position, BOSS_MATE_GAP, m.side)
      }
    }
    return theta
  }

  /**
   * 把 Boss 周围半径 r、方位 theta 的点写入 dest 并限制在场地内。
   * 截断后离 Boss 不足 minR 时沿圆周两侧轮流换角度；都不满足就取离 Boss 最远的一个。
   */
  function writeRing(m: Mate, theta: number, r: number, minR: number): void {
    const bp = ctx.boss.position
    let bestSq = -1
    let bestX = 0
    let bestZ = 0
    for (let k = 0; k < BOSS_RING_TRIES; k++) {
      const n = (k + 1) >> 1
      const t = theta + (k % 2 === 1 ? n : -n) * BOSS_RING_STEP * m.side
      m.dest.set(bp.x + Math.sin(t) * r, 0, bp.z + Math.cos(t) * r)
      clampDest(m)
      const dSq = distXZSq(m.dest, bp)
      if (dSq >= minR * minR) return
      if (dSq > bestSq) {
        bestSq = dSq
        bestX = m.dest.x
        bestZ = m.dest.z
      }
    }
    m.dest.x = bestX
    m.dest.z = bestZ
  }

  /** Boss 存活时把落在 Boss 周围 minR 内的移动目标沿径向推到圈外 */
  function keepOutOfBoss(m: Mate, minR: number): void {
    const bp = ctx.boss.position
    const dx = m.dest.x - bp.x
    const dz = m.dest.z - bp.z
    const dSq = dx * dx + dz * dz
    if (dSq >= minR * minR) return
    const theta = dSq > 1e-6 ? yawOf(dx, dz) : bossBearing(m)
    writeRing(m, theta, minR + BOSS_KEEP_OUT_PAD, minR)
  }

  /**
   * Boss 战站位：以“Boss → 自己”的方位为基准保持 bossRange 的距离，
   * 方位上与主控、其他队友错开，不站在主控与 Boss 的连线上。
   */
  function planBoss(m: Mate): boolean {
    const pos = m.actor.position
    const range = m.bossRange
    const theta = spreadBearing(m, bossBearing(m))
    writeRing(m, theta, range, Math.max(BOSS_KEEP_OUT + BOSS_KEEP_OUT_PAD, range - BOSS_RING_SLACK))

    // 预警期间用更小的滞回，保证动起来
    const warned = ctx.boss.warning !== ''
    const arrive = warned ? BOSS_DODGE_ARRIVE : ARRIVE
    const dSq = distXZSq(pos, m.dest)
    if (m.moving) {
      if (dSq < arrive * arrive) m.moving = false
    } else if (dSq > (warned ? arrive * 2 : BOSS_REPOSITION) ** 2) {
      m.moving = true
    }
    return m.moving
  }

  /** 以 Boss 为圆心沿圆周切向横移 BOSS_SIDESTEP，持续 time 秒；朝一侧被场地挡住时换另一侧 */
  function startSidestep(m: Mate, time: number): void {
    const pos = m.actor.position
    const bp = ctx.boss.position
    const theta = bossBearing(m)
    const r = Math.max(distXZ(pos, bp), BOSS_KEEP_OUT + BOSS_KEEP_OUT_PAD)
    const step = BOSS_SIDESTEP / r
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? m.dodgeSign : -m.dodgeSign
      const t = theta + step * sign
      m.dest.set(bp.x + Math.sin(t) * r, 0, bp.z + Math.cos(t) * r)
      clampDest(m)
      if (distXZSq(m.dest, pos) >= BOSS_SIDESTEP * BOSS_SIDESTEP * 0.25) break
    }
    m.dodgeX = m.dest.x
    m.dodgeZ = m.dest.z
    m.dodgeTimer = time
    m.dodgeSign = m.dodgeSign === 1 ? -1 : 1
  }

  /**
   * 读 Boss 预警做躲避。接管移动时写 dest 与 m.dodgeMove 并返回 true。
   * full 为 false（救援中）时只躲冲击波、横扫与还没落地的毒池，不做突刺 / 毒液的横移。
   */
  function planBossDodge(m: Mate, full: boolean): boolean {
    const pos = m.actor.position
    const warn = ctx.boss.warning
    const fresh = warn !== m.lastWarning
    m.lastWarning = warn

    let escape = 0
    if (warn === BOSS_WARNING.shock) escape = BOSS.shockwave.radius + BOSS_SHOCK_ESCAPE
    else if (warn === BOSS_WARNING.sweep) escape = BOSS.sweep.radius + BOSS_SWEEP_ESCAPE
    if (escape > 0) {
      if (distXZSq(pos, ctx.boss.position) < escape * escape) {
        // 径向往外跑
        writeRing(m, bossBearing(m), escape + BOSS_KEEP_OUT_PAD, escape)
        m.dodgeMove = distXZSq(pos, m.dest) > BOSS_DODGE_ARRIVE * BOSS_DODGE_ARRIVE
        return true
      }
    }
    // 毒池（含预警中的落点）：提前走出去，不等挨了伤害才躲
    if (planPoison(m, !full)) return true
    if (escape > 0) {
      if (full && warn === BOSS_WARNING.shock) {
        // 已在冲击波范围外：原地等它放完，别被站位或补给拉回圈内（救援由 plan 里的禁区半径兜住）
        m.dodgeMove = false
        return true
      }
    }
    if (!full) return false

    if (fresh && (warn === BOSS_WARNING.stab || warn === BOSS_WARNING.spit)) startSidestep(m, BOSS_SIDESTEP_TIME)
    if (m.dodgeTimer <= 0) return false
    m.dest.set(m.dodgeX, 0, m.dodgeZ)
    clampDest(m)
    if (distXZSq(pos, m.dest) < BOSS_DODGE_ARRIVE * BOSS_DODGE_ARRIVE) {
      // 已横移到位，交还给正常走位
      m.dodgeTimer = 0
      return false
    }
    m.dodgeMove = true
    return true
  }

  /** P3：按角色风格走位 */
  function planCombat(m: Mate): boolean {
    const pos = m.actor.position
    const p = ctx.player.actor

    const boss = bossFight()
    // 追得太远（超过各自的 leash）就先回站位（射击层照常工作）；回到 leash 的 0.6 倍内才重新自由走位。
    // Boss 存活时不拉回主控
    if (boss) {
      m.leashed = false
    } else if (p.status === 'alive' || p.status === 'downed') {
      const dSq = distXZSq(pos, p.position)
      const leash = m.def.leash
      if (dSq > leash * leash) m.leashed = true
      else if (dSq < leash * leash * LEASH_RELEASE * LEASH_RELEASE) m.leashed = false
      if (m.leashed) {
        m.moving = true
        return planFollow(m, AI_SHOOTING.followMax)
      }
    }

    const e = m.target
    if (!e) return m.targetBoss ? planBoss(m) : planFollow(m, AI_SHOOTING.followMax)

    if (m.def.style === 'aggressive') {
      // 激进前压：目标远于 ADVANCE_FAR 时推进到离目标 ADVANCE_STANDOFF 的位置（不贴脸），
      // 推进点限制在离主控 leash 以内
      const d = distXZ(pos, e.position)
      if (m.moving) {
        if (d <= (ADVANCE_NEAR + ADVANCE_FAR) / 2) m.moving = false
      } else if (d > ADVANCE_FAR) {
        m.moving = true
      }
      if (!m.moving) return false
      const ox = pos.x - e.position.x
      const oz = pos.z - e.position.z
      const ol = Math.hypot(ox, oz)
      if (ol < 1e-3) return false
      m.dest.set(e.position.x + (ox / ol) * ADVANCE_STANDOFF, pos.y, e.position.z + (oz / ol) * ADVANCE_STANDOFF)
      if (p.status === 'alive' || p.status === 'downed') {
        const lx = m.dest.x - p.position.x
        const lz = m.dest.z - p.position.z
        const ll = Math.hypot(lx, lz)
        const limit = m.def.leash * LEASH_RELEASE
        if (ll > limit) {
          m.dest.x = p.position.x + (lx / ll) * limit
          m.dest.z = p.position.z + (lz / ll) * limit
        }
      }
      clampDest(m)
      return true
    }

    if (m.def.style === 'flank') {
      // Boss 存活时侧翼位以主控为基准会把人带回主控身边：改为守住自己的 Boss 站位开火
      if (boss) return planBoss(m)
      // 侧翼：站到“主控 → 敌人”连线的一侧，拉开射击角度
      let fx = e.position.x - p.position.x
      let fz = e.position.z - p.position.z
      let len = Math.hypot(fx, fz)
      if (len < 1) {
        fx = e.position.x - pos.x
        fz = e.position.z - pos.z
        len = Math.hypot(fx, fz)
      }
      if (len < 1e-3) return false
      fx /= len
      fz /= len
      const advance = Math.min(FLANK_ADVANCE, len * 0.5)
      const lateral = FLANK_OFFSET * m.side
      m.dest.set(
        p.position.x + fx * advance - fz * lateral,
        pos.y,
        p.position.z + fz * advance + fx * lateral,
      )
      clampDest(m)
      const dSq = distXZSq(pos, m.dest)
      if (m.moving) {
        if (dSq < ARRIVE * ARRIVE) m.moving = false
      } else if (dSq > FLANK_REPOSITION * FLANK_REPOSITION) {
        m.moving = true
      }
      return m.moving
    }

    // 支援：守在主控身后附近的自主站位，在中距离射击
    return planFollow(m, (AI_SHOOTING.followMin + AI_SHOOTING.followMax) / 2)
  }

  /** P2：跑到倒地成员身边读条救起 */
  function planRescue(m: Mate, dt: number): boolean {
    const a = m.actor
    const t = m.rescueTarget
    if (!t || t.status !== 'downed' || (t.rescuer !== null && t.rescuer !== m.id)) {
      setGoal(m, 'follow')
      m.thinkTimer = 0
      return planFollow(m, AI_SHOOTING.followMax)
    }
    const d = distXZ(a.position, t.position)

    if (m.channel === 'rescue') {
      if (a.damageSerial !== m.channelSerial || d > INTERACT.rescueRange + RESCUE_CHANNEL_SLACK) {
        // 受伤或目标离开范围：打断，下面重新靠近 / 重新读条
        interruptChannel(m)
      } else {
        m.channelTime += dt
        if (m.channelTime >= INTERACT.rescueTime) {
          t.revive()
          playSfx('revive', t.position, 1, 1)
          setGoal(m, 'follow')
          m.thinkTimer = 0
        }
        return false
      }
    }

    if (d < INTERACT.rescueRange - RESCUE_APPROACH_MARGIN) {
      m.channel = 'rescue'
      m.channelTime = 0
      m.channelSerial = a.damageSerial
      t.rescuer = m.id
      return false
    }
    m.dest.copy(t.position)
    clampDest(m)
    return true
  }

  /** P4：走到空投 / 主武器箱旁拾取 */
  function planAirdrop(m: Mate): boolean {
    const a = m.actor
    const crate = m.crate
    if (!crate || !crate.landed || ctx.airdrops.crates.indexOf(crate) < 0) {
      setGoal(m, 'follow')
      m.thinkTimer = 0
      return planFollow(m, AI_SHOOTING.followMax)
    }
    if (distXZ(a.position, crate.position) < INTERACT.airdropRange) {
      const result = ctx.airdrops.pickup(crate, a)
      // 拿不到（主控要选替换 / 开箱次数已用完）：记下这个箱子，不再反复试
      if (result === 'needsChoice' || result === 'blocked') {
        m.skipCrateId = crate.id
      } else {
        m.reloadTimer = 0
        selectBestWeapon(m)
      }
      setGoal(m, 'follow')
      m.thinkTimer = 0
      return false
    }
    m.dest.copy(crate.position)
    clampDest(m)
    return true
  }

  /**
   * 撤离：跑到舱门口，进入登机范围且到达舱门（或在范围内被挡住走不动）后登机，
   * 登机后由 leave() 把模型从舱门挪进分到的座位坐下
   */
  function planEvac(m: Mate, dt: number): boolean {
    const a = m.actor
    const evac = ctx.evac
    if (evac.heliState !== 'landed') {
      setGoal(m, 'follow')
      m.thinkTimer = 0
      return planFollow(m, AI_SHOOTING.followMax)
    }
    evac.doorWorld(m.dest)
    const atDoor = distXZSq(a.position, m.dest) < ARRIVE * ARRIVE
    if (evac.canBoard(a) && (atDoor || m.channel === 'board')) {
      if (m.channel !== 'board') {
        m.channel = 'board'
        m.channelTime = 0
      }
      m.channelTime += dt
      if (m.channelTime >= INTERACT.boardTime) {
        evac.board(a)
        m.channel = 'none'
        m.channelTime = 0
      }
      return false
    }
    if (m.channel === 'board') {
      m.channel = 'none'
      m.channelTime = 0
    }
    // 已到舱门却仍不能登机（座位已满）：在舱门口站定
    return !atDoor
  }

  /** P1：倒地后爬向最近的存活成员；有人在救自己时不动 */
  function planCrawl(m: Mate): boolean {
    const a = m.actor
    if (a.rescuer !== null) return false
    const list = ctx.combatants
    let best: Combatant | null = null
    let bestSq = Infinity
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!c || c === a || c.status !== 'alive') continue
      const dSq = distXZSq(a.position, c.position)
      if (dSq < bestSq) {
        best = c
        bestSq = dSq
      }
    }
    if (!best || bestSq < CRAWL_STOP * CRAWL_STOP) return false
    m.dest.copy(best.position)
    return true
  }

  function planGoal(m: Mate, dt: number): boolean {
    switch (m.goal) {
      case 'rescue':
        return planRescue(m, dt)
      case 'evac':
        return planEvac(m, dt)
      case 'airdrop':
        return planAirdrop(m)
      case 'combat':
        return planAvoid(m) || planCombat(m)
      default:
        return planAvoid(m) || planFollow(m, AI_SHOOTING.followMax)
    }
  }

  /**
   * 按当前意图算出移动目标；返回本帧是否移动。
   * Boss 存活时（撤离除外）先看预警与毒池躲避，再把移动目标限制在 Boss 禁区与毒池外。
   */
  function plan(m: Mate, dt: number): boolean {
    if (m.goal === 'evac') return planGoal(m, dt)
    // 没有 Boss 时：跟随 / 交战的走位不挡主控视野与枪线
    if (!bossFight()) return clearView(m, dt, planGoal(m, dt))
    const rescuing = m.goal === 'rescue'
    if (planBossDodge(m, !rescuing)) {
      // 躲避优先：救援读条被打断，躲完再重新读条
      interruptChannel(m)
      return m.dodgeMove
    }
    const want = planGoal(m, dt)
    keepOutOfBoss(m, m.goal === 'rescue' ? rescueKeepOut() : BOSS_KEEP_OUT)
    // 救援目标就在毒池里时仍要过去，其余意图的落点不放进毒池
    if (!rescuing) keepOutOfPools(m)
    return want
  }

  /** 救援时离 Boss 的最小距离：平时可贴近到身体半径 + 1.5m，冲击波 / 横扫预警期间不进入其范围 */
  function rescueKeepOut(): number {
    const warn = ctx.boss.warning
    if (warn === BOSS_WARNING.shock) return BOSS.shockwave.radius + BOSS_SHOCK_ESCAPE
    if (warn === BOSS_WARNING.sweep) return BOSS.sweep.radius + BOSS_SWEEP_ESCAPE
    return ctx.boss.radius + BOSS_RESCUE_CLEARANCE
  }

  /* ── 执行层：移动 ── */

  /** 与其他小队成员保持最小间距 */
  function separate(m: Mate): void {
    const pos = m.actor.position
    const list = ctx.combatants
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (!o || o === m.actor) continue
      if (o.status !== 'alive' && o.status !== 'downed') continue
      const dx = pos.x - o.position.x
      const dz = pos.z - o.position.z
      const dSq = dx * dx + dz * dz
      if (dSq >= SEPARATION * SEPARATION) continue
      const d = Math.sqrt(dSq)
      let nx: number
      let nz: number
      if (d < 1e-4) {
        // 完全重合：按编号取一个固定方向分开
        const angle = m.index * 2.1 + 0.5
        nx = Math.sin(angle)
        nz = Math.cos(angle)
      } else {
        nx = dx / d
        nz = dz / d
      }
      // 队友之间各让一半；主控与倒地者不会让，自己让全部
      const share = o.isPlayer || o.status === 'downed' ? 1 : 0.5
      const push = (SEPARATION - d) * share
      pos.x += nx * push
      pos.z += nz * push
    }
  }

  /** Boss 存活时不能进入它的身体半径 */
  function pushOutOfBoss(m: Mate): void {
    const boss = ctx.boss
    if (!boss.active || !boss.alive) return
    const pos = m.actor.position
    const dx = pos.x - boss.position.x
    const dz = pos.z - boss.position.z
    const min = boss.radius + m.actor.radius
    const dSq = dx * dx + dz * dz
    if (dSq >= min * min) return
    const d = Math.sqrt(dSq)
    if (d < 1e-4) {
      pos.z = boss.position.z + min
      return
    }
    pos.x = boss.position.x + (dx / d) * min
    pos.z = boss.position.z + (dz / d) * min
  }

  /**
   * 积分一帧位移：避障转向 + 击退 + 分离 + 碰撞 + 贴地，并写入 velocity。
   * @param upright 是否站立（倒地爬行时不做分离与 Boss 推开）
   */
  /**
   * 朝 (dx, dz) 走时，前方 crowdRadius 内其他成员身体的拥挤代价（主控权重更高）。
   * 就站在目标点 (tx, tz) 旁边的人（救援对象、爬向的队友）不算。
   */
  function crowdCost(m: Mate, dx: number, dz: number, tx: number, tz: number): number {
    const pos = m.actor.position
    const list = ctx.combatants
    const r = TT.crowdRadius
    let cost = 0
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (!o || o === m.actor) continue
      if (o.status !== 'alive' && o.status !== 'downed') continue
      const ox = o.position.x - pos.x
      const oz = o.position.z - pos.z
      const dSq = ox * ox + oz * oz
      if (dSq >= r * r || dSq < 1e-6) continue
      const gx = o.position.x - tx
      const gz = o.position.z - tz
      if (gx * gx + gz * gz < CROWD_GOAL_SKIP * CROWD_GOAL_SKIP) continue
      const d = Math.sqrt(dSq)
      const ahead = (ox * dx + oz * dz) / d
      if (ahead <= CROWD_AHEAD) continue
      cost += (1 - d / r) * ahead * (o.isPlayer ? CROWD_PLAYER : CROWD_MATE)
    }
    return cost
  }

  /**
   * 避障选方向：前方 steerLook 内畅通且不挤人时直接朝目标走（之后每帧直接对准目标）；
   * 否则在目标方向两侧各采样若干方向，再加上 world.steer 的绕角建议，
   * 按“对准目标、开阔、贴近绕角建议、与上次方向一致、不挤人、不朝威胁中心走、不横穿开火中的主控视野”打分。
   */
  function chooseSteer(m: Mate, tx: number, tz: number, dist: number, upright: boolean): void {
    const pos = m.actor.position
    const gx = (tx - pos.x) / dist
    const gz = (tz - pos.z) / dist
    const look = Math.min(dist, TT.steerLook)
    const r = m.actor.radius
    const feet = pos.y
    const clear0 = nav ? nav.clearance(pos.x, pos.z, gx, gz, look, r, feet) : look
    const crowd0 = upright ? crowdCost(m, gx, gz, tx, tz) : 0
    if (clear0 >= look - 1e-3 && crowd0 < CROWD_DIRECT) {
      m.steerDirect = true
      m.steerX = gx
      m.steerZ = gz
      return
    }
    m.steerDirect = false

    vTmp.set(tx, feet, tz)
    ctx.world.steer(pos, vTmp, r, vDir)
    const sx = vDir.x
    const sz = vDir.z
    const base = Math.atan2(gx, gz)
    const n = TT.steerRays
    const stepAng = STEER_SPREAD / Math.max(1, (n - 1) >> 1)
    const threatW = m.goal === 'rescue' || m.goal === 'evac' ? 0 : Math.min(1, m.danger / TT.pressureKite)
    const lof = upright && ctx.player.firing && (m.goal === 'follow' || m.goal === 'combat')
    let best = -Infinity
    let bx = sx
    let bz = sz
    for (let k = 0; k <= n; k++) {
      let dx: number
      let dz: number
      let clear: number
      if (k < n) {
        const offset = ((k + 1) >> 1) * (k % 2 === 1 ? 1 : -1) * stepAng
        dx = Math.sin(base + offset)
        dz = Math.cos(base + offset)
        clear = k === 0 ? clear0 : nav ? nav.clearance(pos.x, pos.z, dx, dz, look, r, feet) : look
      } else {
        // 最后一个候选：world.steer 的绕角方向
        if (Math.abs(sx) + Math.abs(sz) < 1e-4) continue
        dx = sx
        dz = sz
        clear = nav ? nav.clearance(pos.x, pos.z, dx, dz, look, r, feet) : look
      }
      let s = dx * gx + dz * gz + STEER_CLEAR_WEIGHT * (clear / look)
      s += STEER_HINT_WEIGHT * (dx * sx + dz * sz) + STEER_KEEP_WEIGHT * (dx * m.steerX + dz * m.steerZ)
      if (clear < STEER_MIN_CLEAR) s -= 5
      if (upright) s -= k === 0 ? crowd0 : crowdCost(m, dx, dz, tx, tz)
      if (threatW > 0) s -= threatW * Math.max(0, -(dx * m.escapeX + dz * m.escapeZ)) * STEER_THREAT_WEIGHT
      if (lof && viewSide(pos.x + dx * STEER_LOF_PROBE, pos.z + dz * STEER_LOF_PROBE, m.side) !== 0) s -= STEER_LOF_PENALTY
      if (s > best) {
        best = s
        bx = dx
        bz = dz
      }
    }
    m.steerX = bx
    m.steerZ = bz
  }

  /** 卡住后挑一个绕行点：开阔、大致朝目标、尽量不再走刚才撞上的方向；两侧交替偏好 */
  function startDetour(m: Mate): void {
    const pos = m.actor.position
    let gx = m.dest.x - pos.x
    let gz = m.dest.z - pos.z
    const gl = Math.hypot(gx, gz)
    if (gl > 1e-3) {
      gx /= gl
      gz /= gl
    }
    const prefer = m.stuckCount % 2 === 0 ? 1 : -1
    let best = -Infinity
    let bx = 0
    let bz = 0
    let bReach = 0
    for (let k = 0; k < ESCAPE_DIRS; k++) {
      const ang = (k / ESCAPE_DIRS) * Math.PI * 2
      const dx = Math.sin(ang)
      const dz = Math.cos(ang)
      const reach = reachAlong(m, dx, dz, TT.detourMax)
      if (reach < DETOUR_MIN) continue
      // 叉积符号区分目标方向的左右
      const cross = gx * dz - gz * dx
      let s = reach / TT.detourMax + 0.5 * (dx * gx + dz * gz)
      s -= 0.8 * Math.max(0, dx * m.steerX + dz * m.steerZ)
      s += 0.2 * prefer * Math.sign(cross)
      s -= spotThreat(pos.x + dx * reach, pos.z + dz * reach) * 0.5
      if (s > best) {
        best = s
        bx = dx
        bz = dz
        bReach = reach
      }
    }
    if (best === -Infinity) return
    const len = Math.max(DETOUR_MIN, bReach - 0.5)
    m.detourX = pos.x + bx * len
    m.detourZ = pos.z + bz * len
    m.detourTimer = TT.detourTime
    m.steerTimer = 0
  }

  function move(m: Mate, dt: number, wantMove: boolean, speed: number, upright: boolean): void {
    const a = m.actor
    const pos = a.position
    const world = ctx.world
    const startX = pos.x
    const startZ = pos.z
    m.hasMoveDir = false

    let desX = 0
    let desZ = 0
    let goalDist = 0
    if (wantMove) {
      goalDist = distXZ(pos, m.dest)
      if (goalDist > 1e-3) {
        let tx = m.dest.x
        let tz = m.dest.z
        if (m.detourTimer > 0) {
          m.detourTimer -= dt
          if (Math.hypot(m.detourX - pos.x, m.detourZ - pos.z) < DETOUR_ARRIVE) {
            m.detourTimer = 0
            m.steerTimer = 0
          } else if (m.detourTimer > 0) {
            tx = m.detourX
            tz = m.detourZ
          }
        }
        const dist = Math.hypot(tx - pos.x, tz - pos.z)
        if (dist > 1e-3) {
          m.steerTimer -= dt
          if (m.steerTimer <= 0) {
            m.steerTimer = TT.steerInterval
            chooseSteer(m, tx, tz, dist, upright)
          } else if (m.steerDirect) {
            m.steerX = (tx - pos.x) / dist
            m.steerZ = (tz - pos.z) / dist
          }
          // 最后一小段减速，到点不冲过头
          const v = speed * clamp(goalDist / ARRIVE_SLOW, ARRIVE_MIN_SPEED, 1)
          desX = m.steerX * v
          desZ = m.steerZ * v
        }
      }
    } else {
      m.detourTimer = 0
    }

    // 速度平滑：转向和起停都是渐变，不会瞬间掉头
    const k = 1 - Math.exp(-(wantMove ? TT.steerAccel : TT.steerAccel * STOP_ACCEL_MUL) * dt)
    m.velX += (desX - m.velX) * k
    m.velZ += (desZ - m.velZ) * k
    let stepX = m.velX * dt
    let stepZ = m.velZ * dt
    let stepLen = Math.hypot(stepX, stepZ)
    if (wantMove && stepLen > goalDist && stepLen > 1e-6) {
      const s = goalDist / stepLen
      stepX *= s
      stepZ *= s
      stepLen = goalDist
    }
    pos.x += stepX
    pos.z += stepZ
    if (Math.hypot(m.velX, m.velZ) > MOVE_DIR_MIN_SPEED) {
      m.moveYaw = yawOf(m.velX, m.velZ)
      m.hasMoveDir = true
    }

    a.consumeKnockback(dt, vTmp)
    pos.x += vTmp.x
    pos.z += vTmp.z

    if (upright) {
      separate(m)
      pushOutOfBoss(m)
    }
    world.resolveMove(pos, a.radius, pos.y, true)
    const ground = world.groundHeight(pos.x, pos.z, pos.y)
    pos.y = ground >= pos.y ? ground : Math.max(ground, pos.y - FALL_SPEED * dt)

    if (dt > 1e-5) a.velocity.set((pos.x - startX) / dt, 0, (pos.z - startZ) / dt)
    else a.velocity.set(0, 0, 0)

    // 卡住检测：先走绕行点；连续卡住多次时放弃当前站位重新规划（救援 / 撤离 / 补给仍继续绕行）
    const moved = Math.hypot(pos.x - startX, pos.z - startZ)
    if (wantMove && stepLen > 1e-4 && moved < stepLen * STUCK_RATIO) {
      // 撞墙时卸掉一部分速度，别贴着墙“蓄力”
      m.velX *= 0.5
      m.velZ *= 0.5
      m.stuckTime += dt
      if (m.stuckTime > STUCK_TIME) {
        m.stuckTime = 0
        m.unstuckTime = 0
        m.stuckCount += 1
        m.steerTimer = 0
        if (m.stuckCount >= TT.replanAfterStuck && (m.goal === 'follow' || m.goal === 'combat')) {
          m.stuckCount = 0
          m.detourTimer = 0
          m.moving = false
          m.hasPost = false
          m.thinkTimer = 0
        } else {
          startDetour(m)
        }
      }
    } else {
      m.stuckTime = 0
      m.unstuckTime += dt
      if (m.unstuckTime > STUCK_FORGET) m.stuckCount = 0
    }
  }

  /* ── 执行层：射击 ── */

  /** 每帧校验目标是否还活着，并估计目标的移动速度（决定命中率） */
  function trackTargets(m: Mate, dt: number): void {
    const e = m.target
    if (e) {
      if (!e.alive) {
        m.target = null
        m.targetVisible = false
        m.thinkTimer = 0
      } else if (dt > 1e-5) {
        const speed = Math.hypot(e.position.x - m.lastTargetX, e.position.z - m.lastTargetZ) / dt
        m.targetSpeed = damp(m.targetSpeed, speed, TARGET_SPEED_RATE, dt)
        m.lastTargetX = e.position.x
        m.lastTargetZ = e.position.z
      }
    }
    if (m.threat && !m.threat.alive) m.threat = null
    if (m.targetBoss && !ctx.boss.alive) {
      m.targetBoss = false
      m.targetVisible = false
      m.thinkTimer = 0
    }
  }

  /** 更新瞄准点与瞄准角；没有可打的目标时 facingTarget 为 false */
  function updateAim(m: Mate): void {
    const a = m.actor
    const w = a.weapon
    m.facingTarget = false
    if (!m.targetVisible || m.channel !== 'none' || !w || w.mag + w.reserve <= 0) return
    if (m.target) m.target.aimCenter(m.aimPoint)
    else if (m.targetBoss) ctx.boss.aimPoint(m.aimPoint)
    else return
    const dx = m.aimPoint.x - a.position.x
    const dz = m.aimPoint.z - a.position.z
    const dist = Math.hypot(dx, dz)
    if (dist < 1e-3) return
    m.aimYaw = yawOf(dx, dz)
    m.aimPitchTarget = Math.atan2(m.aimPoint.y - (a.position.y + m.shoulderY), dist)
    m.facingTarget = true
  }

  function startReload(m: Mate, w: WeaponState): void {
    m.reloadTotal = WEAPONS[w.id].reloadTime
    m.reloadTimer = m.reloadTotal
    m.burstLeft = 0
    playSfx('reload', m.actor.position, RELOAD_VOLUME, 1)
  }

  function tickReload(m: Mate, dt: number): void {
    if (m.reloadTimer <= 0) return
    m.reloadTimer -= dt
    if (m.reloadTimer > 0) return
    m.reloadTimer = 0
    const w = m.actor.weapon
    if (!w) return
    const take = Math.min(WEAPONS[w.id].magSize - w.mag, w.reserve)
    if (take > 0) {
      w.mag += take
      w.reserve -= take
    }
  }

  /** 打出一发：消耗弹匣、判定命中、生成火光 / 曳光 / 枪声并结算伤害 */
  function fire(m: Mate, w: WeaponState): void {
    const a = m.actor
    const wdef = WEAPONS[w.id]
    w.mag -= 1
    m.sinceShot = 0

    const muzzle = m.rig.muzzle
    if (muzzle) {
      muzzle.getWorldPosition(vMuzzle)
    } else {
      vMuzzle.set(
        a.position.x + Math.sin(m.yaw) * MUZZLE_FORWARD,
        a.position.y + m.shoulderY,
        a.position.z + Math.cos(m.yaw) * MUZZLE_FORWARD,
      )
    }

    const enemy = m.target
    let hit: boolean
    let headshot = false
    let zone: BossZone = 'body'
    let missSpread = MISS_SPREAD_ENEMY
    if (enemy) {
      const chance =
        enemy.type === 'runner'
          ? AI_SHOOTING.hitRunner
          : m.targetSpeed > STILL_SPEED
            ? AI_SHOOTING.hitMoving
            : AI_SHOOTING.hitStill
      hit = rng.chance(chance)
      headshot = hit && rng.chance(m.def.headshotRate)
      if (headshot) enemy.headCenter(vEnd)
      else enemy.aimCenter(vEnd)
    } else {
      const boss = ctx.boss
      missSpread = MISS_SPREAD_BOSS
      hit = rng.chance(AI_SHOOTING.hitBossBody)
      boss.aimPoint(vEnd)
      if (hit) {
        const win = boss.weakWindow
        if (win !== 'none' && rng.chance(AI_SHOOTING.hitBossWeak)) {
          // 弱点暴露时 aimPoint 就是弱点
          zone = win === 'head' ? 'headCore' : 'backCore'
        } else {
          vEnd.x += rng.range(-BOSS_BODY_SCATTER, BOSS_BODY_SCATTER)
          vEnd.y += rng.range(-BOSS_BODY_SCATTER, BOSS_BODY_SCATTER) * 0.5
          vEnd.z += rng.range(-BOSS_BODY_SCATTER, BOSS_BODY_SCATTER)
        }
      }
    }
    const targetDist = vMuzzle.distanceTo(vEnd)

    if (!hit) {
      // 打偏：落点横向偏离目标
      const dx = vEnd.x - vMuzzle.x
      const dz = vEnd.z - vMuzzle.z
      const h = Math.hypot(dx, dz) || 1
      const off = rng.range(missSpread * 0.5, missSpread) * rng.sign()
      vEnd.x += (dz / h) * off
      vEnd.z -= (dx / h) * off
      vEnd.y += rng.range(-0.3, 0.6)
    }

    vShot.subVectors(vEnd, vMuzzle)
    const len = vShot.length()
    if (len > 1e-4) vShot.multiplyScalar(1 / len)
    else vShot.set(Math.sin(m.yaw), 0, Math.cos(m.yaw))

    if (!hit) {
      const wall = ctx.world.raycast(vMuzzle, vShot, MAX_SHOT_DISTANCE)
      if (wall) {
        vEnd.copy(wall.point)
        ctx.effects.impact(vEnd, wall.normal, 'world')
      } else {
        vEnd.copy(vMuzzle).addScaledVector(vShot, MISS_TRACER_LENGTH)
      }
    }

    ctx.effects.muzzleFlash(vMuzzle, vShot, MUZZLE_FLASH_SCALE)
    ctx.effects.tracer(vMuzzle, vEnd)
    playSfx(SHOT_SFX[w.id], vMuzzle, SHOT_VOLUME, rng.range(0.95, 1.05))

    if (hit) {
      dmgInfo.attacker = m.id
      dmgInfo.headshot = headshot
      vHitPoint.copy(vEnd)
      vHitDir.copy(vShot)
      if (enemy) {
        const mul = headshot ? HEADSHOT.multiplier : 1
        ctx.enemies.applyDamage(enemy, wdef.damage * falloff(wdef, targetDist) * mul, dmgInfo)
      } else {
        ctx.boss.applyDamage(wdef.damage, zone, dmgInfo)
      }
    }
    events.emit('shotFired', { shooter: m.id, weapon: w.id, hit })
  }

  /** 点射节奏：每次 3–5 发，按射速出弹，点射之间停顿；弹匣空自动换弹 */
  function shoot(m: Mate, dt: number): void {
    m.sinceShot += dt
    if (m.pauseTimer > 0) m.pauseTimer -= dt
    const a = m.actor
    const w = a.weapon
    if (!w || m.reloadTimer > 0 || a.stunTimer > 0) return
    if (w.mag <= 0) {
      if (w.reserve > 0 && m.channel === 'none') startReload(m, w)
      return
    }
    if (!m.facingTarget || m.pauseTimer > 0) return
    if (Math.abs(wrapAngle(m.aimYaw - m.yaw)) > FIRE_CONE) return

    if (m.burstLeft <= 0) {
      m.burstLeft = rng.int(AI_SHOOTING.burstMin, AI_SHOOTING.burstMax)
      m.shotTimer = 0
    }
    const interval = 60 / WEAPONS[w.id].rpm
    m.shotTimer -= dt
    let fired = 0
    while (m.shotTimer <= 0 && m.burstLeft > 0 && w.mag > 0 && fired < MAX_SHOTS_PER_FRAME) {
      // 目标在本帧被打死就停手
      if (m.target ? !m.target.alive : !ctx.boss.alive) break
      fire(m, w)
      m.shotTimer += interval
      m.burstLeft -= 1
      fired += 1
    }
    if (m.shotTimer < -interval) m.shotTimer = 0
    if (m.burstLeft <= 0) m.pauseTimer = AI_SHOOTING.burstPause
  }

  /* ── 朝向与动画 ── */

  function orient(m: Mate, dt: number): void {
    const a = m.actor
    let targetYaw = m.yaw
    const t = m.rescueTarget
    if (m.facingTarget) {
      targetYaw = m.aimYaw
    } else if (m.channel === 'rescue' && t) {
      targetYaw = yawOf(t.position.x - a.position.x, t.position.z - a.position.z)
    } else if (m.hasMoveDir) {
      targetYaw = m.moveYaw
    }
    m.yaw = wrapAngle(dampAngle(m.yaw, targetYaw, TURN_RATE, dt))
    m.rig.root.position.copy(a.position)
    m.rig.root.rotation.y = m.yaw
  }

  function animate(m: Mate, dt: number, pose: HumanoidPose): void {
    const a = m.actor
    const anim = m.anim
    m.animSpeed = damp(m.animSpeed, Math.hypot(a.velocity.x, a.velocity.z), ANIM_SPEED_RATE, dt)
    m.aimPitch = damp(m.aimPitch, m.facingTarget ? m.aimPitchTarget : 0, TURN_RATE, dt)
    anim.speed = m.animSpeed < 0.05 ? 0 : m.animSpeed
    anim.pose = pose
    anim.aiming = false
    anim.aimPitch = 0
    anim.action = 'none'
    anim.actionProgress = 0
    if (pose === 'stand') {
      anim.aiming = m.facingTarget && m.reloadTimer <= 0
      anim.aimPitch = m.aimPitch
      if (m.channel !== 'none') {
        anim.action = 'interact'
        const total = m.channel === 'rescue' ? INTERACT.rescueTime : INTERACT.boardTime
        anim.actionProgress = clamp(m.channelTime / total, 0, 1)
      } else if (m.reloadTimer > 0) {
        anim.action = 'reload'
        anim.actionProgress = clamp(1 - m.reloadTimer / m.reloadTotal, 0, 1)
      } else if (m.sinceShot < SHOOT_ANIM_TIME) {
        anim.action = 'shoot'
        anim.actionProgress = m.sinceShot / SHOOT_ANIM_TIME
      }
    }
    m.rig.update(dt, anim)
  }

  /* ── 每帧 ── */

  /** 已登机的队友：模型挂在分到的座位锚点下，每帧刷新坐姿 */
  const seatedMates = new Map<Mate, SeatedRig>()

  /** 登机后不再参与 AI：模型从舱门口挪进分到的座位坐下，随直升机起飞；没有座位时才隐藏 */
  function leave(m: Mate): void {
    resetActions(m)
    m.actor.velocity.set(0, 0, 0)
    m.gone = true
    const anchor = ctx.evac.seatAnchor(ctx.evac.seatOf(m.actor))
    if (anchor) seatedMates.set(m, createSeatedRig(m.rig, anchor, INTERACT.mateSeatTime))
    else m.rig.root.visible = false
  }

  function updateMate(m: Mate, dt: number): void {
    if (m.gone) {
      seatedMates.get(m)?.update(dt)
      return
    }
    const a = m.actor
    a.tickStatus(dt)
    if (a.damageSerial !== m.seenSerial) {
      m.seenSerial = a.damageSerial
      m.rig.flash()
    }
    syncWeaponModel(m)

    if (a.status === 'boarded') {
      leave(m)
      return
    }

    if (a.status === 'dead') {
      // 阵亡：保持 dead 姿态留在原地
      if (!m.deadHandled) {
        m.deadHandled = true
        resetActions(m)
        a.velocity.set(0, 0, 0)
      }
      m.rig.root.position.copy(a.position)
      animate(m, dt, 'dead')
      return
    }

    if (a.status === 'downed') {
      // P1：倒地爬向最近的存活成员，不能射击
      if (!m.wasDowned) {
        m.wasDowned = true
        resetActions(m)
      }
      move(m, dt, planCrawl(m), PLAYER.crawlSpeed, false)
      orient(m, dt)
      animate(m, dt, 'downed')
      return
    }

    if (m.wasDowned) {
      m.wasDowned = false
      m.thinkTimer = 0
    }
    m.thinkTimer -= dt
    if (m.thinkTimer <= 0) {
      m.thinkTimer = rng.range(THINK_MIN, THINK_MAX)
      think(m)
    }
    trackTargets(m, dt)
    if (m.channel === 'none') tickReload(m, dt)

    if (m.dodgeTimer > 0) m.dodgeTimer -= dt
    if (m.escapeTimer > 0) m.escapeTimer -= dt
    if (m.postTimer > 0) m.postTimer -= dt
    let wantMove = false
    if (a.stunTimer > 0) interruptChannel(m)
    else wantMove = plan(m, dt)

    // plan 里可能刚完成登机
    if (a.status !== 'alive') {
      if (a.status === 'boarded') leave(m)
      return
    }

    const w = a.weapon
    move(m, dt, wantMove, m.def.moveSpeed * (w ? WEAPONS[w.id].moveMul : 1), true)
    updateAim(m)
    orient(m, dt)
    shoot(m, dt)
    animate(m, dt, 'stand')
  }

  return {
    actors,

    init(): void {
      // 此时 world 已可用：建场地查询，把出生点落到地面并推出障碍物
      nav = createTeammateNav(ctx.world)
      for (let i = 0; i < mates.length; i++) {
        const m = mates[i]
        if (!m) continue
        const pos = m.actor.position
        ctx.world.resolveMove(pos, m.actor.radius, pos.y, true)
        pos.y = ctx.world.groundHeight(pos.x, pos.z, pos.y)
        m.rig.root.position.copy(pos)
        m.dest.copy(pos)
      }
    },

    update(dt: number): void {
      for (let i = 0; i < mates.length; i++) {
        const m = mates[i]
        if (m) updateMate(m, dt)
      }
    },

    dispose(): void {
      offDamaged()
      for (let i = 0; i < mates.length; i++) {
        const m = mates[i]
        if (!m) continue
        endRescue(m)
        scene.remove(m.rig.root)
        m.rig.attachWeapon(null)
        if (m.weaponRig) m.weaponRig.dispose()
        m.weaponRig = null
        m.rig.dispose()
        m.gone = true
      }
      mates.length = 0
    },
  }
}

/**
 * AI 队友系统：Football Master、Manman、91Z 先生。
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
  HEADSHOT,
  INTERACT,
  MAX_SHOT_DISTANCE,
  PAD,
  PLAYER,
  PLAYER_START,
  PLAY_BOUNDS,
  TEAMMATE_AI,
  VOICE,
  WEAPONS,
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

/* ── 常量 ── */

/** 队友顺序（与 ctx.combatants 的后三位一致） */
const TEAMMATE_ORDER: readonly TeammateId[] = ['football', 'manman', 'z91']

const SHOT_SFX: Record<WeaponId, SfxId> = {
  ak47: 'shot_ak47',
  mg3: 'shot_mg3',
  mp5: 'shot_mp5',
  qbz95: 'shot_qbz95',
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
/** 与 Boss 保持的距离区间 */
const BOSS_RANGE_MIN = 12
const BOSS_RANGE_MAX = 18
/** Boss 出招预警时额外后撤的距离 */
const BOSS_WARNING_RETREAT = 4
/** 槽位横向偏移太小（会站在主控枪线上）时改用的横向偏移 */
const BOSS_DEFAULT_LATERAL = 6
/** 比 BOSS_RANGE_MIN 再近这么多就立即后撤 */
const BOSS_CLOSE_MARGIN = 2
/** Boss 战站位偏离超过该值才重新走位（滞回） */
const BOSS_REPOSITION = 4

/** 激进型前压：距离大于 FAR 时推进，推进到两者中点停下 */
const ADVANCE_NEAR = 8
const ADVANCE_FAR = 12
/** 侧翼型：相对“主控 → 敌人”连线的横向 / 前向偏移 */
const FLANK_OFFSET = 10
const FLANK_ADVANCE = 4
const FLANK_REPOSITION = 4

/** 丧尸贴近到 START 内开始后撤，拉开到 STOP 外停止（滞回） */
const KITE_START = 3
const KITE_STOP = 4.5
/** 后撤时每次取的目标步长 */
const KITE_STEP = 5
/** 后撤方向里混入“回到槽位”的权重，避免一路退到场边 */
const KITE_REGROUP_BIAS = 0.35

/** 搜索已落地空投的最远距离 */
const AIRDROP_SEEK_RANGE = 60
/** 主控在该距离内正走向箱子时让给主控 */
const AIRDROP_YIELD_RANGE = 6
/** 判定“主控正走向箱子”的最小接近速度（m/s） */
const AIRDROP_YIELD_SPEED = 0.5

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

/** 卡住检测：实际位移低于预期的该比例视为受阻；持续 STUCK_TIME 秒后横移 SIDESTEP_TIME 秒 */
const STUCK_RATIO = 0.25
const STUCK_TIME = 0.6
const SIDESTEP_TIME = 0.5

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
  /** Boss 战相对“Boss → 主控”轴线的横向偏移 */
  readonly bossLateral: number
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
  sidestepTimer: number
  sidestepSign: 1 | -1

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

/** 把跟随槽位（主控位置 + 按朝向旋转的右 / 前偏移）写入 out，y 置 0 */
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
 * actors 在工厂执行期间即建好，顺序为 football、manman、z91。
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

  for (let i = 0; i < TEAMMATE_ORDER.length; i++) {
    const id = TEAMMATE_ORDER[i]
    if (!id) continue
    const mate = createMate(id, i)
    mates.push(mate)
    actors.push(mate.actor)
  }

  /* ── 创建 ── */

  function createMate(id: TeammateId, index: number): Mate {
    const def = TEAMMATE_AI[id]
    const actor = new CombatantBase(id, events)
    actor.giveWeapon(rng.pick(def.preferredWeapons))
    writeSlot(def, PLAYER_START.x, PLAYER_START.z, PLAYER_START.yaw, actor.position)

    const rig = models.createCharacter(id)
    rig.root.position.copy(actor.position)
    rig.root.rotation.y = PLAYER_START.yaw
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
      bossLateral: Math.abs(def.followRight) >= 3 ? def.followRight : BOSS_DEFAULT_LATERAL,
      side: def.followRight < 0 ? -1 : 1,
      weaponRig: null,
      yaw: PLAYER_START.yaw,
      moveYaw: PLAYER_START.yaw,
      hasMoveDir: false,
      animSpeed: 0,
      goal: 'follow',
      // 三人的决策错开在不同帧
      thinkTimer: (THINK_MIN * (index + 1)) / TEAMMATE_ORDER.length,
      moving: false,
      kiting: false,
      leashed: false,
      stuckTime: 0,
      sidestepTimer: 0,
      sidestepSign: 1,
      target: null,
      targetBoss: false,
      targetVisible: false,
      targetSpeed: 0,
      lastTargetX: 0,
      lastTargetZ: 0,
      threat: null,
      threatCount: 0,
      facingTarget: false,
      aimYaw: PLAYER_START.yaw,
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
    m.sidestepTimer = 0
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
    if (near) {
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

  /** P2：最近的、没被别人占用的倒地成员；周围敌人太多时放弃（Manman 的上限是 Infinity） */
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

  /** P4：最近的已落地空投；主控正要拿、或别的队友已经去拿时不去 */
  function findCrate(m: Mate): AirdropCrate | null {
    const pos = m.actor.position
    const crate = ctx.airdrops.nearestLanded(pos, AIRDROP_SEEK_RANGE)
    if (!crate || crate.id === m.skipCrateId) return null

    const mine = distXZ(pos, crate.position)
    const p = ctx.player.actor
    if (p.status === 'alive') {
      const tx = crate.position.x - p.position.x
      const tz = crate.position.z - p.position.z
      const theirs = Math.hypot(tx, tz)
      if (theirs < mine) {
        // 主控已经站在箱子旁
        if (theirs < INTERACT.airdropRange) return null
        // 主控在附近并且正朝箱子走
        if (theirs < AIRDROP_YIELD_RANGE && p.velocity.x * tx + p.velocity.z * tz > theirs * AIRDROP_YIELD_SPEED) {
          return null
        }
      }
    }
    for (let i = 0; i < mates.length; i++) {
      const o = mates[i]
      if (!o || o === m) continue
      if (o.goal === 'airdrop' && o.crate === crate && o.actor.status === 'alive') return null
    }
    return crate
  }

  function think(m: Mate): void {
    const a = m.actor
    const pos = a.position
    ensureUsableWeapon(m)

    m.threat = ctx.enemies.nearest(pos, m.def.engageRange)
    m.threatCount = ctx.enemies.countWithin(pos, AI_SHOOTING.threatRadius)
    pickTarget(m)

    const w = a.weapon
    const ratio = ammoRatio(w)
    if (ratio < LOW_AMMO_RATIO) {
      if (!m.lowAmmoVoiced) {
        m.lowAmmoVoiced = true
        events.emit('voice', { speaker: m.id, text: VOICE.lowAmmo[m.id] })
      }
    } else if (ratio >= AI_SHOOTING.airdropAmmoRatio) {
      // 补给之后重新武装这句台词
      m.lowAmmoVoiced = false
    }

    // 附近暂时没有威胁时主动换弹
    if (w && m.reloadTimer <= 0 && m.channel === 'none' && w.reserve > 0 && m.threatCount === 0) {
      const size = WEAPONS[w.id].magSize
      if (w.mag < size && w.mag / size < m.def.reloadThreshold) startReload(m, w)
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
    const hasAmmo = w !== undefined && w.mag + w.reserve > 0
    if (hasAmmo && (m.target !== null || m.targetBoss)) {
      setGoal(m, 'combat')
      return
    }
    if (ratio < AI_SHOOTING.airdropAmmoRatio) {
      const crate = findCrate(m)
      if (crate) {
        setGoal(m, 'airdrop')
        m.crate = crate
        return
      }
    }
    setGoal(m, 'follow')
  }

  /* ── 执行层：移动目标 ── */

  /** P5：跟随槽位。离主控超过 startDist 才出发，到槽位附近停下 */
  function planFollow(m: Mate, startDist: number): boolean {
    const pos = m.actor.position
    const p = ctx.player.actor.position
    writeSlot(m.def, p.x, p.z, ctx.player.yaw, m.dest)
    clampDest(m)
    if (m.moving) {
      if (distXZSq(pos, m.dest) < ARRIVE * ARRIVE) m.moving = false
    } else if (distXZSq(pos, p) > startDist * startDist) {
      m.moving = true
    }
    return m.moving
  }

  /** 丧尸贴脸或离 Boss 太近时后撤（边打边退）。生效时写 dest 并返回 true */
  function planAvoid(m: Mate): boolean {
    const pos = m.actor.position
    let ax = 0
    let az = 0
    let active = false

    const t = m.threat
    if (t && t.alive) {
      const dx = pos.x - t.position.x
      const dz = pos.z - t.position.z
      const d = Math.hypot(dx, dz)
      if (d - t.radius < (m.kiting ? KITE_STOP : KITE_START)) {
        active = true
        if (d > 1e-4) {
          ax += dx / d
          az += dz / d
        }
      }
    }
    const boss = ctx.boss
    if (boss.active && boss.alive) {
      const dx = pos.x - boss.position.x
      const dz = pos.z - boss.position.z
      const d = Math.hypot(dx, dz)
      if (d < (m.kiting ? BOSS_RANGE_MIN : BOSS_RANGE_MIN - BOSS_CLOSE_MARGIN)) {
        active = true
        if (d > 1e-4) {
          ax += dx / d
          az += dz / d
        }
      }
    }
    m.kiting = active
    if (!active) return false

    const p = ctx.player.actor.position
    writeSlot(m.def, p.x, p.z, ctx.player.yaw, vTmp)
    const sx = vTmp.x - pos.x
    const sz = vTmp.z - pos.z
    const sl = Math.hypot(sx, sz)
    if (sl > 1) {
      ax += (sx / sl) * KITE_REGROUP_BIAS
      az += (sz / sl) * KITE_REGROUP_BIAS
    }
    const al = Math.hypot(ax, az)
    if (al < 1e-3) return false
    m.dest.set(pos.x + (ax / al) * KITE_STEP, pos.y, pos.z + (az / al) * KITE_STEP)
    clampDest(m)
    return true
  }

  /** Boss 战站位：保持距离，并沿“Boss → 主控”轴线横向错开，不挡主控枪线 */
  function planBoss(m: Mate): boolean {
    const pos = m.actor.position
    const boss = ctx.boss
    const p = ctx.player.actor
    const bx = boss.position.x
    const bz = boss.position.z

    let ax = p.position.x - bx
    let az = p.position.z - bz
    let len = Math.hypot(ax, az)
    if (len < 1 || p.status === 'dead' || p.status === 'boarded') {
      ax = pos.x - bx
      az = pos.z - bz
      len = Math.hypot(ax, az)
    }
    if (len < 1e-3) {
      ax = 0
      az = 1
      len = 1
    }
    ax /= len
    az /= len

    const range = m.bossRange + (boss.warning !== '' ? BOSS_WARNING_RETREAT : 0)
    const s = clamp(m.bossLateral / range, -0.9, 0.9)
    const c = Math.sqrt(1 - s * s)
    // 主控面向 Boss 时的右手方向是 (az, -ax)
    m.dest.set(bx + (ax * c + az * s) * range, pos.y, bz + (az * c - ax * s) * range)
    clampDest(m)

    const dSq = distXZSq(pos, m.dest)
    if (m.moving) {
      if (dSq < ARRIVE * ARRIVE) m.moving = false
    } else if (dSq > BOSS_REPOSITION * BOSS_REPOSITION) {
      m.moving = true
    }
    return m.moving
  }

  /** P3：按角色风格走位 */
  function planCombat(m: Mate): boolean {
    const pos = m.actor.position
    const p = ctx.player.actor

    // 追得太远就先回阵型（射击层照常工作）
    if (p.status === 'alive' || p.status === 'downed') {
      const dSq = distXZSq(pos, p.position)
      const leash = AI_SHOOTING.followMax * 2
      if (dSq > leash * leash) m.leashed = true
      else if (dSq < AI_SHOOTING.followMax * AI_SHOOTING.followMax) m.leashed = false
      if (m.leashed) {
        m.moving = true
        return planFollow(m, AI_SHOOTING.followMax)
      }
    }

    const e = m.target
    if (!e) return m.targetBoss ? planBoss(m) : planFollow(m, AI_SHOOTING.followMax)

    if (m.def.style === 'aggressive') {
      // 激进前压：主动接近到 8–12m
      const d = distXZ(pos, e.position)
      if (m.moving) {
        if (d <= (ADVANCE_NEAR + ADVANCE_FAR) / 2) m.moving = false
      } else if (d > ADVANCE_FAR) {
        m.moving = true
      }
      if (!m.moving) return false
      m.dest.copy(e.position)
      clampDest(m)
      return true
    }

    if (m.def.style === 'flank') {
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

    // 支援：贴着主控保持阵型，在中距离射击
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

  /** P4：走到空投旁拾取 */
  function planAirdrop(m: Mate): boolean {
    const a = m.actor
    const crate = m.crate
    if (!crate || !crate.landed || ctx.airdrops.crates.indexOf(crate) < 0) {
      setGoal(m, 'follow')
      m.thinkTimer = 0
      return planFollow(m, AI_SHOOTING.followMax)
    }
    if (distXZ(a.position, crate.position) < INTERACT.airdropRange) {
      if (ctx.airdrops.pickup(crate, a) === 'needsChoice') {
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

  /** 撤离：跑向舱门，能登机后站定读条 */
  function planEvac(m: Mate, dt: number): boolean {
    const a = m.actor
    const evac = ctx.evac
    if (evac.heliState !== 'landed') {
      setGoal(m, 'follow')
      m.thinkTimer = 0
      return planFollow(m, AI_SHOOTING.followMax)
    }
    if (evac.canBoard(a)) {
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
    evac.doorWorld(m.dest)
    // 已到舱门却仍不能登机：改走停机坪中心兜底
    if (distXZSq(a.position, m.dest) < ARRIVE * ARRIVE) m.dest.set(PAD.x, a.position.y, PAD.z)
    return true
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

  /** 按当前意图算出移动目标；返回本帧是否移动 */
  function plan(m: Mate, dt: number): boolean {
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
  function move(m: Mate, dt: number, wantMove: boolean, speed: number, upright: boolean): void {
    const a = m.actor
    const pos = a.position
    const world = ctx.world
    const startX = pos.x
    const startZ = pos.z
    let stepLen = 0
    m.hasMoveDir = false
    if (m.sidestepTimer > 0) m.sidestepTimer -= dt

    if (wantMove) {
      const dist = distXZ(pos, m.dest)
      if (dist > 1e-3) {
        world.steer(pos, m.dest, a.radius, vDir)
        let dx = vDir.x
        let dz = vDir.z
        if (m.sidestepTimer > 0) {
          // 卡住后短暂横移，绕开挡路的东西
          const sx = -dz * m.sidestepSign
          const sz = dx * m.sidestepSign
          dx = dx * 0.35 + sx
          dz = dz * 0.35 + sz
        }
        const len = Math.hypot(dx, dz)
        if (len > 1e-4) {
          stepLen = Math.min(speed * dt, dist)
          pos.x += (dx / len) * stepLen
          pos.z += (dz / len) * stepLen
          m.moveYaw = yawOf(dx, dz)
          m.hasMoveDir = true
        }
      }
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

    // 卡住检测
    if (stepLen > 0 && Math.hypot(pos.x - startX, pos.z - startZ) < stepLen * STUCK_RATIO) {
      m.stuckTime += dt
      if (m.stuckTime > STUCK_TIME) {
        m.stuckTime = 0
        m.sidestepTimer = SIDESTEP_TIME
        m.sidestepSign = rng.sign()
        // 跟随 / 走位不是非到不可：先停下，条件满足时再重新出发
        if (m.goal === 'follow' || m.goal === 'combat') m.moving = false
      }
    } else {
      m.stuckTime = 0
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

  /** 登机后隐藏模型，不再更新 */
  function leave(m: Mate): void {
    resetActions(m)
    m.actor.velocity.set(0, 0, 0)
    m.rig.root.visible = false
    m.gone = true
  }

  function updateMate(m: Mate, dt: number): void {
    if (m.gone) return
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
      // 此时 world 已可用：把出生点落到地面并推出障碍物
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

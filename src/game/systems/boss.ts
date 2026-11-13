/**
 * Boss 阿奎尔巨兽的战斗逻辑：登场、目标与移动、两阶段攻击循环、毒池、冲击波、受伤判定、死亡与样本提取点。
 *
 * 状态机：hidden → emerge → [gap → sweep → gap → stab ×N → gap → spit → gap → stagger]* → dying → dead。
 * 血量降到 phase2Ratio 时插入 roar；狂暴后在 gap 里按计时插入 shock → prone。
 * 模型来自 ctx.models.createBoss()，这里只管 root 的位置与朝向，并每帧把动画输入交给 rig.update。
 */

import { Vector3 } from 'three'
import { BOSS, BOSS_ENTRY, BOSS_WARNING, FIELD, PLAY_BOUNDS, PLAYER } from '../core/config'
import type {
  BossAnimInput,
  BossAnimMode,
  BossRig,
  BossSystem,
  BossWeakWindow,
  BossZone,
  Combatant,
  EffectHandle,
  GameContext,
  RayHit,
  SfxOptions,
} from '../core/types'
import { clamp, dampAngle, distXZ, distXZSq, lerp, raySphere, smoothstep, wrapAngle, yawOf } from '../utils/math'

/* ── 补充参数：config.ts 没有给出的演出与手感细节 ── */

/** 重选目标的间隔（秒） */
const RETARGET_INTERVAL = 1
/** 招式之间的最短间隙（秒） */
const GAP_MIN = 0.25
/** 横扫前目标还在范围外时，最多再追这么久（秒） */
const SWEEP_CHASE_MAX = 2
/** 目标进入横扫半径的这个比例以内就出手 */
const SWEEP_READY_RATIO = 0.85
/** 出手动画时长（秒）；狂暴后同样乘 enragedTimeMul */
const SWEEP_STRIKE_TIME = 0.6
const STAB_STRIKE_TIME = 0.4
const SPIT_STRIKE_TIME = 1.2
/** 收招阶段的移动速度倍率 */
const RECOVER_SPEED_MUL = 0.7
/** 转向速率（1/秒） */
const TURN_RATE = 2.5
const TURN_RATE_ENRAGED = 3.5
/** 突刺前摇转向锁定方向的速率（1/秒） */
const STAB_TURN_RATE = 12
/** 停步后目标再拉开这么远才重新起步，避免 idle / crawl 来回切换 */
const CHASE_HYSTERESIS = 0.6
/** 毒池落地前的预警时长，以及相邻两池的落地间隔（秒） */
const POOL_WARN_TIME = 0.5
const POOL_STAGGER = 0.3
/** 毒池落点相对目标的随机偏移（米） */
const POOL_JITTER = 1.2
/** 存活成员少于毒池数时，多出来的毒池落在目标周围这个距离带内，压缩走位空间 */
const POOL_SPREAD_MIN = 2.5
const POOL_SPREAD_MAX = 4.5
/** 毒池槽位数：上一轮的毒池还没消失时也够用 */
const POOL_SLOTS = BOSS.spit.pools * 2
/** 转阶段后首次冲击波的延迟（秒） */
const FIRST_SHOCK_DELAY = 8
/** 冲击波蓄力期间的红色波纹条数 */
const SHOCK_RIPPLES = 2
/** 召唤动作时长（秒） */
const SUMMON_ANIM_TIME = 0.8
/** 命中暴露弱点时受击音效的最小间隔（秒） */
const HURT_SFX_INTERVAL = 0.9
/** 射线同时穿过核心与身体时，核心比身体远不超过“核心半径 × 该值”仍判为核心 */
const CORE_PRIORITY_RATIO = 1
/** 循环动画的 progress 周期（秒） */
const IDLE_LOOP = 3
const CRAWL_LOOP = 1.2
/** 样本提取点从尸体中心向正面偏移的距离（米） */
const SAMPLE_FORWARD = BOSS.radius * 0.5
/** 突刺的动画目标点抬到躯干高度（米） */
const STAB_AIM_HEIGHT = 1

const COLOR_POISON = 0x7dff4a
const COLOR_SHOCK_WARN = 0xff3020
const COLOR_SHOCK_RING = 0xffd27a
const COLOR_SAMPLE = 0x3aa0ff

/**
 * 屏幕震动：强度是相机位移幅度（米，effects.shake 的单位），时长为秒。
 * 参照：主控受伤的震动为 0.04–0.18 米，effects 的上限为 0.6 米。
 */
const SHAKE = {
  spawn: { strength: 0.18, duration: 1.2 },
  breach: { strength: 0.24, duration: 0.8 },
  sweep: { strength: 0.1, duration: 0.3 },
  stab: { strength: 0.08, duration: 0.2 },
  roar: { strength: 0.3, duration: BOSS.roar.duration },
  shock: { strength: 0.27, duration: 0.6 },
  death: { strength: 0.24, duration: 1.5 },
} as const

/** 预警文案统一取自 config，HUD 显示与队友 AI 的判断用同一份 */
const WARN_SWEEP = BOSS_WARNING.sweep
const WARN_STAB = BOSS_WARNING.stab
const WARN_SPIT = BOSS_WARNING.spit
const WARN_STAGGER = BOSS_WARNING.stagger
const WARN_SHOCK = BOSS_WARNING.shock
const WARN_PRONE = BOSS_WARNING.prone

/* ── 由 config 推出的常量 ── */

const SWEEP_ARC = (BOSS.sweep.arcDeg * Math.PI) / 180
const SWEEP_COS = Math.cos(SWEEP_ARC / 2)
const LIMIT_X = FIELD.halfX - 4
const LIMIT_Z = FIELD.halfZ - 2
const POOL_RADIUS_SQ = BOSS.spit.poolRadius * BOSS.spit.poolRadius
const POOL_TICK_DAMAGE = BOSS.spit.poolDps * BOSS.spit.poolTick
/** 一轮循环的步数：横扫 + 突刺 ×repeats + 毒液 + 硬直 */
const CYCLE_LENGTH = BOSS.stab.repeats + 3

const NO_PAYLOAD: Record<string, never> = {}

type BossState =
  | 'hidden'
  | 'emerge'
  | 'gap'
  | 'sweep'
  | 'stab'
  | 'spit'
  | 'stagger'
  | 'roar'
  | 'shock'
  | 'prone'
  | 'dying'
  | 'dead'

type MoveKind = 'sweep' | 'stab' | 'spit' | 'stagger'

/** 招式内的子阶段 */
const STAGE_WINDUP = 0
const STAGE_STRIKE = 1
const STAGE_RECOVER = 2

const POOL_FREE = 0
const POOL_FLYING = 1
const POOL_ACTIVE = 2

interface PoisonPool {
  /** POOL_FREE 空闲；POOL_FLYING 已喷出、落点在预警；POOL_ACTIVE 已落地 */
  status: number
  center: Vector3
  /** 飞行中：距落地的秒数；已落地：剩余寿命 */
  timer: number
  /** 距下一次伤害结算的秒数 */
  tick: number
}

/** 循环第 step 步是哪一招 */
function moveAt(step: number): MoveKind {
  if (step === 0) return 'sweep'
  if (step <= BOSS.stab.repeats) return 'stab'
  return step === BOSS.stab.repeats + 1 ? 'spit' : 'stagger'
}

/**
 * 创建 Boss 系统。spawn() 之前模型挂在场景里但不可见，update / raycast / applyDamage 均无效果。
 * @param ctx 游戏上下文。工厂执行期间只用 scene / rng / models，其余系统在 spawn 之后才访问
 */
export function createBoss(ctx: GameContext): BossSystem {
  const rng = ctx.rng.fork()
  const rig: BossRig = ctx.models.createBoss()
  rig.root.visible = false
  // 开局就挂进场景（保持不可见）：着色器预编译需要遍历场景里的全部材质，
  // 登场时只翻可见性，不再有首次编译与建场景节点的开销
  ctx.scene.add(rig.root)

  const position = new Vector3(BOSS_ENTRY.startX, 0, BOSS_ENTRY.startZ)
  const samplePoint = new Vector3()
  const deathPosition = new Vector3()
  /** 突刺 / 喷射的动画目标点 */
  const animTarget = new Vector3()
  const stabFrom = new Vector3()
  const stabTo = new Vector3()
  const waveCenter = new Vector3()
  const tmp = new Vector3()

  // 两份动画输入：带目标点与不带目标点，避免每帧增删可选字段
  const anim: BossAnimInput = { mode: 'idle', progress: 0, enraged: false, moveSpeed: 0 }
  const animAimed: BossAnimInput = { mode: 'idle', progress: 0, enraged: false, moveSpeed: 0, target: animTarget }
  const rayHit: RayHit = {
    distance: 0,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    kind: 'boss',
    bossZone: 'body',
  }
  const sfxAt: SfxOptions = { position }
  const pools: PoisonPool[] = []
  for (let i = 0; i < POOL_SLOTS; i++) {
    pools.push({ status: POOL_FREE, center: new Vector3(), timer: 0, tick: 0 })
  }
  const aliveScratch: Combatant[] = []
  /** 本次冲击波里各成员是否已判定过（下标同 ctx.combatants） */
  const waveJudged: boolean[] = []

  let state: BossState = 'hidden'
  let disposed = false
  let stage = STAGE_WINDUP
  let stateTime = 0
  let windupDur = 0
  let strikeDur = 0
  let totalDur = 0
  let windupMode: BossAnimMode = 'idle'
  let strikeMode: BossAnimMode = 'idle'
  let holdMode: BossAnimMode = 'idle'
  let aimed = false
  let cycleStep = 0

  let hp: number = BOSS.maxHp
  let alive = false
  let enraged = false
  let phase: 1 | 2 = 1
  let weakWindow: BossWeakWindow = 'none'
  let warning = ''

  let yaw = 0
  let moving = false
  let target: Combatant | null = null
  let retargetTimer = 0
  let stabYaw = 0

  let summonTimer: number = BOSS.summon.interval
  let summonAnim = 0
  let shockTimer = 0
  let ripplesDone = 0
  let waveActive = false
  let waveTime = 0
  let breached = false
  let hurtCooldown = 0

  let lastMode: BossAnimMode = 'idle'
  let modeClock = 0

  let sampleAvailable = false
  let beam: EffectHandle | null = null

  /* ── 动画、目标、移动 ── */

  /**
   * 同步 root 的位置朝向，并把本帧的动画输入交给模型。
   * progress 传负数表示循环动画（idle / crawl），按固定周期折算成 0..1。
   */
  function pose(dt: number, mode: BossAnimMode, progress: number, moveSpeed: number, withTarget: boolean): void {
    if (mode !== lastMode) {
      lastMode = mode
      modeClock = 0
    } else {
      modeClock += dt
    }
    const input = withTarget ? animAimed : anim
    input.mode = mode
    if (progress >= 0) {
      input.progress = clamp(progress, 0, 1)
    } else {
      const period = mode === 'crawl' ? CRAWL_LOOP : IDLE_LOOP
      input.progress = (modeClock % period) / period
    }
    input.enraged = enraged
    input.moveSpeed = moveSpeed
    rig.root.position.copy(position)
    rig.root.rotation.y = yaw
    rig.update(dt, input)
  }

  /** 选最近的存活小队成员；没有则为 null */
  function pickTarget(): void {
    const squad = ctx.combatants
    let best: Combatant | null = null
    let bestSq = Infinity
    for (let i = 0; i < squad.length; i++) {
      const member = squad[i]
      if (!member || member.status !== 'alive') continue
      const d = distXZSq(member.position, position)
      if (d < bestSq) {
        bestSq = d
        best = member
      }
    }
    target = best
  }

  /**
   * 朝目标转向并爬行，进入 preferredRange 后停下。
   * @param speedMul 速度倍率；传 0 只转向不移动
   * @returns 本帧实际移动速度（m/s）
   */
  function chase(dt: number, speedMul: number): number {
    if (!target || dt <= 0) {
      moving = false
      return 0
    }
    const dx = target.position.x - position.x
    const dz = target.position.z - position.z
    const dist = Math.hypot(dx, dz)
    if (dist < 0.01) {
      moving = false
      return 0
    }
    const want = yawOf(dx, dz)
    yaw = wrapAngle(dampAngle(yaw, want, enraged ? TURN_RATE_ENRAGED : TURN_RATE, dt))
    if (speedMul <= 0) {
      moving = false
      return 0
    }
    if (dist <= BOSS.preferredRange) moving = false
    else if (dist > BOSS.preferredRange + CHASE_HYSTERESIS) moving = true
    if (!moving) return 0

    // 还没对准目标时放慢，免得横着滑行
    const align = Math.max(0, Math.cos(wrapAngle(want - yaw)))
    const speed = (enraged ? BOSS.speedEnraged : BOSS.speed) * speedMul * (0.35 + 0.65 * align)
    const stepLen = Math.min(speed * dt, dist - BOSS.preferredRange)
    const fromX = position.x
    const fromZ = position.z
    position.x = clamp(fromX + (dx / dist) * stepLen, -LIMIT_X, LIMIT_X)
    position.z = clamp(fromZ + (dz / dist) * stepLen, -LIMIT_Z, LIMIT_Z)
    return Math.hypot(position.x - fromX, position.z - fromZ) / dt
  }

  /** 召唤计时到点则瞬发一次；只在间隙与收招阶段调用，不打断招式 */
  function trySummon(): void {
    if (summonTimer > 0) return
    summonTimer += BOSS.summon.interval
    summonAnim = SUMMON_ANIM_TIME
    ctx.enemies.spawnExtra(BOSS.summon.type, BOSS.summon.count)
    ctx.audio.play('boss_summon', sfxAt)
  }

  /** 间隙与收招阶段共用：播完召唤动作，否则追击目标，并提交 summon / crawl / idle 姿态 */
  function roam(dt: number, speedMul: number): void {
    if (summonAnim > 0) {
      summonAnim -= dt
      moving = false
      pose(dt, 'summon', 1 - summonAnim / SUMMON_ANIM_TIME, 0, false)
      return
    }
    const speed = chase(dt, speedMul)
    pose(dt, speed > 0.05 ? 'crawl' : 'idle', -1, speed, false)
  }

  /* ── 登场与招式间隙 ── */

  function spawn(): void {
    if (disposed || state !== 'hidden') return
    state = 'emerge'
    stateTime = 0
    alive = true
    hp = BOSS.maxHp
    // 面朝南（+Z）
    yaw = yawOf(0, 1)
    position.set(BOSS_ENTRY.startX, 0, BOSS_ENTRY.startZ)
    summonTimer = BOSS.summon.interval
    retargetTimer = 0
    rig.root.visible = true
    // 先刷新一次命中球，登场当帧就能被射线打到
    pose(0, 'emerge', 0, 0, false)
    ctx.events.emit('bossSpawned', NO_PAYLOAD)
    ctx.audio.play('boss_roar')
    ctx.effects.shake(SHAKE.spawn.strength, SHAKE.spawn.duration)
  }

  /** 撞开北侧围栏：只触发一次 */
  function breach(): void {
    breached = true
    ctx.world.breakNorthBarrier()
    for (let i = -1; i <= 1; i++) {
      tmp.set(BOSS_ENTRY.startX + i * BOSS_ENTRY.breachHalfWidth * 0.6, 0.6, BOSS_ENTRY.breachZ)
      ctx.effects.burst(tmp, 'dust')
    }
    ctx.effects.shake(SHAKE.breach.strength, SHAKE.breach.duration)
  }

  function updateEmerge(dt: number): void {
    stateTime += dt
    const t = clamp(stateTime / BOSS.emergeTime, 0, 1)
    const fromZ = position.z
    position.x = BOSS_ENTRY.startX
    position.z = lerp(BOSS_ENTRY.startZ, BOSS_ENTRY.arriveZ, smoothstep(t))
    // 以身体前缘为准，避免模型先穿过围栏再撞开
    if (!breached && position.z + BOSS.radius >= BOSS_ENTRY.breachZ) breach()
    pose(dt, 'emerge', t, dt > 0 ? Math.abs(position.z - fromZ) / dt : 0, false)
    if (t >= 1) enterGap()
  }

  function enterGap(): void {
    state = 'gap'
    stateTime = 0
    weakWindow = 'none'
    warning = ''
  }

  /** 招式间隙：追击目标，到点后开始下一招（狂暴后冲击波计时到点则先放冲击波） */
  function updateGap(dt: number): void {
    stateTime += dt
    if (!target) {
      // 没有存活目标：原地待机，循环暂停
      moving = false
      pose(dt, 'idle', -1, 0, false)
      return
    }
    trySummon()
    if (summonAnim <= 0 && stateTime >= GAP_MIN) {
      if (enraged && shockTimer <= 0) {
        beginShock()
        updateShock(dt)
        return
      }
      const next = moveAt(cycleStep)
      // 横扫射程短，目标太远时先追一小段；追不上也照常出手，保持循环节奏
      const ready =
        next !== 'sweep' ||
        stateTime >= GAP_MIN + SWEEP_CHASE_MAX ||
        distXZ(target.position, position) <= BOSS.sweep.radius * SWEEP_READY_RATIO
      if (ready) {
        beginMove(next)
        if (next === 'stagger') updateHold(dt)
        else updateAttack(dt)
        return
      }
    }
    roam(dt, 1)
  }

  /* ── 攻击循环：横扫 / 突刺 / 毒液 / 硬直 ── */

  /** 开始循环中的一招：算好各段时长（狂暴后乘 enragedTimeMul），放出预警 */
  function beginMove(kind: MoveKind): void {
    const mul = enraged ? BOSS.enragedTimeMul : 1
    state = kind
    stage = STAGE_WINDUP
    stateTime = 0
    moving = false
    switch (kind) {
      case 'sweep':
        windupDur = BOSS.sweep.windup * mul
        strikeDur = SWEEP_STRIKE_TIME * mul
        totalDur = BOSS.sweep.duration * mul
        windupMode = 'sweepWindup'
        strikeMode = 'sweep'
        aimed = false
        warning = WARN_SWEEP
        // 前摇期间朝向锁定，扇形预警与实际判定一致
        ctx.effects.telegraphSector(position, yaw, SWEEP_ARC, BOSS.sweep.radius, windupDur)
        break
      case 'stab':
        windupDur = BOSS.stab.windup * mul
        strikeDur = STAB_STRIKE_TIME * mul
        totalDur = BOSS.stab.duration * mul
        windupMode = 'stabWindup'
        strikeMode = 'stab'
        aimed = true
        warning = WARN_STAB
        lockStab()
        ctx.effects.telegraphLine(stabFrom, stabTo, BOSS.stab.width, windupDur)
        break
      case 'spit':
        windupDur = BOSS.spit.windup * mul
        strikeDur = SPIT_STRIKE_TIME * mul
        totalDur = BOSS.spit.duration * mul
        windupMode = 'spitWindup'
        strikeMode = 'spit'
        aimed = true
        warning = WARN_SPIT
        if (target) animTarget.copy(target.position)
        ctx.audio.play('boss_spit', sfxAt)
        break
      case 'stagger':
        // 硬直是玩家的输出窗口，不随狂暴缩短
        totalDur = BOSS.stagger.duration
        holdMode = 'stagger'
        weakWindow = 'head'
        warning = WARN_STAGGER
        break
    }
  }

  /** 突刺前摇开始时锁定目标当前位置，并算出从 Boss 出发、长 stab.range 的判定线段 */
  function lockStab(): void {
    let dirX = Math.sin(yaw)
    let dirZ = Math.cos(yaw)
    if (target) {
      const dx = target.position.x - position.x
      const dz = target.position.z - position.z
      const dist = Math.hypot(dx, dz)
      if (dist > 0.01) {
        dirX = dx / dist
        dirZ = dz / dist
      }
      animTarget.copy(target.position)
    } else {
      animTarget.set(position.x + dirX * BOSS.preferredRange, 0, position.z + dirZ * BOSS.preferredRange)
    }
    animTarget.y += STAB_AIM_HEIGHT
    stabYaw = yawOf(dirX, dirZ)
    stabFrom.set(position.x, 0, position.z)
    stabTo.set(position.x + dirX * BOSS.stab.range, 0, position.z + dirZ * BOSS.stab.range)
  }

  /** 横扫 / 突刺 / 毒液共用的三段式：前摇 → 出手 → 收招（可缓慢移动） */
  function updateAttack(dt: number): void {
    stateTime += dt
    if (stage === STAGE_WINDUP) {
      if (stateTime < windupDur) {
        if (state === 'stab') {
          yaw = wrapAngle(dampAngle(yaw, stabYaw, STAB_TURN_RATE, dt))
        } else if (state === 'spit') {
          // 鼓胀蓄力时继续盯着目标
          chase(dt, 0)
          if (target) animTarget.copy(target.position)
        }
        pose(dt, windupMode, stateTime / windupDur, 0, aimed)
        return
      }
      stage = STAGE_STRIKE
      if (state === 'sweep') strikeSweep()
      else if (state === 'stab') strikeStab()
      else strikeSpit()
    }
    if (stage === STAGE_STRIKE) {
      const t = stateTime - windupDur
      if (t < strikeDur) {
        pose(dt, strikeMode, t / strikeDur, 0, aimed)
        return
      }
      stage = STAGE_RECOVER
      warning = ''
    }
    if (stateTime >= totalDur) {
      cycleStep = (cycleStep + 1) % CYCLE_LENGTH
      enterGap()
      updateGap(dt)
      return
    }
    if (target) trySummon()
    roam(dt, RECOVER_SPEED_MUL)
  }

  /** 纯计时的静止状态：硬直 / 转阶段咆哮 / 趴倒 */
  function updateHold(dt: number): void {
    stateTime += dt
    if (stateTime < totalDur) {
      pose(dt, holdMode, stateTime / totalDur, 0, false)
      return
    }
    if (state === 'stagger') {
      cycleStep = (cycleStep + 1) % CYCLE_LENGTH
    } else if (state === 'roar') {
      // 狂暴后从横扫重新开始一轮，并安排首次冲击波
      cycleStep = 0
      shockTimer = FIRST_SHOCK_DELAY
    }
    enterGap()
    updateGap(dt)
  }

  /** 横扫结算：半径内且在正面扇形内的成员受伤并被击退 */
  function strikeSweep(): void {
    const faceX = Math.sin(yaw)
    const faceZ = Math.cos(yaw)
    const squad = ctx.combatants
    for (let i = 0; i < squad.length; i++) {
      const member = squad[i]
      if (!member || member.status !== 'alive') continue
      let dx = member.position.x - position.x
      let dz = member.position.z - position.z
      const dist = Math.hypot(dx, dz)
      if (dist > BOSS.sweep.radius + member.radius) continue
      if (dist > 0.01) {
        if ((dx * faceX + dz * faceZ) / dist < SWEEP_COS) continue
      } else {
        dx = faceX
        dz = faceZ
      }
      // 无敌期间连击退一起免除
      if (member.takeDamage(BOSS.sweep.damage, 'bossSweep')) {
        member.applyKnockback(dx, dz, BOSS.sweep.knockback)
      }
    }
    ctx.audio.play('boss_sweep', sfxAt)
    ctx.effects.shake(SHAKE.sweep.strength, SHAKE.sweep.duration)
  }

  /** 突刺结算：到锁定线段的水平距离不超过 width/2 + 自身半径的成员受伤 */
  function strikeStab(): void {
    const ax = stabFrom.x
    const az = stabFrom.z
    const bx = stabTo.x - ax
    const bz = stabTo.z - az
    const lenSq = bx * bx + bz * bz
    const squad = ctx.combatants
    for (let i = 0; i < squad.length; i++) {
      const member = squad[i]
      if (!member || member.status !== 'alive') continue
      const px = member.position.x - ax
      const pz = member.position.z - az
      const t = lenSq > 0 ? clamp((px * bx + pz * bz) / lenSq, 0, 1) : 0
      const offX = px - bx * t
      const offZ = pz - bz * t
      const reach = BOSS.stab.width / 2 + member.radius
      if (offX * offX + offZ * offZ <= reach * reach) member.takeDamage(BOSS.stab.damage, 'bossStab')
    }
    ctx.audio.play('boss_stab', sfxAt)
    ctx.effects.shake(SHAKE.stab.strength, SHAKE.stab.duration)
  }

  /** 取一个毒池槽位：优先空闲的，否则复用最快过期的 */
  function takePoolSlot(): PoisonPool {
    let best = pools[0] as PoisonPool
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i] as PoisonPool
      if (pool.status === POOL_FREE) return pool
      if (pool.status === POOL_ACTIVE && (best.status !== POOL_ACTIVE || pool.timer < best.timer)) best = pool
    }
    return best
  }

  /**
   * 喷射毒液：为每个毒池选落点并放出圆形预警，毒池稍后由 updatePools 落地。
   * 落点优先按“当前目标、其余存活成员”的顺序轮流选，距 Boss 限制在 minRange..maxRange。
   */
  function strikeSpit(): void {
    const spit = BOSS.spit
    const squad = ctx.combatants
    aliveScratch.length = 0
    if (target && target.status === 'alive') aliveScratch.push(target)
    for (let i = 0; i < squad.length; i++) {
      const member = squad[i]
      if (member && member !== target && member.status === 'alive') aliveScratch.push(member)
    }

    const faceX = Math.sin(yaw)
    const faceZ = Math.cos(yaw)
    for (let i = 0; i < spit.pools; i++) {
      let x: number
      let z: number
      let feetY = 0
      if (aliveScratch.length > 0) {
        const member = aliveScratch[i % aliveScratch.length] as Combatant
        // 每人先各吃一个贴身的，多出来的落在周围封走位
        const offset = i < aliveScratch.length ? rng.range(0, POOL_JITTER) : rng.range(POOL_SPREAD_MIN, POOL_SPREAD_MAX)
        const angle = rng.range(0, Math.PI * 2)
        x = member.position.x + Math.sin(angle) * offset
        z = member.position.z + Math.cos(angle) * offset
        feetY = member.position.y
      } else {
        const angle = yaw + rng.range(-1, 1)
        const reach = rng.range(spit.minRange, spit.maxRange)
        x = position.x + Math.sin(angle) * reach
        z = position.z + Math.cos(angle) * reach
      }

      let dirX = x - position.x
      let dirZ = z - position.z
      const dist = Math.hypot(dirX, dirZ)
      if (dist > 0.01) {
        dirX /= dist
        dirZ /= dist
      } else {
        dirX = faceX
        dirZ = faceZ
      }
      const reach = clamp(dist, spit.minRange, spit.maxRange)
      x = clamp(position.x + dirX * reach, -PLAY_BOUNDS.halfX, PLAY_BOUNDS.halfX)
      z = clamp(position.z + dirZ * reach, -PLAY_BOUNDS.halfZ, PLAY_BOUNDS.halfZ)

      const pool = takePoolSlot()
      pool.center.set(x, ctx.world.groundHeight(x, z, feetY), z)
      pool.status = POOL_FLYING
      pool.timer = POOL_WARN_TIME + i * POOL_STAGGER
      pool.tick = spit.poolTick
      ctx.effects.telegraphCircle(pool.center, spit.poolRadius, pool.timer, COLOR_POISON)
      if (i === 0) animTarget.copy(pool.center)
    }

    rig.headCoreWorld(tmp)
    ctx.effects.burst(tmp, 'poison')
  }

  /* ── 毒池 ── */

  /** 推进毒池：飞行中的到点落地，已落地的按 poolTick 结算伤害并到期回收 */
  function updatePools(dt: number): void {
    const spit = BOSS.spit
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i] as PoisonPool
      if (pool.status === POOL_FREE) continue
      pool.timer -= dt
      if (pool.status === POOL_FLYING) {
        if (pool.timer > 0) continue
        pool.status = POOL_ACTIVE
        pool.timer += spit.poolLife
        pool.tick = spit.poolTick
        ctx.effects.poisonPool(pool.center, spit.poolRadius, spit.poolLife)
        ctx.effects.burst(pool.center, 'poison')
        continue
      }
      // 先结算再判过期，保证寿命末尾那一跳不丢
      pool.tick -= dt
      if (pool.tick <= 0) {
        pool.tick += spit.poolTick
        const squad = ctx.combatants
        for (let k = 0; k < squad.length; k++) {
          const member = squad[k]
          if (!member || member.status !== 'alive') continue
          if (distXZSq(member.position, pool.center) <= POOL_RADIUS_SQ) {
            member.takeDamage(POOL_TICK_DAMAGE, 'bossPoison')
          }
        }
      }
      if (pool.timer <= 0) pool.status = POOL_FREE
    }
  }

  function clearPools(): void {
    for (let i = 0; i < pools.length; i++) (pools[i] as PoisonPool).status = POOL_FREE
  }

  /* ── 阶段 2：咆哮、冲击波、趴倒 ── */

  /** 进入狂暴：打断当前招式，开始转阶段演出 */
  function beginRoar(): void {
    enraged = true
    phase = 2
    state = 'roar'
    stateTime = 0
    totalDur = BOSS.roar.duration
    holdMode = 'roar'
    moving = false
    summonAnim = 0
    weakWindow = 'none'
    warning = ''
    ctx.audio.play('boss_roar')
    ctx.effects.shake(SHAKE.roar.strength, SHAKE.roar.duration)
    ctx.events.emit('bossPhase2', NO_PAYLOAD)
  }

  function beginShock(): void {
    state = 'shock'
    stage = STAGE_WINDUP
    stateTime = 0
    moving = false
    shockTimer = BOSS.shockwave.interval
    ripplesDone = 0
    warning = WARN_SHOCK
    ctx.audio.play('boss_charge')
    ctx.effects.telegraphCircle(position, BOSS.shockwave.radius, BOSS.shockwave.windup, COLOR_SHOCK_WARN)
  }

  function updateShock(dt: number): void {
    const shock = BOSS.shockwave
    stateTime += dt
    if (stage === STAGE_WINDUP) {
      if (stateTime < shock.windup) {
        // 蓄力期间分批放出红色波纹，比真正的波环慢，颜色也不同
        const due = Math.min(SHOCK_RIPPLES, Math.floor((stateTime / shock.windup) * SHOCK_RIPPLES) + 1)
        if (ripplesDone < due) {
          ripplesDone += 1
          ctx.effects.shockwaveRing(position, shock.radius, shock.windup / SHOCK_RIPPLES, COLOR_SHOCK_WARN)
        }
        pose(dt, 'shockCharge', stateTime / shock.windup, 0, false)
        return
      }
      stage = STAGE_STRIKE
      releaseShock()
    }
    const t = stateTime - shock.windup
    if (t < shock.expandTime) {
      pose(dt, 'shockRelease', t / shock.expandTime, 0, false)
      return
    }
    // 释放完毕：趴倒并暴露背部核心
    state = 'prone'
    stateTime = 0
    totalDur = shock.proneDuration
    holdMode = 'prone'
    weakWindow = 'back'
    warning = WARN_PRONE
    pose(dt, 'prone', 0, 0, false)
  }

  /** 释放冲击波：波环从当前位置向外扩散，逐帧判定由 updateWave 负责 */
  function releaseShock(): void {
    const shock = BOSS.shockwave
    waveActive = true
    waveTime = 0
    waveCenter.copy(position)
    const count = ctx.combatants.length
    for (let i = 0; i < count; i++) waveJudged[i] = false
    ctx.audio.play('boss_shockwave')
    ctx.effects.shockwaveRing(waveCenter, shock.radius, shock.expandTime, COLOR_SHOCK_RING)
    ctx.effects.shake(SHAKE.shock.strength, SHAKE.shock.duration)
  }

  /** 波环扫到某个成员所在距离的那一刻判定：此刻离地够高则躲过，否则受伤并眩晕 */
  function updateWave(dt: number): void {
    if (!waveActive) return
    const shock = BOSS.shockwave
    waveTime += dt
    // front 不会超过 radius，半径之外的成员始终扫不到
    const front = shock.radius * Math.min(1, waveTime / shock.expandTime)
    const squad = ctx.combatants
    for (let i = 0; i < squad.length; i++) {
      if (waveJudged[i]) continue
      const member = squad[i]
      if (!member || distXZ(member.position, waveCenter) > front) continue
      waveJudged[i] = true
      if (member.status !== 'alive') continue
      const pos = member.position
      const lift = pos.y - ctx.world.groundHeight(pos.x, pos.z, pos.y)
      if (member.airborne && lift > shock.dodgeHeight) continue
      if (member.takeDamage(shock.damage, 'bossShockwave')) member.stun(shock.stun)
    }
    if (waveTime >= shock.expandTime) waveActive = false
  }

  /* ── 死亡与样本 ── */

  function die(): void {
    hp = 0
    alive = false
    state = 'dying'
    stateTime = 0
    moving = false
    summonAnim = 0
    weakWindow = 'none'
    warning = ''
    waveActive = false
    clearPools()
    deathPosition.copy(position)
    ctx.audio.play('boss_die')
    ctx.effects.shake(SHAKE.death.strength, SHAKE.death.duration)
    rig.headCoreWorld(tmp)
    ctx.effects.burst(tmp, 'glow')
    ctx.events.emit('bossDied', { position: deathPosition })
  }

  /** 倒地演出结束：在尸体略偏正面处放出样本提取点与蓝色光柱 */
  function exposeSample(): void {
    samplePoint.set(position.x + Math.sin(yaw) * SAMPLE_FORWARD, 0, position.z + Math.cos(yaw) * SAMPLE_FORWARD)
    // 推出障碍物并限制在小队可活动范围内，保证走得到
    ctx.world.resolveMove(samplePoint, PLAYER.radius, 0, true)
    samplePoint.y = ctx.world.groundHeight(samplePoint.x, samplePoint.z, 0)
    sampleAvailable = true
    beam = ctx.effects.lightBeam(samplePoint, COLOR_SAMPLE)
  }

  function updateDeath(dt: number): void {
    if (state === 'dying') {
      stateTime += dt
      if (stateTime < BOSS.deathTime) {
        pose(dt, 'dying', stateTime / BOSS.deathTime, 0, false)
        return
      }
      state = 'dead'
      exposeSample()
    }
    pose(dt, 'dead', 1, 0, false)
  }

  function takeSample(): void {
    if (!sampleAvailable) return
    sampleAvailable = false
    if (beam) {
      beam.remove()
      beam = null
    }
    ctx.events.emit('sampleTaken', NO_PAYLOAD)
  }

  /* ── 受伤与射线 ── */

  /** 按部位与弱点窗口结算伤害，返回实际扣血量（不超过剩余血量）。命中特效由开枪方负责，这里用不到 DamageInfo */
  function applyDamage(amount: number, zone: BossZone): number {
    if (!alive || amount <= 0) return 0
    const mul = BOSS.damageMul
    let factor: number = mul.body
    let weakHit = false
    if (zone === 'headCore') {
      weakHit = weakWindow === 'head'
      factor = weakHit ? mul.headCoreOpen : mul.headCoreClosed
    } else if (zone === 'backCore') {
      weakHit = weakWindow === 'back'
      if (weakHit) factor = mul.backCoreOpen
    } else if (zone === 'tentacle') {
      factor = mul.tentacle
    }
    const dealt = Math.min(hp, amount * factor)
    hp -= dealt
    rig.flash(zone)
    if (weakHit && hurtCooldown <= 0) {
      hurtCooldown = HURT_SFX_INTERVAL
      ctx.audio.play('boss_hurt', sfxAt)
    }
    if (hp <= 0) die()
    return dealt
  }

  /** 对命中球逐个求交。核心嵌在身体表面，射线两者都穿过且核心更近或只稍远一点时判为核心 */
  function raycast(origin: Vector3, dir: Vector3, maxDist: number): RayHit | null {
    if (!alive) return null
    const spheres = rig.getHitSpheres()
    let bodyIndex = -1
    let bodyDist = Infinity
    let coreIndex = -1
    let coreDist = Infinity
    for (let i = 0; i < spheres.length; i++) {
      const sphere = spheres[i]
      if (!sphere) continue
      const t = raySphere(origin, dir, sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius)
      if (t < 0 || t > maxDist) continue
      if (sphere.zone === 'headCore' || sphere.zone === 'backCore') {
        if (t < coreDist) {
          coreDist = t
          coreIndex = i
        }
      } else if (t < bodyDist) {
        bodyDist = t
        bodyIndex = i
      }
    }

    let index = bodyIndex
    let dist = bodyDist
    const core = coreIndex >= 0 ? spheres[coreIndex] : undefined
    if (core && (bodyIndex < 0 || coreDist <= bodyDist + core.radius * CORE_PRIORITY_RATIO)) {
      index = coreIndex
      dist = coreDist
    }
    const hit = index >= 0 ? spheres[index] : undefined
    if (!hit) return null

    rayHit.distance = dist
    rayHit.point.copy(dir).multiplyScalar(dist).add(origin)
    rayHit.normal.copy(rayHit.point).sub(hit.center)
    if (rayHit.normal.lengthSq() > 1e-8) rayHit.normal.normalize()
    else rayHit.normal.copy(dir).negate()
    rayHit.bossZone = hit.zone
    return rayHit
  }

  function aimPoint(out: Vector3): Vector3 {
    return weakWindow === 'back' ? rig.backCoreWorld(out) : rig.headCoreWorld(out)
  }

  /* ── 每帧更新 ── */

  function update(dt: number): void {
    if (state === 'hidden') return
    if (hurtCooldown > 0) hurtCooldown -= dt
    if (!alive) {
      updateDeath(dt)
      return
    }

    summonTimer -= dt
    if (enraged) shockTimer -= dt
    retargetTimer -= dt
    if (retargetTimer <= 0 || !target || target.status !== 'alive') {
      retargetTimer = RETARGET_INTERVAL
      pickTarget()
    }
    updatePools(dt)
    updateWave(dt)

    // 登场途中不转阶段，爬到位后再触发
    if (!enraged && state !== 'emerge' && hp <= BOSS.maxHp * BOSS.phase2Ratio) beginRoar()

    switch (state) {
      case 'emerge':
        updateEmerge(dt)
        break
      case 'gap':
        updateGap(dt)
        break
      case 'sweep':
      case 'stab':
      case 'spit':
        updateAttack(dt)
        break
      case 'stagger':
      case 'roar':
      case 'prone':
        updateHold(dt)
        break
      case 'shock':
        updateShock(dt)
        break
      default:
        break
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    state = 'hidden'
    alive = false
    weakWindow = 'none'
    warning = ''
    sampleAvailable = false
    target = null
    waveActive = false
    clearPools()
    if (beam) {
      beam.remove()
      beam = null
    }
    ctx.scene.remove(rig.root)
    rig.dispose()
  }

  return {
    get active(): boolean {
      return state !== 'hidden'
    },
    get alive(): boolean {
      return alive
    },
    get hp(): number {
      return hp
    },
    maxHp: BOSS.maxHp,
    get phase(): 1 | 2 {
      return phase
    },
    get weakWindow(): BossWeakWindow {
      return weakWindow
    },
    position,
    radius: BOSS.radius,
    get warning(): string {
      return warning
    },
    get sampleAvailable(): boolean {
      return sampleAvailable
    },
    samplePoint,
    spawn,
    raycast,
    applyDamage,
    aimPoint,
    poisonPools: pools,
    takeSample,
    update,
    dispose,
  }
}

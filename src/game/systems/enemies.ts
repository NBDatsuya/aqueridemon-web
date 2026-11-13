/**
 * 丧尸与波次管理器。
 *
 * - 对象池：三种丧尸各一个池，模型在第一次需要时才创建，死亡下沉后 rig.reset() 回收复用。
 * - 波次：startWave 按 WAVES 生成分批刷新队列；刷新受同屏上限、刷新点冷却、与小队的最小距离约束。
 * - AI：追最近的存活成员（runner 偏好落单者），world.steer 避障 + 丧尸间分离；远处的丧尸降频决策。
 * - 命中：头部球 + 身体胶囊，RayHit 复用同一个内部对象。
 *
 * 每帧路径不分配对象：临时向量、动画输入、音效参数都在工厂内创建一次后复用。
 * 单只丧尸的状态与手感参数见 enemy-actor.ts。
 */

import { Vector3 } from 'three'
import {
  FIELD,
  RUNNER_DODGE_CHANCE,
  SCALING_SPEED_RATIO,
  SPAWN_POINTS,
  SPAWN_RULES,
  WAVES,
  waveScaling,
} from '../core/config'
import type {
  Combatant,
  DamageInfo,
  EnemyActor,
  EnemySystem,
  EnemyType,
  GameContext,
  HumanoidAnimInput,
  RayHit,
  SfxId,
  SfxOptions,
  SpawnSide,
} from '../core/types'
import { clamp, damp, dampAngle, distXZSq, rayCapsule, raySphere, yawOf } from '../utils/math'
import { ENEMY_TUNING as TUNE, Zombie } from './enemy-actor'

/** 同一批内展开类型的固定顺序（展开后再用 ctx.rng 打乱） */
const TYPE_ORDER: readonly EnemyType[] = ['common', 'runner', 'tank']
const SIDES: readonly SpawnSide[] = ['north', 'east', 'south', 'west']

const GROAN_SFX: Record<EnemyType, SfxId> = {
  common: 'zombie_groan',
  runner: 'runner_screech',
  tank: 'tank_roar',
}
const ATTACK_SFX: Record<EnemyType, SfxId> = {
  common: 'zombie_attack',
  runner: 'runner_attack',
  tank: 'tank_slam',
}
const DEATH_SFX: Record<EnemyType, SfxId> = {
  common: 'zombie_die',
  runner: 'zombie_die',
  tank: 'tank_die',
}
/** 首次锁定附近目标时的嘶吼 */
const ALERT_SFX: Record<EnemyType, SfxId> = {
  common: 'zombie_alert',
  runner: 'runner_screech',
  tank: 'tank_roar',
}
const HURT_SFX: Record<EnemyType, SfxId> = {
  common: 'zombie_hurt',
  runner: 'runner_hurt',
  tank: 'tank_hurt',
}
/** 脚步：音效、步距（米）、音量 */
const STEP_SFX: Record<EnemyType, { id: SfxId; stride: number; volume: number }> = {
  common: { id: 'zombie_step', stride: TUNE.commonStride, volume: 0.5 },
  runner: { id: 'zombie_step', stride: TUNE.runnerStride, volume: 0.6 },
  tank: { id: 'tank_step', stride: TUNE.tankStride, volume: 0.75 },
}
/** 各类型嗓音音高倍率的随机范围（runner 更尖、tank 变化更小） */
const VOICE_PITCH: Record<EnemyType, readonly [number, number]> = {
  common: [0.88, 1.12],
  runner: [1.02, 1.2],
  tank: [0.94, 1.06],
}

/** 被挡住时侧向绕行的偏转角（约 70°） */
const DETOUR_ANGLE = 1.2
const DETOUR_COS = Math.cos(DETOUR_ANGLE)
const DETOUR_SIN = Math.sin(DETOUR_ANGLE)

/** 没有目标时的游荡节奏（补充，config 未给出） */
const WANDER = {
  /** 每次重新决定时原地停一会儿的概率 */
  pauseChance: 0.4,
  pauseMin: 1.5,
  pauseMax: 3.5,
  walkMin: 2.5,
  walkMax: 5,
  /** 落点离当前位置的最小距离（米） */
  reachMin: 2,
  /** 还在场外时，往场内走的最长时间范围（秒） */
  enterMin: 6,
  enterMax: 10,
  /** 进场落点收缩到场地中部的比例 */
  enterSpread: 0.6,
} as const

/**
 * 创建丧尸系统（含波次管理器）。
 * @param ctx 游戏上下文。工厂内只用 scene / rng / events / models / audio；world、player、boss、effects、combatants 在 update 及之后才访问
 * @returns 丧尸系统
 */
export function createEnemies(ctx: GameContext): EnemySystem {
  /** AI 抖动、音效随机等用独立子序列，不扰动刷新相关的 ctx.rng 序列 */
  const noise = ctx.rng.fork()

  /** 存活的丧尸 */
  const active: Zombie[] = []
  /** 已死亡、还在播倒地与下沉的丧尸 */
  const dying: Zombie[] = []
  /** 创建过的全部实体（dispose 时释放模型） */
  const created: Zombie[] = []
  const pools: Record<EnemyType, Zombie[]> = { common: [], runner: [], tank: [] }

  /** 各刷新点的剩余冷却，下标与 SPAWN_POINTS 一致 */
  const pointCooldown: number[] = SPAWN_POINTS.map(() => 0)
  /** 已投入、等待刷出的本波丧尸 */
  const pending: EnemyType[] = []
  /** spawnExtra 排队中的丧尸 */
  const extraPending: EnemyType[] = []
  /** 本波各批的类型列表（已打乱）与投入时间 */
  let stageQueues: EnemyType[][] = []
  let stageAt: number[] = []
  let nextStage = 0

  let waveActive = false
  let wave = 0
  let waveTotal = 0
  let waveKilled = 0
  let waveSpawned = 0
  let waveTime = 0
  /** 每次 startWave 自增，用来区分丧尸属于哪一次波次 */
  let waveSerial = 0
  let mainSide: SpawnSide = 'north'

  let spawnGap = 0
  let nextId = 1
  let frame = 0
  /** 全场低吼、发现、攻击与中弹音效的节流计时 */
  let groanGap = 0
  let alertSfxGap = 0
  let attackSfxGap = 0
  let hurtSfxGap = 0

  const tmpDir = new Vector3()
  const tmpTo = new Vector3()
  const hit: RayHit = { distance: 0, point: new Vector3(), normal: new Vector3(), kind: 'enemy', headshot: false }
  const anim: HumanoidAnimInput = { speed: 0, pose: 'stand', action: 'none', actionProgress: 0 }
  /** 音效参数与发声位置：audio.play 同步读取，可以复用 */
  const sfxPos = new Vector3()
  const sfx: SfxOptions = { position: sfxPos, volume: 1, rate: 1 }

  /* ── 音效 ── */

  /** 丧尸到主控（听者）的水平距离平方 */
  const listenerDistSq = (z: Zombie): number => distXZSq(z.position, ctx.player.actor.position)

  /**
   * 在丧尸所在位置播放音效（复用同一个参数对象，带少量变调）。
   * @param voice true：叫声，从嘴部发出并带上这只丧尸的嗓音音高；false：脚步等，从脚底发出
   */
  const playAt = (id: SfxId, z: Zombie, volume: number, voice: boolean): void => {
    const p = z.position
    sfxPos.set(p.x, voice ? p.y + z.height * TUNE.mouthRatio * z.holder.scale.y : p.y, p.z)
    sfx.volume = volume
    sfx.rate = noise.range(0.93, 1.07) * (voice ? z.voicePitch : 1)
    ctx.audio.play(id, sfx)
  }

  /** 低吼（tank 登场时 force，无视全场间隔）。返回是否真的触发了 */
  const groan = (z: Zombie, volume: number, force: boolean): boolean => {
    const distSq = listenerDistSq(z)
    if (!force && distSq > TUNE.hearRange * TUNE.hearRange) return false
    // 近处的丧尸各吼各的；远处的共享全场间隔，避免满场同时哼成一片
    const near = distSq <= TUNE.groanNear * TUNE.groanNear
    if (!force && !near && groanGap > 0) return false
    playAt(GROAN_SFX[z.type], z, volume, true)
    if (!near) groanGap = noise.range(TUNE.groanGapMin, TUNE.groanGapMax)
    return true
  }

  /** 下一次低吼的间隔（runner 的嘶叫更稀） */
  const nextGroan = (z: Zombie): number =>
    noise.range(TUNE.groanMin, TUNE.groanMax) * (z.type === 'runner' ? TUNE.runnerGroanScale : 1)

  /** 首次在 alertRange 内锁定目标：发出“发现”嘶吼（每只每次刷出只一次） */
  const alert = (z: Zombie, target: Combatant): void => {
    if (z.alerted) return
    if (distXZSq(z.position, target.position) > TUNE.alertRange * TUNE.alertRange) return
    z.alerted = true
    if (alertSfxGap > 0 || listenerDistSq(z) > TUNE.hearRange * TUNE.hearRange) return
    playAt(ALERT_SFX[z.type], z, 1, true)
    alertSfxGap = TUNE.alertSfxGap
    // 刚吼完别紧接着再哼一声
    z.groanTimer = Math.max(z.groanTimer, noise.range(2, 3.5))
  }

  /* ── 对象池 ── */

  /** 取一只指定类型的丧尸：池里有就复用，没有才创建模型 */
  const acquire = (type: EnemyType): Zombie => {
    const pooled = pools[type].pop()
    if (pooled) return pooled
    const z = new Zombie(type, ctx.models.createZombie(type, noise.int(0, 0x7fffffff)))
    created.push(z)
    return z
  }

  /** 移出场景并放回对象池 */
  const recycle = (z: Zombie): void => {
    z.alive = false
    z.target = null
    ctx.scene.remove(z.holder)
    z.holder.scale.setScalar(1)
    z.rig.reset()
    pools[z.type].push(z)
  }

  /* ── 刷新 ── */

  /**
   * 选一个可用刷新点：冷却完毕、距所有在场成员大于最小距离；
   * 以 mainSideBias 的概率偏向主刷新方向，其次偏向主控身后；同档内随机。
   * @returns SPAWN_POINTS 下标；没有可用点返回 -1
   */
  const pickSpawnPoint = (): number => {
    const squad = ctx.combatants
    const playerPos = ctx.player.actor.position
    const forward = ctx.player.forward
    const minSq = SPAWN_RULES.minPlayerDistance * SPAWN_RULES.minPlayerDistance
    const wantMain = ctx.rng.chance(SPAWN_RULES.mainSideBias)

    let chosen = -1
    let bestScore = -1
    let ties = 0
    for (let i = 0; i < SPAWN_POINTS.length; i++) {
      const p = SPAWN_POINTS[i]
      const cooldown = pointCooldown[i]
      if (p === undefined || cooldown === undefined || cooldown > 0) continue

      let tooClose = false
      for (let k = 0; k < squad.length; k++) {
        const c = squad[k]
        if (c === undefined || (c.status !== 'alive' && c.status !== 'downed')) continue
        const dx = p.x - c.position.x
        const dz = p.z - c.position.z
        if (dx * dx + dz * dz <= minSq) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      // 在主控身后 180° 内（视野锥外）
      const behind = (p.x - playerPos.x) * forward.x + (p.z - playerPos.z) * forward.z < 0
      let score = behind ? 2 : 0
      if (wantMain && p.side === mainSide) score += 3

      if (score > bestScore) {
        bestScore = score
        chosen = i
        ties = 1
      } else if (score === bestScore) {
        // 同档蓄水池抽样，激活顺序随机
        ties += 1
        if (ctx.rng.next() * ties < 1) chosen = i
      }
    }
    return chosen
  }

  /** 在指定刷新点刷出一只丧尸，并按波次进度应用对数强化 */
  const spawnAt = (type: EnemyType, pointIndex: number, fromWave: boolean): void => {
    const point = SPAWN_POINTS[pointIndex]
    if (point === undefined) return
    const z = acquire(type)
    const def = z.def

    // 进度 = 已刷出数 / 本波总数；额外刷出的不计进度，系数取 1
    const factor = fromWave && waveTotal > 0 ? waveScaling(waveSpawned / waveTotal) : 1
    if (fromWave) waveSpawned += 1

    z.id = nextId++
    z.maxHp = Math.round(def.hp * factor)
    z.hp = z.maxHp
    z.damage = Math.round(def.damage * factor)
    z.speed = def.speed * (1 + (factor - 1) * SCALING_SPEED_RATIO)
    z.waveSerial = fromWave ? waveSerial : 0
    z.alive = true

    z.state = 'move'
    z.target = null
    z.retargetTimer = 0
    z.thinkDt = 0
    z.moveX = 0
    z.moveZ = 0
    z.moveScale = 0
    z.animSpeed = 0
    z.attackTime = 0
    z.attackHit = false
    z.cooldown = 0
    z.dodgeRoll = noise.next()
    z.dodgeTimer = 0
    z.staggerTimer = 0
    z.staggerGap = 0
    z.intended = 0
    z.stuck = 0
    z.detourTimer = 0
    z.wandering = false
    z.wanderTimer = 0
    z.wanderScale = 0
    z.stride = noise.range(0, STEP_SFX[type].stride)
    z.deathTimer = 0
    z.groanTimer = nextGroan(z) * noise.range(0.3, 1)
    z.alerted = false
    z.hurtGap = 0
    const [pitchMin, pitchMax] = VOICE_PITCH[type]
    z.voicePitch = noise.range(pitchMin, pitchMax)

    const pos = z.position
    pos.set(
      point.x + noise.range(-TUNE.spawnJitter, TUNE.spawnJitter),
      0,
      point.z + noise.range(-TUNE.spawnJitter, TUNE.spawnJitter),
    )
    ctx.world.resolveMove(pos, z.radius, 0, false)
    pos.y = ctx.world.groundHeight(pos.x, pos.z, 0)
    z.prevX = pos.x
    z.prevZ = pos.z

    // 面向场地中心，随后由 AI 接管“走进”场地
    z.yaw = yawOf(-pos.x, -pos.z)
    z.wantYaw = z.yaw
    z.holder.rotation.y = z.yaw
    z.holder.scale.setScalar(1)
    ctx.scene.add(z.holder)
    active.push(z)
    pointCooldown[pointIndex] = SPAWN_RULES.pointCooldown

    if (type === 'tank') groan(z, 1, true)
    else if (noise.chance(TUNE.spawnGroanChance)) groan(z, 0.7, false)
  }

  /** 推进波次时间，把到点（或可以提前）的批次投入待刷队列 */
  const updateStages = (dt: number): void => {
    if (!waveActive) return
    waveTime += dt
    while (nextStage < stageQueues.length) {
      const batch = stageQueues[nextStage]
      const at = stageAt[nextStage]
      if (batch === undefined || at === undefined) break
      const due = waveTime >= at
      // 上一批已全部刷出且场上所剩无几：提前投入，保持压力
      const early = nextStage > 0 && pending.length === 0 && active.length <= SPAWN_RULES.earlyStageAtAlive
      if (!due && !early) break
      for (let i = 0; i < batch.length; i++) {
        const type = batch[i]
        if (type !== undefined) pending.push(type)
      }
      nextStage += 1
      if (!due) break
    }
  }

  /** 按间隔从队列里刷出下一只（Boss 召唤的优先） */
  const updateSpawning = (dt: number): void => {
    for (let i = 0; i < pointCooldown.length; i++) {
      const cooldown = pointCooldown[i]
      if (cooldown !== undefined && cooldown > 0) pointCooldown[i] = cooldown - dt
    }
    if (spawnGap > 0) {
      spawnGap -= dt
      return
    }
    if (active.length >= SPAWN_RULES.maxConcurrent) return
    const fromExtra = extraPending.length > 0
    const queue = fromExtra ? extraPending : pending
    if (queue.length === 0) return

    const pointIndex = pickSpawnPoint()
    if (pointIndex < 0) {
      spawnGap = TUNE.spawnRetry
      return
    }
    const type = queue.shift()
    if (type === undefined) return
    spawnAt(type, pointIndex, !fromExtra)
    spawnGap = ctx.rng.range(TUNE.spawnGapMin, TUNE.spawnGapMax)
  }

  /* ── AI：决策 ── */

  /** who 周围 isolationRadius 内是否没有其他存活队友 */
  const isIsolated = (who: Combatant): boolean => {
    const squad = ctx.combatants
    const radiusSq = TUNE.isolationRadius * TUNE.isolationRadius
    for (let i = 0; i < squad.length; i++) {
      const c = squad[i]
      if (c === undefined || c === who || c.status !== 'alive') continue
      if (distXZSq(c.position, who.position) <= radiusSq) return false
    }
    return true
  }

  /** 选目标：最近的存活成员；runner 给落单者的距离打折；当前目标略有粘性 */
  const pickTarget = (z: Zombie): Combatant | null => {
    const squad = ctx.combatants
    let best: Combatant | null = null
    let bestScore = Infinity
    for (let i = 0; i < squad.length; i++) {
      const c = squad[i]
      if (c === undefined || c.status !== 'alive') continue
      let score = Math.sqrt(distXZSq(z.position, c.position))
      if (z.type === 'runner' && isIsolated(c)) score *= TUNE.isolatedWeight
      if (c === z.target) score *= TUNE.stickyWeight
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    return best
  }

  /** 没有存活目标：还在场外就先走进场地，否则在附近走走停停 */
  const thinkWander = (z: Zombie, dt: number): void => {
    const pos = z.position
    if (!z.wandering) {
      z.wandering = true
      z.wanderTimer = 0
    }
    z.wanderTimer -= dt
    if (z.wanderTimer <= 0) {
      const limitX = FIELD.halfX - TUNE.fieldMargin
      const limitZ = FIELD.halfZ - TUNE.fieldMargin
      if (Math.abs(pos.x) > limitX || Math.abs(pos.z) > limitZ) {
        z.wanderX = noise.range(-limitX, limitX) * WANDER.enterSpread
        z.wanderZ = noise.range(-limitZ, limitZ) * WANDER.enterSpread
        z.wanderScale = 1
        z.wanderTimer = noise.range(WANDER.enterMin, WANDER.enterMax)
      } else if (noise.chance(WANDER.pauseChance)) {
        z.wanderScale = 0
        z.wanderTimer = noise.range(WANDER.pauseMin, WANDER.pauseMax)
      } else {
        const angle = noise.range(0, Math.PI * 2)
        const reach = noise.range(WANDER.reachMin, TUNE.wanderRadius)
        z.wanderX = clamp(pos.x + Math.sin(angle) * reach, -limitX, limitX)
        z.wanderZ = clamp(pos.z + Math.cos(angle) * reach, -limitZ, limitZ)
        z.wanderScale = TUNE.wanderSpeed
        z.wanderTimer = noise.range(WANDER.walkMin, WANDER.walkMax)
      }
    }

    if (z.wanderScale <= 0) {
      z.moveScale = 0
      return
    }
    const dx = z.wanderX - pos.x
    const dz = z.wanderZ - pos.z
    if (dx * dx + dz * dz < TUNE.wanderArrive * TUNE.wanderArrive) {
      z.wanderScale = 0
      z.moveScale = 0
      return
    }
    tmpTo.set(z.wanderX, pos.y, z.wanderZ)
    ctx.world.steer(pos, tmpTo, z.radius, tmpDir)
    z.moveX = tmpDir.x
    z.moveZ = tmpDir.z
    z.moveScale = z.wanderScale
  }

  /** 进入攻击：开始前摇，并从此刻起算攻击间隔 */
  const beginAttack = (z: Zombie): void => {
    z.state = 'attack'
    z.attackTime = 0
    z.attackHit = false
    z.cooldown = z.def.attackInterval
    z.moveScale = 0
    // tank 的砸地声在击中瞬间播；其余在出手时播，并做全场节流
    if (z.type !== 'tank' && attackSfxGap <= 0) {
      playAt(ATTACK_SFX[z.type], z, 1, true)
      attackSfxGap = TUNE.attackSfxGap
    }
  }

  /**
   * 决策：重选目标、runner 摆动判定、给出移动方向或发起攻击。
   * 远处的丧尸隔几帧才调用一次，dt 是累积值。
   */
  const think = (z: Zombie, dt: number): void => {
    z.retargetTimer -= dt
    const current = z.target
    if (z.retargetTimer <= 0 || (current !== null && current.status !== 'alive')) {
      z.target = pickTarget(z)
      z.retargetTimer = TUNE.retargetInterval * noise.range(0.8, 1.2)
    }
    const target = z.target
    if (target !== null && !z.alerted) alert(z, target)

    if (z.type === 'runner') {
      // 每满 1 秒掷一次：触发约 0.5 秒的左右横向摆动
      z.dodgeRoll += dt
      if (z.dodgeRoll >= 1) {
        z.dodgeRoll -= Math.floor(z.dodgeRoll)
        const minSq = TUNE.dodgeMinDistance * TUNE.dodgeMinDistance
        if (
          target !== null &&
          z.dodgeTimer <= 0 &&
          distXZSq(z.position, target.position) > minSq &&
          noise.chance(RUNNER_DODGE_CHANCE)
        ) {
          z.dodgeTimer = TUNE.dodgeDuration
          z.dodgeSide = noise.sign()
        }
      }
    }

    if (z.state !== 'move') return
    if (target === null) {
      thinkWander(z, dt)
      return
    }
    z.wandering = false

    const dx = target.position.x - z.position.x
    const dz = target.position.z - z.position.z
    const surface = Math.hypot(dx, dz) - z.radius - target.radius
    if (surface <= z.def.attackReach && z.cooldown <= 0) {
      z.wantYaw = yawOf(dx, dz)
      beginAttack(z)
      return
    }
    if (surface <= z.def.attackReach * TUNE.stopRatio) {
      // 已经贴身但攻击还在冷却：站定面向目标
      z.wantYaw = yawOf(dx, dz)
      z.moveScale = 0
      return
    }
    ctx.world.steer(z.position, target.position, z.radius, tmpDir)
    z.moveX = tmpDir.x
    z.moveZ = tmpDir.z
    z.moveScale = 1
  }

  /* ── AI：每帧推进 ── */

  /** 前摇结束的结算：目标仍在范围内且够得着才造成伤害；tank 附带击退 */
  const strike = (z: Zombie): void => {
    if (z.type === 'tank') playAt(ATTACK_SFX.tank, z, 1, false)
    const target = z.target
    if (target === null || target.status !== 'alive') return
    const dx = target.position.x - z.position.x
    const dz = target.position.z - z.position.z
    const surface = Math.hypot(dx, dz) - z.radius - target.radius
    if (surface > z.def.attackReach + TUNE.hitGrace) return
    // 目标跳上了看台之类的高处，够不着
    if (Math.abs(target.position.y - z.position.y) > TUNE.maxReachHeight) return
    if (!target.takeDamage(z.damage, z.type)) return
    if (z.def.knockback > 0) target.applyKnockback(dx, dz, z.def.knockback)
  }

  /** 攻击状态机：前摇（面向目标）→ 结算 → 收招 → 回到移动 */
  const updateAttack = (z: Zombie, dt: number): void => {
    z.attackTime += dt
    const windup = z.def.windup
    if (z.attackTime < windup) {
      const target = z.target
      if (target !== null && target.status === 'alive') {
        z.wantYaw = yawOf(target.position.x - z.position.x, target.position.z - z.position.z)
      }
      return
    }
    if (!z.attackHit) {
      z.attackHit = true
      strike(z)
    }
    if (z.attackTime >= windup + z.recover) z.state = 'move'
  }

  /** 每帧推进计时、攻击与位移（方向沿用最近一次决策） */
  const advance = (z: Zombie, dt: number): void => {
    const pos = z.position
    z.prevX = pos.x
    z.prevZ = pos.z
    z.intended = 0
    if (z.cooldown > 0) z.cooldown -= dt
    if (z.staggerTimer > 0) z.staggerTimer -= dt
    if (z.staggerGap > 0) z.staggerGap -= dt
    if (z.dodgeTimer > 0) z.dodgeTimer -= dt
    if (z.detourTimer > 0) z.detourTimer -= dt
    if (z.hurtGap > 0) z.hurtGap -= dt

    let speed = 0
    if (z.state === 'attack') {
      updateAttack(z, dt)
    } else if (z.moveScale > 0 && z.staggerTimer <= 0) {
      speed = z.speed * z.moveScale
      let dirX = z.moveX
      let dirZ = z.moveZ
      if (z.detourTimer > 0) {
        // 被挡住了：朝一侧偏转着走一小段
        const sin = DETOUR_SIN * z.detourSide
        dirX = z.moveX * DETOUR_COS - z.moveZ * sin
        dirZ = z.moveX * sin + z.moveZ * DETOUR_COS
      }
      let vx = dirX * speed
      let vz = dirZ * speed
      if (z.dodgeTimer > 0) {
        // runner 摆动：先向一侧再向另一侧，净位移接近 0
        const phase = 1 - z.dodgeTimer / TUNE.dodgeDuration
        const lateral = Math.sin(phase * Math.PI * 2) * z.dodgeSide * z.speed * TUNE.dodgeLateral
        vx += dirZ * lateral
        vz -= dirX * lateral
      }
      pos.x += vx * dt
      pos.z += vz * dt
      z.intended = speed * dt
      if (dirX !== 0 || dirZ !== 0) z.wantYaw = yawOf(dirX, dirZ)

      // 脚步：按走过的距离触发；游荡时步子轻一些。远处的不发（tank 的脚步传得更远）
      const step = STEP_SFX[z.type]
      z.stride += z.intended
      if (z.stride >= step.stride) {
        z.stride -= step.stride
        const range = z.type === 'tank' ? TUNE.hearRange : TUNE.stepHearRange
        if (listenerDistSq(z) <= range * range) playAt(step.id, z, step.volume * (0.6 + 0.4 * z.moveScale), false)
      }
    }
    z.animSpeed = damp(z.animSpeed, speed, TUNE.animRate, dt)
  }

  /** 丧尸两两分离：重叠的互相推开，体型大的被推得少 */
  const separate = (dt: number): void => {
    const rate = Math.min(1, TUNE.separationRate * dt)
    for (let i = 0; i < active.length; i++) {
      const a = active[i]
      if (a === undefined) continue
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j]
        if (b === undefined) continue
        const min = a.radius + b.radius + TUNE.separationPad
        const dx = a.position.x - b.position.x
        const dz = a.position.z - b.position.z
        const distSq = dx * dx + dz * dz
        if (distSq >= min * min) continue
        if (Math.abs(a.position.y - b.position.y) > TUNE.maxReachHeight) continue

        const dist = Math.sqrt(distSq)
        let nx = 0
        let nz = 0
        if (dist < 1e-4) {
          // 完全重合：用 id 给一个确定的推开方向
          const angle = a.id * 2.399963
          nx = Math.sin(angle)
          nz = Math.cos(angle)
        } else {
          nx = dx / dist
          nz = dz / dist
        }
        const push = (min - dist) * rate
        const share = b.radius / (a.radius + b.radius)
        a.position.x += nx * push * share
        a.position.z += nz * push * share
        b.position.x -= nx * push * (1 - share)
        b.position.z -= nz * push * (1 - share)
      }
    }
  }

  /** 把 pos 推到以 (cx, cz) 为圆心、半径 minDist 的圆外 */
  const pushOut = (pos: Vector3, cx: number, cz: number, minDist: number): void => {
    const dx = pos.x - cx
    const dz = pos.z - cz
    const distSq = dx * dx + dz * dz
    if (distSq >= minDist * minDist) return
    const dist = Math.sqrt(distSq)
    if (dist < 1e-4) {
      pos.x = cx + minDist
      return
    }
    const k = minDist / dist
    pos.x = cx + dx * k
    pos.z = cz + dz * k
  }

  /** 位移之后的收尾：不与小队 / Boss 重叠、世界碰撞、贴地、转向、动画、低吼 */
  const settle = (z: Zombie, dt: number): void => {
    const pos = z.position
    const squad = ctx.combatants
    for (let i = 0; i < squad.length; i++) {
      const c = squad[i]
      if (c === undefined || (c.status !== 'alive' && c.status !== 'downed')) continue
      if (Math.abs(c.position.y - pos.y) > TUNE.maxReachHeight) continue
      pushOut(pos, c.position.x, c.position.z, z.radius + c.radius)
    }
    const boss = ctx.boss
    if (boss.active && boss.alive) pushOut(pos, boss.position.x, boss.position.z, boss.radius + z.radius)

    // feetY 传当前脚底高度：平地上就是 0，站在台阶上时才能继续踏上更高一级
    ctx.world.resolveMove(pos, z.radius, pos.y, false)
    const ground = ctx.world.groundHeight(pos.x, pos.z, pos.y)
    pos.y = Math.abs(ground - pos.y) < 0.01 ? ground : damp(pos.y, ground, TUNE.heightRate, dt)

    // 想走却几乎没动：累计一段时间后侧向绕行
    if (z.intended > 1e-5) {
      const moved = Math.hypot(pos.x - z.prevX, pos.z - z.prevZ)
      if (moved < z.intended * TUNE.stuckRatio) z.stuck += dt
      else if (z.stuck > 0) z.stuck = Math.max(0, z.stuck - dt * 2)
      if (z.stuck >= TUNE.stuckTime) {
        z.stuck = 0
        z.detourTimer = TUNE.detourTime
        z.detourSide = noise.sign()
      }
    }

    z.yaw = dampAngle(z.yaw, z.wantYaw, TUNE.turnRate, dt)
    z.holder.rotation.y = z.yaw

    anim.speed = z.animSpeed
    anim.pose = 'stand'
    if (z.state === 'attack') {
      anim.action = 'attack'
      anim.actionProgress = z.attackProgress()
    } else {
      anim.action = 'none'
      anim.actionProgress = 0
    }
    z.rig.update(dt, anim)

    z.groanTimer -= dt
    if (z.groanTimer <= 0) {
      // 被全场间隔挡住或听不见时稍后再试，而不是白白等一整个低吼周期
      z.groanTimer = groan(z, z.state === 'attack' ? 0.8 : 1, false)
        ? nextGroan(z)
        : noise.range(TUNE.groanRetryMin, TUNE.groanRetryMax)
    }
  }

  /* ── 死亡与回收 ── */

  /** 击杀：移出 active、计数、音效、血迹、事件，然后进入倒地流程 */
  const kill = (z: Zombie, info: DamageInfo): void => {
    z.alive = false
    const index = active.indexOf(z)
    if (index >= 0) active.splice(index, 1)
    z.state = 'dying'
    z.target = null
    z.deathTimer = 0
    z.deathY = z.position.y
    dying.push(z)
    if (waveActive && z.waveSerial === waveSerial) waveKilled += 1

    playAt(DEATH_SFX[z.type], z, 1, true)
    // 丧尸的 position 会随对象池复用，事件与贴花拿一份拷贝
    const where = z.position.clone()
    ctx.effects.bloodDecal(where)
    ctx.events.emit('enemyKilled', { type: z.type, attacker: info.attacker, headshot: info.headshot, position: where })
  }

  /** 倒地停留一会儿，然后下沉缩小，结束后回收到对象池 */
  const updateDying = (dt: number): void => {
    for (let i = dying.length - 1; i >= 0; i--) {
      const z = dying[i]
      if (z === undefined) continue
      z.deathTimer += dt
      anim.speed = 0
      anim.pose = 'dead'
      anim.action = 'none'
      anim.actionProgress = 0
      z.rig.update(dt, anim)

      const sink = (z.deathTimer - TUNE.deathLie) / TUNE.deathSink
      if (sink <= 0) continue
      if (sink >= 1) {
        const last = dying.pop()
        if (last !== undefined && last !== z) dying[i] = last
        recycle(z)
        continue
      }
      const eased = sink * sink
      z.position.y = z.deathY - eased * TUNE.deathSinkDepth * z.def.scale
      z.holder.scale.setScalar(1 - (1 - TUNE.deathShrink) * eased)
    }
  }

  /** 队列刷完且本波丧尸全部死亡（倒地动画没播完的不算存活）：波次结束 */
  const checkWaveCleared = (): void => {
    if (!waveActive || nextStage < stageQueues.length || pending.length > 0) return
    for (let i = 0; i < active.length; i++) {
      const z = active[i]
      if (z !== undefined && z.waveSerial === waveSerial) return
    }
    waveActive = false
    ctx.events.emit('waveCleared', { wave })
  }

  /* ── 对外接口 ── */

  const startWave = (waveNumber: number): void => {
    const def = WAVES[waveNumber - 1]
    if (def === undefined) return

    pending.length = 0
    stageQueues = []
    stageAt = []
    let total = 0
    for (const stage of def.stages) {
      const batch: EnemyType[] = []
      for (const type of TYPE_ORDER) {
        const count = stage.spawn[type] ?? 0
        for (let i = 0; i < count; i++) batch.push(type)
      }
      ctx.rng.shuffle(batch)
      stageQueues.push(batch)
      stageAt.push(stage.at)
      total += batch.length
    }

    waveSerial += 1
    wave = waveNumber
    waveTotal = total
    waveKilled = 0
    waveSpawned = 0
    waveTime = 0
    nextStage = 0
    waveActive = true
    mainSide = ctx.rng.pick(SIDES)
    ctx.events.emit('waveStarted', { wave: waveNumber, total })
  }

  const spawnExtra = (type: EnemyType, count: number): void => {
    for (let i = 0; i < count; i++) extraPending.push(type)
  }

  const raycast = (origin: Vector3, dir: Vector3, maxDist: number): RayHit | null => {
    let best: Zombie | null = null
    let bestDist = maxDist
    let bestHead = false
    for (let i = 0; i < active.length; i++) {
      const z = active[i]
      if (z === undefined) continue
      const pos = z.position
      const headRadius = z.headHitRadius()
      const headY = pos.y + z.rig.headHeight * z.holder.scale.y
      const headDist = raySphere(origin, dir, pos.x, headY, pos.z, headRadius)
      const bodyDist = rayCapsule(origin, dir, pos.x, pos.y, pos.z, z.radius, z.bodyHitHeight())

      let dist = -1
      let head = false
      // 两者都命中时取近的；颈部重叠区略偏向头部
      if (headDist >= 0 && (bodyDist < 0 || headDist <= bodyDist + headRadius * TUNE.headBias)) {
        dist = headDist
        head = true
      } else if (bodyDist >= 0) {
        dist = bodyDist
      }
      if (dist < 0 || dist > bestDist) continue
      best = z
      bestDist = dist
      bestHead = head
    }
    if (best === null) return null

    hit.distance = bestDist
    hit.point.copy(dir).multiplyScalar(bestDist).add(origin)
    if (bestHead) {
      best.headCenter(hit.normal)
      hit.normal.subVectors(hit.point, hit.normal)
    } else {
      hit.normal.set(hit.point.x - best.position.x, 0, hit.point.z - best.position.z)
    }
    if (hit.normal.lengthSq() < 1e-8) hit.normal.copy(dir).negate()
    hit.normal.normalize()
    hit.enemy = best
    hit.headshot = bestHead
    return hit
  }

  const applyDamage = (enemy: EnemyActor, amount: number, info: DamageInfo): void => {
    if (!(enemy instanceof Zombie) || !enemy.alive || amount <= 0) return
    enemy.hp -= amount
    enemy.rig.flash()
    if (enemy.hp <= 0) {
      enemy.hp = 0
      kill(enemy, info)
      return
    }
    // 中弹闷哼：单只与全场都有间隔，扫射时不会连成一片；被打了也就算“发现”了
    enemy.alerted = true
    if (enemy.hurtGap <= 0 && hurtSfxGap <= 0) {
      playAt(HURT_SFX[enemy.type], enemy, 0.9, true)
      enemy.hurtGap = noise.range(TUNE.hurtGapMin, TUNE.hurtGapMax)
      hurtSfxGap = TUNE.hurtSfxGap
    }
    // 极短的受击停顿（tank 不吃）；带最小间隔，连射不会把它钉死
    if (enemy.type !== 'tank' && enemy.staggerGap <= 0) {
      enemy.staggerTimer = TUNE.hitStagger
      enemy.staggerGap = TUNE.staggerGap
    }
  }

  const nearest = (pos: Vector3, maxDist: number): EnemyActor | null => {
    let best: Zombie | null = null
    let bestSq = maxDist * maxDist
    for (let i = 0; i < active.length; i++) {
      const z = active[i]
      if (z === undefined) continue
      const distSq = distXZSq(pos, z.position)
      if (distSq > bestSq) continue
      bestSq = distSq
      best = z
    }
    return best
  }

  const countWithin = (pos: Vector3, radius: number): number => {
    const radiusSq = radius * radius
    let count = 0
    for (let i = 0; i < active.length; i++) {
      const z = active[i]
      if (z !== undefined && distXZSq(pos, z.position) <= radiusSq) count += 1
    }
    return count
  }

  const clearAll = (): void => {
    for (const z of active) recycle(z)
    for (const z of dying) recycle(z)
    active.length = 0
    dying.length = 0
    pending.length = 0
    extraPending.length = 0
    stageQueues = []
    stageAt = []
    nextStage = 0
    spawnGap = 0
    // 清场不算通关：直接结束波次，不发 waveCleared
    waveActive = false
  }

  const update = (dt: number): void => {
    if (dt <= 0) return
    frame += 1
    if (groanGap > 0) groanGap -= dt
    if (alertSfxGap > 0) alertSfxGap -= dt
    if (attackSfxGap > 0) attackSfxGap -= dt
    if (hurtSfxGap > 0) hurtSfxGap -= dt

    updateStages(dt)
    updateSpawning(dt)

    // 远处的丧尸每 farUpdateEvery 帧决策一次（按 id 错开），位移仍然每帧
    const playerPos = ctx.player.actor.position
    const farSq = SPAWN_RULES.farDistance * SPAWN_RULES.farDistance
    for (let i = 0; i < active.length; i++) {
      const z = active[i]
      if (z === undefined) continue
      z.thinkDt += dt
      const far = distXZSq(z.position, playerPos) > farSq
      if (!far || (frame + z.id) % SPAWN_RULES.farUpdateEvery === 0) {
        think(z, z.thinkDt)
        z.thinkDt = 0
      }
      advance(z, dt)
    }

    separate(dt)
    for (let i = 0; i < active.length; i++) {
      const z = active[i]
      if (z !== undefined) settle(z, dt)
    }

    updateDying(dt)
    checkWaveCleared()
  }

  const dispose = (): void => {
    clearAll()
    for (const z of created) {
      ctx.scene.remove(z.holder)
      z.holder.remove(z.rig.root)
      z.rig.dispose()
    }
    created.length = 0
    pools.common.length = 0
    pools.runner.length = 0
    pools.tank.length = 0
  }

  return {
    get active(): readonly EnemyActor[] {
      return active
    },
    get waveActive(): boolean {
      return waveActive
    },
    get wave(): number {
      return wave
    },
    get waveTotal(): number {
      return waveTotal
    },
    get waveKilled(): number {
      return waveKilled
    },
    startWave,
    spawnExtra,
    raycast,
    applyDamage,
    nearest,
    countWithin,
    clearAll,
    update,
    dispose,
  }
}

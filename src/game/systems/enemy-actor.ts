/**
 * 单只丧尸的运行时状态（对象池复用的实体）。
 *
 * 这里只有数据、瞄准点计算与手感参数；刷新、AI、命中与波次逻辑都在 enemies.ts。
 * 模型挂在自己的 holder 上：位置、朝向与下沉缩放只改 holder，不碰 rig.root 的变换，
 * 这样 rig 内部怎么摆姿态都不会和这里冲突。
 */

import { Group } from 'three'
import type { Vector3 } from 'three'
import { ENEMIES } from '../core/config'
import type { Combatant, EnemyActor, EnemyDef, EnemyType, HumanoidRig } from '../core/types'

/** move 追击 / 游荡；attack 前摇与收招；dying 倒地等待回收 */
export type ZombieState = 'move' | 'attack' | 'dying'

/**
 * 丧尸手感参数。玩法数值都在 core/config.ts，这里是 config 没有给出的补充项
 * （动画时长、节流间隔、推开力度等）。
 */
export const ENEMY_TUNING = {
  /** 头部命中球相对模型头部的放大倍率 */
  headRadiusScale: 1.15,
  /** 头部球与身体胶囊在颈部重叠时，头部优先的距离容差（× 头部半径） */
  headBias: 0.5,
  /** 躯干瞄准点高度占总身高的比例 */
  aimHeightRatio: 0.6,

  /** 目标重选间隔（秒） */
  retargetInterval: 0.5,
  /** runner 判定“落单”的半径：该范围内没有其他存活队友 */
  isolationRadius: 8,
  /** 落单目标的距离权重（越小越优先） */
  isolatedWeight: 0.5,
  /** 当前目标的距离权重，避免在两个目标之间来回切换 */
  stickyWeight: 0.85,

  /** 与目标表面距离小于 attackReach × 该值时停步 */
  stopRatio: 0.6,
  /** 前摇结束时，目标在 attackReach + 该值内才结算伤害（米） */
  hitGrace: 0.6,
  /** 与目标的高度差超过该值视为够不着（米） */
  maxReachHeight: 1.2,
  /** 收招时长 = 前摇 × 该值（不少于 recoverMin） */
  recoverRatio: 0.8,
  recoverMin: 0.2,

  /** runner 横向摆动时长（秒） */
  dodgeDuration: 0.5,
  /** 摆动时的横向速度峰值（× 自身速度） */
  dodgeLateral: 0.6,
  /** 离目标比这更近时不再摆动（米） */
  dodgeMinDistance: 3,

  /** 受击停顿时长（秒）；tank 不停顿 */
  hitStagger: 0.12,
  /** 两次受击停顿的最小间隔，防止连射把丧尸钉在原地 */
  staggerGap: 0.5,

  /** 倒地后停留多久开始下沉（秒） */
  deathLie: 1.7,
  /** 下沉耗时（秒） */
  deathSink: 1.1,
  /** 下沉深度（× 模型缩放，米） */
  deathSinkDepth: 1.2,
  /** 下沉结束时的缩放 */
  deathShrink: 0.85,

  /** 两次刷新之间的间隔范围（秒） */
  spawnGapMin: 0.4,
  spawnGapMax: 0.8,
  /** 暂时没有可用刷新点时的重试间隔 */
  spawnRetry: 0.25,
  /** 刷新位置相对刷新点的随机偏移（米） */
  spawnJitter: 1.5,

  /** 丧尸之间保持的额外间隙（米） */
  separationPad: 0.15,
  /** 分离推开的速率（1/秒） */
  separationRate: 10,
  /** 转向速率（1/秒） */
  turnRate: 8,
  /** 上下台阶时高度的趋近速率（1/秒） */
  heightRate: 14,
  /** 动画速度的平滑速率（1/秒） */
  animRate: 10,

  /** 被挡住多久后尝试侧向绕行（秒） */
  stuckTime: 1,
  /** 侧向绕行持续时间（秒） */
  detourTime: 0.8,
  /** 实际位移低于期望位移的该比例时算作被挡住 */
  stuckRatio: 0.25,

  /** 游荡时的速度倍率 */
  wanderSpeed: 0.4,
  /** 游荡落点半径（米） */
  wanderRadius: 6,
  /** 到达游荡点的判定距离（米） */
  wanderArrive: 0.6,
  /** 离场地边线多远算“已在场内”（米） */
  fieldMargin: 4,

  /** 每只丧尸两次低吼的间隔范围（秒）；runner 的嘶叫再乘 runnerGroanScale */
  groanMin: 3,
  groanMax: 7,
  runnerGroanScale: 1.5,
  /** 离主控这么近（米）的丧尸低吼不受全场间隔限制（同时发声数仍由音频系统按远近裁剪） */
  groanNear: 14,
  /** 更远的丧尸：全场任意两次低吼之间的最小间隔范围（秒） */
  groanGapMin: 0.5,
  groanGapMax: 1.1,
  /** 被全场间隔挡住时，多久后再试（秒），不必等完整的低吼周期 */
  groanRetryMin: 0.4,
  groanRetryMax: 1,
  /** 叫声的可闻范围（米），超出不触发、不占全场间隔；与音效表的 maxDistance 大致对应 */
  hearRange: 52,
  /** 脚步的可闻范围（米） */
  stepHearRange: 24,
  /** 刷出时低吼的概率（tank 必定咆哮） */
  spawnGroanChance: 0.3,
  /** 首次在该距离（米）内锁定目标时发出“发现”嘶吼 */
  alertRange: 24,
  /** 全场两次“发现”嘶吼之间的最小间隔（秒） */
  alertSfxGap: 0.35,
  /** 全场两次攻击音效之间的最小间隔（秒） */
  attackSfxGap: 0.12,
  /** 单只丧尸两次中弹闷哼的间隔范围（秒） */
  hurtGapMin: 0.7,
  hurtGapMax: 1.2,
  /** 全场两次中弹闷哼之间的最小间隔（秒），扫射一群时不至于连成一片 */
  hurtSfxGap: 0.1,
  /** 嘴部高度占身高的比例（叫声从这里发出） */
  mouthRatio: 0.88,
  /** tank 每走多远响一次脚步（米） */
  tankStride: 0.9,
  /** common 拖步、runner 奔跑的脚步间距（米） */
  commonStride: 0.75,
  runnerStride: 1.3,
} as const

/** 场上（或对象池里）的一只丧尸 */
export class Zombie implements EnemyActor {
  /** 每次刷出重新分配 */
  id = 0
  readonly type: EnemyType
  readonly def: EnemyDef
  readonly rig: HumanoidRig
  /** 加入场景的容器，rig.root 是它的唯一子节点 */
  readonly holder = new Group()
  /** 脚底世界坐标（就是 holder.position） */
  readonly position: Vector3
  readonly radius: number
  readonly height: number
  /** 收招时长（秒） */
  readonly recover: number

  hp = 0
  maxHp = 0
  alive = false
  /** 已乘强化系数的单次伤害 */
  damage = 0
  /** 已乘强化系数的移动速度 */
  speed = 0
  /** 所属波次的内部序号；0 表示额外刷出（Boss 召唤） */
  waveSerial = 0

  state: ZombieState = 'move'
  target: Combatant | null = null
  retargetTimer = 0
  /** 远距离降频时累积的决策 dt */
  thinkDt = 0

  /** 决策给出的水平移动方向（单位向量） */
  moveX = 0
  moveZ = 0
  /** 速度倍率：0 停步，1 全速 */
  moveScale = 0
  yaw = 0
  wantYaw = 0
  animSpeed = 0

  /** 本次攻击已进行的时间 */
  attackTime = 0
  /** 本次攻击是否已结算 */
  attackHit = false
  /** 距离下次可攻击的剩余时间 */
  cooldown = 0

  dodgeRoll = 0
  dodgeTimer = 0
  dodgeSide: 1 | -1 = 1

  staggerTimer = 0
  staggerGap = 0

  /** 本帧移动前的位置与期望位移，用来判断是否被挡住 */
  prevX = 0
  prevZ = 0
  intended = 0
  stuck = 0
  detourTimer = 0
  detourSide: 1 | -1 = 1

  wandering = false
  wanderX = 0
  wanderZ = 0
  wanderTimer = 0
  wanderScale = 0

  groanTimer = 0
  /** 脚步累计距离 */
  stride = 0
  /** 本次刷出后是否已经发出过“发现目标”的嘶吼 */
  alerted = false
  /** 距离下次允许中弹闷哼的剩余时间 */
  hurtGap = 0
  /** 这只丧尸的嗓音音高倍率（刷出时随机），让同类丧尸听起来不是同一个声音 */
  voicePitch = 1

  deathTimer = 0
  /** 死亡时的脚底高度（下沉基准） */
  deathY = 0

  /**
   * @param type 丧尸类型（决定所在的对象池，复用时不变）
   * @param rig 该类型的人形模型
   */
  constructor(type: EnemyType, rig: HumanoidRig) {
    const def = ENEMIES[type]
    this.type = type
    this.def = def
    this.rig = rig
    this.radius = def.radius
    this.height = def.height
    this.recover = Math.max(
      ENEMY_TUNING.recoverMin,
      Math.min(def.windup * ENEMY_TUNING.recoverRatio, def.attackInterval - def.windup),
    )
    this.holder.add(rig.root)
    this.position = this.holder.position
  }

  /** 头部中心世界坐标 */
  headCenter(out: Vector3): Vector3 {
    const p = this.position
    return out.set(p.x, p.y + this.rig.headHeight * this.holder.scale.y, p.z)
  }

  /** 躯干中心世界坐标（AI 瞄准点） */
  aimCenter(out: Vector3): Vector3 {
    const p = this.position
    return out.set(p.x, p.y + this.rig.height * ENEMY_TUNING.aimHeightRatio * this.holder.scale.y, p.z)
  }

  /** 头部命中球半径（含手感放大与当前缩放） */
  headHitRadius(): number {
    return this.rig.headRadius * ENEMY_TUNING.headRadiusScale * this.holder.scale.y
  }

  /** 身体命中胶囊的高度：脚底到颈部 */
  bodyHitHeight(): number {
    const neck = (this.rig.headHeight - this.rig.headRadius) * this.holder.scale.y
    return Math.max(this.radius * 2, neck)
  }

  /** 当前 attack 动作进度：0 前摇开始，0.5 击中，1 收招结束 */
  attackProgress(): number {
    const windup = this.def.windup
    if (this.attackTime < windup) return windup > 0 ? (0.5 * this.attackTime) / windup : 0.5
    return 0.5 + 0.5 * Math.min(1, (this.attackTime - windup) / this.recover)
  }
}

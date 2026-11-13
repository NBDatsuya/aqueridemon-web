/**
 * 撤离系统：救援直升机的进场、悬停缓降、Boss 死后降落、登机倒计时与起飞离场。
 * 模型来自 ctx.models.createHelicopter()，这里只负责 root 的位姿并每帧驱动 rig.update。
 *
 * 机身姿态：root.rotation 用 YXZ 顺序（先偏航，再绕机身横轴俯仰，最后滚转），rotation.x 为正时机头下压。
 * 落地朝向 LAND_YAW 让机头朝西，+X 侧舱门朝南（+Z，主控出生的一侧）。
 */

import { Vector3 } from 'three'
import { EVAC, PAD } from '../core/config'
import type { Combatant, EvacSystem, GameContext, HeliState, HelicopterAnimInput } from '../core/types'
import { clamp, damp, dampAngle, invLerp, lerp, smoothstep, wrapAngle, yawOf } from '../utils/math'

/* ── 表现参数（补充，不涉及玩法数值） ── */

/** 停机坪地面高度（中圈为平地） */
const GROUND_Y = 0
/** 进场起点：停机坪东南方向的水平距离（米） */
const APPROACH_DISTANCE = 350
/** 进场起点比悬停高度再高出多少（米） */
const APPROACH_EXTRA_HEIGHT = 50
/** 进场起步时的前倾角（弧度），随减速逐渐收平 */
const APPROACH_PITCH = 0.2
/** 进场进度超过该比例后悬停浮动开始淡入 */
const BOB_FADE_IN = 0.7
/** 落地朝向：机头朝西，+X 侧舱门朝南 */
const LAND_YAW = -Math.PI / 2
/** 登机点至少在停机坪边缘以内多少米 */
const DOOR_MARGIN = 1
/** 加速降落时水平归位占用的时间比例，其余时间垂直下落 */
const LAND_HORIZONTAL_PORTION = 0.7
/** 全员登机或阵亡后提前起飞前的等待（秒）。config.ts 没有这一项，按任务说明取 2 */
const EARLY_DEPART_DELAY = 2
/** 起飞演出结束时的离地高度（米） */
const DEPART_CLIMB = 40
/** 起飞演出结束时飞出的水平距离（米） */
const DEPART_DISTANCE = 160
/** 起飞演出开头只垂直拉升的时间比例 */
const DEPART_VERTICAL_PORTION = 0.3
/** 加速飞离时的前倾角（弧度） */
const DEPART_PITCH = 0.22
/** departed 之后继续按末速飞远的最长时间（秒），让舱内视角在结局画面下仍在移动 */
const DEPART_COAST = 20
/** 起飞后舱门关闭用时（秒） */
const DOOR_CLOSE_TIME = 1.5
/** 俯仰 / 浮动幅度的趋近速率（1/秒） */
const POSE_RATE = 2
/** 悬停时转向落地朝向的速率（1/秒） */
const TURN_RATE = 0.8
/** 悬停浮动：水平漂移与上下起伏的幅度（米） */
const BOB_DRIFT = 0.4
const BOB_HEAVE = 0.35
/** 悬停摆动：俯仰 / 偏航 / 滚转的幅度（弧度） */
const SWAY_PITCH = 0.025
const SWAY_YAW = 0.03
const SWAY_ROLL = 0.035
/** 螺旋桨声：距离不超过 SOUND_NEAR 时音量为 1，达到 SOUND_FAR 时为 0 */
const SOUND_NEAR = 30
const SOUND_FAR = APPROACH_DISTANCE
/** 螺旋桨音量的平滑速率（1/秒） */
const SOUND_RATE = 4
/** 离地低于该高度时产生下洗气流（米） */
const WASH_HEIGHT = 16
/** 水平偏离停机坪超过该距离后不再吹动停机坪的草屑（米） */
const WASH_RADIUS = 20
/** 触地扬尘：中心粒子数、外圈爆发次数与外圈半径（米） */
const DUST_COUNT = 40
const DUST_RING_BURSTS = 6
const DUST_RING_RADIUS = 3.5

/** 时间进度 0..1；duration 不为正时视为已完成 */
function progress(elapsed: number, duration: number): number {
  return duration > 0 ? clamp(elapsed / duration, 0, 1) : 1
}

/** 起飞用的加速曲线：0..1 段二次加速，超过 1 后按末速匀速外推 */
function accelerate(x: number): number {
  if (x <= 0) return 0
  return x <= 1 ? x * x : 2 * x - 1
}

/**
 * 创建撤离系统（救援直升机）。
 * @param ctx 游戏上下文。工厂执行期间只用到 scene / models；player、effects、combatants 在 update 及之后才会访问
 * @returns 撤离系统
 */
export function createEvac(ctx: GameContext): EvacSystem {
  const rig = ctx.models.createHelicopter()
  const root = rig.root
  /** 每帧复用的动画输入；旋翼始终全速 */
  const anim: HelicopterAnimInput = { rotor: 1, door: 0, cabinLight: false }
  const padCenter = new Vector3(PAD.x, GROUND_Y, PAD.z)
  const scratch = new Vector3()

  // 量出登机点相对机身原点的偏移：此时 root 没有父节点，摆正后世界坐标就是相对偏移
  root.position.set(0, 0, 0)
  root.rotation.set(0, 0, 0)
  rig.doorPoint.getWorldPosition(scratch)
  // 换算到落地朝向下的水平偏移；登机点超出停机坪就把落点反向挪一点，保证它落在 PAD.radius 之内
  const cosYaw = Math.cos(LAND_YAW)
  const sinYaw = Math.sin(LAND_YAW)
  const doorX = scratch.x * cosYaw + scratch.z * sinYaw
  const doorZ = -scratch.x * sinYaw + scratch.z * cosYaw
  const doorDist = Math.hypot(doorX, doorZ)
  const doorMax = Math.max(0, PAD.radius - DOOR_MARGIN)
  const shift = doorDist > doorMax ? (doorDist - doorMax) / doorDist : 0

  const landPos = new Vector3(PAD.x - doorX * shift, GROUND_Y, PAD.z - doorZ * shift)
  const hoverPos = new Vector3(landPos.x, GROUND_Y + EVAC.hoverHeight, landPos.z)
  const startPos = new Vector3(
    landPos.x + APPROACH_DISTANCE * Math.SQRT1_2,
    hoverPos.y + APPROACH_EXTRA_HEIGHT,
    landPos.z + APPROACH_DISTANCE * Math.SQRT1_2,
  )
  const approachYaw = yawOf(hoverPos.x - startPos.x, hoverPos.z - startPos.z)
  const holdY = GROUND_Y + EVAC.holdHeight
  const departDuration = Math.max(EVAC.departTime, 0.001)
  const departDirX = Math.sin(LAND_YAW)
  const departDirZ = Math.cos(LAND_YAW)

  let state: HeliState = 'absent'
  /** 落地后的剩余秒数；未开始为 -1，起飞后为 0 */
  let countdown = -1
  /** 浮动相位用的时钟 */
  let clock = 0
  let sinceBegin = 0
  /** 是否处于 Boss 死后的加速降落 */
  let landing = false
  let landTimer = 0
  let departTimer = 0
  let earlyTimer = 0
  let heartbeatOn = false
  let soundLevel = 0
  let door = 0
  let cabinLight = false

  /** 不含浮动的基准位姿 */
  const base = new Vector3().copy(startPos)
  let yaw = approachYaw
  let pitch = 0
  /** 悬停浮动幅度 0..1 */
  let bob = 0

  /** 加速降落起始时的基准位姿 */
  const landFrom = new Vector3()
  let landFromYaw = 0
  let landFromPitch = 0
  let landFromBob = 0

  /** 上一次 update 中 root 的位移，以及那次 update 所在的帧号（seatWorld 用来抵消一帧滞后） */
  const lastMove = new Vector3()
  let lastFrame = -1

  /** 把基准位姿叠加悬停浮动后写入模型 */
  const applyPose = (): void => {
    root.position.set(
      base.x + Math.sin(clock * 0.7) * BOB_DRIFT * bob,
      base.y + Math.sin(clock * 1.15) * BOB_HEAVE * bob,
      base.z + Math.cos(clock * 0.53) * BOB_DRIFT * bob,
    )
    root.rotation.set(
      pitch + Math.sin(clock * 0.6 + 1) * SWAY_PITCH * bob,
      yaw + Math.sin(clock * 0.31) * SWAY_YAW * bob,
      Math.sin(clock * 0.9) * SWAY_ROLL * bob,
    )
  }

  root.rotation.order = 'YXZ'
  root.visible = false
  applyPose()
  ctx.scene.add(root)

  /** 直升机出现在东南远空，开始进场 */
  const begin = (): void => {
    if (state !== 'absent') return
    state = 'approaching'
    sinceBegin = 0
    base.copy(startPos)
    yaw = approachYaw
    pitch = APPROACH_PITCH
    bob = 0
    root.visible = true
    applyPose()
    lastMove.set(0, 0, 0)
  }

  /** 进场 → 悬停 → 缓降（Boss 战期间） */
  const updateArrival = (dt: number): void => {
    sinceBegin += dt
    if (state === 'approaching') {
      const u = progress(sinceBegin, EVAC.arriveAfter)
      // 减速进场：起步最快，到停机坪上方时速度归零
      base.lerpVectors(startPos, hoverPos, 1 - (1 - u) * (1 - u))
      yaw = approachYaw
      pitch = damp(pitch, APPROACH_PITCH * (1 - u), POSE_RATE, dt)
      bob = smoothstep((u - BOB_FADE_IN) / (1 - BOB_FADE_IN))
      if (u >= 1) state = 'hovering'
      return
    }
    if (state === 'hovering' && sinceBegin >= EVAC.descendAfter) state = 'descending'
    // 缓降到 holdHeight 后保持悬停，状态仍为 descending
    if (state === 'descending' && base.y > holdY) base.y = Math.max(holdY, base.y - EVAC.slowDescent * dt)
    yaw = dampAngle(yaw, LAND_YAW, TURN_RATE, dt)
    pitch = damp(pitch, 0, POSE_RATE, dt)
    bob = damp(bob, 1, POSE_RATE, dt)
  }

  /** 触地：开始倒计时 */
  const touchDown = (): void => {
    landing = false
    state = 'landed'
    base.copy(landPos)
    yaw = LAND_YAW
    pitch = 0
    bob = 0
    door = 1
    countdown = EVAC.countdown
    earlyTimer = 0
    ctx.effects.burst(landPos, 'dust', DUST_COUNT)
    for (let i = 0; i < DUST_RING_BURSTS; i++) {
      const angle = (i / DUST_RING_BURSTS) * Math.PI * 2
      scratch.set(
        landPos.x + Math.cos(angle) * DUST_RING_RADIUS,
        GROUND_Y,
        landPos.z + Math.sin(angle) * DUST_RING_RADIUS,
      )
      ctx.effects.burst(scratch, 'dust')
    }
    ctx.events.emit('heliLanded', {})
  }

  /** Boss 死后的加速降落：不论起始位姿，都在 landAfterBossDeath 秒后触地 */
  const updateLanding = (dt: number): void => {
    landTimer += dt
    const u = progress(landTimer, EVAC.landAfterBossDeath)
    // 水平方向先归位，最后一段垂直落下；两条曲线起止速度都为零
    const h = smoothstep(u / LAND_HORIZONTAL_PORTION)
    const v = smoothstep(u)
    base.set(lerp(landFrom.x, landPos.x, h), lerp(landFrom.y, landPos.y, v), lerp(landFrom.z, landPos.z, h))
    yaw = landFromYaw + wrapAngle(LAND_YAW - landFromYaw) * h
    pitch = landFromPitch * (1 - h)
    bob = landFromBob * (1 - v)
    door = v
    if (u >= 1) touchDown()
  }

  /** 起飞瞬间：未登机的成员按阵亡处理 */
  const takeOff = (): void => {
    const squad = ctx.combatants
    for (let i = 0; i < squad.length; i++) {
      const who = squad[i]
      if (who && (who.status === 'alive' || who.status === 'downed')) who.die('abandoned')
    }
    ctx.audio.setHeartbeat(false)
    heartbeatOn = false
    countdown = 0
    cabinLight = false
    departTimer = 0
    state = 'departing'
  }

  /** 落地期间：倒计时、滴答与心跳、起飞条件 */
  const updateLanded = (dt: number): void => {
    const prev = countdown
    countdown = Math.max(0, prev - dt)
    // 最后 tickFrom 秒：每跨过一个整秒滴答一次（归零那一下不响）
    if (countdown > 0 && countdown <= EVAC.tickFrom && Math.ceil(countdown) !== Math.ceil(prev)) {
      ctx.audio.play('tick')
    }
    if (!heartbeatOn && countdown <= EVAC.heartbeatFrom) {
      heartbeatOn = true
      ctx.audio.setHeartbeat(true)
    }

    // 所有人都已登机或阵亡且至少一人登机：稍等片刻后提前起飞
    const squad = ctx.combatants
    let boarded = 0
    let waiting = 0
    for (let i = 0; i < squad.length; i++) {
      const status = squad[i]?.status
      if (status === 'boarded') boarded++
      else if (status === 'alive' || status === 'downed') waiting++
    }
    earlyTimer = waiting === 0 && boarded > 0 ? earlyTimer + dt : 0

    if (countdown <= 0 || earlyTimer >= EARLY_DEPART_DELAY) takeOff()
  }

  /** 起飞：先垂直拉升，再沿机头方向加速飞离；departed 之后按末速继续飞一段 */
  const updateDeparture = (dt: number): void => {
    departTimer = Math.min(departTimer + dt, departDuration + DEPART_COAST)
    const u = departTimer / departDuration
    const forward = accelerate((u - DEPART_VERTICAL_PORTION) / (1 - DEPART_VERTICAL_PORTION))
    base.set(
      landPos.x + departDirX * DEPART_DISTANCE * forward,
      landPos.y + DEPART_CLIMB * accelerate(u),
      landPos.z + departDirZ * DEPART_DISTANCE * forward,
    )
    pitch = damp(pitch, u > DEPART_VERTICAL_PORTION ? DEPART_PITCH : 0, POSE_RATE, dt)
    door = Math.max(0, door - dt / DOOR_CLOSE_TIME)
    if (state === 'departing' && u >= 1) {
      state = 'departed'
      soundLevel = 0
      ctx.audio.setHelicopter(0)
      ctx.events.emit('heliDeparted', {})
    }
  }

  /** 螺旋桨声：随与主控的距离由远及近平滑升高，飞远时回落 */
  const updateSound = (dt: number): void => {
    const closeness = 1 - invLerp(SOUND_NEAR, SOUND_FAR, root.position.distanceTo(ctx.player.eye))
    soundLevel = damp(soundLevel, closeness * closeness, SOUND_RATE, dt)
    ctx.audio.setHelicopter(soundLevel)
  }

  /** 下洗气流：离地越低越强；水平飞离停机坪后减弱到 0 */
  const updateWash = (): void => {
    const altitude = root.position.y - GROUND_Y
    if (altitude >= WASH_HEIGHT) return
    const offset = Math.hypot(root.position.x - PAD.x, root.position.z - PAD.z)
    const strength = clamp(1 - altitude / WASH_HEIGHT, 0, 1) * (1 - invLerp(0, WASH_RADIUS, offset))
    if (strength > 0) ctx.effects.rotorWash(padCenter, strength)
  }

  const canBoard = (who: Combatant): boolean =>
    state === 'landed' &&
    who.status === 'alive' &&
    Math.hypot(who.position.x - PAD.x, who.position.z - PAD.z) <= PAD.radius

  /** update 开头记下的 root 位置，用来算本帧位移 */
  const prevPos = new Vector3()

  return {
    get heliState(): HeliState {
      return state
    },

    get countdown(): number {
      return countdown
    },

    get departed(): boolean {
      return state === 'departed'
    },

    begin,

    bossDefeated() {
      if (state === 'absent') begin()
      if (landing || state === 'landed' || state === 'departing' || state === 'departed') return
      landing = true
      landTimer = 0
      landFrom.copy(base)
      landFromYaw = yaw
      landFromPitch = pitch
      landFromBob = bob
      cabinLight = true
      state = 'descending'
    },

    canBoard,

    board(who) {
      if (!canBoard(who)) return
      who.board()
      ctx.events.emit('boarded', { who })
    },

    seatWorld(out) {
      // getWorldPosition 会先 updateWorldMatrix(true, false)，取到的是 root 当前位姿下的坐标
      rig.seat.getWorldPosition(out)
      // 主控系统先于本系统更新：本帧还没轮到自己时补上一帧的位移，避免相机比机舱落后一帧
      if (ctx.time.frame !== lastFrame) out.add(lastMove)
      return out
    },

    doorWorld(out) {
      return rig.doorPoint.getWorldPosition(out)
    },

    update(dt) {
      if (state === 'absent') return
      clock += dt
      prevPos.copy(root.position)

      if (state === 'landed') updateLanded(dt)
      else if (state === 'departing' || state === 'departed') updateDeparture(dt)
      else if (landing) updateLanding(dt)
      else updateArrival(dt)

      applyPose()
      lastMove.subVectors(root.position, prevPos)
      lastFrame = ctx.time.frame

      anim.door = door
      anim.cabinLight = cabinLight
      rig.update(dt, anim)

      // departed 时已把音量置 0，之后不再写入
      if (state !== 'departed') updateSound(dt)
      updateWash()
    },

    dispose() {
      ctx.scene.remove(root)
      rig.dispose()
      ctx.audio.setHelicopter(0)
      ctx.audio.setHeartbeat(false)
    },
  }
}

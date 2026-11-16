/**
 * 主控（编号 0）：第一人称控制器、武器与射击、交互读条、相机。
 *
 * 相机有四种机位：存活时第一人称；倒地时身后低角度第三人称（可爬行）；
 * 阵亡时停在尸体旁缓慢拉远下沉；登机后固定在机舱座位上环顾。
 * 状态本身用 CombatantBase；其他系统只通过 ctx 上的接口访问，且都在 init() 之后才使用。
 */

import { Vector3 } from 'three'
import { CombatantBase } from '../core/combatant'
import { HEADSHOT, INTERACT, MAX_SHOT_DISTANCE, PLAYER, PLAYER_ID, PLAYER_START, WEAPONS } from '../core/config'
import type {
  ActorStatus,
  AirdropCrate,
  BossZone,
  Combatant,
  DamageInfo,
  EnemyActor,
  GameContext,
  HumanoidAnimInput,
  InteractionInfo,
  InteractionKind,
  PlayerSystem,
  RayHit,
  SfxId,
  WeaponDef,
  WeaponId,
  WeaponState,
} from '../core/types'
import { clamp, damp, dampAngle, distXZ, distXZSq, invLerp, lerp, smoothstep, wrapAngle } from '../utils/math'
import { setHumanoidUpperHidden } from '../generators/geometry/humanoid'
import { VIEW_MODEL_SCALE, createViewModel } from './player-viewmodel'
import type { ViewModelInput } from './player-viewmodel'

/* ── 手感与表现参数 ──
 * 玩法数值（速度、跳高、射速、伤害、读条时长等）全部取自 core/config.ts；
 * 这里只放控制器私有的调校量（加速度、步幅、起伏、后坐角度、相机机位等）。
 */

/** 俯仰角上下限 */
const PITCH_LIMIT = (85 * Math.PI) / 180
/** 起跳初速，由跳高与重力推出 */
const JUMP_SPEED = Math.sqrt(2 * PLAYER.gravity * PLAYER.jumpHeight)
/** 掉帧时单帧最多补射的子弹数 */
const FIRE_MAX_PER_FRAME = 2

const MOVE = {
  /** 水平速度趋近期望速度的速率（1/秒）：地面 / 空中 / 爬行 */
  groundAccel: 14,
  airAccel: 3,
  crawlAccel: 8,
  /** 松开方向键后低于该速度直接停下 */
  stopSpeed: 0.05,
  /** 上下台阶时眼睛高度的平滑 */
  stepSmoothRate: 14,
  stepSmoothMax: 0.6,
  /** 落地时视角下沉 */
  landDipPerSpeed: 0.012,
  landDipMax: 0.1,
  landDipRate: 10,
} as const

const STEP = {
  /** 步距（米）：行走 / 冲刺 */
  walkStride: 1.7,
  sprintStride: 2.3,
  volume: 0.5,
  sprintVolume: 0.7,
  landVolume: 0.9,
  /** 落地速度超过该值才出声 */
  landMinSpeed: 2,
} as const

const BOB = {
  /** 视角起伏幅度（米）：左右 / 上下 */
  x: 0.012,
  y: 0.02,
  rate: 8,
  /** 冲刺时的幅度上限（行走为 1） */
  max: 1.4,
  minSpeed: 0.3,
} as const

const SPREAD = {
  /** 基础散布的倍率：行走 / 冲刺 / 离地 */
  walkMul: 1.5,
  sprintMul: 2.4,
  airMul: 2.8,
  moveRate: 10,
  /** 连射时每发追加的倍率与上限，停火后恢复 */
  bloomPerShot: 0.22,
  bloomMax: 1.6,
  recoverDelay: 0.16,
  recoverRate: 8,
} as const

const RECOIL = {
  /** 后坐力系数为 1 时每发的上跳 / 水平随机角度（弧度） */
  pitch: 0.007,
  yaw: 0.0035,
  /** 上跳里不回落的比例；其余部分停火后回落 */
  permanent: 0.35,
  maxPitch: 0.12,
  maxYaw: 0.05,
  recoverDelay: 0.16,
  recoverRate: 6,
  yawRecoverRate: 9,
} as const

const STUN = {
  /** 眩晕时相机的滚转 / 俯仰晃动（弧度）与频率 */
  roll: 0.035,
  pitch: 0.018,
  rollFreq: 9,
  pitchFreq: 6.3,
  rate: 8,
} as const

const HURT = {
  /** 受伤音效的最小间隔（毒池每 0.5 秒结算一次，避免连响） */
  minInterval: 0.25,
  shakeBase: 0.04,
  shakePerDamage: 0.002,
  shakeMax: 0.18,
  shakeTime: 0.25,
} as const

const THIRD = {
  /** 注视点在脚底上方的高度 */
  targetHeight: 0.45,
  dist: 3,
  /** 仰角（弧度）：默认值、鼠标俯仰可调的范围 */
  elev: 0.5,
  elevMin: 0.2,
  elevMax: 1.1,
  pitchToElev: 0.6,
  /** 相机离脚底的最低高度 */
  minHeight: 0.35,
  /** 相机与墙面保持的距离、被墙挡住时的最短机位 */
  wallPad: 0.25,
  minDist: 0.7,
  bodyTurnRate: 6,
  /** 阵亡镜头：拉远 / 下沉的时长、拉远距离、最终仰角、缓慢环绕角速度 */
  deadDuration: 8,
  deadPull: 2.5,
  deadElev: 0.16,
  deadOrbit: 0.05,
} as const

const SFX_VOLUME = { shell: 0.35, weakHit: 1.3 } as const

/** 视图模型不可用时的枪口位置：相对眼睛的前 / 右 / 下偏移 */
const MUZZLE_FALLBACK = { forward: 0.4, right: 0.08, down: 0.06 } as const

const TEXT = {
  rescue: '按住 E 救援 ',
  board: '按 E 登机就座',
  sample: '按住 E 提取样本',
  airdrop: '按 E 拾取空投',
  crate: '按 E 打开主武器箱',
} as const

const SHOT_SFX: Record<WeaponId, SfxId> = {
  ak47: 'shot_ak47',
  mg3: 'shot_mg3',
  mp5: 'shot_mp5',
  qbz95: 'shot_qbz95',
}

/** 数字键 1..N 对应武器槽位 */
const DIGIT_CODES: readonly string[] = Array.from({ length: PLAYER.maxWeapons }, (_, i) => `Digit${i + 1}`)

/* ── 每帧复用的临时对象 ── */

const look = { x: 0, y: 0 }
const tmpKnock = new Vector3()
const tmpRight = new Vector3()
const tmpUp = new Vector3()
const shotDir = new Vector3()
const hitPoint = new Vector3()
const hitNormal = new Vector3()
const muzzlePos = new Vector3()
const tpTarget = new Vector3()
const tpDir = new Vector3()

/** 复用的伤害信息：point / direction 指向上面的临时向量，接收方需要保存时应自行拷贝 */
const damageInfo: DamageInfo = { attacker: PLAYER_ID, headshot: false, point: hitPoint, direction: shotDir }

/**
 * 创建主控系统：第一人称移动与视角、武器射击与换弹、E 键交互、各状态下的相机。
 * 工厂执行期间只创建模型并摆好初始相机；其他系统在 init() 之后才访问。
 * @param ctx 游戏上下文
 */
export function createPlayer(ctx: GameContext): PlayerSystem {
  const camera = ctx.camera
  camera.rotation.order = 'YXZ'

  const actor = new CombatantBase(PLAYER_ID, ctx.events)
  actor.position.set(PLAYER_START.x, 0, PLAYER_START.z)

  const forward = new Vector3()
  const eye = new Vector3()
  const rng = ctx.rng.fork()

  // 身体模型：第一人称时显示躯干、腰带与双腿（低头能看到胸腹和脚），头与双臂只投射阴影（双臂由视图模型代替）；
  // 倒地 / 阵亡的第三人称镜头里整身显示
  const body = ctx.models.createCharacter(PLAYER_ID)
  ctx.scene.add(body.root)
  const bodyAnim: HumanoidAnimInput = { speed: 0, pose: 'downed', action: 'none', actionProgress: 0 }
  /**
   * 第一人称时身体沿视线水平方向后移的距离：胸口前沿约在镜头后 6cm、下方 18cm，
   * 平视时整段躯干在视野下沿之外，低头时胸腹出现在画面下半部
   */
  const BODY_BACK = 0.16
  /** 低头（俯角 0.3 → 1.1 rad）时额外后移的距离：胸口前沿退到镜头后约 18cm，肩头与领口移出画面下沿 */
  const BODY_BACK_DOWN = 0.12
  /** 第一人称身体的瞄准俯仰下限（低头时躯干最多前倾约 0.09 rad） */
  const BODY_MIN_AIM_PITCH = -0.35

  /** 按状态切换身体显示：第一人称（无头无臂）/ 第三人称整身 / 登机后隐藏 */
  function syncBodyMode(status: ActorStatus): void {
    const thirdPerson = status === 'downed' || status === 'dead'
    body.root.visible = thirdPerson || status === 'alive'
    setHumanoidUpperHidden(body, !thirdPerson)
  }
  syncBodyMode(actor.status)

  const view = createViewModel(ctx.models)
  camera.add(view.root)
  const viewInput: ViewModelInput = {
    visible: false,
    slot: 0,
    lookX: 0,
    lookY: 0,
    bobPhase: 0,
    bob: 0,
    sprinting: false,
    reload: -1,
    switchProgress: -1,
  }

  /** init() 之后才能访问其他系统 */
  let ready = false
  let controlEnabled = true
  let prevStatus: ActorStatus = actor.status
  let clock = 0

  // 视角：yaw / pitch 是玩家瞄准的角度，recoil* 是叠加在上面的后坐偏移
  let yaw: number = PLAYER_START.yaw
  let pitch = 0
  let recoilPitch = 0
  let recoilYaw = 0
  let viewYaw: number = yaw
  let viewPitch = 0
  let lookDX = 0
  let lookDY = 0
  let wobble = 0

  // 移动
  let velX = 0
  let velZ = 0
  let velY = 0
  let grounded = true
  let sprinting = false
  let moveSpeed = 0
  let stepDist = 0
  let stepSmooth = 0
  let landDip = 0
  let bobPhase = 0
  let bobAmount = 0
  let bodyYaw: number = yaw

  // 武器
  let switchTimer = 0
  let switchFrom = 0
  let reloadTimer = -1
  let fireTimer = 0
  let sinceShot = 1
  let bloom = 0
  let moveSpread = 1
  let dryLatch = false
  let firedThisFrame = false
  /** 是否正在开火（按住左键且武器可射击），HUD 用来点亮准星 */
  let firingNow = false
  /** 准星射线当前是否指向敌人 */
  let aimingEnemyNow = false

  // 交互
  const interactionInfo: InteractionInfo = { kind: 'airdrop', text: '', progress: 0 }
  let hasInteraction = false
  let holdKind: InteractionKind | null = null
  let holdTarget: Combatant | null = null
  let holdTime = 0
  let holdSerial = 0
  let rescueTextFor: Combatant | null = null
  let rescueText = ''

  // 第三人称机位
  let tpYaw: number = yaw
  let tpElev: number = THIRD.elev
  let tpDist: number = THIRD.dist
  let deadTime = 0
  let deadElevFrom: number = THIRD.elev
  let deadDistFrom: number = THIRD.dist

  let lastHurtAt = -1

  // 登机就座过渡：相机从登机时的站位眼睛平滑移到座位眼位，朝向转进环顾范围
  /** 过渡已推进的时间；未登机为 -1 */
  let seatTimer = -1
  /** 登机瞬间站位眼睛相对座位眼位的偏移，以及当时的视线角 */
  const seatFrom = new Vector3()
  let seatFromYaw = 0
  let seatFromPitch = 0
  /** 当前过渡偏移（引擎在所有系统更新完后把相机贴到 seatWorld + seatOffset） */
  const seatOffset = new Vector3()

  /* ── 相机 ── */

  /** 由朝向角与俯仰角写出视线方向 */
  function setView(y: number, p: number): void {
    viewYaw = y
    viewPitch = p
    const cp = Math.cos(p)
    forward.set(Math.sin(y) * cp, Math.sin(p), Math.cos(y) * cp)
  }

  /** 相机位置 = 眼睛 + 震动偏移（登机后不叠加震动，相机只随机舱移动）；朝向取自 viewYaw / viewPitch */
  function writeCamera(extraPitch: number, roll: number): void {
    camera.position.copy(eye)
    if (ready && actor.status !== 'boarded') camera.position.add(ctx.effects.shakeOffset)
    // three 相机默认看向 -Z，而约定 yaw = 0 时朝 +Z，两者差半圈
    camera.rotation.set(viewPitch + extraPitch, viewYaw + Math.PI, roll)
  }

  function applyFirstPerson(): void {
    const pos = actor.position
    setView(yaw + recoilYaw, clamp(pitch + recoilPitch, -PITCH_LIMIT, PITCH_LIMIT))
    const bobX = Math.sin(bobPhase) * BOB.x * bobAmount
    const bobY = Math.cos(bobPhase * 2) * BOB.y * bobAmount
    // 右方向 = (-cos yaw, 0, sin yaw)
    eye.set(
      pos.x - Math.cos(viewYaw) * bobX,
      pos.y + PLAYER.eyeHeight + stepSmooth - landDip + bobY,
      pos.z + Math.sin(viewYaw) * bobX,
    )
    writeCamera(
      Math.sin(clock * STUN.pitchFreq) * STUN.pitch * wobble,
      Math.sin(clock * STUN.rollFreq) * STUN.roll * wobble,
    )
  }

  /** 倒地 / 阵亡：相机在身后上方看着自己，被墙挡住时拉近 */
  function applyThirdPerson(): void {
    const pos = actor.position
    tpTarget.set(pos.x, pos.y + THIRD.targetHeight, pos.z)
    const ce = Math.cos(tpElev)
    // 从注视点指向相机：水平上是视线的反方向
    tpDir.set(-Math.sin(tpYaw) * ce, Math.sin(tpElev), -Math.cos(tpYaw) * ce)
    let dist = tpDist
    if (ready) {
      const hit = ctx.world.raycast(tpTarget, tpDir, dist + THIRD.wallPad)
      if (hit) dist = clamp(hit.distance - THIRD.wallPad, THIRD.minDist, dist)
    }
    eye.copy(tpTarget).addScaledVector(tpDir, dist)
    eye.y = Math.max(eye.y, pos.y + THIRD.minHeight)
    forward.copy(tpTarget).sub(eye).normalize()
    viewYaw = Math.atan2(forward.x, forward.z)
    viewPitch = Math.asin(clamp(forward.y, -1, 1))
    writeCamera(0, 0)
  }

  /** 登机瞬间记下站位眼睛与视线，开始就座过渡；同一次登机只记一次 */
  function beginSeat(): void {
    if (seatTimer >= 0) return
    seatTimer = 0
    ctx.evac.seatWorld(seatFrom)
    seatFrom.subVectors(eye, seatFrom)
    seatOffset.copy(seatFrom)
    seatFromYaw = viewYaw
    seatFromPitch = viewPitch
  }

  /**
   * 已登机：相机贴在机舱座位眼位，只能在正对舱门的一定范围内环顾。
   * 登机后的前 INTERACT.seatBlendTime 秒从站位平滑移入座位，朝向同时转进环顾范围。
   */
  function applySeat(): void {
    // 环顾范围以座位正对舱门的朝向为中心；把瞄准角本身也夹住，避免甩出范围后要倒拨很久
    const center = ctx.evac.seatYaw()
    yaw = wrapAngle(center + clamp(wrapAngle(yaw - center), -INTERACT.seatYawLimit, INTERACT.seatYawLimit))
    pitch = clamp(pitch, -INTERACT.seatPitchDown, INTERACT.seatPitchUp)
    const blendTime: number = INTERACT.seatBlendTime
    const s = seatTimer < 0 || blendTime <= 0 ? 1 : smoothstep(seatTimer / blendTime)
    setView(wrapAngle(seatFromYaw + wrapAngle(yaw - seatFromYaw) * s), lerp(seatFromPitch, pitch, s))
    seatOffset.copy(seatFrom).multiplyScalar(1 - s)
    ctx.evac.seatWorld(eye).add(seatOffset)
    writeCamera(0, 0)
  }

  function applyCamera(status: ActorStatus): void {
    if (status === 'alive') applyFirstPerson()
    else if (status === 'boarded') applySeat()
    else applyThirdPerson()
  }

  /** 推进第三人称机位：倒地时跟随鼠标环绕，阵亡后缓慢拉远下沉 */
  function updateThirdPerson(dt: number, status: ActorStatus): void {
    if (status === 'downed') {
      tpYaw = yaw
      tpElev = clamp(THIRD.elev - pitch * THIRD.pitchToElev, THIRD.elevMin, THIRD.elevMax)
      tpDist = THIRD.dist
    } else if (status === 'dead') {
      deadTime += dt
      const s = smoothstep(deadTime / THIRD.deadDuration)
      tpYaw += THIRD.deadOrbit * dt
      tpElev = lerp(deadElevFrom, THIRD.deadElev, s)
      tpDist = deadDistFrom + THIRD.deadPull * s
    }
  }

  /** 取走鼠标位移；apply 为 false 时只丢弃，避免恢复操作时视角突跳 */
  function readLook(apply: boolean): void {
    ctx.input.consumeLook(look)
    if (!apply) {
      lookDX = 0
      lookDY = 0
      return
    }
    lookDX = look.x
    lookDY = look.y
    // 鼠标右移 → 向右转；从朝北（yaw = PI）右转是朝东（+X），即 yaw 减小
    yaw = wrapAngle(yaw - look.x * PLAYER.mouseSensitivity)
    pitch = clamp(pitch - look.y * PLAYER.mouseSensitivity, -PITCH_LIMIT, PITCH_LIMIT)
  }

  /* ── 移动 ── */

  /** 贴到指定高度，并把高度差交给 stepSmooth 慢慢消化，眼睛不会突跳 */
  function snapTo(height: number): void {
    const pos = actor.position
    stepSmooth = clamp(stepSmooth + pos.y - height, -MOVE.stepSmoothMax, MOVE.stepSmoothMax)
    pos.y = height
  }

  /** Boss 存活时不能穿过它的身体 */
  function pushOutOfBoss(): void {
    const boss = ctx.boss
    if (!boss.active || !boss.alive) return
    const pos = actor.position
    const r = boss.radius
    let dx = pos.x - boss.position.x
    let dz = pos.z - boss.position.z
    const distSq = dx * dx + dz * dz
    if (distSq >= r * r) return
    let dist = Math.sqrt(distSq)
    if (dist < 1e-4) {
      // 正好重合：沿视线反方向退出
      dx = -Math.sin(yaw)
      dz = -Math.cos(yaw)
      dist = 1
    }
    pos.x = boss.position.x + (dx / dist) * r
    pos.z = boss.position.z + (dz / dist) * r
  }

  function playFootstep(volume: number): void {
    ctx.audio.play('footstep', { volume, rate: rng.range(0.92, 1.08) })
  }

  /**
   * 水平移动、跳跃、重力与碰撞。存活、倒地（爬行）、阵亡（只受重力）都走这里。
   * @param canMove 是否响应 WASD / Shift / Space
   */
  function updateMovement(dt: number, status: ActorStatus, canMove: boolean): void {
    const input = ctx.input
    const pos = actor.position
    const crawl = status === 'downed'
    const prevX = pos.x
    const prevZ = pos.z

    // 输入 → 期望速度（相对视角：前 = (sin yaw, cos yaw)，右 = (-cos yaw, sin yaw)）
    let ix = 0
    let iz = 0
    if (canMove) {
      if (input.isDown('KeyW')) iz += 1
      if (input.isDown('KeyS')) iz -= 1
      if (input.isDown('KeyD')) ix += 1
      if (input.isDown('KeyA')) ix -= 1
    }
    let wishX = 0
    let wishZ = 0
    sprinting = false
    const len = Math.hypot(ix, iz)
    if (len > 0) {
      let speed: number = PLAYER.crawlSpeed
      if (!crawl) {
        sprinting = input.isDown('ShiftLeft') || input.isDown('ShiftRight')
        const weapon = actor.weapon
        speed = (sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * (weapon ? WEAPONS[weapon.id].moveMul : 1)
      }
      const sin = Math.sin(yaw)
      const cos = Math.cos(yaw)
      const f = iz / len
      const r = ix / len
      wishX = (sin * f - cos * r) * speed
      wishZ = (cos * f + sin * r) * speed
    }
    const accel = crawl ? MOVE.crawlAccel : grounded ? MOVE.groundAccel : MOVE.airAccel
    velX = damp(velX, wishX, accel, dt)
    velZ = damp(velZ, wishZ, accel, dt)
    if (len === 0 && Math.hypot(velX, velZ) < MOVE.stopSpeed) {
      velX = 0
      velZ = 0
    }

    // 只能从地面起跳；按住空格落地即再跳（连跳无冷却）
    if (canMove && !crawl && grounded && input.isDown('Space')) {
      velY = JUMP_SPEED
      grounded = false
    }

    // 水平位移：自身速度 + 击退，再依次推出 Boss 与场景碰撞体
    actor.consumeKnockback(dt, tmpKnock)
    pos.x += velX * dt + tmpKnock.x
    pos.z += velZ * dt + tmpKnock.z
    pushOutOfBoss()
    ctx.world.resolveMove(pos, actor.radius, pos.y, true)

    // 竖直方向
    const ground = ctx.world.groundHeight(pos.x, pos.z, pos.y)
    if (grounded) {
      if (ground >= pos.y - PLAYER.stepHeight) {
        // 平地、踏上台阶或走下一级台阶：贴地
        if (ground !== pos.y) snapTo(ground)
      } else {
        // 脚下落差太大：开始下落
        grounded = false
        velY = 0
      }
    }
    if (!grounded) {
      velY -= PLAYER.gravity * dt
      pos.y += velY * dt
      if (pos.y <= ground) {
        snapTo(ground)
        // 上升途中蹭进可踏上的台阶时只抬高，不算落地
        if (velY <= 0) {
          const impact = -velY
          velY = 0
          grounded = true
          landDip = Math.min(MOVE.landDipMax, impact * MOVE.landDipPerSpeed)
          if (status === 'alive' && impact > STEP.landMinSpeed) playFootstep(STEP.landVolume)
        }
      }
    }

    // 实际位移 → 速度（被墙挡住时为 0）
    const dx = pos.x - prevX
    const dz = pos.z - prevZ
    const moved = Math.hypot(dx, dz)
    if (dt > 1e-5) {
      actor.velocity.set(dx / dt, 0, dz / dt)
      moveSpeed = moved / dt
    } else {
      actor.velocity.set(0, 0, 0)
      moveSpeed = 0
    }
    actor.airborne = !grounded

    // 脚步声与视角起伏
    const walking = status === 'alive' && grounded && moveSpeed > BOB.minSpeed
    bobAmount = damp(bobAmount, walking ? clamp(moveSpeed / PLAYER.walkSpeed, 0, BOB.max) : 0, BOB.rate, dt)
    if (walking) {
      bobPhase += (moved * Math.PI) / STEP.walkStride
      if (bobPhase > Math.PI * 2) bobPhase -= Math.PI * 2
      stepDist += moved
      const stride = sprinting ? STEP.sprintStride : STEP.walkStride
      if (stepDist >= stride) {
        stepDist -= stride
        playFootstep(sprinting ? STEP.sprintVolume : STEP.volume)
      }
    }
    stepSmooth = damp(stepSmooth, 0, MOVE.stepSmoothRate, dt)
    landDip = damp(landDip, 0, MOVE.landDipRate, dt)

    // 爬行时身体转向移动方向
    if (crawl && moved > 1e-4) bodyYaw = dampAngle(bodyYaw, Math.atan2(dx, dz), THIRD.bodyTurnRate, dt)
  }

  /* ── 交互 ── */

  /** 打断读条并清零；救援读条时把目标的 rescuer 还回去 */
  function cancelHold(): void {
    if (holdKind === 'rescue' && holdTarget && holdTarget.rescuer === actor.id) holdTarget.rescuer = null
    holdKind = null
    holdTarget = null
    holdTime = 0
  }

  function canRescue(target: Combatant): boolean {
    if (target === actor || target.status !== 'downed') return false
    if (target.rescuer !== null && target.rescuer !== actor.id) return false
    return distXZ(target.position, actor.position) <= INTERACT.rescueRange
  }

  /** 最近的可救队友；正在救的那位只要仍满足条件就保持不变 */
  function findRescueTarget(): Combatant | null {
    if (holdKind === 'rescue' && holdTarget && canRescue(holdTarget)) return holdTarget
    const squad = ctx.combatants
    let best: Combatant | null = null
    let bestDist = Infinity
    for (let i = 0; i < squad.length; i++) {
      const member = squad[i]
      if (!member || !canRescue(member)) continue
      const dist = distXZ(member.position, actor.position)
      if (dist < bestDist) {
        best = member
        bestDist = dist
      }
    }
    return best
  }

  function rescueLabel(target: Combatant): string {
    if (rescueTextFor !== target) {
      rescueTextFor = target
      rescueText = TEXT.rescue + target.name
    }
    return rescueText
  }

  /** 最近的、自己还能开的箱子：主武器箱每人限开几个，开满的直接跳过 */
  function findCrate(): AirdropCrate | null {
    const list = ctx.airdrops.crates
    const limit = INTERACT.airdropRange * INTERACT.airdropRange
    let best: AirdropCrate | null = null
    let bestSq = limit
    for (let i = 0; i < list.length; i++) {
      const crate = list[i]
      if (!crate || !crate.landed) continue
      if (crate.limited && crate.content.kind === 'weapon' && ctx.airdrops.hasOpenedWeaponCrate(actor)) continue
      const sq = distXZSq(crate.position, actor.position)
      if (sq <= bestSq) {
        bestSq = sq
        best = crate
      }
    }
    return best
  }

  /**
   * 挑出本帧可用的交互（救援 > 登机 > 样本 > 空投）并推进读条。
   * 登机不会自动发生：站进舱门登机范围后提示“按 E 登机就座”，按下 E 才登机。
   * 只在主控存活且能行动时调用。
   * @returns 是否正在进行会锁住移动与射击的读条（救援 / 样本）
   */
  function updateInteraction(dt: number): boolean {
    const input = ctx.input
    let kind: InteractionKind | null = null
    let target: Combatant | null = null
    let crate: AirdropCrate | null = null
    let duration = 0

    const rescue = findRescueTarget()
    if (rescue) {
      kind = 'rescue'
      target = rescue
      duration = INTERACT.rescueTime
      interactionInfo.text = rescueLabel(rescue)
    } else if (ctx.evac.canBoard(actor)) {
      kind = 'board'
      interactionInfo.text = TEXT.board
    } else if (
      !actor.hasSample &&
      ctx.boss.sampleAvailable &&
      distXZ(actor.position, ctx.boss.samplePoint) <= INTERACT.sampleRange
    ) {
      kind = 'sample'
      duration = INTERACT.sampleTime
      interactionInfo.text = TEXT.sample
    } else {
      crate = findCrate()
      if (crate) {
        kind = 'airdrop'
        interactionInfo.text = crate.content.kind === 'weapon' ? TEXT.crate : TEXT.airdrop
      }
    }

    // 进行中的读条与本帧候选不一致（目标被救起、走出范围等）：打断
    if (holdKind !== null && (holdKind !== kind || holdTarget !== target)) cancelHold()

    if (kind === null) {
      hasInteraction = false
      return false
    }
    hasInteraction = true
    interactionInfo.kind = kind
    interactionInfo.progress = 0

    if (kind === 'airdrop') {
      // 瞬时拾取；返回 needsChoice 时由引擎弹出替换界面
      if (crate && input.wasPressed('KeyE')) ctx.airdrops.pickup(crate, actor)
      return false
    }

    if (kind === 'board') {
      // 按一下 E 就座：先记下站位再登机，就座过渡从当前视角开始
      if (input.wasPressed('KeyE')) {
        beginSeat()
        ctx.evac.board(actor)
        if (actor.status === 'boarded') hasInteraction = false
        else seatTimer = -1
      }
      return false
    }

    if (!input.isDown('KeyE')) {
      cancelHold()
      return false
    }

    if (holdKind === null) {
      holdKind = kind
      holdTarget = target
      holdTime = 0
      holdSerial = actor.damageSerial
    }

    // 救援与样本读条会被受伤打断并清零；按住不放则从头再来
    if (actor.damageSerial !== holdSerial) {
      cancelHold()
      return false
    }

    if (target) target.rescuer = actor.id
    holdTime += dt
    if (holdTime < duration) {
      interactionInfo.progress = holdTime / duration
      return true
    }

    // 读条完成
    interactionInfo.progress = 1
    holdKind = null
    holdTarget = null
    holdTime = 0
    if (kind === 'rescue') {
      if (target) target.revive()
      ctx.audio.play('revive')
    } else {
      ctx.boss.takeSample()
      actor.hasSample = true
      ctx.audio.play('pickup')
    }
    return false
  }

  /* ── 武器 ── */

  /** 武器栏可能被空投 / 替换界面直接改动：按槽位 id 同步视图模型 */
  function syncWeapons(): void {
    const weapons = actor.weapons
    if (actor.currentWeapon >= weapons.length) actor.currentWeapon = Math.max(0, weapons.length - 1)
    const changed = view.sync(weapons)
    if ((changed & (1 << actor.currentWeapon)) === 0) return
    // 手上的枪被换掉：取消换弹，重新举枪（只播升起的后半程）
    reloadTimer = -1
    switchFrom = actor.currentWeapon
    switchTimer = PLAYER.switchTime * 0.5
    fireTimer = 0
    bloom = 0
    dryLatch = false
  }

  function startSwitch(slot: number): void {
    if (slot === actor.currentWeapon || slot < 0 || slot >= actor.weapons.length) return
    // 上一次切换还没过半时，手上显示的仍是更早的那把，沿用它
    if (switchTimer <= PLAYER.switchTime * 0.5) switchFrom = actor.currentWeapon
    actor.currentWeapon = slot
    switchTimer = PLAYER.switchTime
    reloadTimer = -1
    dryLatch = false
    ctx.audio.play('switch')
  }

  function startReload(weapon: WeaponState, def: WeaponDef): void {
    if (weapon.mag >= def.magSize || weapon.reserve <= 0) return
    reloadTimer = 0
    ctx.audio.play('reload')
  }

  function currentSpread(): number {
    const weapon = actor.weapon
    return weapon ? WEAPONS[weapon.id].spread * (moveSpread + bloom) : 0
  }

  /** 散布随移动状态变化、连射扩散与后坐偏移在停火后恢复 */
  function updateAim(dt: number): void {
    sinceShot += dt
    const moveTarget = !grounded
      ? SPREAD.airMul
      : sprinting && moveSpeed > PLAYER.walkSpeed
        ? SPREAD.sprintMul
        : lerp(1, SPREAD.walkMul, clamp(moveSpeed / PLAYER.walkSpeed, 0, 1))
    moveSpread = damp(moveSpread, moveTarget, SPREAD.moveRate, dt)
    if (sinceShot > SPREAD.recoverDelay) bloom = damp(bloom, 0, SPREAD.recoverRate, dt)
    if (sinceShot > RECOIL.recoverDelay) recoilPitch = damp(recoilPitch, 0, RECOIL.recoverRate, dt)
    recoilYaw = damp(recoilYaw, 0, RECOIL.yawRecoverRate, dt)
  }

  /** 准星中心射线是否指向敌人：先求场景遮挡距离，再看丧尸 / Boss 是否更近（被墙挡住不算） */
  function updateAimEnemy(): void {
    aimingEnemyNow = false
    if (!ready || actor.status !== 'alive') return
    const wall = ctx.world.raycast(eye, forward, MAX_SHOT_DISTANCE)
    const limit = wall ? wall.distance : MAX_SHOT_DISTANCE
    const enemyHit = ctx.enemies.raycast(eye, forward, limit)
    if (enemyHit && enemyHit.enemy && enemyHit.distance <= limit) {
      aimingEnemyNow = true
      return
    }
    if (ctx.boss.active && ctx.boss.alive) {
      const bossHit = ctx.boss.raycast(eye, forward, limit)
      if (bossHit && bossHit.distance <= limit) aimingEnemyNow = true
    }
  }

  /** 发射一发子弹：散布、三路射线取最近、伤害、特效、音效、事件、后坐 */
  function fireShot(weapon: WeaponState, def: WeaponDef): void {
    weapon.mag -= 1
    sinceShot = 0
    firedThisFrame = true

    // 在视线周围的圆锥内均匀取样
    const cone = Math.tan(currentSpread()) * Math.sqrt(rng.next())
    const angle = rng.range(0, Math.PI * 2)
    tmpRight.set(-Math.cos(viewYaw), 0, Math.sin(viewYaw))
    tmpUp.crossVectors(tmpRight, forward)
    shotDir
      .copy(forward)
      .addScaledVector(tmpRight, Math.cos(angle) * cone)
      .addScaledVector(tmpUp, Math.sin(angle) * cone)
      .normalize()

    // 场景 / 丧尸 / Boss 取最近命中。各系统的 RayHit 是复用对象，立刻拷出需要的字段
    let dist: number = MAX_SHOT_DISTANCE
    let kind: RayHit['kind'] | null = null
    let enemy: EnemyActor | null = null
    let head = false
    let zone: BossZone = 'body'

    const worldHit = ctx.world.raycast(eye, shotDir, dist)
    if (worldHit) {
      kind = 'world'
      dist = worldHit.distance
      hitPoint.copy(worldHit.point)
      hitNormal.copy(worldHit.normal)
    }
    const enemyHit = ctx.enemies.raycast(eye, shotDir, dist)
    if (enemyHit && enemyHit.enemy && enemyHit.distance <= dist) {
      kind = 'enemy'
      dist = enemyHit.distance
      enemy = enemyHit.enemy
      head = enemyHit.headshot === true
      hitPoint.copy(enemyHit.point)
      hitNormal.copy(enemyHit.normal)
    }
    if (ctx.boss.active) {
      const bossHit = ctx.boss.raycast(eye, shotDir, dist)
      if (bossHit && bossHit.distance <= dist) {
        kind = 'boss'
        dist = bossHit.distance
        zone = bossHit.bossZone ?? 'body'
        hitPoint.copy(bossHit.point)
        hitNormal.copy(bossHit.normal)
      }
    }
    if (kind === null) hitPoint.copy(eye).addScaledVector(shotDir, MAX_SHOT_DISTANCE)

    // 枪口火光与曳光从视图模型的枪口出发
    if (!view.muzzleWorld(actor.currentWeapon, muzzlePos)) {
      muzzlePos
        .copy(eye)
        .addScaledVector(forward, MUZZLE_FALLBACK.forward)
        .addScaledVector(tmpRight, MUZZLE_FALLBACK.right)
      muzzlePos.y -= MUZZLE_FALLBACK.down
    }
    ctx.effects.muzzleFlash(muzzlePos, forward, VIEW_MODEL_SCALE)
    ctx.effects.tracer(muzzlePos, hitPoint)
    ctx.audio.play(SHOT_SFX[def.id])
    ctx.audio.play('shell', { volume: SFX_VOLUME.shell, rate: rng.range(0.9, 1.1) })

    // 伤害随距离衰减
    const damage = def.damage * lerp(1, def.falloffMin, invLerp(def.falloffStart, def.falloffEnd, dist))
    let hit = false

    if (kind === 'enemy' && enemy) {
      hit = true
      const wasAlive = enemy.alive
      ctx.effects.impact(hitPoint, hitNormal, 'blood')
      damageInfo.headshot = head
      ctx.enemies.applyDamage(enemy, head ? damage * HEADSHOT.multiplier : damage, damageInfo)
      const kill = wasAlive && (!enemy.alive || enemy.hp <= 0)
      ctx.audio.play(head ? 'headshot' : 'hit')
      ctx.events.emit('playerHit', { headshot: head, kill, weak: false })
    } else if (kind === 'boss') {
      const weak = zone === 'headCore' || zone === 'backCore'
      ctx.effects.impact(hitPoint, hitNormal, weak ? 'core' : 'goo')
      // 尸体仍然挡子弹，但不再算命中
      if (ctx.boss.alive) {
        hit = true
        damageInfo.headshot = false
        ctx.boss.applyDamage(damage, zone, damageInfo)
        const kill = !ctx.boss.alive
        if (weak) ctx.audio.play('hit', { volume: SFX_VOLUME.weakHit })
        else ctx.audio.play('hit')
        ctx.events.emit('playerHit', { headshot: false, kill, weak })
      }
    } else if (kind === 'world') {
      ctx.effects.bulletHole(hitPoint, hitNormal)
      ctx.effects.impact(hitPoint, hitNormal, 'world')
    }
    ctx.events.emit('shotFired', { shooter: actor.id, weapon: def.id, hit })

    // 后坐：一部分直接抬高瞄准角（不回落），其余进入停火后回落的偏移；水平带少量随机
    const kickUp = RECOIL.pitch * def.recoil
    pitch = clamp(pitch + kickUp * RECOIL.permanent, -PITCH_LIMIT, PITCH_LIMIT)
    recoilPitch = Math.min(RECOIL.maxPitch, recoilPitch + kickUp * (1 - RECOIL.permanent))
    recoilYaw = clamp(recoilYaw + rng.range(-1, 1) * RECOIL.yaw * def.recoil, -RECOIL.maxYaw, RECOIL.maxYaw)
    bloom = Math.min(SPREAD.bloomMax, bloom + SPREAD.bloomPerShot)
    view.kick(def.recoil)
  }

  /**
   * 切枪、换弹与射击。
   * @param alive 是否存活（换弹计时只在存活时推进）
   * @param canUse 是否响应武器输入（未眩晕、未在锁定读条、操作未被关闭）
   */
  function updateWeapons(dt: number, alive: boolean, canUse: boolean): void {
    const input = ctx.input
    // 滚轮每帧都取走，避免不可操作期间累积
    const wheel = input.consumeWheel()
    if (switchTimer > 0) switchTimer = Math.max(0, switchTimer - dt)
    fireTimer -= dt

    const count = Math.min(actor.weapons.length, DIGIT_CODES.length)
    if (canUse && count > 1) {
      if (wheel !== 0) {
        startSwitch((actor.currentWeapon + (wheel > 0 ? 1 : count - 1)) % count)
      } else {
        for (let i = 0; i < count; i++) {
          const code = DIGIT_CODES[i]
          if (code !== undefined && input.wasPressed(code)) {
            startSwitch(i)
            break
          }
        }
      }
    }

    const weapon = actor.weapon
    if (!weapon || !alive) {
      reloadTimer = -1
      dryLatch = false
      firingNow = false
      if (fireTimer < 0) fireTimer = 0
      return
    }
    const def = WEAPONS[weapon.id]

    // 换弹推进：完成时从备弹补入弹匣
    if (reloadTimer >= 0) {
      reloadTimer += dt
      if (reloadTimer >= def.reloadTime) {
        const take = Math.min(def.magSize - weapon.mag, weapon.reserve)
        weapon.mag += take
        weapon.reserve -= take
        reloadTimer = -1
      }
    }

    const triggerDown = input.isMouseDown(0)
    // HUD 的准星高亮：按住左键且武器随时能响（换弹、切枪、空仓都不算）
    firingNow = canUse && triggerDown && switchTimer <= 0 && reloadTimer < 0 && weapon.mag > 0
    if (canUse && switchTimer <= 0 && reloadTimer < 0) {
      if (input.wasPressed('KeyR')) {
        startReload(weapon, def)
      } else if (triggerDown && fireTimer <= 0) {
        if (weapon.mag > 0) {
          // 全自动：按射速补发，余数留在 fireTimer 里保证长期射速准确
          const interval = 60 / def.rpm
          let shots = 0
          while (fireTimer <= 0 && weapon.mag > 0 && shots < FIRE_MAX_PER_FRAME) {
            fireShot(weapon, def)
            fireTimer += interval
            shots += 1
          }
        } else if (!dryLatch) {
          // 空仓：每次扣扳机响一下，有备弹就自动换弹
          dryLatch = true
          ctx.audio.play('dry')
          startReload(weapon, def)
        }
      }
    }
    if (!triggerDown || weapon.mag > 0) dryLatch = false
    if (fireTimer < 0) fireTimer = 0
  }

  /* ── 状态切换 ── */

  function onStatusChanged(from: ActorStatus, to: ActorStatus): void {
    cancelHold()
    hasInteraction = false
    reloadTimer = -1
    switchTimer = 0
    dryLatch = false
    recoilPitch = 0
    recoilYaw = 0
    bloom = 0
    firingNow = false
    aimingEnemyNow = false

    if (to === 'downed') {
      bodyYaw = yaw
      pitch = 0
      velX = 0
      velZ = 0
    } else if (to === 'dead') {
      if (from !== 'downed') {
        // 没经过倒地直接阵亡（如未登机）：从默认机位开始
        bodyYaw = yaw
        tpYaw = yaw
        tpElev = THIRD.elev
        tpDist = THIRD.dist
      }
      deadTime = 0
      deadElevFrom = tpElev
      deadDistFrom = tpDist
      velX = 0
      velZ = 0
    } else if (to === 'alive') {
      // 被救起：回到第一人称并重新举枪
      switchFrom = actor.currentWeapon
      switchTimer = PLAYER.switchTime * 0.5
    }

    const showBody = to === 'downed' || to === 'dead'
    syncBodyMode(to)
    if (showBody) {
      body.root.position.copy(actor.position)
      body.root.rotation.y = bodyYaw
    }
  }

  /* ── 系统接口 ── */

  const offDamaged = ctx.events.on('combatantDamaged', (payload) => {
    if (payload.who !== actor || !ready) return
    if (clock - lastHurtAt >= HURT.minInterval) {
      lastHurtAt = clock
      ctx.audio.play('hurt')
    }
    ctx.effects.shake(Math.min(HURT.shakeMax, HURT.shakeBase + payload.amount * HURT.shakePerDamage), HURT.shakeTime)
  })

  function init(): void {
    ready = true
    const pos = actor.position
    pos.y = ctx.world.groundHeight(pos.x, pos.z, 0)
    applyCamera(actor.status)
    ctx.audio.setListener(eye, forward)
  }

  function update(dt: number): void {
    clock += dt
    actor.tickStatus(dt)
    const status = actor.status
    if (status !== prevStatus) {
      onStatusChanged(prevStatus, status)
      prevStatus = status
    }
    syncWeapons()

    const alive = status === 'alive'
    const stunned = alive && actor.stunTimer > 0
    const canAct = alive && controlEnabled && !stunned
    wobble = damp(wobble, stunned ? 1 : 0, STUN.rate, dt)

    readLook(controlEnabled && status !== 'dead')

    // 交互先于移动：救援 / 样本读条期间锁住移动与射击
    let locked = false
    if (canAct) {
      locked = updateInteraction(dt)
    } else {
      cancelHold()
      hasInteraction = false
    }

    if (status === 'boarded') {
      beginSeat()
      seatTimer = Math.min(seatTimer + dt, INTERACT.seatBlendTime)
      actor.velocity.set(0, 0, 0)
      actor.airborne = false
      moveSpeed = 0
      sprinting = false
      bobAmount = 0
    } else {
      updateMovement(dt, status, controlEnabled && !locked && !stunned && status !== 'dead')
    }
    updateThirdPerson(dt, status)
    updateAim(dt)

    // 先写一次相机：射击要用本帧的眼睛位置，枪口位置也取自相机下的视图模型
    applyCamera(status)
    firedThisFrame = false
    updateWeapons(dt, alive, canAct && !locked)
    // 准星指向检测用开火后的视线，与画面中心的指向一致
    updateAimEnemy()
    // 开火后视角被后坐抬高：重写第一人称相机
    if (firedThisFrame) applyFirstPerson()

    viewInput.visible = alive
    viewInput.slot = switchTimer > PLAYER.switchTime * 0.5 ? switchFrom : actor.currentWeapon
    viewInput.lookX = lookDX
    viewInput.lookY = lookDY
    viewInput.bobPhase = bobPhase
    viewInput.bob = bobAmount
    viewInput.sprinting = sprinting && grounded && moveSpeed > PLAYER.walkSpeed * 0.5
    viewInput.reload = reloadProgress()
    viewInput.switchProgress = switchTimer > 0 ? 1 - switchTimer / PLAYER.switchTime : -1
    view.update(dt, viewInput)

    if (status === 'downed' || status === 'dead') {
      body.root.position.copy(actor.position)
      body.root.rotation.y = bodyYaw
      bodyAnim.pose = status === 'downed' ? 'downed' : 'dead'
      bodyAnim.speed = status === 'downed' ? moveSpeed : 0
      body.update(dt, bodyAnim)
    } else if (status === 'alive') {
      // 第一人称：身体朝向视线、略向后放，双腿按移动速度走 / 跑；躯干按持枪瞄准姿态摆（头与双臂只投影）
      const pos = actor.position
      // 低头时再往后放：镜头移到胸口前方，看到的是胸腹正面、腰带和脚，而不是肩头与领口
      const back = BODY_BACK + BODY_BACK_DOWN * smoothstep((-pitch - 0.3) / 0.8)
      body.root.position.set(pos.x - Math.sin(yaw) * back, pos.y, pos.z - Math.cos(yaw) * back)
      body.root.rotation.y = yaw
      const armed = actor.weapon !== undefined
      const reload = reloadProgress()
      bodyAnim.pose = 'stand'
      bodyAnim.speed = moveSpeed
      bodyAnim.aiming = armed && !viewInput.sprinting
      // 瞄准俯仰会让躯干前倾：低头时限制前倾，胸口始终留在镜头后下方，不会顶到近裁剪面
      bodyAnim.aimPitch = Math.max(pitch, BODY_MIN_AIM_PITCH)
      bodyAnim.action = reload >= 0 ? 'reload' : 'none'
      bodyAnim.actionProgress = reload >= 0 ? reload : 0
      body.update(dt, bodyAnim)
    }

    ctx.audio.setListener(eye, forward)
  }

  function reloadProgress(): number {
    const weapon = actor.weapon
    if (reloadTimer < 0 || !weapon) return -1
    return clamp(reloadTimer / WEAPONS[weapon.id].reloadTime, 0, 1)
  }

  function setControl(enabled: boolean): void {
    controlEnabled = enabled
    if (enabled) return
    cancelHold()
    hasInteraction = false
  }

  function dispose(): void {
    offDamaged()
    cancelHold()
    hasInteraction = false
    camera.remove(view.root)
    view.dispose()
    ctx.scene.remove(body.root)
    body.dispose()
  }

  // 引擎首帧之前相机也要在出生点
  applyFirstPerson()

  return {
    actor,
    forward,
    eye,
    get yaw(): number {
      return wrapAngle(viewYaw)
    },
    get reloadProgress(): number {
      return reloadProgress()
    },
    get spread(): number {
      return currentSpread()
    },
    get firing(): boolean {
      return firingNow
    },
    get aimingEnemy(): boolean {
      return aimingEnemyNow
    },
    get interaction(): InteractionInfo | null {
      return hasInteraction ? interactionInfo : null
    },
    seatOffset,
    setControl,
    init,
    update,
    dispose,
  }
}

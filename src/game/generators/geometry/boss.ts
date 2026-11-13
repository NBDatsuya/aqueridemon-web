/**
 * Boss 阿奎尔巨兽（变异章鱼）的程序化模型与动画。
 *
 * 结构：root（位置与朝向归 Boss 系统）→ body（身体姿态：升降、俯仰、侧倾、缩放）→ 身体曲面 / 眼睛 / 两个核心。
 * 触手、吸盘、尖刺、突刺红光与死亡时流出的液体直接挂在 root 下，在 root 本地空间里摆放。
 * 触手：每条是一条三次贝塞尔曲线；每帧沿曲线采样中心线，交给 boss-tentacles.ts 改写蒙皮管的顶点（8 条共用一个几何体），
 * 不新建几何体、不分配对象。
 * 动画：每个模式只给出“目标姿态”，当前姿态按指数阻尼追过去，所以模式切换不会跳变。
 *
 * 外观分在几个辅助文件里：boss-shared.ts（体型常量与调色板）、boss-body.ts（身体曲面、眼睑、核心与眼睛的组装）、
 * boss-tentacles.ts（触手蒙皮、吸盘、尖刺）、boss-materials.ts（材质与程序贴图）。这里负责姿态、动画与命中球。
 */

import { Color, Group, Matrix4, Mesh, SphereGeometry, Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import { BOSS, GAME_SEED } from '../../core/config'
import type { BossAnimInput, BossAnimMode, BossHitSphere, BossRig, BossZone } from '../../core/types'
import { clamp, lerp, smoothstep, wrapAngle } from '../../utils/math'
import { createRng } from '../../utils/random'
import {
  buildCore,
  buildEye,
  createBodyGeometry,
  createEyeballGeometry,
  createLidGeometry,
  createPuddleGeometry,
  createRimGeometry,
} from './boss-body'
import { createBossMaterials } from './boss-materials'
import {
  ARM_POINTS,
  ARM_SEGMENTS,
  ATTACH_RADIUS,
  ATTACH_Y,
  BACK_CORE_POS,
  BACK_CORE_RADIUS,
  BACK_CORE_TILT,
  BASE_RADIUS,
  CORE_INNER_RADIUS,
  HEAD_CORE_POS,
  HEAD_CORE_RADIUS,
  TAU,
  TENTACLES,
  TENTACLE_LENGTH,
  TIP_RADIUS,
  armAzimuth,
} from './boss-shared'
import { createArmSkin } from './boss-tentacles'

/* ── 命中球（模型坐标：原点在地面中心，正面朝 +Z）。核心与触手的体型常量在 boss-shared.ts ── */

/** 身体命中球。两个核心都要略微探出球面，射线才会先碰到核心 */
const BODY_FRONT_POS = new Vector3(0, 1.55, 0.45)
const BODY_FRONT_RADIUS = 1.45
const BODY_BACK_POS = new Vector3(0, 1.7, -0.95)
const BODY_BACK_RADIUS = 1.4

/** 身体俯仰 / 缩放的轴心高度 */
const PIVOT_Y = 0.9

/** 正前方的两条触手：横扫与突刺用它们 */
const FRONT_A = 0
const FRONT_B = TENTACLES - 1
/**
 * 触手的命中球与粗细按“中心线 12 等分的折线”来算，与蒙皮用的分段数无关：
 * 蒙皮分段可以调，命中球不跟着变
 */
const HIT_DIVISIONS = 12
/** 12 等分点在蒙皮采样点里的间隔 */
const HIT_STRIDE = ARM_SEGMENTS / HIT_DIVISIONS
/** 每条触手 3 个命中球，取这些等分点 */
const HIT_SAMPLES: readonly number[] = [3, 7, 11]
const HITS_PER_TENTACLE = HIT_SAMPLES.length
/** 触手命中球比外观略大一点 */
const HIT_PAD = 0.1
/** 命中球数组里排在触手前面的个数：身体 ×2 + 头部核心 + 背部核心 */
const FIXED_SPHERES = 4

/* ── 静止姿态与节奏 ── */

/** 触手尖端到根部的水平距离：静止时卷着，整体长度约 8 米 */
const REST_REACH = 2.9
const REST_TIP_Y = 0.12
/** 两个控制点的高度：靠根部的一段拱起，靠尖端的一段贴地 */
const REST_LIFT1 = 1.45
const REST_LIFT2 = 0.2
/** 头部核心眼睑的开度：平时半开，硬直时全开 */
const REST_CORE_OPEN = 0.45
const REST_CORE_GLOW = 1.4
/** 背部核心被盖住时的微弱亮度 */
const REST_BACK_GLOW = 0.05
/** 眼睑全开时转过的角度 */
const LID_SWING = 1.45
/** 默认阻尼速率（1/秒） */
const BODY_RATE = 7
const TENTACLE_RATE = 6
/** 皮肤变红的速率（1/秒）：转阶段咆哮的 3 秒里基本变完 */
const RAGE_RATE = 1.2
/** 狂暴后动作幅度与速度的增量 */
const RAGE_VIGOR = 0.5
/** 核心搏动角速度（弧度 / 秒） */
const PULSE_SPEED = 4
/** 受击闪烁的衰减速率（1/秒） */
const FLASH_DECAY = 9
/** 核心受击时额外的发光强度 */
const CORE_FLASH = 4
/** 死后流出的发光液体半径 */
const LEAK_RADIUS = 1.5

/* ── 发光与配色 ── */

/** 核心内层发光体的自发光倍率：平时约 2，硬直 / 趴倒暴露时约 5，溢光交给 Bloom */
const INNER_GAIN = 1.5
/** 核心外膜透光的倍率 */
const SHELL_GAIN = 0.45
/** 核心的光漏到周围肉褶上的比例 */
const RIM_SPILL = 0.09
/** 突刺前摇时尖端红光的最大自发光强度 */
const TIP_GLOW_GAIN = 5
/** 眼睛平时的自发光强度（虹膜微微透亮） */
const EYE_GLOW = 0.12
/** 眼睑平时张开的角度（弧度，上下各一片） */
const EYE_OPEN = 0.5
/** 眨眼周期（秒） */
const BLINK_PERIOD = 4.3

const WHITE = new Color(1, 1, 1)
/** 狂暴时皮肤材质的染色（分量可以大于 1）：把紫红的固有色压成深红 */
const TINT_RAGE = new Color(1.25, 0.27, 0.16)
const SUCKER_RAGE = new Color(1.1, 0.5, 0.45)
const SHEEN_CALM = new Color(0xff9aa8)
const SHEEN_RAGE = new Color(0xff3a2a)
/** 核心内层发光体的固有色（很暗，亮度全靠自发光）与死亡后的颜色 */
const CORE_BODY = new Color(0x1a0600)
const CORE_DEAD = new Color(0x0c0504)
/** 核心外膜死亡后失去血色 */
const SHELL_DEAD = new Color(0x2e1a16)

/* ── 招式参数 ── */

/** emerge 全程的划动次数 */
const EMERGE_STROKES = 5
/**
 * 横扫的起止方位（弧度，正前方为 0）：0 号触手从 +70° 扫到 −80°，另一条镜像。
 * 尖端拖在后面，实际扫过的范围比这组角度窄，所以终点要越过 60° 不少
 */
const SWEEP_FROM = 1.22
const SWEEP_TO = -1.4
/** 横扫时尖端到根部的水平距离：加上根部偏移后，尖端离身体中心约 BOSS.sweep.radius */
const SWEEP_REACH = BOSS.sweep.radius - 1
/** 突刺时尖端越过目标点的距离 */
const STAB_OVERSHOOT = 0.8
/** 突刺时根部到尖端的最大水平距离：尖端离身体中心不超过约 BOSS.stab.range */
const STAB_MAX_REACH = BOSS.stab.range - ATTACH_RADIUS
/** 突刺蓄力时触手缩回盘起的姿态 */
const STAB_COIL_REACH = 1.3
const STAB_COIL_TIP_Y = 1.7
/** stagger 全程的喘息次数 */
const STAGGER_PANTS = 3
/** roar 全程每条触手抽打地面的次数 */
const ROAR_SLAMS = 5
/** prone 全程的起伏次数 */
const PRONE_BREATHS = 2

/* ── 姿态参数 ── */

interface BodyPose {
  /** 底面离地高度（负值 = 陷进地面） */
  y: number
  /** 前后位移 */
  z: number
  /** 俯仰：正值前倾，负值仰头 */
  pitch: number
  roll: number
  /** 整体缩放（膨胀 / 收缩） */
  scale: number
  /** 竖直方向的压扁倍率；压扁时水平方向相应摊开 */
  squash: number
  /** 高频颤抖幅度（弧度） */
  shake: number
  /** 头部核心眼睑开度 0..1 */
  coreOpen: number
  coreGlow: number
  /** 背部核心盖子开度 0..1 */
  backOpen: number
  backGlow: number
  /** 突刺触手尖端的红光 0..1 */
  tipGlow: number
  /** 核心破裂变暗的程度 0..1 */
  death: number
}

const BODY_KEYS: readonly (keyof BodyPose)[] = [
  'y',
  'z',
  'pitch',
  'roll',
  'scale',
  'squash',
  'shake',
  'coreOpen',
  'coreGlow',
  'backOpen',
  'backGlow',
  'tipGlow',
  'death',
]

const REST_BODY: Readonly<BodyPose> = {
  y: 0,
  z: 0,
  pitch: 0,
  roll: 0,
  scale: 1,
  squash: 1,
  shake: 0,
  coreOpen: REST_CORE_OPEN,
  coreGlow: REST_CORE_GLOW,
  backOpen: 0,
  backGlow: REST_BACK_GLOW,
  tipGlow: 0,
  death: 0,
}

interface TentaclePose {
  /** 相对触手自身方位角的水平偏转 */
  yaw: number
  /** 尖端到根部的水平距离 */
  reach: number
  tipY: number
  /** 靠根部控制点的高度 */
  lift1: number
  /** 靠尖端控制点的高度 */
  lift2: number
  /** 侧向卷曲（米，带符号） */
  bend: number
  /** 拉直程度 0..1：1 时整条触手是从根部到尖端的直线 */
  straight: number
  /** 自主摆动的幅度倍率 */
  sway: number
}

const TENTACLE_KEYS: readonly (keyof TentaclePose)[] = [
  'yaw',
  'reach',
  'tipY',
  'lift1',
  'lift2',
  'bend',
  'straight',
  'sway',
]

interface Tentacle {
  /** 方位角：0 = 正前方（+Z），正值转向 +X */
  angle: number
  /** 方位角对应的水平单位方向 */
  outX: number
  outZ: number
  /** 静止时的侧向卷曲，相邻触手方向相反 */
  curl: number
  /** 自主摆动的三组角速度与初相，每条触手各不相同 */
  f1: number
  f2: number
  f3: number
  ph1: number
  ph2: number
  ph3: number
  cur: TentaclePose
  goal: TentaclePose
  /** 本帧的阻尼速率 */
  rate: number
  /** 尖端位置（root 本地坐标），每次 update 刷新 */
  tip: Vector3
}

function createTentaclePose(curl: number): TentaclePose {
  return {
    yaw: 0,
    reach: REST_REACH,
    tipY: REST_TIP_Y,
    lift1: REST_LIFT1,
    lift2: REST_LIFT2,
    bend: curl,
    straight: 0,
    sway: 1,
  }
}

/**
 * 创建 Boss 阿奎尔巨兽的模型绑定。
 *
 * root 原点在地面、正面朝本地 +Z，位置与朝向由 Boss 系统写入；这里只驱动子节点。
 * 每帧调用 update(dt, anim) 推进动画并刷新命中球；不再使用时调用 dispose() 释放全部几何体与材质。
 * @returns Boss 绑定：命中球共 28 个（身体 2、头部核心 1、背部核心 1、触手 8 × 3）
 */
export function createBossRig(): BossRig {
  const rng = createRng(GAME_SEED + 9001)
  const geometries: BufferGeometry[] = []

  function ownGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry)
    return geometry
  }

  const mats = createBossMaterials(GAME_SEED + 9201)

  /* ── 身体 ── */

  const root = new Group()
  root.name = 'boss-aqueridemon'
  /** 身体姿态节点：轴心在 PIVOT_Y 高度 */
  const body = new Group()
  root.add(body)
  /** 把模型坐标（原点在地面）挪到以轴心为原点 */
  const model = new Group()
  model.position.y = -PIVOT_Y
  body.add(model)

  const bodyMesh = new Mesh(ownGeometry(createBodyGeometry(GAME_SEED + 9101)), mats.skin)
  bodyMesh.castShadow = true
  bodyMesh.receiveShadow = true
  model.add(bodyMesh)

  // 眼睑与肉褶的几何体由核心和眼睛共用
  const lidGeo = ownGeometry(createLidGeometry(GAME_SEED + 9103))
  const rimGeo = ownGeometry(createRimGeometry(GAME_SEED + 9104))

  const eyeShapes = { ball: ownGeometry(createEyeballGeometry()), lid: lidGeo, rim: rimGeo }
  const rightEye = buildEye(1, eyeShapes, mats.eye, mats.skin)
  const leftEye = buildEye(-1, eyeShapes, mats.eye, mats.skin)
  model.add(rightEye.pivot, leftEye.pivot)

  const coreShapes = {
    inner: ownGeometry(new SphereGeometry(CORE_INNER_RADIUS, 20, 14)),
    shell: ownGeometry(new SphereGeometry(1, 28, 18)),
    lid: lidGeo,
    rim: rimGeo,
  }
  const headCore = buildCore(coreShapes, mats.headInner, mats.headShell, mats.skin, mats.headRim, HEAD_CORE_RADIUS)
  headCore.pivot.name = 'head-core'
  headCore.inner.name = 'inner'
  headCore.upperLid.name = 'upper-lid'
  headCore.pivot.position.copy(HEAD_CORE_POS)
  model.add(headCore.pivot)

  const backCore = buildCore(coreShapes, mats.backInner, mats.backShell, mats.skin, mats.backRim, BACK_CORE_RADIUS)
  backCore.pivot.name = 'back-core'
  backCore.inner.name = 'inner'
  backCore.upperLid.name = 'upper-lid'
  backCore.pivot.position.copy(BACK_CORE_POS)
  backCore.pivot.rotation.x = BACK_CORE_TILT
  model.add(backCore.pivot)

  /* ── 触手：8 条共用一个蒙皮几何体，吸盘与尖刺各一个 InstancedMesh ── */

  const tentacles: Tentacle[] = []
  /** 每条触手的明暗色差 */
  const tints: number[] = []
  for (let i = 0; i < TENTACLES; i++) {
    const angle = armAzimuth(i)
    const curl = (i % 2 === 0 ? 1 : -1) * rng.range(0.7, 1.1)
    tentacles.push({
      angle,
      outX: Math.sin(angle),
      outZ: Math.cos(angle),
      curl,
      f1: rng.range(0.7, 1.2),
      f2: rng.range(1.1, 1.8),
      f3: rng.range(0.5, 0.9),
      ph1: rng.range(0, TAU),
      ph2: rng.range(0, TAU),
      ph3: rng.range(0, TAU),
      cur: createTentaclePose(curl),
      goal: createTentaclePose(curl),
      rate: TENTACLE_RATE,
      tip: new Vector3(),
    })
    tints.push(rng.range(0.92, 1.06))
  }
  const arms = createArmSkin(mats.arm, mats.sucker, mats.spike, GAME_SEED + 9105, tints)
  root.add(arms.mesh, arms.suckers, arms.spikes)

  /** 突刺前摇时套在触手尖端的红色光球 */
  const tipGlow = new Mesh(ownGeometry(new SphereGeometry(0.3, 12, 8)), mats.tipGlow)
  tipGlow.name = 'tip-glow'
  tipGlow.visible = false
  root.add(tipGlow)

  /** 核心破裂后流到地上的发光液体 */
  const leak = new Mesh(ownGeometry(createPuddleGeometry(GAME_SEED + 9106)), mats.leak)
  leak.name = 'leak'
  // 死亡时身体倒向 −X 一侧，头部核心落在正前方偏 −X 的地面附近
  leak.position.set(-0.3, 0.04, 2.5)
  leak.visible = false
  root.add(leak)

  /* ── 命中球 ── */

  const hitSpheres: BossHitSphere[] = [
    { center: new Vector3(), radius: BODY_FRONT_RADIUS, zone: 'body' },
    { center: new Vector3(), radius: BODY_BACK_RADIUS, zone: 'body' },
    { center: new Vector3(), radius: HEAD_CORE_RADIUS, zone: 'headCore' },
    { center: new Vector3(), radius: BACK_CORE_RADIUS, zone: 'backCore' },
  ]
  for (let i = 0; i < TENTACLES * HITS_PER_TENTACLE; i++) {
    hitSpheres.push({ center: new Vector3(), radius: BASE_RADIUS, zone: 'tentacle' })
  }

  /* ── 运行状态与复用的临时对象 ── */

  const cur: BodyPose = { ...REST_BODY }
  const goal: BodyPose = { ...REST_BODY }
  let bodyRate = BODY_RATE
  /** 狂暴程度 0..1（皮肤颜色与动作幅度都按它渐变） */
  let rage = 0
  let clock = 0
  let swayClock = 0
  let pulseClock = 0
  let lastMode: BossAnimMode | null = null
  /** 第一次 update 之前为 false：第一帧姿态直接到位，不做阻尼 */
  let primed = false
  let stabIndex = FRONT_A
  let flashBody = 0
  let flashTentacle = 0
  let flashHead = 0
  let flashBack = 0
  let disposed = false

  /** 当前这条触手中心线上的采样点（x, y, z 连续存放，root 本地坐标），从根部到尖端 */
  const points = new Float64Array(ARM_POINTS * 3)
  const p0 = new Vector3()
  const p1 = new Vector3()
  const p2 = new Vector3()
  const p3 = new Vector3()
  const span = new Vector3()
  const invRoot = new Matrix4()
  const tint = new Color()
  /** 两个核心本帧的发光强度（已含搏动与受击闪烁）；applySkin 用它给核心周围的肉褶打光 */
  let headLevel = 0
  let backLevel = 0
  /** 突刺目标点（root 本地坐标） */
  const stabLocal = new Vector3(0, 1, BOSS.preferredRange)

  function tent(index: number): Tentacle {
    return tentacles[index] as Tentacle
  }

  /** 模型坐标 → root 本地坐标（经过 body 的当前姿态）。原地修改并返回 v */
  function toRoot(v: Vector3): Vector3 {
    v.y -= PIVOT_Y
    return v.applyMatrix4(body.matrix)
  }

  /** 触手 t 根部的 root 本地坐标 */
  function baseOf(t: Tentacle, out: Vector3): Vector3 {
    toRoot(out.set(t.outX * ATTACH_RADIUS, ATTACH_Y, t.outZ * ATTACH_RADIUS))
    if (out.y < 0.3) out.y = 0.3
    return out
  }

  /** 把突刺目标换算到 root 本地坐标；没给目标时取正前方 */
  function aimStab(anim: BossAnimInput): void {
    if (anim.target) {
      invRoot.copy(root.matrixWorld).invert()
      stabLocal.copy(anim.target).applyMatrix4(invRoot)
    } else {
      stabLocal.set(0, 1, BOSS.preferredRange)
    }
  }

  /* ── 各模式的目标姿态 ── */

  /** 每帧先把目标复位到静止姿态，各模式只改自己关心的参数 */
  function resetGoals(vigor: number): void {
    for (let i = 0; i < BODY_KEYS.length; i++) {
      const key = BODY_KEYS[i] as keyof BodyPose
      goal[key] = REST_BODY[key]
    }
    goal.coreGlow = REST_CORE_GLOW + 0.5 * rage
    bodyRate = BODY_RATE
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const g = t.goal
      g.yaw = 0
      g.reach = REST_REACH
      g.tipY = REST_TIP_Y
      g.lift1 = REST_LIFT1
      g.lift2 = REST_LIFT2
      g.bend = t.curl
      g.straight = 0
      g.sway = vigor
      t.rate = TENTACLE_RATE
    }
  }

  /** idle：头部缓慢呼吸起伏，触手靠自主摆动各自晃动 */
  function poseIdle(p: number, vigor: number): void {
    const breath = Math.sin(p * TAU)
    goal.scale = 1 + 0.035 * vigor * breath
    goal.y = 0.04 + 0.04 * breath
    goal.pitch = 0.03 * Math.sin(p * TAU + 1.1)
  }

  /**
   * crawl：两组触手交替前探、落地、后拉，身体随节奏起伏。emerge 也复用它。
   * @param phase 步态相位（弧度）
   * @param effort 幅度倍率
   */
  function poseCrawl(phase: number, effort: number): void {
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const g = t.goal
      const ph = phase + (i % 2) * Math.PI
      const swing = Math.cos(ph)
      // 向前摆的半个周期里抬离地面，向后拉时贴地
      const lifted = Math.max(0, -Math.sin(ph))
      // 侧面的触手靠转向前摆，前后的触手靠伸缩
      g.yaw = -t.outX * 0.42 * effort * swing
      g.reach = REST_REACH + t.outZ * 0.9 * effort * swing
      g.tipY = REST_TIP_Y + 0.6 * effort * lifted
      g.lift1 = REST_LIFT1 + 0.35 * effort * lifted
      g.lift2 = REST_LIFT2 + 0.45 * effort * lifted
      g.sway = 0.5
      t.rate = 10
    }
    goal.y = 0.06 + 0.06 * effort * Math.sin(phase * 2)
    goal.z = 0.14 * effort * Math.sin(phase)
    goal.pitch = 0.05 * effort * Math.sin(phase + 0.6)
    goal.roll = 0.04 * effort * Math.sin(phase)
    bodyRate = 9
  }

  /** emerge：身体压低前倾，一下一下奋力向前扒；最后一小段收势站稳 */
  function poseEmerge(p: number, vigor: number): void {
    const settle = smoothstep((p - 0.85) / 0.15)
    const phase = p * EMERGE_STROKES * TAU
    const heave = Math.sin(phase)
    poseCrawl(phase, lerp(1.5, 0.6, settle) * vigor)
    // 前方两条触手伸得更远，像在扒地
    tent(FRONT_A).goal.reach += 0.9 * (1 - settle)
    tent(FRONT_B).goal.reach += 0.9 * (1 - settle)
    goal.pitch = lerp(0.24 + 0.1 * heave, 0, settle)
    goal.y = lerp(-0.1 + 0.1 * heave, 0.04, settle)
    goal.z = lerp(0.35 * heave, 0, settle)
    goal.coreOpen = lerp(0.3, REST_CORE_OPEN, settle)
  }

  /**
   * 摆放一条横扫触手。
   * @param side +1 = 从 +X 一侧扫向 −X 一侧，−1 相反
   * @param raise 1 = 高举蓄力，0 = 放平伸直
   * @param swing 横扫进度 0..1
   * @param rate 阻尼速率（1/秒）
   */
  function setSweepArm(index: number, side: number, raise: number, swing: number, rate: number): void {
    const t = tent(index)
    const g = t.goal
    g.yaw = wrapAngle(side * lerp(SWEEP_FROM, SWEEP_TO, swing) - t.angle)
    g.reach = lerp(SWEEP_REACH, 2.3, raise)
    g.tipY = lerp(0.75, 3.9, raise)
    g.lift1 = lerp(1.1, 2.5, raise)
    g.lift2 = lerp(0.85, 3.5, raise)
    // 甩鞭：中段领先、尖端拖在后面
    g.bend = -side * lerp(1.4, 0.5, raise)
    g.straight = 0.7 * (1 - raise)
    g.sway = 0.15
    t.rate = rate
  }

  /** sweepWindup：前方两条触手高高举到各自一侧，身体后仰蓄力 */
  function poseSweepWindup(p: number): void {
    setSweepArm(FRONT_A, 1, 1, 0, 8)
    setSweepArm(FRONT_B, -1, 1, 0, 8)
    const w = smoothstep(p)
    goal.pitch = -0.1 * w
    goal.y = 0.1 * w
    goal.z = -0.15 * w
    bodyRate = 9
  }

  /** sweep：两条触手先后砸平，交叉扫过前方扇形；第二条慢半拍 */
  function poseSweep(p: number): void {
    const swing = smoothstep((p - 0.04) / 0.7)
    setSweepArm(FRONT_A, 1, 1 - smoothstep(p / 0.22), swing, 28)
    setSweepArm(FRONT_B, -1, 1 - smoothstep((p - 0.1) / 0.22), smoothstep((p - 0.14) / 0.7), 28)
    // 身体前压，并跟着第一条触手的方向侧倾
    const lean = smoothstep(p / 0.3)
    goal.pitch = 0.14 * lean
    goal.z = 0.25 * lean
    goal.roll = lerp(-0.1, 0.1, swing) * lean
    bodyRate = 14
  }

  let stabYaw = 0
  let stabDist = 0

  /** 以突刺触手的根部为起点，算出指向目标的水平偏转（stabYaw）与水平距离（stabDist），返回这条触手 */
  function aimStabArm(anim: BossAnimInput): Tentacle {
    aimStab(anim)
    const t = tent(stabIndex)
    baseOf(t, p0)
    const dx = stabLocal.x - p0.x
    const dz = stabLocal.z - p0.z
    stabDist = Math.hypot(dx, dz)
    // 目标几乎在根部正上方时方向不稳定，沿用触手自身的方位
    stabYaw = stabDist > 0.05 ? wrapAngle(Math.atan2(dx, dz) - t.angle) : 0
    return t
  }

  /** stabWindup：一条前触手缩回盘起、尖端对准目标并亮起红光，身体后缩 */
  function poseStabWindup(p: number, anim: BossAnimInput): void {
    const t = aimStabArm(anim)
    const g = t.goal
    g.yaw = stabYaw
    g.reach = STAB_COIL_REACH
    g.tipY = STAB_COIL_TIP_Y
    g.lift1 = 2.1
    g.lift2 = 2.3
    g.bend = (stabIndex === FRONT_A ? -1 : 1) * 0.9
    g.sway = 0.1
    t.rate = 14
    goal.tipGlow = 0.35 + 0.65 * smoothstep(p)
    goal.pitch = -0.1
    goal.z = -0.25
    bodyRate = 10
  }

  /** stab：触手拉成直线刺向目标（略微刺过头），距离不够时触手被拉长变细 */
  function poseStab(p: number, anim: BossAnimInput): void {
    const t = aimStabArm(anim)
    const g = t.goal
    const thrust = smoothstep(p / 0.3)
    g.yaw = stabYaw
    g.reach = lerp(STAB_COIL_REACH, clamp(stabDist + STAB_OVERSHOOT, 2, STAB_MAX_REACH), thrust)
    g.tipY = lerp(STAB_COIL_TIP_Y, clamp(stabLocal.y, 0.3, BOSS.height), thrust)
    g.bend = 0
    g.straight = thrust
    g.sway = 0
    t.rate = 30
    goal.tipGlow = 1 - 0.5 * smoothstep((p - 0.5) / 0.5)
    goal.pitch = 0.14 * thrust
    goal.z = 0.45 * thrust
    bodyRate = 16
  }

  /** spitWindup：头部鼓胀并后仰，带着咕噜的鼓动；触手收紧撑地 */
  function poseSpitWindup(p: number): void {
    const w = smoothstep(p)
    goal.scale = 1 + 0.17 * w + 0.02 * w * Math.sin(p * 46)
    goal.pitch = -0.16 * w
    goal.y = 0.08 * w
    goal.z = -0.2 * w
    goal.coreGlow += 0.5 * w
    for (let i = 0; i < TENTACLES; i++) {
      const g = tent(i).goal
      g.reach = REST_REACH - 0.4 * w
      g.sway *= 0.5
    }
    bodyRate = 10
  }

  /** spit：头部猛地前倾喷吐并瘪下去，随后回正 */
  function poseSpit(p: number): void {
    const lunge = smoothstep(p / 0.18)
    const recover = smoothstep((p - 0.65) / 0.35)
    goal.pitch = lerp(-0.16, 0.42, lunge) * (1 - recover)
    goal.scale = lerp(lerp(1.17, 0.92, lunge), 1, recover)
    goal.z = lerp(-0.2, 0.4, lunge) * (1 - recover)
    goal.shake = 0.03 * lunge * (1 - recover)
    bodyRate = 18
  }

  /** summon：仰头尖啸，全身颤抖，触手尖端扬起 */
  function poseSummon(p: number, vigor: number): void {
    const env = smoothstep(p / 0.25) * (1 - smoothstep((p - 0.75) / 0.25))
    goal.pitch = -0.46 * env
    goal.y = 0.2 * env
    goal.scale = 1 + 0.05 * env
    goal.shake = 0.05 * env * vigor
    goal.coreOpen = lerp(REST_CORE_OPEN, 0.65, env)
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const g = t.goal
      g.tipY = REST_TIP_Y + env
      g.lift2 = REST_LIFT2 + 0.6 * env
      g.sway = vigor * (1 + 0.8 * env)
      t.rate = 12
    }
    bodyRate = 14
  }

  /**
   * 让全部触手瘫在地上。
   * @param reach 尖端到根部的水平距离
   * @param lift 靠根部一段的拱起高度
   * @param curl 侧向卷曲相对静止姿态的比例
   * @param sway 自主摆动幅度
   */
  function limpTentacles(reach: number, lift: number, curl: number, sway: number): void {
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const g = t.goal
      g.reach = reach
      g.tipY = 0.1
      g.lift1 = lift
      g.lift2 = 0.12
      g.bend = t.curl * curl
      g.sway = sway
    }
  }

  /** stagger：瘫软下来大口喘息，眼睑完全张开，头部核心更亮 */
  function poseStagger(p: number): void {
    const pant = Math.sin(p * STAGGER_PANTS * TAU)
    goal.y = -0.04
    goal.squash = 0.86 + 0.03 * pant
    goal.scale = 1 + 0.045 * pant
    goal.pitch = 0.12 + 0.03 * pant
    goal.coreOpen = 1
    goal.coreGlow = 3.4
    limpTentacles(3.6, 0.7, 0.5, 0.2)
  }

  /** roar：仰天咆哮、全身颤抖；触手轮流高举再砸向地面 */
  function poseRoar(p: number): void {
    const env = smoothstep(p / 0.15) * (1 - smoothstep((p - 0.85) / 0.15))
    goal.pitch = -0.52 * env
    goal.y = 0.3 * env
    goal.scale = 1 + 0.08 * env
    goal.shake = 0.07 * env
    goal.coreOpen = lerp(REST_CORE_OPEN, 0.7, env)
    goal.coreGlow += 1.2 * env
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const g = t.goal
      // 每条触手错开相位：七成时间举起，三成时间砸下
      const cycle = p * ROAR_SLAMS + i * 0.37
      const f = cycle - Math.floor(cycle)
      const up = (f < 0.7 ? smoothstep(f / 0.7) : 1 - smoothstep((f - 0.7) / 0.3)) * env
      g.tipY = REST_TIP_Y + 2.7 * up
      g.lift1 = REST_LIFT1 + 1.1 * up
      g.lift2 = REST_LIFT2 + 2.6 * up
      // 举起时收近，砸下时伸远
      g.reach = lerp(REST_REACH, lerp(4.2, 2.8, up), env)
      g.straight = 0.3 * env
      g.sway = 0.4
      t.rate = 22
    }
    bodyRate = 12
  }

  /** shockCharge：身体越鼓越大并开始颤抖，触手收拢绷紧，核心越来越亮 */
  function poseShockCharge(p: number): void {
    const w = smoothstep(p)
    goal.scale = 1 + 0.3 * w
    goal.y = 0.1 * w
    goal.shake = 0.05 * p * p
    goal.coreOpen = lerp(REST_CORE_OPEN, 0.6, w)
    goal.coreGlow += 1.6 * w
    for (let i = 0; i < TENTACLES; i++) {
      const g = tent(i).goal
      g.reach = lerp(REST_REACH, 1.9, w)
      g.tipY = REST_TIP_Y + 0.5 * w
      g.lift1 = REST_LIFT1 + 0.5 * w
      g.sway *= lerp(1, 0.4, w)
    }
    bodyRate = 8
  }

  /** shockRelease：身体猛然收缩压扁，触手贴地向四周甩直，随后略微回弹 */
  function poseShockRelease(p: number): void {
    const slam = smoothstep(p / 0.15)
    const rebound = smoothstep((p - 0.5) / 0.5)
    goal.scale = lerp(lerp(1.3, 0.76, slam), 0.9, rebound)
    goal.squash = lerp(1, 0.8, slam)
    goal.y = -0.05 * slam
    goal.shake = 0.06 * (1 - p)
    goal.coreGlow += 2 * (1 - p)
    limpTentacles(4.7, 0.6, 0.3, 0.1)
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      t.goal.straight = 0.7
      t.rate = 26
    }
    bodyRate = 26
  }

  /** prone：趴倒压扁、略向前栽，触手摊开；背部核心的盖子打开并发光 */
  function poseProne(p: number): void {
    const heave = Math.sin(p * PRONE_BREATHS * TAU)
    goal.y = -0.08
    goal.z = 0.2
    goal.squash = 0.72 + 0.02 * heave
    // 前倾角刚好抵消背部核心的后仰（BACK_CORE_TILT），核心正对上方，四面都打得到
    goal.pitch = 0.3
    goal.coreOpen = 0.15
    goal.coreGlow = 0.6
    goal.backOpen = 1
    goal.backGlow = 3 + 0.4 * heave
    limpTentacles(4.5, 0.5, 0.3, 0.15)
    for (let i = 0; i < TENTACLES; i++) tent(i).goal.straight = 0.5
    bodyRate = 9
  }

  /** dying：缓慢向一侧瘫倒，间歇抽搐且越来越弱；核心闪烁着熄灭 */
  function poseDying(p: number): void {
    const fall = smoothstep(p)
    const burst = Math.max(0, Math.sin(clock * 5.3))
    const spasm = burst * burst * (1 - p)
    goal.roll = 0.5 * fall + 0.08 * spasm * Math.sin(clock * 13)
    goal.pitch = 0.22 * fall
    goal.y = -0.1 * fall
    goal.squash = lerp(1, 0.76, fall)
    goal.shake = 0.05 * spasm
    goal.coreOpen = 0.75
    goal.coreGlow = REST_CORE_GLOW * (1 - fall) * (0.6 + 0.4 * Math.sin(clock * 17))
    goal.death = smoothstep((p - 0.45) / 0.55)
    limpTentacles(lerp(REST_REACH, 3.9, fall), lerp(REST_LIFT1, 0.45, fall), lerp(1, 0.4, fall), 0.3 * (1 - fall))
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      // 各条触手不同步地抽动
      t.goal.tipY = 0.1 + 0.9 * spasm * Math.max(0, Math.sin(clock * 19 + i * 2.3))
      t.rate = 12
    }
    bodyRate = 12
  }

  /** dead：保持倒地姿态不动（与 dying 的终点一致）；核心破裂变暗，发光液体流到地上 */
  function poseDead(): void {
    goal.roll = 0.5
    goal.pitch = 0.22
    goal.y = -0.1
    goal.squash = 0.76
    goal.coreOpen = 0.75
    goal.coreGlow = 0
    goal.backGlow = 0
    goal.death = 1
    limpTentacles(3.9, 0.45, 0.4, 0)
  }

  /** 进入新模式时做一次性的选择 */
  function enterMode(anim: BossAnimInput): void {
    const mode = anim.mode
    // 突刺用目标所在一侧的那条前触手；没有前摇直接进 stab 时也要选
    if (mode === 'stabWindup' || (mode === 'stab' && lastMode !== 'stabWindup')) {
      aimStab(anim)
      stabIndex = stabLocal.x >= 0 ? FRONT_A : FRONT_B
    }
  }

  function applyMode(anim: BossAnimInput, vigor: number): void {
    // 这样写能顺便把 NaN 挡成 0，免得一帧坏输入污染整套姿态
    const p = anim.progress > 0 ? Math.min(anim.progress, 1) : 0
    const speed = anim.moveSpeed > 0 ? anim.moveSpeed : 0
    // 目标已经复位到静止姿态，这里没列出的模式就保持静止
    switch (anim.mode) {
      case 'emerge':
        poseEmerge(p, vigor)
        break
      case 'idle':
        poseIdle(p, vigor)
        break
      case 'crawl':
        // 走得越快划得越用力；狂暴后移动更快，幅度随之变大
        poseCrawl(p * TAU, clamp(speed / BOSS.speed, 0.5, 1.7))
        break
      case 'sweepWindup':
        poseSweepWindup(p)
        break
      case 'sweep':
        poseSweep(p)
        break
      case 'stabWindup':
        poseStabWindup(p, anim)
        break
      case 'stab':
        poseStab(p, anim)
        break
      case 'spitWindup':
        poseSpitWindup(p)
        break
      case 'spit':
        poseSpit(p)
        break
      case 'summon':
        poseSummon(p, vigor)
        break
      case 'stagger':
        poseStagger(p)
        break
      case 'roar':
        poseRoar(p)
        break
      case 'shockCharge':
        poseShockCharge(p)
        break
      case 'shockRelease':
        poseShockRelease(p)
        break
      case 'prone':
        poseProne(p)
        break
      case 'dying':
        poseDying(p)
        break
      case 'dead':
        poseDead()
        break
    }
  }

  /* ── 把当前姿态写到场景节点 ── */

  function applyBody(): void {
    const sy = cur.scale * cur.squash
    // 压扁时向四周摊开，体积大致不变
    const sxz = cur.scale / Math.sqrt(Math.max(cur.squash, 0.2))
    // 轴心高度随竖直缩放调整，膨胀时底面仍贴着地面
    body.position.set(0, PIVOT_Y * sy + cur.y, cur.z)
    body.rotation.set(
      cur.pitch + cur.shake * 0.6 * Math.sin(clock * 29 + 1),
      0,
      cur.roll + cur.shake * Math.sin(clock * 37),
    )
    body.scale.set(sxz, sy, sxz)
    body.updateMatrix()
  }

  function applyCores(): void {
    const alive = 1 - cur.death
    const pulse = Math.sin(pulseClock) * alive
    const wither = 1 - 0.25 * cur.death

    // 头部核心：内核随搏动涨缩，外膜几乎不动（它的球面就是命中球）；死亡后干瘪发黑
    headLevel = Math.max(0, cur.coreGlow) * (1 + 0.25 * pulse) + flashHead * CORE_FLASH
    const headInner = (1 + 0.1 * pulse) * wither
    headCore.inner.scale.set(headInner, headInner * (1 - 0.4 * cur.death), headInner)
    const headShell = (1 + 0.008 * pulse) * (1 - 0.1 * cur.death)
    headCore.shell.scale.set(headShell, headShell * (1 - 0.3 * cur.death), headShell)
    const headLid = cur.coreOpen * LID_SWING
    headCore.upperLid.rotation.x = -headLid
    headCore.lowerLid.rotation.x = headLid
    mats.headInner.emissiveIntensity = INNER_GAIN * headLevel
    mats.headInner.color.lerpColors(CORE_BODY, CORE_DEAD, cur.death)
    mats.headShell.emissiveIntensity = SHELL_GAIN * headLevel
    mats.headShell.color.lerpColors(WHITE, SHELL_DEAD, cur.death)

    // 背部核心：平时缩在盖子下面，趴倒时盖子打开、核心鼓出来
    backLevel = Math.max(0, cur.backGlow) * (1 + 0.25 * pulse) + flashBack * CORE_FLASH
    const backSize = 0.8 + 0.2 * cur.backOpen
    backCore.inner.scale.setScalar(backSize * (1 + 0.1 * pulse) * wither)
    backCore.shell.scale.setScalar(backSize * (1 + 0.008 * pulse))
    const backLid = cur.backOpen * LID_SWING
    backCore.upperLid.rotation.x = -backLid
    backCore.lowerLid.rotation.x = backLid
    mats.backInner.emissiveIntensity = INNER_GAIN * backLevel
    mats.backInner.color.lerpColors(CORE_BODY, CORE_DEAD, cur.death)
    mats.backShell.emissiveIntensity = SHELL_GAIN * backLevel
    mats.backShell.color.lerpColors(WHITE, SHELL_DEAD, cur.death)

    // 核心破裂后流出的发光液体
    leak.visible = cur.death > 0.02
    if (leak.visible) leak.scale.setScalar(cur.death * LEAK_RADIUS)

    applyEyes()
  }

  /**
   * 眼睑开合。直接由已经阻尼过的身体姿态推出来，不另存状态：
   * 仰头咆哮时瞪大，瘫软 / 趴倒时耷拉，死亡后几乎合上；活着的时候隔几秒眨一次。
   */
  function applyEyes(): void {
    const alive = 1 - cur.death
    const phase = clock % BLINK_PERIOD
    // 合眼快、睁眼慢
    const blink = phase < 0.08 ? phase / 0.08 : phase < 0.26 ? 1 - (phase - 0.08) / 0.18 : 0
    const droop = clamp((1 - cur.squash) / 0.28, 0, 1)
    const widen = clamp(-cur.pitch / 0.5, 0, 1)
    const open =
      (EYE_OPEN + 0.12 * rage + 0.2 * widen) *
      (1 - 0.5 * droop) *
      (1 - 0.85 * cur.death) *
      (1 - 0.95 * smoothstep(blink) * alive)
    // 上眼睑压得低一些，眼神更沉
    rightEye.upperLid.rotation.x = -open * 0.8
    rightEye.lowerLid.rotation.x = open
    leftEye.upperLid.rotation.x = -open * 0.8
    leftEye.lowerLid.rotation.x = open
  }

  function applySkin(): void {
    const alive = 1 - cur.death
    const dim = 1 - 0.4 * cur.death
    // 固有色在顶点色里；材质颜色 = 贴图配平 × 狂暴染色 × 死亡变暗
    tint.lerpColors(WHITE, TINT_RAGE, rage).multiplyScalar(dim)
    mats.skin.color.copy(mats.skinBalance).multiply(tint)
    mats.arm.color.copy(mats.skin.color)
    mats.headRim.color.copy(mats.skin.color)
    mats.backRim.color.copy(mats.skin.color)
    mats.sucker.color.lerpColors(WHITE, SUCKER_RAGE, rage).multiplyScalar(dim)
    mats.spike.color.setScalar(dim)
    mats.skin.sheenColor.lerpColors(SHEEN_CALM, SHEEN_RAGE, rage)
    mats.arm.sheenColor.copy(mats.skin.sheenColor)

    // 狂暴后皮下透出暗红微光，随核心一起搏动；受击闪烁叠加在上面
    const ember = rage * alive * (0.1 + 0.04 * Math.sin(pulseClock))
    const er = ember + flashBody * 0.8
    const eg = ember * 0.06 + flashBody * 0.45
    const eb = ember * 0.04 + flashBody * 0.35
    mats.skin.emissive.setRGB(er, eg, eb)
    mats.arm.emissive.setRGB(
      ember + flashTentacle * 0.8,
      ember * 0.06 + flashTentacle * 0.45,
      ember * 0.04 + flashTentacle * 0.35,
    )
    mats.sucker.emissive.setRGB(flashTentacle * 0.5, flashTentacle * 0.28, flashTentacle * 0.22)

    // 核心周围的肉褶被核心的光映红：盖子开得越大漏出来的光越多
    const headSpill = RIM_SPILL * headLevel * (0.3 + 0.7 * cur.coreOpen)
    mats.headRim.emissive.setRGB(er + headSpill, eg + headSpill * 0.3, eb + headSpill * 0.08)
    const backSpill = RIM_SPILL * backLevel * cur.backOpen
    mats.backRim.emissive.setRGB(er + backSpill, eg + backSpill * 0.3, eb + backSpill * 0.08)

    mats.eye.emissiveIntensity = (EYE_GLOW + 0.9 * rage) * alive
  }

  /** 按当前姿态算出每条触手的贝塞尔曲线，改写蒙皮、吸盘与尖刺，并刷新触手命中球 */
  function layoutTentacles(): void {
    const world = root.matrixWorld
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const c = t.cur

      // 自主摆动：三组互不同步的正弦，每条触手的频率与相位都不同
      const sway = c.sway
      const w1 = Math.sin(swayClock * t.f1 + t.ph1)
      const w2 = Math.sin(swayClock * t.f2 + t.ph2)
      const w3 = Math.sin(swayClock * t.f3 + t.ph3)
      const yaw = c.yaw + sway * 0.15 * w1
      const reach = c.reach * (1 + sway * 0.05 * w3)
      const tipY = Math.max(0.08, c.tipY + sway * 0.14 * (1 + w2))
      const lift1 = c.lift1 + sway * 0.2 * w3
      const lift2 = Math.max(0.08, c.lift2 + sway * 0.12 * (1 + w1 * w2))
      const bend = c.bend + sway * 0.5 * w2
      const straight = c.straight

      // 四个控制点：根部跟着身体走；第一控制点从根部向外拱起；第二控制点靠近尖端并带侧向卷曲
      baseOf(t, p0)
      const a = t.angle + yaw
      const dirX = Math.sin(a)
      const dirZ = Math.cos(a)
      const perpX = dirZ
      const perpZ = -dirX
      p3.set(p0.x + dirX * reach - perpX * bend * 0.4, tipY, p0.z + dirZ * reach - perpZ * bend * 0.4)
      const out = reach * 0.16
      p1.set(p0.x + (t.outX + dirX) * out, lift1, p0.z + (t.outZ + dirZ) * out)
      p2.set(p0.x + dirX * reach * 0.75 + perpX * bend, lift2, p0.z + dirZ * reach * 0.75 + perpZ * bend)
      if (straight > 0.001) {
        // 拉直：两个控制点向“根部到尖端的三等分点”靠拢
        span.subVectors(p3, p0)
        p1.x = lerp(p1.x, p0.x + span.x / 3, straight)
        p1.y = lerp(p1.y, p0.y + span.y / 3, straight)
        p1.z = lerp(p1.z, p0.z + span.z / 3, straight)
        p2.x = lerp(p2.x, p0.x + (span.x * 2) / 3, straight)
        p2.y = lerp(p2.y, p0.y + (span.y * 2) / 3, straight)
        p2.z = lerp(p2.z, p0.z + (span.z * 2) / 3, straight)
      }

      // 沿曲线等参数采样；采样点不低于地面
      for (let k = 0; k < ARM_POINTS; k++) {
        const u = k / ARM_SEGMENTS
        const v = 1 - u
        const b0 = v * v * v
        const b1 = 3 * v * v * u
        const b2 = 3 * v * u * u
        const b3 = u * u * u
        const o = k * 3
        const y = b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y
        const floor = lerp(BASE_RADIUS, TIP_RADIUS, u) * 0.6
        points[o] = b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x
        points[o + 1] = y < floor ? floor : y
        points[o + 2] = b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z
      }

      // 弧长按 12 等分的折线累计。被拉长时变细，蜷缩时略微变粗
      let length = 0
      for (let k = HIT_STRIDE; k < ARM_POINTS; k += HIT_STRIDE) {
        const to = k * 3
        const from = to - HIT_STRIDE * 3
        const dx = (points[to] as number) - (points[from] as number)
        const dy = (points[to + 1] as number) - (points[from + 1] as number)
        const dz = (points[to + 2] as number) - (points[from + 2] as number)
        length += Math.sqrt(dx * dx + dy * dy + dz * dz)
      }
      const thin = clamp(Math.sqrt(TENTACLE_LENGTH / Math.max(length, 0.5)), 0.5, 1.15)

      arms.writeArm(i, points, thin)

      const end = ARM_SEGMENTS * 3
      t.tip.set(points[end] as number, points[end + 1] as number, points[end + 2] as number)

      for (let j = 0; j < HITS_PER_TENTACLE; j++) {
        const index = HIT_SAMPLES[j] as number
        const o = index * HIT_STRIDE * 3
        const sphere = hitSpheres[FIXED_SPHERES + i * HITS_PER_TENTACLE + j] as BossHitSphere
        sphere.center.set(points[o] as number, points[o + 1] as number, points[o + 2] as number).applyMatrix4(world)
        sphere.radius = lerp(BASE_RADIUS, TIP_RADIUS, index / HIT_DIVISIONS) * thin + HIT_PAD
      }
    }
    arms.commit()
  }

  function applyTipGlow(): void {
    const glow = cur.tipGlow
    tipGlow.visible = glow > 0.02
    if (!tipGlow.visible) return
    tipGlow.position.copy(tent(stabIndex).tip)
    tipGlow.scale.setScalar(0.6 + 0.5 * glow * (1 + 0.2 * Math.sin(clock * 30)))
    mats.tipGlow.emissiveIntensity = TIP_GLOW_GAIN * glow
  }

  /** 身体与两个核心的命中球：模型坐标 → body 姿态 → 世界坐标 */
  function refreshBodySpheres(): void {
    const world = root.matrixWorld
    const scale = (body.scale.x + body.scale.y + body.scale.z) / 3
    // 身体被压扁时球不会跟着变扁：把球心下移，让球顶跟着外观降下来，否则球会高出外观、把背部核心埋在里面
    const sink = Math.max(0, scale - body.scale.y)
    const front = hitSpheres[0] as BossHitSphere
    const rear = hitSpheres[1] as BossHitSphere
    const head = hitSpheres[2] as BossHitSphere
    const back = hitSpheres[3] as BossHitSphere
    toRoot(front.center.copy(BODY_FRONT_POS)).applyMatrix4(world)
    front.center.y -= BODY_FRONT_RADIUS * sink
    front.radius = BODY_FRONT_RADIUS * scale
    toRoot(rear.center.copy(BODY_BACK_POS)).applyMatrix4(world)
    rear.center.y -= BODY_BACK_RADIUS * sink
    rear.radius = BODY_BACK_RADIUS * scale
    toRoot(head.center.copy(HEAD_CORE_POS)).applyMatrix4(world)
    head.radius = HEAD_CORE_RADIUS * scale
    toRoot(back.center.copy(BACK_CORE_POS)).applyMatrix4(world)
    back.radius = BACK_CORE_RADIUS * scale
  }

  /* ── 对外接口 ── */

  function update(dt: number, anim: BossAnimInput): void {
    if (disposed) return
    const step = dt > 0 ? dt : 0
    const first = !primed
    primed = true
    // root 的位置朝向刚被 Boss 系统改过，先刷新世界矩阵
    root.updateWorldMatrix(true, false)

    const rageGoal = anim.enraged ? 1 : 0
    rage = first ? rageGoal : rageGoal + (rage - rageGoal) * Math.exp(-RAGE_RATE * step)
    const vigor = 1 + RAGE_VIGOR * rage
    clock += step
    swayClock += step * vigor
    pulseClock += step * (PULSE_SPEED + 3 * rage)

    if (anim.mode !== lastMode) {
      enterMode(anim)
      lastMode = anim.mode
    }
    resetGoals(vigor)
    applyMode(anim, vigor)

    // 当前姿态向目标阻尼靠拢；第一帧直接到位。狂暴后追得更快，动作更猛
    const bodyK = first ? 1 : 1 - Math.exp(-bodyRate * vigor * step)
    for (let i = 0; i < BODY_KEYS.length; i++) {
      const key = BODY_KEYS[i] as keyof BodyPose
      cur[key] += (goal[key] - cur[key]) * bodyK
    }
    for (let i = 0; i < TENTACLES; i++) {
      const t = tent(i)
      const k = first ? 1 : 1 - Math.exp(-t.rate * vigor * step)
      for (let j = 0; j < TENTACLE_KEYS.length; j++) {
        const key = TENTACLE_KEYS[j] as keyof TentaclePose
        t.cur[key] += (t.goal[key] - t.cur[key]) * k
      }
    }

    const fade = Math.exp(-FLASH_DECAY * step)
    flashBody *= fade
    flashTentacle *= fade
    flashHead *= fade
    flashBack *= fade

    applyBody()
    applyCores()
    applySkin()
    layoutTentacles()
    applyTipGlow()
    refreshBodySpheres()
  }

  function getHitSpheres(): readonly BossHitSphere[] {
    return hitSpheres
  }

  /** 访问器可能在本帧 update 之前被调用（root 刚被移动过），所以每次都重算矩阵 */
  function modelToWorld(modelPos: Vector3, out: Vector3): Vector3 {
    root.updateWorldMatrix(true, false)
    body.updateMatrix()
    return toRoot(out.copy(modelPos)).applyMatrix4(root.matrixWorld)
  }

  function headCoreWorld(out: Vector3): Vector3 {
    return modelToWorld(HEAD_CORE_POS, out)
  }

  function backCoreWorld(out: Vector3): Vector3 {
    return modelToWorld(BACK_CORE_POS, out)
  }

  function tentacleTipWorld(index: number, out: Vector3): Vector3 {
    const safe = clamp(Math.floor(index), 0, TENTACLES - 1)
    root.updateWorldMatrix(true, false)
    return out.copy(tent(safe).tip).applyMatrix4(root.matrixWorld)
  }

  function flash(zone: BossZone): void {
    if (zone === 'headCore') flashHead = 1
    else if (zone === 'backCore') flashBack = 1
    else if (zone === 'tentacle') flashTentacle = 1
    else flashBody = 1
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    root.removeFromParent()
    arms.dispose()
    mats.dispose()
    for (let i = 0; i < geometries.length; i++) (geometries[i] as BufferGeometry).dispose()
  }

  // 先按静止姿态摆一次，保证实例矩阵与命中球在第一次 update 之前就有效；随后恢复“未启动”状态
  update(0, { mode: 'idle', progress: 0, enraged: false, moveSpeed: 0 })
  primed = false
  lastMode = null

  return { root, getHitSpheres, headCoreWorld, backCoreWorld, tentacleTipWorld, update, flash, dispose }
}

/**
 * 人形骨架与程序化动画：四名角色与三种丧尸共用。
 *
 * 结构：root（外部控制）→ scaler（整体缩放）→ body（骨盆，整体姿态）→ spine（躯干）→ 颈 / 肩 / 肘；body → 髋 / 膝。
 * 头 = 球，躯干 = 长方体，四肢 = 圆柱；全部 geometry 是模块级共享的单位几何体，尺寸靠 Mesh.scale 给出，
 * 材质按实例创建（受击闪烁要逐个改 emissive）。
 *
 * 动画：每帧先算出“站立层”的全部关节角（待机呼吸 + 步态循环），再按阻尼权重叠加
 * 持枪 / 瞄准 / 换弹 / 交互 / 攻击各层，最后按倒地权重混入趴地 / 阵亡姿态。全程只读写预分配的数组。
 *
 * 关节角约定（肢体沿本地 -Y 下垂，模型正面朝 +Z，左侧为 +X）：
 * - rotation.x 为负 → 肢体向前摆；肘自然弯曲为负，膝自然弯曲为正。
 * - 肩的欧拉顺序是 XZY：Y 是绕上臂自身的扭转，Z 是外展（左臂为正、右臂为负时向外），X 是前后摆。
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import type { Object3D, Texture } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { HumanoidAnimInput, HumanoidRig, WeaponRig } from '../../core/types'
import { clamp, damp, lerp, smoothstep } from '../../utils/math'

/* ── 对外类型 ── */

/** 一种表面外观。同一个对象在一个 rig 内只生成一份材质 */
export interface HumanoidLook {
  color: number
  /** 共享纹理（来自 getTexture），不会被 rig 释放 */
  map?: Texture | null
  roughness?: number
  /** 自发光底色（丧尸眼睛等），默认无 */
  emissive?: number
}

/** 丧尸攻击动作：bite 抓咬 / lunge 前扑 / slam 双拳砸地 */
export type ZombieAttackStyle = 'bite' | 'lunge' | 'slam'

/** 丧尸专属参数：给出后双臂前伸、不能持枪，并启用 attack 动作 */
export interface HumanoidZombieOptions {
  attack: ZombieAttackStyle
  /** 双臂前伸程度 0..1 */
  reach: number
  /** 左 / 右臂相对前伸基准的偏移（弧度，负值抬得更高） */
  armOffsetL: number
  armOffsetR: number
  /** 双臂水平张开（弧度，正值向外） */
  armSpread: number
  /** 肘部弯曲（弧度，正值） */
  armBend: number
  /** 跛行 -1..1：正值左腿拖行，负值右腿拖行 */
  limp: number
}

export interface HumanoidOptions {
  /** 整体缩放（加在 root 下的内部 Group 上），默认 1 */
  scale?: number
  /** 未缩放的站立总高（脚底到头顶），默认 1.8；腿长由它反推 */
  height?: number
  headRadius?: number
  /** 颈部长度 */
  neck?: number
  torsoWidth?: number
  torsoHeight?: number
  torsoDepth?: number
  armRadius?: number
  /** 肩到手腕的长度 */
  armLength?: number
  legRadius?: number

  /** 皮肤（头、颈、手） */
  skin: HumanoidLook
  /** 上衣（躯干） */
  top: HumanoidLook
  /** 上臂，默认同 top */
  upperArm?: HumanoidLook
  /** 前臂，默认同上臂 */
  forearm?: HumanoidLook
  /** 大腿 */
  legs: HumanoidLook
  /** 小腿，默认同 legs */
  shin?: HumanoidLook
  /** 鞋，默认同小腿 */
  shoe?: HumanoidLook

  /** 静止姿态：躯干前倾 / 扭转 / 侧歪，头部侧歪 / 转头（弧度） */
  lean?: number
  twist?: number
  roll?: number
  headRoll?: number
  headTurn?: number

  /** 步频倍率，默认 1 */
  cadence?: number
  /** 步幅倍率，默认 1 */
  stride?: number
  /** 行走时身体左右摇晃幅度（弧度），默认 0.03 */
  sway?: number
  /** 动画初相位（弧度），让多个个体不同步 */
  phase?: number

  /** 是否可持枪（attachWeapon 生效），默认 false */
  armed?: boolean
  /** 阵亡时仰面倒下（默认趴倒） */
  deadOnBack?: boolean
  /** 阵亡姿态的左右镜像 */
  deadSide?: 1 | -1
  zombie?: HumanoidZombieOptions
}

/** 解析后的尺寸（未缩放，单位米），供外部摆放配件 */
export interface HumanoidDims {
  scale: number
  height: number
  headRadius: number
  neck: number
  torsoWidth: number
  torsoHeight: number
  torsoDepth: number
  armRadius: number
  upperArm: number
  forearm: number
  legRadius: number
  thigh: number
  shin: number
  /** 肩关节相对骨盆的横向 / 竖向位置 */
  shoulderX: number
  shoulderY: number
  /** 髋关节横向位置 */
  hipX: number
  /** 站立时骨盆（髋关节）离地高度 */
  hipY: number
}

/** 可挂配件的节点。各 Group 的原点与朝向见注释 */
export interface HumanoidParts {
  /** 骨盆：原点在髋部中心 */
  body: Group
  /** 躯干：原点在髋部中心，+Y 指向肩 */
  torso: Group
  /** 头：原点在头部球心 */
  head: Group
  /** 上臂：原点在肩关节，肢体沿 -Y */
  upperArmL: Group
  upperArmR: Group
  /** 前臂：原点在肘关节 */
  forearmL: Group
  forearmR: Group
  /** 大腿：原点在髋关节 */
  thighL: Group
  thighR: Group
  /** 小腿：原点在膝关节 */
  shinL: Group
  shinR: Group
}

/** 配件可用的共享几何体：box 单位立方体（居中）/ sphere 单位球 / limb 顶端在原点、沿 -Y 的单位锥台 */
export type HumanoidShape = 'box' | 'sphere' | 'limb'

/** createHumanoid 的返回值：在 HumanoidRig 之上暴露挂点，供 character.ts / zombie.ts 加配件 */
export interface HumanoidBuild extends HumanoidRig {
  readonly parts: HumanoidParts
  readonly dims: HumanoidDims
  /** 用共享几何体加一个配件。材质按实例创建并参与闪烁 / 释放；位置与缩放由调用方设置 */
  addMesh(parent: Object3D, shape: HumanoidShape, look: HumanoidLook): Mesh<BufferGeometry, MeshStandardMaterial>
}

/* ── 常量 ── */

const TAU = Math.PI * 2
const HALF_PI = Math.PI / 2

/** 姿态自由度索引 */
const BX = 0
const BY = 1
const BZ = 2
const BRX = 3
const BRY = 4
const BRZ = 5
const SPX = 6
const SPY = 7
const SPZ = 8
const HDX = 9
const HDY = 10
const HDZ = 11
const ALX = 12
const ALY = 13
const ALZ = 14
const EL = 15
const ARX = 16
const ARY = 17
const ARZ = 18
const ER = 19
const HLX = 20
const HLZ = 21
const KL = 22
const HRX = 23
const HRZ = 24
const KR = 25
/** 枪管相对骨盆坐标系的俯仰（正值朝下）与偏航（正值朝左） */
const GX = 26
const GY = 27
const DOF = 28

/** 脚掌厚度 */
const FOOT_HEIGHT = 0.07
/** 闪烁回落时间（秒）与亮度 */
const FLASH_TIME = 0.18
const FLASH_GAIN = 0.7
/** 持枪待命（枪斜举在胸前）时枪管的俯仰 / 偏航 */
const CARRY_PITCH = -0.6
const CARRY_YAW = 0.75

/** 手臂预设姿态：[肩 X, 肩 Y（扭转）, 肩 Z, 肘]。数值由双骨 IK 离线求得（默认体型） */
type ArmPose = readonly [number, number, number, number]
/** 待命：右手握把在右腹前，左手托护木，枪口朝左上 */
const CARRY_R: ArmPose = [-0.03, 0.82, -0.24, -1.44]
const CARRY_L: ArmPose = [-0.64, -0.84, -0.23, -0.93]
/** 瞄准：躯干左转 AIM_TWIST，右手握把在右胸前约 0.3m，左手在握把前方约 0.25m 的枪管下 */
const AIM_R: ArmPose = [-0.84, 0.84, 0.29, -1.4]
const AIM_L: ArmPose = [-1.33, -0.35, -0.21, -0.24]
const AIM_TWIST = -0.45

const REST_INPUT: HumanoidAnimInput = { speed: 0, pose: 'stand', action: 'none', actionProgress: 0 }

/* ── 共享几何体与临时对象 ── */

interface SharedGeometry {
  box: BoxGeometry
  sphere: SphereGeometry
  limb: CylinderGeometry
  foot: BoxGeometry
}

let shared: SharedGeometry | null = null

/** 所有 rig 共用的单位几何体，第一次用到时创建，之后不释放 */
function sharedGeometry(): SharedGeometry {
  if (shared === null) {
    const limb = new CylinderGeometry(1, 0.82, 1, 10, 1)
    limb.translate(0, -0.5, 0)
    const foot = new BoxGeometry(1, 1, 1)
    foot.translate(0, -0.5, 0.22)
    shared = { box: new BoxGeometry(1, 1, 1), sphere: new SphereGeometry(1, 14, 10), limb, foot }
  }
  return shared
}

/**
 * 脚掌相对小腿的角度。小腿接近竖直时把脚掌放平；小腿向后放倒（跪地、蹬地末段）时改为脚背朝下，避免脚尖插进地面。
 * @param shinTilt 小腿相对竖直方向的后仰角（髋角 + 膝角，弧度）
 */
function footAngle(shinTilt: number): number {
  if (shinTilt <= 1.1) return clamp(-shinTilt, -1.1, 0.9)
  return -1.1 + 2.4 * smoothstep((shinTilt - 1.1) / 0.4)
}

const tmpEuler = new Euler()
const tmpVec = new Vector3()
const tmpQuat = new Quaternion()
const tmpQuat2 = new Quaternion()
/** 倒地姿态的临时数组（update 同步执行，可在 rig 之间共用） */
const lieTarget = new Float32Array(DOF)

/* ── 工厂 ── */

/**
 * 创建一个人形 rig。
 * @param options 尺寸、外观、静止姿态与步态参数；getTexture 得到的纹理通过 look.map 传入
 * @returns 实现 HumanoidRig 的对象，并额外暴露 parts / dims / addMesh 供调用方加配件
 */
export function createHumanoid(options: HumanoidOptions): HumanoidBuild {
  const geo = sharedGeometry()

  /* 尺寸 */
  const scale = options.scale ?? 1
  const wantHeight = options.height ?? 1.8
  const headR = options.headRadius ?? 0.17
  const neck = options.neck ?? 0.05
  const torsoW = options.torsoWidth ?? 0.44
  const torsoH = options.torsoHeight ?? 0.56
  const torsoD = options.torsoDepth ?? 0.24
  const armR = options.armRadius ?? 0.06
  const armLen = options.armLength ?? 0.55
  const legR = options.legRadius ?? 0.085
  const upperLen = armLen * 0.527
  const foreLen = armLen - upperLen

  /* 静止姿态与步态 */
  const lean = options.lean ?? 0
  const twist = options.twist ?? 0
  const roll = options.roll ?? 0
  const headRoll = options.headRoll ?? 0
  const headTurn = options.headTurn ?? 0
  const restHeadX = -lean * 0.7
  const cadence = options.cadence ?? 1
  const stride = options.stride ?? 1
  const sway = options.sway ?? 0.03
  const phase0 = options.phase ?? 0
  const armed = options.armed === true && options.zombie === undefined
  const deadOnBack = options.deadOnBack === true
  const deadSide = options.deadSide ?? 1
  const zombie = options.zombie
  const limp = zombie ? clamp(zombie.limp, -1, 1) : 0
  const limpL = 1 - Math.max(0, limp) * 0.55
  const limpR = 1 - Math.max(0, -limp) * 0.55

  // 静止姿态下头心相对髋部的位置：用来反推腿长，让头顶恰好落在 height 上，并把头拉回脚底正上方附近
  tmpEuler.set(restHeadX, headTurn, headRoll)
  tmpVec.set(0, neck + headR, 0).applyEuler(tmpEuler)
  tmpVec.y += torsoH
  tmpEuler.set(lean, twist, roll)
  tmpVec.applyEuler(tmpEuler)
  const legLen = Math.max(0.3, wantHeight - headR - tmpVec.y)
  const height = legLen + tmpVec.y + headR
  const baseX = -tmpVec.x
  const baseZ = -tmpVec.z
  /** 跑动前倾时骨盆后移的力臂，让头大致留在脚底正上方（命中判定的头部球不随前倾跑偏） */
  const headLever = (torsoH + neck + headR) * 0.8
  const thighLen = legLen * 0.505
  const shinLen = legLen - thighLen
  const shoulderX = torsoW / 2 + armR * 0.85
  const shoulderY = torsoH - armR
  const hipX = Math.max(legR * 1.05, torsoW / 2 - legR * 0.95)
  /** 趴地时骨盆离地高度；阵亡姿态身体略向一侧翻，再抬高一点避免躯干边角陷地 */
  const lieY = torsoD / 2 + 0.015
  const deadY = lieY + torsoW * 0.05
  /** 脚掌：脚尖在踝前、脚跟在踝后的长度（与共享脚掌几何体的偏移一致） */
  const footLen = legR * 3
  const toeLen = footLen * 0.72
  const heelLen = footLen * 0.28

  const dims: HumanoidDims = {
    scale,
    height,
    headRadius: headR,
    neck,
    torsoWidth: torsoW,
    torsoHeight: torsoH,
    torsoDepth: torsoD,
    armRadius: armR,
    upperArm: upperLen,
    forearm: foreLen,
    legRadius: legR,
    thigh: thighLen,
    shin: shinLen,
    shoulderX,
    shoulderY,
    hipX,
    hipY: legLen,
  }

  /* 材质：每个 rig 自己的一份 */
  const mats: MeshStandardMaterial[] = []
  /** 各材质的自发光底色（r, g, b 连续存放） */
  const baseEmissive: number[] = []
  const lookMats = new Map<HumanoidLook, MeshStandardMaterial>()

  const materialOf = (look: HumanoidLook): MeshStandardMaterial => {
    let mat = lookMats.get(look)
    if (mat === undefined) {
      mat = new MeshStandardMaterial({
        color: look.color,
        map: look.map ?? null,
        roughness: look.roughness ?? 0.85,
        metalness: 0,
      })
      if (look.emissive !== undefined) mat.emissive.setHex(look.emissive)
      lookMats.set(look, mat)
      mats.push(mat)
      baseEmissive.push(mat.emissive.r, mat.emissive.g, mat.emissive.b)
    }
    return mat
  }

  const addMesh = (
    parent: Object3D,
    shape: HumanoidShape,
    look: HumanoidLook,
  ): Mesh<BufferGeometry, MeshStandardMaterial> => {
    const mesh = new Mesh<BufferGeometry, MeshStandardMaterial>(geo[shape], materialOf(look))
    parent.add(mesh)
    return mesh
  }

  /* 节点 */
  const root = new Group()
  const scaler = new Group()
  scaler.scale.setScalar(scale)
  root.add(scaler)
  const body = new Group()
  scaler.add(body)
  const spine = new Group()
  body.add(spine)
  const neckPivot = new Group()
  neckPivot.position.set(0, torsoH, 0)
  spine.add(neckPivot)
  const head = new Group()
  head.position.set(0, neck + headR, 0)
  neckPivot.add(head)

  const skin = options.skin
  const upperArmLook = options.upperArm ?? options.top
  const forearmLook = options.forearm ?? upperArmLook
  const shinLook = options.shin ?? options.legs
  const shoeLook = options.shoe ?? shinLook

  // 躯干略向下多出一截，盖住大腿根
  const torsoMesh = addMesh(spine, 'box', options.top)
  torsoMesh.scale.set(torsoW, torsoH + 0.04, torsoD)
  torsoMesh.position.set(0, torsoH / 2 - 0.02, 0)

  const neckMesh = addMesh(neckPivot, 'limb', skin)
  neckMesh.scale.set(headR * 0.42, neck + 0.06, headR * 0.42)
  neckMesh.position.set(0, neck + 0.03, 0)

  const headMesh = addMesh(head, 'sphere', skin)
  headMesh.scale.setScalar(headR)

  /** 手心相对肘关节的位置（沿前臂） */
  const handY = -foreLen - armR * 0.35

  const buildArm = (side: 1 | -1): { shoulder: Group; elbow: Group } => {
    const shoulder = new Group()
    shoulder.position.set(side * shoulderX, shoulderY, 0)
    shoulder.rotation.order = 'XZY'
    spine.add(shoulder)
    const upper = addMesh(shoulder, 'limb', upperArmLook)
    upper.scale.set(armR, upperLen, armR)
    const elbow = new Group()
    elbow.position.set(0, -upperLen, 0)
    shoulder.add(elbow)
    const fore = addMesh(elbow, 'limb', forearmLook)
    fore.scale.set(armR * 0.86, foreLen, armR * 0.86)
    const hand = addMesh(elbow, 'sphere', skin)
    hand.scale.set(armR * 0.9, armR * 1.05, armR * 0.9)
    hand.position.set(0, handY, 0)
    return { shoulder, elbow }
  }

  const buildLeg = (side: 1 | -1): { hip: Group; knee: Group; foot: Mesh } => {
    const hip = new Group()
    hip.position.set(side * hipX, 0, 0)
    body.add(hip)
    const thigh = addMesh(hip, 'limb', options.legs)
    thigh.scale.set(legR, thighLen, legR)
    const knee = new Group()
    knee.position.set(0, -thighLen, 0)
    hip.add(knee)
    const shin = addMesh(knee, 'limb', shinLook)
    shin.scale.set(legR * 0.84, shinLen - FOOT_HEIGHT * 0.5, legR * 0.84)
    // 脚：原点在脚踝，向前伸出
    const foot = new Mesh<BufferGeometry, MeshStandardMaterial>(geo.foot, materialOf(shoeLook))
    foot.scale.set(legR * 1.5, FOOT_HEIGHT, footLen)
    foot.position.set(0, -(shinLen - FOOT_HEIGHT), 0)
    knee.add(foot)
    return { hip, knee, foot }
  }

  const armL = buildArm(1)
  const armR2 = buildArm(-1)
  const legL = buildLeg(1)
  const legR2 = buildLeg(-1)
  const shoulderL = armL.shoulder
  const elbowL = armL.elbow
  const shoulderR = armR2.shoulder
  const elbowR = armR2.elbow
  const hipL = legL.hip
  const kneeL = legL.knee
  const footL = legL.foot
  const hipR = legR2.hip
  const kneeR = legR2.knee
  const footR = legR2.foot

  /** 右手锚点：武器的握把原点挂在这里，朝向每帧由 syncAnchor 给出 */
  const anchor = new Group()
  anchor.position.set(0, handY, 0)
  elbowR.add(anchor)

  const parts: HumanoidParts = {
    body,
    torso: spine,
    head,
    upperArmL: shoulderL,
    upperArmR: shoulderR,
    forearmL: elbowL,
    forearmR: elbowR,
    thighL: hipL,
    thighR: hipR,
    shinL: kneeL,
    shinR: kneeR,
  }

  /* 动画状态 */
  const P = new Float32Array(DOF)
  let phase = phase0
  let idleT = phase0 * 3
  let speedS = 0
  /** 倒地权重（阻尼值）与其缓动后的混合系数 */
  let wLie = 0
  let lieK = 0
  let wDead = 0
  let wCarry = 0
  let wAim = 0
  let wReload = 0
  let wInteract = 0
  let wAttack = 0
  let aimPitchS = 0
  let kick = 0
  let attackP = 0
  let reloadP = 0
  let flash = 0
  let flashDirty = false
  let weapon: WeaponRig | null = null

  /** 把自由度 i 按权重 w 拉向 target */
  const mix = (i: number, target: number, w: number): void => {
    P[i] += (target - P[i]) * w
  }

  /** 站立层：待机呼吸 + 行走 / 奔跑循环。速度越大步频、步幅、前倾与屈肘越大 */
  const poseStand = (): void => {
    const sp = speedS
    const move = smoothstep(sp / 0.5)
    const run = smoothstep((sp - 4.2) / 2.6)
    const amp = clamp(0.18 + 0.11 * sp, 0, 0.85) * stride * move
    const s = Math.sin(phase)
    const c = Math.cos(phase)
    const breath = Math.sin(idleT * 1.7)
    // 摆动相（腿向前迈）时屈膝
    const swingL = 0.5 + 0.5 * c
    const swingR = 1 - swingL
    const kneeAmp = (0.8 + 0.9 * run) * clamp(amp / 0.4, 0, 1)
    const fwd = move * (0.04 + 0.2 * run)
    const twistDyn = amp * 0.28 * s
    const lift = run * move * 0.22

    P[BX] = 0
    P[BY] = run * move * 0.03 * (0.5 - 0.5 * Math.cos(phase * 2))
    P[BZ] = -fwd * headLever
    P[BRX] = 0
    P[BRY] = 0
    P[BRZ] = sway * s * move
    P[SPX] = lean + fwd + breath * 0.012
    P[SPY] = twist + twistDyn
    P[SPZ] = roll - P[BRZ] * 0.5
    P[HDX] = restHeadX - fwd * 0.6
    P[HDY] = headTurn - twistDyn * 0.6
    P[HDZ] = headRoll

    P[HLX] = -amp * s * limpL - lift
    P[HRX] = amp * s * limpR - lift
    P[HLZ] = 0.02
    P[HRZ] = -0.02
    P[KL] = 0.05 + move * 0.08 + kneeAmp * swingL * swingL * limpL
    P[KR] = 0.05 + move * 0.08 + kneeAmp * swingR * swingR * limpR

    // 步幅大时，两腿张到最开的瞬间按脚贴地反推会让骨盆掉得过低：超出限度的部分当作腾空，补回高度
    const dropL = thighLen * Math.cos(P[HLX]) + shinLen * Math.cos(P[HLX] + P[KL])
    const dropR = thighLen * Math.cos(P[HRX]) + shinLen * Math.cos(P[HRX] + P[KR])
    P[BY] += Math.max(0, legLen - Math.max(dropL, dropR) - (0.03 + 0.1 * amp))

    if (zombie) {
      // 双臂前伸，随步伐小幅交替，并各自缓慢晃动
      const base = -(0.25 + 1.2 * zombie.reach)
      const wobL = Math.sin(idleT * 1.3 + phase0) * 0.07
      const wobR = Math.sin(idleT * 1.1 + phase0 * 1.7) * 0.07
      P[ALX] = base + zombie.armOffsetL + amp * 0.22 * s + wobL
      P[ARX] = base + zombie.armOffsetR - amp * 0.22 * s + wobR
      P[ALY] = 0
      P[ARY] = 0
      P[ALZ] = zombie.armSpread + wobR * 0.5
      P[ARZ] = -zombie.armSpread - wobL * 0.5
      P[EL] = -0.12 - zombie.armBend + wobR
      P[ER] = -0.12 - zombie.armBend + wobL
      P[HDX] += Math.sin(idleT * 0.9 + phase0) * 0.06
      P[HDZ] += Math.sin(idleT * 0.7 + phase0 * 2.3) * 0.05
    } else {
      // 手臂与同侧腿反向摆动，跑起来屈肘
      const armA = amp * (0.75 + 0.2 * run)
      const bend = 0.12 + move * (0.2 + 1.1 * run)
      P[ALX] = armA * s
      P[ARX] = -armA * s
      P[ALY] = 0
      P[ARY] = 0
      P[ALZ] = 0.07 + breath * 0.008
      P[ARZ] = -0.07 - breath * 0.008
      P[EL] = -bend - Math.max(0, -s) * armA * 0.5
      P[ER] = -bend - Math.max(0, s) * armA * 0.5
    }

    P[GX] = CARRY_PITCH
    P[GY] = CARRY_YAW
  }

  /** 把一条手臂（i 为肩 X 的索引）按权重 w 拉向预设姿态，dx / de 是肩俯仰与肘的附加量 */
  const mixArm = (i: number, pose: ArmPose, dx: number, de: number, w: number): void => {
    mix(i, pose[0] + dx, w)
    mix(i + 1, pose[1], w)
    mix(i + 2, pose[2], w)
    mix(i + 3, pose[3] + de, w)
  }

  /** 持枪层：待命（枪斜举胸前）、换弹（左手下放再回位）、举枪瞄准与后坐 */
  const poseWeapon = (): void => {
    const move = smoothstep(speedS / 0.5)

    if (wCarry > 0.001) {
      // 跑动时双臂带着枪一起小幅起伏，不再前后甩臂
      const bob = Math.sin(phase * 2) * move * 0.05
      mixArm(ARX, CARRY_R, bob, 0, wCarry)
      mixArm(ALX, CARRY_L, bob, 0, wCarry)
    }

    if (wReload > 0.001) {
      const w = wReload
      const p = reloadP
      // 0 → 0.3 下放，0.3 → 0.7 在腰间换弹匣，0.7 → 1 回到护木
      const down = smoothstep(p / 0.3) * (1 - smoothstep((p - 0.7) / 0.3))
      const jig = Math.sin(p * TAU * 4) * 0.05 * down
      mix(GX, -0.95, w)
      mix(GY, 0.45, w)
      mix(ER, CARRY_R[3] - 0.25, w)
      const wl = w * down
      mix(ALX, 0.1 + jig, wl)
      mix(ALY, 0, wl)
      mix(ALZ, 0.16, wl)
      mix(EL, -0.75 + jig, wl)
    }

    if (wAim > 0.001) {
      const w = wAim
      const pitch = aimPitchS
      const still = (1 - move) * w
      // 俯仰：躯干承担 1/4，双肩承担 3/4；枪管方向由 GX 精确给出
      P[SPX] += (-pitch * 0.25 - kick * 0.04) * w
      mix(SPY, AIM_TWIST, w)
      mix(HDY, -AIM_TWIST * 0.9, w)
      P[HDX] -= pitch * 0.5 * w
      mixArm(ARX, AIM_R, -pitch * 0.75 + kick * 0.05, -kick * 0.1, w)
      mixArm(ALX, AIM_L, -pitch * 0.75 + kick * 0.05, -kick * 0.08, w)
      mix(GX, -pitch - kick * 0.07, w)
      mix(GY, 0, w)
      P[BZ] -= kick * 0.015 * w
      // 原地瞄准时左脚在前、微屈膝站稳
      P[HLX] -= 0.14 * still
      P[HRX] += 0.12 * still
      P[KL] += 0.14 * still
      P[KR] += 0.06 * still
    }
  }

  /** 交互层（救援 / 读条）：单膝跪地、俯身、双手前伸并小幅按压 */
  const poseInteract = (): void => {
    if (wInteract < 0.001) return
    const w = smoothstep(wInteract)
    const pump = Math.sin(idleT * 6)
    // 左腿屈膝在前，右膝着地；骨盆高度由 ground() 自动落到右膝
    mix(HLX, -1.25, w)
    mix(KL, 2.05, w)
    mix(HRX, 0.1, w)
    mix(KR, 1.6, w)
    mix(BZ, 0.05, w)
    mix(BRZ, 0, w)
    mix(SPX, lean + 0.5 + pump * 0.03, w)
    mix(SPY, twist, w)
    mix(HDX, restHeadX + 0.25, w)
    mix(HDY, headTurn, w)
    mix(ALX, -1.05 + pump * 0.07, w)
    mix(ALY, 0, w)
    mix(ALZ, -0.18, w)
    mix(EL, -0.45 - pump * 0.1, w)
    mix(ARX, -1.05 + pump * 0.07, w)
    mix(ARY, 0, w)
    mix(ARZ, 0.18, w)
    mix(ER, -0.45 - pump * 0.1, w)
    // 手里的枪口朝下
    mix(GX, 0.9, w)
    mix(GY, 0.4, w)
  }

  /** 攻击层的两个权重：蓄力姿态与命中姿态（已乘 wAttack） */
  let atkWind = 0
  let atkHit = 0

  /** 自由度 i 在攻击中的蓄力值 wind 与命中值 hit */
  const atk = (i: number, wind: number, hit: number): void => {
    P[i] += (wind - P[i]) * atkWind + (hit - P[i]) * atkHit
  }

  /**
   * 攻击层（丧尸）：进度 0 → 0.36 抬臂蓄力，0.36 → 0.49 出手（0.5 结算伤害时刚好到位），0.62 → 1 收招。
   * bite 抓咬：双臂上扬后前扒合拢并探身；lunge 前扑：下蹲后跃起前扑；slam 砸地：双拳举过头顶后蹲身砸向地面。
   */
  const poseAttack = (): void => {
    if (zombie === undefined || wAttack < 0.001) return
    const p = attackP
    const strike = smoothstep((p - 0.36) / 0.13)
    atkWind = smoothstep(p / 0.34) * (1 - strike) * wAttack
    atkHit = strike * (1 - smoothstep((p - 0.62) / 0.38)) * wAttack

    if (zombie.attack === 'slam') {
      atk(SPX, lean - 0.3, lean + 1.08)
      atk(HDX, restHeadX - 0.15, restHeadX - 0.5)
      atk(ALX, -2.95, -1.33)
      atk(ARX, -2.95, -1.33)
      atk(ALZ, 0.18, -0.1)
      atk(ARZ, -0.18, 0.1)
      atk(EL, -0.55, -0.12)
      atk(ER, -0.55, -0.12)
      atk(HLX, -0.15, -0.85)
      atk(KL, 0.3, 1.35)
      atk(HRX, -0.15, -0.85)
      atk(KR, 0.3, 1.35)
      atk(BZ, -0.05, 0.1)
    } else if (zombie.attack === 'lunge') {
      atk(BZ, -0.12, 0.45)
      atk(BY, 0, 0.22)
      atk(BRX, 0, 0.25)
      atk(SPX, lean + 0.45, lean + 0.75)
      atk(HDX, restHeadX - 0.45, restHeadX - 0.7)
      atk(ALX, 0.5, -2.9)
      atk(ARX, 0.6, -2.8)
      atk(ALZ, 0.25, -0.2)
      atk(ARZ, -0.25, 0.2)
      atk(EL, -1.4, -0.35)
      atk(ER, -1.4, -0.35)
      atk(HLX, -0.75, 0.35)
      atk(KL, 1.5, 0.5)
      atk(HRX, -0.6, 0.6)
      atk(KR, 1.35, 0.7)
    } else {
      atk(SPX, lean - 0.25, lean + 0.5)
      atk(HDX, restHeadX - 0.3, restHeadX + 0.15)
      atk(ALX, -2.35, -1.95)
      atk(ARX, -2.5, -1.85)
      atk(ALZ, 0.4, -0.3)
      atk(ARZ, -0.4, 0.3)
      atk(EL, -1.3, -0.7)
      atk(ER, -1.3, -0.7)
      atk(HLX, 0.1, -0.5)
      atk(KL, 0.15, 0.55)
      atk(HRX, 0, 0.3)
      atk(KR, 0.1, 0.25)
      atk(BZ, -0.06, 0.16)
    }
  }

  /** 倒地姿态的自由度 i：downed（趴地 / 爬行）取 a，dead（瘫倒）取 b */
  const lie = (i: number, a: number, b: number): void => {
    lieTarget[i] = a + (b - a) * wDead
  }

  /**
   * 倒地层：骨盆降到地面并把身体放平（趴地为 +90°，仰面阵亡为 -90°）。
   * 身体放平后，肩 Z 轴在地面内扫动手臂，肩 Y 轴扭转 ±90° 让肘也在地面内弯曲。
   * downed 且 speed>0 时左右手交替前伸扒地、异侧腿蹬地。
   */
  const poseLying = (): void => {
    if (wLie < 0.001) {
      lieK = 0
      return
    }
    const k = smoothstep(wLie)
    lieK = k
    const crawl = smoothstep(speedS / 0.4) * (1 - wDead)
    const s = Math.sin(phase) * crawl
    const c = Math.cos(phase) * crawl
    const kickL = (0.5 - 0.5 * Math.sin(phase)) * crawl
    const kickR = (0.5 + 0.5 * Math.sin(phase)) * crawl
    const m = deadSide
    // 仰面时一条腿屈膝立起（由 deadSide 决定哪条）
    const kneeUpL = deadOnBack && m > 0
    const kneeUpR = deadOnBack && m < 0
    const flatHip = deadOnBack ? -0.03 : 0.03

    lie(BX, 0, 0)
    lie(BY, lieY, deadY)
    lie(BZ, -0.12, deadOnBack ? 0.12 : -0.12)
    lie(BRX, HALF_PI, deadOnBack ? -HALF_PI : HALF_PI)
    lie(BRY, 0.07 * s, 0.1 * m)
    lie(BRZ, 0.06 * c, 0.12 * m)
    lie(SPX, -0.07, 0)
    lie(SPY, 0, 0)
    lie(SPZ, 0.06 * s, -0.1 * m)
    // 抬头：球形的头比躯干厚，不抬会陷进地面
    lie(HDX, -0.45, deadOnBack ? 0.3 : -0.3)
    lie(HDY, 0.25 * s, 0.8 * m)
    lie(HDZ, 0, 0)

    lie(ALX, 0, 0)
    lie(ALY, HALF_PI, HALF_PI)
    lie(ALZ, 2 + 0.45 * s, m > 0 ? 1.3 : 0.45)
    lie(EL, -1.15 + 0.5 * s, m > 0 ? -0.6 : -0.2)
    lie(ARX, 0, 0)
    lie(ARY, -HALF_PI, -HALF_PI)
    lie(ARZ, -2 + 0.45 * s, m > 0 ? -0.45 : -1.3)
    lie(ER, -1.15 - 0.5 * s, m > 0 ? -0.2 : -0.6)

    lie(HLX, 0.04, kneeUpL ? -0.5 : flatHip)
    lie(HLZ, 0.14 + 0.12 * kickL, 0.22)
    lie(KL, 0.12 + 0.6 * kickL, kneeUpL ? 1 : 0.05)
    lie(HRX, 0.04, kneeUpR ? -0.5 : flatHip)
    lie(HRZ, -0.14 - 0.12 * kickR, -0.1)
    lie(KR, 0.12 + 0.6 * kickR, kneeUpR ? 1 : 0.05)

    // 枪平放在地上，枪口朝头的方向
    lie(GX, -HALF_PI + 0.06, -HALF_PI + 0.06)
    lie(GY, 0.25, 0.25)

    for (let i = 0; i < DOF; i++) P[i] += (lieTarget[i] - P[i]) * k

    // 过渡中段屈膝：倒下时先跪后趴（或坐倒），站起时先撑起再蹬直，避免腿穿进地面
    const bump = Math.sin(k * Math.PI)
    P[HLX] -= 0.95 * bump
    P[KL] += 1.75 * bump
    P[HRX] -= 0.8 * bump
    P[KR] += 1.6 * bump
  }

  /** 脚掌相对小腿的角度（每帧由 clearGround 算出，applyPose 写入） */
  let footRotL = 0
  let footRotR = 0

  /**
   * 一条腿的最低点（膝盖、脚尖、脚跟、脚底）相对骨盆的高度，只考虑前后方向的摆动与身体俯仰。
   * @returns 负值；骨盆高度取它的相反数时这条腿恰好触地
   */
  const legLow = (hipAngle: number, kneeAngle: number, footRot: number): number => {
    const thighTilt = P[BRX] + hipAngle
    const shinTilt = thighTilt + kneeAngle
    const footTilt = shinTilt + footRot
    const kneeY = -thighLen * Math.cos(thighTilt)
    const ankleY = kneeY - (shinLen - FOOT_HEIGHT) * Math.cos(shinTilt)
    const sinF = Math.sin(footTilt)
    const footY = ankleY - Math.max(sinF * toeLen, -sinF * heelLen) + Math.min(0, -FOOT_HEIGHT * Math.cos(footTilt))
    return Math.min(kneeY - legR * 0.85, footY)
  }

  /** 站立各层算完后：让支撑脚（或跪地的膝盖）恰好落在地面上，由腿部关节角反推骨盆高度 */
  const ground = (): void => {
    const lowL = legLow(P[HLX], P[KL], footAngle(P[HLX] + P[KL]))
    const lowR = legLow(P[HRX], P[KR], footAngle(P[HRX] + P[KR]))
    P[BY] += Math.max(-Math.min(lowL, lowR), legLen * 0.3)
  }

  /** 倒地混合后：确定脚掌角度，并在过渡途中把骨盆抬到腿不穿地的高度（只抬不降） */
  const clearGround = (): void => {
    // 站立时脚掌尽量放平；趴地时脚背贴地，仰面时脚尖朝上
    const lieFoot = 1.3 - (deadOnBack ? 1.05 * wDead : 0)
    const levelL = footAngle(P[HLX] + P[KL])
    const levelR = footAngle(P[HRX] + P[KR])
    footRotL = levelL + (lieFoot - levelL) * lieK
    footRotR = levelR + (lieFoot - levelR) * lieK
    if (lieK < 0.001) return
    const low = Math.min(legLow(P[HLX], P[KL], footRotL), legLow(P[HRX], P[KR], footRotR))
    if (P[BY] + low < 0) P[BY] = -low
  }

  /** 武器朝向：抵消躯干与右臂的旋转，让枪管保持在骨盆坐标系里的目标方向 */
  const syncAnchor = (): void => {
    if (weapon === null) return
    tmpQuat.copy(spine.quaternion).multiply(shoulderR.quaternion).multiply(elbowR.quaternion).invert()
    tmpEuler.set(P[GX], P[GY], 0)
    anchor.quaternion.copy(tmpQuat).multiply(tmpQuat2.setFromEuler(tmpEuler))
  }

  /** 把姿态数组写到各个枢轴上 */
  const applyPose = (): void => {
    const upright = 1 - lieK
    body.position.set(baseX * upright + P[BX], P[BY], baseZ * upright + P[BZ])
    body.rotation.set(P[BRX], P[BRY], P[BRZ])
    spine.rotation.set(P[SPX], P[SPY], P[SPZ])
    neckPivot.rotation.set(P[HDX], P[HDY], P[HDZ])
    shoulderL.rotation.set(P[ALX], P[ALY], P[ALZ])
    shoulderR.rotation.set(P[ARX], P[ARY], P[ARZ])
    elbowL.rotation.x = P[EL]
    elbowR.rotation.x = P[ER]
    hipL.rotation.set(P[HLX], 0, P[HLZ])
    hipR.rotation.set(P[HRX], 0, P[HRZ])
    kneeL.rotation.x = P[KL]
    kneeR.rotation.x = P[KR]
    footL.rotation.x = footRotL
    footR.rotation.x = footRotR
    syncAnchor()
  }

  /** 闪烁回落：emissive = 底色 + 白光 */
  const updateFlash = (dt: number): void => {
    if (flash <= 0 && !flashDirty) return
    flash = Math.max(0, flash - dt / FLASH_TIME)
    const k = flash * FLASH_GAIN
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i]
      if (mat === undefined) continue
      const j = i * 3
      mat.emissive.setRGB((baseEmissive[j] ?? 0) + k, (baseEmissive[j + 1] ?? 0) + k, (baseEmissive[j + 2] ?? 0) + k)
    }
    flashDirty = flash > 0
  }

  const update = (dt: number, anim: HumanoidAnimInput): void => {
    const stand = anim.pose === 'stand'
    const action = anim.action

    speedS = damp(speedS, anim.speed, 12, dt)
    idleT += dt
    // 所有待机频率都是 0.1 的整数倍，按 20π 回绕不会跳变
    if (idleT > TAU * 10) idleT -= TAU * 10
    phase += dt * TAU * (1.1 + 0.16 * speedS) * cadence
    if (phase > TAU) phase -= TAU

    // 站着直接阵亡（丧尸）时立刻选定阵亡姿态；已经躺下时在趴地与瘫倒之间平滑过渡；站起过程保持原样
    if (anim.pose === 'dead') wDead = wLie < 0.05 ? 1 : damp(wDead, 1, 5, dt)
    else if (anim.pose === 'downed') wDead = wLie < 0.05 ? 0 : damp(wDead, 0, 5, dt)
    wLie = damp(wLie, stand ? 0 : 1, stand ? 4.5 : 7, dt)
    wCarry = damp(wCarry, weapon !== null ? 1 : 0, 10, dt)
    wAim = damp(wAim, stand && anim.aiming === true && action !== 'interact' ? 1 : 0, 14, dt)
    aimPitchS = damp(aimPitchS, clamp(anim.aimPitch ?? 0, -1.2, 1.2), 20, dt)
    wReload = damp(wReload, stand && action === 'reload' ? 1 : 0, 10, dt)
    wInteract = damp(wInteract, stand && action === 'interact' ? 1 : 0, 8, dt)
    wAttack = damp(wAttack, stand && action === 'attack' ? 1 : 0, 16, dt)
    if (action === 'attack') attackP = clamp(anim.actionProgress, 0, 1)
    if (action === 'reload') reloadP = clamp(anim.actionProgress, 0, 1)
    const kickTarget = action === 'shoot' ? (1 - clamp(anim.actionProgress, 0, 1)) ** 2 : 0
    kick = damp(kick, kickTarget, 45, dt)

    poseStand()
    poseWeapon()
    poseInteract()
    poseAttack()
    ground()
    poseLying()
    clearGround()
    applyPose()
    updateFlash(dt)
  }

  const attachWeapon = (next: WeaponRig | null): void => {
    if (!armed || next === weapon) return
    if (weapon !== null && weapon.root.parent === anchor) anchor.remove(weapon.root)
    weapon = next
    if (next !== null) {
      next.root.position.set(0, 0, 0)
      next.root.rotation.set(0, 0, 0)
      anchor.add(next.root)
      syncAnchor()
    }
  }

  const reset = (): void => {
    phase = phase0
    idleT = phase0 * 3
    speedS = 0
    wLie = 0
    lieK = 0
    wDead = 0
    wCarry = weapon !== null ? 1 : 0
    wAim = 0
    wReload = 0
    wInteract = 0
    wAttack = 0
    aimPitchS = 0
    kick = 0
    attackP = 0
    reloadP = 0
    flash = 0
    flashDirty = true
    update(0, REST_INPUT)
  }

  const dispose = (): void => {
    if (weapon !== null && weapon.root.parent === anchor) anchor.remove(weapon.root)
    weapon = null
    root.removeFromParent()
    for (const mat of mats) mat.dispose()
    mats.length = 0
    baseEmissive.length = 0
    lookMats.clear()
  }

  reset()

  return {
    root,
    height: height * scale,
    headHeight: (height - headR) * scale,
    headRadius: headR * scale,
    get muzzle(): Object3D | null {
      return weapon !== null ? weapon.muzzle : null
    },
    attachWeapon,
    update,
    flash: (): void => {
      flash = 1
      flashDirty = true
    },
    reset,
    dispose,
    parts,
    dims,
    addMesh,
  }
}

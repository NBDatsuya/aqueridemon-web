/**
 * 第一人称视图模型：持枪模型挂在相机右下方，负责摇摆、冲刺放低、换弹倾斜下沉、切枪升降与后坐。
 * 只做表现，不含玩法逻辑，由 systems/player.ts 每帧驱动。
 *
 * 为了不穿进场景，整体缩小后贴近相机：root 的缩放为 VIEW_MODEL_SCALE，
 * 其内部的位置偏移全部按“原尺寸”的米来写，投影到屏幕上的大小与原尺寸持枪一致。
 *
 * 双臂（主控的袖子、袖口条纹与握拳的手）与枪挂在同一个枢轴下，跟着摇摆、冲刺、换弹、切枪与后坐一起动。
 * 姿态与队友第三人称持枪一致：右拳握住握把，左拳从下方托住护木；肩膀放在画面外，肘部由双骨 IK 求出。
 * 不同武器的护木位置不同，换上新枪时重新求解一次手臂。
 */

import { Group, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import { CHARACTERS, PLAYER, PLAYER_ID } from '../core/config'
import type { ActorModels, WeaponId, WeaponRig, WeaponState } from '../core/types'
import { FIST_AXIS, humanoidGeometry } from '../generators/geometry/humanoid-shapes'
import { getTexture } from '../generators/textures'
import { clamp, damp, smoothstep } from '../utils/math'

/** 视图模型整体缩放（枪口火光等世界空间特效按同一比例缩小） */
export const VIEW_MODEL_SCALE = 0.3

/** 握把相对相机的位置（原尺寸，相机空间：+X 右，+Y 上，-Z 前） */
const HOLD = { x: 0.2, y: -0.2, z: -0.46 } as const

/** 表现参数（原尺寸的米 / 弧度 / 1 每秒） */
const VIEW = {
  /** 转动视角时枪身滞后：每 像素/秒 的偏移量与上限 */
  swayPerSpeed: 0.000018,
  swayMax: 0.035,
  swayRate: 9,
  /** 滞后偏移带来的枪身偏转（弧度 / 米） */
  swayTilt: 1.2,
  bobX: 0.012,
  bobY: 0.01,
  breathe: 0.004,
  breatheFreq: 1.6,
  sprintDrop: 0.07,
  sprintPitch: 0.28,
  sprintYaw: 0.5,
  sprintRate: 9,
  reloadDrop: 0.16,
  reloadPitch: 0.6,
  reloadRoll: 0.5,
  /** 换弹进度两端用于下沉 / 回正的比例 */
  reloadEdge: 0.15,
  reloadRate: 16,
  switchDrop: 0.42,
  switchPitch: 0.9,
  switchRate: 28,
  kickPerShot: 0.7,
  kickMax: 1.6,
  kickBack: 0.045,
  kickPitch: 0.05,
  kickRecover: 16,
} as const

/*
 * 手臂的坐标都在枢轴空间（原尺寸的米）：原点是握把顶端，+X 右、+Y 上、-Z 朝前（枪口方向）。
 * 武器本地坐标（枪管朝 +Z、左侧为 +X）绕 Y 转半圈后得到枢轴坐标：(x, y, z) → (-x, y, -z)。
 */

/** 第一人称手臂的尺寸与肩膀 / 肘部朝向 */
const ARM = {
  /** 手的缩放（握拳几何体的单位，取 主控的前臂半径） */
  hand: 0.057,
  upper: 0.3,
  fore: 0.3,
  upperRadius: 0.058,
  foreRadius: 0.05,
  /** 袖口条纹宽度 */
  cuff: 0.034,
  /** 肩膀位置：都在画面外（右肩接近相机平面，左肩在左下方） */
  shoulderR: new Vector3(0, -0.1, 0.44),
  shoulderL: new Vector3(-0.38, -0.2, 0.1),
  /** 肘部弯向：右肘向外侧张开，左肘向左下方 */
  poleR: new Vector3(1, -0.3, 0),
  poleL: new Vector3(-0.6, -0.8, 0),
  /** 手腕弯曲：手的朝向在“拳心轴线垂直于前臂”和“顺着前臂”之间插值的比例 */
  wristR: 0.25,
  wristL: 0.5,
} as const

/**
 * 右拳握住的位置（武器本地坐标）：握把中段，原点下方 5cm。四个型号的握把都从原点向后下方倾斜约 18°，
 * GRIP_AXIS 沿握把指向上端（虎口、拇指一侧）
 */
const GRIP_POINT = new Vector3(0, -0.05, -0.018)
const GRIP_AXIS = new Vector3(0, 0.11, 0.036).normalize()
/** 护木（左拳托住处）的方向，枢轴空间：沿枪管朝前，拇指指向枪口 */
const SUPPORT_AXIS = new Vector3(0, 0, -1)
/** 左拳托住的位置：护木底面中线上的一点（武器本地坐标 z / 底面高度 y），取自各型号的蓝图 */
const SUPPORT: Record<WeaponId, { z: number; y: number }> = {
  ak47: { z: 0.25, y: 0.029 },
  mp5: { z: 0.25, y: 0.027 },
  mg3: { z: 0.31, y: 0.04 },
  qbz95: { z: 0.19, y: 0.024 },
  barrett: { z: 0.34, y: 0.05 },
}
/** 拳心轴线高出护木底面的距离（让手掌贴在护木下方） */
const SUPPORT_LIFT = 0.016

const DOWN = new Vector3(0, -1, 0)
const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpX = new Vector3()
const tmpY = new Vector3()
const tmpZ = new Vector3()
const tmpBasis = new Matrix4()

/** 一条手臂的网格 */
interface ArmMeshes {
  upper: Mesh
  elbow: Mesh
  fore: Mesh
  cuff: Mesh
  hand: Mesh
}

/** 把沿 -Y、顶端在原点的单位肢体摆到 from → to，半径 radius */
function placeLimb(mesh: Mesh, from: Vector3, to: Vector3, radius: number): void {
  tmpA.subVectors(to, from)
  const len = Math.max(1e-4, tmpA.length())
  tmpA.multiplyScalar(1 / len)
  mesh.position.copy(from)
  mesh.quaternion.setFromUnitVectors(DOWN, tmpA)
  mesh.scale.set(radius, len, radius)
}

/**
 * 双骨 IK：肩 → 肘 → 腕，肘部弯向 pole 一侧。够不着时沿肩腕连线拉直。
 * @param out 写入肘部位置
 */
function solveElbow(shoulder: Vector3, wrist: Vector3, pole: Vector3, out: Vector3): void {
  tmpA.subVectors(wrist, shoulder)
  const d = Math.max(1e-4, tmpA.length())
  tmpA.multiplyScalar(1 / d)
  const a = ARM.upper
  const b = ARM.fore
  const dd = clamp(d, Math.abs(a - b) + 1e-3, (a + b) * 0.999)
  const x = (a * a - b * b + dd * dd) / (2 * dd)
  const h = Math.sqrt(Math.max(0, a * a - x * x))
  tmpB.copy(pole).addScaledVector(tmpA, -pole.dot(tmpA)).normalize()
  out.copy(shoulder).addScaledVector(tmpA, x * (d / dd)).addScaledVector(tmpB, h)
}

/**
 * 摆放握拳的手：拳心轴线穿过 axisPoint、沿 axisDir（拇指一侧），手指方向由前臂方向给出。
 * @param forearm 从手腕指向肘部的单位向量
 * @param wristBend 0 时拳心轴线严格沿 axisDir，1 时手完全顺着前臂（轴线偏斜）
 * @param side 1 为左手，-1 为右手（几何体已镜像，轴线 x 取反）
 * @param wrist 写入手腕位置
 */
function placeFist(
  mesh: Mesh,
  axisPoint: Vector3,
  axisDir: Vector3,
  forearm: Vector3,
  wristBend: number,
  side: 1 | -1,
  wrist: Vector3,
): void {
  // 手的 +Y 指向手腕：先取前臂方向去掉沿轴线的分量，再按 wristBend 拉回前臂方向
  tmpY.copy(forearm).addScaledVector(axisDir, -forearm.dot(axisDir))
  if (tmpY.lengthSq() < 1e-6) tmpY.set(0, -1, 0)
  tmpY.normalize().lerp(forearm, wristBend).normalize()
  tmpZ.copy(axisDir).addScaledVector(tmpY, -axisDir.dot(tmpY)).normalize()
  tmpX.crossVectors(tmpY, tmpZ)
  tmpBasis.makeBasis(tmpX, tmpY, tmpZ)
  mesh.quaternion.setFromRotationMatrix(tmpBasis)
  mesh.scale.setScalar(ARM.hand)
  // 手腕 = 轴线点 − 旋转后的轴线偏移
  tmpA.set(side * FIST_AXIS.x * ARM.hand, FIST_AXIS.y * ARM.hand, 0).applyQuaternion(mesh.quaternion)
  wrist.copy(axisPoint).sub(tmpA)
  mesh.position.copy(wrist)
}

/** 每帧传给视图模型的状态（调用方复用同一个对象） */
export interface ViewModelInput {
  /** 是否显示（倒地 / 阵亡 / 登机 / 空手时为 false） */
  visible: boolean
  /** 应显示的武器槽位 */
  slot: number
  /** 本帧鼠标位移（像素） */
  lookX: number
  lookY: number
  /** 步伐相位（弧度，每走一步前进 PI） */
  bobPhase: number
  /** 步伐起伏强度 0..1.4 */
  bob: number
  sprinting: boolean
  /** 换弹进度 0..1；未在换弹为 -1 */
  reload: number
  /** 切枪进度 0..1（0.5 时降到最低并换成新枪）；未在切枪为 -1 */
  switchProgress: number
}

export interface ViewModel {
  /** 挂到相机下的根节点 */
  readonly root: Group
  /**
   * 比较各槽位的武器 id，重建有变化的模型。
   * @returns 发生变化的槽位位掩码（第 i 位对应槽位 i），没有变化为 0
   */
  sync(weapons: readonly WeaponState[]): number
  /** 开火后坐，strength 为武器后坐力系数 */
  kick(strength: number): void
  /** 取指定槽位武器的枪口世界坐标；该槽位没有模型或当前未显示时返回 false */
  muzzleWorld(slot: number, out: Vector3): boolean
  update(dt: number, input: ViewModelInput): void
  dispose(): void
}

/**
 * 创建第一人称视图模型。调用方负责把 root 挂到相机下，并在销毁时移除。
 * @param models 模型工厂（ctx.models）
 */
export function createViewModel(models: ActorModels): ViewModel {
  const root = new Group()
  root.name = 'player-viewmodel'
  root.scale.setScalar(VIEW_MODEL_SCALE)
  root.visible = false

  // 握把所在的枢轴：全部动画都加在它上面
  const pivot = new Group()
  pivot.position.set(HOLD.x, HOLD.y, HOLD.z)
  root.add(pivot)

  /* 双臂：配色取自主控（袖子 = 上衣，袖口条纹 = 点缀色），挂在枢轴下跟枪一起动 */
  const samuel = CHARACTERS[PLAYER_ID]
  const sleeveMat = new MeshStandardMaterial({ color: samuel.bodyColor, map: getTexture('cloth'), roughness: 0.9 })
  const cuffMat = new MeshStandardMaterial({ color: samuel.accentColor, roughness: 0.8 })
  const skinMat = new MeshStandardMaterial({ color: samuel.headColor, roughness: 0.62 })
  const armMats = [sleeveMat, cuffMat, skinMat]
  const arms = new Group()
  arms.name = 'viewmodel-arms'
  pivot.add(arms)

  const armMesh = (geometry: BufferGeometry, mat: MeshStandardMaterial): Mesh => {
    const mesh = new Mesh(geometry, mat)
    mesh.castShadow = false
    mesh.receiveShadow = false
    arms.add(mesh)
    return mesh
  }
  const buildArm = (hand: 'fistL' | 'fistR'): ArmMeshes => ({
    upper: armMesh(humanoidGeometry('limb'), sleeveMat),
    elbow: armMesh(humanoidGeometry('sphere'), sleeveMat),
    fore: armMesh(humanoidGeometry('limb'), sleeveMat),
    cuff: armMesh(humanoidGeometry('band'), cuffMat),
    hand: armMesh(humanoidGeometry(hand), skinMat),
  })
  const armL = buildArm('fistL')
  const armR = buildArm('fistR')
  let posedFor: WeaponId | null = null

  const wrist = new Vector3()
  const elbow = new Vector3()
  const forearm = new Vector3()
  const axisPoint = new Vector3()
  const gripDir = new Vector3()

  /** 求解一条手臂并摆好网格：先用肩膀方向猜前臂方向，迭代两次让手、腕、肘互相吻合 */
  const solveArm = (
    arm: ArmMeshes,
    shoulder: Vector3,
    pole: Vector3,
    axisDir: Vector3,
    wristBend: number,
    side: 1 | -1,
  ): void => {
    forearm.subVectors(shoulder, axisPoint).normalize()
    placeFist(arm.hand, axisPoint, axisDir, forearm, wristBend, side, wrist)
    for (let i = 0; i < 2; i++) {
      solveElbow(shoulder, wrist, pole, elbow)
      forearm.subVectors(elbow, wrist).normalize()
      placeFist(arm.hand, axisPoint, axisDir, forearm, wristBend, side, wrist)
    }
    solveElbow(shoulder, wrist, pole, elbow)
    forearm.subVectors(elbow, wrist).normalize()

    placeLimb(arm.upper, shoulder, elbow, ARM.upperRadius)
    arm.elbow.position.copy(elbow)
    arm.elbow.scale.setScalar(ARM.upperRadius * 0.92)
    // 袖子止于手腕稍后，袖口条纹包住袖子末端
    tmpB.copy(wrist).addScaledVector(forearm, 0.012)
    placeLimb(arm.fore, elbow, tmpB, ARM.foreRadius)
    tmpB.copy(wrist).addScaledVector(forearm, 0.012 + ARM.cuff)
    tmpX.copy(wrist).addScaledVector(forearm, 0.006)
    placeLimb(arm.cuff, tmpB, tmpX, ARM.foreRadius * 0.86)
  }

  /** 按武器型号摆手：右拳握把，左拳托护木 */
  const poseArms = (id: WeaponId): void => {
    posedFor = id
    // 武器本地 → 枢轴：(x, y, z) → (-x, y, -z)
    axisPoint.set(-GRIP_POINT.x, GRIP_POINT.y, -GRIP_POINT.z)
    gripDir.set(-GRIP_AXIS.x, GRIP_AXIS.y, -GRIP_AXIS.z)
    solveArm(armR, ARM.shoulderR, ARM.poleR, gripDir, ARM.wristR, -1)
    const support = SUPPORT[id]
    axisPoint.set(0, support.y + SUPPORT_LIFT, -support.z)
    solveArm(armL, ARM.shoulderL, ARM.poleL, SUPPORT_AXIS, ARM.wristL, 1)
  }

  const rigs: (WeaponRig | null)[] = []
  const ids: (WeaponId | null)[] = []
  for (let i = 0; i < PLAYER.maxWeapons; i++) {
    rigs.push(null)
    ids.push(null)
  }

  let time = 0
  let swayX = 0
  let swayY = 0
  let sprintAmount = 0
  let reloadAmount = 0
  let dropAmount = 0
  let kickAmount = 0

  const removeRig = (slot: number): void => {
    const rig = rigs[slot]
    if (!rig) return
    pivot.remove(rig.root)
    rig.dispose()
    rigs[slot] = null
  }

  const sync = (weapons: readonly WeaponState[]): number => {
    let changed = 0
    for (let i = 0; i < PLAYER.maxWeapons; i++) {
      const state = weapons[i]
      const id = state ? state.id : null
      if (id === ids[i]) continue
      changed |= 1 << i
      removeRig(i)
      ids[i] = id
      if (id === null) continue
      const rig = models.createWeapon(id)
      // 武器模型枪管朝 +Z，相机看向 -Z：绕 Y 转半圈
      rig.root.rotation.y = Math.PI
      rig.root.visible = false
      // 贴脸的小模型不参与阴影，否则地上会有一把悬空的枪影
      rig.root.traverse((node) => {
        node.castShadow = false
        node.receiveShadow = false
      })
      pivot.add(rig.root)
      rigs[i] = rig
    }
    return changed
  }

  const kick = (strength: number): void => {
    kickAmount = Math.min(VIEW.kickMax, kickAmount + VIEW.kickPerShot * strength)
  }

  const muzzleWorld = (slot: number, out: Vector3): boolean => {
    const rig = rigs[slot]
    if (!rig || !root.visible || !rig.root.visible) return false
    rig.muzzle.getWorldPosition(out)
    return true
  }

  const update = (dt: number, input: ViewModelInput): void => {
    time += dt
    kickAmount = damp(kickAmount, 0, VIEW.kickRecover, dt)

    let shown: WeaponId | null = null
    for (let i = 0; i < rigs.length; i++) {
      const rig = rigs[i]
      if (!rig) continue
      rig.root.visible = i === input.slot
      if (rig.root.visible) shown = rig.id
    }
    // 换上新枪（切枪降到最低点时）重新摆手
    if (shown !== null && shown !== posedFor) poseArms(shown)
    root.visible = input.visible && shown !== null
    if (!root.visible) {
      swayX = 0
      swayY = 0
      return
    }

    // 视角转动越快，枪身滞后越多
    const invDt = dt > 1e-5 ? 1 / dt : 0
    const targetX = clamp(-input.lookX * invDt * VIEW.swayPerSpeed, -VIEW.swayMax, VIEW.swayMax)
    const targetY = clamp(input.lookY * invDt * VIEW.swayPerSpeed, -VIEW.swayMax, VIEW.swayMax)
    swayX = damp(swayX, targetX, VIEW.swayRate, dt)
    swayY = damp(swayY, targetY, VIEW.swayRate, dt)

    sprintAmount = damp(sprintAmount, input.sprinting ? 1 : 0, VIEW.sprintRate, dt)

    // 换弹：开头沉下去，结尾抬回来，中间保持倾斜
    const reloadTarget =
      input.reload >= 0
        ? smoothstep(input.reload / VIEW.reloadEdge) *
          (1 - smoothstep((input.reload - (1 - VIEW.reloadEdge)) / VIEW.reloadEdge))
        : 0
    reloadAmount = damp(reloadAmount, reloadTarget, VIEW.reloadRate, dt)

    // 切枪：前半程降下，后半程升起
    const dropTarget = input.switchProgress >= 0 ? 1 - Math.abs(input.switchProgress * 2 - 1) : 0
    dropAmount = damp(dropAmount, dropTarget, VIEW.switchRate, dt)

    const bobX = Math.sin(input.bobPhase) * VIEW.bobX * input.bob
    const bobY = Math.cos(input.bobPhase * 2) * VIEW.bobY * input.bob
    const breathe = Math.sin(time * VIEW.breatheFreq) * VIEW.breathe

    pivot.position.set(
      HOLD.x + swayX + bobX,
      HOLD.y +
        swayY +
        bobY +
        breathe -
        sprintAmount * VIEW.sprintDrop -
        reloadAmount * VIEW.reloadDrop -
        dropAmount * VIEW.switchDrop,
      HOLD.z + kickAmount * VIEW.kickBack,
    )
    // rotation.x 为正时枪口上抬；rotation.y 为正时枪口转向左侧
    pivot.rotation.set(
      kickAmount * VIEW.kickPitch -
        swayY * VIEW.swayTilt -
        sprintAmount * VIEW.sprintPitch -
        reloadAmount * VIEW.reloadPitch -
        dropAmount * VIEW.switchPitch,
      sprintAmount * VIEW.sprintYaw - swayX * VIEW.swayTilt,
      reloadAmount * VIEW.reloadRoll,
    )
  }

  const dispose = (): void => {
    for (let i = 0; i < rigs.length; i++) {
      removeRig(i)
      ids[i] = null
    }
    // 几何体是人形模型的共享几何体，不释放；材质归本模块
    pivot.remove(arms)
    for (const mat of armMats) mat.dispose()
    posedFor = null
    root.remove(pivot)
  }

  return { root, sync, kick, muzzleWorld, update, dispose }
}

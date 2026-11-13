/**
 * 第一人称视图模型：持枪模型挂在相机右下方，负责摇摆、冲刺放低、换弹倾斜下沉、切枪升降与后坐。
 * 只做表现，不含玩法逻辑，由 systems/player.ts 每帧驱动。
 *
 * 为了不穿进场景，整体缩小后贴近相机：root 的缩放为 VIEW_MODEL_SCALE，
 * 其内部的位置偏移全部按“原尺寸”的米来写，投影到屏幕上的大小与原尺寸持枪一致。
 */

import { Group } from 'three'
import type { Vector3 } from 'three'
import { PLAYER } from '../core/config'
import type { ActorModels, WeaponId, WeaponRig, WeaponState } from '../core/types'
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

    let shown = false
    for (let i = 0; i < rigs.length; i++) {
      const rig = rigs[i]
      if (!rig) continue
      rig.root.visible = i === input.slot
      if (rig.root.visible) shown = true
    }
    root.visible = input.visible && shown
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
    root.remove(pivot)
  }

  return { root, sync, kick, muzzleWorld, update, dispose }
}

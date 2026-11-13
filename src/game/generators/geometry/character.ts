/**
 * 四名角色的人形模型：在共用骨架上按 CHARACTERS 配色，并加上各自的识别特征。
 *
 * - Samuel：灰蓝校服，灰色衣领与袖口条纹。
 * - Football Master：红橙短袖球衣 + 深色短裤 + 橙色球袜，身体宽 1.1 倍，左臂黄色队长袖标。
 * - Manman：白上衣 + 浅蓝裙摆与长裤，身体宽 0.9 倍、略矮，深棕色马尾。
 * - 91Z：黑卫衣，兜帽罩住头顶与两侧，脸下半部是口罩（薄盒）。
 */

import { CHARACTERS } from '../../core/config'
import type { CharacterId, HumanoidRig } from '../../core/types'
import { getTexture } from '../textures'
import { createHumanoid } from './humanoid'
import type { HumanoidBuild, HumanoidLook } from './humanoid'

interface CharacterStyle {
  /** 站立总高（米） */
  height: number
  /** 头部半径（米） */
  headRadius: number
  hair: number
  shoe: number
  /** 动画初相位，避免几个人呼吸与步伐完全同步 */
  phase: number
  /** 阵亡姿态的左右镜像 */
  deadSide: 1 | -1
}

/** CHARACTERS 没有给出的外观补充项 */
const STYLES: Record<CharacterId, CharacterStyle> = {
  samuel: { height: 1.8, headRadius: 0.17, hair: 0x2b2420, shoe: 0xe6e6e8, phase: 0.4, deadSide: 1 },
  football: { height: 1.84, headRadius: 0.17, hair: 0x1b1613, shoe: 0x18181a, phase: 2.1, deadSide: -1 },
  manman: { height: 1.7, headRadius: 0.163, hair: 0x3b2a20, shoe: 0xf2f2f4, phase: 3.7, deadSide: 1 },
  z91: { height: 1.8, headRadius: 0.17, hair: 0x121216, shoe: 0x141416, phase: 5.2, deadSide: -1 },
}

const EYE_COLOR = 0x16181c
/** Football Master 的球袜 */
const SOCK_COLOR = 0xf08a3c
/** Samuel 的腰带 */
const BELT_COLOR = 0x26221f

/** 脸：一对深色椭圆眼睛（一个网格），让正面朝向一眼可辨 */
function addEyes(rig: HumanoidBuild, look: HumanoidLook): void {
  const eyes = rig.addMesh(rig.parts.head, 'eyes', look)
  eyes.scale.setScalar(rig.dims.headRadius)
  eyes.castShadow = false
}

/** 头发：比头略大、向后上方偏移的扁球，盖住头顶与后脑，露出脸 */
function addHair(rig: HumanoidBuild, look: HumanoidLook, size: number): void {
  const r = rig.dims.headRadius
  const cap = rig.addMesh(rig.parts.head, 'sphere', look)
  cap.scale.set(r * size * 0.95, r * size, r * size)
  cap.position.set(0, r * 0.16, -r * 0.16)
}

/** 衣领：围在脖子根部的一圈立领 */
function addCollar(rig: HumanoidBuild, look: HumanoidLook): void {
  const d = rig.dims
  const r = d.headRadius
  const collar = rig.addMesh(rig.parts.torso, 'band', look)
  collar.scale.set(r * 0.62, 0.05, r * 0.58)
  collar.position.set(0, d.torsoHeight + 0.03, 0)
  collar.castShadow = false
}

/**
 * 上臂上的一圈色带（袖口条纹 / 队长袖标）。
 * @param at 色带上沿在上臂上的位置 0..1（0 为肩）
 * @param width 色带宽度（米）
 */
function addArmBand(rig: HumanoidBuild, side: 'L' | 'R', look: HumanoidLook, at: number, width: number): void {
  const d = rig.dims
  const band = rig.addMesh(side === 'L' ? rig.parts.upperArmL : rig.parts.upperArmR, 'band', look)
  band.scale.set(d.armRadius * 1.02, width, d.armRadius * 1.02)
  band.position.set(0, -d.upperArm * at, 0)
  band.castShadow = false
}

/**
 * 创建一名角色的人形模型（可持枪）。
 * @param id 角色 id，配色与身体宽度取自 CHARACTERS
 * @returns 原点在脚底、正面朝 +Z 的 rig；整体缩放为 1，武器挂到右手后不会被缩放
 */
export function createCharacter(id: CharacterId): HumanoidRig {
  const def = CHARACTERS[id]
  const style = STYLES[id]
  const cloth = getTexture('cloth')
  const wide = def.bodyScale
  const tall = style.height / 1.8

  const skin: HumanoidLook = { color: def.headColor, roughness: 0.62 }
  const top: HumanoidLook = { color: def.bodyColor, map: cloth, roughness: 0.9 }
  const legs: HumanoidLook = { color: def.legColor, map: cloth, roughness: 0.9 }
  const shoe: HumanoidLook = { color: style.shoe, roughness: 0.8 }
  const accent: HumanoidLook = { color: def.accentColor, roughness: 0.8 }
  // Manman 的头发与马尾用 accentColor，其余角色用 STYLES 里的发色
  const hair: HumanoidLook = { color: id === 'manman' ? def.accentColor : style.hair, roughness: 0.95 }
  const eyes: HumanoidLook = { color: EYE_COLOR, roughness: 0.5 }

  const rig = createHumanoid({
    height: style.height,
    headRadius: style.headRadius,
    torsoWidth: 0.44 * wide,
    torsoDepth: 0.24 * wide,
    torsoHeight: 0.56 * tall,
    armRadius: 0.06 * wide,
    armLength: 0.55 * tall,
    legRadius: 0.085 * wide,
    skin,
    top,
    legs,
    shoe,
    // 球衣是短袖：前臂露出皮肤；小腿是球袜
    forearm: id === 'football' ? skin : undefined,
    shin: id === 'football' ? { color: SOCK_COLOR, map: cloth, roughness: 0.9 } : undefined,
    armed: true,
    phase: style.phase,
    deadSide: style.deadSide,
  })

  const d = rig.dims
  const r = d.headRadius
  addEyes(rig, eyes)

  if (id === 'samuel') {
    addHair(rig, hair, 1.06)
    addCollar(rig, accent)
    addArmBand(rig, 'L', accent, 0.7, 0.04)
    addArmBand(rig, 'R', accent, 0.7, 0.04)
    // 腰带：第一人称低头时能看到的裤腰
    const belt = rig.addMesh(rig.parts.body, 'band', { color: BELT_COLOR, roughness: 0.55 })
    belt.scale.set(d.torsoWidth * 0.47, 0.036, d.torsoDepth * 0.5)
    belt.position.set(0, 0.052, 0)
    belt.castShadow = false
  } else if (id === 'football') {
    addHair(rig, hair, 1.04)
    // 左臂队长袖标
    addArmBand(rig, 'L', accent, 0.42, 0.075)
  } else if (id === 'manman') {
    addHair(rig, hair, 1.07)
    // 马尾：后脑一个发结 + 向后下方垂下的锥台
    const knot = rig.addMesh(rig.parts.head, 'sphere', hair)
    knot.scale.setScalar(r * 0.36)
    knot.position.set(0, r * 0.5, -r * 1.08)
    const tail = rig.addMesh(rig.parts.head, 'limb', hair)
    tail.scale.set(r * 0.3, r * 2.1, r * 0.3)
    tail.position.set(0, r * 0.5, -r * 1.1)
    tail.rotation.x = 0.42
    // 浅蓝衣领与裙摆
    addCollar(rig, legs)
    // 裙摆：围在骨盆外的一圈短筒
    const skirt = rig.addMesh(rig.parts.body, 'band', legs)
    skirt.scale.set(d.torsoWidth * 0.57, 0.21, d.torsoDepth * 0.64)
    skirt.position.set(0, 0.03, 0)
  } else {
    // 兜帽：罩住头顶、两侧与后脑，前面只露出眼睛一带
    const hood = rig.addMesh(rig.parts.head, 'sphere', top)
    hood.scale.set(r * 1.1, r * 1.17, r * 1.2)
    hood.position.set(0, r * 0.12, -r * 0.3)
    // 口罩：盖住脸下半部与鼻子
    const mask = rig.addMesh(rig.parts.head, 'box', accent)
    mask.scale.set(r * 1.22, r * 0.62, r * 0.84)
    mask.position.set(0, -r * 0.33, r * 0.76)
    // 垂在颈后的帽兜与腹部口袋
    const drape = rig.addMesh(rig.parts.torso, 'box', top)
    drape.scale.set(d.torsoWidth * 0.62, 0.11, 0.07)
    drape.position.set(0, d.torsoHeight, -d.torsoDepth * 0.4)
    const pocket = rig.addMesh(rig.parts.torso, 'box', accent)
    pocket.scale.set(d.torsoWidth * 0.6, 0.12, 0.02)
    pocket.position.set(0, d.torsoHeight * 0.3, d.torsoDepth * 0.48 + 0.008)
    pocket.castShadow = false
  }

  return rig
}

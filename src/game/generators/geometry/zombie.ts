/**
 * 三种丧尸的人形模型：复用人形骨架，seed 决定歪斜、配色、破损、双臂姿态与步态等变体。
 *
 * - common：腐烂学生，破烂校服，双臂前伸蹒跚，攻击为抓咬。
 * - runner：瘦削、身体前倾、四肢修长，赤臂赤脚，攻击为前扑。
 * - tank：肌肉膨胀、粗臂、约 2.5m 高，上身赤裸只剩腰间与肩带的校服残片，攻击为双拳砸地。
 *
 * 整体缩放取 ENEMIES[type].scale，未缩放身高取 height / scale，所以 rig.height 恰好等于 ENEMIES[type].height。
 */

import { ENEMIES } from '../../core/config'
import type { EnemyType, HumanoidRig } from '../../core/types'
import { createRng } from '../../utils/random'
import type { Rng } from '../../utils/random'
import { getTexture } from '../textures'
import { createHumanoid } from './humanoid'
import type { HumanoidBuild, HumanoidLook, HumanoidOptions } from './humanoid'

/** 随机歪斜上限：±15° */
const MAX_TILT = (15 * Math.PI) / 180

/** 褪色发脏的校服上衣 / 裤子颜色（给 cloth 纹理着色） */
const UNIFORM_COLORS: readonly number[] = [0x5d6f86, 0x6b7a72, 0x7c6f62, 0x55606e, 0x86806f, 0x64586a, 0x8a8f94]
const PANTS_COLORS: readonly number[] = [0x2f343b, 0x3b3832, 0x2a3038, 0x47423b]
/** 皮肤纹理本身已是灰绿腐烂色，这里只做轻微的明暗与色调变化 */
const SKIN_TINTS: readonly number[] = [0xffffff, 0xdfe6d2, 0xcfd6c4, 0xe8dfd0, 0xc4ccc0]
const HAIR_COLORS: readonly number[] = [0x1c1a18, 0x2a241f, 0x3a3630]
const SHOE_COLOR = 0x1f1f22
const BLOOD_COLOR = 0x4a0f0c

/** 眼睛：底色与自发光（暗处也能看清朝向） */
const EYES: Record<EnemyType, { color: number; emissive: number }> = {
  common: { color: 0xd9d3a8, emissive: 0x6b6126 },
  runner: { color: 0xe6b0a0, emissive: 0x8a1f14 },
  tank: { color: 0xe0c890, emissive: 0x7a4a12 },
}

/** 发光的眼睛与污黑的嘴 */
function addFace(rig: HumanoidBuild, eyes: HumanoidLook, mouth: HumanoidLook): void {
  const r = rig.dims.headRadius
  const head = rig.parts.head
  const left = rig.addMesh(head, 'box', eyes)
  left.scale.set(r * 0.22, r * 0.14, r * 0.1)
  left.position.set(r * 0.36, r * 0.14, r * 0.9)
  const right = rig.addMesh(head, 'box', eyes)
  right.scale.copy(left.scale)
  right.position.set(-r * 0.36, r * 0.14, r * 0.9)
  const jaw = rig.addMesh(head, 'box', mouth)
  jaw.scale.set(r * 0.5, r * 0.18, r * 0.1)
  jaw.position.set(0, -r * 0.42, r * 0.88)
}

/** 胸腹上的一块血污，位置与大小随 seed 变化 */
function addStain(rig: HumanoidBuild, rng: Rng, look: HumanoidLook): void {
  const d = rig.dims
  const stain = rig.addMesh(rig.parts.torso, 'box', look)
  const w = d.torsoWidth * rng.range(0.25, 0.5)
  const h = d.torsoHeight * rng.range(0.2, 0.42)
  stain.scale.set(w, h, 0.012)
  stain.position.set(
    rng.range(-0.5, 0.5) * (d.torsoWidth - w),
    d.torsoHeight * rng.range(0.3, 0.75),
    d.torsoDepth / 2 + 0.004,
  )
}

/** 稀疏的头发：比头略大、向后上方偏移的球 */
function addHair(rig: HumanoidBuild, look: HumanoidLook): void {
  const r = rig.dims.headRadius
  const cap = rig.addMesh(rig.parts.head, 'sphere', look)
  cap.scale.setScalar(r * 1.05)
  cap.position.set(0, r * 0.16, -r * 0.2)
}

/** 坦克的肌肉与校服残片：三角肌、隆起的胸背、腰间布片、斜挎的肩带 */
function addTankBulk(rig: HumanoidBuild, skin: HumanoidLook, rag: HumanoidLook): void {
  const d = rig.dims
  const deltoidL = rig.addMesh(rig.parts.upperArmL, 'sphere', skin)
  deltoidL.scale.setScalar(d.armRadius * 1.5)
  deltoidL.position.set(d.armRadius * 0.15, -d.armRadius * 0.2, 0)
  const deltoidR = rig.addMesh(rig.parts.upperArmR, 'sphere', skin)
  deltoidR.scale.copy(deltoidL.scale)
  deltoidR.position.set(-d.armRadius * 0.15, -d.armRadius * 0.2, 0)

  const chest = rig.addMesh(rig.parts.torso, 'box', skin)
  chest.scale.set(d.torsoWidth * 0.92, d.torsoHeight * 0.4, d.torsoDepth * 1.16)
  chest.position.set(0, d.torsoHeight * 0.72, 0.01)

  const waist = rig.addMesh(rig.parts.torso, 'box', rag)
  waist.scale.set(d.torsoWidth * 1.03, d.torsoHeight * 0.26, d.torsoDepth * 1.04)
  waist.position.set(0, d.torsoHeight * 0.1, 0)

  const strap = rig.addMesh(rig.parts.torso, 'box', rag)
  strap.scale.set(d.torsoWidth * 0.2, d.torsoHeight * 1.05, d.torsoDepth * 1.2)
  strap.position.set(d.torsoWidth * 0.08, d.torsoHeight * 0.55, 0)
  strap.rotation.z = 0.55
}

/**
 * 创建一只丧尸的人形模型（不能持枪，attachWeapon 无效果，muzzle 恒为 null）。
 * @param type 丧尸类型，决定体型、整体缩放与攻击动作
 * @param seed 变体种子：歪斜角度（±15°）、校服与肤色、破损部位、双臂高低、跛行与倒地方向
 * @returns 原点在脚底、正面朝 +Z 的 rig；height 等于 ENEMIES[type].height
 */
export function createZombie(type: EnemyType, seed: number): HumanoidRig {
  const def = ENEMIES[type]
  const rng = createRng(seed)
  const skinTex = getTexture('skin')
  const cloth = getTexture('cloth')

  const skin: HumanoidLook = { color: rng.pick(SKIN_TINTS), map: skinTex, roughness: 0.95 }
  const top: HumanoidLook = { color: rng.pick(UNIFORM_COLORS), map: cloth, roughness: 1 }
  const legs: HumanoidLook = { color: rng.pick(PANTS_COLORS), map: cloth, roughness: 1 }
  const shoe: HumanoidLook = { color: SHOE_COLOR, roughness: 0.9 }
  const blood: HumanoidLook = { color: BLOOD_COLOR, roughness: 0.6 }
  const eyes: HumanoidLook = { color: EYES[type].color, emissive: EYES[type].emissive, roughness: 0.4 }

  // 歪斜：躯干与头合计侧歪不超过 ±15°，另加少量扭转与转头
  const tilt = rng.range(-MAX_TILT, MAX_TILT)
  const base: HumanoidOptions = {
    scale: def.scale,
    height: def.height / def.scale,
    skin,
    top,
    legs,
    roll: tilt * 0.45,
    headRoll: tilt * 0.55,
    twist: rng.range(-0.14, 0.14),
    headTurn: rng.range(-0.2, 0.2),
    phase: rng.range(0, Math.PI * 2),
    deadOnBack: rng.chance(0.65),
    deadSide: rng.sign(),
  }

  let options: HumanoidOptions
  if (type === 'tank') {
    options = {
      ...base,
      headRadius: 0.15,
      neck: 0.03,
      torsoWidth: 0.68,
      torsoHeight: 0.66,
      torsoDepth: 0.4,
      armRadius: 0.105,
      armLength: 0.66,
      legRadius: 0.12,
      // 上身赤裸：躯干与手臂都用皮肤
      top: skin,
      shoe: rng.chance(0.5) ? skin : shoe,
      lean: rng.range(0.14, 0.2),
      cadence: 0.72,
      stride: 0.9,
      sway: 0.1,
      zombie: {
        attack: 'slam',
        reach: 0.5,
        armOffsetL: rng.range(-0.1, 0.15),
        armOffsetR: rng.range(-0.1, 0.15),
        armSpread: rng.range(0.22, 0.34),
        armBend: rng.range(0.35, 0.55),
        limp: rng.range(-0.2, 0.2),
      },
    }
  } else if (type === 'runner') {
    options = {
      ...base,
      headRadius: 0.155,
      neck: 0.06,
      torsoWidth: 0.35,
      torsoHeight: 0.5,
      torsoDepth: 0.185,
      armRadius: 0.043,
      armLength: 0.66,
      legRadius: 0.064,
      // 袖子与裤腿都磨没了，赤脚
      upperArm: rng.chance(0.4) ? top : skin,
      forearm: skin,
      shin: skin,
      shoe: skin,
      lean: rng.range(0.28, 0.36),
      cadence: 1.1,
      stride: 1.05,
      sway: 0.04,
      zombie: {
        attack: 'lunge',
        reach: 0.95,
        armOffsetL: rng.range(-0.15, 0.25),
        armOffsetR: rng.range(-0.15, 0.25),
        armSpread: rng.range(0.02, 0.2),
        armBend: rng.range(0.5, 0.85),
        limp: rng.range(-0.15, 0.15),
      },
    }
  } else {
    const bulk = rng.range(0.94, 1.08)
    options = {
      ...base,
      torsoWidth: 0.44 * bulk,
      torsoDepth: 0.24 * bulk,
      armRadius: 0.058 * bulk,
      legRadius: 0.083 * bulk,
      // 破烂校服：袖子、裤腿、鞋随机缺失
      forearm: rng.chance(0.5) ? skin : top,
      shin: rng.chance(0.35) ? skin : legs,
      shoe: rng.chance(0.25) ? skin : shoe,
      lean: rng.range(0.08, 0.2),
      cadence: rng.range(0.92, 1.06),
      sway: 0.07,
      zombie: {
        attack: 'bite',
        reach: rng.range(0.88, 1),
        armOffsetL: rng.range(-0.25, 0.3),
        armOffsetR: rng.range(-0.25, 0.3),
        armSpread: rng.range(-0.06, 0.16),
        armBend: rng.range(0.1, 0.45),
        limp: rng.range(-0.6, 0.6),
      },
    }
  }

  const rig = createHumanoid(options)

  addFace(rig, eyes, blood)
  addStain(rig, rng, blood)
  if (type === 'tank') {
    addTankBulk(rig, skin, { color: rng.pick(UNIFORM_COLORS), map: cloth, roughness: 1 })
  } else if (type === 'common' && rng.chance(0.6)) {
    addHair(rig, { color: rng.pick(HAIR_COLORS), roughness: 1 })
  }

  return rig
}

/**
 * 三种丧尸的人形模型：复用人形骨架，seed 决定歪斜、配色、破损、双臂姿态与步态等变体。
 *
 * - common：腐烂学生，破烂校服，双臂前伸蹒跚，攻击为抓咬。
 * - runner：瘦削、身体前倾、四肢修长，赤臂赤脚，攻击为前扑。
 * - tank：肌肉膨胀、粗臂、约 2.5m 高，上身赤裸只剩腰间与肩带的校服残片，攻击为双拳砸地。
 *
 * 共同细节：手是张开弯曲的爪；衣摆与断袖、断裤腿处垂着布条；部分个体胸侧撕开、露出血肉与肋骨；嘴里露出一排牙。
 *
 * 整体缩放取 ENEMIES[type].scale，未缩放身高取 height / scale，所以 rig.height 恰好等于 ENEMIES[type].height。
 */

import { Group } from 'three'
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
/** 露出的骨头与牙齿 */
const BONE_COLOR = 0xc9bc98

/** 眼睛：底色与自发光（暗处也能看清朝向） */
const EYES: Record<EnemyType, { color: number; emissive: number }> = {
  common: { color: 0xd9d3a8, emissive: 0x6b6126 },
  runner: { color: 0xe6b0a0, emissive: 0x8a1f14 },
  tank: { color: 0xe0c890, emissive: 0x7a4a12 },
}

/** 发光的眼睛、污黑张开的嘴与一排露出的牙 */
function addFace(rig: HumanoidBuild, eyes: HumanoidLook, mouth: HumanoidLook, bone: HumanoidLook): void {
  const r = rig.dims.headRadius
  const head = rig.parts.head
  const eyeMesh = rig.addMesh(head, 'eyes', eyes)
  eyeMesh.scale.set(r * 1.08, r * 1.15, r)
  eyeMesh.castShadow = false
  const jaw = rig.addMesh(head, 'box', mouth)
  jaw.scale.set(r * 0.5, r * 0.22, r * 0.14)
  jaw.position.set(0, -r * 0.44, r * 0.84)
  jaw.castShadow = false
  const teeth = rig.addMesh(head, 'box', bone)
  teeth.scale.set(r * 0.4, r * 0.06, r * 0.08)
  teeth.position.set(0, -r * 0.36, r * 0.9)
  teeth.castShadow = false
}

/**
 * 破衣服：衣摆一圈下垂的布条；袖子 / 裤腿只剩上半截时，在断口处也垂下布条。
 * @param top 上衣外观（为皮肤时表示赤膊，不加衣摆）
 */
function addRags(
  rig: HumanoidBuild,
  rng: Rng,
  skin: HumanoidLook,
  top: HumanoidLook,
  upperArm: HumanoidLook,
  forearm: HumanoidLook,
  legs: HumanoidLook,
  shin: HumanoidLook,
): void {
  const d = rig.dims
  const p = rig.parts
  if (top !== skin) {
    const hem = rig.addMesh(p.torso, 'rags', top)
    hem.scale.set(d.torsoWidth * 0.93, rng.range(0.1, 0.16), d.torsoDepth * 0.96)
    hem.position.set(0, 0.03, 0)
    // 布条的长短是固定图案：随机左右镜像一下，避免每只丧尸的衣摆完全一样
    if (rng.chance(0.5)) hem.scale.x = -hem.scale.x
  }
  if (upperArm !== skin && forearm === skin) {
    for (const arm of [p.upperArmL, p.upperArmR]) {
      const cuff = rig.addMesh(arm, 'rags', upperArm)
      cuff.scale.set(d.armRadius * 2.1, rng.range(0.05, 0.09), d.armRadius * 2.1)
      cuff.position.set(0, -d.upperArm * 0.9, 0)
      cuff.rotation.y = rng.range(0, Math.PI * 2)
      cuff.castShadow = false
    }
  }
  if (legs !== skin && shin === skin) {
    for (const thigh of [p.thighL, p.thighR]) {
      const cuff = rig.addMesh(thigh, 'rags', legs)
      cuff.scale.set(d.legRadius * 2.1, rng.range(0.07, 0.12), d.legRadius * 2.1)
      cuff.position.set(0, -d.thigh * 0.92, 0)
      cuff.rotation.y = rng.range(0, Math.PI * 2)
      cuff.castShadow = false
    }
  }
}

/** 胸侧撕开的伤口：一块暗红的血肉与露出的四根肋骨，偏向随机一侧 */
function addRibWound(rig: HumanoidBuild, rng: Rng, flesh: HumanoidLook, bone: HumanoidLook): void {
  const d = rig.dims
  const turn = rng.sign() * rng.range(0.25, 0.6)
  const pivot = new Group()
  pivot.rotation.y = turn
  rig.parts.torso.add(pivot)
  const wound = rig.addMesh(pivot, 'sphere', flesh)
  wound.scale.set(d.torsoWidth * 0.2, d.torsoHeight * 0.2, d.torsoDepth * 0.1)
  wound.position.set(0, d.torsoHeight * 0.62, d.torsoDepth * 0.415)
  wound.castShadow = false
  const ribs = rig.addMesh(pivot, 'ribs', bone)
  ribs.scale.set(d.torsoWidth * 0.62, d.torsoHeight * 0.17, d.torsoDepth * 1.04)
  ribs.position.set(0, d.torsoHeight * 0.72, 0)
  ribs.castShadow = false
}

/** 胸腹上的一块血污，位置与大小随 seed 变化 */
function addStain(rig: HumanoidBuild, rng: Rng, look: HumanoidLook): void {
  const d = rig.dims
  // 压扁的球贴在弧形的胸腹上，比平板更贴合躯干表面
  const stain = rig.addMesh(rig.parts.torso, 'sphere', look)
  const w = d.torsoWidth * rng.range(0.25, 0.5)
  const h = d.torsoHeight * rng.range(0.2, 0.42)
  stain.scale.set(w / 2, h / 2, d.torsoDepth * 0.07)
  stain.position.set(
    rng.range(-0.35, 0.35) * (d.torsoWidth - w),
    d.torsoHeight * rng.range(0.3, 0.75),
    d.torsoDepth * 0.445,
  )
  stain.castShadow = false
}

/** 稀疏的头发：比头略大、向后上方偏移的球 */
function addHair(rig: HumanoidBuild, look: HumanoidLook): void {
  const r = rig.dims.headRadius
  const cap = rig.addMesh(rig.parts.head, 'sphere', look)
  cap.scale.set(r * 0.98, r * 1.05, r * 1.05)
  cap.position.set(0, r * 0.18, -r * 0.2)
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

  // 隆起的胸肌与背阔：扁球鼓出躯干表面
  const chest = rig.addMesh(rig.parts.torso, 'sphere', skin)
  chest.scale.set(d.torsoWidth * 0.5, d.torsoHeight * 0.24, d.torsoDepth * 0.6)
  chest.position.set(0, d.torsoHeight * 0.72, 0.01)

  // 腰间残留的校服：一圈短筒加下垂的布条
  const waist = rig.addMesh(rig.parts.torso, 'band', rag)
  waist.scale.set(d.torsoWidth * 0.52, d.torsoHeight * 0.26, d.torsoDepth * 0.54)
  waist.position.set(0, d.torsoHeight * 0.23, 0)
  const hem = rig.addMesh(rig.parts.torso, 'rags', rag)
  hem.scale.set(d.torsoWidth * 1.03, d.torsoHeight * 0.22, d.torsoDepth * 1.07)
  hem.position.set(0, -0.03, 0)

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

  // 腐烂的皮肤略带湿润的反光；血污更湿更亮
  const skin: HumanoidLook = { color: rng.pick(SKIN_TINTS), map: skinTex, roughness: 0.78 }
  const top: HumanoidLook = { color: rng.pick(UNIFORM_COLORS), map: cloth, roughness: 0.97 }
  const legs: HumanoidLook = { color: rng.pick(PANTS_COLORS), map: cloth, roughness: 0.97 }
  const shoe: HumanoidLook = { color: SHOE_COLOR, roughness: 0.85 }
  const blood: HumanoidLook = { color: BLOOD_COLOR, roughness: 0.38 }
  const bone: HumanoidLook = { color: BONE_COLOR, roughness: 0.62 }
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

  addFace(rig, eyes, blood, bone)
  addStain(rig, rng, blood)
  const upperArm = options.upperArm ?? options.top
  const forearm = options.forearm ?? upperArm
  const shin = options.shin ?? options.legs
  addRags(rig, rng, skin, options.top, upperArm, forearm, options.legs, shin)
  if (type === 'tank') {
    addTankBulk(rig, skin, { color: rng.pick(UNIFORM_COLORS), map: cloth, roughness: 0.97 })
  } else {
    if (type === 'common' && rng.chance(0.6)) addHair(rig, { color: rng.pick(HAIR_COLORS), roughness: 1 })
    if (rng.chance(type === 'runner' ? 0.7 : 0.35)) addRibWound(rig, rng, blood, bone)
  }

  return rig
}

/**
 * 植被：阔叶树（枝干 + 成簇的不规则叶团）、针叶树（层叠的锯齿状枝层），以及横倒的大树。
 * 成片的树用 InstancedMesh：每个树种变体两次 draw call（树干、树冠），逐实例改变大小、朝向和叶色。
 */

import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { Rng } from '../../utils/random'
import { createRng } from '../../utils/random'
import {
  assemble,
  blob,
  cylinder,
  deform,
  geometrySet,
  hash01,
  limb,
  paintVertices,
  smoothstep,
  surface,
} from './props-kit'
import type { Assembly, GeometrySet, Prop } from './props-kit'

/** 树种变体：阔叶 3 种、针叶 2 种 */
const BROAD_VARIANTS = 3
const PINE_VARIANTS = 2

/** 阔叶树的逐实例叶色（与叶丛贴图的固有绿色相乘） */
const BROAD_TINTS = [0xffffff, 0xe6f2c8, 0xd4e4b8, 0xf4e6a8, 0xc8d8b0, 0xf0f4d8] as const
/** 针叶树的逐实例叶色（更深、更冷） */
const PINE_TINTS = [0xa6c8a0, 0x94bc98, 0xb4cca4, 0x9cc49c] as const

function treeMaterials(): Record<string, Material> {
  return {
    bark: surface('bark'),
    leaf: surface('foliage', { roughness: 0.9 }),
  }
}

/** 一团叶子：不规则团块，顶部受光亮、底部背光暗 */
function leafClump(radius: number, seed: number, squash: number): BufferGeometry {
  const g = blob(radius, 1, 0.24, seed, 1, squash, 1)
  return paintVertices(g, (p, out) => {
    const k = 0.5 + 0.5 * smoothstep(-radius * squash, radius * squash, p.y)
    out.setRGB(k, k, k)
  })
}

/** 阔叶树：略微倾斜的主干，四五根斜向上的主枝，枝头与树心各一团叶子 */
function buildBroadleaf(a: Assembly, variant: number): void {
  const rng = createRng(9100 + variant * 31)
  a.tile('bark', 1.2).tile('leaf', 2)
  const trunkH = rng.range(3.0, 3.8)
  const leanX = rng.range(-0.35, 0.35)
  const leanZ = rng.range(-0.35, 0.35)
  const trunk: Vector3[] = []
  for (let i = 0; i <= 5; i++) {
    const t = i / 5
    trunk.push(new Vector3(leanX * t * t, t * trunkH, leanZ * t * t))
  }
  // 根部外扩
  a.addUV('bark', limb(trunk, (t) => 0.26 * (1 - 0.4 * t) + 0.14 * Math.max(0, 1 - t / 0.15), 9, 1.2))

  const top = trunk[5]
  const branches = rng.int(4, 5)
  const phase = rng.range(0, Math.PI * 2)
  const tips: Vector3[] = []
  for (let i = 0; i < branches; i++) {
    const yaw = phase + (i / branches) * Math.PI * 2 + rng.range(-0.3, 0.3)
    const rise = rng.range(0.55, 0.95)
    const length = rng.range(1.6, 2.4)
    const base = new Vector3(leanX * 0.7, trunkH * rng.range(0.72, 0.95), leanZ * 0.7)
    const dir = new Vector3(Math.cos(yaw) * Math.cos(rise), Math.sin(rise), Math.sin(yaw) * Math.cos(rise))
    const path: Vector3[] = []
    for (let k = 0; k <= 3; k++) {
      const t = k / 3
      path.push(base.clone().addScaledVector(dir, length * t).add(new Vector3(0, t * t * 0.5, 0)))
    }
    a.addUV('bark', limb(path, (t) => 0.12 * (1 - 0.6 * t), 6, 1.2, true))
    tips.push(path[3])
  }

  // 树冠：树心一大团 + 枝头各一团 + 顶上一两团；越靠下的叶团越暗
  const crownY = top.y + 1.4
  const clumps: [Vector3, number][] = [[new Vector3(top.x, crownY, top.z), rng.range(1.9, 2.3)]]
  for (const tip of tips) clumps.push([tip.clone().add(new Vector3(0, 0.45, 0)), rng.range(1.25, 1.65)])
  const extra = rng.int(1, 2)
  for (let i = 0; i < extra; i++) {
    const yaw = rng.range(0, Math.PI * 2)
    clumps.push([new Vector3(top.x + Math.cos(yaw) * 0.9, crownY + rng.range(1.0, 1.6), top.z + Math.sin(yaw) * 0.9), rng.range(1.2, 1.5)])
  }
  const low = crownY - 1.6
  const high = crownY + 2.4
  clumps.forEach(([c, r], i) => {
    const light = 0.72 + 0.28 * smoothstep(low, high, c.y)
    const hue = 0.94 + 0.12 * hash01(variant, i)
    a.tint(new Color(light * hue, light, light * (2 - hue)).getHex())
    a.add('leaf', leafClump(r, 400 + variant * 17 + i, rng.range(0.72, 0.88)), c.x, c.y, c.z, 0, rng.range(0, 6.28), 0)
  })
  a.tint()
}

/** 针叶树：细高的树干，自下而上逐层收小的锯齿状枝层，枝层边缘下垂 */
function buildPine(a: Assembly, variant: number): void {
  const rng = createRng(9700 + variant * 53)
  a.tile('bark', 1.2).tile('leaf', 1.6)
  const height = rng.range(7.5, 9.5)
  const trunk = [new Vector3(0, 0, 0), new Vector3(0, height * 0.5, 0), new Vector3(0, height * 0.92, 0)]
  a.addUV('bark', limb(trunk, (t) => 0.24 * (1 - 0.75 * t) + 0.08 * Math.max(0, 1 - t / 0.1), 8, 1.2))

  const tiers = rng.int(6, 7)
  const start = 1.5
  const span = height - start
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers
    const r = 2.5 * Math.pow(1 - t, 0.85) + 0.35
    const h = 2.4 * (1 - 0.45 * t)
    const y = start + span * t + h / 2
    const seed = variant * 100 + i
    const g = deform(cylinder(0.06, r, h, 14, false), (p) => {
      const radial = Math.hypot(p.x, p.z)
      if (radial < 1e-4) return
      const angle = Math.atan2(p.z, p.x)
      const k = Math.round((angle / (Math.PI * 2)) * 14 + 14) % 14
      const jag = 1 + (hash01(seed, k) - 0.5) * 0.35
      if (p.y < -h / 2 + 1e-3) {
        // 枝层下缘：锯齿 + 下垂
        p.x *= jag
        p.z *= jag
        p.y -= (k % 2) * 0.22
      }
    })
    paintVertices(g, (p, out) => {
      const k = 0.55 + 0.45 * smoothstep(-h / 2, h / 2, p.y)
      out.setRGB(k, k, k)
    })
    const light = 0.78 + 0.22 * t
    a.tint(new Color(light, light, light).getHex())
    a.add('leaf', g, 0, y, 0, 0, rng.range(0, 6.28), 0)
  }
  a.tint()
}

function broadleafSet(variant: number): GeometrySet {
  return geometrySet(`tree:broad:${variant}`, (a) => buildBroadleaf(a, variant))
}

function pineSet(variant: number): GeometrySet {
  return geometrySet(`tree:pine:${variant}`, (a) => buildPine(a, variant))
}

/**
 * 单棵树（独立网格，用于零散摆放；成片的树请用 createForest）。
 * @param rng 决定树种、大小与朝向
 */
export function generateTree(rng: Rng): Prop {
  const pine = rng.chance(0.4)
  const set = pine ? pineSet(rng.int(0, PINE_VARIANTS - 1)) : broadleafSet(rng.int(0, BROAD_VARIANTS - 1))
  const group = assemble(set, treeMaterials())
  group.scale.setScalar(rng.range(0.8, 1.4))
  group.rotation.y = rng.range(0, Math.PI * 2)
  return { group, boxes: [] }
}

export interface TreeSpot {
  x: number
  z: number
}

export interface Forest {
  group: Group
  /** 释放实例缓冲（几何体与材质属于 props-kit 缓存，由 disposeKit 释放） */
  dispose(): void
}

/**
 * 成片的树：按树种变体分组实例化。
 * @param rng 决定每个点的树种、大小、朝向与叶色
 * @param spots 树的位置（地面 y = 0）
 * @param pineShare 针叶树的比例
 */
export function createForest(rng: Rng, spots: readonly TreeSpot[], pineShare = 0.4): Forest {
  const group = new Group()
  group.name = 'forest'
  const mats = treeMaterials()

  interface Bucket {
    set: GeometrySet
    pine: boolean
    matrices: Matrix4[]
    colors: Color[]
  }
  const buckets: Bucket[] = []
  for (let v = 0; v < BROAD_VARIANTS; v++) buckets.push({ set: broadleafSet(v), pine: false, matrices: [], colors: [] })
  for (let v = 0; v < PINE_VARIANTS; v++) buckets.push({ set: pineSet(v), pine: true, matrices: [], colors: [] })

  const q = new Quaternion()
  const up = new Vector3(0, 1, 0)
  const pos = new Vector3()
  const scale = new Vector3()
  for (const spot of spots) {
    const pine = rng.chance(pineShare)
    const index = pine ? BROAD_VARIANTS + rng.int(0, PINE_VARIANTS - 1) : rng.int(0, BROAD_VARIANTS - 1)
    const bucket = buckets[index]
    const s = pine ? rng.range(0.8, 1.35) : rng.range(0.85, 1.5)
    // 高矮胖瘦略有不同
    scale.set(s * rng.range(0.9, 1.1), s * rng.range(0.92, 1.12), s * rng.range(0.9, 1.1))
    q.setFromAxisAngle(up, rng.range(0, Math.PI * 2))
    pos.set(spot.x, 0, spot.z)
    bucket.matrices.push(new Matrix4().compose(pos, q, scale))
    bucket.colors.push(new Color(rng.pick(pine ? PINE_TINTS : BROAD_TINTS)))
  }

  const meshes: InstancedMesh[] = []
  for (const bucket of buckets) {
    const count = bucket.matrices.length
    if (count === 0) continue
    for (const [slot, geometry] of Object.entries(bucket.set)) {
      const mat = mats[slot]
      if (!mat) continue
      const mesh = new InstancedMesh(geometry, mat, count)
      bucket.matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
      if (slot === 'leaf') bucket.colors.forEach((c, i) => mesh.setColorAt(i, c))
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      group.add(mesh)
      meshes.push(mesh)
    }
  }

  return {
    group,
    dispose() {
      meshes.forEach((m) => m.dispose())
      group.removeFromParent()
    },
  }
}

/** 横倒的大树（树干沿 X，根盘在 -X 端）：翘起的根盘、折断的枝杈、压扁的树冠 */
export function generateFallenTree(): Prop {
  const set = geometrySet('tree:fallen', (a) => {
    a.tile('bark', 1.2).tile('leaf', 2).tile('soil', 1)
    const trunk: Vector3[] = []
    for (let i = 0; i <= 6; i++) {
      const t = i / 6
      trunk.push(new Vector3(-4.4 + t * 9.4, 0.42 + Math.sin(t * Math.PI) * 0.12 - t * 0.1, Math.sin(t * 2.2) * 0.25))
    }
    a.addUV('bark', limb(trunk, (t) => 0.42 * (1 - 0.55 * t), 10, 1.2))
    // 根盘：一团带泥的扁平团块，几条翘起的根
    a.tint(0x6a5844)
    a.add('soil', blob(1.1, 1, 0.3, 77, 0.35, 1, 1), -4.55, 0.9, 0)
    a.tint()
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + 0.4
      const root = [
        new Vector3(-4.45, 0.5, 0),
        new Vector3(-4.7, 0.5 + Math.sin(ang) * 0.7, Math.cos(ang) * 0.7),
        new Vector3(-4.9, 0.5 + Math.sin(ang) * 1.3, Math.cos(ang) * 1.3),
      ]
      a.addUV('bark', limb(root, (t) => 0.12 * (1 - 0.7 * t), 5, 1.2, true))
    }
    // 折断与压弯的枝杈
    const limbs: [number, number, number, number][] = [
      [0.8, 0.5, 1.4, 1.2],
      [1.6, -0.6, 1.0, 1.6],
      [2.8, 0.7, 0.3, 1.8],
      [3.4, -0.5, 1.2, 1.4],
    ]
    for (const [x, dz, dy, len] of limbs) {
      const y = 0.5
      a.addUV('bark', limb([new Vector3(x, y, 0), new Vector3(x + len * 0.5, y + dy * 0.5, dz * 0.6), new Vector3(x + len, y + dy, dz)], (t) => 0.1 * (1 - 0.6 * t), 6, 1.2, true))
    }
    // 树冠：贴地压扁的几团叶子
    const crown: [number, number, number, number][] = [
      [3.8, 1.0, 0.2, 1.7],
      [5.2, 0.9, -0.5, 1.5],
      [4.6, 1.4, 1.0, 1.3],
      [2.8, 1.5, 0.8, 1.1],
    ]
    crown.forEach(([x, y, z, r], i) => {
      a.tint(i % 2 === 0 ? 0xe8f0d0 : 0xd0dcb8)
      a.add('leaf', leafClump(r, 510 + i, 0.7), x, y, z)
    })
    a.tint()
  })
  const group = assemble(set, { ...treeMaterials(), soil: surface('dirt') })
  return { group, boxes: [] }
}

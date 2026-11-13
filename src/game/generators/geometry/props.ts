/**
 * 场景道具生成器：车辆、长椅、沙袋、课桌、围栏、建筑等。全部由共享的单位几何体缩放拼成。
 * 每个生成器返回模型和本地空间的碰撞盒；世界系统负责摆放（只按 90° 的整数倍旋转，碰撞盒保持轴对齐）。
 */

import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial, SphereGeometry } from 'three'
import type { BufferGeometry } from 'three'
import type { TextureKind } from '../../core/types'
import type { Rng } from '../../utils/random'
import { getTexture } from '../textures'

/** 本地空间的碰撞盒（中心 x / z，半宽 hx / hz，顶面高度） */
export interface PropBox {
  x: number
  z: number
  hx: number
  hz: number
  height: number
  walkable: boolean
  blocksShots: boolean
}

export interface Prop {
  /** 原点在底面中心 */
  group: Group
  boxes: PropBox[]
}

type Shape = 'box' | 'cyl' | 'cone' | 'sphere'

const geometries = new Map<Shape, BufferGeometry>()
const materials = new Map<string, MeshLambertMaterial>()

/** 取共享的单位几何体（边长 / 半径 / 高度均为 1） */
function geometry(shape: Shape): BufferGeometry {
  let g = geometries.get(shape)
  if (!g) {
    if (shape === 'box') g = new BoxGeometry(1, 1, 1)
    else if (shape === 'cyl') g = new CylinderGeometry(1, 1, 1, 10)
    else if (shape === 'cone') g = new ConeGeometry(1, 1, 7)
    else g = new SphereGeometry(1, 8, 6)
    geometries.set(shape, g)
  }
  return g
}

/** 取按颜色 + 纹理缓存的材质 */
function material(color: number, texture?: TextureKind, opacity = 1): MeshLambertMaterial {
  const key = `${color}:${texture ?? ''}:${opacity}`
  let m = materials.get(key)
  if (!m) {
    m = new MeshLambertMaterial({
      color,
      map: texture ? getTexture(texture) : null,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
    })
    materials.set(key, m)
  }
  return m
}

/** 往 parent 里加一个缩放后的单位几何体。圆柱 / 圆锥的 sx、sz 是半径，sy 是高度 */
function add(
  parent: Group,
  shape: Shape,
  mat: MeshLambertMaterial,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): Mesh {
  const mesh = new Mesh(geometry(shape), mat)
  mesh.scale.set(sx, sy, sz)
  mesh.position.set(x, y, z)
  mesh.rotation.set(rx, ry, rz)
  parent.add(mesh)
  return mesh
}

/** 构造一个碰撞盒 */
function solid(x: number, z: number, hx: number, hz: number, height: number, walkable = true, blocksShots = true): PropBox {
  return { x, z, hx, hz, height, walkable, blocksShots }
}

const HALF_PI = Math.PI / 2

const TIRE = 0x1b1c1f
const GLASS = 0x1c2228
const STEEL = 0x8a98a6
const WOOD = 0xb08a5c

/** 废弃轿车（车身沿 X） */
export function generateCar(color = 0x7a2f2a): Prop {
  const group = new Group()
  const body = material(color, 'rust')
  add(group, 'box', body, 4.2, 0.8, 1.8, 0, 0.7, 0)
  add(group, 'box', body, 2.2, 0.6, 1.6, -0.2, 1.4, 0)
  add(group, 'box', material(GLASS), 2.24, 0.42, 1.5, -0.2, 1.42, 0)
  const tire = material(TIRE)
  for (const wx of [-1.35, 1.35]) {
    for (const wz of [-0.85, 0.85]) add(group, 'cyl', tire, 0.35, 0.25, 0.35, wx, 0.35, wz, HALF_PI)
  }
  return { group, boxes: [solid(0, 0, 2.1, 0.9, 1.6)] }
}

/** 半截校车（车身沿 X，+X 端是断口） */
export function generateBus(): Prop {
  const group = new Group()
  const body = material(0xe0a418, 'rust')
  add(group, 'box', body, 6, 2.3, 2.4, 0, 1.55, 0)
  add(group, 'box', material(GLASS), 5.4, 0.7, 2.44, -0.2, 2.05, 0)
  add(group, 'box', material(0x2a2c30), 6.02, 0.25, 2.42, 0, 0.75, 0)
  const tire = material(TIRE)
  for (const wx of [-1.9, 1.6]) {
    for (const wz of [-1.1, 1.1]) add(group, 'cyl', tire, 0.5, 0.3, 0.5, wx, 0.5, wz, HALF_PI)
  }
  // 断口处翻卷的铁皮
  const torn = material(0x5a3a22, 'rust')
  add(group, 'box', torn, 0.9, 1.1, 0.08, 3.3, 1.3, 1.1, 0, 0.5, 0.2)
  add(group, 'box', torn, 0.7, 0.9, 0.08, 3.2, 2.1, -1.0, 0, -0.6, -0.3)
  add(group, 'box', torn, 1.1, 0.08, 1.2, 3.4, 0.5, 0.1, 0.1, 0, 0.3)
  return { group, boxes: [solid(0, 0, 3.1, 1.25, 2.7, false)] }
}

/** 翻倒的长椅（沿 X） */
export function generateBench(): Prop {
  const group = new Group()
  const wood = material(WOOD, 'wood')
  add(group, 'box', wood, 1.8, 0.45, 0.08, 0, 0.3, 0.12, 0.25)
  add(group, 'box', wood, 1.8, 0.4, 0.08, 0, 0.42, -0.2, -1.1)
  const steel = material(0x3c4046)
  add(group, 'box', steel, 0.06, 0.5, 0.5, -0.8, 0.28, -0.05, 0.3)
  add(group, 'box', steel, 0.06, 0.5, 0.5, 0.8, 0.28, -0.05, 0.3)
  return { group, boxes: [solid(0, 0, 0.95, 0.35, 0.65)] }
}

/**
 * 沙袋墙（沿 X）。
 * @param length 每层沙袋数
 * @param layers 层数
 */
export function generateSandbags(length = 4, layers = 3): Prop {
  const group = new Group()
  const bag = material(0xb8a47a, 'cloth')
  for (let layer = 0; layer < layers; layer++) {
    const count = layer % 2 === 0 ? length : length - 1
    for (let i = 0; i < count; i++) {
      add(group, 'sphere', bag, 0.44, 0.17, 0.3, (i - (count - 1) / 2) * 0.8, 0.17 + layer * 0.3, 0)
    }
  }
  return { group, boxes: [solid(0, 0, length * 0.4 + 0.1, 0.34, layers * 0.3 + 0.05)] }
}

/**
 * 足球门（球门线沿 Z，门口朝 +X）。
 * @param fallen 是否翻倒（向 +X 方向扣在地上，作为掩体）
 */
export function generateGoal(fallen = false): Prop {
  const group = new Group()
  const frame = new Group()
  const white = material(0xf0f0f0)
  add(frame, 'cyl', white, 0.06, 2.44, 0.06, 0, 1.22, -3.66)
  add(frame, 'cyl', white, 0.06, 2.44, 0.06, 0, 1.22, 3.66)
  add(frame, 'cyl', white, 0.06, 7.32, 0.06, 0, 2.44, 0, HALF_PI)
  add(frame, 'cyl', white, 0.04, 7.32, 0.04, -1.6, 0.05, 0, HALF_PI)
  for (const z of [-3.66, 3.66]) {
    add(frame, 'cyl', white, 0.04, 1.6, 0.04, -0.8, 0.05, z, 0, 0, HALF_PI)
    add(frame, 'cyl', white, 0.04, 2.9, 0.04, -0.8, 1.22, z, 0, 0, -0.58)
  }
  // 球网：半透明薄板
  add(frame, 'box', material(0xffffff, undefined, 0.18), 0.02, 2.5, 7.3, -0.85, 1.2, 0, 0, 0, -0.58)
  group.add(frame)
  if (!fallen) return { group, boxes: [] }
  frame.rotation.z = -HALF_PI
  frame.position.set(0, 0.08, 0)
  return { group, boxes: [solid(1.2, 0, 1.3, 3.7, 0.9, true, false)] }
}

/** 金属储物箱 */
export function generateLocker(): Prop {
  const group = new Group()
  add(group, 'box', material(STEEL, 'metal'), 1.2, 1.8, 0.6, 0, 0.9, 0)
  const seam = material(0x2c3036)
  add(group, 'box', seam, 0.02, 1.7, 0.02, 0, 0.9, 0.31)
  add(group, 'box', seam, 0.08, 0.2, 0.03, 0.12, 1.0, 0.31)
  return { group, boxes: [solid(0, 0, 0.6, 0.3, 1.8, false)] }
}

/** 轮胎堆 */
export function generateTires(): Prop {
  const group = new Group()
  const tire = material(TIRE)
  for (let i = 0; i < 3; i++) add(group, 'cyl', tire, 0.42, 0.25, 0.42, -0.38, 0.125 + i * 0.25, 0)
  for (let i = 0; i < 2; i++) add(group, 'cyl', tire, 0.42, 0.25, 0.42, 0.42, 0.125 + i * 0.25, 0.08)
  add(group, 'cyl', tire, 0.42, 0.25, 0.42, 0.5, 0.42, 0.5, 1.1)
  return { group, boxes: [solid(0, 0.1, 0.85, 0.6, 0.75)] }
}

/**
 * 堆叠的课桌（沿 X）。
 * @param count 每层课桌数
 * @param layers 层数
 */
export function generateDeskPile(count = 3, layers = 2): Prop {
  const group = new Group()
  const top = material(0xc9a36a, 'wood')
  const leg = material(0x4a4e55)
  for (let layer = 0; layer < layers; layer++) {
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * 1.25 + (layer % 2) * 0.3
      const y = layer * 0.76
      add(group, 'box', top, 1.2, 0.05, 0.6, x, y + 0.73, 0)
      add(group, 'box', leg, 0.04, 0.7, 0.55, x - 0.55, y + 0.36, 0)
      add(group, 'box', leg, 0.04, 0.7, 0.55, x + 0.55, y + 0.36, 0)
    }
  }
  return { group, boxes: [solid(0.15, 0, count * 0.625 + 0.2, 0.34, layers * 0.76, layers <= 2)] }
}

/** 临时路障：木板 + 铁丝网（沿 X） */
export function generateBarrier(): Prop {
  const group = new Group()
  const wood = material(WOOD, 'wood')
  add(group, 'box', wood, 2.5, 0.16, 0.06, 0, 0.62, 0, 0, 0, 0.42)
  add(group, 'box', wood, 2.5, 0.16, 0.06, 0, 0.62, 0.04, 0, 0, -0.42)
  add(group, 'box', wood, 0.12, 1.25, 0.12, -1.15, 0.62, 0)
  add(group, 'box', wood, 0.12, 1.25, 0.12, 1.15, 0.62, 0)
  const wire = material(0x30343a)
  for (const y of [0.35, 0.7, 1.05]) add(group, 'box', wire, 2.3, 0.025, 0.025, 0, y, -0.05)
  return { group, boxes: [solid(0, 0, 1.25, 0.2, 1.25, false, false)] }
}

/** 翻倒的垃圾桶 */
export function generateTrashBin(): Prop {
  const group = new Group()
  const bin = material(0x3a6a4a, 'rust')
  add(group, 'cyl', bin, 0.36, 0.95, 0.36, 0, 0.36, 0, 0, 0, HALF_PI)
  add(group, 'cyl', material(0x2a2c30), 0.38, 0.06, 0.38, 0.75, 0.04, 0.3)
  return { group, boxes: [solid(0, 0, 0.5, 0.38, 0.72)] }
}

/** 移动公告板 */
export function generateBillboard(): Prop {
  const group = new Group()
  const post = material(0x50545a)
  add(group, 'cyl', post, 0.06, 2.6, 0.06, -1.3, 1.3, 0)
  add(group, 'cyl', post, 0.06, 2.6, 0.06, 1.3, 1.3, 0)
  add(group, 'box', material(0xe8e4d8), 3, 1.6, 0.08, 0, 2.1, 0)
  add(group, 'box', material(0xb03a2e), 2.6, 0.3, 0.1, 0, 2.6, 0)
  add(group, 'box', material(0x3a4250), 1.6, 0.12, 0.1, -0.4, 2.1, 0)
  add(group, 'box', material(0x3a4250), 2.0, 0.12, 0.1, -0.2, 1.8, 0)
  return { group, boxes: [] }
}

/**
 * 路灯。
 * @param tilt 倾斜角（弧度）
 */
export function generateLampPost(tilt = 0): Prop {
  const group = new Group()
  const inner = new Group()
  const steel = material(0x5a5e66, 'metal')
  add(inner, 'cyl', steel, 0.09, 6, 0.09, 0, 3, 0)
  add(inner, 'box', steel, 1.2, 0.08, 0.08, 0.6, 6, 0)
  add(inner, 'box', material(0xf2e8c0), 0.5, 0.12, 0.26, 1.1, 5.9, 0)
  inner.rotation.z = tilt
  group.add(inner)
  return { group, boxes: [] }
}

/**
 * 低多边形树。
 * @param rng 决定大小与颜色
 */
export function generateTree(rng: Rng): Prop {
  const group = new Group()
  const leaves = material(rng.pick([0x2f6b34, 0x3a7a3c, 0x285c30]))
  add(group, 'cyl', material(0x5a4030, 'wood'), 0.25, 2.2, 0.25, 0, 1.1, 0)
  add(group, 'cone', leaves, 2.2, 3.6, 2.2, 0, 3.7, 0)
  add(group, 'cone', leaves, 1.6, 2.8, 1.6, 0, 5.5, 0)
  add(group, 'cone', leaves, 1.0, 2.0, 1.0, 0, 6.9, 0)
  group.scale.setScalar(rng.range(0.8, 1.6))
  group.rotation.y = rng.range(0, Math.PI * 2)
  return { group, boxes: [] }
}

/** 横倒的大树（树干沿 X） */
export function generateFallenTree(): Prop {
  const group = new Group()
  add(group, 'cyl', material(0x5a4030, 'wood'), 0.38, 9, 0.38, 0, 0.4, 0, 0, 0, HALF_PI)
  const leaves = material(0x2f6b34)
  add(group, 'cone', leaves, 1.6, 3.4, 1.6, 4.4, 0.9, 0, 0, 0, -HALF_PI)
  add(group, 'cone', leaves, 1.2, 2.6, 1.2, 6.4, 0.8, 0.2, 0, 0, -HALF_PI)
  add(group, 'cyl', material(0x4a3426, 'wood'), 0.12, 2.2, 0.12, 1.5, 1.1, 0.4, 0.5, 0, 0.3)
  return { group, boxes: [] }
}

/**
 * 一段铁丝网围栏（沿 X）。
 * @param length 长度（米）
 */
export function generateFence(length = 4): Prop {
  const group = new Group()
  const post = material(0x6a6e74, 'metal')
  add(group, 'cyl', post, 0.05, 2.2, 0.05, -length / 2, 1.1, 0)
  add(group, 'cyl', post, 0.05, 2.2, 0.05, length / 2, 1.1, 0)
  add(group, 'box', post, length, 0.05, 0.05, 0, 2.15, 0)
  add(group, 'box', post, length, 0.05, 0.05, 0, 0.25, 0)
  add(group, 'box', material(0x9aa0a6, undefined, 0.3), length, 1.9, 0.02, 0, 1.2, 0)
  return { group, boxes: [] }
}

/**
 * 一段围墙（沿 X）。
 * @param length 长度（米）
 * @param height 高度（米）
 */
export function generateWall(length = 8, height = 2.6): Prop {
  const group = new Group()
  add(group, 'box', material(0xb8b2a4, 'concrete'), length, height, 0.4, 0, height / 2, 0)
  add(group, 'box', material(0x6a6458), length + 0.1, 0.15, 0.5, 0, height + 0.07, 0)
  return { group, boxes: [] }
}

/** 已封锁的校门（沿 X）：门柱 + 铁门 + 红色交叉封条 */
export function generateGate(): Prop {
  const group = new Group()
  const pillar = material(0x8a8478, 'concrete')
  add(group, 'box', pillar, 0.8, 3.4, 0.8, -3.2, 1.7, 0)
  add(group, 'box', pillar, 0.8, 3.4, 0.8, 3.2, 1.7, 0)
  const bar = material(0x3a3e44, 'metal')
  for (let i = -5; i <= 5; i++) add(group, 'box', bar, 0.06, 2.6, 0.06, i * 0.5, 1.3, 0)
  add(group, 'box', bar, 5.6, 0.08, 0.08, 0, 2.6, 0)
  add(group, 'box', bar, 5.6, 0.08, 0.08, 0, 0.3, 0)
  const tape = material(0xc0281e)
  add(group, 'box', tape, 6.2, 0.22, 0.05, 0, 1.4, -0.12, 0, 0, 0.42)
  add(group, 'box', tape, 6.2, 0.22, 0.05, 0, 1.4, -0.14, 0, 0, -0.42)
  return { group, boxes: [] }
}

/**
 * 远景建筑：主体 + 朝 ±X 两面的窗带 + 屋顶。
 * @param width X 方向尺寸
 * @param height 高度
 * @param depth Z 方向尺寸
 * @param color 墙面颜色
 */
export function generateBuilding(width: number, height: number, depth: number, color: number): Prop {
  const group = new Group()
  add(group, 'box', material(color, 'concrete'), width, height, depth, 0, height / 2, 0)
  add(group, 'box', material(0x5a564e), width + 1, 0.5, depth + 1, 0, height + 0.25, 0)
  const glass = material(0x2a3a4a)
  for (let y = 2.6; y < height - 1.2; y += 3.4) {
    add(group, 'box', glass, 0.1, 1.4, depth * 0.9, width / 2 + 0.03, y, 0)
    add(group, 'box', glass, 0.1, 1.4, depth * 0.9, -width / 2 - 0.03, y, 0)
  }
  return { group, boxes: [] }
}

/** 看台残骸：几块歪斜的金属台阶板 */
export function generateBleacherWreck(): Prop {
  const group = new Group()
  const steel = material(0x7a7e84, 'rust')
  add(group, 'box', steel, 3.6, 0.12, 0.9, 0, 0.5, -0.4, 0.35, 0.1, 0.05)
  add(group, 'box', steel, 3.4, 0.12, 0.9, 0.2, 0.85, 0.3, -0.5, -0.08, 0.1)
  add(group, 'box', steel, 0.1, 1.1, 0.1, -1.5, 0.5, 0, 0, 0, 0.3)
  add(group, 'box', steel, 0.1, 1.2, 0.1, 1.5, 0.55, 0.2, 0.2)
  return { group, boxes: [solid(0, 0, 1.9, 0.9, 1.05)] }
}

/** 释放全部共享几何体与材质（世界系统销毁时调用；之后再调用生成器会重新创建） */
export function disposeProps(): void {
  geometries.forEach((g) => g.dispose())
  geometries.clear()
  materials.forEach((m) => m.dispose())
  materials.clear()
}

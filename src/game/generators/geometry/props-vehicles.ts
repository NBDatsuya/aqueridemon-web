/**
 * 场景车辆：废弃轿车（三厢 / 两厢）与半截校车。
 * 车身用侧面轮廓拉伸（带倒角和轮拱），车窗是深色玻璃，轮胎轮毂用 props-kit 的车削模型。
 * 同一种车型 + 颜色 + 损坏状态只拼装一次几何体，所有实例共享。
 */

import type { Material } from 'three'
import {
  addWheel,
  assemble,
  bevelBox,
  extrude,
  geometrySet,
  glass,
  lens,
  solid,
  surface,
} from './props-kit'
import type { Assembly, Prop } from './props-kit'

/** 轿车车型：sedan 三厢、hatch 两厢 */
export type CarStyle = 'sedan' | 'hatch'

export interface CarOptions {
  /** 车型，默认 sedan */
  style?: CarStyle
  /** 左前轮瘪胎（车身随之倾斜），默认 false */
  flat?: boolean
}

type Outline = [number, number][]

/** 轿车轮心到车身中点的距离（米） */
const CAR_AXLE = 1.33
const CAR_WHEEL_R = 0.34
const CAR_WHEEL_W = 0.22
/** 瘪胎的下沉量（米） */
const FLAT_DROP = 0.1

/** 车辆共用材质（按槽位） */
function vehicleMaterials(): Record<string, Material> {
  return {
    body: surface('paintedMetal', { roughness: 0.5 }),
    trim: surface('polymer', { roughness: 0.8 }),
    tire: surface('rubber'),
    rim: surface('steel', { roughness: 0.45 }),
    glass: glass(),
    lens: lens(),
    rust: surface('rust'),
    interior: surface('polymer', { roughness: 1 }, 'interior'),
  }
}

/** 在轮廓的底边上挖出一个轮拱（从后往前走） */
function arch(pts: Outline, cx: number, r: number): void {
  pts.push([cx - r - 0.06, 0.3])
  for (let i = 0; i <= 8; i++) {
    const t = Math.PI - (i / 8) * Math.PI
    pts.push([cx + Math.cos(t) * r, 0.36 + Math.sin(t) * r * 0.95])
  }
  pts.push([cx + r + 0.06, 0.3])
}

/** 下车身侧面轮廓（XY 平面，+X 为车头） */
function lowerOutline(style: CarStyle): Outline {
  const pts: Outline = []
  pts.push([style === 'hatch' ? -1.92 : -2.08, 0.34])
  arch(pts, -CAR_AXLE, 0.42)
  arch(pts, CAR_AXLE, 0.42)
  pts.push([1.86, 0.3], [2.06, 0.36], [2.1, 0.55], [2.07, 0.74], [1.95, 0.86], [1.4, 0.94], [0.72, 0.99])
  if (style === 'sedan') pts.push([-1.42, 1.0], [-1.94, 0.96], [-2.08, 0.84], [-2.12, 0.6])
  else pts.push([-1.7, 1.0], [-1.9, 0.94], [-1.95, 0.6])
  return pts
}

/** 车厢（玻璃罩）侧面轮廓 */
function cabinOutline(style: CarStyle): Outline {
  return style === 'sedan'
    ? [
        [0.74, 0.96],
        [0.0, 1.4],
        [-0.95, 1.42],
        [-1.48, 0.98],
      ]
    : [
        [0.74, 0.96],
        [0.0, 1.42],
        [-1.45, 1.4],
        [-1.86, 0.97],
      ]
}

function buildCar(a: Assembly, color: number, style: CarStyle, flat: boolean): void {
  a.tile('body', 1.6).tile('trim', 0.8).tile('rust', 1)
  a.grime('body', 0.7, 0.6)

  // 瘪胎一侧下沉：车身绕 X 轴、Z 轴各歪一点
  if (flat) a.pose(0, -FLAT_DROP * 0.5, 0, -0.045, 0, -0.02)

  a.tint(color)
  a.add('body', extrude(lowerOutline(style), 1.76, 0.07))
  const roofStart = style === 'sedan' ? -0.95 : -1.45
  a.add('body', bevelBox(-roofStart + 0.02, 0.05, 1.52, 0.02), roofStart / 2, 1.43, 0)
  // A / B / C 柱
  const bx = style === 'sedan' ? -0.45 : -0.52
  const rear = style === 'sedan' ? [-1.48, -0.95] : [-1.86, -1.45]
  for (const z of [-0.74, 0.74]) {
    a.rod('body', 0.74, 0.98, z, 0.0, 1.41, z, 0.045, 6)
    a.rod('body', bx, 0.99, z, bx, 1.42, z, 0.05, 6)
    a.rod('body', rear[0], 0.99, z, rear[1], 1.41, z, 0.06, 6)
  }

  a.tint()
  a.add('glass', extrude(cabinOutline(style), 1.5, 0.05))

  // 保险杠、格栅、后视镜、门把手、车牌
  const tail = style === 'sedan' ? -2.1 : -1.95
  a.tint(0x1d1e21)
  a.add('trim', bevelBox(0.16, 0.22, 1.8, 0.05), 2.08, 0.42, 0)
  a.add('trim', bevelBox(0.16, 0.22, 1.8, 0.05), tail, 0.45, 0)
  a.add('trim', bevelBox(0.05, 0.16, 0.9, 0.02), 2.09, 0.66, 0)
  a.add('trim', bevelBox(3.4, 0.08, 0.04, 0.015), 0, 0.36, 0.89)
  a.add('trim', bevelBox(3.4, 0.08, 0.04, 0.015), 0, 0.36, -0.89)
  for (const s of [-1, 1]) {
    a.add('trim', bevelBox(0.12, 0.1, 0.18, 0.03), 0.62, 1.04, s * 1.0)
    a.rod('trim', 0.66, 0.98, s * 0.86, 0.62, 1.02, s * 0.93, 0.018, 4)
    for (const hx of [0.15, -0.75]) a.add('trim', bevelBox(0.14, 0.03, 0.03, 0.01), hx, 0.86, s * 0.885)
  }
  a.tint(0xd8d6cc)
  a.add('trim', bevelBox(0.02, 0.11, 0.36, 0.005), 2.17, 0.42, 0)
  a.add('trim', bevelBox(0.02, 0.11, 0.36, 0.005), tail - 0.09, 0.47, 0)

  // 车灯
  a.tint(0xfff4dc)
  for (const s of [-1, 1]) a.add('lens', bevelBox(0.08, 0.12, 0.34, 0.03), 2.05, 0.71, s * 0.6)
  a.tint(0x9a0c0c)
  const tailY = style === 'sedan' ? 0.76 : 0.8
  for (const s of [-1, 1]) a.add('lens', bevelBox(0.06, 0.12, 0.3, 0.03), tail + 0.03, tailY, s * 0.63)

  // 车轮（不跟随车身倾斜）
  a.pose()
  a.tint(0xb4b8bc)
  for (const x of [-CAR_AXLE, CAR_AXLE]) {
    for (const s of [-1, 1] as const) {
      const drop = flat && x > 0 && s > 0 ? FLAT_DROP : 0
      addWheel(a, 'tire', 'rim', x, s * 0.77, CAR_WHEEL_R, CAR_WHEEL_W, s, drop, 18)
    }
  }
  a.tint()
}

/**
 * 废弃轿车（车身沿 X，车头朝 +X）。
 * @param color 车漆颜色
 */
export function generateCar(color = 0x7a2f2a, options: CarOptions = {}): Prop {
  const style = options.style ?? 'sedan'
  const flat = options.flat ?? false
  const set = geometrySet(`car:${style}:${color}:${flat}`, (a) => buildCar(a, color, style, flat))
  const group = assemble(set, vehicleMaterials())
  return { group, boxes: [solid(0, 0, 2.1, 0.9, 1.6)] }
}

function buildBus(a: Assembly): void {
  a.tile('body', 2).tile('trim', 1).tile('rust', 1).tile('interior', 1)
  a.grime('body', 1.2, 0.55)

  const yellow = 0xe0a418
  a.tint(yellow)
  // 车身：-3.0 .. 2.6，底边 0.75，顶面 2.65
  a.add('body', bevelBox(5.6, 1.9, 2.4, 0.12), -0.2, 1.7, 0)
  a.add('body', bevelBox(5.5, 0.1, 2.3, 0.05), -0.2, 2.68, 0)

  // 黑色窗带 + 侧窗（右侧 +Z 前部留出车门）
  a.tint(0x17181a)
  for (const s of [-1, 1]) {
    a.add('trim', bevelBox(5.0, 0.8, 0.02, 0.008), -0.2, 2.08, s * 1.212)
    a.add('trim', bevelBox(5.6, 0.08, 0.03, 0.01), -0.2, 1.38, s * 1.21)
    a.add('trim', bevelBox(5.6, 0.08, 0.03, 0.01), -0.2, 1.62, s * 1.21)
  }
  a.add('trim', bevelBox(0.2, 0.3, 2.5, 0.06), -3.04, 0.86, 0)
  a.add('trim', bevelBox(0.02, 0.24, 1.4, 0.01), -3.02, 2.52, 0)
  a.add('trim', bevelBox(0.82, 1.7, 0.02, 0.01), -2.5, 1.55, 1.21)

  a.tint()
  for (const s of [-1, 1]) {
    // 玻璃外表面比窗带外表面高出 2 cm，远处深度精度不够时也不会互相穿插闪烁
    for (let x = -1.9; x < 2.3; x += 0.82) a.add('glass', bevelBox(0.7, 0.62, 0.02, 0.006), x, 2.1, s * 1.232)
    if (s < 0) a.add('glass', bevelBox(0.7, 0.62, 0.02, 0.006), -2.5, 2.1, -1.232)
  }
  a.add('glass', bevelBox(0.7, 1.5, 0.02, 0.006), -2.5, 1.6, 1.242)
  a.add('glass', bevelBox(0.02, 0.8, 2.1, 0.006), -3.012, 1.98, 0)

  // 车灯与顶部警示灯
  a.tint(0xfff4dc)
  for (const s of [-1, 1]) a.add('lens', bevelBox(0.04, 0.16, 0.26, 0.02), -3.01, 1.12, s * 0.85)
  a.tint(0xd04a10)
  for (const s of [-1, 1]) a.add('lens', bevelBox(0.06, 0.12, 0.18, 0.02), -3.01, 2.55, s * 0.98)

  // 断口：车厢内部的暗面、几排座椅、翻卷的车壳与铁皮
  a.tint(0x141414)
  a.add('interior', bevelBox(0.02, 1.8, 2.3, 0.005), 2.612, 1.7, 0)
  a.tint(0x3a4a62)
  for (const s of [-1, 1]) {
    a.add('interior', bevelBox(0.12, 0.6, 0.9, 0.04), 2.9, 1.35, s * 0.62)
    a.add('interior', bevelBox(0.45, 0.12, 0.9, 0.04), 2.72, 1.05, s * 0.62)
  }
  a.tint(yellow)
  a.add('body', bevelBox(0.5, 0.05, 2.36, 0.02), 2.82, 2.6, 0, 0, 0, -0.18)
  for (const s of [-1, 1]) a.add('body', bevelBox(0.45, 1.7, 0.04, 0.015), 2.8, 1.65, s * 1.2, 0, s * 0.28, 0)
  a.tint(0x2a2622)
  a.add('trim', bevelBox(0.5, 0.06, 2.3, 0.02), 2.83, 0.82, 0)
  a.tint()
  a.add('rust', bevelBox(0.9, 1.1, 0.04, 0.01), 3.0, 1.3, 1.12, 0, 0.5, 0.2)
  a.add('rust', bevelBox(0.7, 0.9, 0.04, 0.01), 2.95, 2.1, -1.02, 0, -0.6, -0.3)
  a.add('rust', bevelBox(1.0, 0.04, 1.2, 0.01), 2.95, 0.55, 0.1, 0.1, 0, 0.3)

  // 车轮：前轮完好，后轮一只瘪胎
  a.tint(0x9a9ea2)
  addWheel(a, 'tire', 'rim', -2.0, 1.02, 0.5, 0.3, 1, 0, 20)
  addWheel(a, 'tire', 'rim', -2.0, -1.02, 0.5, 0.3, -1, 0, 20)
  addWheel(a, 'tire', 'rim', 1.6, 1.02, 0.5, 0.3, 1, 0.12, 20)
  addWheel(a, 'tire', 'rim', 1.6, -1.02, 0.5, 0.3, -1, 0, 20)
  a.tint()
}

/** 半截校车（车身沿 X，+X 端是断口） */
export function generateBus(): Prop {
  const set = geometrySet('bus', buildBus)
  const group = assemble(set, vehicleMaterials(), ['glass'])
  return { group, boxes: [solid(0, 0, 3.1, 1.25, 2.7, false)] }
}

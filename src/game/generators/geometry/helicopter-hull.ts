/**
 * 直升机机身：由若干超椭圆截面放样出的连续蒙皮（机鼻 → 座舱 → 客舱 → 尾梁），
 * 在网格上按格挖出风挡、侧窗、舱门洞口，并生成内衬、洞口侧壁、玻璃、隔板、蒙皮细节贴花层。
 * 另外还有舱门（独立的一块弧形板）与机背上的发动机整流罩。
 *
 * 截面参数 θ：以 +X 水平方向为 0、向上为正；-PI/2 是机腹中线，PI/2 是机背中线，PI 是 -X 侧腰线。
 * 所有坐标在机体系（见 helicopter-layout.ts）。
 */

import { Vector3 } from 'three'
import { createCurve } from './helicopter-airdrop-kit'
import type { MeshBuilder, Vec3 } from './helicopter-airdrop-kit'
import {
  CABIN_Z,
  DOOR_SLIDE,
  DOOR_TOP_Y,
  DOOR_Z0,
  DOOR_Z1,
  FLOOR_Y,
  RAIL_BOTTOM,
  RAIL_TOP,
  ROTOR_Y,
  TINT,
  WAIST_Y,
  WALL,
  WINDOW_LOW_Y,
  WINDOW_TOP_Y,
  Z_NOSE,
  Z_TAIL,
} from './helicopter-layout'
import type { HeliBuilders } from './helicopter-layout'

const HALF_PI = Math.PI / 2
const TAU = Math.PI * 2

/* ── 机身截面 ── */

/**
 * 控制截面：[z, 半宽, 上缘 y, 下缘 y, 超椭圆指数]。指数 2 为椭圆，越大越方。
 * 客舱段（z = -2.0 .. 1.6）保持等截面，舱门才能贴着机身直线滑动。
 */
const STATIONS: readonly (readonly [number, number, number, number, number])[] = [
  [Z_TAIL, 0.015, 0.875, 0.845, 2],
  [-8.9, 0.1, 0.96, 0.76, 2],
  [-8.7, 0.19, 1.045, 0.665, 2],
  [-5.4, 0.34, 0.92, 0.2, 2],
  [-4.8, 0.43, 0.97, 0.02, 2.15],
  [-4.1, 0.62, 1.05, -0.32, 2.4],
  [-3.4, 0.9, 1.13, -0.72, 2.8],
  [-2.7, 1.14, 1.185, -1.02, 3.2],
  [-2, 1.25, 1.2, -1.18, 3.4],
  [1.6, 1.25, 1.2, -1.18, 3.4],
  [2.3, 1.215, 1.16, -1.17, 3.2],
  [2.9, 1.13, 1.02, -1.15, 3],
  [3.4, 0.99, 0.72, -1.1, 2.8],
  [3.85, 0.8, 0.34, -1.02, 2.5],
  [4.2, 0.55, 0.08, -0.86, 2.3],
  [4.42, 0.28, -0.14, -0.66, 2.1],
  [4.48, 0.15, -0.27, -0.53, 2],
  [Z_NOSE, 0.02, -0.38, -0.42, 2],
]

const stationZ = STATIONS.map((s) => s[0])
/** 机身半宽随 z 的变化 */
export const hullHalfWidth = createCurve(stationZ, STATIONS.map((s) => s[1]))
/** 机背中线高度随 z 的变化 */
export const hullTop = createCurve(stationZ, STATIONS.map((s) => s[2]))
/** 机腹中线高度随 z 的变化 */
export const hullBottom = createCurve(stationZ, STATIONS.map((s) => s[3]))
const hullSquareness = createCurve(stationZ, STATIONS.map((s) => s[4]))

/**
 * 机身蒙皮上的一点。
 * @param z 纵向位置
 * @param theta 截面参数（见文件头）
 */
export function hullPoint(z: number, theta: number, out: Vector3): Vector3 {
  const top = hullTop(z)
  const bottom = hullBottom(z)
  const e = 2 / hullSquareness(z)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return out.set(
    hullHalfWidth(z) * Math.sign(c) * Math.pow(Math.abs(c), e),
    (top + bottom) / 2 + ((top - bottom) / 2) * Math.sign(s) * Math.pow(Math.abs(s), e),
    z,
  )
}

/**
 * +X 侧蒙皮上高度为 y 的点对应的截面参数（-PI/2 .. PI/2）。-X 侧取 PI 减去这个值。
 */
export function thetaAtHeight(z: number, y: number): number {
  const top = hullTop(z)
  const bottom = hullBottom(z)
  const r = Math.min(1, Math.max(-1, (y - (top + bottom) / 2) / ((top - bottom) / 2)))
  return Math.asin(Math.sign(r) * Math.pow(Math.abs(r), hullSquareness(z) / 2))
}

const scratchA = new Vector3()
const scratchB = new Vector3()
const scratchC = new Vector3()
const scratchD = new Vector3()

/** 参数曲面在 (z, theta) 处的外法线（数值差分） */
function surfaceNormal(point: LoftPoint, z: number, theta: number, out: Vector3): Vector3 {
  const d = 1e-3
  point(z, theta + d, scratchA)
  point(z, theta - d, scratchB)
  scratchA.sub(scratchB)
  point(z + d, theta, scratchB)
  point(z - d, theta, scratchC)
  scratchB.sub(scratchC)
  out.crossVectors(scratchA, scratchB)
  if (out.lengthSq() < 1e-16) return out.set(0, 1, 0)
  return out.normalize()
}

/**
 * 蒙皮沿法线偏移 offset 后的点（正值向外）。用来把零件贴到机身表面或内衬上。
 * @returns [x, y, z]
 */
export function hullSurface(z: number, theta: number, offset = 0): [number, number, number] {
  hullPoint(z, theta, scratchD)
  if (offset !== 0) {
    const n = surfaceNormal(hullPoint, z, theta, new Vector3())
    scratchD.addScaledVector(n, offset)
  }
  return [scratchD.x, scratchD.y, scratchD.z]
}

/** 蒙皮在 (z, theta) 处的外法线 */
export function hullNormal(z: number, theta: number): [number, number, number] {
  const n = surfaceNormal(hullPoint, z, theta, new Vector3())
  return [n.x, n.y, n.z]
}

/* ── 截面弧长（贴花图集的纵坐标） ── */

const ARC_SAMPLES = 720
const arcTables = new Map<number, Float64Array>()

/** z 处截面从机腹中线起、沿 θ 增大方向的累计弧长表 */
function arcTable(z: number): Float64Array {
  const key = Math.round(z * 1e4)
  let table = arcTables.get(key)
  if (!table) {
    table = new Float64Array(ARC_SAMPLES + 1)
    hullPoint(z, -HALF_PI, scratchA)
    for (let k = 1; k <= ARC_SAMPLES; k++) {
      hullPoint(z, -HALF_PI + (k / ARC_SAMPLES) * TAU, scratchB)
      table[k] = table[k - 1] + Math.hypot(scratchB.x - scratchA.x, scratchB.y - scratchA.y)
      scratchA.copy(scratchB)
    }
    arcTables.set(key, table)
  }
  return table
}

/** z 处截面的周长（米） */
export function hullPerimeter(z: number): number {
  return arcTable(z)[ARC_SAMPLES]
}

/** 贴花图集横坐标：尾尖为 0，机头尖为 1 */
export function atlasU(z: number): number {
  return (z - Z_TAIL) / (Z_NOSE - Z_TAIL)
}

/**
 * 贴花图集纵坐标：截面弧长占周长的比例。机腹中线为 0，经 +X 侧到机背中线为 0.5，再经 -X 侧回到机腹为 1。
 * @param theta 截面参数，-PI/2 .. 3PI/2
 */
export function atlasV(z: number, theta: number): number {
  const table = arcTable(z)
  const t = Math.min(ARC_SAMPLES, Math.max(0, ((theta + HALF_PI) / TAU) * ARC_SAMPLES))
  const k = Math.min(ARC_SAMPLES - 1, Math.floor(t))
  return (table[k] + (table[k + 1] - table[k]) * (t - k)) / table[ARC_SAMPLES]
}

/* ── 放样网格 ── */

/** 参数曲面：给定 (z, theta) 返回空间点 */
export type LoftPoint = (z: number, theta: number, out: Vector3) => Vector3

/** 在 (z, theta) 网格上采样好的曲面 */
export interface LoftGrid {
  zs: readonly number[]
  thetas: readonly number[]
  nz: number
  nt: number
  /** 顶点位置，按 [i * nt + j] * 3 排列 */
  pos: Float64Array
  /** 顶点外法线 */
  nor: Float64Array
  /** 沿截面折线的累计长度（平铺贴图的 v） */
  arc: Float64Array
}

/** 网格上的一块矩形：格子 i ∈ [i0, i1)、j ∈ [j0, j1) */
export interface CellRect {
  i0: number
  i1: number
  j0: number
  j1: number
}

/** 顶点 (i, j) 的贴图坐标 */
export type LoftUv = (i: number, j: number) => readonly [number, number]

/**
 * 在网格上采样一个参数曲面。
 * @param point 曲面函数
 * @param zs 纵向采样位置（递增）
 * @param thetas 截面参数采样位置（递增）
 */
export function createLoftGrid(point: LoftPoint, zs: readonly number[], thetas: readonly number[]): LoftGrid {
  const nz = zs.length
  const nt = thetas.length
  const pos = new Float64Array(nz * nt * 3)
  const nor = new Float64Array(nz * nt * 3)
  const arc = new Float64Array(nz * nt)
  const p = new Vector3()
  const n = new Vector3()
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nt; j++) {
      const o = (i * nt + j) * 3
      point(zs[i], thetas[j], p)
      surfaceNormal(point, zs[i], thetas[j], n)
      pos[o] = p.x
      pos[o + 1] = p.y
      pos[o + 2] = p.z
      nor[o] = n.x
      nor[o + 1] = n.y
      nor[o + 2] = n.z
      if (j > 0) {
        arc[i * nt + j] = arc[i * nt + j - 1] + Math.hypot(p.x - pos[o - 3], p.y - pos[o - 2], p.z - pos[o - 1])
      }
    }
  }
  return { zs, thetas, nz, nt, pos, nor, arc }
}

/** 网格顶点沿法线偏移后的位置 */
function gridPoint(grid: LoftGrid, i: number, j: number, offset: number): Vec3 {
  const o = (i * grid.nt + j) * 3
  return [grid.pos[o] + grid.nor[o] * offset, grid.pos[o + 1] + grid.nor[o + 1] * offset, grid.pos[o + 2] + grid.nor[o + 2] * offset]
}

function inHoles(holes: readonly CellRect[], i: number, j: number): boolean {
  for (const h of holes) {
    if (i >= h.i0 && i < h.i1 && j >= h.j0 && j < h.j1) return true
  }
  return false
}

/**
 * 把网格上的一块矩形输出成蒙皮。
 * @param rect 要输出的格子范围
 * @param offset 沿法线的偏移（正值向外）
 * @param inward 为 true 时正面朝向机身内部（内衬）
 * @param holes 要跳过的洞口
 * @param uv 自定义贴图坐标；缺省为按米平铺（z, 截面弧长）
 */
export function emitLoft(
  b: MeshBuilder,
  grid: LoftGrid,
  rect: CellRect,
  offset: number,
  inward: boolean,
  holes: readonly CellRect[] = [],
  uv?: LoftUv,
): void {
  const { nt } = grid
  const ids = new Map<number, number>()
  const sign = inward ? -1 : 1
  const vertexAt = (i: number, j: number): number => {
    const key = i * nt + j
    let id = ids.get(key)
    if (id === undefined) {
      const o = key * 3
      const p = gridPoint(grid, i, j, offset)
      const t = uv ? uv(i, j) : [grid.zs[i] * b.uvScale, grid.arc[key] * b.uvScale]
      id = b.vertex(p[0], p[1], p[2], grid.nor[o] * sign, grid.nor[o + 1] * sign, grid.nor[o + 2] * sign, t[0], t[1])
      ids.set(key, id)
    }
    return id
  }
  for (let i = rect.i0; i < rect.i1; i++) {
    for (let j = rect.j0; j < rect.j1; j++) {
      if (inHoles(holes, i, j)) continue
      const a = vertexAt(i, j)
      const c = vertexAt(i + 1, j + 1)
      // 外法线 = 沿 θ 的切线 × 沿 z 的切线
      if (inward) b.quad(a, vertexAt(i + 1, j), c, vertexAt(i, j + 1))
      else b.quad(a, vertexAt(i, j + 1), c, vertexAt(i + 1, j))
    }
  }
}

/**
 * 用扇形封住第 i 圈截面（机头 / 尾尖 / 隔板）。
 * @param facing 正面朝向：+1 朝 +Z，-1 朝 -Z
 * @param shiftZ 整体沿 z 挪动的距离
 */
export function emitCap(b: MeshBuilder, grid: LoftGrid, i: number, offset: number, facing: 1 | -1, shiftZ = 0): void {
  const ring: number[] = []
  let cx = 0
  let cy = 0
  let cz = 0
  for (let j = 0; j < grid.nt; j++) {
    const p = gridPoint(grid, i, j, offset)
    cx += p[0]
    cy += p[1]
    cz += p[2]
    ring.push(b.vertex(p[0], p[1], p[2] + shiftZ, 0, 0, facing, p[0] * b.uvScale, p[1] * b.uvScale))
  }
  cx /= grid.nt
  cy /= grid.nt
  cz /= grid.nt
  const center = b.vertex(cx, cy, cz + shiftZ, 0, 0, facing, cx * b.uvScale, cy * b.uvScale)
  for (let j = 0; j < grid.nt - 1; j++) {
    // θ 增大方向从 +Z 一侧看是逆时针
    if (facing > 0) b.tri(center, ring[j], ring[j + 1])
    else b.tri(center, ring[j + 1], ring[j])
  }
}

/**
 * 沿洞口四边输出侧壁：把偏移 outer 与 inner 的两层蒙皮连起来。
 * @param outward 为 true 时侧壁朝向矩形外侧（门板的外缘），否则朝向洞口中心（窗框）
 */
export function emitRim(b: MeshBuilder, grid: LoftGrid, hole: CellRect, outer: number, inner: number, outward = false): void {
  const flip = outward ? -1 : 1
  const edgeI = (i: number, facingZ: number): void => {
    for (let j = hole.j0; j < hole.j1; j++) {
      b.flat(gridPoint(grid, i, j, outer), gridPoint(grid, i, j + 1, outer), gridPoint(grid, i, j + 1, inner), gridPoint(grid, i, j, inner), [
        0,
        0,
        facingZ * flip,
      ])
    }
  }
  const edgeJ = (j: number, toward: number): void => {
    for (let i = hole.i0; i < hole.i1; i++) {
      // 朝向洞口内部：沿截面指向相邻的那一圈
      const here = gridPoint(grid, i, j, 0)
      const next = gridPoint(grid, i, j + toward, 0)
      b.flat(gridPoint(grid, i, j, outer), gridPoint(grid, i + 1, j, outer), gridPoint(grid, i + 1, j, inner), gridPoint(grid, i, j, inner), [
        (next[0] - here[0]) * flip,
        (next[1] - here[1]) * flip,
        (next[2] - here[2]) * flip,
      ])
    }
  }
  edgeI(hole.i0, 1)
  edgeI(hole.i1, -1)
  edgeJ(hole.j0, 1)
  edgeJ(hole.j1, -1)
}

/** 在 marks 之间按最大步长细分，返回递增的采样列表（marks 本身都会出现在结果里） */
function subdivide(marks: readonly number[], maxStep: number): number[] {
  const sorted = [...marks].sort((a, b) => a - b)
  const result: number[] = [sorted[0]]
  for (let k = 1; k < sorted.length; k++) {
    const from = sorted[k - 1]
    const to = sorted[k]
    if (to - from < 1e-9) continue
    const steps = Math.max(1, Math.ceil((to - from - 1e-9) / maxStep))
    for (let s = 1; s <= steps; s++) result.push(s === steps ? to : from + ((to - from) * s) / steps)
  }
  return result
}

/** 在列表里找与 value 最接近的下标（洞口边界都是列表里的精确值） */
function indexOfValue(list: readonly number[], value: number): number {
  let best = 0
  for (let k = 1; k < list.length; k++) {
    if (Math.abs(list[k] - value) < Math.abs(list[best] - value)) best = k
  }
  return best
}

/* ── 机身网格与洞口 ── */

const cabinTheta = (y: number): number => thetaAtHeight(CABIN_Z, y)

/** +X 侧用到的截面分界线（-X 侧取 PI 减去它）。按高度给出的都在客舱等截面段上量取 */
export const THETA = {
  /** 机头下视窗下沿 */
  chinLow: -1.2,
  /** 客舱地板 / 舱门下沿 / 下视窗上沿 */
  floor: cabinTheta(FLOOR_Y),
  /** 舱门窗下沿 */
  windowLow: cabinTheta(WINDOW_LOW_Y),
  /** 腰线：侧窗下沿 */
  waist: cabinTheta(WAIST_Y),
  /** 风挡下沿 */
  screenLow: 0.2,
  /** 侧窗上沿 */
  windowTop: cabinTheta(WINDOW_TOP_Y),
  /** 舱门上沿 / 驾驶舱侧窗上沿 */
  doorTop: cabinTheta(DOOR_TOP_Y),
  /** 顶窗下沿与上沿 */
  roofLow: 0.95,
  roofHigh: HALF_PI - 0.12,
  /** 风挡中柱边缘 */
  post: HALF_PI - 0.05,
} as const

/** 风挡、侧窗等洞口的纵向范围 */
export const SPAN = {
  cabinWindowA: [-0.75, -0.05],
  cabinWindowB: [0.35, 1.15],
  cockpitSide: [1.75, 2.6],
  screen: [2.75, 3.75],
  chin: [3.5, 4.1],
  /** 驾驶舱内衬的前端 */
  cockpitFront: 4.36,
} as const

/** +X 侧的截面采样（-PI/2 .. PI/2） */
const RIGHT_THETAS = subdivide(
  [
    -HALF_PI,
    THETA.chinLow,
    THETA.floor,
    THETA.windowLow,
    THETA.waist,
    0.06,
    THETA.screenLow,
    THETA.windowTop,
    THETA.doorTop,
    THETA.roofLow,
    THETA.roofHigh,
    THETA.post,
    HALF_PI,
  ],
  0.21,
)

/** 整圈截面采样：+X 侧递增到机背，再经 -X 侧（镜像）回到机腹；首尾是同一条机腹中线 */
const HULL_THETAS: readonly number[] = [
  ...RIGHT_THETAS,
  ...RIGHT_THETAS.slice(0, -1)
    .reverse()
    .map((t) => Math.PI - t),
]

/** 纵向采样：洞口边界、截面控制点，加上机头附近的加密 */
const HULL_ZS: readonly number[] = [
  Z_TAIL,
  -8.9,
  -8.7,
  -8.15,
  -7.6,
  -7.05,
  -6.5,
  -5.95,
  -5.4,
  -4.8,
  -4.1,
  -3.4,
  -2.7,
  -2,
  -1.45,
  DOOR_Z0,
  SPAN.cabinWindowA[0],
  SPAN.cabinWindowA[1],
  SPAN.cabinWindowB[0],
  SPAN.cabinWindowB[1],
  DOOR_Z1,
  1.6,
  SPAN.cockpitSide[0],
  2.2,
  SPAN.cockpitSide[1],
  SPAN.screen[0],
  3,
  3.25,
  SPAN.chin[0],
  SPAN.screen[1],
  3.95,
  SPAN.chin[1],
  4.25,
  SPAN.cockpitFront,
  4.44,
  4.48,
  Z_NOSE,
]

/** 蒙皮上的一个洞口：纵向范围 + 截面参数范围 */
export interface Opening {
  kind: 'door' | 'cabinWindow' | 'cockpit'
  z0: number
  z1: number
  t0: number
  t1: number
}

/** 把 +X 侧的参数范围镜像到 -X 侧 */
function mirrored(o: Opening): Opening {
  return { ...o, t0: Math.PI - o.t1, t1: Math.PI - o.t0 }
}

const COCKPIT_RIGHT: readonly Opening[] = [
  { kind: 'cockpit', z0: SPAN.cockpitSide[0], z1: SPAN.cockpitSide[1], t0: THETA.waist, t1: THETA.doorTop },
  { kind: 'cockpit', z0: SPAN.cockpitSide[0], z1: SPAN.cockpitSide[1], t0: THETA.roofLow, t1: THETA.roofHigh },
  { kind: 'cockpit', z0: SPAN.screen[0], z1: SPAN.screen[1], t0: THETA.screenLow, t1: THETA.post },
  { kind: 'cockpit', z0: SPAN.chin[0], z1: SPAN.chin[1], t0: THETA.chinLow, t1: THETA.floor },
]

/** 全部洞口：舱门（+X）、客舱侧窗（-X）、驾驶舱各窗（两侧） */
export const OPENINGS: readonly Opening[] = [
  { kind: 'door', z0: DOOR_Z0, z1: DOOR_Z1, t0: THETA.floor, t1: THETA.doorTop },
  mirrored({ kind: 'cabinWindow', z0: SPAN.cabinWindowA[0], z1: SPAN.cabinWindowA[1], t0: THETA.waist, t1: THETA.windowTop }),
  mirrored({ kind: 'cabinWindow', z0: SPAN.cabinWindowB[0], z1: SPAN.cabinWindowB[1], t0: THETA.waist, t1: THETA.windowTop }),
  ...COCKPIT_RIGHT,
  ...COCKPIT_RIGHT.map(mirrored),
]

function toCells(o: Opening): CellRect {
  return {
    i0: indexOfValue(HULL_ZS, o.z0),
    i1: indexOfValue(HULL_ZS, o.z1),
    j0: indexOfValue(HULL_THETAS, o.t0),
    j1: indexOfValue(HULL_THETAS, o.t1),
  }
}

/** 贴花层比蒙皮高出的距离 */
const OVERLAY_LIFT = 0.003
/** 玻璃相对蒙皮内退的距离 */
const GLASS_INSET = -0.02

/**
 * 生成机身：外蒙皮、贴花层、客舱与驾驶舱内衬、洞口侧壁、玻璃、隔板、地板与舱门滑轨。
 */
export function buildHull(s: HeliBuilders): void {
  const grid = createLoftGrid(hullPoint, HULL_ZS, HULL_THETAS)
  const all: CellRect = { i0: 0, i1: grid.nz - 1, j0: 0, j1: grid.nt - 1 }
  const cells = OPENINGS.map(toCells)

  // 外蒙皮 + 两端封口
  s.paint.tint(TINT.hull)
  emitLoft(s.paint, grid, all, 0, false, cells)
  emitCap(s.paint, grid, grid.nz - 1, 0, 1)
  emitCap(s.paint, grid, 0, 0, -1)

  // 贴花层：与蒙皮同形，UV 展开到图集
  emitLoft(s.overlay, grid, all, OVERLAY_LIFT, false, cells, (i, j) => [atlasU(HULL_ZS[i]), atlasV(HULL_ZS[i], HULL_THETAS[j])])

  // 客舱内衬：从 +X 侧地板线下方一格起，绕过舱顶到 -X 侧地板线下方一格（与地板交叠，不留缝）
  const iRear = indexOfValue(HULL_ZS, DOOR_Z0)
  const iFront = indexOfValue(HULL_ZS, DOOR_Z1)
  const jFloorRight = indexOfValue(HULL_THETAS, THETA.floor)
  const jFloorLeft = indexOfValue(HULL_THETAS, Math.PI - THETA.floor)
  s.paint.tint(TINT.interior)
  emitLoft(s.paint, grid, { i0: iRear, i1: iFront, j0: jFloorRight - 1, j1: jFloorLeft + 1 }, -WALL, true, cells)
  // 前后隔板（朝客舱的一面）
  emitCap(s.paint, grid, iRear, -WALL, 1)
  emitCap(s.paint, grid, iFront, -WALL, -1)

  // 驾驶舱内衬：整圈，前端封口；前隔板朝驾驶舱的一面略向前错开
  const iNose = indexOfValue(HULL_ZS, SPAN.cockpitFront)
  s.paint.tint(TINT.cockpit)
  emitLoft(s.paint, grid, { i0: iFront, i1: iNose, j0: 0, j1: grid.nt - 1 }, -WALL, true, cells)
  emitCap(s.paint, grid, iNose, -WALL, -1)
  emitCap(s.paint, grid, iFront, -WALL, 1, 0.03)

  // 洞口侧壁与玻璃
  for (let k = 0; k < OPENINGS.length; k++) {
    const opening = OPENINGS[k]
    const rect = cells[k]
    s.paint.tint(opening.kind === 'door' ? TINT.interiorDark : TINT.gasket)
    emitRim(s.paint, grid, rect, 0, -WALL)
    if (opening.kind === 'cockpit') emitLoft(s.glass, grid, rect, GLASS_INSET, false)
    else if (opening.kind === 'cabinWindow') emitLoft(s.cabinGlass, grid, rect, GLASS_INSET, false)
  }

  // 客舱地板：两侧伸进舱壁夹层
  s.paint.tint(TINT.floor)
  s.paint.box(2.26, 0.04, DOOR_Z1 - DOOR_Z0, 0, FLOOR_Y - 0.02, CABIN_Z)

  /* ── 舱门滑轨：上、下各一根直轨，从洞口前沿延伸到舱门全开的位置 ── */

  const railFront = DOOR_Z1 + 0.06
  const railRear = DOOR_Z0 - DOOR_SLIDE - 0.06
  s.steel.tint(TINT.rail)
  s.steel.beam([RAIL_TOP.x, RAIL_TOP.y, railRear], [RAIL_TOP.x, RAIL_TOP.y, railFront], 0.04, 0.04)
  s.steel.beam([RAIL_BOTTOM.x, RAIL_BOTTOM.y, railRear], [RAIL_BOTTOM.x, RAIL_BOTTOM.y, railFront], 0.03, 0.03)
  // 支座：等截面段用短垫块，机身收窄的后段用斜撑杆
  const thetaTop = cabinTheta(RAIL_TOP.y)
  const thetaBottom = cabinTheta(RAIL_BOTTOM.y)
  for (const z of [railFront - 0.08, 0.2, -0.8, -1.8]) {
    const top = hullSurface(z, thetaTop)
    s.steel.beam([top[0] - 0.01, RAIL_TOP.y, z], [RAIL_TOP.x, RAIL_TOP.y, z], 0.06, 0.03)
    const bottom = hullSurface(z, thetaBottom)
    s.steel.beam([bottom[0] - 0.01, RAIL_BOTTOM.y, z], [RAIL_BOTTOM.x, RAIL_BOTTOM.y, z], 0.06, 0.025)
  }
  for (const z of [-2.45, railRear + 0.06]) {
    s.steel.rod(hullSurface(z, thetaTop, -0.02), [RAIL_TOP.x, RAIL_TOP.y, z], 0.013, 0.013, 6)
    s.steel.rod(hullSurface(z, thetaBottom + 0.25, -0.02), [RAIL_BOTTOM.x, RAIL_BOTTOM.y, z], 0.013, 0.013, 6)
  }
}

/* ── 舱门 ── */

/** 门板外缘相对洞口的搭接量，以及窗距门板前后边缘的距离 */
const DOOR_LAP = 0.03
const DOOR_WINDOW_MARGIN = 0.3
/** 门板外表面 / 内表面相对机身蒙皮的偏移 */
const DOOR_OUTER = 0.02
const DOOR_INNER = -0.022

/** 舱门覆盖的纵向与截面范围（贴花绘制时要用） */
export const DOOR_PANEL = {
  z0: DOOR_Z0 - DOOR_LAP,
  z1: DOOR_Z1 + DOOR_LAP,
  t0: cabinTheta(FLOOR_Y - DOOR_LAP),
  t1: cabinTheta(DOOR_TOP_Y + 0.02),
  windowZ0: DOOR_Z0 + DOOR_WINDOW_MARGIN,
  windowZ1: DOOR_Z1 - DOOR_WINDOW_MARGIN,
} as const

/** 舱门所在的曲面：客舱等截面沿 z 拉伸 */
function doorPoint(z: number, theta: number, out: Vector3): Vector3 {
  hullPoint(CABIN_Z, theta, out)
  out.z = z
  return out
}

/**
 * 生成舱门（关闭位置）：外板、内板、窗框、玻璃、贴花层、内外把手与滑轮支架。
 */
export function buildDoor(s: HeliBuilders): void {
  const thetas = [
    DOOR_PANEL.t0,
    ...RIGHT_THETAS.filter((t) => t > DOOR_PANEL.t0 + 0.01 && t < DOOR_PANEL.t1 - 0.01),
    DOOR_PANEL.t1,
  ]
  const zs = [DOOR_PANEL.z0, DOOR_PANEL.windowZ0, CABIN_Z, DOOR_PANEL.windowZ1, DOOR_PANEL.z1]
  const grid = createLoftGrid(doorPoint, zs, thetas)
  const all: CellRect = { i0: 0, i1: grid.nz - 1, j0: 0, j1: grid.nt - 1 }
  const windowRect: CellRect = {
    i0: 1,
    i1: 3,
    j0: indexOfValue(thetas, THETA.windowLow),
    j1: indexOfValue(thetas, THETA.windowTop),
  }

  s.doorPaint.tint(TINT.hull)
  emitLoft(s.doorPaint, grid, all, DOOR_OUTER, false, [windowRect])
  s.doorPaint.tint(TINT.interior)
  emitLoft(s.doorPaint, grid, all, DOOR_INNER, true, [windowRect])
  s.doorPaint.tint(TINT.gasket)
  emitRim(s.doorPaint, grid, windowRect, DOOR_OUTER, DOOR_INNER)
  s.doorPaint.tint(TINT.hullDark)
  emitRim(s.doorPaint, grid, all, DOOR_OUTER, DOOR_INNER, true)

  emitLoft(s.doorGlass, grid, windowRect, 0, false)
  emitLoft(s.doorOverlay, grid, all, DOOR_OUTER + OVERLAY_LIFT, false, [windowRect], (i, j) => [atlasU(zs[i]), atlasV(CABIN_Z, thetas[j])])

  // 外把手：底板 + 拉手，靠近门的前缘
  const handleZ = DOOR_Z1 - 0.13
  const handleTheta = cabinTheta(-0.36)
  const outside = hullSurface(CABIN_Z, handleTheta, DOOR_OUTER)
  const normal = hullNormal(CABIN_Z, handleTheta)
  const along = (p: readonly number[], d: number, dy: number, z: number): Vec3 => [p[0] + normal[0] * d, p[1] + normal[1] * d + dy, z]
  s.doorPaint.tint(TINT.black)
  s.doorPaint.beam(along(outside, 0.004, -0.09, handleZ), along(outside, 0.004, 0.09, handleZ), 0.09, 0.008, normal)
  s.doorPaint.tint(TINT.steelDark)
  s.doorPaint.beam(along(outside, 0.035, -0.075, handleZ), along(outside, 0.035, 0.075, handleZ), 0.026, 0.02, normal)
  for (const dy of [-0.07, 0.07]) s.doorPaint.beam(along(outside, 0, dy, handleZ), along(outside, 0.035, dy, handleZ), 0.02, 0.02)
  // 内把手
  const inside = hullSurface(CABIN_Z, handleTheta, DOOR_INNER)
  s.doorPaint.beam(along(inside, -0.04, -0.07, handleZ), along(inside, -0.04, 0.07, handleZ), 0.024, 0.02, normal)
  for (const dy of [-0.065, 0.065]) s.doorPaint.beam(along(inside, 0, dy, handleZ), along(inside, -0.04, dy, handleZ), 0.02, 0.02)

  // 滑轮支架：上方跨过上滑轨，下方贴着下滑轨外侧
  s.doorPaint.tint(TINT.rail)
  for (const z of [DOOR_Z0 + 0.35, DOOR_Z1 - 0.35]) {
    s.doorPaint.box(0.012, 0.115, 0.09, RAIL_TOP.x + 0.04, RAIL_TOP.y - 0.003, z)
    s.doorPaint.box(0.1, 0.012, 0.09, RAIL_TOP.x - 0.004, RAIL_TOP.y + 0.05, z)
    s.doorPaint.box(0.012, 0.07, 0.09, RAIL_BOTTOM.x + 0.03, RAIL_BOTTOM.y + 0.01, z)
  }
}

/* ── 发动机整流罩 ── */

/** 整流罩截面：[z, 半宽, 上缘 y, 下缘 y]，下缘埋在机背里 */
const COWL_STATIONS: readonly (readonly [number, number, number, number])[] = [
  [-4.3, 0.02, 1.02, 0.98],
  [-4.1, 0.14, 1.14, 0.96],
  [-3.6, 0.3, 1.36, 0.95],
  [-2.9, 0.47, 1.58, 1],
  [-2, 0.58, 1.72, 1.05],
  [-0.8, 0.62, 1.77, 1.05],
  [0.2, 0.6, 1.74, 1.05],
  [0.9, 0.52, 1.62, 1.05],
  [1.35, 0.38, 1.44, 1.06],
  [1.62, 0.2, 1.26, 1.08],
  [1.74, 0.03, 1.16, 1.12],
]
const cowlZ = COWL_STATIONS.map((s) => s[0])
const cowlHalfWidth = createCurve(cowlZ, COWL_STATIONS.map((s) => s[1]))
const cowlTop = createCurve(cowlZ, COWL_STATIONS.map((s) => s[2]))
const cowlBottom = createCurve(cowlZ, COWL_STATIONS.map((s) => s[3]))
const COWL_EXPONENT = 2 / 2.6

/** 整流罩表面上的一点 */
export function cowlPoint(z: number, theta: number, out: Vector3): Vector3 {
  const top = cowlTop(z)
  const bottom = cowlBottom(z)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return out.set(
    cowlHalfWidth(z) * Math.sign(c) * Math.pow(Math.abs(c), COWL_EXPONENT),
    (top + bottom) / 2 + ((top - bottom) / 2) * Math.sign(s) * Math.pow(Math.abs(s), COWL_EXPONENT),
    z,
  )
}

/**
 * 生成发动机整流罩及其附件：进气口、排气管、散热百叶、旋翼轴与轴座。
 */
export function buildCowl(s: HeliBuilders): void {
  const zs = subdivide(cowlZ, 0.5)
  const thetas = subdivide([-0.35, Math.PI + 0.35], 0.3)
  const grid = createLoftGrid(cowlPoint, zs, thetas)
  s.paint.tint(TINT.hull)
  emitLoft(s.paint, grid, { i0: 0, i1: grid.nz - 1, j0: 0, j1: grid.nt - 1 }, 0, false)

  const p = new Vector3()
  for (const side of [-1, 1]) {
    // 进气口：整流罩前部两侧的短筒，前端露出深色内壁
    const intakeX = side * 0.44
    s.paint.tint(TINT.hull)
    s.paint.rod([intakeX, 1.36, 0.45], [intakeX, 1.37, 1.12], 0.17, 0.155, 14)
    s.steel.tint(TINT.steelDark)
    s.steel.ring(0.15, 0.014, intakeX, 1.37, 1.12, 0, 0, 0, 6, 16)
    s.polymer.tint(TINT.black)
    s.polymer.rod([intakeX, 1.37, 1.1], [intakeX, 1.37, 1.123], 0.142, 0.142, 14)

    // 排气管：从整流罩后部向后上方伸出，管口发黑
    const from: Vec3 = [side * 0.2, 1.4, -2.9]
    const to: Vec3 = [side * 0.27, 1.6, -3.62]
    s.steel.tint(TINT.exhaust)
    s.steel.rod(from, to, 0.135, 0.15, 14)
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const dz = to[2] - from[2]
    const inv = 1 / Math.hypot(dx, dy, dz)
    s.polymer.tint(TINT.black)
    s.polymer.rod(
      [to[0] - dx * inv * 0.02, to[1] - dy * inv * 0.02, to[2] - dz * inv * 0.02],
      [to[0] + dx * inv * 0.003, to[1] + dy * inv * 0.003, to[2] + dz * inv * 0.003],
      0.125,
      0.125,
      14,
    )

    // 散热百叶：整流罩侧面的一排深色竖条
    const louverTheta = side > 0 ? 0.42 : Math.PI - 0.42
    s.polymer.tint(TINT.black)
    for (let k = 0; k < 7; k++) {
      const z = -1.75 + k * 0.11
      cowlPoint(z, louverTheta, p)
      s.polymer.box(0.02, 0.2, 0.045, p.x + side * 0.002, p.y, z, 0, 0, side * -0.42)
    }
    // 检修口盖的铰链与锁扣
    s.steel.tint(TINT.steelDark)
    for (const z of [-0.55, 0.05]) {
      cowlPoint(z, side > 0 ? 0.2 : Math.PI - 0.2, p)
      s.steel.box(0.014, 0.05, 0.07, p.x + side * 0.004, p.y, z)
    }
  }

  // 旋翼轴座（整流罩顶上的鼓包）与静止的轴筒
  s.paint.tint(TINT.hull)
  s.paint.ball(0.3, 0.1, 0.42, 0, 1.73, 0.02, 14, 6, HALF_PI)
  s.steel.tint(TINT.steelDark)
  s.steel.rod([0, 1.7, 0], [0, ROTOR_Y - 0.26, 0], 0.11, 0.095, 14)
}

/**
 * 场景道具的建模工具箱：按材质槽位合并几何体的 Assembly、常用形体（倒角盒、放样、枝干、轮胎等）、
 * 画布贴图，以及按 key 缓存的几何 / 材质 / 贴图。只被 props*.ts 使用，缓存由 disposeKit 统一释放。
 *
 * 约定：Assembly 产出的几何体都带 position / normal / uv / color 四个属性，材质一律开启顶点色。
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Shape,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { Material, Object3D } from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { createSurfaceMaterial } from '../textures/pbr'
import type { SurfaceKind, SurfaceOptions } from '../textures/pbr'
import { createRng } from '../../utils/random'

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

/** 一个道具的几何体：槽位名 → 合并后的几何体（每个槽位对应一种材质、一次 draw call） */
export type GeometrySet = Record<string, BufferGeometry>

export const HALF_PI = Math.PI / 2

const geometrySets = new Map<string, GeometrySet>()
const materials = new Map<string, Material>()
const textures = new Map<string, CanvasTexture>()

const UP = new Vector3(0, 1, 0)
const M = new Matrix4()
const PM = new Matrix4()
const E = new Euler()
const Q = new Quaternion()
const VA = new Vector3()
const VB = new Vector3()
const VC = new Vector3()
const VD = new Vector3()
const KEEP = new Set(['position', 'normal', 'uv', 'color'])

/** 构造一个碰撞盒 */
export function solid(x: number, z: number, hx: number, hz: number, height: number, walkable = true, blocksShots = true): PropBox {
  return { x, z, hx, hz, height, walkable, blocksShots }
}

/** 限制到 [0, 1] */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 由一两个整数得到固定的伪随机数 [0, 1)（同样的输入永远得到同样的结果） */
export function hash01(a: number, b = 0): number {
  const s = Math.sin(a * 127.1 + b * 311.7 + 17.3) * 43758.5453
  return s - Math.floor(s)
}

/** 0..1 的平滑过渡 */
export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * 盒式投影 UV：按面法线的主轴把本地坐标（米）除以 tile 作为 UV，贴图密度与部件大小无关。
 * 贴图纹理方向沿 U；grainY 为 true 时把竖直方向（本地 Y）映射到 U。
 */
function boxProject(g: BufferGeometry, tile: number, grainY: boolean): void {
  const pos = g.getAttribute('position')
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i += 3) {
    VA.fromBufferAttribute(pos, i)
    VB.fromBufferAttribute(pos, i + 1).sub(VA)
    VC.fromBufferAttribute(pos, i + 2).sub(VA)
    VD.crossVectors(VB, VC)
    const ax = Math.abs(VD.x)
    const ay = Math.abs(VD.y)
    const az = Math.abs(VD.z)
    const top = ay >= ax && ay >= az
    for (let j = 0; j < 3; j++) {
      VA.fromBufferAttribute(pos, i + j)
      let u = top ? VA.x : ax >= az ? VA.z : VA.x
      let v = top ? VA.z : VA.y
      if (grainY && !top) {
        const s = u
        u = v
        v = s
      }
      uv[(i + j) * 2] = u / tile
      uv[(i + j) * 2 + 1] = v / tile
    }
  }
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
}

/** 保证有顶点色属性，并乘上 tint */
function ensureColor(g: BufferGeometry, tint: Color | null): void {
  const count = g.getAttribute('position').count
  const old = g.getAttribute('color')
  const data = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    data[i * 3] = (old ? old.getX(i) : 1) * (tint ? tint.r : 1)
    data[i * 3 + 1] = (old ? old.getY(i) : 1) * (tint ? tint.g : 1)
    data[i * 3 + 2] = (old ? old.getZ(i) : 1) * (tint ? tint.b : 1)
  }
  g.setAttribute('color', new Float32BufferAttribute(data, 3))
}

/**
 * 几何体拼装器：部件按槽位（材质）收集，build 时每个槽位合并成一个几何体。
 * 传入的几何体归拼装器所有（会被变换、合并并释放）。
 */
export class Assembly {
  private readonly slots = new Map<string, BufferGeometry[]>()
  private readonly tiles = new Map<string, number>()
  private readonly grimes = new Map<string, readonly [number, number]>()
  private tintColor: Color | null = null
  private readonly parent = new Matrix4()
  private warpFn: ((p: Vector3) => void) | null = null
  private settled = false

  /** 设置槽位的贴图铺设尺寸：tile 米铺一次贴图（默认 1） */
  tile(slot: string, meters: number): this {
    this.tiles.set(slot, meters)
    return this
  }

  /** 给槽位加贴地污渍：高度 height 以下逐渐压暗到 dark 倍亮度 */
  grime(slot: string, height: number, dark = 0.55): this {
    this.grimes.set(slot, [height, dark])
    return this
  }

  /** 设置之后加入的部件的顶点色（不传则恢复白色） */
  tint(color?: number): this {
    this.tintColor = color === undefined ? null : new Color(color)
    return this
  }

  /** 设置之后加入的部件共用的父变换（先旋转再平移）；不传参数则清除 */
  pose(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    this.parent.makeRotationFromEuler(E.set(rx, ry, rz)).setPosition(x, y, z)
    return this
  }

  /** 加入一个部件：先按欧拉角旋转再平移；UV 在部件本地空间做盒式投影 */
  add(slot: string, geometry: BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    M.makeRotationFromEuler(E.set(rx, ry, rz)).setPosition(x, y, z)
    return this.place(slot, geometry, M, true)
  }

  /** 同 add，但保留几何体自带的 UV */
  addUV(slot: string, geometry: BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    M.makeRotationFromEuler(E.set(rx, ry, rz)).setPosition(x, y, z)
    return this.place(slot, geometry, M, false)
  }

  /** 加入一组已分好槽位的几何体（例如 loft 的结果） */
  addSet(set: GeometrySet, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    for (const [slot, g] of Object.entries(set)) this.add(slot, g, x, y, z, rx, ry, rz)
    return this
  }

  /** 从 a 到 b 的圆杆（半径可渐变），纹理方向沿杆长 */
  rod(slot: string, ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, radial = 8, radiusEnd = radius): this {
    const dir = new Vector3(bx - ax, by - ay, bz - az)
    const length = dir.length()
    const g = new CylinderGeometry(radiusEnd, radius, length, radial)
    g.userData.grainY = true
    Q.setFromUnitVectors(UP, dir.divideScalar(length))
    M.makeRotationFromQuaternion(Q).setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
    return this.place(slot, g, M, true)
  }

  /** 圆杆接头处的小球 */
  joint(slot: string, x: number, y: number, z: number, radius: number): this {
    return this.add(slot, new SphereGeometry(radius, 8, 6), x, y, z)
  }

  /** 合并各槽位，得到最终几何体 */
  build(): GeometrySet {
    const out: GeometrySet = {}
    for (const [slot, list] of this.slots) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false)
      if (!merged) throw new Error(`道具槽位 ${slot} 合并失败`)
      if (list.length > 1) list.forEach((g) => g.dispose())
      const grime = this.grimes.get(slot)
      if (grime) {
        const pos = merged.getAttribute('position')
        const col = merged.getAttribute('color')
        for (let i = 0; i < pos.count; i++) {
          const k = grime[1] + (1 - grime[1]) * smoothstep(0, grime[0], pos.getY(i))
          col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k)
        }
      }
      out[slot] = merged
    }
    this.slots.clear()
    const all = Object.values(out)
    if (this.warpFn) {
      for (const g of all) {
        const pos = g.getAttribute('position')
        for (let i = 0; i < pos.count; i++) {
          this.warpFn(VA.fromBufferAttribute(pos, i))
          pos.setXYZ(i, VA.x, VA.y, VA.z)
        }
      }
    }
    if (this.settled) {
      let min = Infinity
      for (const g of all) {
        g.computeBoundingBox()
        if (g.boundingBox) min = Math.min(min, g.boundingBox.min.y)
      }
      for (const g of all) g.translate(0, -min, 0)
    }
    for (const g of all) {
      g.computeBoundingBox()
      g.computeBoundingSphere()
    }
    return out
  }

  /** 合并后对全部顶点做一次整体变形（扭曲、压扁等；法线保持不变，只适合小幅度变形） */
  warp(fn: (p: Vector3) => void): this {
    this.warpFn = fn
    return this
  }

  /** 合并后整体上下平移，使最低点正好落在 y = 0 */
  settle(): this {
    this.settled = true
    return this
  }

  private place(slot: string, geometry: BufferGeometry, matrix: Matrix4, project: boolean): this {
    let g = geometry
    if (geometry.index) {
      g = geometry.toNonIndexed()
      g.userData = geometry.userData
      geometry.dispose()
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    if (project || !g.getAttribute('uv')) boxProject(g, this.tiles.get(slot) ?? 1, g.userData.grainY === true)
    g.applyMatrix4(PM.multiplyMatrices(this.parent, matrix))
    for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name)
    g.morphAttributes = {}
    g.clearGroups()
    ensureColor(g, this.tintColor)
    const list = this.slots.get(slot)
    if (list) list.push(g)
    else this.slots.set(slot, [g])
    return this
  }
}

/* ── 形体 ── */

/** 由索引三角形生成几何体，并把每个三角形的绕序统一成与顶点法线同向 */
function oriented(pos: number[], nor: number[], idx: number[], uv?: number[]): BufferGeometry {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3
    const b = idx[t + 1] * 3
    const c = idx[t + 2] * 3
    VA.set(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2])
    VB.set(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2])
    VC.crossVectors(VA, VB)
    VD.set(nor[a] + nor[b] + nor[c], nor[a + 1] + nor[b + 1] + nor[c + 1], nor[a + 2] + nor[b + 2] + nor[c + 2])
    if (VC.dot(VD) < 0) {
      const s = idx[t + 1]
      idx[t + 1] = idx[t + 2]
      idx[t + 2] = s
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  if (uv) g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/**
 * 带倒角的盒子（44 个三角形）：六个面保持平整，棱与角用面法线插值出圆润的高光。
 * @param bevel 倒角宽度（米），自动限制在最短边的 45% 以内
 */
export function bevelBox(w: number, h: number, d: number, bevel = 0.012): BufferGeometry {
  const hx = w / 2
  const hy = h / 2
  const hz = d / 2
  const b = Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45)
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  // 每个角 3 个顶点，分别属于 X / Y / Z 三个面
  for (let c = 0; c < 8; c++) {
    const sx = c & 1 ? 1 : -1
    const sy = c & 2 ? 1 : -1
    const sz = c & 4 ? 1 : -1
    pos.push(sx * hx, sy * (hy - b), sz * (hz - b), sx * (hx - b), sy * hy, sz * (hz - b), sx * (hx - b), sy * (hy - b), sz * hz)
    nor.push(sx, 0, 0, 0, sy, 0, 0, 0, sz)
  }
  const quad = (p: number, q: number, r: number, s: number): void => {
    idx.push(p, q, r, p, r, s)
  }
  for (let axis = 0; axis < 3; axis++) {
    const bit = 1 << axis
    const fa = (axis + 1) % 3
    const fb = (axis + 2) % 3
    const u = 1 << fa
    const v = 1 << fb
    for (const s of [0, bit]) quad(s * 3 + axis, (s | u) * 3 + axis, (s | u | v) * 3 + axis, (s | v) * 3 + axis)
    // 沿该轴的 4 条棱：连接相邻的两个面
    for (const cu of [0, u]) {
      for (const cv of [0, v]) {
        const c0 = cu | cv
        const c1 = c0 | bit
        quad(c0 * 3 + fa, c1 * 3 + fa, c1 * 3 + fb, c0 * 3 + fb)
      }
    }
  }
  for (let c = 0; c < 8; c++) idx.push(c * 3, c * 3 + 1, c * 3 + 2)
  return oriented(pos, nor, idx)
}

/** 圆柱 / 圆台（轴线沿 Y，中心在原点） */
export function cylinder(rTop: number, rBottom: number, height: number, radial = 10, open = false): BufferGeometry {
  return new CylinderGeometry(rTop, rBottom, height, radial, 1, open)
}

/** 车削体（绕 Y 轴）。profile 为 [半径, 高度] 序列：高度递增的段朝外，递减的段朝向轴线 */
export function lathe(profile: readonly (readonly [number, number])[], segments = 16): BufferGeometry {
  return new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, y)),
    segments,
  )
}

/** 沿平滑曲线的等径圆管 */
export function tube(points: readonly (readonly [number, number, number])[], radius: number, tubular: number, radial = 6, closed = false): BufferGeometry {
  const curve = new CatmullRomCurve3(
    points.map(([x, y, z]) => new Vector3(x, y, z)),
    closed,
    'catmullrom',
    0.5,
  )
  return new TubeGeometry(curve, tubular, radius, radial, closed)
}

/**
 * 把 XY 平面上的轮廓沿 Z 拉伸成带倒角的板（沿 Z 居中，总厚度 depth，轮廓不外扩）。
 * @param outline 闭合轮廓的顶点
 * @param holes 可选的孔洞轮廓
 */
export function extrude(
  outline: readonly (readonly [number, number])[],
  depth: number,
  bevel = 0.01,
  holes: readonly (readonly (readonly [number, number])[])[] = [],
): BufferGeometry {
  const shape = new Shape(outline.map(([x, y]) => new Vector2(x, y)))
  for (const hole of holes) shape.holes.push(new Shape(hole.map(([x, y]) => new Vector2(x, y))))
  const inner = Math.max(0.001, depth - bevel * 2)
  const g = new ExtrudeGeometry(shape, {
    depth: inner,
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 1,
  })
  g.translate(0, 0, -inner / 2)
  return g
}

/** 焊合重合顶点并重算平滑法线（会丢弃 UV） */
export function weld(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('uv')
  geometry.deleteAttribute('normal')
  const g = mergeVertices(geometry, 1e-4)
  geometry.dispose()
  g.computeVertexNormals()
  return g
}

/** 逐顶点变形并重算法线（索引几何体得到平滑法线，非索引的得到硬边） */
export function deform(geometry: BufferGeometry, fn: (p: Vector3) => void): BufferGeometry {
  const pos = geometry.getAttribute('position')
  const p = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    fn(p)
    pos.setXYZ(i, p.x, p.y, p.z)
  }
  pos.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 不规则的团块（叶丛、石块、垃圾袋）：二十面体细分后按随机量径向起伏。
 * @param detail 细分级别（0 为 20 面，1 为 80 面，2 为 180 面）
 * @param jitter 半径的相对起伏幅度
 * @param flat 是否用硬边（石块）
 */
export function blob(radius: number, detail: number, jitter: number, seed: number, sx = 1, sy = 1, sz = 1, flat = false): BufferGeometry {
  const rng = createRng(seed)
  let g = weld(new IcosahedronGeometry(1, detail))
  const pos = g.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const k = radius * (1 + rng.range(-jitter, jitter))
    pos.setXYZ(i, pos.getX(i) * k * sx, pos.getY(i) * k * sy, pos.getZ(i) * k * sz)
  }
  if (flat) {
    const hard = g.toNonIndexed()
    g.dispose()
    g = hard
  }
  g.computeVertexNormals()
  return g
}

/**
 * 沿折线的渐变圆管（树干、枝条、弯管）：截面沿路径平行移动，法线取径向，U 沿长度方向。
 * @param radius 按路径参数 0..1 给出半径
 * @param tip 是否在末端收成尖
 */
export function limb(path: readonly Vector3[], radius: (t: number) => number, radial = 6, tile = 1, tip = false): BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const tangent = new Vector3()
  const side = new Vector3(1, 0, 0)
  const up = new Vector3()
  const p = new Vector3()
  const n = path.length
  const wraps = Math.max(1, Math.round((Math.PI * 2 * radius(0)) / tile))
  let along = 0
  for (let i = 0; i < n; i++) {
    tangent.subVectors(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]).normalize()
    if (i === 0 && Math.abs(tangent.x) > 0.9) side.set(0, 0, 1)
    side.addScaledVector(tangent, -side.dot(tangent)).normalize()
    up.crossVectors(tangent, side)
    if (i > 0) along += path[i].distanceTo(path[i - 1])
    const r = radius(i / (n - 1))
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      p.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a))
      nor.push(p.x, p.y, p.z)
      pos.push(path[i].x + p.x * r, path[i].y + p.y * r, path[i].z + p.z * r)
      uv.push(along / tile, (j / radial) * wraps)
    }
  }
  const row = radial + 1
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j
      idx.push(a, a + row, a + row + 1, a, a + row + 1, a + 1)
    }
  }
  if (tip) {
    const end = path[n - 1]
    const r = radius(1)
    const apex = pos.length / 3
    pos.push(end.x + tangent.x * r * 1.5, end.y + tangent.y * r * 1.5, end.z + tangent.z * r * 1.5)
    nor.push(tangent.x, tangent.y, tangent.z)
    uv.push((along + r) / tile, 0.5)
    for (let j = 0; j < radial; j++) idx.push((n - 1) * row + j, apex, (n - 1) * row + j + 1)
  }
  return oriented(pos, nor, idx, uv)
}

/**
 * 两条边线之间的带子（警戒带、撕裂的铁皮）：U 沿长度（米 / tile），V 横跨 0..1。材质请用双面。
 */
export function strip(left: readonly Vector3[], right: readonly Vector3[], tile = 1): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  let along = 0
  for (let i = 0; i < left.length; i++) {
    if (i > 0) along += (left[i].distanceTo(left[i - 1]) + right[i].distanceTo(right[i - 1])) / 2
    pos.push(left[i].x, left[i].y, left[i].z, right[i].x, right[i].y, right[i].z)
    uv.push(along / tile, 0, along / tile, 1)
    if (i > 0) idx.push(i * 2 - 2, i * 2, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2 - 1)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * 四个角点之间的双线性曲面片（球网、铁丝网），UV 按米 / tile 铺设。
 * @param corners 按 (u0,v0)、(u1,v0)、(u1,v1)、(u0,v1) 的顺序
 * @param offset 可选的逐点偏移（松弛、鼓包）
 */
export function patch(
  corners: readonly [Vector3, Vector3, Vector3, Vector3],
  segU: number,
  segV: number,
  tile: number,
  offset?: (u: number, v: number, p: Vector3) => void,
): BufferGeometry {
  const [p00, p10, p11, p01] = corners
  const width = (p00.distanceTo(p10) + p01.distanceTo(p11)) / 2
  const height = (p00.distanceTo(p01) + p10.distanceTo(p11)) / 2
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const a = new Vector3()
  const b = new Vector3()
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      const u = i / segU
      const v = j / segV
      a.lerpVectors(p00, p10, u)
      b.lerpVectors(p01, p11, u)
      a.lerp(b, v)
      if (offset) offset(u, v, a)
      pos.push(a.x, a.y, a.z)
      uv.push((u * width) / tile, (v * height) / tile)
      if (i < segU && j < segV) {
        const k = j * (segU + 1) + i
        idx.push(k, k + 1, k + segU + 2, k, k + segU + 2, k + segU + 1)
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

export interface LoftOptions {
  /** 第 i 段、第 k 格的四边形归属的槽位；返回 null 则留空。默认全部归 'body' */
  slot?: (i: number, k: number) => string | null
  /** 第 i 个截面、第 k 个点的顶点色（out 初始为白色） */
  color?: (i: number, k: number, out: Color) => void
  /** 反转朝向（做内衬时用） */
  flip?: boolean
  /** 截面是否首尾相接，默认 true */
  closed?: boolean
  /** 起始 / 末端封口所属的槽位，不给则不封口 */
  capStart?: string
  capEnd?: string
}

/**
 * 放样：把一串截面（每个截面点数相同）蒙成曲面。法线在整张网格上平滑，跨槽位也连续；
 * 闭合截面自动判定外侧（远离截面质心）。结果只有 position / normal / color，UV 由 Assembly.add 补。
 */
export function loft(rings: readonly (readonly Vector3[])[], options: LoftOptions = {}): GeometrySet {
  const n = rings.length
  const m = rings[0].length
  const closed = options.closed ?? true
  const cells = closed ? m : m - 1
  const at = (i: number, k: number): Vector3 => rings[i][k % m]
  const centers = rings.map((ring) => ring.reduce((c, p) => c.add(p), new Vector3()).divideScalar(m))
  const fn = new Vector3()
  const faceNormal = (i: number, k: number): Vector3 =>
    fn.crossVectors(VA.subVectors(at(i + 1, k), at(i, k)), VB.subVectors(at(i, k + 1), at(i, k)))

  let outward = 0
  if (closed) {
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < cells; k++) {
        faceNormal(i, k)
        VC.addVectors(at(i, k), at(i + 1, k + 1)).sub(centers[i]).sub(centers[i + 1])
        outward += fn.dot(VC)
      }
    }
  }
  const sign = (outward < 0 ? -1 : 1) * (options.flip ? -1 : 1)

  const normals = rings.map((ring) => ring.map(() => new Vector3()))
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < cells; k++) {
      faceNormal(i, k).multiplyScalar(sign)
      normals[i][k % m].add(fn)
      normals[i + 1][k % m].add(fn)
      normals[i][(k + 1) % m].add(fn)
      normals[i + 1][(k + 1) % m].add(fn)
    }
  }
  normals.forEach((ring) => ring.forEach((v) => v.normalize()))

  interface Bucket {
    pos: number[]
    nor: number[]
    col: number[]
  }
  const buckets = new Map<string, Bucket>()
  const bucket = (slot: string): Bucket => {
    let b = buckets.get(slot)
    if (!b) {
      b = { pos: [], nor: [], col: [] }
      buckets.set(slot, b)
    }
    return b
  }
  const tmp = new Color()
  const emit = (b: Bucket, i: number, k: number, normal?: Vector3): void => {
    const p = at(i, k)
    const nn = normal ?? normals[i][k % m]
    b.pos.push(p.x, p.y, p.z)
    b.nor.push(nn.x, nn.y, nn.z)
    tmp.set(0xffffff)
    if (options.color) options.color(i, k % m, tmp)
    b.col.push(tmp.r, tmp.g, tmp.b)
  }

  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < cells; k++) {
      const slot = options.slot ? options.slot(i, k) : 'body'
      if (slot === null) continue
      const b = bucket(slot)
      emit(b, i, k)
      if (sign > 0) {
        emit(b, i + 1, k)
        emit(b, i + 1, k + 1)
        emit(b, i, k)
        emit(b, i + 1, k + 1)
        emit(b, i, k + 1)
      } else {
        emit(b, i + 1, k + 1)
        emit(b, i + 1, k)
        emit(b, i, k)
        emit(b, i, k + 1)
        emit(b, i + 1, k + 1)
      }
    }
  }

  // 封口：从质心出发的扇形，法线沿放样方向朝外
  const cap = (slot: string, ring: number, neighbour: number): void => {
    const b = bucket(slot)
    const dir = new Vector3().subVectors(centers[ring], centers[neighbour]).normalize()
    if (options.flip) dir.negate()
    const c = centers[ring]
    for (let k = 0; k < m; k++) {
      const p = at(ring, k)
      const q = at(ring, k + 1)
      const front = VC.crossVectors(VA.subVectors(p, c), VB.subVectors(q, c)).dot(dir) > 0
      b.pos.push(c.x, c.y, c.z)
      b.nor.push(dir.x, dir.y, dir.z)
      b.col.push(1, 1, 1)
      emit(b, ring, front ? k : k + 1, dir)
      emit(b, ring, front ? k + 1 : k, dir)
    }
  }
  if (options.capStart) cap(options.capStart, 0, 1)
  if (options.capEnd) cap(options.capEnd, n - 1, n - 2)

  const out: GeometrySet = {}
  for (const [slot, b] of buckets) {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(b.pos, 3))
    g.setAttribute('normal', new Float32BufferAttribute(b.nor, 3))
    g.setAttribute('color', new Float32BufferAttribute(b.col, 3))
    out[slot] = g
  }
  return out
}

/** 轮胎截面（半径比例, 沿轴向的半宽比例）：胎圈 → 胎壁 → 胎肩 → 胎面（含一道纵向沟槽），另一半镜像 */
const TIRE_HALF: readonly (readonly [number, number])[] = [
  [0.62, -0.8],
  [0.7, -0.97],
  [0.84, -1],
  [0.95, -0.92],
  [1, -0.76],
  [1, -0.4],
  [0.962, -0.36],
  [0.962, -0.26],
  [1, -0.22],
]

/**
 * 轮胎（轴线沿 Z，中心在原点）：车削出胎壁、胎肩与带纵向沟槽的胎面，胎肩隔格起伏做出胎纹块，内圈闭合。
 * @param flat 大于 0 时把底部压扁这么多米（瘘胎），此时轮心应放在 radius - flat 的高度
 */
export function tireGeometry(radius: number, width: number, flat = 0, radial = 20): BufferGeometry {
  const hw = width / 2
  const half = TIRE_HALF.map(([r, y]): [number, number] => [r * radius, y * hw])
  const mirrored = half
    .slice()
    .reverse()
    .map(([r, y]): [number, number] => [r, -y])
  const profile = [...half, ...mirrored, half[0]]
  const g = lathe(profile, radial)
  const pos = g.getAttribute('position')
  const count = profile.length
  // 胎肩与胎面边缘隔一格缩进一点，形成横向胎纹块
  for (let i = 0; i <= radial; i++) {
    if (i % 2 === 0) continue
    for (const j of [3, 4, count - 6, count - 5]) {
      const v = i * count + j
      pos.setXYZ(v, pos.getX(v) * 0.972, pos.getY(v), pos.getZ(v) * 0.972)
    }
  }
  g.rotateX(HALF_PI)
  if (flat > 0) {
    const floor = -radius + flat
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      const squash = clamp01((floor + flat * 2 - y) / (flat * 2))
      if (squash <= 0) continue
      pos.setXYZ(i, pos.getX(i) * (1 + 0.06 * squash), Math.max(y, floor), pos.getZ(i) * (1 + 0.3 * squash))
    }
  }
  return g
}

/** 轮毂（轴线沿 Z，外侧朝 +Z）：盘形钢圈、中心盖与五颗螺母 */
export function rimGeometry(radius: number, width: number, radial = 20): BufferGeometry {
  const hw = width / 2
  const dish = lathe(
    [
      [0.66 * radius, 0.7 * hw],
      [0.6 * radius, 0.8 * hw],
      [0.55 * radius, 0.6 * hw],
      [0.47 * radius, 0.3 * hw],
      [0.2 * radius, 0.24 * hw],
      [0.15 * radius, 0.4 * hw],
      [0, 0.42 * hw],
    ],
    radial,
  )
  const parts = [dish.toNonIndexed()]
  dish.dispose()
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const nut = cylinder(0.035 * radius, 0.045 * radius, 0.12 * hw, 6).toNonIndexed()
    nut.translate(Math.cos(a) * 0.31 * radius, 0.3 * hw, Math.sin(a) * 0.31 * radius)
    parts.push(nut)
  }
  const g = mergeGeometries(parts, false)
  parts.forEach((p) => p.dispose())
  g.rotateX(HALF_PI)
  return g
}

/**
 * 往拼装器里加一只着地的车轮（轴线沿 Z）。
 * @param side 轮毂朝向：1 为 +Z，-1 为 -Z
 * @param flat 瘘胎的下沉量（米）
 */
export function addWheel(a: Assembly, tireSlot: string, rimSlot: string, x: number, z: number, radius: number, width: number, side: 1 | -1, flat = 0, radial = 16): void {
  const ry = side > 0 ? 0 : Math.PI
  a.add(tireSlot, tireGeometry(radius, width, flat, radial), x, radius - flat, z, 0, ry, 0)
  a.add(rimSlot, rimGeometry(radius, width, radial), x, radius - flat, z, 0, ry, 0)
}

/* ── 缓存与实例化 ── */

/**
 * 按 key 取一个道具的几何体；第一次调用时用 build 拼装，之后所有实例共享。
 * @param key 道具种类 + 影响形状的参数
 */
export function geometrySet(key: string, build: (a: Assembly) => void): GeometrySet {
  let set = geometrySets.get(key)
  if (!set) {
    const assembly = new Assembly()
    build(assembly)
    set = assembly.build()
    geometrySets.set(key, set)
  }
  return set
}

/** 按 key 缓存材质，并开启顶点色（Assembly 产出的几何体都带顶点色） */
export function material<T extends Material>(key: string, create: () => T): T {
  let m = materials.get(key)
  if (!m) {
    m = create()
    m.vertexColors = true
    materials.set(key, m)
  }
  return m as T
}

/**
 * 取一个缓存的 PBR 表面材质。贴图密度由几何体的盒式投影 UV 决定，这里一般不需要传 repeat。
 * @param variant 需要在同一组参数上再做二次设置（tweak）时，用它区分缓存
 */
export function surface(kind: SurfaceKind, options: SurfaceOptions = {}, variant = '', tweak?: (m: MeshStandardMaterial) => void): MeshStandardMaterial {
  return material(`${kind}:${JSON.stringify(options)}:${variant}`, () => {
    const m = createSurfaceMaterial(kind, options)
    if (tweak) tweak(m)
    return m
  })
}

/** 深色车窗 / 楼窗玻璃：不透明、低粗糙度，靠环境反射出效果；双面，从车内看也成立 */
export function glass(): MeshPhysicalMaterial {
  return material(
    'glass',
    () =>
      new MeshPhysicalMaterial({
        color: 0x141c20,
        roughness: 0.06,
        metalness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.3,
        side: DoubleSide,
      }),
  )
}

/** 蒙尘的透明玻璃（校车车窗）：半透明、不写深度，能看到车内 */
export function clearGlass(): MeshPhysicalMaterial {
  return material(
    'glass:clear',
    () =>
      new MeshPhysicalMaterial({
        color: 0x2a3a3c,
        roughness: 0.08,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        envMapIntensity: 1.5,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        side: DoubleSide,
      }),
  )
}

/** 灯罩（车灯、尾灯）：光滑的有色透镜，颜色由顶点色决定 */
export function lens(): MeshPhysicalMaterial {
  return material('lens', () => new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08 }))
}

/**
 * 按 key 缓存一张现画的画布贴图（可平铺）。
 * @param srgb 颜色图传 true；透明度 / 数据图传 false
 */
export function canvasTexture(
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  srgb = true,
): CanvasTexture {
  let texture = textures.get(key)
  if (!texture) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 2D 画布，道具贴图不可用')
    draw(ctx, width, height)
    texture = new CanvasTexture(canvas)
    texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.anisotropy = 8
    textures.set(key, texture)
  }
  return texture
}

/**
 * 用某个槽位的几何体创建网格并挂到 parent 下（槽位不存在则跳过）。
 * @param castShadow 是否投射阴影（玻璃等可关闭）
 */
export function addMesh(parent: Object3D, set: GeometrySet, slot: string, mat: Material, castShadow = true): Mesh | null {
  const geometry = set[slot]
  if (!geometry) return null
  const mesh = new Mesh(geometry, mat)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

/**
 * 把一个道具的各槽位几何体配上材质，装成 Group（每个槽位一个网格，全部接收阴影）。
 * @param mats 槽位名 → 材质；几何体里出现的槽位必须都有
 * @param noShadow 不投射阴影的槽位（球网、铁丝网等镂空薄片）
 */
export function assemble(set: GeometrySet, mats: Record<string, Material>, noShadow: readonly string[] = []): Group {
  const group = new Group()
  for (const slot of Object.keys(set)) {
    const mat = mats[slot]
    if (!mat) throw new Error(`道具槽位 ${slot} 没有对应的材质`)
    addMesh(group, set, slot, mat, !noShadow.includes(slot))
  }
  return group
}

/** 分段线性插值：keys 为按 x 升序的 [x, 值] */
export function keyed(keys: readonly (readonly [number, number])[], x: number): number {
  if (x <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, v0] = keys[i - 1]
      const [x1, v1] = keys[i]
      return v0 + ((v1 - v0) * (x - x0)) / (x1 - x0)
    }
  }
  return keys[keys.length - 1][1]
}

/**
 * 逐顶点上色（写入 color 属性，初始为白色；加入 Assembly 时还会再乘上 tint）。
 * 用来做污渍、叶丛的明暗层次等不值得单独开材质的变化。
 */
export function paintVertices(geometry: BufferGeometry, fn: (p: Vector3, out: Color) => void): BufferGeometry {
  const pos = geometry.getAttribute('position')
  const data = new Float32Array(pos.count * 3)
  const p = new Vector3()
  const c = new Color()
  for (let i = 0; i < pos.count; i++) {
    c.setRGB(1, 1, 1)
    fn(p.fromBufferAttribute(pos, i), c)
    data[i * 3] = c.r
    data[i * 3 + 1] = c.g
    data[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(data, 3))
  return geometry
}

/** 带分段的普通盒子（面上有顶点网格，可配合 paintVertices 做污渍渐变） */
export function gridBox(w: number, h: number, d: number, sx = 1, sy = 1, sz = 1): BufferGeometry {
  return new BoxGeometry(w, h, d, sx, sy, sz)
}

/** 平面片（位于 XY 平面，朝 +Z），自带 0..1 的 UV */
export function plane(w: number, h: number): BufferGeometry {
  return new PlaneGeometry(w, h)
}

/**
 * 镂空网的材质（球网、铁丝网）：网线画在 alphaMap 上，用半透明混合 + alphaTest 剔掉全透明像素；
 * 这样远处网线会自然淡出，而不是糊成一整片。不写深度、双面。
 * @param draw 在黑底上用白色画出网线（贴图可平铺）
 */
export function meshMaterial(key: string, color: number, metalness: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void): MeshStandardMaterial {
  return material(`mesh:${key}`, () => {
    const alphaMap = canvasTexture(
      `mesh:${key}`,
      128,
      128,
      (ctx, w) => {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, w)
        ctx.strokeStyle = '#fff'
        ctx.lineCap = 'square'
        draw(ctx, w)
      },
      false,
    )
    return new MeshStandardMaterial({
      color,
      alphaMap,
      alphaTest: 0.06,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      roughness: 0.6,
      metalness,
    })
  })
}

/** 释放工具箱缓存的全部几何体、材质与画布贴图（之后再调用生成器会重新创建） */
export function disposeKit(): void {
  geometrySets.forEach((set) => Object.values(set).forEach((g) => g.dispose()))
  geometrySets.clear()
  materials.forEach((m) => m.dispose())
  materials.clear()
  textures.forEach((t) => t.dispose())
  textures.clear()
}

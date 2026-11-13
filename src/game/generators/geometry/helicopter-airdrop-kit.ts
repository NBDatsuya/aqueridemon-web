/**
 * 直升机与空投箱共用的建模工具。
 *
 * 写实模型由上千个小零件组成，逐个建 Mesh 会产生上千次 draw call。这里的 MeshBuilder 把同一种材质的
 * 所有静态零件累加进一个 BufferGeometry（位置 / 法线 / UV / 顶点色），一个材质只画一次。
 * - 顶点色用来在同一个材质里区分不同颜色的零件（材质 color 保持白色，贴图 × 顶点色）。
 * - UV 默认按“盒式投影”生成：按三角形朝向选投影平面，1 个贴图周期对应 1 / uvScale 米，
 *   所以零件无论大小，贴图密度都一致。
 *
 * 这些工具只在模块级懒创建共享几何体时运行一次，内部可以随意分配临时对象。
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { Mesh } from 'three'

const TAU = Math.PI * 2

/** 三维点（米） */
export type Vec3 = readonly [number, number, number]

const matrix = new Matrix4()
const normalMatrix = new Matrix3()
const quaternion = new Quaternion()
const euler = new Euler()
const position = new Vector3()
const scale = new Vector3()
const va = new Vector3()
const vb = new Vector3()
const vc = new Vector3()
const vn = new Vector3()
const axisY = new Vector3(0, 1, 0)
const scratchColor = new Color()

let unitBox: BoxGeometry | null = null

/** 翼型截面上的一圈采样点：x 为弦向位置 0..1，y 为半厚度系数（乘以最大厚度） */
const AIRFOIL_X = [0, 0.02, 0.08, 0.2, 0.4, 0.68, 1] as const

/** NACA 对称翼型的厚度分布，返回值已归一化到最大厚度为 1（约在 30% 弦长处） */
function airfoilHalfThickness(x: number): number {
  const y = 0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x
  return (y / 0.1) * 0.5
}

/** 机翼 / 桨叶放样用的一个截面 */
export interface WingSection {
  /** 截面基准点（弦线上 pivot 位置处） */
  origin: Vec3
  /** 弦向单位向量：从前缘指向后缘 */
  chordDir: Vec3
  /** 厚度方向单位向量（上表面一侧） */
  thickDir: Vec3
  /** 弦长（米） */
  chord: number
  /** 最大厚度（米） */
  thickness: number
  /** 基准点在弦线上的位置 0..1，默认 0.25 */
  pivot?: number
  /** 该截面的顶点色，默认沿用当前颜色 */
  color?: number
}

/**
 * 单调三次插值（PCHIP）：穿过所有控制点、不产生过冲，相邻控制点等值时保持平直。
 * @param xs 自变量，严格递增
 * @param ys 对应的值
 * @returns 插值函数；超出范围时取端点值
 */
export function createCurve(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length
  const slopes: number[] = []
  const secants: number[] = []
  for (let i = 0; i < n - 1; i++) secants.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  for (let i = 0; i < n; i++) {
    if (i === 0) slopes.push(secants[0] ?? 0)
    else if (i === n - 1) slopes.push(secants[n - 2] ?? 0)
    else {
      const d0 = secants[i - 1]
      const d1 = secants[i]
      if (d0 * d1 <= 0) slopes.push(0)
      else {
        const h0 = xs[i] - xs[i - 1]
        const h1 = xs[i + 1] - xs[i]
        const w0 = 2 * h1 + h0
        const w1 = h1 + 2 * h0
        slopes.push((w0 + w1) / (w0 / d0 + w1 / d1))
      }
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (i < n - 2 && x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * slopes[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * slopes[i + 1]
    )
  }
}

/** 按材质累加零件的网格构建器 */
export class MeshBuilder {
  /** 贴图密度：每米多少个贴图周期（盒式投影与管、翼面的 UV 都用它） */
  uvScale = 1
  /** 不为 null 时，之后加入的顶点统一使用这个 UV（发光贴图取色块用） */
  fixedUv: readonly [number, number] | null = null

  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []
  private readonly colors: number[] = []
  private readonly indices: number[] = []
  private r = 1
  private g = 1
  private b = 1

  /** 已累加的三角形数 */
  get triangles(): number {
    return this.indices.length / 3
  }

  /** 是否还没有任何三角形 */
  get empty(): boolean {
    return this.indices.length === 0
  }

  /**
   * 设置之后加入的零件的顶点色。
   * @param hex sRGB 颜色（如 0x5f6f42）
   */
  tint(hex: number): this {
    scratchColor.set(hex)
    this.r = scratchColor.r
    this.g = scratchColor.g
    this.b = scratchColor.b
    return this
  }

  /** 加入一个顶点，返回它的序号 */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.positions.push(x, y, z)
    this.normals.push(nx, ny, nz)
    if (this.fixedUv) this.uvs.push(this.fixedUv[0], this.fixedUv[1])
    else this.uvs.push(u, v)
    this.colors.push(this.r, this.g, this.b)
    return this.positions.length / 3 - 1
  }

  /** 加入一个三角形（逆时针为正面） */
  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c)
  }

  /** 加入一个四边形 a-b-c-d（逆时针为正面） */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d)
  }

  /**
   * 加入一个平面四边形，顶点按逆时针给出，法线取面法线。UV 由调用方指定（贴花用）。
   * @param uv 四个顶点对应的贴图矩形 [u0, v0, u1, v1]：p0 取 (u0, v0)，p1 取 (u1, v0)，p2 取 (u1, v1)，p3 取 (u0, v1)
   */
  patch(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, uv: readonly [number, number, number, number]): void {
    va.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    vb.set(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2])
    vn.crossVectors(va, vb).normalize()
    const a = this.vertex(p0[0], p0[1], p0[2], vn.x, vn.y, vn.z, uv[0], uv[1])
    const b = this.vertex(p1[0], p1[1], p1[2], vn.x, vn.y, vn.z, uv[2], uv[1])
    const c = this.vertex(p2[0], p2[1], p2[2], vn.x, vn.y, vn.z, uv[2], uv[3])
    const d = this.vertex(p3[0], p3[1], p3[2], vn.x, vn.y, vn.z, uv[0], uv[3])
    this.quad(a, b, c, d)
  }

  /**
   * 加入一个平直着色的四边形（窗框侧壁、端面等），UV 按盒式投影。
   * @param facing 期望的朝向；四边形的面法线与它相反时自动翻转绕序
   */
  flat(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, facing: Vec3): void {
    va.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    vb.set(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2])
    vn.crossVectors(va, vb)
    if (vn.lengthSq() < 1e-14) {
      // p0 与 p1 或 p3 重合（退化成三角形）：改用对角的两条边
      va.set(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2])
      vb.set(p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2])
      vn.crossVectors(va, vb)
      if (vn.lengthSq() < 1e-14) return
    }
    vn.normalize()
    const reversed = vn.x * facing[0] + vn.y * facing[1] + vn.z * facing[2] < 0
    if (reversed) vn.negate()
    const ax = Math.abs(vn.x)
    const ay = Math.abs(vn.y)
    const az = Math.abs(vn.z)
    const plane = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
    const k = this.uvScale
    const add = (p: Vec3): number =>
      this.vertex(p[0], p[1], p[2], vn.x, vn.y, vn.z, (plane === 0 ? p[2] : p[0]) * k, (plane === 1 ? p[2] : p[1]) * k)
    const a = add(p0)
    const b = add(p1)
    const c = add(p2)
    const d = add(p3)
    if (reversed) this.quad(a, d, c, b)
    else this.quad(a, b, c, d)
  }

  /**
   * 把一个 three 几何体按矩阵变换后并入。UV 改用盒式投影；镜像矩阵会自动翻转绕序。
   * @param geometry 源几何体（不会被修改或释放）
   * @param transform 变换矩阵
   */
  append(geometry: BufferGeometry, transform: Matrix4): void {
    const pos = geometry.getAttribute('position')
    const nor = geometry.getAttribute('normal')
    const index = geometry.getIndex()
    const count = index ? index.count : pos.count
    const mirrored = transform.determinant() < 0
    normalMatrix.getNormalMatrix(transform)
    const k = this.uvScale

    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i
      let ib = index ? index.getX(i + 1) : i + 1
      let ic = index ? index.getX(i + 2) : i + 2
      if (mirrored) {
        const swap = ib
        ib = ic
        ic = swap
      }
      va.fromBufferAttribute(pos, ia).applyMatrix4(transform)
      vb.fromBufferAttribute(pos, ib).applyMatrix4(transform)
      vc.fromBufferAttribute(pos, ic).applyMatrix4(transform)
      // 面法线决定投影平面
      const fx = (vb.y - va.y) * (vc.z - va.z) - (vb.z - va.z) * (vc.y - va.y)
      const fy = (vb.z - va.z) * (vc.x - va.x) - (vb.x - va.x) * (vc.z - va.z)
      const fz = (vb.x - va.x) * (vc.y - va.y) - (vb.y - va.y) * (vc.x - va.x)
      const ax = Math.abs(fx)
      const ay = Math.abs(fy)
      const az = Math.abs(fz)
      const plane = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2

      const base = this.positions.length / 3
      const corners = [va, vb, vc]
      const ids = [ia, ib, ic]
      for (let c = 0; c < 3; c++) {
        const p = corners[c]
        vn.fromBufferAttribute(nor, ids[c]).applyMatrix3(normalMatrix).normalize()
        const u = plane === 0 ? p.z : p.x
        const v = plane === 1 ? p.z : p.y
        this.vertex(p.x, p.y, p.z, vn.x, vn.y, vn.z, u * k, v * k)
      }
      this.indices.push(base, base + 1, base + 2)
    }
  }

  /** 并入一个临时几何体，然后释放它 */
  consume(geometry: BufferGeometry, transform: Matrix4): void {
    this.append(geometry, transform)
    geometry.dispose()
  }

  /**
   * 长方体：中心 (x, y, z)，尺寸 (sx, sy, sz)，可选欧拉旋转（XYZ 顺序）。
   */
  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    if (!unitBox) unitBox = new BoxGeometry(1, 1, 1)
    quaternion.setFromEuler(euler.set(rx, ry, rz))
    matrix.compose(position.set(x, y, z), quaternion, scale.set(sx, sy, sz))
    this.append(unitBox, matrix)
  }

  /**
   * 从 from 到 to 的方梁：width 沿“侧向”，height 沿 up 提示方向（会被修正为垂直于梁）。
   * @param up 高度方向的提示，默认 +Y；与梁平行时自动改用 +X
   */
  beam(from: Vec3, to: Vec3, width: number, height: number, up: Vec3 = [0, 1, 0]): void {
    if (!unitBox) unitBox = new BoxGeometry(1, 1, 1)
    va.set(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    const length = va.length()
    va.divideScalar(length)
    vb.set(up[0], up[1], up[2])
    vb.addScaledVector(va, -vb.dot(va))
    if (vb.lengthSq() < 1e-8) {
      vb.set(1, 0, 0)
      vb.addScaledVector(va, -vb.dot(va))
    }
    vb.normalize()
    vc.crossVectors(va, vb)
    // 列向量：本地 X = 侧向，本地 Y = 梁方向，本地 Z = 高度方向
    matrix.makeBasis(vc, va, vb)
    matrix.scale(scale.set(width, length, height))
    matrix.setPosition((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2)
    this.append(unitBox, matrix)
  }

  /**
   * 从 from 到 to 的圆杆或圆台。
   * @param radius0 from 端半径
   * @param radius1 to 端半径，默认与 radius0 相同
   * @param segments 圆周分段数
   * @param capped 两端是否封口
   */
  rod(from: Vec3, to: Vec3, radius0: number, radius1 = radius0, segments = 8, capped = true): void {
    va.set(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    const length = va.length()
    quaternion.setFromUnitVectors(axisY, va.divideScalar(length))
    matrix.compose(
      position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2),
      quaternion,
      scale.set(1, length, 1),
    )
    this.consume(new CylinderGeometry(radius1, radius0, 1, segments, 1, !capped), matrix)
  }

  /**
   * 椭球：中心 (x, y, z)，三个半轴 (rx, ry, rz)。
   * @param thetaLength 纬度范围（从 +Y 极点起算），默认整球；取 PI / 2 得到上半球
   */
  ball(
    rx: number,
    ry: number,
    rz: number,
    x: number,
    y: number,
    z: number,
    widthSegments = 10,
    heightSegments = 6,
    thetaLength = Math.PI,
  ): void {
    matrix.compose(position.set(x, y, z), quaternion.identity(), scale.set(rx, ry, rz))
    this.consume(new SphereGeometry(1, widthSegments, heightSegments, 0, TAU, 0, thetaLength), matrix)
  }

  /**
   * 圆环：中心 (x, y, z)，默认躺在本地 XY 平面内，再按欧拉角旋转。
   * @param radius 环半径
   * @param tube 管半径
   */
  ring(
    radius: number,
    tube: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    radialSegments = 6,
    tubularSegments = 14,
    arc = TAU,
  ): void {
    quaternion.setFromEuler(euler.set(rx, ry, rz))
    matrix.compose(position.set(x, y, z), quaternion, scale.set(1, 1, 1))
    this.consume(new TorusGeometry(radius, tube, radialSegments, tubularSegments, arc), matrix)
  }

  /**
   * 沿折线扫出的圆管（线缆、把手、弯管）。相邻段之间用平行移动的截面框架，不会扭转。
   * @param points 折线顶点（至少 2 个）
   * @param radius 管半径
   * @param segments 圆周分段数
   * @param capped 两端是否封口
   */
  tube(points: readonly Vec3[], radius: number, segments = 6, capped = true): void {
    const n = points.length
    const tangent = new Vector3()
    const normal = new Vector3()
    const binormal = new Vector3()
    const previous = new Vector3()
    const rings: number[] = []
    let travelled = 0

    for (let i = 0; i < n; i++) {
      const p = points[i]
      const before = points[Math.max(0, i - 1)]
      const after = points[Math.min(n - 1, i + 1)]
      tangent.set(after[0] - before[0], after[1] - before[1], after[2] - before[2]).normalize()
      if (i === 0) {
        // 起始框架：任取一个不与切线平行的方向
        normal.set(0, 1, 0)
        if (Math.abs(tangent.y) > 0.9) normal.set(1, 0, 0)
        normal.addScaledVector(tangent, -normal.dot(tangent)).normalize()
      } else {
        // 把上一圈的法线投影到新的截面内
        normal.addScaledVector(tangent, -normal.dot(tangent)).normalize()
        travelled += Math.hypot(p[0] - previous.x, p[1] - previous.y, p[2] - previous.z)
      }
      previous.set(p[0], p[1], p[2])
      binormal.crossVectors(tangent, normal)

      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * TAU
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const nx = normal.x * cos + binormal.x * sin
        const ny = normal.y * cos + binormal.y * sin
        const nz = normal.z * cos + binormal.z * sin
        rings.push(
          this.vertex(
            p[0] + nx * radius,
            p[1] + ny * radius,
            p[2] + nz * radius,
            nx,
            ny,
            nz,
            (s / segments) * TAU * radius * this.uvScale,
            travelled * this.uvScale,
          ),
        )
      }

      if (capped && (i === 0 || i === n - 1)) {
        const sign = i === 0 ? -1 : 1
        const center = this.vertex(p[0], p[1], p[2], tangent.x * sign, tangent.y * sign, tangent.z * sign, 0, 0)
        const first = rings.length - (segments + 1)
        for (let s = 0; s < segments; s++) {
          const a = this.vertex(
            this.positions[rings[first + s] * 3],
            this.positions[rings[first + s] * 3 + 1],
            this.positions[rings[first + s] * 3 + 2],
            tangent.x * sign,
            tangent.y * sign,
            tangent.z * sign,
            0,
            0,
          )
          const b = this.vertex(
            this.positions[rings[first + s + 1] * 3],
            this.positions[rings[first + s + 1] * 3 + 1],
            this.positions[rings[first + s + 1] * 3 + 2],
            tangent.x * sign,
            tangent.y * sign,
            tangent.z * sign,
            0,
            0,
          )
          if (i === 0) this.tri(center, b, a)
          else this.tri(center, a, b)
        }
      }
    }

    const stride = segments + 1
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const a = rings[i * stride + s]
        const b = rings[i * stride + s + 1]
        const c = rings[(i + 1) * stride + s + 1]
        const d = rings[(i + 1) * stride + s]
        // 截面按 normal → binormal 方向绕行，binormal = tangent × normal，所以朝外的绕序是 a-b-c-d
        this.quad(a, b, c, d)
      }
    }
  }

  /**
   * 沿若干截面放样出对称翼型（桨叶、平尾、垂尾）。相邻截面之间连成蒙皮，可选两端封口。
   * @param sections 截面列表（至少 2 个），按展向顺序排列
   * @param capStart 是否封住第一个截面
   * @param capEnd 是否封住最后一个截面
   */
  wing(sections: readonly WingSection[], capStart = true, capEnd = true): void {
    const loop = AIRFOIL_X.length * 2
    const rings: number[] = []
    const savedR = this.r
    const savedG = this.g
    const savedB = this.b
    const first = sections[0]
    const last = sections[sections.length - 1]

    // 截面绕行方向与展向的手性决定三角形绕序
    va.set(first.chordDir[0], first.chordDir[1], first.chordDir[2])
    vb.set(first.thickDir[0], first.thickDir[1], first.thickDir[2])
    vc.crossVectors(va, vb)
    const spanSign =
      vc.x * (last.origin[0] - first.origin[0]) +
      vc.y * (last.origin[1] - first.origin[1]) +
      vc.z * (last.origin[2] - first.origin[2])
    const flip = spanSign > 0

    let span = 0
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]
      if (s.color !== undefined) this.tint(s.color)
      if (i > 0) {
        const prev = sections[i - 1]
        span += Math.hypot(s.origin[0] - prev.origin[0], s.origin[1] - prev.origin[1], s.origin[2] - prev.origin[2])
      }
      const pivot = s.pivot ?? 0.25
      for (let k = 0; k < loop; k++) {
        // 前半圈：上表面从前缘到后缘；后半圈：下表面从后缘回到前缘
        const upper = k < AIRFOIL_X.length
        const xi = upper ? k : loop - 1 - k
        const x = AIRFOIL_X[xi]
        const side = upper ? 1 : -1
        const y = airfoilHalfThickness(x) * side
        // 切线取同一表面上相邻采样点的差分
        const x0 = AIRFOIL_X[Math.max(0, xi - 1)]
        const x1 = AIRFOIL_X[Math.min(AIRFOIL_X.length - 1, xi + 1)]
        const dx = (x1 - x0) * s.chord
        const dy = (airfoilHalfThickness(x1) - airfoilHalfThickness(x0)) * s.thickness
        // 上表面外法线 (-dy, dx)，下表面关于弦线镜像
        let nc = -dy
        let nt = dx * side
        if (xi === 0) {
          nc = -1
          nt = 0
        }
        const inv = 1 / Math.hypot(nc, nt)
        nc *= inv
        nt *= inv
        const along = (x - pivot) * s.chord
        const off = y * s.thickness
        rings.push(
          this.vertex(
            s.origin[0] + s.chordDir[0] * along + s.thickDir[0] * off,
            s.origin[1] + s.chordDir[1] * along + s.thickDir[1] * off,
            s.origin[2] + s.chordDir[2] * along + s.thickDir[2] * off,
            s.chordDir[0] * nc + s.thickDir[0] * nt,
            s.chordDir[1] * nc + s.thickDir[1] * nt,
            s.chordDir[2] * nc + s.thickDir[2] * nt,
            (upper ? x : 2 - x) * s.chord * this.uvScale,
            span * this.uvScale,
          ),
        )
      }
    }

    for (let i = 0; i < sections.length - 1; i++) {
      for (let k = 0; k < loop - 1; k++) {
        // 跳过前缘 / 后缘处的重合点（上、下表面各有一份）
        if (k === AIRFOIL_X.length - 1) continue
        const a = rings[i * loop + k]
        const b = rings[i * loop + k + 1]
        const c = rings[(i + 1) * loop + k + 1]
        const d = rings[(i + 1) * loop + k]
        if (flip) this.quad(a, d, c, b)
        else this.quad(a, b, c, d)
      }
    }

    const cap = (index: number, outward: number): void => {
      const s = sections[index]
      if (s.color !== undefined) this.tint(s.color)
      // 端面法线沿展向
      const nx = vc.x * outward
      const ny = vc.y * outward
      const nz = vc.z * outward
      const ids: number[] = []
      for (let k = 0; k < loop; k++) {
        const src = rings[index * loop + k] * 3
        ids.push(this.vertex(this.positions[src], this.positions[src + 1], this.positions[src + 2], nx, ny, nz, 0, 0))
      }
      // 上、下表面的对应点两两相连成条带
      for (let k = 0; k < AIRFOIL_X.length - 1; k++) {
        const a = ids[k]
        const b = ids[k + 1]
        const c = ids[loop - 2 - k]
        const d = ids[loop - 1 - k]
        if (outward > 0) this.quad(a, d, c, b)
        else this.quad(a, b, c, d)
      }
    }
    // vc = chordDir × thickDir；端面朝外的方向取决于它与展向的夹角
    if (capStart) cap(0, flip ? -1 : 1)
    if (capEnd) cap(sections.length - 1, flip ? 1 : -1)

    this.r = savedR
    this.g = savedG
    this.b = savedB
  }

  /** 生成合并后的几何体（带 position / normal / uv / color 与索引） */
  build(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3))
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2))
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3))
    geometry.setIndex(this.indices)
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
    return geometry
  }
}

/** 一张画布及其 2D 上下文 */
export interface DrawSurface {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/**
 * 创建一张离屏画布（贴花、标识都现画在上面）。
 * @param width 宽（像素）
 * @param height 高（像素）
 */
export function createDrawSurface(width: number, height: number): DrawSurface {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 2D 画布，贴花不可用')
  return { canvas, ctx }
}

/**
 * 把画布包装成颜色贴图（sRGB，开启各向异性过滤）。
 * @param canvas 已画好的画布
 */
export function createCanvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

/**
 * 让网格参与实时阴影。
 * @param mesh 目标网格
 * @param cast 是否投射阴影（玻璃、贴花、桨盘残影传 false）
 */
export function enableShadows(mesh: Mesh, cast = true): void {
  mesh.castShadow = cast
  mesh.receiveShadow = true
}

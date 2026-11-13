/**
 * 武器建模工具：侧面轮廓挤出（带倒角）、截面放样、车削、圆杆、倒角方块，以及按材质分层合并。
 *
 * 坐标约定与 weapon.ts 一致：枪管朝 +Z，+Y 向上，枪的左侧是 +X。
 * 侧视图里的点一律写成 [z, y]。
 *
 * 每个零件在加入图层时统一重算法线与 UV：
 * - 法线：同一位置上夹角小于折痕角的面按面积加权平均，倒角因此呈现为连续的圆边高光，大平面仍保持平整；
 * - UV：按三角面朝向做盒式投影，单位是米 × 密度，U 始终沿枪身长度方向（木纹、拉丝方向）。
 */

import { BufferAttribute, BufferGeometry, ExtrudeGeometry, Path, Quaternion, Shape, TorusGeometry, Vector2, Vector3 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { SurfaceKind, SurfaceOptions } from '../textures/pbr'

/** 侧视图上的点 [z, y] */
export type Pt = readonly [number, number]
/** 带圆角的轮廓点 [z, y, 圆角切距]，切距缺省为 0（尖角） */
export type CornerPt = readonly [number, number, number?]
/** 空间点 [x, y, z] */
export type Vec3 = readonly [number, number, number]

/** 一个材质图层：合并后的几何体与创建材质所需的参数 */
export interface WeaponLayer {
  kind: SurfaceKind
  options: SurfaceOptions
  geometry: BufferGeometry
}

/** 一把枪的模型蓝图：若干材质图层与枪口位置。几何体由同型号的所有实例共享 */
export interface WeaponBlueprint {
  layers: WeaponLayer[]
  /** 枪口在 root 本地空间的位置 [z, y]（x 恒为 0） */
  muzzle: Pt
}

/* ── 轮廓 ── */

/**
 * 把带圆角的控制点展开成多边形轮廓。
 * @param points 控制点 [z, y, 切距]：切距大于 0 的角用二次曲线抹圆
 * @param segments 每个圆角的分段数（1 即斜切）
 */
export function outline(points: readonly CornerPt[], segments = 3): Pt[] {
  const out: Pt[] = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const [z, y, r = 0] = points[i]
    if (r <= 0) {
      out.push([z, y])
      continue
    }
    const prev = points[(i + n - 1) % n]
    const next = points[(i + 1) % n]
    const ax = prev[0] - z
    const ay = prev[1] - y
    const bx = next[0] - z
    const by = next[1] - y
    const al = Math.hypot(ax, ay)
    const bl = Math.hypot(bx, by)
    const d = Math.min(r, al * 0.45, bl * 0.45)
    const sz = z + (ax / al) * d
    const sy = y + (ay / al) * d
    const ez = z + (bx / bl) * d
    const ey = y + (by / bl) * d
    for (let k = 0; k <= segments; k++) {
      const t = k / segments
      const u = 1 - t
      out.push([u * u * sz + 2 * u * t * z + t * t * ez, u * u * sy + 2 * u * t * y + t * t * ey])
    }
  }
  return out
}

/**
 * 长圆孔（两端半圆）轮廓，用作散热孔等。
 * @param segments 每个半圆的分段数
 */
export function slot(z0: number, z1: number, y0: number, y1: number, segments = 4): Pt[] {
  const r = Math.min((y1 - y0) / 2, (z1 - z0) / 2)
  const cy = (y0 + y1) / 2
  const out: Pt[] = []
  for (let k = 0; k <= segments; k++) {
    const a = -Math.PI / 2 + (k / segments) * Math.PI
    out.push([z1 - r + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  for (let k = 0; k <= segments; k++) {
    const a = Math.PI / 2 + (k / segments) * Math.PI
    out.push([z0 + r + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return out
}

/**
 * 矩形轮廓，四角可抹圆。
 * @param r 圆角切距，默认 0（尖角）
 */
export function rect(z0: number, z1: number, y0: number, y1: number, r = 0): Pt[] {
  return outline(
    [
      [z0, y0, r],
      [z1, y0, r],
      [z1, y1, r],
      [z0, y1, r],
    ],
    2,
  )
}

/**
 * 沿圆弧的带状轮廓（弧形弹匣）：圆心 [cz, cy]，半径 r0..r1，角度 a0..a1。
 * 角度从圆心指向 -Z 方向起算，增大时向下转（见 arcPoint）。
 */
export function arcBand(cz: number, cy: number, r0: number, r1: number, a0: number, a1: number, segments = 8): Pt[] {
  const out: Pt[] = []
  for (let k = 0; k <= segments; k++) out.push(arcPoint(cz, cy, r1, a0 + ((a1 - a0) * k) / segments))
  for (let k = segments; k >= 0; k--) out.push(arcPoint(cz, cy, r0, a0 + ((a1 - a0) * k) / segments))
  return out
}

/** 圆弧上的点：角度 0 在圆心正后方（-Z），增大时向下转 */
export function arcPoint(cz: number, cy: number, radius: number, angle: number): Pt {
  return [cz - Math.cos(angle) * radius, cy - Math.sin(angle) * radius]
}

/* ── 基本体 ── */

export interface ProfileOptions {
  /** 倒角宽度，默认 1mm；0 为不倒角 */
  bevel?: number
  /** 倒角分段数，默认 1（法线平滑后已呈圆边）；握把等大圆边可加大 */
  bevelSegments?: number
  /** 挤出体中心的 X 偏移，默认 0 */
  x?: number
  /** 贯穿的孔 */
  holes?: readonly (readonly Pt[])[]
}

/**
 * 把侧面轮廓沿 X 方向挤出成厚度为 width 的实体，棱边带倒角。
 * @param points 侧视图轮廓 [z, y]，顺逆时针均可
 * @param width 总厚度（含倒角）
 */
export function profile(points: readonly Pt[], width: number, options: ProfileOptions = {}): BufferGeometry {
  const bevel = Math.min(options.bevel ?? 0.001, width * 0.45)
  // 外轮廓统一成逆时针：ExtrudeGeometry 只在这种情况下才会顺带校正孔的绕向
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    area += p[0] * q[1] - q[0] * p[1]
  }
  const contour = area < 0 ? [...points].reverse() : points
  const shape = new Shape(contour.map(([z, y]) => new Vector2(z, y)))
  for (const hole of options.holes ?? []) shape.holes.push(new Path(hole.map(([z, y]) => new Vector2(z, y))))
  const depth = width - bevel * 2
  const geo = new ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    // 轮廓先内缩再倒角，外形尺寸与给定轮廓一致
    bevelOffset: -bevel,
    bevelSegments: options.bevelSegments ?? 1,
  })
  geo.translate(0, 0, -depth / 2)
  // 形状的 x → 枪的 Z，挤出方向 → 枪的 X
  geo.rotateY(-Math.PI / 2)
  if (options.x) geo.translate(options.x, 0, 0)
  return geo
}

/**
 * 各棱都带倒角的方块，中心在 (x, y, z)。
 * @param sx 宽（X）
 * @param sy 高（Y）
 * @param sz 长（Z）
 */
export function box(sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, bevel = 0.001): BufferGeometry {
  const hz = sz / 2
  const hy = sy / 2
  const cut = Math.min(bevel, hz * 0.6, hy * 0.6)
  const points = outline(
    [
      [-hz, -hy, cut],
      [hz, -hy, cut],
      [hz, hy, cut],
      [-hz, hy, cut],
    ],
    1,
  )
  return profile(points, sx, { bevel: cut }).translate(x, y, z)
}

/** 放样截面：超椭圆环 */
export interface Section {
  /** 沿放样轴的位置 */
  t: number
  /** 截面中心（轴为 z 时是 y，轴为 y 时是 z） */
  c: number
  /** 截面在侧视图平面内的半径 */
  a: number
  /** 截面的半宽（X） */
  w: number
  /** 超椭圆指数：2 为椭圆，越大越接近矩形 */
  n?: number
  /** 顶部相对底部的宽度比（梯形截面），默认 1 */
  taper?: number
}

export interface LoftOptions {
  /** 放样轴，默认 'z' */
  axis?: 'z' | 'y'
  /** 环向分段数，默认 16 */
  segments?: number
  /** 端面封口，默认两端都封 */
  caps?: 'both' | 'none' | 'start' | 'end'
  /** X 偏移，默认 0 */
  x?: number
}

/** 用下沿 / 上沿写一个截面（轴为 z 时即 y 的范围） */
export function sec(t: number, lo: number, hi: number, w: number, n = 2.6, taper?: number): Section {
  return { t, c: (lo + hi) / 2, a: (hi - lo) / 2, w, n, taper }
}

/**
 * 把一串截面环连成表面。截面沿轴的位置递增时表面朝外；
 * 位置回退的一段朝内（用来做枪口内膛），位置不变而半径变化的一段是台阶端面。
 */
export function loft(sections: readonly Section[], options: LoftOptions = {}): BufferGeometry {
  const seg = options.segments ?? 16
  const axisY = options.axis === 'y'
  const caps = options.caps ?? 'both'
  const x0 = options.x ?? 0

  const rings: number[][] = []
  for (const s of sections) {
    const e = 2 / (s.n ?? 2)
    const ring: number[] = []
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2
      const cs = Math.cos(th)
      const sn = Math.sin(th)
      const sx = Math.sign(cs) * Math.abs(cs) ** e
      const sy = Math.sign(sn) * Math.abs(sn) ** e
      const taper = s.taper === undefined ? 1 : 1 + (s.taper - 1) * (sy + 1) * 0.5
      ring.push(x0 + s.w * sx * taper, s.c + s.a * sy)
    }
    rings.push(ring)
  }

  const out: number[] = []
  // 顶点写成 (横向, 面内, 轴向)；轴为 y 时交换后两个分量并翻转绕序
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    if (axisY) out.push(a[0], a[2], a[1], c[0], c[2], c[1], b[0], b[2], b[1])
    else out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
  }
  const at = (i: number, k: number): Vec3 => {
    const ring = rings[i]
    const j = (k % seg) * 2
    return [ring[j], ring[j + 1], sections[i].t]
  }

  for (let i = 0; i + 1 < sections.length; i++) {
    for (let k = 0; k < seg; k++) {
      const a = at(i, k)
      const b = at(i, k + 1)
      const c = at(i + 1, k)
      const d = at(i + 1, k + 1)
      tri(a, b, c)
      tri(b, d, c)
    }
  }
  const last = sections.length - 1
  if (caps === 'both' || caps === 'start') {
    const center: Vec3 = [x0, sections[0].c, sections[0].t]
    for (let k = 0; k < seg; k++) tri(center, at(0, k + 1), at(0, k))
  }
  if (caps === 'both' || caps === 'end') {
    const center: Vec3 = [x0, sections[last].c, sections[last].t]
    for (let k = 0; k < seg; k++) tri(center, at(last, k), at(last, k + 1))
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(out), 3))
  return geo
}

/**
 * 车削体：轴线平行于 Z，高度 y。
 * @param path 母线 [z, 半径]，z 递增的一段朝外，回退的一段朝内（内膛）
 */
export function lathe(
  path: readonly Pt[],
  y: number,
  x = 0,
  segments = 16,
  caps: LoftOptions['caps'] = 'both',
): BufferGeometry {
  return loft(
    path.map(([z, r]) => ({ t: z, c: y, a: r, w: r })),
    { segments, x, caps },
  )
}

/**
 * 两端开口、带壁厚的空心圆筒（准星护圈、套箍），外棱带小倒角。
 * @param outer 外半径
 * @param inner 内半径
 */
export function shell(
  outer: number,
  inner: number,
  z0: number,
  z1: number,
  y: number,
  x = 0,
  segments = 16,
): BufferGeometry {
  const cut = Math.min(0.0008, (outer - inner) * 0.4, (z1 - z0) * 0.3)
  return lathe(
    [
      [z0, inner],
      [z0, outer - cut],
      [z0 + cut, outer],
      [z1 - cut, outer],
      [z1, outer - cut],
      [z1, inner],
      [z0, inner],
    ],
    y,
    x,
    segments,
    'none',
  )
}

/** 沿 Z 的圆管：从 z0 到 z1，轴线高度 y */
export function tube(radius: number, z0: number, z1: number, y: number, x = 0, segments = 16): BufferGeometry {
  return lathe(
    [
      [z0, radius],
      [z1, radius],
    ],
    y,
    x,
    segments,
  )
}

/**
 * 任意朝向的圆杆。
 * @param endRadius 末端半径，默认与起点相同（不同则为锥杆）
 */
export function rod(radius: number, from: Vec3, to: Vec3, segments = 10, endRadius = radius): BufferGeometry {
  const dir = new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  const length = dir.length()
  const geo = lathe(
    [
      [0, radius],
      [length, endRadius],
    ],
    0,
    0,
    segments,
  )
  geo.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir.normalize()))
  return geo.translate(from[0], from[1], from[2])
}

/**
 * 圆环（背带环、准星护圈）。
 * @param axis 圆环所绕的轴
 */
export function ring(
  radius: number,
  thickness: number,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z' = 'z',
  tubular = 20,
  radial = 8,
): BufferGeometry {
  const geo = new TorusGeometry(radius, thickness, radial, tubular)
  if (axis === 'x') geo.rotateY(Math.PI / 2)
  else if (axis === 'y') geo.rotateX(Math.PI / 2)
  return geo.translate(x, y, z)
}

/** 把 z ≥ zFrom 的顶点按高度前后错开：z += (y0 - y) × k（斜切枪口） */
export function shear(geo: BufferGeometry, zFrom: number, y0: number, k: number): BufferGeometry {
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z >= zFrom) pos.setZ(i, z + (y0 - pos.getY(i)) * k)
  }
  pos.needsUpdate = true
  return geo
}

/** 木纹方向在侧视图上为 (dz, dy) 时对应的 grain 角 */
export function grainAlong(dz: number, dy: number): number {
  return Math.atan2(-dy, dz)
}

/* ── 法线与 UV ── */

/** 折痕角的余弦：夹角小于约 50° 的相邻面平滑过渡（45° 倒角被抹圆，90° 直角保持硬边） */
const CREASE_COS = Math.cos((50 * Math.PI) / 180)
/** 顶点焊接精度：0.05mm */
const WELD = 2e4

/**
 * 把零件转成带法线与 UV 的非索引几何体。
 * @param density 贴图密度 [沿枪身方向, 垂直方向]，单位 次/米
 * @param grain 贴图 U 方向相对 +Z 绕 X 轴的转角（握把等斜向木件）
 */
function finishPart(part: BufferGeometry, density: readonly [number, number], grain: number): BufferGeometry {
  const source = part.index ? part.toNonIndexed() : part
  const pos = source.getAttribute('position')
  const triCount = Math.floor(pos.count / 3)

  // 收集有效三角面：顶点、面积加权法线、单位法线
  const verts = new Float32Array(triCount * 9)
  const weighted = new Float32Array(triCount * 3)
  const unit = new Float32Array(triCount * 3)
  let count = 0
  for (let t = 0; t < triCount; t++) {
    const i = t * 3
    const ax = pos.getX(i)
    const ay = pos.getY(i)
    const az = pos.getZ(i)
    const ux = pos.getX(i + 1) - ax
    const uy = pos.getY(i + 1) - ay
    const uz = pos.getZ(i + 1) - az
    const vx = pos.getX(i + 2) - ax
    const vy = pos.getY(i + 2) - ay
    const vz = pos.getZ(i + 2) - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    // 丢弃退化面（车削体收到轴线上的那一圈）
    if (len < 1e-12) continue
    const o = count * 9
    verts[o] = ax
    verts[o + 1] = ay
    verts[o + 2] = az
    verts[o + 3] = ax + ux
    verts[o + 4] = ay + uy
    verts[o + 5] = az + uz
    verts[o + 6] = ax + vx
    verts[o + 7] = ay + vy
    verts[o + 8] = az + vz
    weighted[count * 3] = nx
    weighted[count * 3 + 1] = ny
    weighted[count * 3 + 2] = nz
    unit[count * 3] = nx / len
    unit[count * 3 + 1] = ny / len
    unit[count * 3 + 2] = nz / len
    count++
  }

  // 按位置归并：每个位置记下共用它的三角面
  const shared = new Map<number, number[]>()
  const keys = new Float64Array(count * 3)
  for (let v = 0; v < count * 3; v++) {
    const qx = Math.round(verts[v * 3] * WELD) + 50000
    const qy = Math.round(verts[v * 3 + 1] * WELD) + 50000
    const qz = Math.round(verts[v * 3 + 2] * WELD) + 50000
    const key = (qx * 100000 + qy) * 100000 + qz
    keys[v] = key
    const list = shared.get(key)
    const face = Math.floor(v / 3)
    if (list) list.push(face)
    else shared.set(key, [face])
  }

  const normals = new Float32Array(count * 9)
  const uvs = new Float32Array(count * 6)
  const cg = Math.cos(grain)
  const sg = Math.sin(grain)
  for (let t = 0; t < count; t++) {
    const fx = unit[t * 3]
    const fy = unit[t * 3 + 1]
    const fz = unit[t * 3 + 2]
    // 转到木纹坐标系后选投影轴
    const gy = fy * cg + fz * sg
    const gz = -fy * sg + fz * cg
    const dominant = Math.abs(fx) >= Math.abs(gy) && Math.abs(fx) >= Math.abs(gz) ? 0 : Math.abs(gy) >= Math.abs(gz) ? 1 : 2
    for (let j = 0; j < 3; j++) {
      const v = t * 3 + j
      let nx = 0
      let ny = 0
      let nz = 0
      const list = shared.get(keys[v])
      if (list) {
        for (const other of list) {
          const ox = unit[other * 3]
          const oy = unit[other * 3 + 1]
          const oz = unit[other * 3 + 2]
          if (ox * fx + oy * fy + oz * fz < CREASE_COS) continue
          nx += weighted[other * 3]
          ny += weighted[other * 3 + 1]
          nz += weighted[other * 3 + 2]
        }
      }
      const len = Math.hypot(nx, ny, nz)
      if (len > 0) {
        normals[v * 3] = nx / len
        normals[v * 3 + 1] = ny / len
        normals[v * 3 + 2] = nz / len
      } else {
        normals[v * 3] = fx
        normals[v * 3 + 1] = fy
        normals[v * 3 + 2] = fz
      }

      const px = verts[v * 3]
      const py = verts[v * 3 + 1] * cg + verts[v * 3 + 2] * sg
      const pz = -verts[v * 3 + 1] * sg + verts[v * 3 + 2] * cg
      if (dominant === 0) {
        uvs[v * 2] = pz * density[0]
        uvs[v * 2 + 1] = py * density[1]
      } else if (dominant === 1) {
        uvs[v * 2] = pz * density[0]
        uvs[v * 2 + 1] = px * density[1]
      } else {
        uvs[v * 2] = px * density[0]
        uvs[v * 2 + 1] = py * density[1]
      }
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(verts.slice(0, count * 9), 3))
  geo.setAttribute('normal', new BufferAttribute(normals, 3))
  geo.setAttribute('uv', new BufferAttribute(uvs, 2))
  if (source !== part) source.dispose()
  return geo
}

/* ── 图层 ── */

/** 同一材质的零件集合 */
export interface LayerBuilder {
  /** 加入零件（零件会被消耗掉，不要再使用） */
  add(...parts: BufferGeometry[]): void
  /** 加入贴图方向需要转动的零件，grain 见 grainAlong */
  addGrain(grain: number, ...parts: BufferGeometry[]): void
  /** 合并成一个几何体 */
  build(): WeaponLayer
}

/**
 * 新建一个材质图层。
 * @param kind 表面种类
 * @param options 材质参数（每个武器实例据此各建一份材质）
 * @param density 贴图密度 [沿枪身方向, 垂直方向]，单位 次/米
 */
export function createLayer(
  kind: SurfaceKind,
  options: SurfaceOptions = {},
  density: readonly [number, number] = [6, 6],
): LayerBuilder {
  const parts: BufferGeometry[] = []
  const addGrain = (grain: number, ...list: BufferGeometry[]): void => {
    for (const part of list) {
      parts.push(finishPart(part, density, grain))
      part.dispose()
    }
  }
  return {
    add: (...list) => addGrain(0, ...list),
    addGrain,
    build() {
      const merged = mergeGeometries(parts, false)
      if (!merged) throw new Error('武器图层合并失败：没有可合并的零件')
      for (const part of parts) part.dispose()
      parts.length = 0
      merged.computeBoundingBox()
      merged.computeBoundingSphere()
      return { kind, options, geometry: merged }
    },
  }
}

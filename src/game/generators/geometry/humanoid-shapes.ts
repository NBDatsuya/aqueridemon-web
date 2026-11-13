/**
 * 人形模型的共享几何体：头、躯干、四肢、握拳的手、丧尸爪、鞋、破布条、肋骨等。
 *
 * 全部在模块级懒创建、所有 rig 共用、永不释放；尺寸靠 Mesh.scale 给出（见各形状的注释）。
 * 曲面零件用超椭圆截面放样（loftY）生成，法线按位置焊接，接缝与极点不出现折痕。
 * 每个几何体都带 position / normal / uv，鞋与赤脚另带 color（鞋底压暗），以便同材质下区分鞋底。
 */

import { BoxGeometry, BufferAttribute, BufferGeometry, Euler, Matrix4, Quaternion, SphereGeometry, Vector3 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 共享几何体的名字：
 * - box / sphere：单位立方体（居中）/ 单位球
 * - limb：顶端在原点、沿 -Y 的单位肢体（两端圆头，略超出 0..-1，关节处互相盖住）
 * - band：顶端在原点、沿 -Y 的单位圆柱（袖口条纹、袖标）
 * - torso：底在原点、高 1、宽深各 1 的躯干（胸宽腰细、肩部收圆）
 * - head：半径约 1 的头（略长、下颌收窄、带鼻梁）
 * - fistL / fistR：握拳的左 / 右手，原点在手腕，手指沿 -Y；单位为前臂半径。拳心空洞的轴线沿 +Z（拇指一侧），见 FIST_AXIS
 * - clawL / clawR：丧尸的爪，原点在手腕，五指张开弯曲、指尖尖细
 * - eyes：一对眼睛，单位为头部半径
 * - shoe / bareFoot：脚，原点在脚踝；单位盒 x ±0.5、y 0..-1、z -0.28..0.72（与旧脚掌盒一致）
 * - rags：一圈下垂的破布条，环半径 0.5、从 y=0 垂到最长 -1（衣摆、袖口）
 * - ribs：四根前凸的肋骨弧，环半径 0.5，最高一根在 y=0
 */
export type HumanoidShape =
  | 'box'
  | 'sphere'
  | 'limb'
  | 'band'
  | 'torso'
  | 'head'
  | 'fistL'
  | 'fistR'
  | 'clawL'
  | 'clawR'
  | 'eyes'
  | 'shoe'
  | 'bareFoot'
  | 'rags'
  | 'ribs'

/** 握拳时拳心空洞的轴线位置（左手，手腕原点、单位为手的缩放）；右手 x 取反。轴线方向为 +Z（拇指一侧） */
export const FIST_AXIS = { x: -0.75, y: -1.5, radius: 0.43 } as const

const TAU = Math.PI * 2

/** 截面 [y, 半宽 rx, 半深 rz, 中心 z]；rx = rz = 0 为极点 */
type Ring = readonly [number, number, number, number?]

const tmpMat = new Matrix4()
const tmpQuat = new Quaternion()
const tmpEuler = new Euler()
const tmpScale = new Vector3()
const tmpPos = new Vector3()
const tmpDir = new Vector3()
const DOWN = new Vector3(0, -1, 0)

/** 同一位置上的顶点共用平均法线：消除放样接缝、球的经线接缝与极点的折痕 */
function weldNormals(geometry: BufferGeometry): void {
  const pos = geometry.getAttribute('position')
  const nor = geometry.getAttribute('normal')
  const groups = new Map<string, number[]>()
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`
    const list = groups.get(key)
    if (list) list.push(i)
    else groups.set(key, [i])
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    let x = 0
    let y = 0
    let z = 0
    for (const i of list) {
      x += nor.getX(i)
      y += nor.getY(i)
      z += nor.getZ(i)
    }
    const len = Math.hypot(x, y, z)
    if (len < 1e-6) continue
    for (const i of list) nor.setXYZ(i, x / len, y / len, z / len)
  }
  nor.needsUpdate = true
}

/**
 * 沿 Y 放样超椭圆截面。
 * @param rings 截面序列（y 单调），首尾可为极点
 * @param radial 每圈的分段数
 * @param exp 超椭圆指数：2 为椭圆，越大越方
 */
function loftY(rings: readonly Ring[], radial: number, exp = 2): BufferGeometry {
  const cols = radial + 1
  const n = rings.length
  const pos = new Float32Array(n * cols * 3)
  const uv = new Float32Array(n * cols * 2)
  const first = rings[0]
  const last = rings[n - 1]
  const y0 = first ? first[0] : 0
  const y1 = last ? last[0] : 1
  const span = y1 - y0 || 1
  const k = 2 / exp
  let p = 0
  let q = 0
  for (const ring of rings) {
    const [y, rx, rz, cz = 0] = ring
    for (let i = 0; i < cols; i++) {
      const a = (i / radial) * TAU
      const c = Math.cos(a)
      const s = Math.sin(a)
      pos[p++] = rx * Math.sign(c) * Math.abs(c) ** k
      pos[p++] = y
      pos[p++] = cz + rz * Math.sign(s) * Math.abs(s) ** k
      uv[q++] = i / radial
      uv[q++] = (y - y0) / span
    }
  }
  const asc = y1 > y0
  const index: number[] = []
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < radial; i++) {
      const a = r * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      if (asc) index.push(a, c, b, b, c, d)
      else index.push(a, b, c, b, d, c)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  // 极点：法线直接取放样方向的两端
  const nor = geometry.getAttribute('normal')
  rings.forEach((ring, r) => {
    if (ring[1] !== 0 || ring[2] !== 0) return
    const sign = (r === 0) === asc ? -1 : 1
    for (let i = 0; i < cols; i++) nor.setXYZ(r * cols + i, 0, sign, 0)
  })
  weldNormals(geometry)
  return geometry
}

/** 两端圆头的胶囊：顶端球心在原点，沿 -Y 长 len，半径由 r0 渐变到 r1 */
function capsule(len: number, r0: number, r1: number, radial = 8): BufferGeometry {
  return loftY(
    [
      [r0, 0, 0],
      [r0 * 0.71, r0 * 0.71, r0 * 0.71],
      [0, r0, r0],
      [-len, r1, r1],
      [-len - r1 * 0.71, r1 * 0.71, r1 * 0.71],
      [-len - r1, 0, 0],
    ],
    radial,
  )
}

/**
 * 圆角盒：在细分的盒上把棱角推成圆弧，法线取圆弧方向。
 * @param r 圆角半径（绝对尺寸，须小于各边的一半）
 */
function roundedBox(w: number, h: number, d: number, r: number, seg = 3): BufferGeometry {
  const geometry = new BoxGeometry(w, h, d, seg, seg, seg)
  const pos = geometry.getAttribute('position')
  const nor = geometry.getAttribute('normal')
  const ix = w / 2 - r
  const iy = h / 2 - r
  const iz = d / 2 - r
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const cx = Math.max(-ix, Math.min(ix, x))
    const cy = Math.max(-iy, Math.min(iy, y))
    const cz = Math.max(-iz, Math.min(iz, z))
    tmpDir.set(x - cx, y - cy, z - cz)
    const len = tmpDir.length()
    if (len < 1e-6) continue
    tmpDir.multiplyScalar(1 / len)
    pos.setXYZ(i, cx + tmpDir.x * r, cy + tmpDir.y * r, cz + tmpDir.z * r)
    nor.setXYZ(i, tmpDir.x, tmpDir.y, tmpDir.z)
  }
  weldNormals(geometry)
  return geometry
}

/** 平移 + 欧拉旋转 + 缩放后返回同一个几何体 */
function place(
  geometry: BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): BufferGeometry {
  tmpEuler.set(rx, ry, rz, 'XYZ')
  tmpQuat.setFromEuler(tmpEuler)
  tmpMat.compose(tmpPos.set(x, y, z), tmpQuat, tmpScale.set(sx, sy, sz))
  geometry.applyMatrix4(tmpMat)
  return geometry
}

/** 把一段沿 -Y 的几何体（顶端在原点）摆到 from → to 之间 */
function between(geometry: BufferGeometry, from: Vector3, to: Vector3): BufferGeometry {
  tmpDir.subVectors(to, from).normalize()
  tmpQuat.setFromUnitVectors(DOWN, tmpDir)
  tmpMat.compose(from, tmpQuat, tmpScale.set(1, 1, 1))
  geometry.applyMatrix4(tmpMat)
  return geometry
}

/** 合并后只保留 position / normal / uv，避免各零件属性不一致导致合并失败 */
function merge(parts: BufferGeometry[]): BufferGeometry {
  for (const part of parts) {
    for (const name of Object.keys(part.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') part.deleteAttribute(name)
    }
  }
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (merged === null) throw new Error('humanoid-shapes: mergeGeometries failed')
  return merged
}

/** 左右镜像（x 取反）并翻转三角形绕序，得到另一只手 */
function mirrorX(source: BufferGeometry): BufferGeometry {
  const geometry = source.clone()
  geometry.scale(-1, 1, 1)
  const index = geometry.getIndex()
  if (index !== null) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1)
      index.setX(i + 1, index.getX(i + 2))
      index.setX(i + 2, b)
    }
    index.needsUpdate = true
  }
  return geometry
}

/** 按 y 给顶点上色：低于 soleY 的部分压暗（鞋底），其余为白色 */
function shadeBelow(geometry: BufferGeometry, soleY: number, dark: number): BufferGeometry {
  const pos = geometry.getAttribute('position')
  const color = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const v = pos.getY(i) <= soleY ? dark : 1
    color[i * 3] = v
    color[i * 3 + 1] = v
    color[i * 3 + 2] = v
  }
  geometry.setAttribute('color', new BufferAttribute(color, 3))
  return geometry
}

/** 可重复的伪随机 0..1（只用于几何体的固定变化） */
function hash(i: number): number {
  const s = Math.sin(i * 12.9898 + 4.1) * 43758.5453
  return s - Math.floor(s)
}

/* ── 各形状 ── */

function buildLimb(): BufferGeometry {
  const profile: readonly (readonly [number, number])[] = [
    [0.05, 0],
    [0.045, 0.45],
    [0.03, 0.78],
    [0, 0.95],
    [-0.12, 1],
    [-0.45, 0.94],
    [-0.8, 0.84],
    [-0.97, 0.8],
    [-1.01, 0.68],
    [-1.04, 0.38],
    [-1.05, 0],
  ]
  return loftY(
    profile.map(([y, r]) => [y, r, r] as const),
    14,
  )
}

function buildBand(): BufferGeometry {
  return loftY(
    [
      [0, 0, 0],
      [0, 0.9, 0.9],
      [-0.02, 1, 1],
      [-0.98, 1, 1],
      [-1, 0.9, 0.9],
      [-1, 0, 0],
    ],
    16,
  )
}

function buildTorso(): BufferGeometry {
  return loftY(
    [
      [0, 0, 0],
      [0.004, 0.36, 0.36],
      [0.03, 0.44, 0.45],
      [0.14, 0.43, 0.46],
      [0.36, 0.42, 0.47],
      [0.58, 0.47, 0.49],
      [0.8, 0.5, 0.5],
      [0.9, 0.49, 0.47],
      [0.96, 0.43, 0.4],
      [0.995, 0.3, 0.3],
      [1.01, 0.14, 0.16],
      [1.012, 0, 0],
    ],
    20,
    2.6,
  )
}

function buildHead(): BufferGeometry {
  const geometry = new SphereGeometry(1, 22, 16)
  const pos = geometry.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i)
    let y = pos.getY(i)
    let z = pos.getZ(i)
    // 下颌两侧收窄、下巴略收；后脑稍鼓
    const jaw = Math.max(0, Math.min(1, (-0.15 - y) / 0.8))
    const jawK = jaw * jaw * (3 - 2 * jaw)
    x *= 0.9 * (1 - 0.2 * jawK)
    if (z > 0) z *= 1 - 0.1 * jawK
    else z *= 1.03
    // 鼻梁与眉弓
    if (z > 0.4) {
      z += 0.15 * Math.exp(-(x * x) / 0.008 - ((y + 0.1) * (y + 0.1)) / 0.03)
      z += 0.04 * Math.exp(-((y - 0.3) * (y - 0.3)) / 0.006) * (1 - Math.min(1, x * x * 3))
    }
    y *= 1.06
    pos.setXYZ(i, x, y, z)
  }
  geometry.computeVertexNormals()
  weldNormals(geometry)
  return geometry
}

/** 一根手指：沿给定折点连成的若干节胶囊 */
function finger(points: readonly Vector3[], r0: number, r1: number, out: BufferGeometry[]): void {
  const segs = points.length - 1
  for (let i = 0; i < segs; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (a === undefined || b === undefined) continue
    const ra = r0 + ((r1 - r0) * i) / segs
    const rb = r0 + ((r1 - r0) * (i + 1)) / segs
    out.push(between(capsule(a.distanceTo(b), ra, rb, 8), a, b))
  }
}

/** 握拳的左手：掌心朝 -X，四指绕 FIST_AXIS 卷成空心拳，拇指从 +Z 一侧压在上面 */
function buildFistL(): BufferGeometry {
  const parts: BufferGeometry[] = []
  // 腕部 + 手掌 + 拇指根部的鱼际肌
  parts.push(place(capsule(0.25, 0.5, 0.52, 10), 0, 0.28, 0, 0, 0, 0, 0.85, 1, 1.05))
  parts.push(place(roundedBox(0.8, 1.75, 1.62, 0.3), 0, -0.86, 0))
  parts.push(place(new SphereGeometry(0.42, 10, 8), -0.18, -0.55, 0.45, 0, 0, 0, 0.9, 1.15, 1))

  const cx = FIST_AXIS.x
  const cy = FIST_AXIS.y
  // 指根在掌心远端、靠手背一侧；沿圆弧绕轴线顺时针卷向掌心
  const fingers: readonly (readonly [number, number, number])[] = [
    [0.57, 2.6, 0.19],
    [0.19, 2.75, 0.195],
    [-0.19, 2.65, 0.185],
    [-0.57, 2.4, 0.165],
  ]
  for (const [z, sweep, r] of fingers) {
    const sx = -0.08
    const sy = -1.72
    const radius = Math.hypot(sx - cx, sy - cy)
    const a0 = Math.atan2(sy - cy, sx - cx)
    const pts: Vector3[] = []
    for (let j = 0; j <= 3; j++) {
      const a = a0 - (sweep * j) / 3
      // 指根略外扩、指尖收紧
      const rr = radius * (1 - 0.06 * (j / 3))
      pts.push(new Vector3(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z))
    }
    finger(pts, r, r * 0.85, parts)
  }
  // 拇指：从掌根 +Z 一侧绕过轴线上端，压在食指外侧
  finger(
    [new Vector3(-0.08, -0.5, 0.72), new Vector3(-0.62, -0.86, 0.95), new Vector3(-1.12, -1.18, 0.86)],
    0.23,
    0.18,
    parts,
  )
  return merge(parts)
}

/** 丧尸的左爪：手掌偏窄，五指张开、三节逐渐弯向掌心，指尖收成尖 */
function buildClawL(): BufferGeometry {
  const parts: BufferGeometry[] = []
  parts.push(place(capsule(0.25, 0.46, 0.48, 10), 0, 0.28, 0, 0, 0, 0, 0.8, 1, 1))
  parts.push(place(roundedBox(0.66, 1.55, 1.42, 0.25), 0, -0.78, 0))

  const fingers: readonly (readonly [number, number, number, number])[] = [
    // 指根 z、张开角、弯曲、长度倍率
    [0.52, 0.32, 0.42, 0.95],
    [0.18, 0.1, 0.5, 1.1],
    [-0.18, -0.1, 0.46, 1.02],
    [-0.52, -0.3, 0.38, 0.82],
  ]
  const lens = [0.62, 0.5, 0.48] as const
  const dir = new Vector3()
  const palmSide = new Vector3(-1, 0, 0)
  for (const [z, spread, bend, scale] of fingers) {
    const p = new Vector3(-0.05, -1.5, z)
    dir.set(0, -Math.cos(spread), Math.sin(spread))
    const pts: Vector3[] = [p.clone()]
    for (const len of lens) {
      dir.multiplyScalar(Math.cos(bend)).addScaledVector(palmSide, Math.sin(bend)).normalize()
      p.addScaledVector(dir, len * scale)
      pts.push(p.clone())
    }
    finger(pts, 0.15, 0.035, parts)
  }
  // 拇指：从掌根前侧斜伸向前下方，再弯向掌心
  finger(
    [new Vector3(-0.1, -0.45, 0.6), new Vector3(-0.35, -0.85, 1.05), new Vector3(-0.75, -1.2, 1.15), new Vector3(-1.05, -1.4, 0.95)],
    0.18,
    0.04,
    parts,
  )
  return merge(parts)
}

function buildEyes(): BufferGeometry {
  const left = place(new SphereGeometry(1, 10, 8), 0.33, 0.12, 0.88, 0, 0, 0, 0.14, 0.095, 0.08)
  const right = place(new SphereGeometry(1, 10, 8), -0.33, 0.12, 0.88, 0, 0, 0, 0.14, 0.095, 0.08)
  return merge([left, right])
}

function buildShoe(): BufferGeometry {
  const geometry = loftY(
    [
      [-1, 0, 0, 0.21],
      [-0.99, 0.4, 0.42, 0.21],
      [-0.94, 0.5, 0.5, 0.22],
      [-0.78, 0.5, 0.5, 0.22],
      [-0.74, 0.46, 0.47, 0.21],
      [-0.45, 0.44, 0.41, 0.14],
      [-0.15, 0.37, 0.28, 0.02],
      [0, 0.34, 0.23, -0.03],
      [0.04, 0.3, 0.18, -0.04],
      [0.06, 0, 0, -0.04],
    ],
    16,
    2.2,
  )
  return shadeBelow(geometry, -0.77, 0.32)
}

function buildBareFoot(): BufferGeometry {
  const geometry = loftY(
    [
      [-1, 0, 0, 0.24],
      [-0.98, 0.4, 0.44, 0.24],
      [-0.86, 0.46, 0.5, 0.23],
      [-0.6, 0.42, 0.43, 0.18],
      [-0.3, 0.34, 0.3, 0.05],
      [0, 0.32, 0.22, -0.03],
      [0.05, 0, 0, -0.03],
    ],
    14,
    2.1,
  )
  return shadeBelow(geometry, -2, 1)
}

function buildRags(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const n = 13
  const width = ((TAU * 0.5) / n) * 1.25
  for (let i = 0; i < n; i++) {
    const len = 0.35 + 0.65 * hash(i)
    const strip = new BoxGeometry(width * (0.75 + 0.35 * hash(i + 20)), len, 0.05)
    strip.translate(0, -len / 2, 0)
    const theta = (i / n) * TAU + (hash(i + 40) - 0.5) * 0.2
    tmpEuler.set(-0.1 - 0.12 * hash(i + 60), theta, (hash(i + 80) - 0.5) * 0.3, 'YXZ')
    tmpQuat.setFromEuler(tmpEuler)
    tmpMat.compose(tmpPos.set(Math.sin(theta) * 0.51, 0, Math.cos(theta) * 0.51), tmpQuat, tmpScale.set(1, 1, 1))
    strip.applyMatrix4(tmpMat)
    parts.push(strip)
  }
  return merge(parts)
}

function buildRibs(): BufferGeometry {
  const parts: BufferGeometry[] = []
  for (let i = 0; i < 4; i++) {
    const r = 0.5 - i * 0.012
    const arc = 1.5 - i * 0.12
    const rib = loftRibArc(r, 0.032, arc)
    rib.translate(0, -i * 0.22, 0)
    parts.push(rib)
  }
  return merge(parts)
}

/** 一根肋骨：水平面内以 +Z 为中心、张角 arc 的圆弧管 */
function loftRibArc(radius: number, tube: number, arc: number): BufferGeometry {
  const segs = 10
  const parts: BufferGeometry[] = []
  const a = new Vector3()
  const b = new Vector3()
  for (let i = 0; i < segs; i++) {
    const t0 = -arc / 2 + (arc * i) / segs
    const t1 = -arc / 2 + (arc * (i + 1)) / segs
    a.set(Math.sin(t0) * radius, 0, Math.cos(t0) * radius)
    b.set(Math.sin(t1) * radius, 0, Math.cos(t1) * radius)
    parts.push(between(capsule(a.distanceTo(b), tube, tube, 6), a, b))
  }
  return merge(parts)
}

/* ── 缓存 ── */

const BUILDERS: Record<HumanoidShape, () => BufferGeometry> = {
  box: () => new BoxGeometry(1, 1, 1),
  sphere: () => new SphereGeometry(1, 16, 12),
  limb: buildLimb,
  band: buildBand,
  torso: buildTorso,
  head: buildHead,
  fistL: buildFistL,
  fistR: () => mirrorX(humanoidGeometry('fistL')),
  clawL: buildClawL,
  clawR: () => mirrorX(humanoidGeometry('clawL')),
  eyes: buildEyes,
  shoe: buildShoe,
  bareFoot: buildBareFoot,
  rags: buildRags,
  ribs: buildRibs,
}

const cache = new Map<HumanoidShape, BufferGeometry>()

/**
 * 取得（首次使用时生成）一个共享几何体。调用方不得释放或修改它。
 * @param shape 形状名，含义与单位见 HumanoidShape
 */
export function humanoidGeometry(shape: HumanoidShape): BufferGeometry {
  let geometry = cache.get(shape)
  if (geometry === undefined) {
    geometry = BUILDERS[shape]()
    geometry.computeBoundingSphere()
    cache.set(shape, geometry)
  }
  return geometry
}

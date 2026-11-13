/**
 * Boss 触手的外观：蒙皮管 + 吸盘 + 尖刺。
 *
 * 蒙皮管：8 条触手共用一个几何体（一次绘制）。boss.ts 每帧给出每条触手中心线上的 ARM_POINTS 个点，
 * 这里沿中心线推算无扭转的标架，把每一环截面的顶点位置与法线直接写进缓冲区：不新建几何体，不分配对象。
 * 截面背面圆、腹面略扁；腹面两排吸盘与尖端的刺都是 InstancedMesh，跟着同一套标架摆放。
 */

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, InstancedMesh, Mesh } from 'three'
import type { Material } from 'three'
import { lerp, smoothstep } from '../../utils/math'
import { getNoise } from '../../utils/noise'
import {
  ARM_POINTS,
  ARM_SEGMENTS,
  BASE_RADIUS,
  INFLAMED,
  PUS_HEAD,
  SKIN_BASE,
  SKIN_BRUISE,
  SKIN_DARK,
  SKIN_PALE,
  TAU,
  TENTACLES,
  TIP_RADIUS,
  armAzimuth,
  cellular3,
} from './boss-shared'
import type { CellSample } from './boss-shared'

/** 截面一圈的分段数；接缝处多一个顶点，给 UV 用 */
const RADIAL = 14
const RING_VERTS = RADIAL + 1
const VERTS_PER_ARM = ARM_POINTS * RING_VERTS
const LAST_RING = ARM_POINTS - 1
/** 每一环在标架缓存里占 12 个数：中心、侧向、背向、切向 */
const FRAME = 12

/** 地面高度（root 本地坐标，略高于 0 避免与地面共面闪烁）：蒙皮顶点不会低于它 */
const GROUND_Y = 0.015

/** 截面半轴（以该处半径为 1）：背面接近圆，腹面压扁 */
const HALF_WIDTH = 1
const HALF_DORSAL = 0.92
const HALF_VENTRAL = 0.74

/* ── 吸盘 ── */

const SUCKERS_PER_ROW = 18
const SUCKERS_PER_ARM = SUCKERS_PER_ROW * 2
/** 吸盘一圈的边数：6 边在近处能看出是六边形 */
const SUCKER_SIDES = 8
/** 两排吸盘各自偏离正下方的角度 */
const SUCKER_SPREAD = 0.45
/** 吸盘半径相对所在处触手半径的比例 */
const SUCKER_SIZE = 0.42
/** 吸盘分布的起止位置（沿触手 0..1） */
const SUCKER_FROM = 0.15
const SUCKER_TO = 0.93
/** 吸盘根部在截面上的位置与外法线（侧向分量取正，另一排取反） */
const SUCKER_PX = Math.sin(SUCKER_SPREAD) * HALF_WIDTH * 0.97
const SUCKER_PY = -Math.cos(SUCKER_SPREAD) * HALF_VENTRAL * 0.97
const SUCKER_NORM = Math.hypot(Math.sin(SUCKER_SPREAD) / HALF_WIDTH, Math.cos(SUCKER_SPREAD) / HALF_VENTRAL)
const SUCKER_NX = Math.sin(SUCKER_SPREAD) / HALF_WIDTH / SUCKER_NORM
const SUCKER_NY = -Math.cos(SUCKER_SPREAD) / HALF_VENTRAL / SUCKER_NORM

/* ── 尖刺 ── */

/** 每条触手靠近尖端的背面小刺数量；另有一根接在尖端的主刺 */
const THORNS = 5
const SPIKES_PER_ARM = THORNS + 1
const SPIKE_SIDES = 6
/** 主刺：根部半径与长度（米，触手被拉细时同比例缩小） */
const SPIKE_RADIUS = 0.085
const SPIKE_LENGTH = 0.62
/** 小刺朝向：法线与切线的混合（向尖端方向倒伏） */
const THORN_OUT = 0.8
const THORN_FORWARD = 0.6

export interface ArmSkin {
  /** 8 条触手的蒙皮管 */
  readonly mesh: Mesh
  readonly suckers: InstancedMesh
  readonly spikes: InstancedMesh
  /**
   * 写入第 index 条触手本帧的形状。
   * @param points 中心线上 ARM_POINTS 个点（x, y, z 连续存放，root 本地坐标），从根部到尖端
   * @param thin 粗细倍率（被拉长时小于 1）
   */
  writeArm(index: number, points: Float64Array, thin: number): void
  /** 本帧全部触手写完后调用：标记缓冲区需要上传 */
  commit(): void
  dispose(): void
}

/** 蒙皮管在 u（0 根部 .. 1 尖端）处的半径：线性渐细，根部外扩埋进裙膜，最后一小段收细接上主刺 */
function skinRadius(u: number): number {
  const flare = 1 + 0.3 * (1 - smoothstep(u / 0.1))
  const taper = 1 - 0.35 * smoothstep((u - 0.9) / 0.1)
  return lerp(BASE_RADIUS, TIP_RADIUS, u) * flare * taper
}

/** 把一组基向量（已乘好缩放）与位置写成列主序的 4×4 实例矩阵 */
function writeMatrix(
  target: { [index: number]: number },
  offset: number,
  xx: number,
  xy: number,
  xz: number,
  yx: number,
  yy: number,
  yz: number,
  zx: number,
  zy: number,
  zz: number,
  px: number,
  py: number,
  pz: number,
): void {
  target[offset] = xx
  target[offset + 1] = xy
  target[offset + 2] = xz
  target[offset + 3] = 0
  target[offset + 4] = yx
  target[offset + 5] = yy
  target[offset + 6] = yz
  target[offset + 7] = 0
  target[offset + 8] = zx
  target[offset + 9] = zy
  target[offset + 10] = zz
  target[offset + 11] = 0
  target[offset + 12] = px
  target[offset + 13] = py
  target[offset + 14] = pz
  target[offset + 15] = 1
}

/**
 * 吸盘：绕 Y 轴的回转体，开口朝 +Y，外缘半径为 1。轮廓依次是：埋在皮肤里的柄 → 外缘 → 唇口 → 中心凹陷。
 */
function createSuckerGeometry(): BufferGeometry {
  const profile: readonly (readonly [number, number, number])[] = [
    [0.62, -0.14, 0xa98a94],
    [1, 0.22, 0xe3c2bd],
    [0.72, 0.36, 0xf0d6cf],
  ]
  const count = profile.length * SUCKER_SIDES + 1
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const color = new Color()
  for (let p = 0; p < profile.length; p++) {
    const [radius, height, hex] = profile[p] as readonly [number, number, number]
    color.setHex(hex)
    for (let s = 0; s < SUCKER_SIDES; s++) {
      const a = (s / SUCKER_SIDES) * TAU
      const v = (p * SUCKER_SIDES + s) * 3
      positions[v] = Math.cos(a) * radius
      positions[v + 1] = height
      positions[v + 2] = Math.sin(a) * radius
      colors[v] = color.r
      colors[v + 1] = color.g
      colors[v + 2] = color.b
    }
  }
  // 中心：深色的吸盘腔
  const centre = count - 1
  positions[centre * 3 + 1] = 0.1
  color.setHex(0x4a2638)
  colors[centre * 3] = color.r
  colors[centre * 3 + 1] = color.g
  colors[centre * 3 + 2] = color.b

  const indices: number[] = []
  for (let s = 0; s < SUCKER_SIDES; s++) {
    const next = (s + 1) % SUCKER_SIDES
    for (let p = 0; p < profile.length - 1; p++) {
      const a = p * SUCKER_SIDES + s
      const b = p * SUCKER_SIDES + next
      indices.push(a, a + SUCKER_SIDES, b, b, a + SUCKER_SIDES, b + SUCKER_SIDES)
    }
    const top = (profile.length - 1) * SUCKER_SIDES
    indices.push(top + s, centre, top + next)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 尖刺：沿 +Z 的弯钩，根部半径为 1、长度为 1（根部略向后伸，埋进皮肤），尖端向 +Y 弯。
 * 实例用非等比缩放分别控制粗细与长度。
 */
function createSpikeGeometry(): BufferGeometry {
  const stations: readonly (readonly [number, number])[] = [
    [0, 0x6b5248],
    [0.1, 0x9a8468],
    [0.4, 0xd8c9a0],
    [0.72, 0xa08a66],
  ]
  const count = stations.length * SPIKE_SIDES + 1
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const color = new Color()
  for (let p = 0; p < stations.length; p++) {
    const [s, hex] = stations[p] as readonly [number, number]
    const radius = s <= 0.1 ? 1 : Math.pow(1 - (s - 0.1) / 0.9, 0.85)
    const hook = 0.9 * s * s
    color.setHex(hex)
    for (let i = 0; i < SPIKE_SIDES; i++) {
      const a = (i / SPIKE_SIDES) * TAU
      const v = (p * SPIKE_SIDES + i) * 3
      positions[v] = Math.cos(a) * radius
      positions[v + 1] = hook + Math.sin(a) * radius
      positions[v + 2] = -0.12 + 1.12 * s
      colors[v] = color.r
      colors[v + 1] = color.g
      colors[v + 2] = color.b
    }
  }
  const tip = count - 1
  positions[tip * 3 + 1] = 0.9
  positions[tip * 3 + 2] = 1
  color.setHex(0x2a1e18)
  colors[tip * 3] = color.r
  colors[tip * 3 + 1] = color.g
  colors[tip * 3 + 2] = color.b

  const indices: number[] = []
  for (let i = 0; i < SPIKE_SIDES; i++) {
    const next = (i + 1) % SPIKE_SIDES
    for (let p = 0; p < stations.length - 1; p++) {
      const a = p * SPIKE_SIDES + i
      const b = p * SPIKE_SIDES + next
      indices.push(a, b, a + SPIKE_SIDES, b, b + SPIKE_SIDES, a + SPIKE_SIDES)
    }
    const top = (stations.length - 1) * SPIKE_SIDES
    indices.push(top + i, top + next, tip)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 创建触手外观。网格的顶点在 root 本地空间，调用方把 mesh / suckers / spikes 直接挂到 root 下。
 * @param skin 蒙皮管材质（需要 vertexColors）
 * @param sucker 吸盘材质（需要 vertexColors）
 * @param spike 尖刺材质（需要 vertexColors）
 * @param seed 花纹与疣粒的种子
 * @param tints 每条触手的明暗倍率，缺省为 1
 */
export function createArmSkin(
  skin: Material,
  sucker: Material,
  spike: Material,
  seed: number,
  tints?: readonly number[],
): ArmSkin {
  const noise = getNoise(seed)
  const cell: CellSample = { f1: 0, f2: 0, id: 0 }
  const color = new Color()

  /* ── 静态数据：截面轮廓、各环半径、每个顶点的起伏倍率 ── */

  const profX = new Float32Array(RING_VERTS)
  const profY = new Float32Array(RING_VERTS)
  const profNX = new Float32Array(RING_VERTS)
  const profNY = new Float32Array(RING_VERTS)
  for (let j = 0; j < RING_VERTS; j++) {
    // 接缝放在腹面正中，藏在两排吸盘之间
    const theta = -Math.PI / 2 + (j / RADIAL) * TAU
    const ct = Math.cos(theta)
    const st = Math.sin(theta)
    const half = st >= 0 ? HALF_DORSAL : HALF_VENTRAL
    profX[j] = ct * HALF_WIDTH
    profY[j] = st * half
    const norm = Math.hypot(ct / HALF_WIDTH, st / half)
    profNX[j] = ct / HALF_WIDTH / norm
    profNY[j] = st / half / norm
  }

  const ringRadius = new Float32Array(ARM_POINTS)
  for (let k = 0; k < ARM_POINTS; k++) ringRadius[k] = skinRadius(k / ARM_SEGMENTS)

  const vertexCount = TENTACLES * VERTS_PER_ARM
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const colors = new Float32Array(vertexCount * 3)
  const bump = new Float32Array(vertexCount)
  const indices = new Uint16Array(TENTACLES * ARM_SEGMENTS * RADIAL * 6)
  /** 每条触手起始标架用的水平侧向（垂直于触手方位） */
  const sideX = new Float32Array(TENTACLES)
  const sideZ = new Float32Array(TENTACLES)

  let face = 0
  for (let a = 0; a < TENTACLES; a++) {
    const azimuth = armAzimuth(a)
    sideX[a] = Math.cos(azimuth)
    sideZ[a] = -Math.sin(azimuth)
    const tint = tints?.[a] ?? 1
    for (let k = 0; k < ARM_POINTS; k++) {
      const u = k / ARM_SEGMENTS
      for (let j = 0; j < RING_VERTS; j++) {
        const theta = -Math.PI / 2 + (j / RADIAL) * TAU
        const ct = Math.cos(theta)
        const st = Math.sin(theta)
        const v = a * VERTS_PER_ARM + k * RING_VERTS + j

        const mottle = noise.noise3D(u * 6 + a * 13.7, ct * 1.4, st * 1.4)
        const speckle = noise.noise3D(u * 16 + a * 5.1, ct * 2.6, st * 2.6)
        // 0 腹面 .. 1 背面
        const dorsal = smoothstep((st + 0.25) / 0.5)
        // 背面的疣粒：细胞噪声里约四成的格子长出圆顶肿块，越靠尖端越小
        cellular3(u * 8.5 + a * 31, ct * 0.45, st * 0.45, seed + a, cell)
        let wart = 0
        let sore = 0
        if (cell.id < 0.42) {
          const t = cell.f1 / 0.4
          if (t < 1) wart = Math.pow(1 - t * t, 0.7) * dorsal * (1 - 0.5 * u)
          sore = Math.max(0, 1 - Math.abs(t - 0.95) / 0.35) * dorsal
        }
        bump[v] = 1 + 0.05 * mottle + 0.025 * speckle + 0.13 * wart

        color.copy(SKIN_BASE).lerp(SKIN_DARK, smoothstep(0.5 + 0.5 * mottle) * 0.75)
        color.lerp(SKIN_BRUISE, smoothstep((speckle - 0.3) / 0.4) * 0.5 * dorsal)
        color.lerp(INFLAMED, sore * 0.55)
        color.lerp(PUS_HEAD, wart * wart * 0.85)
        // 腹面颜色浅；整条触手越靠尖端越深
        color.lerp(SKIN_PALE, (1 - smoothstep((st + 0.75) / 0.5)) * 0.8)
        color.multiplyScalar(lerp(1, 0.7, u) * tint)
        colors[v * 3] = color.r
        colors[v * 3 + 1] = color.g
        colors[v * 3 + 2] = color.b

        // 皮肤贴图绕一圈铺 2 次、沿长度铺 5 次（平铺写在 UV 里，贴图本身是共享的）
        uvs[v * 2] = (j / RADIAL) * 2
        uvs[v * 2 + 1] = u * 5
      }
    }
    for (let k = 0; k < ARM_SEGMENTS; k++) {
      for (let j = 0; j < RADIAL; j++) {
        const p = a * VERTS_PER_ARM + k * RING_VERTS + j
        const q = p + RING_VERTS
        indices[face] = p
        indices[face + 1] = p + 1
        indices[face + 2] = q
        indices[face + 3] = p + 1
        indices[face + 4] = q + 1
        indices[face + 5] = q
        face += 6
      }
    }
  }

  const positionAttr = new BufferAttribute(positions, 3)
  positionAttr.setUsage(DynamicDrawUsage)
  const normalAttr = new BufferAttribute(normals, 3)
  normalAttr.setUsage(DynamicDrawUsage)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', positionAttr)
  geometry.setAttribute('normal', normalAttr)
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))

  const mesh = new Mesh(geometry, skin)
  // 顶点每帧都在动，包围球不可靠
  mesh.frustumCulled = false
  mesh.castShadow = true
  mesh.receiveShadow = true

  /* ── 吸盘：沿触手按等比间距排列（间距与当地粗细成正比），两排错开半格 ── */

  const suckerGeometry = createSuckerGeometry()
  const suckers = new InstancedMesh(suckerGeometry, sucker, TENTACLES * SUCKERS_PER_ARM)
  suckers.instanceMatrix.setUsage(DynamicDrawUsage)
  suckers.frustumCulled = false
  suckers.castShadow = true
  suckers.receiveShadow = true
  const suckerMatrices = suckers.instanceMatrix.array

  /** 每个吸盘在中心线上的位置（环的小数下标）与所在的排（+1 / -1） */
  const suckerRing = new Float32Array(SUCKERS_PER_ARM)
  const suckerSide = new Float32Array(SUCKERS_PER_ARM)
  const radiusFrom = lerp(BASE_RADIUS, TIP_RADIUS, SUCKER_FROM)
  const radiusTo = lerp(BASE_RADIUS, TIP_RADIUS, SUCKER_TO)
  const ratio = Math.pow(radiusTo / radiusFrom, 1 / (SUCKERS_PER_ROW - 0.5))
  for (let s = 0; s < SUCKERS_PER_ARM; s++) {
    const row = s % 2
    const step = (s - row) / 2 + row * 0.5
    const radius = radiusFrom * Math.pow(ratio, step)
    suckerRing[s] = ((BASE_RADIUS - radius) / (BASE_RADIUS - TIP_RADIUS)) * ARM_SEGMENTS
    suckerSide[s] = row === 0 ? 1 : -1
  }

  /* ── 尖刺：每条触手一根主刺 + 靠近尖端背面的几根小刺 ── */

  const spikeGeometry = createSpikeGeometry()
  const spikes = new InstancedMesh(spikeGeometry, spike, TENTACLES * SPIKES_PER_ARM)
  spikes.instanceMatrix.setUsage(DynamicDrawUsage)
  spikes.frustumCulled = false
  spikes.castShadow = true
  spikes.receiveShadow = true
  const spikeMatrices = spikes.instanceMatrix.array

  const thornRing = new Uint8Array(THORNS)
  const thornCos = new Float32Array(THORNS)
  const thornSin = new Float32Array(THORNS)
  const thornRadius = new Float32Array(THORNS)
  const thornLength = new Float32Array(THORNS)
  for (let i = 0; i < THORNS; i++) {
    const f = i / (THORNS - 1)
    thornRing[i] = Math.round(lerp(0.7, 0.93, f) * ARM_SEGMENTS)
    // 在背脊两侧交替
    const angle = Math.PI / 2 + (i % 2 === 0 ? -0.6 : 0.6)
    thornCos[i] = Math.cos(angle)
    thornSin[i] = Math.sin(angle)
    thornRadius[i] = lerp(0.055, 0.035, f)
    thornLength[i] = lerp(0.24, 0.13, f)
  }

  /** 当前这条触手各环的标架，写完蒙皮后给吸盘与尖刺用 */
  const frames = new Float32Array(ARM_POINTS * FRAME)
  const mixed = new Float32Array(FRAME)

  function writeArm(index: number, points: Float64Array, thin: number): void {
    let tx = 0
    let ty = 0
    let tz = 1
    let ux = 0
    let uy = 1
    let uz = 0
    let v = index * VERTS_PER_ARM * 3

    for (let k = 0; k <= LAST_RING; k++) {
      // 切线：相邻两点的中心差分（两端用单侧）；点重合时沿用上一环的切线
      const ia = (k > 0 ? k - 1 : 0) * 3
      const ib = (k < LAST_RING ? k + 1 : LAST_RING) * 3
      const dx = (points[ib] as number) - (points[ia] as number)
      const dy = (points[ib + 1] as number) - (points[ia + 1] as number)
      const dz = (points[ib + 2] as number) - (points[ia + 2] as number)
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dl > 1e-7) {
        tx = dx / dl
        ty = dy / dl
        tz = dz / dl
      }

      if (k === 0) {
        // 起始背向 = 切线 × 水平侧向：触手平伸时背面朝上，吸盘朝下
        const s0x = sideX[index] as number
        const s0z = sideZ[index] as number
        ux = ty * s0z
        uy = tz * s0x - tx * s0z
        uz = -ty * s0x
      } else {
        // 无扭转地沿中心线传递：去掉背向里沿新切线的分量
        const along = ux * tx + uy * ty + uz * tz
        ux -= tx * along
        uy -= ty * along
        uz -= tz * along
      }
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
      if (ul > 1e-7) {
        ux /= ul
        uy /= ul
        uz /= ul
      } else {
        // 退化（切线与参考方向平行）：任取一个与切线垂直的方向
        const pick = Math.abs(ty) < 0.9 ? 1 : 0
        const along = pick * ty + (1 - pick) * tx
        ux = 1 - pick - tx * along
        uy = pick - ty * along
        uz = -tz * along
        const fl = Math.sqrt(ux * ux + uy * uy + uz * uz)
        ux /= fl
        uy /= fl
        uz /= fl
      }
      // 侧向 = 背向 × 切向（侧向、背向、切向构成右手系）
      const sx = uy * tz - uz * ty
      const sy = uz * tx - ux * tz
      const sz = ux * ty - uy * tx

      const c = k * 3
      const cx = points[c] as number
      const cy = points[c + 1] as number
      const cz = points[c + 2] as number
      const radius = (ringRadius[k] as number) * thin
      const ring = index * VERTS_PER_ARM + k * RING_VERTS
      for (let j = 0; j < RING_VERTS; j++) {
        const scale = (bump[ring + j] as number) * radius
        const ox = (profX[j] as number) * scale
        const oy = (profY[j] as number) * scale
        const py = cy + sy * ox + uy * oy
        positions[v] = cx + sx * ox + ux * oy
        // 软组织压在地上会摊平：低于地面的顶点贴到地面上，不穿进地里
        positions[v + 1] = py < GROUND_Y ? GROUND_Y : py
        positions[v + 2] = cz + sz * ox + uz * oy
        const nx = profNX[j] as number
        const ny = profNY[j] as number
        normals[v] = sx * nx + ux * ny
        normals[v + 1] = sy * nx + uy * ny
        normals[v + 2] = sz * nx + uz * ny
        v += 3
      }

      const f = k * FRAME
      frames[f] = cx
      frames[f + 1] = cy
      frames[f + 2] = cz
      frames[f + 3] = sx
      frames[f + 4] = sy
      frames[f + 5] = sz
      frames[f + 6] = ux
      frames[f + 7] = uy
      frames[f + 8] = uz
      frames[f + 9] = tx
      frames[f + 10] = ty
      frames[f + 11] = tz
    }

    // 吸盘：在相邻两环的标架之间插值，贴在腹面两侧，开口沿该处外法线
    let o = index * SUCKERS_PER_ARM * 16
    for (let s = 0; s < SUCKERS_PER_ARM; s++) {
      const at = suckerRing[s] as number
      const k0 = Math.min(Math.floor(at), LAST_RING - 1)
      const w = at - k0
      const f0 = k0 * FRAME
      for (let i = 0; i < FRAME; i++) {
        mixed[i] = (frames[f0 + i] as number) * (1 - w) + (frames[f0 + FRAME + i] as number) * w
      }
      const radius = lerp(ringRadius[k0] as number, ringRadius[k0 + 1] as number, w) * thin
      const side = suckerSide[s] as number
      const sx = mixed[3] as number
      const sy = mixed[4] as number
      const sz = mixed[5] as number
      const bx = mixed[6] as number
      const by = mixed[7] as number
      const bz = mixed[8] as number
      const fx = mixed[9] as number
      const fy = mixed[10] as number
      const fz = mixed[11] as number
      const ox = side * SUCKER_PX * radius
      const oy = SUCKER_PY * radius
      // 吸盘轴向（开口方向）
      const nx = sx * side * SUCKER_NX + bx * SUCKER_NY
      const ny = sy * side * SUCKER_NX + by * SUCKER_NY
      const nz = sz * side * SUCKER_NX + bz * SUCKER_NY
      const size = SUCKER_SIZE * radius
      writeMatrix(
        suckerMatrices,
        o,
        fx * size,
        fy * size,
        fz * size,
        nx * size,
        ny * size,
        nz * size,
        (fy * nz - fz * ny) * size,
        (fz * nx - fx * nz) * size,
        (fx * ny - fy * nx) * size,
        (mixed[0] as number) + sx * ox + bx * oy,
        (mixed[1] as number) + sy * ox + by * oy,
        (mixed[2] as number) + sz * ox + bz * oy,
      )
      o += 16
    }

    // 主刺：接在最后一环上，沿切线伸出，弯钩朝背面
    o = index * SPIKES_PER_ARM * 16
    const end = LAST_RING * FRAME
    const girth = SPIKE_RADIUS * thin
    const reach = SPIKE_LENGTH * thin
    writeMatrix(
      spikeMatrices,
      o,
      (frames[end + 3] as number) * girth,
      (frames[end + 4] as number) * girth,
      (frames[end + 5] as number) * girth,
      (frames[end + 6] as number) * girth,
      (frames[end + 7] as number) * girth,
      (frames[end + 8] as number) * girth,
      (frames[end + 9] as number) * reach,
      (frames[end + 10] as number) * reach,
      (frames[end + 11] as number) * reach,
      frames[end] as number,
      frames[end + 1] as number,
      frames[end + 2] as number,
    )

    // 小刺：立在背脊两侧，向尖端方向倒伏
    for (let i = 0; i < THORNS; i++) {
      o += 16
      const k = thornRing[i] as number
      const f = k * FRAME
      const ct = thornCos[i] as number
      const st = thornSin[i] as number
      const sx = frames[f + 3] as number
      const sy = frames[f + 4] as number
      const sz = frames[f + 5] as number
      const bx = frames[f + 6] as number
      const by = frames[f + 7] as number
      const bz = frames[f + 8] as number
      const fx = frames[f + 9] as number
      const fy = frames[f + 10] as number
      const fz = frames[f + 11] as number
      // 截面上该方向的外法线
      const nx = sx * ct + bx * st
      const ny = sy * ct + by * st
      const nz = sz * ct + bz * st
      // 刺的轴向与弯钩方向（互相垂直）
      const ax = nx * THORN_OUT + fx * THORN_FORWARD
      const ay = ny * THORN_OUT + fy * THORN_FORWARD
      const az = nz * THORN_OUT + fz * THORN_FORWARD
      const hx = fx * THORN_OUT - nx * THORN_FORWARD
      const hy = fy * THORN_OUT - ny * THORN_FORWARD
      const hz = fz * THORN_OUT - nz * THORN_FORWARD
      const radius = (ringRadius[k] as number) * thin * 0.9
      const thick = (thornRadius[i] as number) * thin
      const long = (thornLength[i] as number) * thin
      writeMatrix(
        spikeMatrices,
        o,
        (hy * az - hz * ay) * thick,
        (hz * ax - hx * az) * thick,
        (hx * ay - hy * ax) * thick,
        hx * thick,
        hy * thick,
        hz * thick,
        ax * long,
        ay * long,
        az * long,
        (frames[f] as number) + (sx * ct * HALF_WIDTH + bx * st * HALF_DORSAL) * radius,
        (frames[f + 1] as number) + (sy * ct * HALF_WIDTH + by * st * HALF_DORSAL) * radius,
        (frames[f + 2] as number) + (sz * ct * HALF_WIDTH + bz * st * HALF_DORSAL) * radius,
      )
    }
  }

  function commit(): void {
    positionAttr.needsUpdate = true
    normalAttr.needsUpdate = true
    suckers.instanceMatrix.needsUpdate = true
    spikes.instanceMatrix.needsUpdate = true
  }

  function dispose(): void {
    geometry.dispose()
    suckerGeometry.dispose()
    spikeGeometry.dispose()
    suckers.dispose()
    spikes.dispose()
  }

  return { mesh, suckers, spikes, writeArm, commit, dispose }
}

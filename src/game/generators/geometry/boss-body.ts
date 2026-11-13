/**
 * Boss 身体部分的几何体与零件组装（全部只在创建时执行）。
 *
 * 身体是一张连续的曲面：把外套膜、裙膜、眼丘、眉脊、8 个触手肩部当作椭球距离场，用光滑并集融成一个隐式曲面，
 * 再从体内一点向各方向发射线求交，得到经纬网格。两个核心的位置各挖一个眼窝（核心外膜半透明，后面不能有皮肤穿过）。
 * 之后沿法线做多层位移（大形起伏、垂褶、脓疮、溃烂坑），并把皮肤固有色与病变颜色写进顶点色。
 *
 * 核心 = 内层发光体 + 半透明外膜 + 上下两片肥厚眼睑 + 一圈肉褶；眼睛 = 眼球 + 两片眼睑 + 眼眶。
 * 眼睑是 1/4 球壳，绕横轴转动开合。
 */

import { BufferAttribute, BufferGeometry, Color, Group, Matrix4, Mesh, SphereGeometry, TorusGeometry, Vector3 } from 'three'
import type { Material } from 'three'
import { clamp, lerp, smoothstep } from '../../utils/math'
import { getNoise } from '../../utils/noise'
import {
  BACK_CORE_POS,
  BACK_CORE_RADIUS,
  CORE_SOCKET_SCALE,
  EYE_DIR,
  EYE_POS,
  EYE_PROTRUDE,
  EYE_RADIUS,
  HEAD_CORE_POS,
  HEAD_CORE_RADIUS,
  INFLAMED,
  NECROSIS,
  PUS_HEAD,
  SKIN_BASE,
  SKIN_BRUISE,
  SKIN_DARK,
  SKIN_PALE,
  TAU,
  TENTACLES,
  armAzimuth,
  cellular3,
} from './boss-shared'
import type { CellSample } from './boss-shared'

/* ── 身体网格 ── */

/** 经纬网格的列数（绕竖直轴一圈）与行数（从头顶到底面中心） */
const BODY_COLS = 104
const BODY_ROWS = 68
/** 射线的发出点：在头部与裙部的重叠区里，从这里能看到整个外表面 */
const ORIGIN_Y = 1.35
const ORIGIN_Z = -0.15
/** 裙膜下缘相对发出点的天顶角；在此之上分配 ROW_SPLIT 比例的行，底面看不见，只留少量行 */
const RIM_ANGLE = 2.15
const ROW_SPLIT = 0.86
/** 皮肤贴图：绕身体一圈铺的次数，以及沿经线方向每铺一次的长度（米） */
const BODY_U_REPEAT = 8
const BODY_V_METRES = 1.4

/** 核心眼窝内壁的颜色：藏在发光体后面的暗红 */
const SOCKET_DARK = new Color(0x3a0a0e)

/** 距离场里的一个椭球 */
interface Blob {
  cx: number
  cy: number
  cz: number
  rx: number
  ry: number
  rz: number
  /** 与已有形体融合的圆滑宽度（米） */
  blend: number
}

/** 要从身体里挖掉的球（核心眼窝） */
interface Socket {
  x: number
  y: number
  z: number
  r: number
}

function createBlobs(): Blob[] {
  const blobs: Blob[] = [
    // 头部 / 外套膜：前后拉长，顶端高度 3 米
    { cx: 0, cy: 1.7, cz: -0.25, rx: 1.75, ry: 1.3, rz: 2.05, blend: 0 },
    // 裙部：头部下方压扁的一团，触手从这里伸出
    { cx: 0, cy: 0.72, cz: 0.1, rx: 1.66, ry: 0.7, rz: 1.72, blend: 0.55 },
    // 外套膜后部向下垮的一团
    { cx: 0, cy: 1.2, cz: -1.4, rx: 1.3, ry: 0.95, rz: 1, blend: 0.5 },
  ]
  for (let side = -1; side <= 1; side += 2) {
    // 眼丘：眼球坐在上面
    blobs.push({ cx: side * EYE_POS.x, cy: EYE_POS.y, cz: EYE_POS.z, rx: 0.36, ry: 0.36, rz: 0.36, blend: 0.22 })
    // 眉脊：压在眼睛上方，前后走向
    blobs.push({ cx: side * 1.3, cy: 2.26, cz: 1, rx: 0.3, ry: 0.15, rz: 0.44, blend: 0.2 })
  }
  for (let i = 0; i < TENTACLES; i++) {
    // 触手肩部：裙膜在每条触手根部鼓出一瓣，把根部包在里面
    const azimuth = armAzimuth(i)
    blobs.push({
      cx: Math.sin(azimuth) * 1.4,
      cy: 0.8,
      cz: Math.cos(azimuth) * 1.4,
      rx: 0.6,
      ry: 0.6,
      rz: 0.6,
      blend: 0.3,
    })
  }
  return blobs
}

/** 点到椭球表面的近似有向距离（内部为负） */
function blobDistance(b: Blob, x: number, y: number, z: number): number {
  const qx = (x - b.cx) / b.rx
  const qy = (y - b.cy) / b.ry
  const qz = (z - b.cz) / b.rz
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz)
  const gx = qx / b.rx
  const gy = qy / b.ry
  const gz = qz / b.rz
  const k1 = Math.sqrt(gx * gx + gy * gy + gz * gz)
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(b.rx, b.ry, b.rz)
}

/** 光滑最小值：两个距离相差不到 k 时圆滑过渡 */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b)
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** 身体的距离场：全部椭球的光滑并集，再挖掉核心眼窝 */
function bodyField(blobs: readonly Blob[], sockets: readonly Socket[], x: number, y: number, z: number): number {
  let d = blobDistance(blobs[0] as Blob, x, y, z)
  for (let i = 1; i < blobs.length; i++) {
    const blob = blobs[i] as Blob
    d = smoothMin(d, blobDistance(blob, x, y, z), blob.blend)
  }
  for (let i = 0; i < sockets.length; i++) {
    const s = sockets[i] as Socket
    const dx = x - s.x
    const dy = y - s.y
    const dz = z - s.z
    // 球内为正：与身体求光滑最大值，等于把球挖掉
    const cut = s.r - Math.sqrt(dx * dx + dy * dy + dz * dz)
    d = -smoothMin(-d, -cut, 0.08)
  }
  return d
}

/** 沿方向 (dx, dy, dz) 从外向内找到最外层的表面，返回到发出点的距离 */
function castSurface(
  blobs: readonly Blob[],
  sockets: readonly Socket[],
  dx: number,
  dy: number,
  dz: number,
): number {
  let hi = 3.4
  let t = hi
  // 球面步进：每次按当前距离的一部分前进，直到进入体内
  for (let i = 0; i < 120; i++) {
    const d = bodyField(blobs, sockets, dx * t, ORIGIN_Y + dy * t, ORIGIN_Z + dz * t)
    if (d <= 0) break
    hi = t
    t = Math.max(0, t - Math.max(d * 0.7, 0.02))
    if (t === 0) break
  }
  let lo = t
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (bodyField(blobs, sockets, dx * mid, ORIGIN_Y + dy * mid, ORIGIN_Z + dz * mid) > 0) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/**
 * 把经纬网格接缝列与两极处位置重合的顶点的法线取平均，消除 computeVertexNormals 留下的接缝。
 * 顶点排布：(rows + 1) 行，每行 (cols + 1) 个。
 */
function weldGridNormals(geometry: BufferGeometry, cols: number, rows: number): void {
  const normal = geometry.getAttribute('normal')
  const row = cols + 1
  for (let iy = 0; iy <= rows; iy++) {
    const first = iy * row
    // 两极整行重合；其余行只有首尾两个顶点重合
    const stride = iy === 0 || iy === rows ? 1 : cols
    let sx = 0
    let sy = 0
    let sz = 0
    for (let ix = 0; ix <= cols; ix += stride) {
      sx += normal.getX(first + ix)
      sy += normal.getY(first + ix)
      sz += normal.getZ(first + ix)
    }
    const len = Math.hypot(sx, sy, sz) || 1
    for (let ix = 0; ix <= cols; ix += stride) normal.setXYZ(first + ix, sx / len, sy / len, sz / len)
  }
  normal.needsUpdate = true
}

/** 小数部分：从一个随机数派生出另一个 */
function fract(v: number): number {
  return v - Math.floor(v)
}

/**
 * 生成身体（外套膜 + 头部 + 裙膜）的几何体，模型坐标。带 position / normal / uv / color。
 * @param seed 病变分布的种子
 */
export function createBodyGeometry(seed: number): BufferGeometry {
  const noise = getNoise(seed)
  const cell: CellSample = { f1: 0, f2: 0, id: 0 }
  const blobs = createBlobs()
  const sockets: Socket[] = [
    { x: HEAD_CORE_POS.x, y: HEAD_CORE_POS.y, z: HEAD_CORE_POS.z, r: HEAD_CORE_RADIUS * CORE_SOCKET_SCALE },
    { x: BACK_CORE_POS.x, y: BACK_CORE_POS.y, z: BACK_CORE_POS.z, r: BACK_CORE_RADIUS * CORE_SOCKET_SCALE },
  ]
  const row = BODY_COLS + 1
  const count = (BODY_ROWS + 1) * row
  const positions = new Float32Array(count * 3)

  // 第一步：光滑的基础形体
  for (let iy = 0; iy <= BODY_ROWS; iy++) {
    const s = iy / BODY_ROWS
    const phi =
      s < ROW_SPLIT
        ? (s / ROW_SPLIT) * RIM_ANGLE
        : RIM_ANGLE + ((s - ROW_SPLIT) / (1 - ROW_SPLIT)) * (Math.PI - RIM_ANGLE)
    const sp = Math.sin(phi)
    const cp = Math.cos(phi)
    for (let ix = 0; ix < BODY_COLS; ix++) {
      // 接缝放在正后方
      const theta = (ix / BODY_COLS) * TAU + Math.PI
      const dx = sp * Math.sin(theta)
      const dz = sp * Math.cos(theta)
      const t = castSurface(blobs, sockets, dx, cp, dz)
      const v = (iy * row + ix) * 3
      positions[v] = dx * t
      positions[v + 1] = ORIGIN_Y + cp * t
      positions[v + 2] = ORIGIN_Z + dz * t
    }
    // 接缝列与第 0 列重合（只为了 UV 连续）
    const from = iy * row * 3
    const to = (iy * row + BODY_COLS) * 3
    positions[to] = positions[from] as number
    positions[to + 1] = positions[from + 1] as number
    positions[to + 2] = positions[from + 2] as number
  }

  const indices: number[] = []
  for (let iy = 0; iy < BODY_ROWS; iy++) {
    for (let ix = 0; ix < BODY_COLS; ix++) {
      const a = iy * row + ix + 1
      const b = iy * row + ix
      const c = (iy + 1) * row + ix
      const d = c + 1
      if (iy !== 0) indices.push(a, b, d)
      if (iy !== BODY_ROWS - 1) indices.push(b, c, d)
    }
  }

  const geometry = new BufferGeometry()
  const positionAttr = new BufferAttribute(positions, 3)
  geometry.setAttribute('position', positionAttr)
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  weldGridNormals(geometry, BODY_COLS, BODY_ROWS)
  const normals = geometry.getAttribute('normal')

  // 第二步：沿光滑法线做病变位移，同时算顶点色
  const colors = new Float32Array(count * 3)
  const color = new Color()
  const eyeX = EYE_POS.x + EYE_DIR.x * EYE_PROTRUDE
  const eyeY = EYE_POS.y + EYE_DIR.y * EYE_PROTRUDE
  const eyeZ = EYE_POS.z + EYE_DIR.z * EYE_PROTRUDE
  const headSocket = HEAD_CORE_RADIUS * CORE_SOCKET_SCALE
  const backSocket = BACK_CORE_RADIUS * CORE_SOCKET_SCALE
  for (let iy = 0; iy <= BODY_ROWS; iy++) {
    for (let ix = 0; ix < BODY_COLS; ix++) {
      const i = iy * row + ix
      const x = positions[i * 3] as number
      const y = positions[i * 3 + 1] as number
      const z = positions[i * 3 + 2] as number

      const toHead = Math.hypot(x - HEAD_CORE_POS.x, y - HEAD_CORE_POS.y, z - HEAD_CORE_POS.z)
      const toBack = Math.hypot(x - BACK_CORE_POS.x, y - BACK_CORE_POS.y, z - BACK_CORE_POS.z)
      const toEye = Math.hypot(Math.abs(x) - eyeX, y - eyeY, z - eyeZ)
      // 核心、眼睛周围与贴地的底面保持平整，其余地方才长病变
      const nearEye = 1 - smoothstep((toEye - 0.4) / 0.3)
      const calm =
        Math.min(smoothstep((toHead - headSocket - 0.1) / 0.5), smoothstep((toBack - backSocket - 0.1) / 0.5)) *
        (1 - nearEye) *
        smoothstep((y - 0.12) / 0.4)

      // 大形起伏
      const lump =
        0.11 * noise.noise3D(x * 0.75, y * 0.75, z * 0.75) + 0.05 * noise.noise3D(x * 1.7 + 11, y * 1.7, z * 1.7)
      // 垂褶：绕身体一圈的横向皱纹，颈部与外套膜后下方最明显
      const ridge = 1 - Math.abs(noise.noise3D(x * 0.8, y * 5.2, z * 0.8 + 40))
      const fold = ridge * ridge * ridge
      const sag = clamp(
        Math.max(1 - Math.abs(y - 1.2) / 0.5, smoothstep((-z - 0.9) / 0.8) * smoothstep((2.2 - y) / 0.8)),
        0,
        1,
      )
      const folds = 0.3 + 0.7 * sag

      // 溃烂坑：约三成的格子塌陷下去，边缘微微翻起
      cellular3(x * 1.1 + 7, y * 1.1, z * 1.1 + 3, seed + 9, cell)
      let rot = 0
      let rotRim = 0
      if (cell.id < 0.3) {
        const t = cell.f1 / (0.35 + 0.25 * fract(cell.id * 29.3))
        if (t < 1) rot = 1 - t * t
        rotRim = Math.max(0, 1 - Math.abs(t - 1) / 0.3)
      }
      // 脓疮：约一半的格子鼓起圆顶，大小与高度各不相同；烂掉的地方不再鼓包
      cellular3(x * 1.55, y * 1.55, z * 1.55, seed + 3, cell)
      let pus = 0
      let sore = 0
      let height = 0
      if (cell.id < 0.5) {
        const t = cell.f1 / (0.28 + 0.3 * fract(cell.id * 17.13))
        if (t < 1) pus = Math.pow(1 - t * t, 0.6) * (1 - rot)
        sore = Math.max(0, 1 - Math.abs(t - 1) / 0.45) * (1 - rot)
        height = 0.07 + 0.1 * fract(cell.id * 91.7)
      }

      const offset = calm * (lump + 0.05 * fold * folds + height * pus - 0.08 * rot + 0.025 * rotRim)
      positions[i * 3] = x + normals.getX(i) * offset
      positions[i * 3 + 1] = y + normals.getY(i) * offset
      positions[i * 3 + 2] = z + normals.getZ(i) * offset

      // 底色：紫红带深浅斑驳与淤青；裙膜下缘发浅；褶皱谷底发暗
      const mottle = 0.5 + 0.5 * noise.noise3D(x * 1.3 + 5, y * 1.3, z * 1.3)
      const speckle = noise.noise3D(x * 3.6, y * 3.6 + 9, z * 3.6)
      color.copy(SKIN_BASE).lerp(SKIN_DARK, smoothstep(mottle) * 0.7)
      color.lerp(SKIN_BRUISE, smoothstep((speckle - 0.25) / 0.4) * 0.45)
      color.lerp(SKIN_PALE, (1 - smoothstep((y - 0.15) / 0.75)) * 0.6)
      color.multiplyScalar(lerp(1, lerp(0.78, 1.05, fold), folds))
      // 病变：脓疮外圈红肿、顶部黄白；溃烂处黑绿
      color.lerp(INFLAMED, calm * sore * 0.6)
      // 脓头只占鼓包顶部的一小块，其余是红肿的包体
      color.lerp(PUS_HEAD, calm * pus * pus * pus * pus * 0.9)
      color.lerp(NECROSIS, calm * Math.min(1, rot * 1.6) * 0.9)
      // 核心周围发炎泛红，眼窝内壁暗红；眼睛周围颜色深
      const red = Math.max(1 - smoothstep((toHead - headSocket) / 0.7), 1 - smoothstep((toBack - backSocket) / 0.6))
      color.lerp(INFLAMED, red * 0.65)
      const pit = Math.max(1 - smoothstep((toHead - headSocket) / 0.06), 1 - smoothstep((toBack - backSocket) / 0.06))
      color.lerp(SOCKET_DARK, pit)
      color.lerp(SKIN_DARK, nearEye * 0.6)
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }
    const from = iy * row
    const to = from + BODY_COLS
    for (let k = 0; k < 3; k++) {
      positions[to * 3 + k] = positions[from * 3 + k] as number
      colors[to * 3 + k] = colors[from * 3 + k] as number
    }
  }
  positionAttr.needsUpdate = true
  geometry.computeVertexNormals()
  weldGridNormals(geometry, BODY_COLS, BODY_ROWS)

  // UV：横向按列均分；纵向按各行之间的平均间距累计，贴图在身体各处的拉伸大致均匀
  const uvs = new Float32Array(count * 2)
  let travelled = 0
  for (let iy = 0; iy <= BODY_ROWS; iy++) {
    if (iy > 0) {
      let sum = 0
      for (let ix = 0; ix < BODY_COLS; ix++) {
        const a = (iy * row + ix) * 3
        const b = a - row * 3
        sum += Math.hypot(
          (positions[a] as number) - (positions[b] as number),
          (positions[a + 1] as number) - (positions[b + 1] as number),
          (positions[a + 2] as number) - (positions[b + 2] as number),
        )
      }
      travelled += sum / BODY_COLS
    }
    for (let ix = 0; ix <= BODY_COLS; ix++) {
      const i = iy * row + ix
      uvs[i * 2] = (ix / BODY_COLS) * BODY_U_REPEAT
      uvs[i * 2 + 1] = -travelled / BODY_V_METRES
    }
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  return geometry
}

/* ── 眼睑、眼眶、眼球、液体 ── */

const LID_COLS = 14
/** 眼睑主体的行数与卷边的行数 */
const LID_SHELL_ROWS = 6
const LID_LIP_ROWS = 3
/** 眼睑外表面的半径（以它盖住的球为 1） */
const LID_OUTER = 1.2
/** 卷边占的角度：眼睑边缘在这段里向内卷到贴住球面 */
const LID_LIP = 0.14

/**
 * 生成一片眼睑：盖住单位球正面上半边（y ≥ 0、z ≥ 0）的肥厚 1/4 球壳，边缘向内卷成圆唇。
 * 绕 X 轴转动即可开合；下眼睑用同一片绕 Z 轴转半圈。核心与眼睛共用。
 */
export function createLidGeometry(seed: number): BufferGeometry {
  const noise = getNoise(seed)
  const rows = LID_SHELL_ROWS + LID_LIP_ROWS
  const row = LID_COLS + 1
  const count = (rows + 1) * row
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  const color = new Color()
  for (let iy = 0; iy <= rows; iy++) {
    let theta: number
    let radius: number
    // 0 主体 .. 1 最边缘
    let edge = 0
    if (iy <= LID_SHELL_ROWS) {
      theta = (iy / LID_SHELL_ROWS) * (Math.PI / 2 - LID_LIP)
      // 平行于眼睑边缘的几道褶痕
      radius = LID_OUTER + 0.025 * Math.sin(theta * 16) * smoothstep(theta / 0.4)
    } else {
      const a = ((iy - LID_SHELL_ROWS) / LID_LIP_ROWS) * (Math.PI / 2)
      theta = Math.PI / 2 - LID_LIP + LID_LIP * Math.sin(a)
      radius = 1.01 + (LID_OUTER - 1.01) * Math.cos(a)
      edge = (iy - LID_SHELL_ROWS) / LID_LIP_ROWS
    }
    const st = Math.sin(theta)
    const ct = Math.cos(theta)
    for (let ix = 0; ix <= LID_COLS; ix++) {
      const phi = (ix / LID_COLS) * Math.PI
      const ux = -Math.cos(phi) * st
      const uz = Math.sin(phi) * st
      const wobble = 0.02 * noise.noise3D(ux * 3, ct * 3, uz * 3) * (1 - edge)
      const r = radius + wobble
      const i = iy * row + ix
      positions[i * 3] = ux * r
      positions[i * 3 + 1] = ct * r
      positions[i * 3 + 2] = uz * r

      // 越靠边缘越红肿，最边上一线发暗
      const mottle = 0.5 + 0.5 * noise.noise3D(ux * 2.2 + 7, ct * 2.2, uz * 2.2)
      color.copy(SKIN_BASE).lerp(SKIN_DARK, 0.35 + 0.4 * mottle)
      color.lerp(INFLAMED, smoothstep((theta - 0.7) / 0.7) * 0.7)
      color.multiplyScalar(lerp(1, 0.55, edge * edge))
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
      uvs[i * 2] = (ix / LID_COLS) * 2
      uvs[i * 2 + 1] = iy / rows
    }
  }
  const indices: number[] = []
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < LID_COLS; ix++) {
      const a = iy * row + ix + 1
      const b = iy * row + ix
      const c = (iy + 1) * row + ix
      const d = c + 1
      // 第 0 行收在极点上，只有一个三角形
      if (iy !== 0) indices.push(a, b, d)
      indices.push(b, c, d)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 生成围着核心（或眼球）的一圈肉褶：轴线沿 Z 的圆环，表面略有起伏，稍微退到球心后面，盖住眼睑与身体的交线。
 * 尺寸以被包围的球的半径为 1。
 */
export function createRimGeometry(seed: number): BufferGeometry {
  const noise = getNoise(seed)
  const geometry = new TorusGeometry(1.22, 0.3, 8, 24)
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  const colors = new Float32Array(position.count * 3)
  const color = new Color()
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    // 位移只与位置有关，接缝两侧重合的顶点会得到相同的结果
    const swell = 0.07 * noise.noise3D(x * 2.2, y * 2.2, z * 2.2) + 0.04 * noise.noise3D(x * 5 + 3, y * 5, z * 5)
    position.setXYZ(i, x + normal.getX(i) * swell, y + normal.getY(i) * swell, z + normal.getZ(i) * swell - 0.2)
    const mottle = 0.5 + 0.5 * noise.noise3D(x * 1.8 + 9, y * 1.8, z * 1.8)
    color.copy(SKIN_DARK).lerp(INFLAMED, 0.35 + 0.45 * mottle)
    // 内圈（靠近球面）更暗
    color.multiplyScalar(lerp(0.6, 1, smoothstep((Math.hypot(x, y) - 0.95) / 0.4)))
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
    uv.setXY(i, uv.getX(i) * 4, uv.getY(i))
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  return geometry
}

/**
 * 生成眼球：单位球，极点转到 +Z。配套的虹膜贴图是极坐标展开（v = 1 在瞳孔中心）。
 */
export function createEyeballGeometry(): BufferGeometry {
  const geometry = new SphereGeometry(1, 20, 12)
  geometry.rotateX(Math.PI / 2)
  return geometry
}

/**
 * 生成核心破裂后流到地上的那滩液体：贴地的不规则圆片，半径约为 1，法线朝上。
 */
export function createPuddleGeometry(seed: number): BufferGeometry {
  const noise = getNoise(seed)
  const sides = 28
  const positions = new Float32Array((sides + 1) * 3)
  const normals = new Float32Array((sides + 1) * 3)
  const uvs = new Float32Array((sides + 1) * 2)
  const indices: number[] = []
  normals[1] = 1
  uvs[0] = 0.5
  uvs[1] = 0.5
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * TAU
    const r = 0.78 + 0.22 * noise.noise2D(Math.cos(a) * 1.6 + 5, Math.sin(a) * 1.6)
    const i = s + 1
    positions[i * 3] = Math.sin(a) * r
    positions[i * 3 + 2] = Math.cos(a) * r
    normals[i * 3 + 1] = 1
    uvs[i * 2] = 0.5 + 0.5 * Math.sin(a) * r
    uvs[i * 2 + 1] = 0.5 + 0.5 * Math.cos(a) * r
    indices.push(0, i, 1 + ((s + 1) % sides))
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

/* ── 零件组装 ── */

/** 让实体网格参与阴影 */
function solid(mesh: Mesh): Mesh {
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

export interface CoreShapes {
  /** 内层发光体（半径已经是 CORE_INNER_RADIUS） */
  inner: BufferGeometry
  /** 外膜：单位球 */
  shell: BufferGeometry
  lid: BufferGeometry
  rim: BufferGeometry
}

export interface CoreParts {
  /** 本地 +Z 是核心朝外的方向；缩放 = 核心半径 */
  pivot: Group
  inner: Mesh
  shell: Mesh
  upperLid: Mesh
  lowerLid: Mesh
  rim: Mesh
}

/**
 * 组装一个核心：内层发光体 + 半透明外膜 + 上下眼睑 + 周围的肉褶。外膜的球面就是命中球。
 * @param radius 核心半径（米）
 */
export function buildCore(
  shapes: CoreShapes,
  innerMaterial: Material,
  shellMaterial: Material,
  lidMaterial: Material,
  rimMaterial: Material,
  radius: number,
): CoreParts {
  const pivot = new Group()
  pivot.scale.setScalar(radius)
  const inner = new Mesh(shapes.inner, innerMaterial)
  const shell = new Mesh(shapes.shell, shellMaterial)
  const upperLid = solid(new Mesh(shapes.lid, lidMaterial))
  const lowerLid = solid(new Mesh(shapes.lid, lidMaterial))
  // 下眼睑：同一片球壳绕 Z 轴转半圈
  lowerLid.rotation.z = Math.PI
  const rim = solid(new Mesh(shapes.rim, rimMaterial))
  pivot.add(inner, shell, upperLid, lowerLid, rim)
  return { pivot, inner, shell, upperLid, lowerLid, rim }
}

export interface EyeShapes {
  ball: BufferGeometry
  lid: BufferGeometry
  rim: BufferGeometry
}

export interface EyeParts {
  /** 本地 +Z 是视线方向，本地 X 水平（瞳孔沿它横放）；缩放 = 眼球半径 */
  pivot: Group
  upperLid: Mesh
  lowerLid: Mesh
}

/**
 * 组装一只眼睛并摆到眼丘上（模型坐标）。
 * @param side +1 右眼（+X 一侧），-1 左眼
 */
export function buildEye(side: 1 | -1, shapes: EyeShapes, eyeMaterial: Material, skinMaterial: Material): EyeParts {
  const pivot = new Group()
  const forward = new Vector3(side * EYE_DIR.x, EYE_DIR.y, EYE_DIR.z)
  // 横轴取水平方向，瞳孔才是横的
  const right = new Vector3(0, 1, 0).cross(forward).normalize()
  const up = new Vector3().crossVectors(forward, right)
  pivot.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(right, up, forward))
  pivot.position.set(side * EYE_POS.x, EYE_POS.y, EYE_POS.z).addScaledVector(forward, EYE_PROTRUDE)
  pivot.scale.setScalar(EYE_RADIUS)

  const ball = solid(new Mesh(shapes.ball, eyeMaterial))
  const upperLid = solid(new Mesh(shapes.lid, skinMaterial))
  const lowerLid = solid(new Mesh(shapes.lid, skinMaterial))
  lowerLid.rotation.z = Math.PI
  const rim = solid(new Mesh(shapes.rim, skinMaterial))
  // 眼眶比核心的肉褶略靠前：环的中心线落在眼丘表面附近，大约埋进去一半，看上去是眼睛周围隆起的一圈肉
  rim.position.z = 0.25
  pivot.add(ball, upperLid, lowerLid, rim)
  return { pivot, upperLid, lowerLid }
}

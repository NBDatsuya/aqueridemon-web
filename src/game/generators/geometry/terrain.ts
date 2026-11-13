/**
 * 后山：SPEC“边界封锁物 · 北侧（后山）”所说的后山，放在北侧树林背后的一片缓坡草丘。
 * 高度场由平滑的值噪声叠加，坡度平缓（约 8-25 米），颜色写在顶点上（草地为主，夹杂泥土与枯草）。
 */

import { BufferGeometry, Color, Float32BufferAttribute, Mesh, MeshStandardMaterial } from 'three'

/** 后山范围（米，世界坐标）：东西 ±HALF_WIDTH，南北从 NEAR_Z 往北到 FAR_Z */
const HILLS = {
  halfWidth: 230,
  nearZ: -132,
  farZ: -310,
  /** 起伏高度：基础坡高 + 噪声起伏 */
  base: 9,
  swell: 16,
  segX: 120,
  segZ: 60,
  seed: 17,
} as const

const GRASS = new Color(0x5f7f42)
const MEADOW = new Color(0x78894a)
const DIRT = new Color(0x7a6a4e)

function hash(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return s - Math.floor(s)
}

/** 二维值噪声 [0, 1] */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash(xi, yi, seed)
  const b = hash(xi + 1, yi, seed)
  const c = hash(xi, yi + 1, seed)
  const d = hash(xi + 1, yi + 1, seed)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** 平滑的分形噪声 [0, 1]：只叠三层，起伏圆润，没有尖棱 */
function rolling(x: number, y: number, seed: number): number {
  let sum = 0
  let amp = 0.6
  let norm = 0
  let freq = 1
  for (let o = 0; o < 3; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 13) * amp
    norm += amp
    amp *= 0.4
    freq *= 2.1
  }
  return sum / norm
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 后山高度：南缘（树林一侧）埋在地面以下，往北缓缓升起成几道圆润的丘顶，东西两端回落到地面 */
function hillHeight(x: number, z: number): number {
  const { halfWidth, nearZ, farZ, base, swell, seed } = HILLS
  const t = (nearZ - z) / (nearZ - farZ)
  const rise = smooth(0, 0.45, t)
  const ends = 1 - smooth(0.7, 1, Math.abs(x) / halfWidth)
  const n = rolling(x / 70, z / 55, seed)
  return (base + swell * n) * rise * ends - 1.2 * (1 - smooth(0, 0.06, t))
}

/** 生成后山的几何体（顶点色已写入） */
function hillGeometry(): BufferGeometry {
  const { halfWidth, nearZ, farZ, segX, segZ, seed } = HILLS
  const cols = segX + 1
  const rows = segZ + 1
  const heights = new Float32Array(cols * rows)
  const pos = new Float32Array(cols * rows * 3)
  for (let j = 0; j < rows; j++) {
    const z = nearZ + ((farZ - nearZ) * j) / segZ
    for (let i = 0; i < cols; i++) {
      const x = -halfWidth + (2 * halfWidth * i) / segX
      const h = hillHeight(x, z)
      const k = j * cols + i
      heights[k] = h
      pos[k * 3] = x
      pos[k * 3 + 1] = h
      pos[k * 3 + 2] = z
    }
  }

  const index: number[] = []
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      // 列沿 +X、行沿 -Z 推进：(b - a) × (c - a) 指向 +Y
      index.push(a, b, c, b, d, c)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setIndex(index)
  g.computeVertexNormals()

  // 顶点色：草地为主，低频夹杂浅色草甸，稍陡处和坡脚露一点泥土
  const nor = g.getAttribute('normal')
  const col = new Float32Array(cols * rows * 3)
  const c = new Color()
  for (let k = 0; k < cols * rows; k++) {
    const x = pos[k * 3]
    const z = pos[k * 3 + 2]
    const slope = 1 - nor.getY(k)
    const meadow = valueNoise(x / 24, z / 24, seed + 99)
    c.copy(GRASS).lerp(MEADOW, smooth(0.35, 0.85, meadow) * 0.8)
    c.lerp(DIRT, smooth(0.06, 0.16, slope) * 0.5 + (1 - smooth(0.5, 3, heights[k])) * 0.25)
    col[k * 3] = c.r
    col[k * 3 + 1] = c.g
    col[k * 3 + 2] = c.b
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  g.computeBoundingSphere()
  return g
}

export interface Hills {
  mesh: Mesh
  dispose(): void
}

/** 创建北侧后山（世界坐标，地面 y = 0）。远景只受光、不参与阴影 */
export function createHills(): Hills {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.6 })
  const mesh = new Mesh(hillGeometry(), material)
  mesh.name = 'hills'
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.matrixAutoUpdate = false
  return {
    mesh,
    dispose() {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}

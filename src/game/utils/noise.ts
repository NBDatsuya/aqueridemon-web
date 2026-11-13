/**
 * 程序化噪声：Simplex 2D/3D、分形布朗运动（fbm）、Worley（细胞）噪声。
 * 自行实现，不依赖外部库。所有函数对同一种子可复现。
 */

import { createRng } from './random'

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6
const F3 = 1 / 3
const G3 = 1 / 6

/** 12 个梯度方向（x, y, z 连续存放） */
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0,
  -1, -1,
])

export interface Noise {
  /** Simplex 2D，返回 [-1, 1] */
  noise2D(x: number, y: number): number
  /** Simplex 3D，返回 [-1, 1] */
  noise3D(x: number, y: number, z: number): number
  /** 多倍频叠加的 2D 噪声，返回约 [-1, 1] */
  fbm2D(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number
  /** Worley 噪声：到最近特征点的距离，返回 [0, 1]（越靠近细胞边界越大） */
  worley2D(x: number, y: number): number
}

/**
 * 创建一组共享同一置换表的噪声函数。
 * @param seed 种子
 */
export function createNoise(seed = 1337): Noise {
  const rng = createRng(seed)
  const base = new Uint8Array(256)
  for (let i = 0; i < 256; i++) base[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    const tmp = base[i] as number
    base[i] = base[j] as number
    base[j] = tmp
  }
  const perm = new Uint8Array(512)
  const permMod12 = new Uint8Array(512)
  for (let i = 0; i < 512; i++) {
    const v = base[i & 255] as number
    perm[i] = v
    permMod12[i] = v % 12
  }
  const p = (i: number): number => perm[i] as number
  const pm = (i: number): number => permMod12[i] as number
  const g = (i: number): number => GRAD3[i] as number

  const noise2D = (xin: number, yin: number): number => {
    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)
    const i1 = x0 > y0 ? 1 : 0
    const j1 = x0 > y0 ? 0 : 1
    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2
    const ii = i & 255
    const jj = j & 255

    let n = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 > 0) {
      const gi = pm(ii + p(jj)) * 3
      t0 *= t0
      n += t0 * t0 * (g(gi) * x0 + g(gi + 1) * y0)
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 > 0) {
      const gi = pm(ii + i1 + p(jj + j1)) * 3
      t1 *= t1
      n += t1 * t1 * (g(gi) * x1 + g(gi + 1) * y1)
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 > 0) {
      const gi = pm(ii + 1 + p(jj + 1)) * 3
      t2 *= t2
      n += t2 * t2 * (g(gi) * x2 + g(gi + 1) * y2)
    }
    return 70 * n
  }

  const noise3D = (xin: number, yin: number, zin: number): number => {
    const s = (xin + yin + zin) * F3
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const k = Math.floor(zin + s)
    const t = (i + j + k) * G3
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)
    const z0 = zin - (k - t)

    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }

    const x1 = x0 - i1 + G3
    const y1 = y0 - j1 + G3
    const z1 = z0 - k1 + G3
    const x2 = x0 - i2 + 2 * G3
    const y2 = y0 - j2 + 2 * G3
    const z2 = z0 - k2 + 2 * G3
    const x3 = x0 - 1 + 3 * G3
    const y3 = y0 - 1 + 3 * G3
    const z3 = z0 - 1 + 3 * G3
    const ii = i & 255
    const jj = j & 255
    const kk = k & 255

    let n = 0
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
    if (t0 > 0) {
      const gi = pm(ii + p(jj + p(kk))) * 3
      t0 *= t0
      n += t0 * t0 * (g(gi) * x0 + g(gi + 1) * y0 + g(gi + 2) * z0)
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
    if (t1 > 0) {
      const gi = pm(ii + i1 + p(jj + j1 + p(kk + k1))) * 3
      t1 *= t1
      n += t1 * t1 * (g(gi) * x1 + g(gi + 1) * y1 + g(gi + 2) * z1)
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
    if (t2 > 0) {
      const gi = pm(ii + i2 + p(jj + j2 + p(kk + k2))) * 3
      t2 *= t2
      n += t2 * t2 * (g(gi) * x2 + g(gi + 1) * y2 + g(gi + 2) * z2)
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
    if (t3 > 0) {
      const gi = pm(ii + 1 + p(jj + 1 + p(kk + 1))) * 3
      t3 *= t3
      n += t3 * t3 * (g(gi) * x3 + g(gi + 1) * y3 + g(gi + 2) * z3)
    }
    return 32 * n
  }

  const fbm2D = (x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number => {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise2D(x * freq, y * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  /** 细胞内特征点的伪随机偏移 [0, 1) */
  const cellHash = (cx: number, cy: number, salt: number): number =>
    p((cx & 255) + p((cy & 255) + salt)) / 255

  const worley2D = (x: number, y: number): number => {
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    let best = 8
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = cx + ox + cellHash(cx + ox, cy + oy, 0)
        const py = cy + oy + cellHash(cx + ox, cy + oy, 37)
        const d = (px - x) * (px - x) + (py - y) * (py - y)
        if (d < best) best = d
      }
    }
    return Math.min(1, Math.sqrt(best))
  }

  return { noise2D, noise3D, fbm2D, worley2D }
}

const cache = new Map<number, Noise>()

/**
 * 取得按种子缓存的噪声实例（同种子只建一次置换表）。
 * @param seed 种子
 */
export function getNoise(seed = 1337): Noise {
  let noise = cache.get(seed)
  if (!noise) {
    noise = createNoise(seed)
    cache.set(seed, noise)
  }
  return noise
}

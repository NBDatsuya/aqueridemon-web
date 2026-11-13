/**
 * PBR 表面：木与植物（上漆胡桃木、风化木板、树皮、叶丛）。
 * 木纹统一用“年轮坐标”生成：t = 沿 v 的线性项 + 周期噪声扭曲，取 t 的小数部分作为一圈年轮内的位置，
 * 线性项的系数是整数，所以贴图上下、左右都能无缝衔接，纹理连续流畅。
 */

import { clamp01, hash2, mix, smoothstep } from './pbr-core'
import type { Gen } from './pbr-core'

const TAU = Math.PI * 2

/** 上漆胡桃木（枪托）：弦切面的流畅年轮、顺纹导管孔、深浅图案，漆面半光泽 */
export function wood(g: Gen): void {
  const { size, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  // 扭曲噪声沿 u（顺纹方向）变化慢、沿 v 变化快，年轮才会被拉成流畅的长线而不是一圈圈等高线
  const warpBig = g.fbm(1, 2, 3)
  const warpMid = g.fbm(2, 6, 3)
  const fiber = g.fbm(2, 180, 2, 0.6)
  const figure = g.fbm(2, 3, 4)
  const curl = g.fbm(22, 2, 2)
  // 导管孔：顺纹的极短细沟
  const pores = g.field()
  for (let i = 0; i < 3200; i++) {
    g.stroke(
      pores,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.range(-0.06, 0.06),
      rng.range(3, 16) * s,
      0.3 * s,
      rng.range(0.35, 1),
      0,
      0,
      0,
      1,
    )
  }
  const rings = 9
  const phase = rng.next()

  let i = 0
  for (let y = 0; y < size; y++) {
    const v = ((y + 0.5) / size) * rings + phase
    for (let x = 0; x < size; x++, i++) {
      // 年轮坐标：低频扭曲让年轮弯成山形纹，中频扭曲带来细小波动
      const t = v + warpBig[i] * 1.5 + warpMid[i] * 0.22
      const fr = t - Math.floor(t)
      // 一圈之内：早材渐深，到晚材形成一道深色细线后骤然变浅
      const late = smoothstep(0.3, 0.9, fr) * (1 - smoothstep(0.92, 1, fr))
      const t4 = t * 4 + fiber[i] * 0.15
      const fr4 = t4 - Math.floor(t4)
      const fine = smoothstep(0.45, 0.93, fr4) * (1 - smoothstep(0.94, 1, fr4))
      const dark = clamp01(0.62 * late + 0.3 * fine)
      const pore = pores[i] * (1 - 0.5 * late)
      const k = (1 + 0.11 * figure[i] + 0.06 * fiber[i] + 0.03 * curl[i]) * (1 - 0.5 * pore)

      height[i] = 0.55 + 0.05 * fiber[i] - 0.05 * dark - 0.3 * pore
      cr[i] = mix(0.46, 0.2, dark) * k
      cg[i] = mix(0.295, 0.12, dark) * k
      cb[i] = mix(0.175, 0.072, dark) * k
      rough[i] = clamp01(0.33 + 0.04 * dark + 0.03 * figure[i] + 0.14 * pore)
    }
  }
}

/** 风化木板：横向拼板，板缝与端缝凹陷，年轮被风化成棱，带节疤、干裂、钉孔与锈水痕 */
export function planks(g: Gen): void {
  const { size, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const boards = 4
  const bh = size / boards
  const gap = 1.7 * s
  const warp = g.fbm(1, 3, 3)
  const fiber = g.fbm(2, 200, 2, 0.6)
  const mott = g.fbm(5, 7, 4)
  const grey = g.fbm(3, 4, 4)
  const fine = g.fbm(64, 64, 2, 0.6)

  // 每块板自己的端缝位置、色调、年轮相位与斜度
  const joint = new Float32Array(boards)
  const tone = new Float32Array(boards)
  const phase = new Float32Array(boards)
  const skew = new Float32Array(boards)
  for (let b = 0; b < boards; b++) {
    joint[b] = rng.next()
    tone[b] = rng.range(-1, 1)
    phase[b] = rng.next() * 9
    skew[b] = rng.range(-1.4, 1.4)
  }

  // 节疤：年轮绕着它转
  const knots = g.field()
  for (let i = 0; i < 4; i++) {
    const r = rng.range(15, 26) * s
    const b = rng.int(0, boards - 1)
    g.blob(knots, null, rng.next() * size, (b + rng.range(0.3, 0.7)) * bh, r * 1.7, r, 0, 1, 0, 1)
  }
  // 干裂：顺纹的细长裂口
  const checks = g.field()
  for (let i = 0; i < 70; i++) {
    g.stroke(
      checks,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.range(-0.04, 0.04),
      rng.range(14, 120) * s,
      rng.range(0.4, 0.9) * s,
      rng.range(0.5, 1),
      rng.range(-0.002, 0.002) / s,
      0,
      0,
      1,
    )
  }
  // 钉孔在端缝两侧，锈水顺着往下淌
  const nails = g.field()
  const stains = g.field()
  for (let b = 0; b < boards; b++) {
    for (let k = 0; k < 4; k++) {
      const nx = joint[b] * size + (k < 2 ? -10 : 10) * s
      const ny = (b + (k % 2 === 0 ? 0.22 : 0.78)) * bh
      g.blob(nails, null, nx, ny, 2.3 * s, 2.3 * s, 0, 1, 0, 0.5, 0.5)
      g.blob(stains, null, nx, ny + 9 * s, 3.4 * s, 15 * s, 0, rng.range(0.5, 1), 0, 1)
    }
  }

  let i = 0
  for (let y = 0; y < size; y++) {
    const vb = ((y + 0.5) / size) * boards
    const b = Math.floor(vb)
    const fv = vb - b
    const dEdge = Math.min(fv, 1 - fv) * bh
    for (let x = 0; x < size; x++, i++) {
      let du = (x + 0.5) / size - joint[b]
      du -= Math.floor(du)
      const dJoint = Math.min(du, 1 - du) * size
      const d = Math.min(dEdge, dJoint) + fine[i] * 0.5 * s
      const board = smoothstep(gap * 0.5, gap * 1.6, d)
      const bevel = smoothstep(gap, gap + 5 * s, d)

      const kn = knots[i]
      const t = fv * 4.5 + phase[b] + warp[i] * 1.1 + skew[b] * du + kn * 3
      const fr = t - Math.floor(t)
      // 晚材耐风化，凸成一道道棱
      const ridge = smoothstep(0.35, 0.85, fr) * (1 - smoothstep(0.9, 1, fr))
      const core = smoothstep(0.72, 0.92, kn)
      const ck = checks[i]
      const nail = nails[i]
      const stain = stains[i] * (1 - nail)
      const silver = smoothstep(-0.3, 0.6, grey[i])

      const k =
        (0.9 + 0.1 * tone[b] + 0.07 * mott[i] + 0.06 * fiber[i] + 0.03 * fine[i]) *
        (1 - 0.55 * ck) *
        (0.8 + 0.2 * bevel) *
        (1 - 0.5 * core)
      // 木色：暖褐，日晒雨淋后褪成银灰
      let r = mix(mix(0.53, 0.5, silver), mix(0.31, 0.3, silver), ridge) * k
      let gg = mix(mix(0.43, 0.47, silver), mix(0.24, 0.275, silver), ridge) * k
      let bb = mix(mix(0.32, 0.43, silver), mix(0.17, 0.25, silver), ridge) * k
      r = mix(r, 0.36, stain * 0.6)
      gg = mix(gg, 0.2, stain * 0.6)
      bb = mix(bb, 0.1, stain * 0.6)
      r = mix(r, 0.14, nail)
      gg = mix(gg, 0.11, nail)
      bb = mix(bb, 0.09, nail)

      const hb = 0.5 + 0.06 * tone[b] + 0.2 * ridge + 0.06 * fiber[i] + 0.08 * bevel - 0.35 * ck - 0.1 * core - 0.2 * nail
      height[i] = mix(0.08, hb, board)
      cr[i] = mix(0.07, r, board)
      cg[i] = mix(0.058, gg, board)
      cb[i] = mix(0.045, bb, board)
      rough[i] = mix(1, clamp01(0.86 - 0.06 * ridge + 0.06 * ck + 0.04 * silver - 0.25 * nail), board)
    }
  }
}

/** 树皮：纵向拉长的厚鳞块，之间是深沟，块面带纤维棱、次级裂纹，局部长苔与地衣 */
export function bark(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const f1 = g.field()
  const f2 = g.field()
  const id = g.field()
  g.worley(9, 3, 0.95, f1, f2, id)
  const g1 = g.field()
  const g2 = g.field()
  g.worley(24, 9, 0.95, g1, g2, null)
  const edgeN = g.fbm(14, 6, 4, 0.55)
  const fibers = g.fbm(44, 4, 3, 0.55, 2)
  const fine = g.fbm(70, 40, 2, 0.6)
  const big = g.fbm(2, 2, 3)
  const mossSrc = g.fbm(4, 4, 5, 0.58)
  const mossLevel = g.level(mossSrc, 0.16)
  const lichen = g.field()
  for (let i = 0; i < 26; i++) {
    const r = rng.range(3, 9) * s
    g.blob(lichen, null, rng.next() * size, rng.next() * size, r, r * rng.range(0.6, 1), rng.next() * TAU, 1, 0, 0.6)
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const edge = f2[i] - f1[i] + edgeN[i] * 0.13
    const plate = smoothstep(0.05, 0.45, edge)
    const top = smoothstep(0.3, 0.7, edge)
    const fb = fibers[i] * 0.5 + 0.5
    const split = (1 - smoothstep(0.03, 0.13, g2[i] - g1[i] + fine[i] * 0.03)) * plate
    const tone = id[i]

    const k = (0.72 + 0.34 * tone + 0.16 * fb + 0.07 * fine[i] + 0.06 * big[i] + n * 0.08) * (1 - 0.5 * split)
    let r = mix(0.085, 0.37 * k, plate)
    let gg = mix(0.062, 0.295 * k, plate)
    let b = mix(0.048, 0.235 * k, plate)
    // 苔藓长在潮湿的一侧，沟里和块面上都有
    const moss = smoothstep(mossLevel, mossLevel + 0.3, mossSrc[i] + fine[i] * 0.08) * (0.45 + 0.4 * fb)
    r = mix(r, 0.2 + 0.05 * fb, moss)
    gg = mix(gg, 0.29 + 0.07 * fb, moss)
    b = mix(b, 0.1, moss)
    // 地衣：块面上灰白的圆斑
    const li = smoothstep(0.15, 0.5, lichen[i] + fine[i] * 0.1) * top
    r = mix(r, 0.62, li * 0.7)
    gg = mix(gg, 0.65, li * 0.7)
    b = mix(b, 0.56, li * 0.7)

    height[i] =
      0.08 + plate * (0.42 + 0.2 * tone + 0.16 * fb) + 0.05 * fine[i] * plate - 0.14 * split + 0.03 * li + n * 0.03
    cr[i] = r
    cg[i] = gg
    cb[i] = b
    rough[i] = clamp01(0.93 + 0.05 * (1 - plate) - 0.05 * li + 0.03 * moss)
  }
}

/** 叶丛：层层叠叠的叶片（带深度遮挡），主脉与侧脉、叶面拱起，上层亮、下层暗，少数发黄 */
export function foliage(g: Gen): void {
  const { size, mask, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const depth = g.field()
  const vein = g.field()
  const tone = g.field()
  const rim = g.field()
  const mott = g.fbm(4, 4, 3)
  const fine = g.fbm(90, 90, 2, 0.6)

  const leaves = 1500
  for (let n = 0; n < leaves; n++) {
    const cx = rng.next() * size
    const cy = rng.next() * size
    const angle = rng.next() * TAU
    const len = rng.range(15, 30) * s
    const wid = len * rng.range(0.4, 0.58)
    const z = rng.next()
    const leafTone = rng.next()
    const tilt = rng.range(-1, 1)
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const r = Math.ceil(len) + 1
    const x0 = Math.floor(cx)
    const y0 = Math.floor(cy)
    for (let oy = -r; oy <= r; oy++) {
      const py = y0 + oy
      const dy = py + 0.5 - cy
      const row = (py & mask) * size
      for (let ox = -r; ox <= r; ox++) {
        const px = x0 + ox
        const dx = px + 0.5 - cx
        const a = (dx * ca + dy * sa) / len
        if (a <= -1 || a >= 1) continue
        // 叶形：两头尖，靠叶柄一侧更宽
        const w = Math.min(1, (1 - a * a) * (1.2 - 0.4 * a))
        const b = Math.abs(dy * ca - dx * sa) / wid
        const q = b / w
        if (q >= 1) continue
        // 叶面沿主脉对折成浅 V 形，两侧拱起
        const h = 0.08 + z * 0.66 + 0.16 * (1 - q * q) - 0.05 * (1 - smoothstep(0, 0.2, q)) + tilt * a * 0.07
        const i = row + (px & mask)
        if (h <= depth[i]) continue
        depth[i] = h
        tone[i] = leafTone
        rim[i] = q
        const mid = 1 - smoothstep(0.03, 0.11, b)
        const sv = a * 5 + 0.5 - b * 1.6
        const fs = sv - Math.floor(sv)
        const side = (1 - smoothstep(0.03, 0.13, Math.min(fs, 1 - fs))) * (1 - q) * 0.65
        vein[i] = mid > side ? mid : side
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const h = depth[i]
    if (h <= 0) {
      // 叶缝深处
      height[i] = 0
      cr[i] = 0.025
      cg[i] = 0.05
      cb[i] = 0.02
      rough[i] = 0.9
      continue
    }
    const t = tone[i]
    const q = rim[i]
    const vn = vein[i]
    // 越靠下的叶片越暗；叶缘略暗
    const shade = (0.36 + 0.7 * clamp01(h)) * (1 - 0.22 * q * q) * (1 + 0.06 * mott[i] + 0.05 * fine[i])
    let r = mix(0.09, 0.3, t)
    let gg = mix(0.24, 0.47, t)
    let b = mix(0.055, 0.13, t)
    // 少数叶片发黄
    const autumn = smoothstep(0.9, 0.97, t)
    r = mix(r, 0.58, autumn)
    gg = mix(gg, 0.5, autumn)
    b = mix(b, 0.14, autumn)
    // 叶脉颜色更浅
    r = mix(r, r * 1.25 + 0.1, vn * 0.6)
    gg = mix(gg, gg * 1.15 + 0.1, vn * 0.6)
    b = mix(b, b * 1.2 + 0.05, vn * 0.6)

    height[i] = h + 0.035 * vn + 0.012 * fine[i]
    cr[i] = r * shade
    cg[i] = gg * shade
    cb[i] = b * shade
    rough[i] = clamp01(0.5 + 0.18 * (1 - h) + 0.08 * vn + 0.05 * fine[i])
  }
}

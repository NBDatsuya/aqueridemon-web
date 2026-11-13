/**
 * PBR 表面：地面与建筑（草皮、泥地、沥青、混凝土、红砖、粉刷墙面）。
 * 每个函数先构造遮罩场，再在一次合成循环里同时写出高度、颜色、粗糙度。
 */

import { clamp01, hash2, mix, smoothstep } from './pbr-core'
import type { Gen } from './pbr-core'

/** 草皮：修剪过的球场草。大量带 z 序的草叶笔触 + 深浅斑驳 + 少量枯黄 */
export function grass(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const patch = g.fbm(3, 3, 4)
  const clump = g.fbm(13, 13, 3)
  const dry = g.fbm(5, 5, 3)
  const blades = g.field()
  const tint = g.field()

  // 草叶整体朝一个方向倒伏（修剪方向），单片再随机发散
  const lay = -Math.PI / 2 + rng.range(-0.45, 0.45)
  const total = 24000
  for (let i = 0; i < total; i++) {
    const x = rng.next() * size
    const y = rng.next() * size
    const local = clump[((y | 0) & g.mask) * size + ((x | 0) & g.mask)]
    const z = clamp01(0.18 + rng.next() * 0.7 + local * 0.12)
    const spread = rng.range(-1, 1)
    g.stroke(
      blades,
      tint,
      x,
      y,
      lay + spread * Math.abs(spread) * 1.3,
      (6 + rng.next() * 11) * s,
      (0.45 + rng.next() * 0.55) * s,
      z,
      rng.range(-0.05, 0.05) / s,
      rng.next(),
      0.72,
      2,
    )
  }

  const seed = g.seed()
  for (let i = 0; i < count; i++) {
    const hb = blades[i]
    const p = patch[i]
    const c = clump[i]
    const grain = hash2(i & g.mask, (i / size) | 0, seed)
    if (hb <= 0) {
      // 草叶间露出的泥土与枯草层
      const k = 0.75 + 0.3 * c + 0.2 * grain
      height[i] = 0.06 + 0.06 * grain
      cr[i] = 0.17 * k
      cg[i] = 0.14 * k
      cb[i] = 0.07 * k
      rough[i] = 1
      continue
    }
    const t = tint[i]
    // 越靠下的草叶被遮挡得越暗
    const shade = (0.4 + 0.6 * hb) * (0.86 + 0.16 * p + 0.06 * c)
    // 枯黄：只在少数区域、少数草叶上出现
    const yellow = smoothstep(0.25, 0.8, dry[i]) * smoothstep(0.55, 0.95, t) * 0.75
    let r = mix(0.13, 0.4, t)
    let gr = mix(0.31, 0.58, t)
    let b = mix(0.07, 0.2, t)
    r = mix(r, 0.6, yellow)
    gr = mix(gr, 0.55, yellow)
    b = mix(b, 0.27, yellow)
    height[i] = 0.2 + hb * 0.8
    cr[i] = r * shade
    cg[i] = gr * shade
    cb[i] = b * shade
    rough[i] = 0.74 + 0.2 * (1 - hb) + 0.06 * yellow
  }
}

/** 泥地：干湿斑驳的泥土 + 半埋的碎石 + 砂砾 + 干处的裂纹 */
export function dirt(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const big = g.fbm(3, 3, 5)
  const mid = g.fbm(11, 11, 4, 0.55)
  const fine = g.fbm(52, 52, 3, 0.6)
  const stones = g.field()
  const stoneTint = g.field()
  const grit = g.field()

  for (let i = 0; i < 150; i++) {
    const rx = (2 + rng.next() * rng.next() * rng.next() * 16) * s
    g.blob(
      stones,
      stoneTint,
      rng.next() * size,
      rng.next() * size,
      rx,
      rx * rng.range(0.55, 0.95),
      rng.range(0, Math.PI),
      rng.range(0.45, 1),
      rng.next(),
      0.55,
    )
  }
  for (let i = 0; i < 3200; i++) {
    const rx = (0.7 + rng.next() * 1.3) * s
    g.blob(grit, null, rng.next() * size, rng.next() * size, rx, rx, 0, rng.range(0.4, 1), 0, 1)
  }

  const cracks = g.field()
  g.cracks(cracks, 14, 110 * s, 1.1 * s)
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const wet = smoothstep(-0.2, 0.6, big[i])
    const m = mid[i]
    const f = fine[i]
    const grain = hash2(i & g.mask, (i / size) | 0, seed)
    // 裂纹只出现在干的地方
    const crack = cracks[i] * (1 - wet)
    const st = stones[i]
    // 石子边缘被噪声啃掉一点，轮廓不那么圆
    const stoneMask = smoothstep(0.02, 0.2, st + f * 0.06)
    const gr = grit[i]

    let h = 0.4 - 0.1 * big[i] + 0.1 * m + 0.05 * f - 0.25 * crack + gr * 0.08
    h = mix(h, h + 0.08 + st * 0.34 + f * 0.03, stoneMask)

    const soil = (0.86 + 0.2 * m + 0.1 * f + 0.1 * (grain - 0.5)) * (1 - 0.6 * crack)
    let r = mix(0.47, 0.3, wet) * soil
    let gg = mix(0.365, 0.215, wet) * soil
    let b = mix(0.25, 0.14, wet) * soil
    // 砂砾：比泥土略亮的小颗粒
    r += gr * 0.1
    gg += gr * 0.095
    b += gr * 0.085

    const tone = stoneTint[i]
    // 石面带泥：亮度随细噪声变化，并被周围泥土染暖
    const lum = (0.3 + 0.3 * tone) * (0.7 + 0.3 * st) * (0.9 + 0.12 * grain + 0.14 * f)
    // 约三成石子偏暖（砂岩），其余偏冷灰
    const warm = tone > 0.7 ? 0.07 : 0.02
    r = mix(r, lum + warm, stoneMask)
    gg = mix(gg, lum + warm * 0.4, stoneMask)
    b = mix(b, lum - warm * 0.6, stoneMask)
    // 石子与泥土的接触处压暗
    const rim = 1 - 0.3 * stoneMask * (1 - stoneMask) * 4

    height[i] = h
    cr[i] = r * rim
    cg[i] = gg * rim
    cb[i] = b * rim
    rough[i] = mix(mix(0.97, 0.8, wet), 0.82, stoneMask)
  }
}

/** 沥青：粗细两级骨料颗粒嵌在深色沥青里 + 磨损露骨 + 细裂纹 + 油渍 */
export function asphalt(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const stones = g.field()
  const tone = g.field()
  // 粗骨料：不规则的小石子
  for (let i = 0; i < 6500; i++) {
    const r = (1.5 + rng.next() * rng.next() * 3.2) * s
    g.blob(
      stones,
      tone,
      rng.next() * size,
      rng.next() * size,
      r,
      r * rng.range(0.6, 1),
      rng.range(0, Math.PI),
      rng.range(0.5, 1),
      rng.next(),
      0.5,
      0.3,
    )
  }
  // 细骨料：砂粒
  for (let i = 0; i < 16000; i++) {
    const r = (0.6 + rng.next() * 0.8) * s
    g.blob(stones, tone, rng.next() * size, rng.next() * size, r, r, 0, rng.range(0.2, 0.45), rng.next(), 1, 0.3)
  }
  const und = g.fbm(4, 4, 4)
  const wear = g.fbm(6, 6, 4)
  const cracks = g.field()
  g.cracks(cracks, 4, 190 * s, 1.2 * s)
  const oil = g.fbm(3, 3, 4)
  const oilLevel = g.level(oil, 0.06)
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const st = stones[i]
    const stone = smoothstep(0.03, 0.14, st)
    const t = tone[i]
    // 磨损越重，沥青膜越薄，骨料露出得越多越亮
    const expose = clamp01(0.6 + 0.4 * wear[i])
    const grain = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const crack = cracks[i]
    const oily = smoothstep(oilLevel, oilLevel + 0.3, oil[i])

    let c = mix(0.095, 0.16 + 0.3 * t * t + 0.1 * st, stone * expose)
    c += grain * 0.03
    c *= (1 - 0.75 * crack) * (1 - 0.4 * oily)

    // 少数骨料带一点暖色，其余中性偏冷
    const warm = t > 0.72 ? 0.035 * stone * expose : 0
    height[i] = 0.34 + 0.08 * und[i] + st * 0.42 + grain * 0.03 - crack * 0.4
    cr[i] = c + warm
    cg[i] = c + warm * 0.5
    cb[i] = c * 1.05 - warm
    rough[i] = mix(mix(0.8, 0.93, stone * expose), 0.45, oily * 0.8) + crack * 0.05
  }
}

/** 混凝土：浇筑层痕 + 气孔 + 细裂纹 + 带水线的水渍 */
export function concrete(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const big = g.fbm(2, 2, 4)
  const mott = g.fbm(9, 9, 4, 0.55)
  const fine = g.fbm(70, 70, 2, 0.6)
  // 浇筑层痕：沿 u 方向拉长的条带
  const pour = g.fbm(2, 22, 3, 0.55)
  const stainSrc = g.fbm(4, 3, 5, 0.55)
  const stainLevel = g.level(stainSrc, 0.3)
  const cracks = g.field()
  g.cracks(cracks, 5, 210 * s, 1 * s)
  const pores = g.field()
  for (let i = 0; i < 520; i++) {
    const r = (0.6 + rng.next() * rng.next() * 2.8) * s
    g.blob(pores, null, rng.next() * size, rng.next() * size, r, r * rng.range(0.7, 1), rng.range(0, 3), 1, 0, 0.5)
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const grain = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const stain = smoothstep(stainLevel - 0.1, stainLevel + 0.4, stainSrc[i])
    // 水渍边缘的一圈深色水线
    const rim = stain * (1 - stain) * 4
    const p = pores[i]
    const crack = cracks[i]

    let c = 0.6 + 0.06 * big[i] + 0.04 * mott[i] + 0.022 * pour[i] + 0.016 * fine[i] + grain * 0.03
    c *= (1 - 0.13 * stain - 0.04 * rim) * (1 - 0.45 * p) * (1 - 0.7 * crack)

    height[i] = 0.6 + 0.1 * big[i] + 0.07 * mott[i] + 0.045 * pour[i] + 0.03 * fine[i] - 0.35 * p - 0.4 * crack
    // 略偏暖的灰；水渍处偏黄褐
    cr[i] = c * (1 + 0.01 * stain)
    cg[i] = c * 0.985
    cb[i] = c * (0.955 - 0.035 * stain)
    rough[i] = clamp01(0.86 + 0.05 * mott[i] + 0.06 * stain + 0.1 * p + 0.1 * crack)
  }
}

/** 红砖墙：错缝砌筑，灰缝凹陷，逐块色差、边角磕损、砖面麻点与泛碱 */
export function brick(g: Gen): void {
  const { size, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const nx = 4
  const ny = 12
  const bw = size / nx
  const bh = size / ny
  const mortar = 2.4 * s
  const corner = 5 * s
  const edgeN = g.fbm(18, 18, 4, 0.55)
  const face = g.fbm(36, 36, 3, 0.6)
  const big = g.fbm(3, 3, 4)
  const eff = g.fbm(5, 7, 4)
  const effLevel = g.level(eff, 0.14)
  const pits = g.field()
  for (let i = 0; i < 900; i++) {
    const r = (0.8 + rng.next() * rng.next() * 3) * s
    g.blob(pits, null, rng.next() * size, rng.next() * size, r, r, 0, rng.range(0.4, 1), 0, 0.6)
  }
  const seedA = g.seed()
  const seedB = g.seed()
  const seedC = g.seed()

  let i = 0
  for (let y = 0; y < size; y++) {
    const v = ((y + 0.5) / size) * ny
    const row = Math.floor(v)
    const fv = v - row
    const dy = Math.min(fv, 1 - fv) * bh
    const shift = (row & 1) * 0.5 + (hash2(row, 7, seedC) - 0.5) * 0.14
    for (let x = 0; x < size; x++, i++) {
      const u = ((x + 0.5) / size) * nx + shift
      const colRaw = Math.floor(u)
      const fu = u - colRaw
      const col = ((colRaw % nx) + nx) % nx
      const tone = hash2(col, row, seedA)
      const kind = hash2(col, row, seedB)
      const dx = Math.min(fu, 1 - fu) * bw
      // 到砖边的距离：角上用圆角，叠加噪声得到磕损的不规则轮廓
      let d = Math.min(dx, dy)
      if (dx < corner && dy < corner) d = corner - Math.hypot(corner - dx, corner - dy)
      d += edgeN[i] * 1.7 * s
      const m = smoothstep(mortar, mortar + 2 * s, d)
      const bevel = smoothstep(mortar, mortar + 9 * s, d)
      const grain = hash2(x, y, seedC) - 0.5
      const f = face[i]
      const pit = pits[i]

      // 砖：红褐为主，少数过烧发黑，少数偏橙
      const burnt = kind > 0.86 ? 0.62 : 1
      const k = (0.9 + 0.1 * f + 0.06 * big[i] + grain * 0.06) * burnt * (1 - 0.35 * pit) * (0.84 + 0.16 * bevel)
      let r = mix(0.5, 0.69, tone) * k
      let gg = mix(0.22, 0.36, tone) * k
      let b = mix(0.16, 0.24, tone) * k
      // 泛碱：砖面上的灰白盐霜
      const salt = smoothstep(effLevel, effLevel + 0.3, eff[i]) * 0.42 * (0.6 + 0.4 * f)
      r = mix(r, 0.78, salt)
      gg = mix(gg, 0.74, salt)
      b = mix(b, 0.69, salt)

      // 灰缝：粗砂浆，越靠近砖边越脏
      const mk = (0.55 + 0.08 * big[i] + grain * 0.12 + 0.05 * f) * (0.8 + 0.2 * smoothstep(0, mortar, d))
      const brickH = 0.62 + 0.1 * kind + 0.07 * f + 0.1 * bevel - 0.14 * pit
      const mortarH = 0.26 + grain * 0.08 + 0.03 * f

      height[i] = mix(mortarH, brickH, m)
      cr[i] = mix(mk * 1.02, r, m)
      cg[i] = mix(mk, gg, m)
      cb[i] = mix(mk * 0.95, b, m)
      rough[i] = mix(0.97, 0.84 + 0.07 * f + 0.06 * salt + 0.08 * pit, m)
    }
  }
}

/** 粉刷墙面（可着色）：接近中性的浅色，抹灰起伏、滚涂橘皮纹、污渍与稀疏的发丝裂纹 */
export function plaster(g: Gen): void {
  const { size, count, height, cr, cg, cb, rough } = g
  const s = size / 512
  const und = g.fbm(4, 4, 4)
  const trowel = g.fbm(3, 9, 4, 0.55)
  const peel = g.fbm(60, 60, 2, 0.6, 1)
  const stainSrc = g.fbm(3, 5, 5, 0.55)
  const stainLevel = g.level(stainSrc, 0.22)
  const cracks = g.field()
  g.cracks(cracks, 2, 170 * s, 0.6 * s)
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const grain = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const stain = smoothstep(stainLevel - 0.1, stainLevel + 0.45, stainSrc[i])
    const crack = cracks[i]
    const c =
      (0.9 + 0.022 * und[i] + 0.014 * trowel[i] + 0.012 * peel[i] + grain * 0.012) *
      (1 - 0.07 * stain) *
      (1 - 0.35 * crack)

    height[i] = 0.5 + 0.2 * und[i] + 0.08 * trowel[i] + 0.06 * peel[i] + grain * 0.02 - 0.3 * crack
    cr[i] = c
    cg[i] = c * (0.994 - 0.006 * stain)
    cb[i] = c * (0.978 - 0.02 * stain)
    rough[i] = clamp01(0.88 + 0.04 * peel[i] + 0.05 * stain + 0.07 * crack)
  }
}

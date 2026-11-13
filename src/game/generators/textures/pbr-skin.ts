/**
 * PBR 表面：生物皮肤（人类皮肤、腐烂皮肤、湿滑病变皮肤）。
 * 皮肤的微观结构统一用细胞噪声的边界做“皮沟”网络，再叠加毛孔、斑点、病变等遮罩；
 * 颜色、高度、粗糙度都从同一批遮罩得到。
 */

import { clamp01, hash2, mix, smoothstep } from './pbr-core'
import type { Gen } from './pbr-core'

const TAU = Math.PI * 2

/** 人类皮肤（可着色）：皮沟网络、毛孔、细纹，带泛红、雀斑与少量痣；颜色接近中性浅色，半光泽 */
export function skin(g: Gen): void {
  const { size, mask, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const cells = Math.round(88 * s)
  const f1 = g.field()
  const f2 = g.field()
  const id = g.field()
  g.worley(cells, cells, 0.95, f1, f2, id)
  const und = g.fbm(3, 3, 4)
  const mid = g.fbm(26, 26, 3, 0.55)
  const fine = g.fbm(128, 128, 2, 0.6)
  const flush = g.fbm(4, 4, 4)
  const gate = g.fbm(5, 5, 3)

  const pores = g.field()
  const poreCount = Math.round(2600 * s * s)
  for (let i = 0; i < poreCount; i++) {
    const r = (0.7 + rng.next() * 0.9) * s
    g.blob(pores, null, rng.next() * size, rng.next() * size, r, r, 0, rng.range(0.4, 1), 0, 1)
  }
  // 雀斑成片出现：只落在 gate 为正的区域
  const freckles = g.field()
  const freckleCount = Math.round(170 * s * s)
  for (let i = 0; i < freckleCount; i++) {
    const x = rng.next() * size
    const y = rng.next() * size
    const r = (1 + rng.next() * rng.next() * 3.2) * s
    const value = rng.range(0.25, 1)
    const angle = rng.next() * TAU
    if (gate[((y | 0) & mask) * size + ((x | 0) & mask)] < -0.15) continue
    g.blob(freckles, null, x, y, r, r * 0.8, angle, value, 0, 1)
  }
  const moles = g.field()
  for (let i = 0; i < 3; i++) {
    const r = rng.range(2.4, 4.2) * s
    g.blob(moles, null, rng.next() * size, rng.next() * size, r, r * rng.range(0.8, 1), rng.next() * TAU, 1, 0, 0.6)
  }
  // 细纹：大致朝同一方向的浅皱
  const wrinkles = g.field()
  const dir = rng.next() * Math.PI
  for (let i = 0; i < 46; i++) {
    g.stroke(
      wrinkles,
      null,
      rng.next() * size,
      rng.next() * size,
      dir + rng.range(-0.4, 0.4),
      rng.range(40, 200) * s,
      rng.range(0.5, 1.1) * s,
      rng.range(0.3, 1),
      rng.range(-0.006, 0.006) / s,
      0,
      0,
      1,
    )
  }

  for (let i = 0; i < count; i++) {
    const furrow = 1 - smoothstep(0, 0.2, f2[i] - f1[i])
    const pore = pores[i]
    const wr = wrinkles[i]
    const fk = freckles[i] * 0.8
    const mole = smoothstep(0.1, 0.5, moles[i])
    const red = smoothstep(-0.3, 0.8, flush[i])
    const plate = id[i] - 0.5

    const c =
      (0.87 + 0.012 * mid[i] + 0.012 * plate + 0.008 * fine[i]) *
      (1 - 0.07 * furrow) *
      (1 - 0.2 * pore) *
      (1 - 0.12 * wr)
    // 轻微的暖色偏移：泛红处绿、蓝更少，染色后就是更红润的肤色
    let r = c * (1 + 0.015 * red)
    let gg = c * (0.985 - 0.04 * red)
    let b = c * (0.965 - 0.05 * red)
    r *= 1 - 0.1 * fk
    gg *= 1 - 0.17 * fk
    b *= 1 - 0.24 * fk
    r = mix(r, 0.42, mole)
    gg = mix(gg, 0.3, mole)
    b = mix(b, 0.24, mole)

    height[i] =
      0.5 + 0.1 * und[i] + 0.05 * mid[i] + 0.03 * plate + 0.02 * fine[i] - 0.13 * furrow - 0.3 * pore - 0.2 * wr + 0.1 * mole
    cr[i] = r
    cg[i] = gg
    cb[i] = b
    rough[i] = clamp01(0.5 + 0.08 * furrow + 0.14 * pore + 0.06 * wr - 0.03 * mid[i])
  }
}

/** 腐烂皮肤：灰绿与蜡黄斑驳的死皮，青紫淤斑、暗色血管、溃烂露肉（湿）与翻卷的创缘，暗红血迹 */
export function zombieSkin(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const f1 = g.field()
  const f2 = g.field()
  g.worley(58, 58, 0.95, f1, f2, null)
  const und = g.fbm(3, 3, 4)
  const mid = g.fbm(14, 14, 4, 0.55)
  const fine = g.fbm(70, 70, 2, 0.6)
  const pale = g.fbm(4, 4, 4)
  const bruiseSrc = g.fbm(5, 5, 4)
  const bruiseLevel = g.level(bruiseSrc, 0.2)
  const rotSrc = g.fbm(6, 6, 5, 0.6)
  const rotLevel = g.level(rotSrc, 0.08)

  const veinsRaw = g.field()
  g.cracks(veinsRaw, 9, 150 * s, 1.2 * s)
  const veins = g.blur(veinsRaw, 1, 1)

  // 血迹：几处溅落，每处一摊主斑 + 周围的飞溅点 + 往下淌的一道
  const blood = g.field()
  for (let i = 0; i < 5; i++) {
    const x = rng.next() * size
    const y = rng.next() * size
    const r = rng.range(8, 20) * s
    g.blob(blood, null, x, y, r, r * rng.range(0.6, 1), rng.next() * TAU, 1, 0, 0.5)
    for (let k = 0; k < 16; k++) {
      const a = rng.next() * TAU
      const d = r * rng.range(0.8, 2.8)
      const dr = rng.range(0.8, 3.2) * s
      g.blob(blood, null, x + Math.cos(a) * d, y + Math.sin(a) * d, dr, dr, 0, rng.range(0.5, 1), 0, 0.5)
    }
    // 甩溅的细血线：从主斑边缘朝外，末端收尖
    for (let k = 0; k < 4; k++) {
      const a = rng.next() * TAU
      g.stroke(
        blood,
        null,
        x + Math.cos(a) * r * 0.6,
        y + Math.sin(a) * r * 0.6,
        a + rng.range(-0.3, 0.3),
        r * rng.range(0.8, 2.2),
        rng.range(0.6, 1.3) * s,
        rng.range(0.5, 0.9),
        rng.range(-0.02, 0.02) / s,
        0,
        0.3,
        2,
      )
    }
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const furrow = 1 - smoothstep(0, 0.22, f2[i] - f1[i])
    const m = mid[i]
    const f = fine[i]
    const src = rotSrc[i] + f * 0.035
    const rot = smoothstep(rotLevel, rotLevel + 0.1, src)
    const rim = clamp01(smoothstep(rotLevel - 0.14, rotLevel, src) - rot)
    const bruise = smoothstep(bruiseLevel, bruiseLevel + 0.4, bruiseSrc[i]) * (1 - rot)
    const vein = clamp01(veins[i] * 1.8) * (1 - rot)
    const bl = smoothstep(0.12, 0.45, blood[i] + f * 0.12)
    const waxy = smoothstep(-0.4, 0.6, pale[i])

    const k = (0.9 + 0.1 * m + 0.05 * f + n * 0.04) * (1 - 0.2 * furrow)
    let r = mix(0.4, 0.55, waxy) * k
    let gg = mix(0.46, 0.54, waxy) * k
    let b = mix(0.37, 0.39, waxy) * k
    // 淤斑：青紫
    r = mix(r, 0.25 * k, bruise * 0.75)
    gg = mix(gg, 0.2 * k, bruise * 0.75)
    b = mix(b, 0.3 * k, bruise * 0.75)
    // 血管：皮下发黑的青色细线
    r = mix(r, 0.15, vein * 0.7)
    gg = mix(gg, 0.2, vein * 0.7)
    b = mix(b, 0.24, vein * 0.7)
    // 创缘：翻起的发黄死皮
    r = mix(r, 0.62, rim * 0.6)
    gg = mix(gg, 0.57, rim * 0.6)
    b = mix(b, 0.38, rim * 0.6)
    // 溃烂：暗红的烂肉，夹着黄色脓点
    const pus = smoothstep(0.35, 0.7, f) * 0.6
    const deep = smoothstep(-0.3, 0.5, m)
    r = mix(r, mix(mix(0.2, 0.44, deep), 0.6, pus), rot)
    gg = mix(gg, mix(mix(0.035, 0.09, deep), 0.52, pus), rot)
    b = mix(b, mix(0.035, 0.07, deep) + 0.15 * pus, rot)
    // 血迹：干涸后发黑的暗红
    r = mix(r, 0.27 + 0.05 * f, bl * 0.92)
    gg = mix(gg, 0.028, bl * 0.92)
    b = mix(b, 0.025, bl * 0.92)

    height[i] =
      0.5 + 0.12 * und[i] + 0.07 * m + 0.02 * f - 0.12 * furrow * (1 - rot) + 0.05 * vein + 0.1 * rim -
      0.26 * rot + 0.06 * rot * f + 0.025 * bl + n * 0.02
    cr[i] = r
    cg[i] = gg
    cb[i] = b
    let ro = 0.7 + 0.08 * furrow + 0.03 * m + 0.1 * rim
    ro = mix(ro, 0.3 + 0.1 * pus, rot)
    ro = mix(ro, 0.42, bl)
    rough[i] = clamp01(ro)
  }
}

/** 湿滑病变皮肤（可着色）：章鱼般的湿皮，大小疣粒、带脓头的脓疮、色素点与色素斑，皮沟里更粗糙 */
export function bossSkin(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const cells = Math.round(34 * s)
  const f1 = g.field()
  const f2 = g.field()
  g.worley(cells, cells, 0.95, f1, f2, null)
  const und = g.fbm(3, 3, 4)
  const folds = g.fbm(7, 7, 4, 0.55, 2)
  const fine = g.fbm(110, 110, 2, 0.6)
  const patchSrc = g.fbm(4, 4, 5, 0.58)
  const patchLevel = g.level(patchSrc, 0.3)

  // 疣粒：少量大的 + 大量小的，圆顶截面
  const warts = g.field()
  const wartTone = g.field()
  const bigCount = Math.round(70 * s * s)
  for (let i = 0; i < bigCount; i++) {
    const r = rng.range(5, 15) * s
    g.blob(warts, wartTone, rng.next() * size, rng.next() * size, r, r * rng.range(0.75, 1), rng.next() * TAU, 0.5 + r / (30 * s), rng.next(), 0.6)
  }
  const smallCount = Math.round(700 * s * s)
  for (let i = 0; i < smallCount; i++) {
    const r = rng.range(1.4, 4.4) * s
    g.blob(warts, wartTone, rng.next() * size, rng.next() * size, r, r * rng.range(0.75, 1), rng.next() * TAU, rng.range(0.2, 0.5), rng.next(), 0.6)
  }
  // 脓疮：鼓起的包，顶上是脓头，外面一圈发炎
  const pustules = g.field()
  const pustuleCount = Math.round(11 * s * s)
  for (let i = 0; i < pustuleCount; i++) {
    const r = rng.range(7, 14) * s
    g.blob(pustules, null, rng.next() * size, rng.next() * size, r, r * rng.range(0.85, 1), rng.next() * TAU, 1, 0, 0.5)
  }
  // 色素点：密布的深色小点（色素细胞）
  const spots = g.field()
  const spotCount = Math.round(1500 * s * s)
  for (let i = 0; i < spotCount; i++) {
    const r = rng.range(1, 2.6) * s
    g.blob(spots, null, rng.next() * size, rng.next() * size, r, r, 0, rng.range(0.3, 1), 0, 1)
  }

  for (let i = 0; i < count; i++) {
    const furrow = 1 - smoothstep(0, 0.2, f2[i] - f1[i])
    const w = warts[i]
    const wart = smoothstep(0, 0.12, w)
    const p = pustules[i]
    const swell = smoothstep(0, 0.25, p)
    const head = smoothstep(0.78, 0.93, p)
    const ring = swell * (1 - smoothstep(0.45, 0.8, p))
    const patch = smoothstep(patchLevel, patchLevel + 0.3, patchSrc[i])
    const spot = spots[i] * (0.45 + 0.55 * patch) * (1 - swell)
    const fold = folds[i] * 0.5 + 0.5

    const c =
      (0.8 + 0.035 * (fold - 0.5) + 0.01 * fine[i] + wart * (0.05 * w + 0.05 * (wartTone[i] - 0.5))) *
      (1 - 0.14 * furrow * (1 - wart)) *
      (1 - 0.2 * patch) *
      (1 - 0.42 * spot)
    // 发炎的一圈偏红偏暗；脓头是发黄的浅色
    let r = c * (1 - 0.1 * ring)
    let gg = c * (1 - 0.3 * ring)
    let b = c * (1 - 0.27 * ring)
    r = mix(r, 0.97, head)
    gg = mix(gg, 0.93, head)
    b = mix(b, 0.7, head)

    height[i] =
      0.26 + 0.1 * und[i] + 0.06 * fold - 0.09 * furrow * (1 - wart) * (1 - swell) + 0.3 * w + 0.4 * p + 0.03 * head +
      0.012 * fine[i]
    cr[i] = r
    cg[i] = gg
    cb[i] = b
    // 湿皮整体很光滑：疣顶与脓头最亮，皮沟和色素斑稍粗糙
    rough[i] = clamp01(0.3 + 0.14 * furrow * (1 - wart) - 0.08 * wart * w + 0.05 * patch + 0.04 * fine[i] - 0.14 * head)
  }
}

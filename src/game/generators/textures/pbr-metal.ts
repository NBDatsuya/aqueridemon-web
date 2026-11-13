/**
 * PBR 表面：金属与合成材料（拉丝钢、枪械发黑钢、喷漆金属、锈蚀铁皮、工程塑料、橡胶）。
 * 喷漆金属与锈蚀铁皮会额外写出金属度图层（漆 / 锈是非金属，露出的底材是金属）。
 */

import { clamp01, hash2, mix, smoothstep } from './pbr-core'
import type { Gen } from './pbr-core'

const TAU = Math.PI * 2

/** 拉丝钢：沿 u 方向的多尺度拉丝纹 + 顺纹长划痕 + 少量使用划痕（划痕处更亮更光滑） */
export function steel(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const hair = g.fbm(2, size / 2, 1)
  const mid = g.fbm(1, 96, 3, 0.6)
  const wide = g.fbm(1, 22, 3)
  const cloud = g.fbm(3, 3, 4)
  const scratch = g.field()
  for (let i = 0; i < 170; i++) {
    g.stroke(
      scratch,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.range(-0.035, 0.035) + (rng.next() < 0.5 ? 0 : Math.PI),
      rng.range(40, 280) * s,
      rng.range(0.3, 0.8) * s,
      rng.range(0.25, 1),
      0,
      0,
      0,
      1,
    )
  }
  for (let i = 0; i < 24; i++) {
    g.stroke(
      scratch,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.next() * TAU,
      rng.range(14, 90) * s,
      rng.range(0.3, 0.6) * s,
      rng.range(0.4, 1),
      rng.range(-0.004, 0.004) / s,
      0,
      0,
      1,
    )
  }

  for (let i = 0; i < count; i++) {
    const b = 0.5 * hair[i] + 0.33 * mid[i] + 0.17 * wide[i]
    const sc = scratch[i]
    const c = 0.66 + 0.05 * b + 0.03 * cloud[i] + 0.17 * sc
    height[i] = 0.5 + 0.24 * b - 0.3 * sc
    cr[i] = c * 0.985
    cg[i] = c
    cb[i] = c * 1.02
    rough[i] = clamp01(0.35 - 0.05 * b + 0.04 * cloud[i] - 0.15 * sc)
  }
}

/** 枪械发黑 / 磷化钢：深灰近黑的哑光转化膜，细密颗粒，边缘磨损处露出发亮的细划痕 */
export function gunmetal(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const grain = g.fbm(128, 128, 2, 0.6)
  const cloud = g.fbm(4, 4, 4)
  const tool = g.fbm(1, 128, 2, 0.6)
  const wearSrc = g.fbm(7, 7, 5, 0.58)
  const wearLevel = g.level(wearSrc, 0.09)
  const scratch = g.field()
  for (let i = 0; i < 80; i++) {
    g.stroke(
      scratch,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.next() * TAU,
      rng.range(8, 75) * s,
      rng.range(0.25, 0.6) * s,
      rng.range(0.35, 1),
      rng.range(-0.006, 0.006) / s,
      0,
      0,
      1,
    )
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const gr = grain[i]
    const sc = scratch[i]
    // 磨损区：转化膜被磨薄，颗粒的高点先露出底材
    const wear = smoothstep(wearLevel, wearLevel + 0.4, wearSrc[i]) * (0.35 + 0.35 * gr)
    const bare = Math.max(clamp01(wear), sc)
    const base = 0.15 + 0.02 * cloud[i] + 0.014 * gr + n * 0.02
    const c = mix(base, 0.5, bare * 0.8)

    height[i] = 0.5 + 0.1 * gr + 0.05 * tool[i] + n * 0.05 - 0.22 * sc
    // 发黑层略偏蓝，露出的钢是中性灰
    cr[i] = c * mix(0.94, 1, bare)
    cg[i] = c * mix(0.98, 1, bare)
    cb[i] = c * mix(1.07, 1.02, bare)
    rough[i] = mix(0.56 + 0.05 * gr + 0.03 * cloud[i], 0.3, bare)
  }
}

/** 喷漆金属（可着色）：带橘皮纹的漆面，磕碰掉漆露出底漆与钢，掉漆处颜色、粗糙度、金属度都变化 */
export function paintedMetal(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough, metal } = g
  const s = size / 512
  const peel = g.fbm(44, 44, 2, 0.5)
  const und = g.fbm(3, 3, 3)
  const grime = g.fbm(4, 4, 5, 0.55)
  const chipSrc = g.fbm(6, 6, 5, 0.62)
  const chipLevel = g.level(chipSrc, 0.045)
  const rustSrc = g.fbm(9, 9, 3)
  const ding = g.field()
  for (let i = 0; i < 110; i++) {
    const r = (1 + rng.next() * rng.next() * 5) * s
    g.blob(ding, null, rng.next() * size, rng.next() * size, r, r * rng.range(0.4, 1), rng.next() * TAU, 1, 0, 0.5)
  }
  const scratch = g.field()
  for (let i = 0; i < 46; i++) {
    g.stroke(
      scratch,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.next() * TAU,
      rng.range(10, 100) * s,
      rng.range(0.4, 1) * s,
      rng.range(0.4, 1),
      rng.range(-0.005, 0.005) / s,
      0,
      0,
      1,
    )
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const src = chipSrc[i] + peel[i] * 0.025
    const d = ding[i]
    const sc = scratch[i]
    // 掉漆：露出钢；外面一圈是被磨薄的底漆
    const chip = Math.max(
      smoothstep(chipLevel, chipLevel + 0.025, src),
      smoothstep(0.35, 0.5, d),
      smoothstep(0.6, 0.8, sc),
    )
    const thin = Math.max(
      smoothstep(chipLevel - 0.09, chipLevel - 0.02, src),
      smoothstep(0.02, 0.3, d),
      smoothstep(0.15, 0.55, sc),
    )
    const primer = clamp01(thin - chip)
    const dirty = smoothstep(0, 0.9, grime[i])
    const rusty = smoothstep(-0.1, 0.5, rustSrc[i]) * chip

    const paint = 0.88 + 0.014 * und[i] + 0.008 * peel[i] - 0.05 * dirty
    const bare = 0.7 + n * 0.06
    let r = mix(paint, paint * 0.84, primer)
    let gg = r
    let b = mix(paint * 0.99, paint * 0.82, primer)
    r = mix(r, mix(bare, 0.52, rusty), chip)
    gg = mix(gg, mix(bare, 0.33, rusty), chip)
    b = mix(b, mix(bare * 1.02, 0.2, rusty), chip)

    height[i] = mix(0.62 + 0.05 * peel[i] + 0.04 * und[i], 0.4 + n * 0.04 + 0.05 * rusty, chip) - 0.07 * primer
    cr[i] = r
    cg[i] = gg
    cb[i] = b
    rough[i] = mix(mix(0.43 - 0.03 * peel[i] + 0.07 * dirty, 0.55, primer), mix(0.38, 0.55, rusty), chip)
    metal[i] = chip * (1 - 0.85 * rusty)
  }
}

/** 锈蚀铁皮：浮锈 → 赤锈 → 深褐老锈的层次，起皮鳞片、赭黄锈点，残留少量暗钢 */
export function rust(g: Gen): void {
  const { size, count, height, cr, cg, cb, rough, metal } = g
  const big = g.fbm(3, 3, 5, 0.55)
  const mid = g.fbm(10, 10, 4, 0.55)
  const fine = g.fbm(60, 60, 3, 0.6)
  const speck = g.fbm(30, 30, 3, 0.6)
  const streak = g.fbm(40, 2, 3, 0.55)
  const f1 = g.field()
  const f2 = g.field()
  const id = g.field()
  g.worley(24, 24, 0.95, f1, f2, id)
  const amount = g.field()
  for (let i = 0; i < count; i++) amount[i] = big[i] * 0.6 + mid[i] * 0.4
  // 约 84% 的面积被锈覆盖
  const level = g.level(amount, 0.84)
  let top = -Infinity
  for (let i = 0; i < count; i++) if (amount[i] > top) top = amount[i]
  const span = 1 / Math.max(1e-3, top - level)
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const f = fine[i]
    const a = amount[i] + f * 0.07
    const rusted = smoothstep(level - 0.04, level + 0.1, a)
    // 锈蚀深度 0..1：浮锈 → 老锈
    const t = clamp01((a - level) * span)
    // 老锈起皮：鳞片之间的裂缝
    const flakeEdge = (1 - smoothstep(0.02, 0.12, f2[i] - f1[i])) * smoothstep(0.35, 0.7, t)
    const flakeLift = (id[i] - 0.5) * smoothstep(0.35, 0.7, t)

    let r: number
    let gg: number
    let b: number
    if (t < 0.45) {
      const k = t / 0.45
      r = mix(0.64, 0.47, k)
      gg = mix(0.35, 0.21, k)
      b = mix(0.14, 0.09, k)
    } else {
      const k = (t - 0.45) / 0.55
      r = mix(0.47, 0.24, k)
      gg = mix(0.21, 0.115, k)
      b = mix(0.09, 0.075, k)
    }
    const k = (0.88 + 0.2 * f + n * 0.12 + flakeLift * 0.25) * (1 - 0.5 * flakeEdge)
    r *= k
    gg *= k
    b *= k
    // 赭黄锈点
    const ochre = smoothstep(0.35, 0.8, speck[i]) * 0.55 * (1 - 0.5 * t)
    r = mix(r, 0.72, ochre)
    gg = mix(gg, 0.49, ochre)
    b = mix(b, 0.2, ochre)

    // 残留的钢：发暗、带流挂污痕
    const st = 0.38 + 0.04 * streak[i] + n * 0.04 + 0.03 * mid[i]
    height[i] = mix(0.36 + n * 0.03, 0.44 + 0.26 * t + 0.09 * f + flakeLift * 0.12 - 0.2 * flakeEdge, rusted)
    cr[i] = mix(st, r, rusted)
    cg[i] = mix(st * 1.01, gg, rusted)
    cb[i] = mix(st * 1.04, b, rusted)
    rough[i] = mix(0.48 + 0.05 * streak[i], clamp01(0.86 + 0.1 * t + 0.05 * f), rusted)
    metal[i] = 1 - rusted
  }
}

/** 工程塑料（可着色）：哑光、细密皮纹（模具咬花），少量被磨亮的擦痕 */
export function polymer(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const cells = Math.round(104 * s)
  const f1 = g.field()
  const f2 = g.field()
  g.worley(cells, cells, 0.95, f1, f2, null)
  const und = g.fbm(3, 3, 3)
  const fine = g.fbm(160, 160, 1)
  const scuff = g.field()
  for (let i = 0; i < 26; i++) {
    g.stroke(
      scuff,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.next() * TAU,
      rng.range(18, 90) * s,
      rng.range(0.8, 2.2) * s,
      rng.range(0.3, 0.9),
      rng.range(-0.006, 0.006) / s,
      0,
      0,
      1,
    )
  }

  for (let i = 0; i < count; i++) {
    // 皮纹：细胞中心鼓起，边界下凹
    const bump = smoothstep(0, 0.42, f2[i] - f1[i])
    const sc = scuff[i]
    const c = 0.8 + 0.012 * und[i] + 0.022 * (bump - 0.6) + 0.006 * fine[i] + 0.035 * sc
    // 擦痕把皮纹的高点磨平
    height[i] = 0.35 + 0.34 * bump * (1 - 0.6 * sc) + 0.05 * fine[i]
    cr[i] = c
    cg[i] = c
    cb[i] = c * 1.005
    rough[i] = clamp01(0.62 - 0.05 * bump + 0.025 * und[i] - 0.2 * sc)
  }
}

/** 轮胎橡胶：近黑的哑光表面，细颗粒、龟裂细纹、灰白擦痕，凹处积灰 */
export function rubber(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const fine = g.fbm(96, 96, 2, 0.6)
  const mid = g.fbm(12, 12, 4)
  const dustSrc = g.fbm(5, 5, 5, 0.6)
  const scuff = g.field()
  for (let i = 0; i < 34; i++) {
    g.stroke(
      scuff,
      null,
      rng.next() * size,
      rng.next() * size,
      rng.next() * TAU,
      rng.range(12, 70) * s,
      rng.range(0.6, 1.8) * s,
      rng.range(0.3, 0.9),
      rng.range(-0.01, 0.01) / s,
      0,
      0,
      1,
    )
  }
  // 老化龟裂：大量极短的细纹，大致沿 v 方向
  const crack = g.field()
  for (let i = 0; i < 420; i++) {
    g.stroke(
      crack,
      null,
      rng.next() * size,
      rng.next() * size,
      Math.PI / 2 + rng.range(-0.5, 0.5),
      rng.range(3, 12) * s,
      0.3 * s,
      rng.range(0.3, 0.9),
      rng.range(-0.05, 0.05) / s,
      0,
      0,
      1,
    )
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const f = fine[i]
    const sc = scuff[i]
    const ck = crack[i]
    // 灰尘落在颗粒的低处和裂纹里
    const dust = clamp01(smoothstep(-0.1, 0.8, dustSrc[i]) * (0.55 - 0.45 * f) + ck * 0.4)
    const base = (0.085 + 0.012 * mid[i] + 0.012 * f + n * 0.012) * (1 - 0.4 * ck) + 0.075 * sc

    height[i] = 0.5 + 0.16 * f + 0.1 * mid[i] + n * 0.05 - 0.12 * sc - 0.3 * ck
    cr[i] = mix(base, 0.3, dust * 0.5)
    cg[i] = mix(base, 0.27, dust * 0.5)
    cb[i] = mix(base * 1.03, 0.23, dust * 0.5)
    rough[i] = clamp01(0.84 + 0.05 * f + 0.1 * dust + 0.05 * sc)
  }
}

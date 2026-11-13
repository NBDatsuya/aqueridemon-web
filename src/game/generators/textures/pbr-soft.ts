/**
 * PBR 表面：织物、皮革与头发（棉布、牛仔布、帆布、皮革、发丝）。
 * 织物按纱线逐根建模：经纱（沿 v）与纬纱（沿 u）各有截面轮廓与上下起伏，取高者为可见的那根，
 * 颜色、高度、粗糙度都从这份纱线数据得到。纱线根数是偶数且整除贴图边长，所以可无缝平铺。
 */

import { clamp01, hash2, mix, smoothstep } from './pbr-core'
import type { Gen } from './pbr-core'

const TAU = Math.PI * 2

/**
 * 平纹织物的纱线场。
 * @param pitch 单根纱线的间距（像素，需整除贴图边长且根数为偶数）
 * @param irregular 纱线粗细与位置的不规则程度 0..1
 * @param twist 纱线捐度纹的强度（0 关闭，细纱分辨率不够时不用）
 * @param thread 输出：纱线高度 0..1（线间空隙趋近 0）
 * @param top 输出：可见的是经纱（0）还是纬纱（1）
 * @param tone 输出：可见纱线的明暗偏移，约 -1..1
 */
function weave(
  g: Gen,
  pitch: number,
  irregular: number,
  twist: number,
  thread: Float32Array,
  top: Float32Array,
  tone: Float32Array,
): void {
  const { size, rng } = g
  const n = Math.round(size / pitch)
  const warpTone = new Float32Array(n)
  const weftTone = new Float32Array(n)
  const warpWide = new Float32Array(n)
  const weftWide = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    warpTone[k] = rng.range(-1, 1)
    weftTone[k] = rng.range(-1, 1)
    warpWide[k] = 1 - irregular * 0.3 * rng.next()
    weftWide[k] = 1 - irregular * 0.3 * rng.next()
  }
  // 纱线的轻微跑偏与粗细节（竹节）
  const wobX = g.fbm(7, 5, 2)
  const wobY = g.fbm(5, 7, 2)
  const slubW = g.fbm(n / 2, 5, 2)
  const slubF = g.fbm(5, n / 2, 2)
  const wob = pitch * 0.22 * irregular

  let i = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const tx = (x + 0.5 + wobX[i] * wob) / pitch
      const ty = (y + 0.5 + wobY[i] * wob) / pitch
      const ix = Math.floor(tx)
      const iy = Math.floor(ty)
      const fx = tx - ix
      const fy = ty - iy
      const wi = ((ix % n) + n) % n
      const wj = ((iy % n) + n) % n
      // 截面轮廓 × 上下起伏：(ix + iy) 为偶数的交叉点经纱在上
      const ew = Math.cos(Math.PI * (ty - 0.5)) * (ix & 1 ? -1 : 1)
      const ef = -Math.cos(Math.PI * (tx - 0.5)) * (iy & 1 ? -1 : 1)
      const hw = Math.sqrt(Math.sin(Math.PI * fx)) * (0.55 + 0.45 * ew) * warpWide[wi] * (1 + 0.12 * irregular * slubW[i])
      const hf = Math.sqrt(Math.sin(Math.PI * fy)) * (0.55 + 0.45 * ef) * weftWide[wj] * (1 + 0.12 * irregular * slubF[i])
      if (hw >= hf) {
        const tw = twist > 0 ? Math.sin(TAU * (ty * 1.5 + fx)) * twist : 0
        thread[i] = hw * (1 + tw * 0.12)
        top[i] = 0
        tone[i] = warpTone[wi] * 0.7 + slubW[i] * 0.3 + tw
      } else {
        const tw = twist > 0 ? Math.sin(TAU * (tx * 1.5 + fy)) * twist : 0
        thread[i] = hf * (1 + tw * 0.12)
        top[i] = 1
        tone[i] = weftTone[wj] * 0.7 + slubF[i] * 0.3 + tw
      }
    }
  }
}

/** 棉布（可着色）：细密平纹，经纬清晰，纱线略有粗细变化，带细小绒毛与轻微褶皱 */
export function fabric(g: Gen): void {
  const { size, count, height, cr, cg, cb, rough } = g
  const thread = g.field()
  const top = g.field()
  const tone = g.field()
  weave(g, size / 128, 0.5, 0, thread, top, tone)
  const wrinkle = g.fbm(3, 4, 4)
  const mott = g.fbm(6, 6, 3)
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const th = clamp01(thread[i])
    // 纱线越高越亮，线间空隙发暗；纬纱略暗一点，经纬才分得清
    const c = (0.7 + 0.2 * th) * (1 + 0.045 * tone[i] - 0.035 * top[i]) + 0.012 * mott[i] + n * 0.03
    height[i] = 0.18 + 0.56 * th + 0.14 * wrinkle[i] + n * 0.05
    cr[i] = c
    cg[i] = c
    cb[i] = c * 0.99
    rough[i] = clamp01(0.9 + 0.08 * (1 - th) + n * 0.04)
  }
}

/** 帆布（可着色）：粗纱平纹，纱线粗细不匀、带捐纹，起伏明显，有污迹与磨白 */
export function canvas(g: Gen): void {
  const { size, count, height, cr, cg, cb, rough } = g
  const thread = g.field()
  const top = g.field()
  const tone = g.field()
  weave(g, size / 64, 1, 0.5, thread, top, tone)
  const und = g.fbm(3, 3, 4)
  const dirtSrc = g.fbm(4, 5, 5, 0.55)
  const wearSrc = g.fbm(6, 6, 4)
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const th = clamp01(thread[i])
    // 脏污积在纱线之间；纱线高点被磨白
    const dirty = smoothstep(-0.1, 0.8, dirtSrc[i]) * (1 - 0.6 * th)
    const worn = smoothstep(0.1, 0.8, wearSrc[i]) * smoothstep(0.55, 0.95, th)
    const c = (0.62 + 0.24 * th) * (1 + 0.06 * tone[i] - 0.03 * top[i]) * (1 - 0.2 * dirty) + 0.05 * worn + n * 0.04
    height[i] = 0.12 + 0.68 * th + 0.08 * und[i] + n * 0.06
    cr[i] = c
    cg[i] = c * (0.995 - 0.01 * dirty)
    cb[i] = c * (0.975 - 0.03 * dirty)
    rough[i] = clamp01(0.93 + 0.06 * (1 - th) - 0.05 * worn + n * 0.04)
  }
}

/** 牛仔布：3/1 斜纹，靛蓝经纱浮在表面、白色纬纱隔三露一，形成斜向纹路；竖向竹节与磨白 */
export function denim(g: Gen): void {
  const { size, rng, height, cr, cg, cb, rough } = g
  const pitch = size / 128
  const n = 128
  const warpTone = new Float32Array(n)
  const warpWide = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    warpTone[k] = rng.range(-1, 1)
    warpWide[k] = 1 - 0.22 * rng.next()
  }
  // 竖向竹节：沿经纱方向拉长的深浅条
  const slub = g.fbm(64, 3, 2)
  const fade = g.fbm(3, 3, 4)
  const wrinkle = g.fbm(4, 3, 4)
  const seed = g.seed()

  let i = 0
  for (let y = 0; y < size; y++) {
    const ty = (y + 0.5) / pitch
    const iy = Math.floor(ty)
    const fy = ty - iy
    const ay = Math.sqrt(Math.sin(Math.PI * fy))
    for (let x = 0; x < size; x++, i++) {
      const tx = (x + 0.5) / pitch
      const ix = Math.floor(tx)
      const fx = tx - ix
      const ax = Math.sqrt(Math.sin(Math.PI * fx))
      // 4 行一个循环：k = 0 的交叉点纬纱在上，其余 3 行经纱浮在上面
      const k = (((iy - ix) % 4) + 4) % 4
      const hw = ax * (k === 0 ? 0.12 : 0.6 + 0.4 * Math.sin((Math.PI * (k - 1 + fy)) / 3)) * warpWide[ix]
      const hf = ay * (k === 0 ? 0.62 + 0.38 * Math.sin(Math.PI * fx) : 0.3)
      const nz = hash2(x, y, seed) - 0.5
      const wornArea = 0.5 + 0.5 * fade[i]

      let r: number
      let gg: number
      let b: number
      let h: number
      if (hw >= hf) {
        h = hw
        // 环染的经纱：高点磨掉靛蓝露出白芯
        const worn = clamp01(0.1 + 0.2 * warpTone[ix] + 0.22 * slub[i] + 0.4 * wornArea * smoothstep(0.55, 1, hw))
        const shade = 0.72 + 0.28 * hw
        r = mix(0.115, 0.42, worn) * shade
        gg = mix(0.185, 0.52, worn) * shade
        b = mix(0.37, 0.7, worn) * shade
      } else {
        h = hf
        // 纬纱陷在经纱之间，又被靛蓝蹭染，只比经纱略浅，远看是一道道斜向的浅色细纹
        const shade = (0.55 + 0.45 * hf) * (0.8 + 0.2 * wornArea)
        r = 0.36 * shade
        gg = 0.43 * shade
        b = 0.58 * shade
      }
      height[i] = 0.16 + 0.6 * h + 0.14 * wrinkle[i] + nz * 0.05
      cr[i] = r + nz * 0.025
      cg[i] = gg + nz * 0.025
      cb[i] = b + nz * 0.03
      rough[i] = clamp01(0.9 + 0.08 * (1 - h) + nz * 0.04)
    }
  }
}

/** 皮革（可着色）：荔枝纹颗粒，粒间沟纹发暗更粗糙，粒顶被磨亮；长折痕与细毛孔 */
export function leather(g: Gen): void {
  const { size, count, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const cells = Math.round(46 * s)
  const f1 = g.field()
  const f2 = g.field()
  const id = g.field()
  g.worley(cells, cells, 0.9, f1, f2, id)
  const m1 = g.field()
  const m2 = g.field()
  g.worley(cells * 3, cells * 3, 0.95, m1, m2, null)
  const und = g.fbm(3, 3, 4)
  const wearSrc = g.fbm(5, 5, 4)
  // 折痕：略弯的长线，大致朝两个方向
  const crease = g.field()
  const dir = rng.next() * Math.PI
  for (let i = 0; i < 30; i++) {
    g.stroke(
      crease,
      null,
      rng.next() * size,
      rng.next() * size,
      dir + (rng.next() < 0.3 ? Math.PI / 2 : 0) + rng.range(-0.35, 0.35),
      rng.range(60, 280) * s,
      rng.range(0.7, 1.6) * s,
      rng.range(0.4, 1),
      rng.range(-0.006, 0.006) / s,
      0,
      0,
      1,
    )
  }
  const seed = g.seed()

  for (let i = 0; i < count; i++) {
    const n = hash2(i & g.mask, (i / size) | 0, seed) - 0.5
    const pebble = smoothstep(0.02, 0.34, f2[i] - f1[i])
    const micro = smoothstep(0, 0.35, m2[i] - m1[i])
    const cs = crease[i]
    const worn = smoothstep(0, 0.7, wearSrc[i]) * pebble
    const c =
      (0.8 - 0.17 * (1 - pebble) + 0.03 * (micro - 0.5) + 0.02 * und[i] + 0.035 * worn + n * 0.015) * (1 - 0.3 * cs)

    height[i] = 0.26 + 0.36 * pebble * (0.72 + 0.28 * id[i]) + 0.07 * micro + 0.07 * und[i] - 0.3 * cs
    cr[i] = c
    cg[i] = c * 0.988
    cb[i] = c * 0.97
    rough[i] = clamp01(0.5 + 0.2 * (1 - pebble) + 0.05 * (1 - micro) - 0.12 * worn + 0.12 * cs)
  }
}

/** 头发（可着色）：三层发丝沿 v 方向流动、互相叠压，每根有自己的粗细与深浅，发束之间是暗缝 */
export function hair(g: Gen): void {
  const { size, rng, height, cr, cg, cb, rough } = g
  const s = size / 512
  const sub = 4
  const n = size * sub
  const layers = 3
  const profH = new Float32Array(n * layers)
  const profT = new Float32Array(n * layers)
  // 每层一条横截面：逐根排列的发丝（圆拱轮廓），沿 v 方向扫掘并被噪声带着左右摆动
  for (let l = 0; l < layers; l++) {
    let pos = 0
    while (pos < n) {
      let w = Math.round(rng.range(1.5, 3.6) * s * sub)
      if (n - pos - w < 6) w = n - pos
      const z = rng.range(0.35, 1) * (1 - 0.1 * l)
      const t = rng.next()
      for (let j = 0; j < w; j++) {
        profH[l * n + pos + j] = z * Math.sqrt(Math.sin((Math.PI * (j + 0.5)) / w))
        profT[l * n + pos + j] = t
      }
      pos += w
    }
  }
  const flowA = [g.fbm(2, 1, 3), g.fbm(3, 1, 3), g.fbm(2, 2, 3)]
  const flowB = [g.fbm(9, 3, 2), g.fbm(7, 2, 2), g.fbm(11, 3, 2)]
  const clump = g.fbm(18, 1, 3)
  const streak = g.fbm(120, 2, 2, 0.6)
  const along = g.fbm(3, 5, 3)
  const big = [34 * s, 22 * s, 46 * s]
  const small = [5 * s, 7 * s, 4 * s]
  const nMask = n - 1

  let i = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      let h = 0
      let t = 0
      for (let l = 0; l < layers; l++) {
        const p = x + 0.5 + flowA[l][i] * big[l] + flowB[l][i] * small[l]
        const k = l * n + (Math.floor(p * sub) & nMask)
        if (profH[k] > h) {
          h = profH[k]
          t = profT[k]
        }
      }
      // 发束：低处是束与束之间的缝
      const cl = 0.5 + 0.5 * clump[i]
      const hh = clamp01(h * (0.72 + 0.28 * cl) + 0.05 * streak[i])
      const c = (0.36 + 0.5 * hh) * (0.84 + 0.22 * t) * (1 + 0.05 * along[i] + 0.04 * streak[i])
      height[i] = 0.1 + 0.8 * hh
      cr[i] = c
      cg[i] = c * 0.985
      cb[i] = c * 0.965
      rough[i] = clamp01(0.44 + 0.2 * (1 - hh) + 0.05 * (t - 0.5))
    }
  }
}

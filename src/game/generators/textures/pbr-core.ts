/**
 * PBR 贴图生成内核：可无缝平铺的噪声场、笔触与斑点光栅化、以及 高度场 → 法线 / 粗糙度 的编码管线。
 * 纯数值实现，不依赖 three 与 DOM，全部数据放在 Float32Array 里，逐像素循环不分配对象。
 * 约定：贴图边长是 2 的幂；所有场按行存放，下标 = y * size + x，y 向下（画布方向）。
 */

import { createRng } from '../../utils/random'
import type { Rng } from '../../utils/random'

const TAU = Math.PI * 2

/** 把数值夹到 [0, 1] */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 线性插值 */
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 平滑阶跃：v 从 a 到 b 时由 0 平滑过渡到 1（a 可以大于 b） */
export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** 整数坐标哈希，返回 [0, 1) */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// 噪声用的临时表：按需扩容后复用，避免每个倍频都重新分配
let latX = new Float32Array(0)
let latY = new Float32Array(0)
let colA = new Int32Array(0)
let colB = new Int32Array(0)
let colT = new Float32Array(0)
let colW = new Float32Array(0)

/**
 * 往 out 叠加一个倍频的周期梯度噪声（整张贴图上 fx × fy 个晶格，天然无缝）。
 * @param mode 0 原值；1 取绝对值（团块状）；2 取 1 - 绝对值（脊线状）
 */
function addNoise(
  out: Float32Array,
  size: number,
  fx: number,
  fy: number,
  amp: number,
  seed: number,
  mode: number,
): void {
  const cells = fx * fy
  if (latX.length < cells) {
    latX = new Float32Array(cells)
    latY = new Float32Array(cells)
  }
  if (colA.length < size) {
    colA = new Int32Array(size)
    colB = new Int32Array(size)
    colT = new Float32Array(size)
    colW = new Float32Array(size)
  }
  for (let j = 0, k = 0; j < fy; j++) {
    for (let i = 0; i < fx; i++, k++) {
      const a = hash2(i, j, seed) * TAU
      latX[k] = Math.cos(a)
      latY[k] = Math.sin(a)
    }
  }
  // 每个倍频一个随机相位，避免各倍频的晶格零点重合
  const ox = hash2(seed, 11, 3)
  const oy = hash2(seed, 29, 5)
  for (let x = 0; x < size; x++) {
    const p = ((x + 0.5) / size) * fx + ox
    const i0 = Math.floor(p)
    const t = p - i0
    colA[x] = i0 % fx
    colB[x] = (i0 + 1) % fx
    colT[x] = t
    colW[x] = t * t * t * (t * (t * 6 - 15) + 10)
  }
  const gain = amp * 1.42
  let idx = 0
  for (let y = 0; y < size; y++) {
    const p = ((y + 0.5) / size) * fy + oy
    const j0 = Math.floor(p)
    const ty = p - j0
    const ty1 = ty - 1
    const wy = ty * ty * ty * (ty * (ty * 6 - 15) + 10)
    const r0 = (j0 % fy) * fx
    const r1 = ((j0 + 1) % fy) * fx
    for (let x = 0; x < size; x++) {
      const i0 = colA[x]
      const i1 = colB[x]
      const tx = colT[x]
      const tx1 = tx - 1
      const wx = colW[x]
      const a = latX[r0 + i0] * tx + latY[r0 + i0] * ty
      const b = latX[r0 + i1] * tx1 + latY[r0 + i1] * ty
      const c = latX[r1 + i0] * tx + latY[r1 + i0] * ty1
      const d = latX[r1 + i1] * tx1 + latY[r1 + i1] * ty1
      const top = a + (b - a) * wx
      const v = (top + (c + (d - c) * wx - top) * wy) * gain
      out[idx++] += mode === 0 ? v : mode === 1 ? Math.abs(v) : 1 - Math.abs(v)
    }
  }
}

/** 把一张场线性拉伸到 [lo, hi] */
export function normalize(field: Float32Array, lo: number, hi: number): void {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < field.length; i++) {
    const v = field[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  const k = max > min ? (hi - lo) / (max - min) : 0
  for (let i = 0; i < field.length; i++) field[i] = lo + (field[i] - min) * k
}

/**
 * 一张表面的生成上下文：持有输出图层（高度、颜色、粗糙度、金属度）与全部场运算工具。
 * 表面生成函数先用噪声 / 笔触构造若干遮罩场，再在一次逐像素合成里同时写出所有图层，
 * 这样颜色、法线、粗糙度的细节出自同一份数据。
 */
export class Gen {
  /** 贴图边长（2 的幂） */
  readonly size: number
  /** size - 1，用于按位取模 */
  readonly mask: number
  /** 像素总数 */
  readonly count: number
  /** 本张贴图的随机源 */
  readonly rng: Rng
  /** 高度场，约 [0, 1]，越大越凸 */
  readonly height: Float32Array
  /** 颜色 R（sRGB，0..1） */
  readonly cr: Float32Array
  /** 颜色 G（sRGB，0..1） */
  readonly cg: Float32Array
  /** 颜色 B（sRGB，0..1） */
  readonly cb: Float32Array
  /** 绝对粗糙度（0..1） */
  readonly rough: Float32Array
  /** 金属度（0..1），只有声明了金属度贴图的表面才会用到 */
  readonly metal: Float32Array

  constructor(size: number, seed: number) {
    if ((size & (size - 1)) !== 0) throw new Error('PBR 贴图边长必须是 2 的幂')
    this.size = size
    this.mask = size - 1
    this.count = size * size
    this.rng = createRng(seed)
    this.height = new Float32Array(this.count)
    this.cr = new Float32Array(this.count)
    this.cg = new Float32Array(this.count)
    this.cb = new Float32Array(this.count)
    this.rough = new Float32Array(this.count)
    this.metal = new Float32Array(this.count)
  }

  /** 分配一张清零的标量场 */
  field(): Float32Array {
    return new Float32Array(this.count)
  }

  /** 取一个新的整数种子 */
  seed(): number {
    return this.rng.int(1, 0x7ffffffe)
  }

  /**
   * 周期分形噪声，结果拉伸到 [-1, 1]。fx ≠ fy 时得到沿一个方向拉长的纹理（拉丝、木纹、发丝）。
   * @param fx 首个倍频在 u 方向的周期数（整数）
   * @param fy 首个倍频在 v 方向的周期数（整数）
   * @param octaves 倍频层数（晶格小于 2 像素时提前停止）
   * @param gain 每层振幅衰减，默认 0.5
   * @param mode 0 普通；1 团块（绝对值）；2 脊线（1 - 绝对值）
   */
  fbm(fx: number, fy: number, octaves: number, gain = 0.5, mode = 0): Float32Array {
    const out = this.field()
    const limit = this.size / 2
    let amp = 1
    let ax = Math.max(1, Math.round(fx))
    let ay = Math.max(1, Math.round(fy))
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && (ax > limit || ay > limit)) break
      addNoise(out, this.size, Math.min(ax, limit), Math.min(ay, limit), amp, this.seed(), mode)
      amp *= gain
      ax *= 2
      ay *= 2
    }
    normalize(out, -1, 1)
    return out
  }

  /**
   * 周期 Worley（细胞）噪声。距离以 u 方向的晶格宽度为单位。
   * @param fx u 方向的细胞数
   * @param fy v 方向的细胞数
   * @param jitter 特征点抖动 0..1（0 为规则网格）
   * @param f1 输出：到最近特征点的距离
   * @param f2 输出：到次近特征点的距离（f2 - f1 在细胞边界处趋近 0），可为 null
   * @param id 输出：所在细胞的随机值 [0, 1)，可为 null
   */
  worley(
    fx: number,
    fy: number,
    jitter: number,
    f1: Float32Array,
    f2: Float32Array | null,
    id: Float32Array | null,
    stretched = false,
  ): void {
    const size = this.size
    const cells = fx * fy
    const px = new Float32Array(cells)
    const py = new Float32Array(cells)
    const pid = new Float32Array(cells)
    const seed = this.seed()
    for (let j = 0, k = 0; j < fy; j++) {
      for (let i = 0; i < fx; i++, k++) {
        px[k] = i + 0.5 + (hash2(i, j, seed) - 0.5) * jitter
        py[k] = j + 0.5 + (hash2(i, j, seed + 1) - 0.5) * jitter
        pid[k] = hash2(i, j, seed + 2)
      }
    }
    const aspect = fx / fy
    // 细胞不是正方形时，最近的特征点可能隔着好几格：沿细胞较窄的方向扩大搜索范围，否则格线上会出现断层
    const ri = aspect > 1.01 ? Math.ceil(aspect) + 1 : 1
    const rj = aspect < 0.99 ? Math.ceil(1 / aspect) + 1 : 1
    let idx = 0
    for (let y = 0; y < size; y++) {
      const v = ((y + 0.5) / size) * fy
      const cj = Math.floor(v)
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * fx
        const ci = Math.floor(u)
        let d1 = 1e9
        let d2 = 1e9
        let best = 0
        for (let oj = -rj; oj <= rj; oj++) {
          const jj = cj + oj
          const wj = ((jj % fy) + fy) % fy
          for (let oi = -ri; oi <= ri; oi++) {
            const ii = ci + oi
            const wi = ((ii % fx) + fx) % fx
            const k = wj * fx + wi
            const dx = px[k] + (ii - wi) - u
            const dy = (py[k] + (jj - wj) - v) * aspect
            const d = dx * dx + dy * dy
            if (d < d1) {
              d2 = d1
              d1 = d
              best = pid[k]
            } else if (d < d2) {
              d2 = d
            }
          }
        }
        f1[idx] = Math.sqrt(d1)
        if (f2) f2[idx] = Math.sqrt(d2)
        if (id) id[idx] = best
        idx++
      }
    }
  }

  /**
   * 等值线：取 src 在 level 处的等高线，输出宽度约为 width 像素的细线遮罩（0..1）。
   * 用来画裂纹、折痕、血管这类蜿蜒的细线。
   */
  lines(src: Float32Array, level: number, width: number): Float32Array {
    const { size, mask } = this
    const out = this.field()
    const inv = 1 / width
    for (let y = 0; y < size; y++) {
      const row = y * size
      const up = ((y - 1) & mask) * size
      const down = ((y + 1) & mask) * size
      for (let x = 0; x < size; x++) {
        const l = (x - 1) & mask
        const r = (x + 1) & mask
        const gx = (src[row + r] - src[row + l]) * 0.5
        const gy = (src[down + x] - src[up + x]) * 0.5
        const d = Math.abs(src[row + x] - level) / (Math.sqrt(gx * gx + gy * gy) + 1e-6)
        if (d < width) {
          const t = 1 - d * inv
          out[row + x] = t * t * (3 - 2 * t)
        }
      }
    }
    return out
  }

  /** 带环绕的盒式模糊（多次迭代近似高斯），返回新场 */
  blur(src: Float32Array, radius: number, passes = 2): Float32Array {
    const { size, mask } = this
    const r = Math.max(1, Math.round(radius))
    const inv = 1 / (r * 2 + 1)
    const out = new Float32Array(src)
    const tmp = this.field()
    const sums = new Float32Array(size)
    for (let p = 0; p < passes; p++) {
      // 横向
      for (let y = 0; y < size; y++) {
        const row = y * size
        let sum = 0
        for (let k = -r; k <= r; k++) sum += out[row + (k & mask)]
        for (let x = 0; x < size; x++) {
          tmp[row + x] = sum * inv
          sum += out[row + ((x + r + 1) & mask)] - out[row + ((x - r) & mask)]
        }
      }
      // 纵向：逐行推进每一列的滑动和，保持按行访问
      sums.fill(0)
      for (let k = -r; k <= r; k++) {
        const row = (k & mask) * size
        for (let x = 0; x < size; x++) sums[x] += tmp[row + x]
      }
      for (let y = 0; y < size; y++) {
        const row = y * size
        const add = ((y + r + 1) & mask) * size
        const sub = ((y - r) & mask) * size
        for (let x = 0; x < size; x++) {
          out[row + x] = sums[x] * inv
          sums[x] += tmp[add + x] - tmp[sub + x]
        }
      }
    }
    return out
  }

  /**
   * 求一个阈值，使得 field 中约有 coverage 比例的像素大于它。
   * 用它做遮罩可以让不同种子的覆盖率保持一致（同风格的变体）。
   */
  level(field: Float32Array, coverage: number): number {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < field.length; i++) {
      const v = field[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    if (max <= min) return min
    const bins = new Uint32Array(1024)
    const k = 1023.999 / (max - min)
    for (let i = 0; i < field.length; i++) bins[((field[i] - min) * k) | 0]++
    const target = coverage * field.length
    let acc = 0
    for (let b = 1023; b >= 0; b--) {
      acc += bins[b]
      if (acc >= target) return min + b / k
    }
    return min
  }

  /**
   * 沿一条（可弯曲的）路径画一道笔触，按“取最大值”写入 h，可同时把 tagValue 写进 tag（每道笔触一个标签）。
   * @param h 目标场
   * @param tag 标签场，可为 null
   * @param x 起点 x（像素）
   * @param y 起点 y（像素）
   * @param angle 起始方向（弧度，画布坐标）
   * @param len 长度（像素）
   * @param halfWidth 半宽（像素）
   * @param value 笔触中心写入的值
   * @param curve 每像素的转向（弧度）
   * @param tagValue 写入标签场的值
   * @param base 截面底值比例：0 为边缘渐隐的软笔触，接近 1 为平顶硬边
   * @param taper 0 等宽；1 两端收尖；2 起点宽、末端收尖
   */
  stroke(
    h: Float32Array,
    tag: Float32Array | null,
    x: number,
    y: number,
    angle: number,
    len: number,
    halfWidth: number,
    value: number,
    curve: number,
    tagValue: number,
    base: number,
    taper: number,
  ): void {
    const { size, mask } = this
    const step = halfWidth > 1.5 ? halfWidth * 0.5 : 0.75
    const steps = Math.max(1, Math.ceil(len / step))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const env = taper === 0 ? 1 : Math.sqrt(taper === 1 ? Math.sin(Math.PI * t) : 1 - t)
      const w = halfWidth * env + 0.5
      const r = Math.ceil(w)
      const inv = 1 / w
      const cx = Math.floor(x)
      const cy = Math.floor(y)
      for (let oy = -r; oy <= r; oy++) {
        const py = cy + oy
        const dy = py + 0.5 - y
        const row = (py & mask) * size
        for (let ox = -r; ox <= r; ox++) {
          const px = cx + ox
          const dx = px + 0.5 - x
          const d2 = dx * dx + dy * dy
          if (d2 >= w * w) continue
          const val = value * (base + (1 - base) * (1 - Math.sqrt(d2) * inv))
          const i = row + (px & mask)
          if (val > h[i]) {
            h[i] = val
            if (tag) tag[i] = tagValue
          }
        }
      }
      x += Math.cos(angle) * step
      y += Math.sin(angle) * step
      angle += curve * step
    }
  }

  /**
   * 盖一个旋转椭圆形的凸起，按“取最大值”写入 h，可同时写标签。
   * @param rx 长轴半径（像素）
   * @param ry 短轴半径（像素）
   * @param power 截面形状：0.5 近似半球，1 抛物面，2 以上为尖峰
   * @param base 截面底值比例：0 边缘降到 0，接近 1 为平顶
   */
  blob(
    h: Float32Array,
    tag: Float32Array | null,
    x: number,
    y: number,
    rx: number,
    ry: number,
    angle: number,
    value: number,
    tagValue: number,
    power: number,
    base = 0,
  ): void {
    const { size, mask } = this
    const r = Math.ceil(Math.max(rx, ry)) + 1
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const irx = 1 / rx
    const iry = 1 / ry
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    for (let oy = -r; oy <= r; oy++) {
      const py = cy + oy
      const dy = py + 0.5 - y
      const row = (py & mask) * size
      for (let ox = -r; ox <= r; ox++) {
        const px = cx + ox
        const dx = px + 0.5 - x
        const a = (dx * ca + dy * sa) * irx
        const b = (dy * ca - dx * sa) * iry
        const k = 1 - a * a - b * b
        if (k <= 0) continue
        const val = value * (base + (1 - base) * (power === 1 ? k : Math.pow(k, power)))
        const i = row + (px & mask)
        if (val > h[i]) {
          h[i] = val
          if (tag) tag[i] = tagValue
        }
      }
    }
  }

  /**
   * 画若干条带分叉的锯齿状裂纹（有回归方向的随机游走），按“取最大值”写入 out，裂纹中心为 1。
   * @param out 目标遮罩场
   * @param count 主裂纹条数
   * @param length 主裂纹的典型长度（像素）
   * @param halfWidth 起点处的半宽（像素），沿程收细
   */
  cracks(out: Float32Array, count: number, length: number, halfWidth: number): void {
    const rng = this.rng
    for (let i = 0; i < count; i++) {
      this.crack(
        out,
        rng.next() * this.size,
        rng.next() * this.size,
        rng.next() * TAU,
        length * rng.range(0.6, 1.4),
        halfWidth,
        2,
      )
    }
  }

  /** 单条裂纹：分段前进，小幅抖动、偶尔急转，并按概率分叉出更细的支裂纹 */
  private crack(
    out: Float32Array,
    x: number,
    y: number,
    angle: number,
    len: number,
    halfWidth: number,
    depth: number,
  ): void {
    const rng = this.rng
    const unit = this.size / 512
    let dir = angle
    let travelled = 0
    while (travelled < len) {
      const seg = (3 + rng.next() * 8) * unit
      const w = halfWidth * (1 - (travelled / len) * 0.75)
      dir += rng.range(-0.42, 0.42) + (angle - dir) * 0.3
      if (rng.next() < 0.1) dir += rng.range(-0.9, 0.9)
      this.stroke(out, null, x, y, dir, seg, w, 1, 0, 0, 0, 0)
      x += Math.cos(dir) * seg
      y += Math.sin(dir) * seg
      travelled += seg
      if (depth > 0 && rng.next() < 0.06) {
        const side = rng.sign() * rng.range(0.5, 1.2)
        this.crack(out, x, y, dir + side, (len - travelled) * rng.range(0.3, 0.8), w * 0.75, depth - 1)
      }
    }
  }
}

/** 表面生成函数：往 Gen 的输出图层里写入高度、颜色、粗糙度（以及可选的金属度） */
export type SurfaceGenerator = (g: Gen) => void

/** 编码参数 */
export interface EncodeOptions {
  /** 法线起伏强度（高度差 1 对应的斜率倍数，已按分辨率归一） */
  bump: number
  /** 凹处压暗 / 凸处提亮的强度（烘进颜色图的微遮蔽），0 关闭 */
  cavity: number
  /** 粗糙度贴图的量程：贴图值 = 绝对粗糙度 / roughScale */
  roughScale: number
  /** 是否把金属度写进粗糙度贴图的 B 通道 */
  packMetal: boolean
}

/** 三张贴图的 RGBA8 像素数据 */
export interface EncodedMaps {
  size: number
  color: Uint8ClampedArray
  normal: Uint8ClampedArray
  rough: Uint8ClampedArray
}

/**
 * 把 Gen 的图层编码成三张 RGBA8 贴图：
 * 颜色（sRGB，叠加由高度得到的微遮蔽）、法线（由高度场求导，切线空间，OpenGL 约定）、
 * 粗糙度（G 通道；packMetal 时 B 通道为金属度）。
 * @param g 已经由表面生成函数写好图层的上下文
 * @param options 编码参数
 */
export function encodeMaps(g: Gen, options: EncodeOptions): EncodedMaps {
  const { size, mask, count, height, cr, cg, cb, rough, metal } = g
  const color = new Uint8ClampedArray(count * 4)
  const normal = new Uint8ClampedArray(count * 4)
  const roughOut = new Uint8ClampedArray(count * 4)

  // 微遮蔽：高度减去其模糊值，凹处为负、凸处为正
  const soft = options.cavity > 0 ? g.blur(height, Math.max(2, size / 128), 2) : null
  // 画布 y 向下而贴图 v 向上（flipY），所以 G 通道直接用画布方向的差分
  const slope = options.bump * (size / 512) * 0.5
  const roughK = 255 / options.roughScale

  for (let y = 0; y < size; y++) {
    const row = y * size
    const up = ((y - 1) & mask) * size
    const down = ((y + 1) & mask) * size
    for (let x = 0; x < size; x++) {
      const i = row + x
      const o = i * 4
      const dx = (height[row + ((x + 1) & mask)] - height[row + ((x - 1) & mask)]) * slope
      const dy = (height[down + x] - height[up + x]) * slope
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1)
      normal[o] = (-dx * inv * 0.5 + 0.5) * 255
      normal[o + 1] = (dy * inv * 0.5 + 0.5) * 255
      normal[o + 2] = (inv * 0.5 + 0.5) * 255
      normal[o + 3] = 255

      let shade = 1
      if (soft) {
        const c = (height[i] - soft[i]) * options.cavity
        shade = 1 + (c < -0.4 ? -0.4 : c > 0.2 ? 0.2 : c)
      }
      color[o] = cr[i] * shade * 255
      color[o + 1] = cg[i] * shade * 255
      color[o + 2] = cb[i] * shade * 255
      color[o + 3] = 255

      const rv = rough[i] * roughK
      roughOut[o] = rv
      roughOut[o + 1] = rv
      roughOut[o + 2] = options.packMetal ? metal[i] * 255 : rv
      roughOut[o + 3] = 255
    }
  }
  return { size, color, normal, rough: roughOut }
}

/**
 * 程序纹理：用 Canvas 2D 现画，再转成 CanvasTexture。同一 kind + seed 只生成一次。
 * 除血迹贴花外都可平铺（噪声在四边做了混合）。
 */

import { CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace } from 'three'
import type { Texture } from 'three'
import type { GetTexture, TextureKind } from '../../core/types'
import { getNoise } from '../../utils/noise'
import type { Noise } from '../../utils/noise'
import { createRng, hashSeed } from '../../utils/random'
import type { Rng } from '../../utils/random'

export { createSkyMaterial } from './sky'

/** 纹理边长（像素） */
const SIZE = 256

type Rgb = readonly [number, number, number]

interface Painter {
  ctx: CanvasRenderingContext2D
  size: number
  rng: Rng
  noise: Noise
}

/** 当前像素的输出颜色，由着色回调写入（避免逐像素分配） */
const px: [number, number, number, number] = [0, 0, 0, 255]

/** 把 base × k 写入当前像素 */
function setRgb(base: Rgb, k: number): void {
  px[0] = base[0] * k
  px[1] = base[1] * k
  px[2] = base[2] * k
}

/** 把 a、b 按 t 混合后乘 k 写入当前像素 */
function mixRgb(a: Rgb, b: Rgb, t: number, k: number): void {
  px[0] = (a[0] + (b[0] - a[0]) * t) * k
  px[1] = (a[1] + (b[1] - a[1]) * t) * k
  px[2] = (a[2] + (b[2] - a[2]) * t) * k
}

/** 可平铺的分形噪声：与平移一个周期后的采样在四边混合 */
function tileNoise(noise: Noise, x: number, y: number, size: number, scale: number, octaves: number): number {
  const s = scale / size
  const u = x / size
  const v = y / size
  const a = noise.fbm2D(x * s, y * s, octaves)
  const b = noise.fbm2D((x - size) * s, y * s, octaves)
  const c = noise.fbm2D(x * s, (y - size) * s, octaves)
  const d = noise.fbm2D((x - size) * s, (y - size) * s, octaves)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/**
 * 逐像素填充。shade 收到该像素的噪声值（约 -1..1）并把颜色写进 px。
 * @param scale 整张纹理上的噪声周期数
 */
function fillPixels(
  p: Painter,
  scale: number,
  octaves: number,
  shade: (n: number, x: number, y: number) => void,
): void {
  const { ctx, size, noise } = p
  const image = ctx.createImageData(size, size)
  const data = image.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      px[3] = 255
      shade(tileNoise(noise, x, y, size, scale, octaves), x, y)
      const i = (y * size + x) * 4
      data[i] = px[0]
      data[i + 1] = px[1]
      data[i + 2] = px[2]
      data[i + 3] = px[3]
    }
  }
  ctx.putImageData(image, 0, 0)
}

/** 画一个边缘羽化的圆斑 */
function blotch(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, `rgba(${color},${alpha})`)
  g.addColorStop(0.6, `rgba(${color},${alpha * 0.6})`)
  g.addColorStop(1, `rgba(${color},0)`)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

/** 随机画若干条细线（划痕、草丛） */
function strokes(
  p: Painter,
  count: number,
  minLen: number,
  maxLen: number,
  style: (i: number) => string,
  width: number,
  vertical: boolean,
): void {
  const { ctx, size, rng } = p
  ctx.lineWidth = width
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, size)
    const y = rng.range(0, size)
    const len = rng.range(minLen, maxLen)
    const angle = vertical ? -Math.PI / 2 + rng.range(-0.5, 0.5) : rng.range(0, Math.PI * 2)
    ctx.strokeStyle = style(i)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len)
    ctx.stroke()
  }
}

const GRASS: Rgb = [58, 125, 68]
const CONCRETE: Rgb = [128, 128, 126]
const METAL: Rgb = [176, 180, 186]
const RUST: Rgb = [146, 80, 40]
const SKIN: Rgb = [90, 107, 90]
const SKIN_ROT: Rgb = [52, 60, 46]
const CLOTH: Rgb = [226, 226, 222]
const WOOD: Rgb = [142, 98, 58]
const ASPHALT: Rgb = [62, 64, 68]

const PAINTERS: Record<TextureKind, (p: Painter) => void> = {
  // 草地：绿色基底 + 噪声明暗 + 草丛短线 + 泥土斑点
  grass(p) {
    fillPixels(p, 5, 4, (n) => setRgb(GRASS, 1 + n * 0.24))
    strokes(p, 1000, 2, 6, (i) => (i % 3 === 0 ? 'rgba(96,160,84,0.55)' : 'rgba(30,84,40,0.6)'), 1, true)
    for (let i = 0; i < 22; i++) {
      blotch(p.ctx, p.rng.range(0, p.size), p.rng.range(0, p.size), p.rng.range(2, 6), '98,74,48', 0.45)
    }
  },

  // 混凝土：灰底 + Worley 裂纹 + 污渍
  concrete(p) {
    const { noise, size } = p
    fillPixels(p, 6, 4, (n, x, y) => {
      const cell = noise.worley2D((x / size) * 7, (y / size) * 7)
      const crack = cell > 0.84 ? 0.62 : 1
      setRgb(CONCRETE, (1 + n * 0.13) * crack)
    })
    for (let i = 0; i < 9; i++) {
      blotch(p.ctx, p.rng.range(0, size), p.rng.range(0, size), p.rng.range(10, 34), '50,48,44', 0.22)
    }
  },

  // 金属：银灰 + 细划痕
  metal(p) {
    fillPixels(p, 3, 3, (n, _x, y) => setRgb(METAL, 1 + n * 0.07 + Math.sin(y * 1.7) * 0.012))
    strokes(p, 70, 8, 60, (i) => (i % 4 === 0 ? 'rgba(40,44,50,0.35)' : 'rgba(240,244,250,0.4)'), 0.7, false)
  },

  // 锈蚀金属：金属底 + 噪声驱动的橙褐锈斑
  rust(p) {
    fillPixels(p, 5, 4, (n) => {
      const t = Math.min(1, Math.max(0, (n + 0.05) * 3.2))
      mixRgb(METAL, RUST, t, 1 + n * 0.1)
    })
    strokes(p, 40, 6, 40, () => 'rgba(60,34,20,0.35)', 0.8, false)
  },

  // 丧尸皮肤：灰绿 + 腐烂斑块 + 暗红血迹
  skin(p) {
    fillPixels(p, 5, 4, (n) => {
      const t = Math.min(1, Math.max(0, (n - 0.12) * 4))
      mixRgb(SKIN, SKIN_ROT, t, 1 + n * 0.12)
    })
    for (let i = 0; i < 7; i++) {
      const x = p.rng.range(0, p.size)
      const y = p.rng.range(0, p.size)
      blotch(p.ctx, x, y, p.rng.range(5, 16), '92,14,14', 0.6)
      for (let k = 0; k < 4; k++) {
        blotch(p.ctx, x + p.rng.range(-22, 22), y + p.rng.range(-22, 22), p.rng.range(1.5, 4), '92,14,14', 0.65)
      }
    }
  },

  // 血迹贴花：透明底上的不规则红色飞溅，边缘羽化
  blood(p) {
    const { ctx, size, rng } = p
    const c = size / 2
    ctx.clearRect(0, 0, size, size)
    for (let i = 0; i < 9; i++) {
      const a = rng.range(0, Math.PI * 2)
      const r = rng.range(0, size * 0.16)
      blotch(ctx, c + Math.cos(a) * r, c + Math.sin(a) * r, rng.range(size * 0.1, size * 0.22), '122,6,6', 0.95)
    }
    for (let i = 0; i < 26; i++) {
      const a = rng.range(0, Math.PI * 2)
      const r = rng.range(size * 0.2, size * 0.46)
      blotch(ctx, c + Math.cos(a) * r, c + Math.sin(a) * r, rng.range(size * 0.012, size * 0.045), '108,4,4', 0.9)
    }
    blotch(ctx, c, c, size * 0.16, '70,0,0', 0.7)
  },

  // 布料：近中性浅色 + 经纬织纹，供材质 color 着色
  cloth(p) {
    fillPixels(p, 6, 3, (n, x, y) => {
      const weave = (x % 4 < 2) !== (y % 4 < 2) ? 0.035 : -0.035
      setRgb(CLOTH, 1 + weave + n * 0.06)
    })
  },

  // 木纹：沿一个方向拉长的条纹
  wood(p) {
    const { size } = p
    fillPixels(p, 3, 3, (n, _x, y) => {
      const grain = Math.sin((y / size) * Math.PI * 2 * 14 + n * 5)
      setRgb(WOOD, 1 + grain * 0.1 + n * 0.08)
    })
  },

  // 沥青：深灰 + 细碎颗粒
  asphalt(p) {
    const { rng } = p
    fillPixels(p, 8, 3, (n) => setRgb(ASPHALT, 1 + n * 0.12 + rng.range(-0.09, 0.09)))
  },
}

const cache = new Map<string, Texture>()

/** 生成一张纹理 */
function build(kind: TextureKind, seed: number): Texture {
  const size = kind === 'blood' ? 128 : SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 2D 画布，程序纹理不可用')

  const salt = hashSeed(kind)
  PAINTERS[kind]({ ctx, size, rng: createRng(salt ^ (seed * 7919)), noise: getNoise((salt % 9973) + seed) })

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  const wrap = kind === 'blood' ? ClampToEdgeWrapping : RepeatWrapping
  texture.wrapS = wrap
  texture.wrapT = wrap
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

/**
 * 取得程序纹理。同一 kind + seed 返回同一个实例（调用方不要释放，也不要改它的 repeat；
 * 需要不同平铺密度时换一个 seed 取独立实例）。
 * @param kind 纹理种类
 * @param seed 变体种子，默认 0
 */
export const getTexture: GetTexture = (kind, seed = 0) => {
  const key = `${kind}:${seed}`
  let texture = cache.get(key)
  if (!texture) {
    texture = build(kind, seed)
    cache.set(key, texture)
  }
  return texture
}

/**
 * Boss 的材质与程序贴图。
 *
 * 皮肤：MeshPhysicalMaterial + PBR 表面库的 bossSkin 贴图。clearcoat 是覆在表面的粘液膜，sheen 模拟皮下散射在轮廓处的柔光。
 * 固有色写在顶点色里，材质的 color 只用来做狂暴染色与死亡变暗（由 boss.ts 每帧写入）。
 * 核心：内层发光体（等离子纹理）+ 外层半透明膜（血管纹理，透明度写在贴图的 alpha 里）。
 * 眼睛：极坐标虹膜贴图（横向瞳孔），clearcoat 充当角膜，给出锐利高光。
 *
 * 这里自建的 DataTexture 由 dispose 释放；bossSkin 贴图是表面库的共享实例，不在这里释放，也不改它的 repeat（平铺写在几何体的 UV 里）。
 */

import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
} from 'three'
import type { Texture } from 'three'
import { clamp, lerp, smoothstep } from '../../utils/math'
import { getNoise } from '../../utils/noise'
import { getSurface } from '../textures/pbr'
import { TAU, cellular3 } from './boss-shared'
import type { CellSample } from './boss-shared'

/** 球面贴图尺寸（经纬展开，宽是高的两倍） */
const TEX_W = 256
const TEX_H = 128

export interface BossMaterials {
  /** 身体、眼睑、核心盖子、眼眶 */
  skin: MeshPhysicalMaterial
  /** 触手（与身体分开，受击闪烁各自独立） */
  arm: MeshPhysicalMaterial
  sucker: MeshPhysicalMaterial
  /** 尖刺：角质 */
  spike: MeshPhysicalMaterial
  eye: MeshPhysicalMaterial
  /** 核心周围的一圈肉褶：自发光跟着核心亮度走，像光透进了周围的组织 */
  headRim: MeshPhysicalMaterial
  backRim: MeshPhysicalMaterial
  /** 核心内层发光体 */
  headInner: MeshStandardMaterial
  backInner: MeshStandardMaterial
  /** 核心外层半透明膜 */
  headShell: MeshPhysicalMaterial
  backShell: MeshPhysicalMaterial
  /** 突刺前摇的尖端红光 */
  tipGlow: MeshStandardMaterial
  /** 核心破裂后流出的发光液体 */
  leak: MeshStandardMaterial
  /**
   * 把皮肤颜色图配平成中性色的染色。用了皮肤贴图的材质（skin / arm / headRim / backRim）的 color
   * 都要以它为基准，再乘狂暴染色与明暗
   */
  skinBalance: Color
  /** 释放全部材质与自建贴图 */
  dispose(): void
}

/** 配平后皮肤贴图的平均亮度（线性）：留一点余量，贴图里的亮斑不至于过曝 */
const BALANCE_TARGET = 0.8
/** 配平倍率的上限：贴图很暗时不无限放大 */
const BALANCE_MAX = 8

/** sRGB 字节 → 线性 */
function toLinear(byte: number): number {
  const c = byte / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 贴图的图像能否画到 2D 画布上（用来读像素） */
function isDrawable(image: unknown): image is HTMLCanvasElement | HTMLImageElement | ImageBitmap | OffscreenCanvas {
  if (image instanceof HTMLCanvasElement || image instanceof HTMLImageElement) return true
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) return true
  return typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas
}

/**
 * 量出皮肤颜色图的平均色，算出把它配平成中性色所需的染色，写入 out。
 * 表面库的 bossSkin 约定是“接近中性浅色、可着色”，但库还在升级，过渡期的贴图带明显的固有色；
 * 这里按实际贴图配平，固有色统一由顶点色决定，两种情况下都是同一个结果。
 * 读不到像素（没有 DOM、贴图不是画布等）时保持 out 为白色。
 */
function measureBalance(texture: Texture, out: Color): Color {
  out.setRGB(1, 1, 1)
  if (typeof document === 'undefined') return out
  const image: unknown = texture.image
  if (!isDrawable(image)) return out
  const size = 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return out
  let pixels: Uint8ClampedArray
  try {
    ctx.drawImage(image, 0, 0, size, size)
    pixels = ctx.getImageData(0, 0, size, size).data
  } catch {
    // 画布被污染或图像尚未就绪：不配平
    return out
  }
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < pixels.length; i += 4) {
    r += toLinear(pixels[i] as number)
    g += toLinear(pixels[i + 1] as number)
    b += toLinear(pixels[i + 2] as number)
  }
  const count = pixels.length / 4
  out.setRGB(
    clamp(BALANCE_TARGET / Math.max(r / count, 1e-3), 1, BALANCE_MAX),
    clamp(BALANCE_TARGET / Math.max(g / count, 1e-3), 1, BALANCE_MAX),
    clamp(BALANCE_TARGET / Math.max(b / count, 1e-3), 1, BALANCE_MAX),
  )
  return out
}

/** 把 RGBA 字节数据包成带 mipmap 的 sRGB 贴图：横向循环（经度），纵向夹紧（两极） */
function toTexture(data: Uint8Array<ArrayBuffer>): DataTexture {
  const texture = new DataTexture(data, TEX_W, TEX_H, RGBAFormat, UnsignedByteType)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

/** 边界柔化的“在内部”：d < 0 为内部，在宽度 width 内从 1 过渡到 0 */
function inside(d: number, width: number): number {
  return 1 - smoothstep(d / width + 0.5)
}

interface CoreTextures {
  /** 外膜：橙红色半透明膜体 + 暗红不透明的血管网（alpha = 不透明度） */
  shell: DataTexture
  /** 外膜的透光分布：血管之间亮，血管处暗 */
  shellGlow: DataTexture
  /** 内核：橙红底色上游走着黄白色的炽热细丝 */
  plasma: DataTexture
}

/**
 * 生成核心用的三张球面贴图。血管取自 3D 细胞噪声的格子边界（f2 - f1 趋于 0 的地方），
 * 直接在球面上采样，所以经线接缝与两极都是连续的。
 */
function createCoreTextures(seed: number): CoreTextures {
  const noise = getNoise(seed)
  const cell: CellSample = { f1: 0, f2: 0, id: 0 }
  const shell = new Uint8Array(TEX_W * TEX_H * 4)
  const glow = new Uint8Array(TEX_W * TEX_H * 4)
  const plasma = new Uint8Array(TEX_W * TEX_H * 4)

  for (let j = 0; j < TEX_H; j++) {
    // 与 SphereGeometry 的 UV 约定一致：v = 1 在 +Y 极
    const theta = (1 - (j + 0.5) / TEX_H) * Math.PI
    const st = Math.sin(theta)
    const y = Math.cos(theta)
    for (let i = 0; i < TEX_W; i++) {
      const phi = ((i + 0.5) / TEX_W) * TAU
      const x = -Math.cos(phi) * st
      const z = Math.sin(phi) * st

      // 域扭曲：让血管走向弯曲，不像规整的蜂窝
      const wx = x + 0.16 * noise.noise3D(x * 2.2, y * 2.2, z * 2.2)
      const wy = y + 0.16 * noise.noise3D(x * 2.2 + 19, y * 2.2, z * 2.2)
      const wz = z + 0.16 * noise.noise3D(x * 2.2, y * 2.2 + 37, z * 2.2)
      const cloud = 0.5 + 0.5 * noise.noise3D(x * 3.1, y * 3.1 + 11, z * 3.1)

      // 主血管粗细不均，毛细血管更密更淡
      cellular3(wx * 2.4, wy * 2.4, wz * 2.4, seed, cell)
      const width = Math.max(0.03, 0.11 * (0.7 + 0.5 * noise.noise3D(x * 1.3 + 5, y * 1.3, z * 1.3)))
      const trunk = 1 - smoothstep((cell.f2 - cell.f1) / width)
      cellular3(wx * 5.6 + 3, wy * 5.6, wz * 5.6, seed + 7, cell)
      const capillary = 1 - smoothstep((cell.f2 - cell.f1) / 0.09)
      const vein = Math.max(trunk, 0.55 * capillary)

      const o = (j * TEX_W + i) * 4
      const tissue = 0.8 + 0.2 * cloud
      shell[o] = lerp(215 * tissue, 84, vein)
      shell[o + 1] = lerp(88 * tissue, 10, vein)
      shell[o + 2] = lerp(38 * tissue, 14, vein)
      shell[o + 3] = 255 * lerp(0.42 + 0.14 * cloud, 0.96, vein)

      const through = 255 * (1 - vein) * (1 - vein) * (0.55 + 0.45 * cloud)
      glow[o] = through
      glow[o + 1] = through
      glow[o + 2] = through
      glow[o + 3] = 255

      cellular3(wx * 3.3 + 9, wy * 3.3 + 2, wz * 3.3, seed + 13, cell)
      const filament = 1 - smoothstep((cell.f2 - cell.f1) / 0.22)
      const heat = clamp(0.35 + 0.3 * cloud + 0.55 * filament, 0, 1)
      const level = 0.45 + 0.55 * heat
      plasma[o] = 255 * level
      plasma[o + 1] = lerp(96, 236, heat) * level
      plasma[o + 2] = lerp(20, 170, heat) * level
      plasma[o + 3] = 255
    }
  }
  return { shell: toTexture(shell), shellGlow: toTexture(glow), plasma: toTexture(plasma) }
}

/**
 * 生成章鱼眼的虹膜贴图。贴图是极坐标展开：配套的眼球几何体把球的极点转到 +Z（眼睛朝向），
 * 所以 v = 1 是瞳孔中心，u 绕视轴一圈。瞳孔是两端略宽的横条。
 */
function createIrisTexture(seed: number): DataTexture {
  const noise = getNoise(seed)
  const data = new Uint8Array(TEX_W * TEX_H * 4)
  for (let j = 0; j < TEX_H; j++) {
    // 离视轴的角距
    const rho = (1 - (j + 0.5) / TEX_H) * Math.PI
    const sr = Math.sin(rho)
    const front = rho < Math.PI / 2
    // 正面半球上就是到视轴的距离；越过赤道后继续增大，保持单调
    const r = front ? sr : 2 - sr
    for (let i = 0; i < TEX_W; i++) {
      const a = ((i + 0.5) / TEX_W) * TAU
      // 眼球本地坐标（极点转到 +Z 之后）：x 横向，y 纵向
      const ux = -Math.cos(a)
      const uy = -Math.sin(a)
      const x = ux * sr
      const y = uy * sr

      // 眼球其余部分：章鱼没有明显的眼白，用带斑点的深紫褐色
      const blotch = 0.5 + 0.5 * noise.noise3D(x * 5, y * 5, r * 3)
      let cr = 58 + 30 * blotch
      let cg = 30 + 14 * blotch
      let cb = 44 + 18 * blotch

      // 虹膜：金黄到琥珀色的放射状纤维，外缘一圈深色
      const fiber = 0.5 + 0.5 * noise.noise3D(ux * 7, uy * 7, r * 2.5)
      const fleck = smoothstep((noise.noise3D(x * 14, y * 14, 3.7) - 0.25) / 0.4)
      const rim = lerp(1, 0.22, smoothstep((r - 0.46) / 0.16))
      const iris = inside(r - 0.6, 0.06)
      cr = lerp(cr, lerp(lerp(120, 222, fiber), 70, fleck * 0.6) * rim, iris)
      cg = lerp(cg, lerp(lerp(62, 168, fiber), 34, fleck * 0.6) * rim, iris)
      cb = lerp(cb, lerp(lerp(14, 46, fiber), 10, fleck * 0.6) * rim, iris)

      // 横向瞳孔：两端略宽的哑铃形
      const along = Math.abs(x) / 0.4
      const half = 0.07 * (1 + 0.8 * along * along)
      const pupil = front ? inside(Math.abs(y) - half, 0.03) * inside(Math.abs(x) - 0.4, 0.05) : 0
      const o = (j * TEX_W + i) * 4
      data[o] = lerp(cr, 5, pupil)
      data[o + 1] = lerp(cg, 4, pupil)
      data[o + 2] = lerp(cb, 6, pupil)
      data[o + 3] = 255
    }
  }
  return toTexture(data)
}

/**
 * 创建 Boss 的全部材质。只能在工厂函数里调用（会取 PBR 表面库的贴图）。
 * @param seed 程序贴图的种子
 */
export function createBossMaterials(seed: number): BossMaterials {
  const surface = getSurface('bossSkin')
  const skinBalance = measureBalance(surface.map, new Color())
  const core = createCoreTextures(seed)
  const iris = createIrisTexture(seed + 101)

  /** 湿滑皮肤：粗糙度贴图乘以较低的系数，外面再覆一层带轻微起伏的清漆当粘液 */
  const wetSkin = (): MeshPhysicalMaterial =>
    new MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      map: surface.map,
      normalMap: surface.normalMap,
      normalScale: new Vector2(1.1, 1.1),
      roughnessMap: surface.roughnessMap,
      roughness: 0.45,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.16,
      clearcoatNormalMap: surface.normalMap,
      clearcoatNormalScale: new Vector2(0.35, 0.35),
      sheen: 0.45,
      sheenRoughness: 0.45,
      sheenColor: new Color(0xff9aa8),
      ior: 1.4,
    })

  const innerCore = (): MeshStandardMaterial =>
    new MeshStandardMaterial({
      color: 0x1a0600,
      emissive: 0xffffff,
      emissiveMap: core.plasma,
      emissiveIntensity: 1,
      roughness: 0.55,
    })

  const shellCore = (): MeshPhysicalMaterial =>
    new MeshPhysicalMaterial({
      color: 0xffffff,
      map: core.shell,
      emissive: 0xff6a22,
      emissiveMap: core.shellGlow,
      emissiveIntensity: 1,
      roughness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      transparent: true,
      // 膜在内核外面，不写深度，免得排序出错时把内核挡掉
      depthWrite: false,
    })

  const skin = wetSkin()
  const arm = wetSkin()
  const headRim = wetSkin()
  const backRim = wetSkin()
  const sucker = new MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.38,
    clearcoat: 0.8,
    clearcoatRoughness: 0.2,
    sheen: 0.4,
    sheenRoughness: 0.5,
    sheenColor: new Color(0xffb0b0),
  })
  const spike = new MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.34,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
  })
  const eye = new MeshPhysicalMaterial({
    color: 0xffffff,
    map: iris,
    emissive: 0xffb040,
    emissiveMap: iris,
    emissiveIntensity: 0.12,
    roughness: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    ior: 1.45,
  })
  const tipGlow = new MeshStandardMaterial({
    color: 0x300400,
    emissive: 0xff2408,
    emissiveIntensity: 0,
    roughness: 0.4,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  })
  const leak = new MeshStandardMaterial({
    color: 0x3a1004,
    emissive: 0xffffff,
    emissiveMap: core.plasma,
    emissiveIntensity: 1.6,
    roughness: 0.08,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })

  const headInner = innerCore()
  const backInner = innerCore()
  const headShell = shellCore()
  const backShell = shellCore()

  function dispose(): void {
    skin.dispose()
    arm.dispose()
    headRim.dispose()
    backRim.dispose()
    sucker.dispose()
    spike.dispose()
    eye.dispose()
    headInner.dispose()
    backInner.dispose()
    headShell.dispose()
    backShell.dispose()
    tipGlow.dispose()
    leak.dispose()
    core.shell.dispose()
    core.shellGlow.dispose()
    core.plasma.dispose()
    iris.dispose()
  }

  return {
    skin,
    arm,
    sucker,
    spike,
    eye,
    headRim,
    backRim,
    headInner,
    backInner,
    headShell,
    backShell,
    tipGlow,
    leak,
    skinBalance,
    dispose,
  }
}

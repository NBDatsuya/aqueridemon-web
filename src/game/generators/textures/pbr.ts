/**
 * PBR 表面库：每种表面提供 颜色 / 法线 / 粗糙度 三张程序贴图，并能直接生成 MeshStandardMaterial。
 * 所有模型生成器通过 createSurfaceMaterial 取材质，画质升级只需要改这个文件及同目录的 pbr-*.ts。
 *
 * 管线：表面生成函数（pbr-ground.ts 等）写出高度场、颜色、绝对粗糙度 → pbr-core.ts 的 encodeMaps
 * 由高度场求导得到法线、把微遮蔽烘进颜色 → 这里转成 CanvasTexture 并缓存。
 * 贴图按需懒生成，模块加载时不生成任何贴图，也不访问 document。
 *
 * 迁移中：尚未重做的表面（generate 为 null）暂时沿用过渡实现（借用旧贴图，法线由亮度求梯度）。
 */

import { CanvasTexture, MeshStandardMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, Vector2 } from 'three'
import type { ColorRepresentation, Texture } from 'three'
import type { TextureKind } from '../../core/types'
import { hashSeed } from '../../utils/random'
import { getTexture } from './index'
import { Gen, encodeMaps } from './pbr-core'
import type { SurfaceGenerator } from './pbr-core'
import { asphalt, brick, concrete, dirt, grass, plaster } from './pbr-ground'
import { gunmetal, paintedMetal, polymer, rubber, rust, steel } from './pbr-metal'
import { bark, foliage, planks, wood } from './pbr-organic'
import { bossSkin, skin, zombieSkin } from './pbr-skin'
import { canvas, denim, fabric, hair, leather } from './pbr-soft'

/**
 * 表面种类。标“可着色”的颜色图接近中性浅色，用 options.color 染色；其余自带固有色。
 * - 地面与建筑：grass 草皮、dirt 泥地、asphalt 沥青、concrete 混凝土、brick 红砖、plaster 粉刷墙面（可着色）
 * - 金属：steel 拉丝钢、gunmetal 枪械发黑钢、paintedMetal 喷漆金属（可着色，带磕碰掉漆）、rust 锈蚀铁皮
 * - 合成材料：polymer 哑光工程塑料（可着色）、rubber 橡胶
 * - 木与植物：wood 上漆胡桃木、planks 风化木板、bark 树皮、foliage 叶丛
 * - 织物与皮革：fabric 棉布（可着色）、denim 牛仔布、canvas 军用帆布（可着色）、leather 皮革（可着色）
 * - 生物：skin 人类皮肤（可着色）、zombieSkin 腐烂皮肤、bossSkin 湿滑病变皮肤（可着色）、hair 头发（可着色）
 */
export type SurfaceKind =
  | 'grass'
  | 'dirt'
  | 'asphalt'
  | 'concrete'
  | 'brick'
  | 'plaster'
  | 'steel'
  | 'gunmetal'
  | 'paintedMetal'
  | 'rust'
  | 'polymer'
  | 'rubber'
  | 'wood'
  | 'planks'
  | 'bark'
  | 'foliage'
  | 'fabric'
  | 'denim'
  | 'canvas'
  | 'leather'
  | 'skin'
  | 'zombieSkin'
  | 'bossSkin'
  | 'hair'

/** 一组 PBR 贴图。共享实例：不要释放，也不要改 repeat / offset */
export interface SurfaceMaps {
  /** 颜色图（sRGB） */
  map: Texture
  /** 切线空间法线图（OpenGL 约定，Y 向上） */
  normalMap: Texture
  /** 粗糙度图（读取 G 通道，与 material.roughness 相乘） */
  roughnessMap: Texture
}

export interface SurfaceOptions {
  /** 染色（与颜色图相乘），默认白色 */
  color?: ColorRepresentation
  /** 贴图平铺次数：单个数字或 [u, v]，默认 1 */
  repeat?: number | readonly [number, number]
  /** 贴图变体种子，默认 0 */
  seed?: number
  /** 覆盖该表面的默认粗糙度系数 */
  roughness?: number
  /** 覆盖该表面的默认金属度 */
  metalness?: number
  /** 法线强度倍率，默认 1 */
  normalScale?: number
  /** 自发光颜色，默认无 */
  emissive?: ColorRepresentation
  /** 自发光强度，默认 1 */
  emissiveIntensity?: number
  /** 环境反射强度，默认 1 */
  envMapIntensity?: number
}

interface SurfaceDef {
  /** 贴图边长（像素） */
  size: number
  /**
   * 默认粗糙度系数，同时也是粗糙度贴图的量程：贴图值 = 绝对粗糙度 / roughness，
   * 所以默认材质下 贴图 × 系数 正好还原生成函数写出的绝对粗糙度
   */
  roughness: number
  /** 默认金属度（有金属度贴图时是它的乘数） */
  metalness: number
  /** 法线起伏强度 */
  bump: number
  /** 微遮蔽强度（凹处压暗） */
  cavity: number
  /** 粗糙度贴图的 B 通道是否带金属度（掉漆露铁、锈与钢混合这类表面） */
  metalMap: boolean
  /** 生成函数；null 表示尚未重做，沿用过渡实现 */
  generate: SurfaceGenerator | null
  /** 过渡实现借用的旧贴图种类 */
  legacy: TextureKind
}

const DEFS: Record<SurfaceKind, SurfaceDef> = {
  grass: { size: 1024, roughness: 1, metalness: 0, bump: 5, cavity: 0.5, metalMap: false, generate: grass, legacy: 'grass' },
  dirt: { size: 512, roughness: 1, metalness: 0, bump: 7, cavity: 1.2, metalMap: false, generate: dirt, legacy: 'asphalt' },
  asphalt: { size: 512, roughness: 0.95, metalness: 0, bump: 5, cavity: 1, metalMap: false, generate: asphalt, legacy: 'asphalt' },
  concrete: { size: 512, roughness: 1, metalness: 0, bump: 5, cavity: 1, metalMap: false, generate: concrete, legacy: 'concrete' },
  brick: { size: 512, roughness: 1, metalness: 0, bump: 8, cavity: 0.9, metalMap: false, generate: brick, legacy: 'concrete' },
  plaster: { size: 512, roughness: 1, metalness: 0, bump: 3.5, cavity: 0.5, metalMap: false, generate: plaster, legacy: 'concrete' },
  steel: { size: 512, roughness: 0.5, metalness: 1, bump: 1.2, cavity: 0, metalMap: false, generate: steel, legacy: 'metal' },
  gunmetal: { size: 512, roughness: 0.7, metalness: 0.85, bump: 1.6, cavity: 0.3, metalMap: false, generate: gunmetal, legacy: 'metal' },
  paintedMetal: { size: 512, roughness: 0.6, metalness: 1, bump: 3, cavity: 0.5, metalMap: true, generate: paintedMetal, legacy: 'metal' },
  rust: { size: 512, roughness: 1, metalness: 1, bump: 5, cavity: 0.9, metalMap: true, generate: rust, legacy: 'rust' },
  polymer: { size: 512, roughness: 0.7, metalness: 0, bump: 1.6, cavity: 0.25, metalMap: false, generate: polymer, legacy: 'cloth' },
  rubber: { size: 512, roughness: 1, metalness: 0, bump: 2.5, cavity: 0.6, metalMap: false, generate: rubber, legacy: 'asphalt' },
  wood: { size: 512, roughness: 0.6, metalness: 0, bump: 1.5, cavity: 0.3, metalMap: false, generate: wood, legacy: 'wood' },
  planks: { size: 512, roughness: 1, metalness: 0, bump: 6, cavity: 1, metalMap: false, generate: planks, legacy: 'wood' },
  bark: { size: 512, roughness: 1, metalness: 0, bump: 9, cavity: 1.2, metalMap: false, generate: bark, legacy: 'wood' },
  foliage: { size: 512, roughness: 1, metalness: 0, bump: 6, cavity: 0.8, metalMap: false, generate: foliage, legacy: 'grass' },
  fabric: { size: 512, roughness: 1, metalness: 0, bump: 3, cavity: 0.6, metalMap: false, generate: fabric, legacy: 'cloth' },
  denim: { size: 512, roughness: 1, metalness: 0, bump: 3.5, cavity: 0.6, metalMap: false, generate: denim, legacy: 'cloth' },
  canvas: { size: 512, roughness: 1, metalness: 0, bump: 5, cavity: 0.8, metalMap: false, generate: canvas, legacy: 'cloth' },
  leather: { size: 512, roughness: 0.9, metalness: 0, bump: 3.5, cavity: 0.7, metalMap: false, generate: leather, legacy: 'cloth' },
  skin: { size: 1024, roughness: 0.8, metalness: 0, bump: 2, cavity: 0.4, metalMap: false, generate: skin, legacy: 'cloth' },
  zombieSkin: { size: 512, roughness: 1, metalness: 0, bump: 5, cavity: 0.9, metalMap: false, generate: zombieSkin, legacy: 'skin' },
  bossSkin: { size: 1024, roughness: 0.55, metalness: 0, bump: 5, cavity: 0.8, metalMap: false, generate: bossSkin, legacy: 'skin' },
  hair: { size: 512, roughness: 0.7, metalness: 0, bump: 4, cavity: 0.6, metalMap: false, generate: hair, legacy: 'cloth' },
}

/** 各向异性过滤级别（掠射角下保持清晰） */
const ANISOTROPY = 8

const mapsCache = new Map<string, SurfaceMaps>()
const repeatCache = new Map<string, SurfaceMaps>()

/** 把 RGBA8 像素数据做成可平铺、带 mipmap 的贴图 */
function toTexture(pixels: Uint8ClampedArray, size: number, srgb: boolean): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 2D 画布，PBR 贴图不可用')
  const image = ctx.createImageData(size, size)
  image.data.set(pixels)
  ctx.putImageData(image, 0, 0)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.anisotropy = ANISOTROPY
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

/** 生成一种表面的三张贴图 */
function build(kind: SurfaceKind, seed: number, def: SurfaceDef, generate: SurfaceGenerator): SurfaceMaps {
  const gen = new Gen(def.size, (hashSeed(kind) ^ Math.imul((seed | 0) + 1, 0x9e3779b1)) >>> 0)
  generate(gen)
  const encoded = encodeMaps(gen, {
    bump: def.bump,
    cavity: def.cavity,
    roughScale: def.roughness,
    packMetal: def.metalMap,
  })
  return {
    map: toTexture(encoded.color, encoded.size, true),
    normalMap: toTexture(encoded.normal, encoded.size, false),
    roughnessMap: toTexture(encoded.rough, encoded.size, false),
  }
}

/** 过渡实现：由旧颜色图的亮度生成法线图与粗糙度图（只用于尚未重做的表面） */
function buildLegacy(def: SurfaceDef, seed: number): SurfaceMaps {
  // 加偏移避开 getTexture 的共享实例（别处可能改过它们的 repeat）
  const map = getTexture(def.legacy, 1000 + seed)
  const source = map.image as HTMLCanvasElement
  const size = source.width
  const src = source.getContext('2d')?.getImageData(0, 0, size, size).data
  if (!src) throw new Error('无法读取颜色图，PBR 贴图不可用')

  const count = size * size
  const height = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    height[i] = (src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11) / 255
  }
  const normal = new Uint8ClampedArray(count * 4)
  const rough = new Uint8ClampedArray(count * 4)
  const strength = def.bump * 3
  for (let y = 0; y < size; y++) {
    const up = ((y - 1 + size) % size) * size
    const down = ((y + 1) % size) * size
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const dx = (height[y * size + ((x + 1) % size)] - height[y * size + ((x - 1 + size) % size)]) * strength
      const dy = (height[down + x] - height[up + x]) * strength
      const inv = 1 / Math.hypot(dx, dy, 1)
      normal[i * 4] = (-dx * inv * 0.5 + 0.5) * 255
      normal[i * 4 + 1] = (dy * inv * 0.5 + 0.5) * 255
      normal[i * 4 + 2] = (inv * 0.5 + 0.5) * 255
      normal[i * 4 + 3] = 255
      // 暗处（缝隙、污渍）更粗糙
      const r = Math.min(1, Math.max(0.35, 1.15 - height[i] * 0.4)) * 255
      rough[i * 4] = r
      rough[i * 4 + 1] = r
      rough[i * 4 + 2] = r
      rough[i * 4 + 3] = 255
    }
  }
  return { map, normalMap: toTexture(normal, size, false), roughnessMap: toTexture(rough, size, false) }
}

/**
 * 取得一种表面的 PBR 贴图组。同一 kind + seed 只生成一次。
 * @param kind 表面种类
 * @param seed 变体种子，默认 0
 */
export function getSurface(kind: SurfaceKind, seed = 0): SurfaceMaps {
  const key = `${kind}:${seed}`
  let maps = mapsCache.get(key)
  if (!maps) {
    const def = DEFS[kind]
    maps = def.generate ? build(kind, seed, def, def.generate) : buildLegacy(def, seed)
    mapsCache.set(key, maps)
  }
  return maps
}

/** 取得带平铺次数的贴图组（克隆共享图像，按 kind + seed + repeat 缓存） */
function repeated(kind: SurfaceKind, seed: number, u: number, v: number): SurfaceMaps {
  const base = getSurface(kind, seed)
  if (u === 1 && v === 1) return base
  const key = `${kind}:${seed}:${u}:${v}`
  let maps = repeatCache.get(key)
  if (!maps) {
    const copy = (texture: Texture): Texture => {
      const clone = texture.clone()
      clone.repeat.set(u, v)
      clone.needsUpdate = true
      return clone
    }
    maps = { map: copy(base.map), normalMap: copy(base.normalMap), roughnessMap: copy(base.roughnessMap) }
    repeatCache.set(key, maps)
  }
  return maps
}

/**
 * 创建一个 PBR 材质。每次调用返回新的材质实例（调用方负责 dispose）；贴图是共享的，不随材质释放。
 * @param kind 表面种类
 * @param options 染色、平铺、粗糙度等覆盖项
 */
export function createSurfaceMaterial(kind: SurfaceKind, options: SurfaceOptions = {}): MeshStandardMaterial {
  const def = DEFS[kind]
  const repeat = options.repeat ?? 1
  const u = typeof repeat === 'number' ? repeat : repeat[0]
  const v = typeof repeat === 'number' ? repeat : repeat[1]
  const maps = repeated(kind, options.seed ?? 0, u, v)
  const scale = options.normalScale ?? 1
  const material = new MeshStandardMaterial({
    color: options.color ?? 0xffffff,
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new Vector2(scale, scale),
    roughnessMap: maps.roughnessMap,
    roughness: options.roughness ?? def.roughness,
    metalness: options.metalness ?? def.metalness,
    envMapIntensity: options.envMapIntensity ?? 1,
  })
  // 金属度打包在粗糙度贴图的 B 通道（three 读取 metalnessMap 的 B 通道）
  if (def.metalMap) material.metalnessMap = maps.roughnessMap
  if (options.emissive !== undefined) {
    material.emissive.set(options.emissive)
    material.emissiveIntensity = options.emissiveIntensity ?? 1
  }
  return material
}

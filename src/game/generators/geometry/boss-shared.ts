/**
 * Boss 模型各文件共用的体型常量、调色板与小工具。
 * 模型坐标：原点在地面中心，正面朝 +Z。命中球（boss.ts）与外观（boss-body.ts / boss-tentacles.ts）都以这里的数值为准，
 * 改动前先确认两边仍然对得上。
 */

import { Color, Vector3 } from 'three'
import { BOSS } from '../../core/config'

export const TAU = Math.PI * 2

/* ── 核心与眼睛 ── */

/** 头部核心：正面中央，半嵌在头部表面 */
export const HEAD_CORE_POS = new Vector3(0, 1.55, 1.7)
export const HEAD_CORE_RADIUS = 0.48
/** 背部核心：头顶偏后 */
export const BACK_CORE_POS = new Vector3(0, 2.8, -1)
export const BACK_CORE_RADIUS = 0.45
/** 背部核心的朝向：从正前方转到朝上并略向后仰 */
export const BACK_CORE_TILT = -Math.PI / 2 - 0.3
/** 核心内层发光体的半径（以核心半径为 1） */
export const CORE_INNER_RADIUS = 0.6
/** 身体上为核心挖出的眼窝半径（以核心半径为 1）：外膜是半透明的，后面不能有皮肤穿过去 */
export const CORE_SOCKET_SCALE = 1.08

/** 右眼（+X 一侧）的眼丘中心；左眼按 X 镜像 */
export const EYE_POS = new Vector3(1.4, 1.95, 0.75)
/** 右眼的朝向（单位向量）：朝外、略向前上方 */
export const EYE_DIR = new Vector3(0.82, 0.18, 0.55).normalize()
export const EYE_RADIUS = 0.26
/** 眼球中心沿朝向探出眼丘中心的距离：眼丘半径约 0.36，眼球露出视轴周围约 65° 的球冠，眼睑与眼眶从眼丘里长出来 */
export const EYE_PROTRUDE = 0.17

/* ── 触手 ── */

export const TENTACLES = BOSS.tentacles
/** 名义长度：曲线比它长时按体积守恒变细（突刺、横扫会拉伸） */
export const TENTACLE_LENGTH = BOSS.tentacleLength
/** 根部 / 尖端的名义半径；命中球半径按这两个值沿长度线性插值 */
export const BASE_RADIUS = 0.42
export const TIP_RADIUS = 0.1
/** 触手根部在裙部里的位置 */
export const ATTACH_RADIUS = 1.25
export const ATTACH_Y = 0.75
/** 每条触手中心线的分段数（蒙皮环数 = 分段数 + 1）。必须是 12 的整数倍：命中球取 12 等分点 */
export const ARM_SEGMENTS = 48
export const ARM_POINTS = ARM_SEGMENTS + 1

/** 第 index 条触手的方位角：0 = 正前方（+Z），正值转向 +X */
export function armAzimuth(index: number): number {
  return ((index + 0.5) / TENTACLES) * TAU
}

/* ── 调色板（线性空间）。皮肤的固有色全部写在顶点色里，材质颜色只负责狂暴染色 ── */

export const SKIN_BASE = new Color(0x8e5a8a)
export const SKIN_DARK = new Color(0x4b2c50)
/** 腹面与裙膜下缘的浅色 */
export const SKIN_PALE = new Color(0xc7a3ad)
/** 淤青状的蓝紫斑 */
export const SKIN_BRUISE = new Color(0x5c3d78)
/** 脓疮顶部的黄白色脓头 */
export const PUS_HEAD = new Color(0xe8dc9a)
/** 发炎的红肿组织（脓疮边缘、核心周围） */
export const INFLAMED = new Color(0xa8343c)
/** 坏死腐烂的黑绿色 */
export const NECROSIS = new Color(0x23261a)

/* ── 3D 细胞噪声（Worley）：脓疮、溃烂坑与血管纹路都靠它 ── */

export interface CellSample {
  /** 到最近特征点的距离（单位：格） */
  f1: number
  /** 到第二近特征点的距离；f2 - f1 在格子边界处趋于 0 */
  f2: number
  /** 最近特征点所在格子的随机数 [0, 1) */
  id: number
}

/** 整数格坐标的 32 位哈希 */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/**
 * 在 (x, y, z) 处采样 3D 细胞噪声，结果写入 out 并返回。每个单位格里有一个随机特征点。
 * @param seed 整数种子，不同种子给出互不相关的图案
 */
export function cellular3(x: number, y: number, z: number, seed: number, out: CellSample): CellSample {
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  const cz = Math.floor(z)
  let f1 = 9
  let f2 = 9
  let id = 0
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx
        const iy = cy + dy
        const iz = cz + dz
        const h = hash3(ix, iy, iz, seed)
        const px = ix + (h & 1023) / 1024 - x
        const py = iy + ((h >>> 10) & 1023) / 1024 - y
        const pz = iz + ((h >>> 20) & 1023) / 1024 - z
        const d = Math.sqrt(px * px + py * py + pz * pz)
        if (d < f1) {
          f2 = f1
          f1 = d
          id = hash3(ix, iy, iz, seed + 1) / 4294967296
        } else if (d < f2) {
          f2 = d
        }
      }
    }
  }
  out.f1 = f1
  out.f2 = f2
  out.id = id
  return out
}

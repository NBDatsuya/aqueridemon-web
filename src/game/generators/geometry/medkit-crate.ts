/**
 * 医疗包箱模型：白色聚合物急救箱 + 凸起的蓝色十字（顶面与四个侧面都有），与补给箱、主武器箱一眼可分。
 * 箱子本身是静态的；空投变体带降落伞，update 只驱动伞。
 */

import { DoubleSide, Group, Mesh } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { AirdropAnimInput, AirdropRig, CrateModelOptions } from '../../core/types'
import { createSurfaceMaterial } from '../textures/pbr'
import { MeshBuilder, enableShadows } from './helicopter-airdrop-kit'
import { createParachute } from './parachute'
import type { ParachuteRig } from './parachute'

/* ── 尺寸（米） ── */

/** 箱长（x） */
const LENGTH = 0.62
/** 箱宽（z） */
const WIDTH = 0.42
/** 箱高（y） */
const HEIGHT = 0.4
/** 箱身与箱盖的接缝高度 */
const SEAM_Y = 0.3
/** 侧面十字的中心高度 */
const CROSS_Y = 0.21

/* ── 配色 ── */

const TINT = {
  body: 0xe8e8e3,
  lid: 0xdcdcd6,
  seam: 0x9fa3a6,
  cross: 0x1668c7,
} as const

/** 共享几何体：所有医疗包箱实例复用同一批 BufferGeometry */
interface CrateGeometries {
  body: BufferGeometry
  cross: BufferGeometry
  steel: BufferGeometry
}

let shared: CrateGeometries | null = null

function geometries(): CrateGeometries {
  if (shared) return shared

  const halfX = LENGTH / 2
  const halfZ = WIDTH / 2

  /* ── 白色箱体 ── */

  const body = new MeshBuilder()
  body.uvScale = 2.4
  body.tint(TINT.body)
  body.box(LENGTH, SEAM_Y, WIDTH, 0, SEAM_Y / 2, 0)
  // 接缝唇边与箱盖
  body.tint(TINT.seam)
  body.box(LENGTH + 0.012, 0.022, WIDTH + 0.012, 0, SEAM_Y + 0.011, 0)
  body.tint(TINT.lid)
  body.box(LENGTH - 0.015, HEIGHT - SEAM_Y - 0.022, WIDTH - 0.015, 0, (HEIGHT + SEAM_Y + 0.022) / 2, 0)

  /* ── 蓝色十字：顶面与四个侧面各一个，凸出表面一点 ── */

  const cross = new MeshBuilder()
  cross.uvScale = 3
  cross.tint(TINT.cross)
  // 顶面
  cross.box(0.3, 0.014, 0.1, 0, HEIGHT + 0.006, 0)
  cross.box(0.1, 0.014, 0.3, 0, HEIGHT + 0.006, 0)
  // ±Z 两面
  for (const sz of [-1, 1]) {
    cross.box(0.3, 0.1, 0.014, 0, CROSS_Y, sz * (halfZ + 0.006))
    cross.box(0.1, 0.3, 0.014, 0, CROSS_Y, sz * (halfZ + 0.006))
  }
  // ±X 两面
  for (const sx of [-1, 1]) {
    cross.box(0.014, 0.1, 0.3, sx * (halfX + 0.006), CROSS_Y, 0)
    cross.box(0.014, 0.3, 0.1, sx * (halfX + 0.006), CROSS_Y, 0)
  }

  /* ── 钢件：搭扣与吊环 ── */

  const steel = new MeshBuilder()
  steel.uvScale = 3
  for (const sx of [-1, 1]) steel.box(0.06, 0.09, 0.016, sx * 0.16, SEAM_Y + 0.01, halfZ + 0.006)
  // 顶面四个吊环：空投变体的降落伞吊带挂在这里
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      steel.ring(0.024, 0.005, sx * 0.24, HEIGHT + 0.045 - 0.024, sz * 0.14, 0, Math.atan2(sz, -sx), 0, 6, 12)
    }
  }

  shared = { body: body.build(), cross: cross.build(), steel: steel.build() }
  return shared
}

/**
 * 创建医疗包箱模型。
 * @param options parachute 为 true 时带上降落伞（Boss 战空投）
 * @returns 与空投箱同形的绑定：root 原点在箱底中心；无伞时 update 不做任何事
 */
export function createMedkitCrate(options: CrateModelOptions = {}): AirdropRig {
  const geo = geometries()

  const bodyMat = createSurfaceMaterial('polymer', { roughness: 0.6 })
  const crossMat = createSurfaceMaterial('paintedMetal', { roughness: 0.5 })
  const steelMat = createSurfaceMaterial('steel', { roughness: 0.45 })
  for (const mat of [bodyMat, crossMat, steelMat]) mat.vertexColors = true
  const materials: Material[] = [bodyMat, crossMat, steelMat]

  let chute: ParachuteRig | null = null
  if (options.parachute === true) {
    const webbingMat = createSurfaceMaterial('canvas')
    const canopyMat = createSurfaceMaterial('fabric', { roughness: 0.82 })
    canopyMat.side = DoubleSide
    webbingMat.vertexColors = true
    canopyMat.vertexColors = true
    materials.push(webbingMat, canopyMat)
    chute = createParachute({ attachY: HEIGHT, spreadX: 0.24, spreadZ: 0.14, webbing: webbingMat, canopy: canopyMat })
  }

  const root = new Group()
  root.name = 'medkit-crate'
  const body = new Mesh(geo.body, bodyMat)
  body.name = 'medkit-crate-body'
  enableShadows(body)
  const cross = new Mesh(geo.cross, crossMat)
  cross.name = 'medkit-crate-cross'
  enableShadows(cross)
  const steel = new Mesh(geo.steel, steelMat)
  steel.name = 'medkit-crate-steel'
  enableShadows(steel)
  root.add(body, cross, steel)
  if (chute) root.add(chute.root)

  return {
    root,
    size: LENGTH,

    update(dt: number, anim: AirdropAnimInput) {
      chute?.update(dt, anim)
    },

    dispose() {
      root.removeFromParent()
      for (const mat of materials) mat.dispose()
    },
  }
}

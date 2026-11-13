/**
 * 空投补给箱模型：军用补给箱（加强筋、角件、搭扣、把手、捆扎带、吊环、喷印标识）+ 降落伞（parachute.ts）。
 *
 * 约定：root 原点在箱底中心，外部系统只控制 root 的位置与朝向，这里只动子节点。
 *
 * 结构：箱体的全部静态零件按材质合并成 4 个网格（喷漆铁皮 / 钢件 / 织带 / 贴花），颜色差异靠顶点色。
 * 几何体与贴花图集由所有实例共享（模块级懒创建）；材质每个实例独占，dispose 时释放。
 */

import { DoubleSide, Group, Mesh, MeshStandardMaterial } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { AirdropAnimInput, AirdropRig } from '../../core/types'
import { createSurfaceMaterial } from '../textures/pbr'
import { AIRDROP_DECALS, atlasUv, getAirdropDecalTexture } from './airdrop-decals'
import type { AtlasRect } from './airdrop-decals'
import { MeshBuilder, enableShadows } from './helicopter-airdrop-kit'
import { createParachute } from './parachute'

/* ── 箱体尺寸（米） ── */

/** 箱体约略边长 */
const SIZE = 1.1
/** 箱板表面到中心的距离 */
const PANEL = 0.52
/** 边框（包边、角柱）表面到中心的距离：比箱板凸出 1.5cm */
const FRAME = 0.535
/** 底部滑橇高度，箱身从这里开始 */
const SKID_HEIGHT = 0.07
/** 箱身上沿 / 箱盖下沿 / 箱盖顶面 */
const BODY_TOP = 0.84
const LID_BOTTOM = 0.86
const LID_TOP = 1.06
/** 箱盖顶板（略高出盖沿）的顶面高度 */
const DECK = 1.072
/** 捆扎带：两道，绕过顶面、±X 两侧与箱底 */
const STRAP_Z = 0.3
const STRAP_WIDTH = 0.05
/** 顶面四个吊环到中心线的距离，以及吊带在吊环上的连接高度（相对 SIZE） */
const RING_OFFSET = 0.36
const RING_TOP = 0.045

/* ── 颜色（顶点色，sRGB） ── */

const COLOR = {
  body: 0x5c6b3a,
  frame: 0x4f5d32,
  lid: 0x596838,
  gasket: 0x14160f,
  skid: 0x55585b,
  steel: 0xb4b8bc,
  zinc: 0xcfd0cc,
  strap: 0x9a8a5c,
  grip: 0x4a4234,
} as const

/* ── 共享几何体（模块级懒创建，永不释放） ── */

interface SharedGeometries {
  /** 箱体：喷漆铁皮 */
  paint: BufferGeometry
  /** 箱体：钢件（角件、搭扣、把手、棘轮扣、吊环、滑橇） */
  steel: BufferGeometry
  /** 箱体：捆扎带与把手缠带 */
  strap: BufferGeometry
  /** 箱体：喷印标识与污渍贴花 */
  decal: BufferGeometry
}

let shared: SharedGeometries | null = null

/** 在朝外法线为 (nx, 0, nz) 的侧面上，把“面向箱子时的左右坐标”换算成世界 x / z */
function onFace(nx: number, nz: number, distance: number, right: number): [number, number] {
  // 面向该侧面时，右手方向为 (nz, 0, -nx)
  return [nx * distance + nz * right, nz * distance - nx * right]
}

/** 在侧面上贴一块贴花：right0..right1 为左右范围，y0..y1 为高度范围 */
function faceDecal(
  b: MeshBuilder,
  nx: number,
  nz: number,
  distance: number,
  right0: number,
  right1: number,
  y0: number,
  y1: number,
  rect: AtlasRect,
): void {
  const [x0, z0] = onFace(nx, nz, distance, right0)
  const [x1, z1] = onFace(nx, nz, distance, right1)
  b.patch([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0], atlasUv(rect))
}

/** 铆钉头：从表面点沿法线鼓起的六棱台 */
function rivet(b: MeshBuilder, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
  const h = 0.005
  b.rod([x - nx * 0.001, y - ny * 0.001, z - nz * 0.001], [x + nx * h, y + ny * h, z + nz * h], 0.009, 0.0055, 6)
}

/** 箱体的四组静态几何体 */
function buildCrate(): Pick<SharedGeometries, 'paint' | 'steel' | 'strap' | 'decal'> {
  const paint = new MeshBuilder()
  const steel = new MeshBuilder()
  const strap = new MeshBuilder()
  const decal = new MeshBuilder()
  paint.uvScale = 1.2
  steel.uvScale = 3
  strap.uvScale = 6

  const bodyHeight = BODY_TOP - SKID_HEIGHT

  /* ── 箱身与箱盖（喷漆铁皮） ── */

  paint.tint(COLOR.body)
  paint.box(PANEL * 2, bodyHeight, PANEL * 2, 0, SKID_HEIGHT + bodyHeight / 2, 0)
  // 上下两道包边与四根角柱：箱板因此成为内凹的镶板
  paint.tint(COLOR.frame)
  paint.box(FRAME * 2, 0.07, FRAME * 2, 0, SKID_HEIGHT + 0.035, 0)
  paint.box(FRAME * 2, 0.06, FRAME * 2, 0, BODY_TOP - 0.03, 0)
  const postCenter = FRAME - 0.0375
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) paint.box(0.075, 0.64, 0.075, sx * postCenter, 0.46, sz * postCenter)
  }
  // ±X 两面的竖向加强筋（把手两侧）
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) paint.box(0.022, 0.64, 0.05, sx * PANEL, 0.46, sz * 0.15)
  }
  // ±Z 两面（标签面）靠近角柱处的短加强筋
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) paint.box(0.04, 0.64, 0.016, sx * 0.475, 0.46, sz * PANEL)
  }
  // 箱盖与箱身之间的密封条
  paint.tint(COLOR.gasket)
  paint.box(PANEL * 2 - 0.01, LID_BOTTOM - BODY_TOP + 0.004, PANEL * 2 - 0.01, 0, (BODY_TOP + LID_BOTTOM) / 2, 0)
  // 箱盖：盖体 + 下沿外翻边 + 顶板
  paint.tint(COLOR.lid)
  paint.box(1.06, LID_TOP - LID_BOTTOM, 1.06, 0, (LID_TOP + LID_BOTTOM) / 2, 0)
  paint.box(0.96, DECK - LID_TOP + 0.004, 0.96, 0, (DECK + LID_TOP) / 2 - 0.002, 0)
  paint.tint(COLOR.frame)
  paint.box(1.075, 0.035, 1.075, 0, LID_BOTTOM + 0.0175, 0)

  /* ── 钢件 ── */

  // 底部两条滑橇
  steel.tint(COLOR.skid)
  for (const sx of [-1, 1]) steel.box(0.11, SKID_HEIGHT, 1.06, sx * 0.34, SKID_HEIGHT / 2, 0)

  // 八个角件 + 铆钉
  const capCenter = 0.49
  const capHalf = 0.055
  const capFace = capCenter + capHalf
  for (const top of [false, true]) {
    const cy = top ? DECK - capHalf + 0.0005 : SKID_HEIGHT + capHalf
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * capCenter
        const cz = sz * capCenter
        steel.tint(COLOR.zinc)
        steel.box(capHalf * 2, capHalf * 2, capHalf * 2, cx, cy, cz)
        steel.tint(COLOR.steel)
        for (const d of [-0.028, 0.028]) {
          rivet(steel, sx * capFace, cy + d, cz + d, sx, 0, 0)
          rivet(steel, cx + d, cy + d, sz * capFace, 0, 0, sz)
          if (top) rivet(steel, cx + d, cy + capHalf, cz + d, 0, 1, 0)
        }
      }
    }
  }

  // ±Z 两面的搭扣：底板（箱身包边上）+ 扣座（箱盖翻边上）+ 扳手 + 两根销轴
  for (const sz of [-1, 1]) {
    for (const x of [-0.3, 0.3]) {
      steel.tint(COLOR.steel)
      steel.box(0.07, 0.085, 0.006, x, 0.795, sz * (FRAME + 0.003))
      steel.box(0.07, 0.04, 0.008, x, 0.9, sz * (0.5375 + 0.004))
      steel.tint(COLOR.zinc)
      steel.box(0.036, 0.13, 0.009, x, 0.832, sz * 0.5505, sz * -0.05)
      steel.tint(COLOR.steel)
      steel.rod([x - 0.03, 0.772, sz * 0.546], [x + 0.03, 0.772, sz * 0.546], 0.006, 0.006, 6)
      steel.rod([x - 0.026, 0.905, sz * 0.549], [x + 0.026, 0.905, sz * 0.549], 0.005, 0.005, 6)
    }
    // 标签面右下角的铭牌
    const [px, pz] = onFace(0, sz, PANEL + 0.002, 0.375)
    steel.tint(COLOR.zinc)
    steel.box(0.12, 0.075, 0.004, px, 0.235, pz)
    steel.tint(COLOR.steel)
    for (const dx of [-0.05, 0.05]) {
      for (const dy of [-0.027, 0.027]) rivet(steel, px + dx, 0.235 + dy, pz + sz * 0.002, 0, 0, sz)
    }
  }

  // ±X 两面的折叠把手：两个支座 + 弯成 U 形的钢筋 + 缠布握把
  for (const sx of [-1, 1]) {
    steel.tint(COLOR.steel)
    for (const sz of [-1, 1]) steel.box(0.022, 0.044, 0.036, sx * (PANEL + 0.011), 0.668, sz * 0.11)
    steel.tube(
      [
        [sx * 0.535, 0.668, -0.11],
        [sx * 0.552, 0.62, -0.11],
        [sx * 0.562, 0.588, -0.105],
        [sx * 0.564, 0.575, -0.088],
        [sx * 0.564, 0.575, 0.088],
        [sx * 0.562, 0.588, 0.105],
        [sx * 0.552, 0.62, 0.11],
        [sx * 0.535, 0.668, 0.11],
      ],
      0.007,
      6,
    )
    strap.tint(COLOR.grip)
    strap.rod([sx * 0.564, 0.575, -0.07], [sx * 0.564, 0.575, 0.07], 0.012, 0.012, 8)
  }

  /* ── 捆扎带（织带）+ 棘轮扣 ── */

  const strapTop = DECK + 0.004
  const strapSide = 0.544
  const strapBottom = SKID_HEIGHT - 0.004
  for (const sz of [-1, 1]) {
    const z = sz * STRAP_Z
    strap.tint(COLOR.strap)
    strap.box(strapSide * 2 + 0.004, 0.004, STRAP_WIDTH, 0, strapTop, z)
    strap.box(strapSide * 2 + 0.004, 0.004, STRAP_WIDTH, 0, strapBottom, z)
    for (const sx of [-1, 1]) strap.box(0.004, strapTop - strapBottom, STRAP_WIDTH, sx * strapSide, (strapTop + strapBottom) / 2, z)
    // 穿过棘轮扣后多出来的一截带尾
    strap.box(0.13, 0.004, STRAP_WIDTH * 0.92, 0.33, strapTop + 0.005, z + sz * 0.004, 0, 0.05 * sz, 0)

    steel.tint(COLOR.steel)
    steel.box(0.085, 0.01, 0.064, 0.18, strapTop + 0.007, z)
    for (const side of [-1, 1]) steel.box(0.085, 0.03, 0.004, 0.18, strapTop + 0.02, z + side * 0.032)
    steel.rod([0.2, strapTop + 0.022, z - 0.034], [0.2, strapTop + 0.022, z + 0.034], 0.008, 0.008, 8)
    steel.tint(COLOR.zinc)
    steel.box(0.1, 0.006, 0.05, 0.145, strapTop + 0.038, z, 0, 0, 0.2)
  }

  // 顶面四个吊环：底座 + 立起的 D 形环，环面朝向箱顶中心
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * RING_OFFSET
      const z = sz * RING_OFFSET
      const yaw = Math.atan2(sz, -sx)
      steel.tint(COLOR.steel)
      steel.box(0.09, 0.01, 0.06, x, DECK + 0.005, z, 0, yaw, 0)
      steel.tint(COLOR.zinc)
      steel.ring(0.036, 0.007, x, SIZE + RING_TOP - 0.036, z, 0, yaw, 0, 6, 14)
    }
  }

  /* ── 贴花 ── */

  const skin = PANEL + 0.0015
  for (const sz of [-1, 1]) {
    faceDecal(decal, 0, sz, skin, -0.45, 0.45, 0.17, 0.73, AIRDROP_DECALS.label)
    faceDecal(decal, 0, sz, skin + 0.001, -0.48, 0.48, 0.14, 0.46, AIRDROP_DECALS.wearA)
  }
  for (const sx of [-1, 1]) {
    faceDecal(decal, sx, 0, skin, -0.12, 0.12, 0.2, 0.5, AIRDROP_DECALS.side)
    faceDecal(decal, sx, 0, skin + 0.001, -0.48, 0.48, 0.14, 0.46, AIRDROP_DECALS.wearB)
  }
  // 顶盖编号：两道捆扎带之间
  const topY = DECK + 0.0015
  decal.patch([-0.2, topY, 0.2], [0.2, topY, 0.2], [0.2, topY, -0.2], [-0.2, topY, -0.2], atlasUv(AIRDROP_DECALS.top))

  return { paint: paint.build(), steel: steel.build(), strap: strap.build(), decal: decal.build() }
}

function geometries(): SharedGeometries {
  if (!shared) shared = buildCrate()
  return shared
}

/**
 * 创建空投箱模型（军用补给箱 + 降落伞）。
 * @returns 空投绑定：root 原点在箱底中心；update 按 parachute 开合伞衣，landed 后伞衣塌落并隐藏
 */
export function createAirdrop(): AirdropRig {
  const geo = geometries()

  /* ── 材质（本实例独占；颜色由顶点色提供） ── */

  const paintMat = createSurfaceMaterial('paintedMetal')
  const steelMat = createSurfaceMaterial('steel', { roughness: 0.5 })
  const webbingMat = createSurfaceMaterial('canvas')
  const canopyMat = createSurfaceMaterial('fabric', { roughness: 0.82 })
  canopyMat.side = DoubleSide
  const decalMat = new MeshStandardMaterial({
    map: getAirdropDecalTexture(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    roughness: 0.88,
    metalness: 0,
  })
  for (const mat of [paintMat, steelMat, webbingMat, canopyMat]) mat.vertexColors = true
  const materials: Material[] = [paintMat, steelMat, webbingMat, canopyMat, decalMat]

  const root = new Group()
  root.name = 'airdrop'

  /** 建一个网格并挂到 parent 下 */
  const addMesh = (parent: Group, geometry: BufferGeometry, material: Material, castShadow = true): Mesh => {
    const mesh = new Mesh(geometry, material)
    enableShadows(mesh, castShadow)
    parent.add(mesh)
    return mesh
  }

  /* ── 箱体 ── */

  const crate = new Group()
  crate.name = 'airdrop-crate'
  root.add(crate)
  addMesh(crate, geo.paint, paintMat)
  addMesh(crate, geo.steel, steelMat)
  addMesh(crate, geo.strap, webbingMat)
  addMesh(crate, geo.decal, decalMat, false)

  /* ── 降落伞 ── */

  const chute = createParachute({ attachY: SIZE, webbing: webbingMat, canopy: canopyMat })
  root.add(chute.root)

  return {
    root,
    size: SIZE,

    update(dt, anim: AirdropAnimInput) {
      chute.update(dt, anim)
    },

    dispose() {
      root.removeFromParent()
      for (const mat of materials) mat.dispose()
    },
  }
}

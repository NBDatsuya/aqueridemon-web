/**
 * 空投箱模型：军用补给箱（加强筋、角件、搭扣、把手、捆扎带、吊环、喷印标识）+ 分瓣的圆形降落伞。
 *
 * 约定：root 原点在箱底中心，外部系统只控制 root 的位置与朝向，这里只动子节点。
 *
 * 结构：
 * - 箱体的全部静态零件按材质合并成 4 个网格（喷漆铁皮 / 钢件 / 织带 / 贴花），颜色差异靠顶点色。
 * - 降落伞：吊带、伞绳、伞衣各一个网格。伞衣与伞绳建在“归一化空间”（伞缘半径 1、伞高 1），
 *   靠节点的非等比缩放开合，每帧不必重算顶点。
 * 几何体与贴花图集由所有实例共享（模块级懒创建）；材质每个实例独占，dispose 时释放。
 */

import { DoubleSide, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { AirdropAnimInput, AirdropRig } from '../../core/types'
import { clamp, damp, lerp, smoothstep } from '../../utils/math'
import { createSurfaceMaterial } from '../textures/pbr'
import { AIRDROP_DECALS, atlasUv, getAirdropDecalTexture } from './airdrop-decals'
import type { AtlasRect } from './airdrop-decals'
import { MeshBuilder, enableShadows } from './helicopter-airdrop-kit'

const TAU = Math.PI * 2

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

/* ── 降落伞 ── */

/** 伞绳汇聚点高出箱顶（SIZE）的距离 */
const CONFLUENCE = 0.45
/** 伞衣幅数（每条接缝下接一根伞绳） */
const GORES = 16
/** 每幅内的横向采样位置 0..1：两端靠近接缝处加一列，让接缝的深色边足够细 */
const GORE_COLUMNS = [0, 0.035, 0.25, 0.5, 0.75, 0.965, 1] as const
/** 从顶孔到伞缘的纵向采样位置 0..1（0.06 处是顶孔边缘） */
const CANOPY_ROWS = [0.06, 0.14, 0.24, 0.36, 0.48, 0.6, 0.72, 0.82, 0.9, 0.96, 1] as const
/** 伞缘处的母线夹角：略大于 90°，伞缘向内收一点 */
const SKIRT_ANGLE = (Math.PI / 2) * 1.08
/** 伞绳粗细（归一化空间的半径，乘以伞衣半径后约 1cm） */
const CORD_RADIUS = 0.004

/** 未开伞：收成细长的一束 */
const CLOSED = { radius: 0.28, cord: 3.8, dome: 2.2 } as const
/** 完全张开 */
const OPEN = { radius: 2.3, cord: 3, dome: 1.3 } as const
/** 落地后塌在箱子一侧的地面上：tilt 为伞绳方向相对竖直的倾角 */
const FALLEN = { cord: 2.6, dome: 0.12, tilt: 2, shrink: 0.15, cordRadius: 0.05 } as const

/** 开伞程度的趋近速率（1/秒） */
const OPEN_RATE = 5
/** 落地后：塌落用时、摊在地上的停留时间、收缩消失用时（秒） */
const COLLAPSE_TIME = 1.2
const REST_TIME = 1
const SHRINK_TIME = 0.6
/** 缩放下限，避免出现不可逆的矩阵 */
const MIN_SCALE = 0.001

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
  riser: 0x8c8158,
  link: 0x3a3c3e,
  cord: 0xd6d0ba,
  orange: 0xd9622b,
  orangeHem: 0xb5501f,
  orangeSeam: 0x74340f,
  white: 0xe8e2cf,
  whiteHem: 0xc2bca6,
  whiteSeam: 0x8a8576,
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
  /** 吊带（本地原点在箱顶中心） */
  risers: BufferGeometry
  /** 伞绳（归一化空间：从原点连到半径 1、高 1 的伞缘） */
  cords: BufferGeometry
  /** 伞衣（归一化空间：伞缘接缝处半径 1、y = 0，伞顶 y ≈ 1） */
  canopy: BufferGeometry
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

/** 吊带：四个吊环 → 汇聚点，汇聚点处一个连接环。本地原点在箱顶中心（y = SIZE） */
function buildRisers(): BufferGeometry {
  const b = new MeshBuilder()
  b.uvScale = 6
  b.tint(COLOR.riser)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.beam([sx * RING_OFFSET, RING_TOP, sz * RING_OFFSET], [sx * 0.012, CONFLUENCE, sz * 0.012], 0.034, 0.005, [sx, 1.2, sz])
    }
  }
  b.tint(COLOR.link)
  b.ring(0.034, 0.008, 0, CONFLUENCE, 0, Math.PI / 2, 0, 0, 6, 12)
  return b.build()
}

/** 伞绳：归一化空间里从原点连到各条接缝在伞缘上的端点 */
function buildCords(): BufferGeometry {
  const b = new MeshBuilder()
  b.uvScale = 4
  b.tint(COLOR.cord)
  for (let i = 0; i < GORES; i++) {
    const angle = (i / GORES) * TAU
    b.rod([0, 0, 0], [Math.cos(angle), 1, Math.sin(angle)], CORD_RADIUS, CORD_RADIUS, 4, false)
  }
  return b.build()
}

/**
 * 伞衣曲面上的一点（归一化空间）。
 * @param t 纵向位置：0 伞顶，1 伞缘
 * @param gore 第几幅
 * @param g 幅内横向位置 0..1（0 / 1 为接缝）
 */
function canopyPoint(t: number, gore: number, g: number, out: Vector3): Vector3 {
  const a = t * SKIRT_ANGLE
  const across = Math.max(0, Math.sin(Math.PI * g))
  // 相邻两根伞绳之间的伞布被气流鼓起，越靠近伞缘鼓得越明显
  const bulge = 1 + 0.075 * Math.pow(Math.sin(a), 1.5) * Math.pow(across, 0.8)
  const radius = (Math.sin(a) / Math.sin(SKIRT_ANGLE)) * bulge
  // 伞缘在两根伞绳之间向上拱起，形成扇贝边
  const lift = 0.05 * smoothstep((t - 0.7) / 0.3) * across
  const y = (Math.cos(a) - Math.cos(SKIRT_ANGLE)) / (1 - Math.cos(SKIRT_ANGLE)) + lift
  const phi = ((gore + g) / GORES) * TAU
  return out.set(Math.cos(phi) * radius, y, Math.sin(phi) * radius)
}

/** 伞衣：逐幅生成，橙白相间；接缝、顶孔边与伞缘加强带用较深的顶点色 */
function buildCanopy(): BufferGeometry {
  const b = new MeshBuilder()
  const p = new Vector3()
  const p0 = new Vector3()
  const p1 = new Vector3()
  const du = new Vector3()
  const dv = new Vector3()
  const n = new Vector3()
  const eps = 0.004
  const columns = GORE_COLUMNS.length
  const lastRow = CANOPY_ROWS.length - 1
  // UV 按张开时的实际尺寸折算，约每 0.7m 一个贴图周期
  const density = 1.5

  for (let gore = 0; gore < GORES; gore++) {
    const orange = gore % 2 === 0
    const base = orange ? COLOR.orange : COLOR.white
    const hem = orange ? COLOR.orangeHem : COLOR.whiteHem
    const seam = orange ? COLOR.orangeSeam : COLOR.whiteSeam
    const ids: number[] = []

    for (let row = 0; row <= lastRow; row++) {
      const t = CANOPY_ROWS[row]
      for (let col = 0; col < columns; col++) {
        const g = GORE_COLUMNS[col]
        canopyPoint(t, gore, g, p)
        // 法线：幅内单侧差分，接缝处因此留下一道折痕
        canopyPoint(t, gore, Math.max(0, g - eps), p0)
        canopyPoint(t, gore, Math.min(1, g + eps), p1)
        du.subVectors(p1, p0)
        canopyPoint(Math.max(0.01, t - eps), gore, g, p0)
        canopyPoint(Math.min(1, t + eps), gore, g, p1)
        dv.subVectors(p1, p0)
        n.crossVectors(du, dv).normalize()
        if (n.x * p.x + n.y * 0.4 + n.z * p.z < 0) n.negate()

        const edge = col === 0 || col === columns - 1
        const band = row === 0 || row >= lastRow - 1
        b.tint(edge ? seam : band ? hem : base)
        const phi = ((gore + g) / GORES) * TAU
        ids.push(b.vertex(p.x, p.y, p.z, n.x, n.y, n.z, phi * OPEN.radius * density, t * 3.6 * density))
      }
    }

    for (let row = 0; row < lastRow; row++) {
      for (let col = 0; col < columns - 1; col++) {
        const a = ids[row * columns + col]
        const c = ids[(row + 1) * columns + col + 1]
        b.quad(a, ids[row * columns + col + 1], c, ids[(row + 1) * columns + col])
      }
    }
  }
  return b.build()
}

function geometries(): SharedGeometries {
  if (!shared) {
    shared = { ...buildCrate(), risers: buildRisers(), cords: buildCords(), canopy: buildCanopy() }
  }
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

  const chute = new Group()
  chute.name = 'airdrop-parachute'
  root.add(chute)

  // 吊带：箱顶四个吊环 → 汇聚点。塌落时靠 scale.y 压平
  const risers = new Group()
  risers.position.y = SIZE
  chute.add(risers)
  addMesh(risers, geo.risers, webbingMat)

  // 摆动节点：原点在汇聚点，伞绳与伞衣都挂在它下面
  const sway = new Group()
  sway.position.y = SIZE + CONFLUENCE
  chute.add(sway)

  // 伞绳：整体缩放为（伞衣半径, 伞绳高度, 伞衣半径）
  const cords = new Group()
  sway.add(cords)
  addMesh(cords, geo.cords, webbingMat)

  const canopy = new Group()
  sway.add(canopy)
  addMesh(canopy, geo.canopy, canopyMat)

  /* ── 动画状态 ── */

  let time = 0
  /** 平滑后的张开程度 0..1；落地后冻结 */
  let open = 0
  /** 落地后经过的秒数 */
  let landedTime = 0
  let hidden = false

  /** 按当前状态摆放伞衣、伞绳与吊带 */
  const pose = (): void => {
    // fall：塌落进度；keep：最后收缩消失时从 1 降到 0
    const fall = smoothstep(landedTime / COLLAPSE_TIME)
    const keep = Math.max(MIN_SCALE, 1 - smoothstep((landedTime - COLLAPSE_TIME - REST_TIME) / SHRINK_TIME))
    // 伞衣鼓起时才有呼吸与摆动
    const live = open * (1 - fall)

    const radius = lerp(CLOSED.radius, OPEN.radius, open) * (1 + Math.sin(time * 2.6) * 0.035 * live)
    const cordHeight = lerp(lerp(CLOSED.cord, OPEN.cord, open), FALLEN.cord, fall)
    const dome = lerp(lerp(CLOSED.dome, OPEN.dome, open), FALLEN.dome, fall)
    const tilt = lerp(Math.sin(time * 1.1) * 0.07 * live, FALLEN.tilt, fall)

    const slack = lerp(1, 0.05, fall)
    risers.scale.y = slack
    sway.position.y = SIZE + CONFLUENCE * slack
    sway.rotation.set(Math.cos(time * 0.83) * 0.05 * live, 0, tilt)

    // 伞衣沿倒下的伞绳摇到地面，同时反向转回水平并压扁
    const canopyRadius = radius * (1 - FALLEN.shrink * fall) * keep
    canopy.position.y = cordHeight
    canopy.rotation.z = -tilt * fall
    canopy.scale.set(canopyRadius, dome * keep, canopyRadius)

    // 伞绳随塌落收拢成一束，指向伞衣中心
    const cordRadius = lerp(radius, FALLEN.cordRadius, fall) * keep
    cords.scale.set(cordRadius, cordHeight, cordRadius)
  }

  pose()

  return {
    root,
    size: SIZE,

    update(dt, anim: AirdropAnimInput) {
      if (anim.landed) {
        if (hidden) return
        landedTime += dt
        if (landedTime >= COLLAPSE_TIME + REST_TIME + SHRINK_TIME) {
          hidden = true
          chute.visible = false
          return
        }
      } else {
        // 重新进入下落状态（对象复用）时恢复降落伞
        if (landedTime > 0) {
          landedTime = 0
          hidden = false
          chute.visible = true
        }
        open = damp(open, clamp(anim.parachute, 0, 1), OPEN_RATE, dt)
      }
      time += dt
      pose()
    },

    dispose() {
      root.removeFromParent()
      for (const mat of materials) mat.dispose()
    },
  }
}

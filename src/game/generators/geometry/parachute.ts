/**
 * 空投降落伞：吊带、伞绳、伞衣。伞衣与伞绳建在“归一化空间”（伞缘半径 1、伞高 1），
 * 靠节点的非等比缩放开合，每帧不必重算顶点；落地后塌在箱子一侧，停留片刻再收缩隐藏。
 *
 * 几何体按吊点间距缓存共享；材质由调用方传入并负责释放。
 * 空投补给箱、主武器箱、医疗包箱都用它演出带伞下落。
 */

import { Group, Mesh, Vector3 } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { AirdropAnimInput } from '../../core/types'
import { clamp, damp, lerp, smoothstep } from '../../utils/math'
import { MeshBuilder, enableShadows } from './helicopter-airdrop-kit'

const TAU = Math.PI * 2

/* ── 伞形参数 ── */

/** 伞绳汇聚点高出箱顶的距离（米） */
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

/* ── 共享几何体 ── */

interface SharedGeometries {
  /** 伞绳（归一化空间：从原点连到半径 1、高 1 的伞缘） */
  cords: BufferGeometry
  /** 伞衣（归一化空间：伞缘接缝处半径 1、y = 0，伞顶 y ≈ 1） */
  canopy: BufferGeometry
}

let shared: SharedGeometries | null = null

/** 吊带几何体按吊点间距缓存：不同箱型的顶面吊点位置不一样 */
const riserCache = new Map<string, BufferGeometry>()

/** 吊带：四个吊点 → 汇聚点，汇聚点处一个连接环。本地原点在箱顶中心 */
function buildRisers(spreadX: number, spreadZ: number, ringTop: number): BufferGeometry {
  const key = `${spreadX}|${spreadZ}|${ringTop}`
  const cached = riserCache.get(key)
  if (cached) return cached
  const b = new MeshBuilder()
  b.uvScale = 6
  b.tint(COLOR.riser)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.beam([sx * spreadX, ringTop, sz * spreadZ], [sx * 0.012, CONFLUENCE, sz * 0.012], 0.034, 0.005, [sx, 1.2, sz])
    }
  }
  b.tint(COLOR.link)
  b.ring(0.034, 0.008, 0, CONFLUENCE, 0, Math.PI / 2, 0, 0, 6, 12)
  const geometry = b.build()
  riserCache.set(key, geometry)
  return geometry
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
  if (!shared) shared = { cords: buildCords(), canopy: buildCanopy() }
  return shared
}

export interface ParachuteOptions {
  /** 箱顶吊点高度（米，相对箱子 root 原点） */
  attachY: number
  /** 顶面四个吊点到中心线的水平距离，默认 0.36 */
  spreadX?: number
  spreadZ?: number
  /** 吊环高出箱顶的距离（米），默认 0.045 */
  ringTop?: number
  /** 织带材质（吊带与伞绳共用） */
  webbing: Material
  /** 伞衣材质 */
  canopy: Material
}

export interface ParachuteRig {
  readonly root: Group
  /** 按 parachute 开合伞衣；landed 后塌落并隐藏 */
  update(dt: number, anim: AirdropAnimInput): void
}

/**
 * 创建降落伞（吊带 + 伞绳 + 伞衣）。
 * @param options 吊点位置与材质
 * @returns 降落伞绑定：root 原点应放在箱顶中心高度
 */
export function createParachute(options: ParachuteOptions): ParachuteRig {
  const geo = geometries()
  const attachY = options.attachY
  const spreadX = options.spreadX ?? 0.36
  const spreadZ = options.spreadZ ?? 0.36
  const ringTop = options.ringTop ?? 0.045

  const root = new Group()
  root.name = 'parachute'

  const risers = new Group()
  risers.position.y = attachY
  root.add(risers)
  const riserMesh = new Mesh(buildRisers(spreadX, spreadZ, ringTop), options.webbing)
  riserMesh.name = 'parachute-risers'
  enableShadows(riserMesh)
  risers.add(riserMesh)

  // 摆动节点：原点在汇聚点，伞绳与伞衣都挂在它下面
  const sway = new Group()
  sway.position.y = attachY + CONFLUENCE
  root.add(sway)

  // 伞绳：整体缩放为（伞衣半径, 伞绳高度, 伞衣半径）
  const cords = new Group()
  sway.add(cords)
  const cordMesh = new Mesh(geo.cords, options.webbing)
  cordMesh.name = 'parachute-cords'
  enableShadows(cordMesh)
  cords.add(cordMesh)

  const canopy = new Group()
  sway.add(canopy)
  const canopyMesh = new Mesh(geo.canopy, options.canopy)
  canopyMesh.name = 'parachute-canopy'
  enableShadows(canopyMesh)
  canopy.add(canopyMesh)

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
    sway.position.y = attachY + CONFLUENCE * slack
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

    update(dt, anim: AirdropAnimInput) {
      if (anim.landed) {
        if (hidden) return
        landedTime += dt
        if (landedTime >= COLLAPSE_TIME + REST_TIME + SHRINK_TIME) {
          hidden = true
          root.visible = false
          return
        }
      } else {
        // 重新进入下落状态（对象复用）时恢复降落伞
        if (landedTime > 0) {
          landedTime = 0
          hidden = false
          root.visible = true
        }
        open = damp(open, clamp(anim.parachute, 0, 1), OPEN_RATE, dt)
      }
      time += dt
      pose()
    },
  }
}

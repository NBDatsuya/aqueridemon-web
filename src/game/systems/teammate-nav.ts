/**
 * AI 队友的场地查询：避障探测与战术站位点。
 *
 * 只读 world.colliders（静态碰撞体），阻挡规则与 world.resolveMove 一致：
 * 已在顶面之上、或能直接踏上去的可站立面不阻挡。看台台阶逐级可上，按不阻挡处理。
 * 每次查询只做简单的盒子求交，不分配对象。
 */

import { BLEACHERS, FIELD, PLAYER, PLAY_BOUNDS } from '../core/config'
import type { Collider, WorldSystem } from '../core/types'

/** 战术站位点 */
export interface TacticalSpot {
  readonly x: number
  readonly z: number
  /** 是否紧贴能挡子弹的掩体 */
  readonly cover: boolean
  /** 掩体朝外的法线（从掩体指向站位点）；无掩体时为 0 */
  readonly nx: number
  readonly nz: number
  /** 看台顶层等高处 */
  readonly high: boolean
}

export interface TeammateNav {
  readonly spots: readonly TacticalSpot[]
  /**
   * 半径 radius 的圆从 (x, z) 沿单位方向 (dx, dz) 前进，最早在多远处被阻挡；maxDist 内没有阻挡返回 maxDist。
   * 已经贴在障碍物里时，只有朝障碍物内部走才算阻挡（贴墙滑行不算）。
   */
  clearance(x: number, z: number, dx: number, dz: number, maxDist: number, radius: number, feetY: number): number
  /** 点 (x, z) 外扩 radius 后是否与阻挡物重叠 */
  blocked(x: number, z: number, radius: number, feetY: number): boolean
}

/** 掩体至少这么高才算能挡人（米） */
const COVER_MIN_HEIGHT = 0.9
/** 两边都超过该长度的碰撞体不生成掩体点（太大，如车体以外的大块结构） */
const COVER_MAX_SPAN = 14
/** 站位点离掩体表面的距离（米，不含身体半径） */
const COVER_GAP = 0.8
/** 长边上每隔这么远放一个点 */
const COVER_SIDE_STEP = 3.5
/** 空地网格间距与离场地边缘的余量（米） */
const OPEN_GRID = 9
const OPEN_MARGIN = 5
/** 看台顶层的点间距 */
const HIGH_STEP = 4
/** 站位点离活动边界至少这么远 */
const BOUND_MARGIN = 1.5

function isBleacherStep(c: Collider): boolean {
  return c.walkable && c.minX === BLEACHERS.minX && c.maxX === BLEACHERS.maxX && c.minZ >= BLEACHERS.minZ - 1e-3 && c.maxZ <= BLEACHERS.maxZ + 1e-3
}

function blocksAt(c: Collider, feetY: number): boolean {
  if (feetY >= c.height - 0.02) return false
  if (c.walkable && c.height <= feetY + PLAYER.stepHeight) return false
  return !(c.walkable && isBleacherStep(c))
}

/**
 * 创建场地查询。需要在 world 可用之后（system init 阶段）调用。
 * @param world 场景系统（只读 colliders）
 */
export function createTeammateNav(world: WorldSystem): TeammateNav {
  const colliders = world.colliders

  function blocked(x: number, z: number, radius: number, feetY: number): boolean {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i]
      if (!c || !blocksAt(c, feetY)) continue
      if (x > c.minX - radius && x < c.maxX + radius && z > c.minZ - radius && z < c.maxZ + radius) return true
    }
    return false
  }

  function clearance(x: number, z: number, dx: number, dz: number, maxDist: number, radius: number, feetY: number): number {
    let best = maxDist
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i]
      if (!c || !blocksAt(c, feetY)) continue
      const minX = c.minX - radius
      const maxX = c.maxX + radius
      const minZ = c.minZ - radius
      const maxZ = c.maxZ + radius
      if (x > minX && x < maxX && z > minZ && z < maxZ) {
        // 已在外扩盒内：取最近面的外法线，朝内走才算挡住
        const l = x - minX
        const r = maxX - x
        const n = z - minZ
        const s = maxZ - z
        const m = Math.min(l, r, n, s)
        let nx = 0
        let nz = 0
        if (m === l) nx = -1
        else if (m === r) nx = 1
        else if (m === n) nz = -1
        else nz = 1
        if (dx * nx + dz * nz < -0.1) return 0
        continue
      }
      let tMin = 0
      let tMax = best
      if (Math.abs(dx) < 1e-6) {
        if (x <= minX || x >= maxX) continue
      } else {
        const inv = 1 / dx
        let t1 = (minX - x) * inv
        let t2 = (maxX - x) * inv
        if (t1 > t2) {
          const t = t1
          t1 = t2
          t2 = t
        }
        if (t1 > tMin) tMin = t1
        if (t2 < tMax) tMax = t2
        if (tMin > tMax) continue
      }
      if (Math.abs(dz) < 1e-6) {
        if (z <= minZ || z >= maxZ) continue
      } else {
        const inv = 1 / dz
        let t1 = (minZ - z) * inv
        let t2 = (maxZ - z) * inv
        if (t1 > t2) {
          const t = t1
          t1 = t2
          t2 = t
        }
        if (t1 > tMin) tMin = t1
        if (t2 < tMax) tMax = t2
        if (tMin > tMax) continue
      }
      if (tMin < best) best = tMin
    }
    return best
  }

  const spots: TacticalSpot[] = []
  const probe = PLAYER.radius + 0.2

  function inBounds(x: number, z: number): boolean {
    return Math.abs(x) <= PLAY_BOUNDS.halfX - BOUND_MARGIN && Math.abs(z) <= PLAY_BOUNDS.halfZ - BOUND_MARGIN
  }

  function addSpot(x: number, z: number, cover: boolean, nx: number, nz: number, high: boolean, feetY: number): void {
    if (!inBounds(x, z) || blocked(x, z, probe, feetY)) return
    spots.push({ x, z, cover, nx, nz, high })
  }

  /** 沿一条边（from → to）等距放点，法线为 (nx, nz) */
  function addEdge(x0: number, z0: number, x1: number, z1: number, nx: number, nz: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const count = Math.max(1, Math.floor(len / COVER_SIDE_STEP))
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count
      addSpot(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, true, nx, nz, false, 0)
    }
  }

  // 掩体四周
  const off = PLAYER.radius + COVER_GAP
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i]
    if (!c || !c.blocksShots || c.height < COVER_MIN_HEIGHT || isBleacherStep(c)) continue
    if (c.maxX - c.minX > COVER_MAX_SPAN && c.maxZ - c.minZ > COVER_MAX_SPAN) continue
    addEdge(c.minX, c.minZ - off, c.maxX, c.minZ - off, 0, -1)
    addEdge(c.minX, c.maxZ + off, c.maxX, c.maxZ + off, 0, 1)
    addEdge(c.minX - off, c.minZ, c.minX - off, c.maxZ, -1, 0)
    addEdge(c.maxX + off, c.minZ, c.maxX + off, c.maxZ, 1, 0)
  }

  // 看台顶层：视野开阔的高处
  const stepDepth = (BLEACHERS.maxZ - BLEACHERS.minZ) / BLEACHERS.steps
  const topZ = BLEACHERS.minZ + stepDepth / 2
  const topY = BLEACHERS.steps * BLEACHERS.stepHeight
  for (let x = BLEACHERS.minX + HIGH_STEP / 2; x < BLEACHERS.maxX; x += HIGH_STEP) {
    addSpot(x, topZ, false, 0, 0, true, topY)
  }

  // 场内空地网格：让队友能在开阔地上分散站开
  for (let x = -FIELD.halfX + OPEN_MARGIN; x <= FIELD.halfX - OPEN_MARGIN; x += OPEN_GRID) {
    for (let z = -FIELD.halfZ + OPEN_MARGIN; z <= FIELD.halfZ - OPEN_MARGIN; z += OPEN_GRID) {
      addSpot(x, z, false, 0, 0, false, 0)
    }
  }

  return { spots, clearance, blocked }
}

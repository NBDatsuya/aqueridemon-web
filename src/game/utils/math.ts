/**
 * 数学与简易碰撞工具。纯函数，不分配对象（除非调用方传入 out）。
 */

import type { Vector3 } from 'three'

/** 把 v 限制在 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 线性插值 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 把 v 从 [a, b] 映射到 [0, 1] 并截断 */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp((v - a) / (b - a), 0, 1)
}

/** 平滑阶跃 */
export function smoothstep(t: number): number {
  const c = clamp(t, 0, 1)
  return c * c * (3 - 2 * c)
}

/**
 * 帧率无关的指数趋近。
 * @param current 当前值
 * @param target 目标值
 * @param rate 趋近速率（越大越快，单位 1/秒）
 * @param dt 帧时长（秒）
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt)
}

/** 把角度归一化到 (-PI, PI] */
export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  else if (r <= -Math.PI) r += Math.PI * 2
  return r
}

/** 沿最短弧把角度 current 趋近 target */
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt))
}

/** 水平方向 (x, z) 对应的朝向角：模型正面朝 +Z 时 rotation.y 取此值 */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz)
}

/** 两点水平距离 */
export function distXZ(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** 两点水平距离的平方 */
export function distXZSq(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}

/**
 * 射线与球求交。
 * @param origin 射线起点
 * @param dir 射线方向（已归一化）
 * @param cx 球心 x
 * @param cy 球心 y
 * @param cz 球心 z
 * @param radius 半径
 * @returns 命中距离；未命中或在身后返回 -1
 */
export function raySphere(
  origin: Vector3,
  dir: Vector3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number {
  const ox = origin.x - cx
  const oy = origin.y - cy
  const oz = origin.z - cz
  const b = ox * dir.x + oy * dir.y + oz * dir.z
  const c = ox * ox + oy * oy + oz * oz - radius * radius
  if (c > 0 && b > 0) return -1
  const disc = b * b - c
  if (disc < 0) return -1
  const t = -b - Math.sqrt(disc)
  return t < 0 ? 0 : t
}

/**
 * 射线与轴对齐包围盒求交（slab 法）。
 * @returns 命中距离；未命中返回 -1
 */
export function rayAabb(
  origin: Vector3,
  dir: Vector3,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  let tMin = 0
  let tMax = Infinity

  if (Math.abs(dir.x) < 1e-8) {
    if (origin.x < minX || origin.x > maxX) return -1
  } else {
    const inv = 1 / dir.x
    let t1 = (minX - origin.x) * inv
    let t2 = (maxX - origin.x) * inv
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return -1
  }

  if (Math.abs(dir.y) < 1e-8) {
    if (origin.y < minY || origin.y > maxY) return -1
  } else {
    const inv = 1 / dir.y
    let t1 = (minY - origin.y) * inv
    let t2 = (maxY - origin.y) * inv
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return -1
  }

  if (Math.abs(dir.z) < 1e-8) {
    if (origin.z < minZ || origin.z > maxZ) return -1
  } else {
    const inv = 1 / dir.z
    let t1 = (minZ - origin.z) * inv
    let t2 = (maxZ - origin.z) * inv
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return -1
  }

  return tMin
}

/**
 * 射线与竖直胶囊（近似为竖直圆柱 + 顶部球）求交，用于人形目标。
 * @param footX 脚底 x
 * @param footY 脚底 y
 * @param footZ 脚底 z
 * @param radius 半径
 * @param height 总高度
 * @returns 命中距离；未命中返回 -1
 */
export function rayCapsule(
  origin: Vector3,
  dir: Vector3,
  footX: number,
  footY: number,
  footZ: number,
  radius: number,
  height: number,
): number {
  const ox = origin.x - footX
  const oz = origin.z - footZ
  const a = dir.x * dir.x + dir.z * dir.z
  if (a > 1e-8) {
    const b = ox * dir.x + oz * dir.z
    const c = ox * ox + oz * oz - radius * radius
    const disc = b * b - a * c
    if (disc >= 0) {
      const t = Math.max(0, (-b - Math.sqrt(disc)) / a)
      const y = origin.y + dir.y * t
      if (y >= footY && y <= footY + height - radius) {
        if (c <= 0 || b < 0) return t
      }
    }
  }
  return raySphere(origin, dir, footX, footY + height - radius, footZ, radius)
}

/** 把秒数格式化为 mm:ss */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`
}

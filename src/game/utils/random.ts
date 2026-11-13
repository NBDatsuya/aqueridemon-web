/**
 * 种子随机数（mulberry32）。同一种子产生同一序列，保证程序化生成可复现。
 */

export interface Rng {
  /** [0, 1) */
  next(): number
  /** [min, max) */
  range(min: number, max: number): number
  /** 闭区间整数 [min, max] */
  int(min: number, max: number): number
  /** 以概率 p 返回 true */
  chance(p: number): boolean
  /** 随机取一个元素（数组不能为空） */
  pick<T>(items: readonly T[]): T
  /** 原地洗牌并返回同一数组 */
  shuffle<T>(items: T[]): T[]
  /** 随机 +1 / -1 */
  sign(): 1 | -1
  /** 派生一个独立的子序列 */
  fork(): Rng
}

/**
 * 创建种子随机数发生器。
 * @param seed 任意整数种子
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const rng: Rng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    shuffle: <T>(items: T[]): T[] => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = items[i] as T
        items[i] = items[j] as T
        items[j] = tmp
      }
      return items
    },
    sign: () => (next() < 0.5 ? -1 : 1),
    fork: () => createRng(Math.floor(next() * 4294967296)),
  }
  return rng
}

/**
 * 把字符串哈希成 32 位整数种子（FNV-1a）。
 * @param text 任意字符串
 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

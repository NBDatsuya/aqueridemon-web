/**
 * 类型化的游戏内事件总线（系统之间的解耦通信）。
 * 与 src/core 的 EventBus 无关：那个只用于游戏与 HUD 外壳之间的暂停 / 重开。
 */

import type { GameEventMap, GameEventType, GameEvents } from './types'

type Handler<K extends GameEventType> = (payload: GameEventMap[K]) => void

/** 创建一条独立的事件总线（每局一条） */
export function createEvents(): GameEvents {
  const listeners = new Map<GameEventType, Set<Handler<GameEventType>>>()

  const off = <K extends GameEventType>(type: K, handler: Handler<K>): void => {
    listeners.get(type)?.delete(handler as Handler<GameEventType>)
  }

  const on = <K extends GameEventType>(type: K, handler: Handler<K>): (() => void) => {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(handler as Handler<GameEventType>)
    return () => off(type, handler)
  }

  const emit = <K extends GameEventType>(type: K, payload: GameEventMap[K]): void => {
    const set = listeners.get(type)
    if (!set) return
    // 复制一份，允许处理函数在回调中退订
    Array.from(set).forEach((handler) => handler(payload))
  }

  return { on, off, emit, clear: () => listeners.clear() }
}

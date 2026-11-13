/**
 * 键鼠输入与指针锁定。
 *
 * 键盘挂在 window 上（未锁定时也记录，供菜单使用）；鼠标按键、位移与滚轮只在指针锁定期间累计。
 * “刚按下”边沿由引擎在帧末调用 endFrame() 清除。
 */

import type { GameContext, InputSystem } from '../core/types'

/** 锁定期间需要屏蔽浏览器默认行为的按键（滚动、切换焦点、菜单等）。不含 Escape 与 F1-F12 */
const GAME_KEYS: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyR',
  'KeyG',
  'KeyC',
  'KeyX',
  'KeyZ',
  'KeyV',
  'KeyB',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'Tab',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

/** 记录的鼠标按键数量（0 左键、1 中键、2 右键、3 / 4 侧键） */
const MOUSE_BUTTONS = 5

/** 像素模式下一格滚轮对应的 deltaY */
const WHEEL_PIXELS_PER_NOTCH = 100
/** 行模式下一格滚轮对应的 deltaY */
const WHEEL_LINES_PER_NOTCH = 3

/** 用户按 ESC 退出锁定后，浏览器有一段拒绝重锁的冷却期（Chrome 约 1.25 秒），重试要等它过去 */
const RELOCK_RETRY_DELAY = 1400

/**
 * 创建输入系统。
 * @param ctx 游戏上下文（输入系统最先创建，不依赖其他系统）
 * @param dom 指针锁定的目标元素（通常是渲染画布或其容器）
 */
export function createInput(ctx: GameContext, dom: HTMLElement): InputSystem {
  const keysDown = new Set<string>()
  const keysPressed = new Set<string>()
  const mouseDown: boolean[] = []
  const mousePressed: boolean[] = []
  for (let i = 0; i < MOUSE_BUTTONS; i++) {
    mouseDown.push(false)
    mousePressed.push(false)
  }
  let lookX = 0
  let lookY = 0
  let wheel = 0
  let disposed = false
  /** 待执行的自动重锁定时器；没有为 -1 */
  let relockTimer = -1

  const isLocked = (): boolean => document.pointerLockElement === dom

  const reset = (): void => {
    keysDown.clear()
    keysPressed.clear()
    mouseDown.fill(false)
    mousePressed.fill(false)
    lookX = 0
    lookY = 0
    wheel = 0
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isLocked() && GAME_KEYS.has(e.code)) e.preventDefault()
    // 自动重复不算新的按下，也不恢复已被 reset 清掉的按住状态
    if (e.repeat) return
    if (!keysDown.has(e.code)) keysPressed.add(e.code)
    keysDown.add(e.code)
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    keysDown.delete(e.code)
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (!isLocked()) return
    // 屏蔽中键自动滚动、侧键前进 / 后退等默认行为
    e.preventDefault()
    if (e.button < 0 || e.button >= MOUSE_BUTTONS) return
    if (mouseDown[e.button] !== true) mousePressed[e.button] = true
    mouseDown[e.button] = true
  }

  const onMouseUp = (e: MouseEvent): void => {
    if (e.button < 0 || e.button >= MOUSE_BUTTONS) return
    mouseDown[e.button] = false
  }

  const onMouseMove = (e: MouseEvent): void => {
    if (!isLocked()) return
    lookX += e.movementX
    lookY += e.movementY
  }

  const onWheel = (e: WheelEvent): void => {
    if (!isLocked()) return
    e.preventDefault()
    let notches = e.deltaY
    if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) notches /= WHEEL_PIXELS_PER_NOTCH
    else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) notches /= WHEEL_LINES_PER_NOTCH
    // 单次事件最多算一格：120px 一格的鼠标不会多出零头，触控板的细碎位移则累加成整格
    wheel += notches > 1 ? 1 : notches < -1 ? -1 : notches
  }

  const onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  const onLockChange = (): void => {
    if (!isLocked()) reset()
  }

  const onBlur = (): void => {
    reset()
  }

  const onVisibilityChange = (): void => {
    reset()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  dom.addEventListener('mousedown', onMouseDown)
  dom.addEventListener('wheel', onWheel, { passive: false })
  dom.addEventListener('contextmenu', onContextMenu)
  // 松开与移动挂在 document 上：锁定期间事件目标不一定是 dom，且要接住移出元素后的松开
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onLockChange)
  document.addEventListener('visibilitychange', onVisibilityChange)

  const exitLock = (): void => {
    if (isLocked()) document.exitPointerLock()
  }

  const cancelRelock = (): void => {
    if (relockTimer >= 0) {
      clearTimeout(relockTimer)
      relockTimer = -1
    }
  }

  const scheduleRelock = (): void => {
    if (relockTimer >= 0) return
    relockTimer = window.setTimeout(() => {
      relockTimer = -1
      if (disposed || isLocked()) return
      requestLock()
    }, RELOCK_RETRY_DELAY)
  }

  const requestLock = (): void => {
    cancelRelock()
    if (isLocked()) return
    try {
      // 新版浏览器返回 Promise（用户按 ESC 退出后冷却期内重锁、非手势触发等情况下会 reject），旧版返回 undefined 或直接抛错
      const result: unknown = dom.requestPointerLock()
      if (result instanceof Promise) {
        result.catch(() => {
          // 被拒绝的最常见原因：用户刚按 ESC（如按 ESC 关闭暂停菜单后立即请求重锁）
          // 等冷却期过去自动重试一次，指针无缝恢复；若再失败就保持未锁定，等待玩家点击
          scheduleRelock()
        })
      }
    } catch {
      scheduleRelock()
    }
  }

  return {
    get locked(): boolean {
      return isLocked()
    },

    isDown: (code) => keysDown.has(code),
    wasPressed: (code) => keysPressed.has(code),
    isMouseDown: (button) => mouseDown[button] === true,
    wasMousePressed: (button) => mousePressed[button] === true,

    consumeLook(out) {
      out.x = lookX
      out.y = lookY
      lookX = 0
      lookY = 0
    },

    consumeWheel() {
      // 只取走整格，不足一格的零头留待下次累计
      const whole = Math.trunc(wheel) || 0
      wheel -= whole
      return whole
    },

    requestLock,

    exitLock,
    reset,

    endFrame() {
      keysPressed.clear()
      mousePressed.fill(false)
    },

    update() {
      // 输入完全由事件驱动，无需逐帧推进
    },

    dispose() {
      disposed = true
      cancelRelock()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      dom.removeEventListener('mousedown', onMouseDown)
      dom.removeEventListener('wheel', onWheel)
      dom.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onLockChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      exitLock()
      reset()
    },
  }
}

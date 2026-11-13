/**
 * 标题菜单 BGM：把原版 Boss 曲（C 小调 108 BPM 的管弦铜管）当菜单类页面的背景音乐循环播放。
 * 用独立的 AudioContext 与实时调度器，和游戏内音频互不影响；浏览器要求用户手势后才能出声，
 * 所以上下文在第一次点击 / 按键时才创建。音量跟随设置里的背景音乐音量与静音开关。
 */

import type { MusicTrack } from '../../core/types'
import { createImpulse } from './impulse'
import type { MusicPlayer } from './music'
import { createMusic } from './music'

/** music 总线在音量 1 时的增益（与游戏内一致） */
const MUSIC_GAIN = 0.55
/** 菜单类页面播放的曲目 */
const TITLE_TRACK: MusicTrack = 'title'

export interface MenuMusic {
  /** 创建或恢复 AudioContext；在用户手势的回调里调用 */
  unlock(): void
  /** 是否播放（菜单类页面为 true，游戏页与音乐鉴赏页为 false） */
  setEnabled(enabled: boolean): void
  setVolume(volume: number, muted: boolean): void
}

/**
 * 创建标题菜单 BGM 控制器。此时不创建 AudioContext。
 */
export function createMenuMusic(): MenuMusic {
  let ctx: AudioContext | null = null
  let bus: GainNode | null = null
  let player: MusicPlayer | null = null
  let enabled = false
  let volume = 1
  let muted = false

  const apply = (): void => {
    if (!ctx || !bus || !player) return
    bus.gain.setTargetAtTime(muted ? 0 : volume * MUSIC_GAIN, ctx.currentTime, 0.05)
    player.setTrack(enabled ? TITLE_TRACK : 'none')
  }

  const unlock = (): void => {
    if (typeof window.AudioContext !== 'function') return
    if (!ctx) {
      ctx = new window.AudioContext()
      // 与游戏内一致的限幅器
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -9
      limiter.knee.value = 6
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.2
      limiter.connect(ctx.destination)
      bus = ctx.createGain()
      bus.gain.value = 0
      bus.connect(limiter)
      player = createMusic(ctx, bus, createImpulse(ctx), false)
    }
    if (ctx.state === 'suspended') void ctx.resume()
    apply()
  }

  return {
    unlock,
    setEnabled: (next: boolean): void => {
      enabled = next
      apply()
    },
    setVolume: (nextVolume: number, nextMuted: boolean): void => {
      volume = Math.min(1, Math.max(0, nextVolume))
      muted = nextMuted
      apply()
    },
  }
}

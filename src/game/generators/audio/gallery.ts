/**
 * 音乐鉴赏：把游戏里的程序化曲目离线渲染成定长 AudioBuffer，用普通的缓冲播放器放出来，支持暂停与拖动进度；
 * 同时从渲染结果里预先算出一条“灯光亮度”曲线（低频起音 + 整体响度），页面按播放位置取值，拖动后也保持同步。
 *
 * 本模块只依赖音频生成代码，不引入 three，菜单页可以直接动态 import。
 */

import type { MusicTrack } from '../../core/types'
import { createImpulse } from './impulse'
import type { SongId } from './music'
import { renderSong } from './music'

export type GalleryTrackId = 'idle' | 'bossLegacy' | 'round' | 'boss'

export interface GalleryTrack {
  id: GalleryTrackId
  /** 一小节的时长（秒） */
  barSeconds: number
  /** 演奏的小节数：取一轮完整的曲式 */
  bars: number
  /** 曲尾释音与混响（秒） */
  tail: number
  /** 总时长（秒） */
  duration: number
}

interface TrackSource {
  song: SongId
  mode: MusicTrack
}

const bar = (bpm: number): number => (60 / bpm) * 4

const track = (id: GalleryTrackId, barSeconds: number, bars: number, tail: number): GalleryTrack => ({
  id,
  barSeconds,
  bars,
  tail,
  duration: barSeconds * bars + tail,
})

/** 曲目顺序：游戏内现行的两首在前，不再使用的两首在后 */
export const GALLERY_TRACKS: readonly GalleryTrack[] = [
  // 回合战斗：4 段 × 8 小节，含第四段的 breakdown
  track('round', bar(132), 32, 3),
  // Boss（Drum and Bass）：8 小节前奏 + 32 小节循环体
  track('boss', bar(174), 40, 3),
  // 闲时（原开局选枪界面的氛围曲）：一小节 8 秒，4 个和弦循环两轮
  track('idle', 8, 8, 6),
  // 原版 Boss：4 段 × 8 小节
  track('bossLegacy', bar(108), 32, 3),
]

const SOURCES: Record<GalleryTrackId, TrackSource> = {
  idle: { song: 'menu', mode: 'menu' },
  bossLegacy: { song: 'bossLegacy', mode: 'boss' },
  round: { song: 'combat', mode: 'battle' },
  boss: { song: 'boss', mode: 'boss' },
}

/** 播放音量为 1 时的增益（与游戏内 music 总线一致） */
const MUSIC_GAIN = 0.55
/** 灯光曲线的帧率（帧 / 秒） */
const PULSE_RATE = 100
/** 起音检测用的低通截止频率（Hz）：只看底鼓、定音鼓、贝斯一带 */
const PULSE_CUTOFF = 160
/** 起音后亮度的衰减时间常数（秒） */
const PULSE_DECAY = 0.16
/** 亮度里起音与整体响度的占比 */
const PULSE_HIT_WEIGHT = 0.72

interface Rendered {
  buffer: AudioBuffer
  /** 每帧 0..1 的亮度 */
  pulse: Float32Array
}

/** 归一化用的分位数：避开个别极端峰值 */
function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

/** 从渲染结果算出亮度曲线：低频能量高出近期平均的部分算“起音”，起音后指数衰减，再叠一层平滑的整体响度 */
function analysePulse(buffer: AudioBuffer): Float32Array {
  const sr = buffer.sampleRate
  const hop = Math.max(1, Math.round(sr / PULSE_RATE))
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
  const frames = Math.ceil(left.length / hop)
  const bass = new Float32Array(frames)
  const loud = new Float32Array(frames)
  const k = 1 - Math.exp((-2 * Math.PI * PULSE_CUTOFF) / sr)
  let low = 0
  for (let f = 0; f < frames; f++) {
    const start = f * hop
    const end = Math.min(left.length, start + hop)
    let sumLow = 0
    let sumAll = 0
    for (let i = start; i < end; i++) {
      const x = ((left[i] as number) + (right[i] as number)) * 0.5
      low += (x - low) * k
      sumLow += low * low
      sumAll += x * x
    }
    const n = Math.max(1, end - start)
    bass[f] = Math.sqrt(sumLow / n)
    loud[f] = Math.sqrt(sumAll / n)
  }

  const onset = new Float32Array(frames)
  let average = 0
  for (let f = 0; f < frames; f++) {
    const value = bass[f] as number
    onset[f] = Math.max(0, value - average * 1.15)
    // 约 150ms 的滑动平均
    average += (value - average) * 0.065
  }
  const onsetNorm = percentile(onset, 0.985) || 1
  const loudNorm = percentile(loud, 0.98) || 1

  const pulse = new Float32Array(frames)
  const decay = Math.exp(-1 / (PULSE_DECAY * PULSE_RATE))
  let hit = 0
  let body = 0
  for (let f = 0; f < frames; f++) {
    hit = Math.max(Math.min(1, (onset[f] as number) / onsetNorm), hit * decay)
    body += (Math.min(1, (loud[f] as number) / loudNorm) - body) * 0.08
    pulse[f] = Math.min(1, PULSE_HIT_WEIGHT * hit + (1 - PULSE_HIT_WEIGHT) * body)
  }
  return pulse
}

const cache = new Map<GalleryTrackId, Promise<Rendered>>()

/** 渲染（或取缓存）一首曲目；同名种子保证每次听到的是同一个版本 */
function load(id: GalleryTrackId): Promise<Rendered> {
  const cached = cache.get(id)
  if (cached) return cached
  const info = GALLERY_TRACKS.find((t) => t.id === id)
  if (!info) return Promise.reject(new Error(`unknown track ${id}`))
  const source = SOURCES[id]
  const task = renderSong(
    source.song,
    { duration: info.barSeconds * info.bars, tail: info.tail, seed: `gallery:${id}`, track: source.mode },
    createImpulse,
  ).then((buffer) => ({ buffer, pulse: analysePulse(buffer) }))
  // 失败不缓存，下次点击重试
  task.catch(() => cache.delete(id))
  cache.set(id, task)
  return task
}

/** 释放已渲染的缓冲（离开页面时调用，一首约 20MB） */
export function clearGalleryCache(): void {
  cache.clear()
}

export type GalleryState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface GalleryPlayer {
  /** 当前选中的曲目 */
  readonly current: GalleryTrackId | null
  readonly state: GalleryState
  /** 选中并从头播放；必须在用户手势（点击）的同步调用栈里调用，浏览器才允许出声 */
  select(id: GalleryTrackId): Promise<void>
  /** 暂停 / 继续；同样需要在用户手势里调用 */
  toggle(): void
  /** 跳到指定秒数，播放中则从新位置继续 */
  seek(seconds: number): void
  /** 当前播放位置（秒） */
  position(): number
  /** 当前听到的位置对应的灯光亮度 0..1（扣除输出延迟） */
  pulse(): number
  /** 音量 0..1 与静音 */
  setVolume(volume: number, muted: boolean): void
  dispose(): void
}

/**
 * 创建音乐鉴赏播放器。AudioContext 在第一次 select / toggle 时创建。
 * @param onChange 状态、曲目或位置跳变时回调（播放进度本身由调用方按帧读取 position）
 */
export function createGalleryPlayer(onChange: () => void): GalleryPlayer {
  let ctx: AudioContext | null = null
  let volumeNode: GainNode | null = null
  let volume = 1
  let muted = false

  let current: GalleryTrackId | null = null
  let state: GalleryState = 'idle'
  let rendered: Rendered | null = null
  let source: AudioBufferSourceNode | null = null
  /** 播放中：position = ctx.currentTime - startedAt；暂停时位置记在 offset */
  let startedAt = 0
  let offset = 0
  /** 每次选曲递增，丢弃过期的渲染结果 */
  let request = 0
  let disposed = false

  const setState = (next: GalleryState): void => {
    state = next
    onChange()
  }

  const ensureContext = (): AudioContext | null => {
    if (disposed) return null
    if (!ctx) {
      if (typeof window.AudioContext !== 'function') return null
      ctx = new window.AudioContext()
      // 与游戏内一致的限幅器，保证响度相同且不削波
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -9
      limiter.knee.value = 6
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.2
      limiter.connect(ctx.destination)
      volumeNode = ctx.createGain()
      volumeNode.connect(limiter)
      applyVolume()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  const applyVolume = (): void => {
    if (!ctx || !volumeNode) return
    volumeNode.gain.setTargetAtTime(muted ? 0 : volume * MUSIC_GAIN, ctx.currentTime, 0.03)
  }

  const duration = (): number => rendered?.buffer.duration ?? 0

  const stopSource = (): void => {
    if (!source) return
    source.onended = null
    try {
      source.stop()
    } catch {
      // 已经停止
    }
    source.disconnect()
    source = null
  }

  const startAt = (seconds: number): void => {
    const audio = ctx
    if (!audio || !volumeNode || !rendered) return
    stopSource()
    const from = Math.min(Math.max(0, seconds), duration())
    const node = audio.createBufferSource()
    node.buffer = rendered.buffer
    node.connect(volumeNode)
    node.onended = () => {
      if (source !== node) return
      source = null
      offset = 0
      setState('paused')
    }
    node.start(audio.currentTime + 0.02, from)
    source = node
    startedAt = audio.currentTime + 0.02 - from
    offset = from
    setState('playing')
  }

  const position = (): number => {
    if (state === 'playing' && ctx) return Math.min(duration(), Math.max(0, ctx.currentTime - startedAt))
    return offset
  }

  const select = async (id: GalleryTrackId): Promise<void> => {
    if (!ensureContext()) {
      setState('error')
      return
    }
    const ticket = ++request
    stopSource()
    current = id
    rendered = null
    offset = 0
    setState('loading')
    try {
      const result = await load(id)
      if (ticket !== request || disposed) return
      rendered = result
      startAt(0)
    } catch {
      if (ticket === request) setState('error')
    }
  }

  const toggle = (): void => {
    if (!rendered) return
    if (state === 'playing') {
      offset = position()
      stopSource()
      setState('paused')
      return
    }
    if (!ensureContext()) return
    // 播完停在开头，再按一次从头放
    startAt(offset >= duration() - 0.05 ? 0 : offset)
  }

  const seek = (seconds: number): void => {
    if (!rendered) return
    const target = Math.min(Math.max(0, seconds), duration())
    if (state === 'playing') {
      startAt(target)
    } else {
      offset = target
      onChange()
    }
  }

  const pulse = (): number => {
    if (!rendered || state !== 'playing' || !ctx) return 0
    const latency = ctx.outputLatency || ctx.baseLatency || 0
    const frame = Math.floor((position() - latency) * PULSE_RATE)
    return frame >= 0 ? (rendered.pulse[frame] ?? 0) : 0
  }

  const setVolume = (nextVolume: number, nextMuted: boolean): void => {
    volume = Math.min(1, Math.max(0, nextVolume))
    muted = nextMuted
    applyVolume()
  }

  const dispose = (): void => {
    disposed = true
    request++
    stopSource()
    void ctx?.close()
    ctx = null
    volumeNode = null
    rendered = null
  }

  return {
    get current() {
      return current
    },
    get state() {
      return state
    },
    select,
    toggle,
    seek,
    position,
    pulse,
    setVolume,
    dispose,
  }
}

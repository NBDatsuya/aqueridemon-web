/**
 * 程序化音频系统入口。全部声音用 Web Audio API 合成，不加载任何音频文件。
 *
 * 信号流：
 *   一次性音效（预渲染 AudioBuffer）─┬→ sfx 总线 ─┐
 *   风声 / 直升机 / 循环心跳 ───────────┘             ├→ premix → 低通 ─┬→ dry ─────────────┬→ master → 限幅器 → 输出
 *   音乐调度器 ──────────────────→ music 总线 ─┘                  └→ WaveShaper → wet ─┘
 * 低通与 WaveShaper 只在 setMuffled(true) 时起作用（低沉失真）。
 *
 * createAudio() 本身不创建 AudioContext；unlock() 之前的所有调用只记录期望状态（音量、曲目、循环声等），
 * unlock() 时一次性应用。
 */

import type { Vector3 } from 'three'
import type { AudioSystem, MusicTrack, SfxId, SfxOptions } from '../../core/types'
import { clamp, invLerp, smoothstep } from '../../utils/math'
import { createRng, hashSeed } from '../../utils/random'
import type { AmbientLoops } from './ambient'
import { createAmbient } from './ambient'
import type { MusicPlayer } from './music'
import { createMusic } from './music'
import { SFX, SFX_IDS } from './sfx-bank'

/** 同时发声的一次性音效上限 */
const MAX_VOICES = 20
/** sfx 总线在音量 1 时的增益 */
const SFX_GAIN = 0.9
/** music 总线在音量 1 时的增益 */
const MUSIC_GAIN = 0.55
/** 闷声时的低通截止频率（Hz） */
const MUFFLE_CUTOFF = 420
const MUFFLE_DRY = 0.55
const MUFFLE_WET = 0.22
/** 左右声像的最大偏移（留一点串音，避免声音完全贴在一侧） */
const PAN_WIDTH = 0.85
/** 预渲染时每段连续占用主线程的时间（毫秒），超过就让出一帧 */
const SLICE_MS = 6

interface AudioGraph {
  ctx: AudioContext
  master: GainNode
  sfxBus: GainNode
  musicBus: GainNode
  /** 全局低通：平时全开，闷声时压到 MUFFLE_CUTOFF */
  muffle: BiquadFilterNode
  dry: GainNode
  wet: GainNode
  /** 低通全开时的截止频率 */
  openCutoff: number
  /** 音效混响的输入 */
  reverb: ConvolverNode
  music: MusicPlayer
  ambient: AmbientLoops
}

interface Voice {
  id: SfxId
  source: AudioBufferSourceNode
  gain: GainNode
  nodes: AudioNode[]
  priority: number
  /** 衰减后的响度 0..1，抢占时用来比较 */
  loudness: number
  start: number
  end: number
}

const noop = (): void => {}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** WaveShaper 的 tanh 失真曲线；amount 越大削波越狠 */
function distortionCurve(amount: number) {
  const curve = new Float32Array(1024)
  const norm = Math.tanh(amount)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * amount) / norm
  }
  return curve
}

/** 混响冲激响应：指数衰减的噪声（高频衰减更快）+ 两次早期反射，模拟空旷的球场 */
function createImpulse(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate
  const length = Math.floor(sr * 1.6)
  const buffer = ctx.createBuffer(2, length, sr)
  const rng = createRng(hashSeed('cis2-reverb'))
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    let low = 0
    for (let i = 0; i < length; i++) {
      const t = i / sr
      const smoothing = 0.25 + 0.6 * Math.min(1, t / 0.8)
      low += (rng.next() * 2 - 1 - low) * (1 - smoothing)
      data[i] = low * Math.exp(-t / 0.32)
    }
    const reflections = [0.061 + ch * 0.007, 0.113 - ch * 0.005]
    reflections.forEach((time, i) => {
      const index = Math.floor(time * sr)
      if (index < length) data[index] = (data[index] as number) + (i === 0 ? 0.6 : 0.4)
    })
  }
  return buffer
}

/** 距离衰减：参考距离内不衰减，之后按反比衰减，并在接近最大距离时平滑归零 */
function attenuation(distance: number, refDistance: number, maxDistance: number): number {
  if (distance <= refDistance) return 1
  const inverse = refDistance / distance
  const edge = 1 - smoothstep(invLerp(maxDistance * 0.6, maxDistance, distance))
  return inverse * edge
}

/**
 * 创建音频系统。此时不创建 AudioContext，必须在用户手势回调里调用 unlock() 后才会发声。
 * @returns AudioSystem 实现
 */
export function createAudio(): AudioSystem {
  /** 运行时的随机（变体选择、变调抖动） */
  const rng = createRng(hashSeed('cis2-audio-runtime'))
  const roarCurve = distortionCurve(3)
  const buffers = new Map<string, AudioBuffer>()
  const lastPlayed = new Map<SfxId, { time: number; volume: number }>()
  const voices: Voice[] = []

  let graph: AudioGraph | null = null
  let prerender: Promise<void> | null = null
  /** dispose() 时自增，用来中止还在进行的预渲染 */
  let epoch = 0

  // 期望状态：unlock 之前只记录，unlock 时应用
  let bgmVolume = 0.7
  let sfxVolume = 1
  let muted = false
  let muffled = false
  let paused = false
  let heliLevel = 0
  let heartbeatOn = false
  let track: MusicTrack = 'none'

  // 听者：位置与水平朝向（单位向量）
  let listenerX = 0
  let listenerY = 0
  let listenerZ = 0
  let forwardX = 0
  let forwardZ = -1

  /* ── 节点图 ── */

  const build = (): AudioGraph | null => {
    if (typeof window === 'undefined') return null
    const legacy = window as unknown as { webkitAudioContext?: typeof AudioContext }
    const Ctor = window.AudioContext ?? legacy.webkitAudioContext
    if (!Ctor) return null
    const ctx = new Ctor()

    const gainNode = (value: number): GainNode => {
      const node = ctx.createGain()
      node.gain.value = value
      return node
    }

    // 限幅器：多把枪同时开火时不削波
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -9
    limiter.knee.value = 6
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.2
    limiter.connect(ctx.destination)
    const master = gainNode(muted ? 0 : 1)
    master.connect(limiter)

    // 闷声链：低通 → dry，以及低通 → WaveShaper → wet
    const openCutoff = Math.min(20000, ctx.sampleRate * 0.45)
    const muffle = ctx.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.Q.value = 0.8
    muffle.frequency.value = muffled ? MUFFLE_CUTOFF : openCutoff
    const dry = gainNode(muffled ? MUFFLE_DRY : 1)
    const wet = gainNode(muffled ? MUFFLE_WET : 0)
    const crush = ctx.createWaveShaper()
    crush.curve = distortionCurve(4)
    crush.oversample = '2x'
    muffle.connect(dry)
    dry.connect(master)
    muffle.connect(crush)
    crush.connect(wet)
    wet.connect(master)

    const premix = gainNode(1)
    premix.connect(muffle)
    const sfxBus = gainNode(sfxVolume * SFX_GAIN)
    sfxBus.connect(premix)
    const musicBus = gainNode(bgmVolume * MUSIC_GAIN)
    musicBus.connect(premix)

    // 音效混响（发送式）
    const impulse = createImpulse(ctx)
    const reverb = ctx.createConvolver()
    reverb.buffer = impulse
    const reverbReturn = gainNode(0.8)
    reverb.connect(reverbReturn)
    reverbReturn.connect(sfxBus)

    const music = createMusic(ctx, musicBus, impulse)
    const ambient = createAmbient(ctx, sfxBus)
    return { ctx, master, sfxBus, musicBus, muffle, dry, wet, openCutoff, reverb, music, ambient }
  }

  /* ── 预渲染 ── */

  /** 取某个音效变体的 AudioBuffer；还没渲染就当场渲染并缓存 */
  const bufferFor = (g: AudioGraph, id: SfxId, variant: number): AudioBuffer | null => {
    const key = `${id}#${variant}`
    const cached = buffers.get(key)
    if (cached) return cached
    try {
      const sr = g.ctx.sampleRate
      const rendered = SFX[id].render(sr, createRng(hashSeed(key)), variant)
      const channels = Array.isArray(rendered) ? rendered : [rendered]
      const first = channels[0]
      if (!first) return null
      const buffer = g.ctx.createBuffer(channels.length, first.length, sr)
      channels.forEach((data, ch) => buffer.getChannelData(ch).set(data))
      buffers.set(key, buffer)
      return buffer
    } catch {
      return null
    }
  }

  /** 分片预渲染全部音效，避免一次性卡住主线程 */
  const prerenderAll = (g: AudioGraph): Promise<void> => {
    if (prerender) return prerender
    const mine = epoch
    const run = async (): Promise<void> => {
      let sliceStart = performance.now()
      for (const id of SFX_IDS) {
        for (let variant = 0; variant < SFX[id].variants; variant++) {
          if (mine !== epoch) return
          bufferFor(g, id, variant)
          if (performance.now() - sliceStart > SLICE_MS) {
            await nextTask()
            sliceStart = performance.now()
          }
        }
      }
    }
    prerender = run()
    return prerender
  }

  /* ── 状态应用 ── */

  const applyVolumes = (g: AudioGraph): void => {
    const now = g.ctx.currentTime
    g.musicBus.gain.setTargetAtTime(bgmVolume * MUSIC_GAIN, now, 0.05)
    g.sfxBus.gain.setTargetAtTime(sfxVolume * SFX_GAIN, now, 0.05)
    g.master.gain.setTargetAtTime(muted ? 0 : 1, now, 0.03)
  }

  const applyMuffle = (g: AudioGraph): void => {
    const now = g.ctx.currentTime
    g.muffle.frequency.setTargetAtTime(muffled ? MUFFLE_CUTOFF : g.openCutoff, now, muffled ? 0.18 : 0.3)
    g.dry.gain.setTargetAtTime(muffled ? MUFFLE_DRY : 1, now, 0.2)
    g.wet.gain.setTargetAtTime(muffled ? MUFFLE_WET : 0, now, 0.2)
  }

  /* ── 一次性音效的发声管理 ── */

  const release = (voice: Voice): void => {
    const index = voices.indexOf(voice)
    if (index >= 0) voices.splice(index, 1)
    voice.source.disconnect()
    voice.nodes.forEach((node) => node.disconnect())
  }

  /** 抢占：立刻让出名额，声音用极短的淡出收掉以免爆音 */
  const steal = (voice: Voice, now: number): void => {
    const index = voices.indexOf(voice)
    if (index >= 0) voices.splice(index, 1)
    voice.gain.gain.setTargetAtTime(0, now, 0.008)
    try {
      voice.source.stop(now + 0.05)
    } catch {
      // 已经停止
    }
  }

  /** 抢占评分：优先级为主，响度次之，快播完的更容易被顶掉 */
  const scoreOf = (voice: Voice, now: number): number => {
    const length = voice.end - voice.start
    const progress = length > 0 ? clamp((now - voice.start) / length, 0, 1) : 1
    return voice.priority * 100 + voice.loudness * 40 - progress * 40
  }

  const play = (id: SfxId, options?: SfxOptions): void => {
    const g = graph
    if (!g || paused) return
    const def = SFX[id]
    if (!def) return

    try {
      const now = g.ctx.currentTime
      let loudness = clamp(options?.volume ?? 1, 0, 4)
      let pan = 0

      // 距离衰减与左右声像
      const position = options?.position
      if (position) {
        const dx = position.x - listenerX
        const dy = position.y - listenerY
        const dz = position.z - listenerZ
        const distance = Math.hypot(dx, dy, dz)
        if (distance >= def.maxDistance) return
        loudness *= attenuation(distance, def.refDistance, def.maxDistance)
        const horizontal = Math.hypot(dx, dz)
        if (horizontal > 1e-3) {
          const nx = dx / horizontal
          const nz = dz / horizontal
          // 听者的右方向 = forward × up = (-forwardZ, forwardX)
          const side = nx * -forwardZ + nz * forwardX
          const front = nx * forwardX + nz * forwardZ
          // 贴身的声音不做大幅声像；身后的声音略小
          pan = clamp(side, -1, 1) * PAN_WIDTH * Math.min(1, horizontal / 2)
          if (front < 0) loudness *= 1 + 0.2 * front
        }
      }
      if (loudness < 0.003) return

      // 节流：同一 id 短时间内只响一次，除非这次明显更响（比如队友刚开过枪，主控紧接着开枪）
      const last = lastPlayed.get(id)
      if (last && now - last.time < def.throttle && loudness <= last.volume * 1.5) return

      // 清掉已经播完但没收到 ended 的声音
      for (let i = voices.length - 1; i >= 0; i--) {
        const voice = voices[i]
        if (voice && now > voice.end + 0.5) release(voice)
      }

      // 同一 id 的发声数上限：顶掉最早的那个
      let same = 0
      let oldest: Voice | null = null
      for (const voice of voices) {
        if (voice.id !== id) continue
        same++
        if (!oldest || voice.start < oldest.start) oldest = voice
      }
      if (oldest && same >= def.maxVoices) steal(oldest, now)

      // 总发声数上限：按优先级丢弃（受伤 / Boss / UI > 枪声 > 脚步、远处丧尸）
      if (voices.length >= MAX_VOICES) {
        const score = def.priority * 100 + Math.min(1, loudness) * 40
        let victim: Voice | null = null
        let victimScore = Infinity
        for (const voice of voices) {
          const s = scoreOf(voice, now)
          if (s < victimScore) {
            victim = voice
            victimScore = s
          }
        }
        if (!victim || victimScore >= score) return
        steal(victim, now)
      }

      const variant = def.variants > 1 ? rng.int(0, def.variants - 1) : 0
      const buffer = bufferFor(g, id, variant)
      if (!buffer) return
      const rate = clamp(options?.rate ?? 1, 0.25, 4) * (1 + rng.range(-def.jitter, def.jitter))

      const source = g.ctx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = rate
      const gain = g.ctx.createGain()
      gain.gain.value = def.gain * loudness
      const nodes: AudioNode[] = [gain]

      if (def.distortion) {
        // 怪物咆哮：先过 WaveShaper 失真再调音量，远近的失真程度一致
        const shaper = g.ctx.createWaveShaper()
        shaper.curve = roarCurve
        shaper.oversample = '2x'
        source.connect(shaper)
        shaper.connect(gain)
        nodes.push(shaper)
      } else {
        source.connect(gain)
      }

      let tail: AudioNode = gain
      if (pan !== 0 && typeof g.ctx.createStereoPanner === 'function') {
        const panner = g.ctx.createStereoPanner()
        panner.pan.value = pan
        gain.connect(panner)
        nodes.push(panner)
        tail = panner
      }
      tail.connect(g.sfxBus)

      if (def.reverb > 0) {
        const send = g.ctx.createGain()
        send.gain.value = def.reverb
        tail.connect(send)
        send.connect(g.reverb)
        nodes.push(send)
      }

      const voice: Voice = {
        id,
        source,
        gain,
        nodes,
        priority: def.priority,
        loudness: Math.min(1, loudness),
        start: now,
        end: now + buffer.duration / rate,
      }
      voices.push(voice)
      source.onended = () => release(voice)
      source.start()
      lastPlayed.set(id, { time: now, volume: loudness })
    } catch {
      // 音频出错不影响游戏
    }
  }

  /* ── AudioSystem 接口 ── */

  const unlock = async (): Promise<void> => {
    try {
      if (!graph) {
        graph = build()
        if (graph) {
          graph.ambient.setHelicopter(heliLevel)
          graph.ambient.setHeartbeat(heartbeatOn)
          graph.music.setTrack(track)
        }
      }
      const g = graph
      if (!g) return
      const ctx = g.ctx
      if (ctx.state !== 'running') {
        // resume() 必须在手势的同步调用栈里发起。不等待它：浏览器拒绝时这个 Promise 可能一直不落定
        ctx
          .resume()
          .then(() => (paused && graph === g ? ctx.suspend() : undefined))
          .catch(noop)
      }
      await prerenderAll(g)
    } catch {
      // 音频不可用时保持静默
    }
  }

  const setVolumes = (bgm: number, sfx: number, mute: boolean): void => {
    const nextBgm = clamp(Number.isFinite(bgm) ? bgm : 0, 0, 1)
    const nextSfx = clamp(Number.isFinite(sfx) ? sfx : 0, 0, 1)
    if (nextBgm === bgmVolume && nextSfx === sfxVolume && mute === muted) return
    bgmVolume = nextBgm
    sfxVolume = nextSfx
    muted = mute
    if (graph) applyVolumes(graph)
  }

  const setListener = (position: Vector3, forward: Vector3): void => {
    listenerX = position.x
    listenerY = position.y
    listenerZ = position.z
    const length = Math.hypot(forward.x, forward.z)
    // 几乎垂直向上 / 向下看时沿用上一次的水平朝向
    if (length > 1e-4) {
      forwardX = forward.x / length
      forwardZ = forward.z / length
    }
  }

  const setMusic = (next: MusicTrack): void => {
    if (next === track) return
    track = next
    graph?.music.setTrack(next)
  }

  const setHelicopter = (level: number): void => {
    heliLevel = clamp(Number.isFinite(level) ? level : 0, 0, 1)
    graph?.ambient.setHelicopter(heliLevel)
  }

  const setHeartbeat = (on: boolean): void => {
    if (on === heartbeatOn) return
    heartbeatOn = on
    graph?.ambient.setHeartbeat(on)
  }

  const setMuffled = (on: boolean): void => {
    if (on === muffled) return
    muffled = on
    if (graph) applyMuffle(graph)
  }

  const setPaused = (next: boolean): void => {
    if (next === paused) return
    paused = next
    const g = graph
    if (!g) return
    const pending = next ? g.ctx.suspend() : g.ctx.resume()
    pending.catch(noop)
  }

  const dispose = (): void => {
    epoch++
    prerender = null
    const g = graph
    graph = null

    voices.forEach((voice) => {
      try {
        voice.source.stop()
      } catch {
        // 已经停止
      }
    })
    voices.length = 0
    buffers.clear()
    lastPlayed.clear()

    // 复位一局内的状态；音量设置保留
    muffled = false
    paused = false
    heliLevel = 0
    heartbeatOn = false
    track = 'none'

    if (!g) return
    g.music.dispose()
    g.ambient.dispose()
    g.master.disconnect()
    g.ctx.close().catch(noop)
  }

  return { unlock, setVolumes, setListener, play, setMusic, setHelicopter, setHeartbeat, setMuffled, setPaused, dispose }
}

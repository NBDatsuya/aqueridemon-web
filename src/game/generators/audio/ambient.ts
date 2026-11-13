/**
 * 循环声：常驻风声、直升机螺旋桨、循环心跳。全部用实时节点合成，输出到调用方给的总线。
 */

import { clamp } from '../../utils/math'
import { createRng, hashSeed } from '../../utils/random'
import { renderHeartbeat } from './feedback'

/** 风声基础音量（很轻） */
const WIND_LEVEL = 0.3
/** 直升机满音量 */
const HELI_LEVEL = 0.8
/** 桨叶通过频率（Hz）：每秒“呼”多少下 */
const BLADE_HZ = 11
/** 循环心跳的周期（秒），约 78 BPM */
const HEART_PERIOD = 0.77
const HEART_LEVEL = 0.9
/** level 归零后多久拆掉直升机节点（毫秒） */
const HELI_TEARDOWN_MS = 2000

export interface AmbientLoops {
  /** 直升机螺旋桨音量 0..1，平滑过渡；0 为停止 */
  setHelicopter(level: number): void
  /** 循环心跳开关 */
  setHeartbeat(on: boolean): void
  dispose(): void
}

interface HeliRig {
  sources: AudioScheduledSourceNode[]
  band: BiquadFilterNode
  gain: GainNode
}

function stopQuietly(source: AudioScheduledSourceNode, when?: number): void {
  try {
    source.stop(when)
  } catch {
    // 已经停止或从未启动
  }
}

/**
 * 创建循环声层。风声立即开始并淡入；直升机与心跳按需启停。
 * @param ctx 已创建的 AudioContext
 * @param output 输出总线（sfx 总线）
 */
export function createAmbient(ctx: AudioContext, output: AudioNode): AmbientLoops {
  const sr = ctx.sampleRate
  const rng = createRng(hashSeed('cis2-ambient'))

  // 共用的白噪声循环
  const noiseBuffer = ctx.createBuffer(1, Math.floor(sr * 3), sr)
  const noiseData = noiseBuffer.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = rng.next() * 2 - 1

  const noiseSource = (rate: number): AudioBufferSourceNode => {
    const source = ctx.createBufferSource()
    source.buffer = noiseBuffer
    source.loop = true
    source.playbackRate.value = rate
    return source
  }

  const lfo = (freq: number, depth: number, target: AudioParam): OscillatorNode => {
    const osc = ctx.createOscillator()
    osc.frequency.value = freq
    const amount = ctx.createGain()
    amount.gain.value = depth
    osc.connect(amount)
    amount.connect(target)
    return osc
  }

  /* ── 风声：带通噪声，中心频率与音量被几条慢速 LFO 推着起伏 ── */

  const windBand = ctx.createBiquadFilter()
  windBand.type = 'bandpass'
  windBand.frequency.value = 360
  windBand.Q.value = 0.7
  const windTone = ctx.createBiquadFilter()
  windTone.type = 'lowpass'
  windTone.frequency.value = 1400
  const windGain = ctx.createGain()
  windGain.gain.value = 0
  windGain.gain.setTargetAtTime(WIND_LEVEL, ctx.currentTime, 1.5)
  windBand.connect(windTone)
  windTone.connect(windGain)
  windGain.connect(output)

  const windSources: AudioScheduledSourceNode[] = [
    noiseSource(0.7),
    lfo(0.07, 140, windBand.frequency),
    lfo(0.11, WIND_LEVEL * 0.35, windGain.gain),
    lfo(0.037, WIND_LEVEL * 0.25, windGain.gain),
  ]
  windSources[0]?.connect(windBand)
  windSources.forEach((source) => source.start())

  /* ── 直升机：40Hz 正弦 + 带通噪声“呼呼”声，整体被桨叶脉冲调制 ── */

  // 桨叶调制波形：1 秒内 BLADE_HZ 个“快起慢落”的脉冲，取值 0..1
  const bladeBuffer = ctx.createBuffer(1, Math.floor(sr), sr)
  const bladeData = bladeBuffer.getChannelData(0)
  for (let i = 0; i < bladeData.length; i++) {
    const phase = ((i * BLADE_HZ) / bladeData.length) % 1
    bladeData[i] = phase < 0.1 ? phase / 0.1 : Math.exp(-(phase - 0.1) * 5.5)
  }

  let heli: HeliRig | null = null
  let heliLevel = 0
  let heliTimer: ReturnType<typeof setTimeout> | null = null

  const buildHeli = (): HeliRig => {
    const gain = ctx.createGain()
    gain.gain.value = 0
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 2600
    const chop = ctx.createGain()
    chop.gain.value = 0.3
    chop.connect(tone)
    tone.connect(gain)
    gain.connect(output)

    const blade = ctx.createBufferSource()
    blade.buffer = bladeBuffer
    blade.loop = true
    const bladeDepth = ctx.createGain()
    bladeDepth.gain.value = 0.7
    blade.connect(bladeDepth)
    bladeDepth.connect(chop.gain)

    // 低频震动
    const rumble = ctx.createOscillator()
    rumble.type = 'sine'
    rumble.frequency.value = 40
    const rumbleGain = ctx.createGain()
    rumbleGain.gain.value = 0.55
    rumble.connect(rumbleGain)
    rumbleGain.connect(chop)
    const harmonic = ctx.createOscillator()
    harmonic.type = 'triangle'
    harmonic.frequency.value = 80
    const harmonicGain = ctx.createGain()
    harmonicGain.gain.value = 0.16
    harmonic.connect(harmonicGain)
    harmonicGain.connect(chop)

    // 桨叶切风的“呼呼”声
    const whoosh = noiseSource(0.9)
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 500
    band.Q.value = 0.9
    const whooshGain = ctx.createGain()
    whooshGain.gain.value = 1.8
    whoosh.connect(band)
    band.connect(whooshGain)
    whooshGain.connect(chop)

    const sources: AudioScheduledSourceNode[] = [blade, rumble, harmonic, whoosh]
    sources.forEach((source) => source.start())
    return { sources, band, gain }
  }

  const teardownHeli = (): void => {
    heliTimer = null
    if (!heli) return
    heli.sources.forEach((source) => stopQuietly(source))
    heli.gain.disconnect()
    heli = null
  }

  const setHelicopter = (level: number): void => {
    const next = clamp(Number.isFinite(level) ? level : 0, 0, 1)
    // 每帧都会被调用：变化很小时不重复排自动化事件
    if (Math.abs(next - heliLevel) < 0.004 && (next > 0 || heliLevel === 0)) return
    heliLevel = next

    if (next > 0) {
      if (heliTimer !== null) {
        clearTimeout(heliTimer)
        heliTimer = null
      }
      if (!heli) heli = buildHeli()
    }
    if (!heli) return

    const now = ctx.currentTime
    heli.gain.gain.setTargetAtTime(Math.pow(next, 1.2) * HELI_LEVEL, now, 0.25)
    // 越近越亮
    heli.band.frequency.setTargetAtTime(420 + 600 * next, now, 0.4)
    if (next === 0 && heliTimer === null) heliTimer = setTimeout(teardownHeli, HELI_TEARDOWN_MS)
  }

  /* ── 循环心跳：把单次心跳铺进一个周期长度的循环缓冲，采样级精确、不需要定时器 ── */

  const heartBuffer = ctx.createBuffer(1, Math.floor(sr * HEART_PERIOD), sr)
  const beat = renderHeartbeat(sr, createRng(hashSeed('heartbeat-loop')))
  heartBuffer.getChannelData(0).set(beat.subarray(0, Math.min(beat.length, heartBuffer.length)))

  const heartGain = ctx.createGain()
  heartGain.gain.value = 0
  heartGain.connect(output)
  let heartOn = false
  let heartSource: AudioBufferSourceNode | null = null
  let heartFading: AudioBufferSourceNode | null = null

  const setHeartbeat = (on: boolean): void => {
    if (on === heartOn) return
    heartOn = on
    const now = ctx.currentTime
    if (on) {
      // 上一轮还在淡出就直接掌掉，避免两个心跳叠在一起
      if (heartFading) stopQuietly(heartFading)
      heartFading = null
      const source = ctx.createBufferSource()
      source.buffer = heartBuffer
      source.loop = true
      source.connect(heartGain)
      source.onended = () => source.disconnect()
      source.start()
      heartSource = source
      heartGain.gain.setTargetAtTime(HEART_LEVEL, now, 0.08)
    } else {
      heartGain.gain.setTargetAtTime(0, now, 0.12)
      if (heartSource) {
        stopQuietly(heartSource, now + 0.6)
        heartFading = heartSource
      }
      heartSource = null
    }
  }

  const dispose = (): void => {
    if (heliTimer !== null) clearTimeout(heliTimer)
    teardownHeli()
    windSources.forEach((source) => stopQuietly(source))
    windGain.disconnect()
    if (heartSource) stopQuietly(heartSource)
    if (heartFading) stopQuietly(heartFading)
    heartSource = null
    heartFading = null
    heartGain.disconnect()
  }

  return { setHelicopter, setHeartbeat, dispose }
}

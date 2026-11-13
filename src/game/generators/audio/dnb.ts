/**
 * Boss 战背景音乐：Drum and Bass（174 BPM，F 小调）。
 *
 * 鼓：先把一段 4 小节的 Amen 式碎拍（底鼓 / 军鼓 / 鬼音 / 叮叮镲，十六分摇摆）离线合成进一个 AudioBuffer，
 * 做降采样、量化与压缩，模仿“采样来的”颗粒感；播放时按八分音符切片、重排（chopped Amen），
 * 并用播放速率做变调、半速与军鼓滚奏，另备一份反向缓冲用于反向军鼓。
 * 贝斯：两层失谐锯齿波 + 低八度锯齿的 reese，经共享的 LFO 低通与 WaveShaper，和正弦 sub 一起按底鼓侧链压缩。
 * 铺底与主音：暗色长音铺底、和弦断奏、hoover 式滑音齐奏，以及上升噪声、冲击、镲片等预渲染效果。
 *
 * 结构（小节）：前奏 8 小节（压抑的铺底与 sub → 闷住的碎拍 → 滤波打开 + 上升噪声 + 滚奏）后进入 32 小节循环：
 * 0–15 全编制，16–19 半速段，20–23 重新蓄力，24–31 高潮；每段最后一小节加花。
 * 调度由 music.ts 的 lookahead 调度器按步调用 schedule，时间全部基于 AudioContext。
 */

import type { Rng } from '../../utils/random'
import { createRng, hashSeed } from '../../utils/random'
import { addOsc, attackDecay, createBuffer, decay, fadeEdges, filter, mix, noise, noiseBand, normalize, saturate, sweep } from './synth'

export const DNB_BPM = 174
/** 一步（十六分音符）的时长（秒） */
const STEP = 60 / DNB_BPM / 4
const STEPS = 16
const BAR = STEP * STEPS
/** 预渲染碎拍的长度：4 小节 */
const BREAK_STEPS = STEPS * 4
/** 碎拍尾部多留的余响（秒），给最后一刀用 */
const BREAK_TAIL = 0.5
/** 反拍十六分音符的推后量（× 一步） */
const SWING = 0.09
/** 前奏小节数 */
const INTRO_BARS = 8
/** 循环体小节数 */
const LOOP_BARS = 32

const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

const at = <T>(items: readonly T[], index: number): T =>
  items[((index % items.length) + items.length) % items.length] as T

/* ── Amen 式碎拍素材 ── */

/** [小节内步, 力度] */
type Hit = readonly [step: number, velocity: number]

interface BreakBar {
  kick: readonly Hit[]
  snare: readonly Hit[]
  /** 镲片落点（替代该步的叮叮镲） */
  crash?: number
}

/** 经典 4 小节乐句：前两小节相同，第三小节省掉一个底鼓并把军鼓后移，第四小节提前进军鼓并砸镲 */
const AMEN: readonly BreakBar[] = [
  { kick: [[0, 1], [2, 0.9], [10, 0.95], [11, 0.8]], snare: [[4, 1], [7, 0.38], [9, 0.42], [12, 1], [15, 0.38]] },
  { kick: [[0, 1], [2, 0.9], [10, 0.95], [11, 0.8]], snare: [[4, 1], [7, 0.38], [9, 0.42], [12, 1], [15, 0.38]] },
  { kick: [[0, 1], [2, 0.9], [10, 0.95]], snare: [[4, 1], [7, 0.38], [9, 0.42], [14, 0.95]] },
  { kick: [[2, 0.9], [3, 0.75], [10, 0.95]], snare: [[1, 0.8], [4, 1], [7, 0.38], [9, 0.42], [14, 0.95]], crash: 10 },
]

/** 一刀：从碎拍的 src 步开始，在输出的 at 步起播放 len 步（输出时长），rate 为播放速率 */
interface Chop {
  readonly at: number
  readonly src: number
  readonly len: number
  readonly rate: number
  readonly reverse: boolean
  readonly gain: number
}

const chop = (atStep: number, src: number, len = 2, rate = 1, gain = 1, reverse = false): Chop => ({
  at: atStep,
  src,
  len,
  rate,
  reverse,
  gain,
})

/** 按八分音符切片序号（0..31，每片 2 步）拼一小节；-1 为留空 */
const fromSlices = (slices: readonly number[]): readonly Chop[] =>
  slices.flatMap((slice, i) => (slice >= 0 ? [chop(i * 2, slice * 2)] : []))

/** 原样的第 b 小节 */
const STRAIGHT: readonly (readonly Chop[])[] = [0, 1, 2, 3].map((b) =>
  fromSlices([0, 1, 2, 3, 4, 5, 6, 7].map((j) => b * 8 + j)),
)

/** 重排变体 */
const VARIANTS: readonly (readonly Chop[])[] = [
  // 后半小节把第一下底鼓再踩一次
  fromSlices([0, 1, 2, 3, 0, 5, 6, 7]),
  // 两小节交错拼接
  fromSlices([0, 1, 2, 11, 4, 13, 6, 15]),
  // 第三小节的头接第一小节的尾，留一个空拍
  fromSlices([16, 17, 18, 3, -1, 21, 6, 7]),
  // 底鼓连踩 + 提前的军鼓
  fromSlices([0, 0, 2, 3, 8, 9, 2, 6]),
  // 结巴式：军鼓切成十六分重复，最后一下升调
  [
    chop(0, 0),
    chop(2, 2),
    chop(4, 4, 1),
    chop(5, 4, 1, 1.12, 0.8),
    chop(6, 6),
    chop(8, 8),
    chop(10, 10),
    chop(12, 12, 1),
    chop(13, 12, 1, 1, 0.75),
    chop(14, 14, 1),
    chop(15, 4, 1, 1.25, 0.85),
  ],
  // 第四小节的军鼓前移
  fromSlices([0, 1, 26, 3, 4, 29, 6, 31]),
]

/** 半速段：每片以 0.5 倍速播放，军鼓落到第三拍，整体降八度 */
const HALF_TIME: readonly Chop[] = [chop(0, 0, 4, 0.5), chop(4, 2, 4, 0.5, 0.9), chop(8, 4, 4, 0.5), chop(12, 10, 4, 0.5, 0.9)]

/** 加花小节：前半原样，后半军鼓十六分滚奏，最后两步变三十二分并升调；reverse 时最后四步换成反向军鼓 */
function fillChops(source: number, reverse: boolean): readonly Chop[] {
  const chops: Chop[] = [...(STRAIGHT[source] ?? []).filter((c) => c.at < 8)]
  const rollEnd = reverse ? 12 : 14
  for (let s = 8; s < rollEnd; s++) chops.push(chop(s, 4, 1, 1 + (s - 8) * 0.025, 0.55 + (s - 8) * 0.08))
  if (reverse) {
    chops.push(chop(12, 12, 4, 1, 1, true))
  } else {
    for (let k = 0; k < 4; k++) chops.push(chop(14 + k * 0.5, 4, 0.5, 1.15 + k * 0.05, 0.85 + k * 0.05))
  }
  return chops
}

/* ── 和声（F 小调） ── */

interface DnbChord {
  /** sub 的 MIDI 音高（30–60Hz 一带） */
  sub: number
  /** 铺底与断奏的和弦音 */
  tones: readonly number[]
}

const FM: DnbChord = { sub: 29, tones: [53, 56, 60] }
const DB: DnbChord = { sub: 25, tones: [53, 56, 61] }
const EB: DnbChord = { sub: 27, tones: [55, 58, 63] }
const BBM: DnbChord = { sub: 34, tones: [53, 58, 61] }
const C: DnbChord = { sub: 24, tones: [55, 60, 64] }

/** 16 小节进行，每个和弦 2 小节 */
const PROGRESSION: readonly DnbChord[] = [FM, FM, DB, EB, FM, FM, BBM, C]

/** reese 音型：[起始步, 相对根音的半音, 时值（步）]，单双小节交替 */
type BassNote = readonly [step: number, offset: number, length: number]
const BASS_A: readonly BassNote[] = [
  [0, 0, 5.5],
  [6, 0, 1.5],
  [8, 12, 1],
  [10, 0, 3.5],
  [14, 3, 2],
]
const BASS_B: readonly BassNote[] = [
  [0, 0, 3],
  [3, 0, 2.5],
  [7, 0, 1],
  [8, 7, 3.5],
  [12, 5, 2],
  [14, 3, 2],
]

/** 断奏落点 */
const STAB_STEPS: readonly number[] = [6, 10, 14]

/* ── 预渲染素材 ── */

export interface DnbAssets {
  /** 4 小节碎拍 */
  breakBeat: AudioBuffer
  /** 同一段碎拍的反向版本 */
  reversed: AudioBuffer
  /** 4 小节上升噪声 */
  riser: AudioBuffer
  impact: AudioBuffer
  crash: AudioBuffer
  /** 碎拍里每一步有没有底鼓（侧链压缩用） */
  kickAt: readonly boolean[]
}

function renderKick(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.35)
  addOsc(out, sr, 'sine', sweep(190, 48, 0.07), decay(0.12))
  // 鼓槌：一个短促的中频音头 + 高频噪声咔嗒
  addOsc(out, sr, 'sine', 1100, (t) => 0.25 * Math.exp(-t / 0.004))
  mix(out, sr, noiseBand(sr, rng, 0.02, 'highpass', 3000, 0.7, decay(0.0025)), 0.45)
  saturate(out, 1.8)
  return normalize(fadeEdges(out, sr, 0, 0.03), 0.95)
}

/** 军鼓：鼓皮的两个音 + 响弦噪声 + 明亮的“啪” + 一次早期反射（小房间）。ghost 为轻敲版本 */
function renderSnare(sr: number, rng: Rng, ghost: boolean): Float32Array {
  const out = createBuffer(sr, 0.4)
  addOsc(out, sr, 'sine', sweep(205, 180, 0.04), (t) => 0.7 * Math.exp(-t / 0.05))
  addOsc(out, sr, 'sine', 335, (t) => 0.35 * Math.exp(-t / 0.03))
  mix(out, sr, noiseBand(sr, rng, 0.3, 'bandpass', 2300, 0.8, decay(ghost ? 0.05 : 0.09)), 1)
  mix(out, sr, noiseBand(sr, rng, 0.08, 'highpass', 6000, 0.7, decay(0.015)), ghost ? 0.25 : 0.65)
  const room = out.slice()
  filter(room, sr, 'lowpass', 3500, 0.7)
  mix(out, sr, room, 0.22, 0.017)
  mix(out, sr, room, 0.12, 0.031)
  saturate(out, ghost ? 1.2 : 1.6)
  return normalize(fadeEdges(out, sr, 0, 0.04), 0.95)
}

/** 叮叮镲：六个不和谐方波的金属团块 → 高通 + 带通，加一点噪声“叮” */
function renderRide(sr: number, rng: Rng, seconds: number, tau: number): Float32Array {
  const out = createBuffer(sr, seconds)
  const ratios = [1, 1.342, 1.716, 2.093, 2.551, 3.012]
  const base = rng.range(395, 415)
  ratios.forEach((r) => addOsc(out, sr, 'square', base * r * 2, 0.16, 0, Infinity, rng.next()))
  filter(out, sr, 'highpass', 5200, 0.7)
  filter(out, sr, 'bandpass', 8800, 0.9)
  normalize(out, 1)
  const body = decay(tau)
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * body(i / sr)
  mix(out, sr, noiseBand(sr, rng, 0.05, 'highpass', 7000, 0.7, decay(0.008)), 0.4)
  return normalize(fadeEdges(out, sr, 0, 0.02), 0.85)
}

/** 离线压缩：包络跟随 + 固定比率，把碎拍压紧 */
function compress(data: Float32Array, sr: number, threshold: number, ratio: number, attack: number, release: number): void {
  const a = Math.exp(-1 / (attack * sr))
  const r = Math.exp(-1 / (release * sr))
  let env = 0
  for (let i = 0; i < data.length; i++) {
    const x = Math.abs(data[i] as number)
    env = x > env ? a * env + (1 - a) * x : r * env + (1 - r) * x
    if (env > threshold) data[i] = (data[i] as number) * ((threshold + (env - threshold) / ratio) / env)
  }
}

/** 采样器颗粒感：采样保持降采样 + 位深量化 */
function grit(data: Float32Array, hold: number, bits: number): void {
  const levels = Math.pow(2, bits - 1)
  let held = 0
  for (let i = 0; i < data.length; i++) {
    if (i % hold === 0) held = Math.round((data[i] as number) * levels) / levels
    data[i] = held
  }
}

/**
 * 预渲染 Drum and Bass 用到的缓冲（约 4 小节碎拍 + 上升噪声 + 冲击 + 镲片）。
 * @param ctx 用来创建 AudioBuffer 的上下文
 */
export function renderDnbAssets(ctx: BaseAudioContext): DnbAssets {
  const sr = ctx.sampleRate
  const rng = createRng(hashSeed('cis2-dnb-break'))
  const toBuffer = (data: Float32Array): AudioBuffer => {
    const buffer = ctx.createBuffer(1, data.length, sr)
    buffer.getChannelData(0).set(data)
    return buffer
  }

  const kick = renderKick(sr, rng)
  const snare = renderSnare(sr, rng, false)
  const ghost = renderSnare(sr, rng, true)
  const rides = [renderRide(sr, rng, 0.5, 0.12), renderRide(sr, rng, 0.5, 0.1)]
  const crash = renderRide(sr, rng, 1.8, 0.55)
  mix(crash, sr, noiseBand(sr, rng, 1.8, 'highpass', 3500, 0.7, attackDecay(0.002, 0.5)), 0.6)
  normalize(crash, 0.85)

  const kickAt: boolean[] = new Array<boolean>(BREAK_STEPS).fill(false)
  const beat = createBuffer(sr, BREAK_STEPS * STEP + BREAK_TAIL)
  const place = (sample: Float32Array, step: number, gain: number): void => {
    // 偶数步只往后微调，保证每一刀的起点不会切掉音头
    const t = step * STEP + (step % 2 === 1 ? SWING * STEP : 0) + rng.range(0, 0.0025)
    mix(beat, sr, sample, gain * rng.range(0.92, 1.04), t)
  }
  AMEN.forEach((bar, b) => {
    const base = b * STEPS
    bar.kick.forEach(([s, v]) => {
      place(kick, base + s, v)
      kickAt[base + s] = true
    })
    bar.snare.forEach(([s, v]) => place(v < 0.6 ? ghost : snare, base + s, v < 0.6 ? v * 1.3 : v * 0.9))
    for (let s = 0; s < STEPS; s += 2) {
      if (s === bar.crash) continue
      place(rides[(s / 2) % 2] as Float32Array, base + s, s % 4 === 0 ? 0.32 : 0.22)
    }
    if (bar.crash !== undefined) place(crash, base + bar.crash, 0.45)
  })
  saturate(beat, 1.35)
  compress(beat, sr, 0.35, 4, 0.001, 0.06)
  grit(beat, 2, 12)
  filter(beat, sr, 'lowpass', 12500, 0.7)
  normalize(beat, 0.95)
  const reversed = beat.slice().reverse()

  // 上升噪声：4 小节，带通从 300Hz 扫到 9kHz，音量平方上升，叠一条上滑的正弦
  const riseSeconds = BAR * 4
  const riser = noise(sr, riseSeconds, rng)
  filter(riser, sr, 'bandpass', sweep(300, 9000, riseSeconds), 2.2)
  normalize(riser, 1)
  addOsc(riser, sr, 'sine', sweep(110, 880, riseSeconds), 0.25)
  for (let i = 0; i < riser.length; i++) {
    const k = i / riser.length
    riser[i] = (riser[i] as number) * k * k
  }
  normalize(fadeEdges(riser, sr, 0.05, 0.01), 0.8)

  const impact = createBuffer(sr, 1.6)
  addOsc(impact, sr, 'sine', sweep(130, 30, 0.45), decay(0.45))
  mix(impact, sr, noiseBand(sr, rng, 1.2, 'lowpass', sweep(3000, 120, 0.35), 0.8, decay(0.14)), 0.8)
  saturate(impact, 2)
  normalize(fadeEdges(impact, sr, 0, 0.1), 0.95)

  return {
    breakBeat: toBuffer(beat),
    reversed: toBuffer(reversed),
    riser: toBuffer(riser),
    impact: toBuffer(impact),
    crash: toBuffer(crash),
    kickAt,
  }
}

/* ── 播放 ── */

export interface DnbParts {
  stepDur: number
  schedule: (step: number, time: number) => void
  sustained: AudioScheduledSourceNode[]
}

type Phase = 'intro' | 'full' | 'half' | 'rebuild' | 'peak'

/** 各段 reese 低通的中心频率（Hz），LFO 在其上下摆动 */
const BASS_CUTOFF: Record<Phase, number> = { intro: 260, full: 650, half: 380, rebuild: 450, peak: 950 }
/** 各段铺底的音量倍率 */
const PAD_LEVEL: Record<Phase, number> = { intro: 1, full: 0.45, half: 1.2, rebuild: 0.8, peak: 0.55 }

/**
 * 搭建一首 Drum and Bass 的节点图并返回调度回调。
 * @param ctx 音频上下文（实时或离线）
 * @param out 本曲的输出（music.ts 负责淡入淡出与音量）
 * @param reverb 共享混响的输入（铺底与主音发送更多）
 * @param rng 本次播放的随机（加花与切片变体）
 * @param assets renderDnbAssets 的结果
 */
export function buildDnb(ctx: BaseAudioContext, out: AudioNode, reverb: AudioNode, rng: Rng, assets: DnbAssets): DnbParts {
  const gainNode = (value: number): GainNode => {
    const node = ctx.createGain()
    node.gain.value = value
    return node
  }
  const lowpass = (freq: number, q: number): BiquadFilterNode => {
    const node = ctx.createBiquadFilter()
    node.type = 'lowpass'
    node.frequency.value = freq
    node.Q.value = q
    return node
  }

  // 鼓总线：低通（前奏与蓄力时扫开）→ 压缩 → 输出
  const drumBus = gainNode(1)
  const drumFilter = lowpass(300, 0.9)
  const drumComp = ctx.createDynamicsCompressor()
  drumComp.threshold.value = -16
  drumComp.knee.value = 4
  drumComp.ratio.value = 5
  drumComp.attack.value = 0.002
  drumComp.release.value = 0.09
  const drumLevel = gainNode(0.8)
  drumBus.connect(drumFilter)
  drumFilter.connect(drumComp)
  drumComp.connect(drumLevel)
  drumLevel.connect(out)

  // 贝斯：reese → 共享低通（LFO）→ 失真 → 电平 → 侧链；sub 直接进侧链
  const duck = gainNode(1)
  duck.connect(out)
  const bassFilter = lowpass(BASS_CUTOFF.intro, 4)
  const shaper = ctx.createWaveShaper()
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * 2.4) / Math.tanh(2.4)
  }
  shaper.curve = curve
  shaper.oversample = '2x'
  const bassLevel = gainNode(0.3)
  bassFilter.connect(shaper)
  shaper.connect(bassLevel)
  bassLevel.connect(duck)
  const subLevel = gainNode(0.42)
  subLevel.connect(duck)

  const lfo = ctx.createOscillator()
  lfo.frequency.value = 1 / (BAR * 2)
  const lfoDepth = gainNode(320)
  lfo.connect(lfoDepth)
  lfoDepth.connect(bassFilter.frequency)
  lfo.start()

  // 铺底与主音：各自带混响发送
  const padFilter = lowpass(850, 0.6)
  const padLevel = gainNode(1)
  padFilter.connect(padLevel)
  padLevel.connect(out)
  const padSend = gainNode(0.6)
  padLevel.connect(padSend)
  padSend.connect(reverb)
  const leadBus = gainNode(1)
  leadBus.connect(out)
  const leadSend = gainNode(0.35)
  leadBus.connect(leadSend)
  leadSend.connect(reverb)
  const fxBus = gainNode(1)
  fxBus.connect(out)
  const fxSend = gainNode(0.25)
  fxBus.connect(fxSend)
  fxSend.connect(reverb)

  /* ── 声源 ── */

  const playBuffer = (buffer: AudioBuffer, dest: AudioNode, time: number, gain: number): void => {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const level = gainNode(gain)
    source.connect(level)
    level.connect(dest)
    source.onended = () => level.disconnect()
    source.start(time)
  }

  let lastDuck = 0
  /** 侧链：底鼓落点把贝斯压下去再放开 */
  const duckAt = (time: number): void => {
    if (time < lastDuck + 0.05) return
    lastDuck = time
    duck.gain.setTargetAtTime(0.22, time, 0.004)
    duck.gain.setTargetAtTime(1, time + 0.035, 0.07)
  }

  const breakSeconds = assets.breakBeat.duration
  /** 播放一刀：从碎拍（或反向碎拍）的 src 步起，输出 len 步，带 1.5ms 的起止淡变避免爆音 */
  const playChop = (c: Chop, time: number, gain: number, kicks: boolean): void => {
    const length = c.len * STEP
    const sourceSpan = length * c.rate
    const offset = c.reverse ? breakSeconds - (c.src * STEP + sourceSpan) : c.src * STEP
    if (offset < 0 || offset >= breakSeconds) return
    const source = ctx.createBufferSource()
    source.buffer = c.reverse ? assets.reversed : assets.breakBeat
    source.playbackRate.value = c.rate
    const level = ctx.createGain()
    const peak = gain * c.gain
    level.gain.setValueAtTime(0, time)
    level.gain.linearRampToValueAtTime(peak, time + 0.0015)
    level.gain.setValueAtTime(peak, time + length - 0.004)
    level.gain.linearRampToValueAtTime(0, time + length)
    source.connect(level)
    level.connect(drumBus)
    source.onended = () => level.disconnect()
    source.start(time, offset)
    source.stop(time + length + 0.005)

    if (!kicks || c.reverse) return
    // 这一刀覆盖到的源步里有底鼓：按播放速率换算到输出时间做侧链
    const covered = Math.ceil(sourceSpan / STEP)
    for (let k = 0; k < covered; k++) {
      if (assets.kickAt[c.src + k]) duckAt(time + (k * STEP) / c.rate)
    }
  }

  /** reese：两层 ±16 音分的锯齿 + 低八度锯齿，进共享低通 */
  const reese = (time: number, midi: number, steps: number): void => {
    const hold = steps * STEP
    const end = time + hold + 0.06
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, time)
    env.gain.linearRampToValueAtTime(0.33, time + 0.008)
    env.gain.setValueAtTime(0.33, time + hold)
    env.gain.linearRampToValueAtTime(0, end)
    env.connect(bassFilter)
    const f = hz(midi)
    const voices: readonly (readonly [freq: number, cents: number])[] = [
      [f, -16],
      [f, 16],
      [f / 2, 7],
    ]
    voices.forEach(([freq, cents], i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = freq
      osc.detune.value = cents
      osc.connect(env)
      osc.start(time)
      osc.stop(end + 0.02)
      if (i === 0) osc.onended = () => env.disconnect()
    })
  }

  const sub = (time: number, midi: number, steps: number, gain = 0.9): void => {
    const hold = steps * STEP
    const end = time + hold + 0.05
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, time)
    env.gain.linearRampToValueAtTime(gain, time + 0.006)
    env.gain.setValueAtTime(gain, time + hold)
    env.gain.linearRampToValueAtTime(0, end)
    env.connect(subLevel)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = hz(midi)
    osc.connect(env)
    osc.onended = () => env.disconnect()
    osc.start(time)
    osc.stop(end + 0.02)
  }

  /** 暗色铺底：每个和弦音两层失谐锯齿，慢起慢落 */
  const pad = (time: number, chord: DnbChord, bars: number, level: number): void => {
    const hold = bars * BAR - 0.6
    const end = time + hold + 1.4
    chord.tones.forEach((midi) => {
      const env = ctx.createGain()
      const peak = 0.03 * level
      env.gain.setValueAtTime(0, time)
      env.gain.linearRampToValueAtTime(peak, time + 1.1)
      env.gain.setValueAtTime(peak, time + hold)
      env.gain.linearRampToValueAtTime(0, end)
      env.connect(padFilter)
      ;[-9, 9].forEach((cents, i) => {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = hz(midi)
        osc.detune.value = cents
        osc.connect(env)
        osc.start(time)
        osc.stop(end + 0.02)
        if (i === 0) osc.onended = () => env.disconnect()
      })
    })
  }

  /** hoover：一簇大幅失谐的锯齿 + 低八度，起音从低处滑上来，收尾往下掉 */
  const hoover = (time: number, midi: number, steps: number, gain: number): void => {
    const hold = steps * STEP
    const end = time + hold + 0.25
    const f = hz(midi)
    const tone = lowpass(2600, 1.2)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, time)
    env.gain.linearRampToValueAtTime(gain, time + 0.03)
    env.gain.setValueAtTime(gain, time + hold)
    env.gain.linearRampToValueAtTime(0, end)
    tone.connect(env)
    env.connect(leadBus)
    const voices: readonly (readonly [ratio: number, cents: number])[] = [
      [1, -35],
      [1, -12],
      [1, 12],
      [1, 35],
      [0.5, 0],
    ]
    voices.forEach(([ratio, cents], i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.detune.value = cents
      osc.frequency.setValueAtTime(f * ratio * 0.7, time)
      osc.frequency.exponentialRampToValueAtTime(f * ratio, time + 0.16)
      osc.frequency.setValueAtTime(f * ratio, time + hold)
      osc.frequency.exponentialRampToValueAtTime(f * ratio * 0.84, end)
      osc.connect(tone)
      osc.start(time)
      osc.stop(end + 0.02)
      if (i === 0) osc.onended = () => env.disconnect()
    })
  }

  /** 和弦断奏：短促、滤波快速收拢 */
  const stab = (time: number, chord: DnbChord, gain: number): void => {
    const end = time + 0.2
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.Q.value = 2
    tone.frequency.setValueAtTime(3600, time)
    tone.frequency.exponentialRampToValueAtTime(380, time + 0.16)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, time)
    env.gain.linearRampToValueAtTime(gain, time + 0.003)
    env.gain.setValueAtTime(gain, time + 0.1)
    env.gain.linearRampToValueAtTime(0, end)
    tone.connect(env)
    env.connect(leadBus)
    let first = true
    chord.tones.forEach((midi) => {
      ;[-7, 7].forEach((cents) => {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = hz(midi + 12)
        osc.detune.value = cents
        osc.connect(tone)
        osc.start(time)
        osc.stop(end + 0.02)
        if (first) osc.onended = () => env.disconnect()
        first = false
      })
    })
  }

  /* ── 编排 ── */

  let currentBar = -1
  let phase: Phase = 'intro'
  let loopBar = 0
  let chord: DnbChord = FM
  let chops: readonly Chop[] = []
  let drumGain = 1
  let isFill = false
  /** 当前 4 小节组里各小节用的切片（每组开头重新抽） */
  let group: readonly (readonly Chop[])[] = STRAIGHT

  const phaseOf = (bar: number): Phase => {
    if (bar < INTRO_BARS) return 'intro'
    const lb = (bar - INTRO_BARS) % LOOP_BARS
    if (lb < 16) return 'full'
    if (lb < 20) return 'half'
    if (lb < 24) return 'rebuild'
    return 'peak'
  }

  /** 每 4 小节抽一组切片：第一小节多半原样，中间两小节按概率换成变体，第四小节保留砸镲的原样 */
  const pickGroup = (busy: boolean): readonly (readonly Chop[])[] => {
    const odds = busy ? 0.7 : 0.4
    return [0, 1, 2, 3].map((b) => {
      const straight = STRAIGHT[b] ?? []
      if (b === 3) return straight
      if (b === 0 && !busy) return straight
      return rng.chance(odds) ? rng.pick(VARIANTS) : straight
    })
  }

  /** 进入新小节：决定段落、切片、自动化与长音 */
  const startBar = (bar: number, time: number): void => {
    currentBar = bar
    const previous = phase
    phase = phaseOf(bar)
    loopBar = bar < INTRO_BARS ? bar : (bar - INTRO_BARS) % LOOP_BARS
    const intro = phase === 'intro'
    chord = intro ? FM : at(PROGRESSION, Math.floor((loopBar % 16) / 2))
    const dropNext = (intro && bar === INTRO_BARS - 1) || (!intro && loopBar === 23)
    isFill = dropNext || (!intro && (loopBar === 15 || loopBar === 31))
    const drop = (!intro && (loopBar === 0 || loopBar === 24)) || (!intro && previous === 'intro')

    // 鼓
    if (!intro && loopBar % 4 === 0) group = pickGroup(phase === 'peak')
    if (intro) {
      if (bar < 2) chops = []
      else chops = isFill ? fillChops(3, true) : at(STRAIGHT, bar)
    } else if (phase === 'half') {
      chops = HALF_TIME
    } else if (isFill) {
      chops = fillChops(3, dropNext)
    } else {
      chops = at(group, loopBar)
    }
    drumGain = intro ? 0.8 : phase === 'half' ? 0.9 : 1

    // 鼓的低通：前奏闷住再在后 4 小节扫开；蓄力段重新扫一次；其余全开
    const open = 20000
    if (intro) {
      if (bar === 2) drumFilter.frequency.setValueAtTime(300, time)
      if (bar === 4) {
        drumFilter.frequency.setValueAtTime(300, time)
        drumFilter.frequency.exponentialRampToValueAtTime(7000, time + BAR * 4)
      }
    } else if (phase === 'rebuild') {
      if (loopBar === 20) {
        drumFilter.frequency.setValueAtTime(450, time)
        drumFilter.frequency.exponentialRampToValueAtTime(16000, time + BAR * 4)
      }
    } else {
      drumFilter.frequency.setValueAtTime(open, time)
    }

    // 贝斯低通中心随段落变化
    bassFilter.frequency.setTargetAtTime(BASS_CUTOFF[phase], time, 0.4)

    // 效果：Boss 登场的冲击、落拍的冲击 + 镲、上升噪声
    if (bar === 0) {
      playBuffer(assets.impact, fxBus, time, 0.9)
      playBuffer(assets.crash, fxBus, time, 0.35)
    }
    if (drop) {
      playBuffer(assets.impact, fxBus, time, 0.8)
      playBuffer(assets.crash, fxBus, time, 0.45)
    } else if (!intro && phase !== 'half' && loopBar % 8 === 0) {
      playBuffer(assets.crash, fxBus, time, 0.3)
    }
    if (!intro && loopBar === 16) playBuffer(assets.impact, fxBus, time, 0.6)
    if ((intro && bar === 4) || (!intro && loopBar === 20)) playBuffer(assets.riser, fxBus, time, 0.5)

    // 长音：铺底跟和弦走（每 2 小节，前奏每 4 小节），前奏与半速段配 sub 长音
    if (intro) {
      if (bar % 4 === 0) {
        pad(time, FM, 4, PAD_LEVEL.intro)
        sub(time, FM.sub, STEPS * 4 - 1, 0.7)
      }
    } else if (loopBar % 2 === 0) {
      pad(time, chord, 2, PAD_LEVEL[phase])
      if (phase === 'half') {
        sub(time, chord.sub, STEPS * 2 - 1)
        reese(time, chord.sub + 12, STEPS * 2 - 2)
        hoover(time, chord.sub + 24, STEPS + 8, 0.05)
      }
    }
  }

  const schedule = (step: number, time: number): void => {
    const s = step % STEPS
    const bar = Math.floor(step / STEPS)
    if (bar !== currentBar) startBar(bar, time - s * STEP)

    // 鼓：这一步起始的刀（含三十二分音符的半步偏移）
    for (const c of chops) {
      if (Math.floor(c.at) === s) playChop(c, time + (c.at - s) * STEP, drumGain, phase !== 'intro')
    }

    if (phase === 'intro' || phase === 'half') return

    // 贝斯：加花小节后半让出空间
    if (!(isFill && s >= 8)) {
      const pattern = bar % 2 === 0 ? BASS_A : BASS_B
      for (const note of pattern) {
        if (note[0] !== s) continue
        reese(time, chord.sub + 12 + note[1], note[2])
        sub(time, chord.sub + (note[1] >= 12 ? note[1] - 12 : note[1]), note[2])
      }
    }

    // 主音：全编制段偶尔断奏；高潮段每 2 小节一声 hoover + 更密的断奏
    if (phase === 'full' && loopBar % 4 === 2 && STAB_STEPS.includes(s)) stab(time, chord, 0.045)
    if (phase === 'peak') {
      if (loopBar % 2 === 0 && s === 0) hoover(time, chord.sub + 24, 6, 0.045)
      if (loopBar % 2 === 1 && STAB_STEPS.includes(s)) stab(time, chord, 0.05)
    }
  }

  return { stepDur: STEP, schedule, sustained: [lfo] }
}

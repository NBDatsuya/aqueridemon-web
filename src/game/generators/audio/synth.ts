/**
 * 离线合成工具：直接往 Float32Array 里写样本，供一次性音效与打击乐预渲染使用。
 * 全部是纯函数，不依赖 AudioContext；随机数来自种子 Rng，同一种子结果可复现。
 * 约定：sr 为采样率（Hz），时间单位为秒。
 */

import { clamp } from '../../utils/math'
import type { Rng } from '../../utils/random'

/** 以秒为自变量的控制曲线（包络、扫频等） */
export type Envelope = (t: number) => number
/** 参数：常数或控制曲线。曲线按控制率求值后线性插值 */
export type Param = number | Envelope
export type Wave = 'sine' | 'saw' | 'square' | 'triangle'
export type FilterKind = 'lowpass' | 'highpass' | 'bandpass'
/** 渲染结果：单声道，或 [左, 右] 两个声道 */
export type Rendered = Float32Array | Float32Array[]

const TWO_PI = Math.PI * 2
/** 控制率：每多少个样本对 Param 求值一次 */
const BLOCK = 16

const valueAt = (p: Param, t: number): number => (typeof p === 'number' ? p : p(t))

/* ── 包络与控制曲线 ── */

/**
 * 指数衰减包络。
 * @param tau 时间常数（秒）
 */
export function decay(tau: number): Envelope {
  return (t) => Math.exp(-t / tau)
}

/**
 * 线性起音 + 指数衰减。
 * @param attack 起音时长（秒）
 * @param tau 衰减时间常数（秒）
 */
export function attackDecay(attack: number, tau: number): Envelope {
  return (t) => (t < attack ? t / attack : Math.exp(-(t - attack) / tau))
}

/**
 * 梯形包络：线性起音、保持、二次曲线释音。
 * @param attack 起音时长
 * @param hold 保持时长
 * @param release 释音时长
 */
export function trapezoid(attack: number, hold: number, release: number): Envelope {
  return (t) => {
    if (t < attack) return t / attack
    if (t < attack + hold) return 1
    const r = 1 - (t - attack - hold) / release
    return r > 0 ? r * r : 0
  }
}

/**
 * 指数扫频：seconds 秒内从 from 滑到 to，之后保持 to。
 */
export function sweep(from: number, to: number, seconds: number): Envelope {
  const ratio = to / from
  return (t) => from * Math.pow(ratio, clamp(t / seconds, 0, 1))
}

/**
 * 钟形（高斯）包络。
 * @param center 峰值时刻
 * @param width 宽度（标准差量级）
 */
export function bell(center: number, width: number): Envelope {
  return (t) => {
    const x = (t - center) / width
    return Math.exp(-x * x)
  }
}

/**
 * 平滑的低频随机曲线，取值约 [-1, 1]，用于音高 / 音量的不规则抖动。
 * @param rate 每秒随机控制点数量
 */
export function slowRandom(rng: Rng, seconds: number, rate: number): Envelope {
  const count = Math.ceil(seconds * rate) + 2
  const points = new Float32Array(count)
  for (let i = 0; i < count; i++) points[i] = rng.range(-1, 1)
  return (t) => {
    const x = clamp(t * rate, 0, count - 1.001)
    const i = Math.floor(x)
    const k = x - i
    const a = points[i] as number
    const b = points[i + 1] as number
    return a + (b - a) * k * k * (3 - 2 * k)
  }
}

/* ── 基础信号 ── */

/** 创建指定时长的静音缓冲 */
export function createBuffer(sr: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.ceil(sr * seconds)))
}

/** PolyBLEP 残差：抹平锯齿波 / 方波跳变处的混叠 */
function polyBlep(phase: number, dt: number): number {
  if (dt <= 0) return 0
  if (phase < dt) {
    const x = phase / dt
    return x + x - x * x - 1
  }
  if (phase > 1 - dt) {
    const x = (phase - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

function waveSample(wave: Wave, phase: number, dt: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(TWO_PI * phase)
    case 'saw':
      return 2 * phase - 1 - polyBlep(phase, dt)
    case 'square': {
      const half = phase + 0.5
      return (phase < 0.5 ? 1 : -1) + polyBlep(phase, dt) - polyBlep(half >= 1 ? half - 1 : half, dt)
    }
    case 'triangle': {
      // 相位偏移 1/4 周期，让波形从 0 起振，避免起音爆点
      const shifted = phase + 0.25
      return 1 - 4 * Math.abs((shifted >= 1 ? shifted - 1 : shifted) - 0.5)
    }
  }
}

/**
 * 把一个振荡器叠加进 out。freq / amp 的时间自变量从 start 起算。
 * @param start 起始时刻（秒）
 * @param seconds 持续时长；默认写到缓冲末尾
 * @param phase 初始相位 0..1
 */
export function addOsc(
  out: Float32Array,
  sr: number,
  wave: Wave,
  freq: Param,
  amp: Param,
  start = 0,
  seconds = Infinity,
  phase = 0,
): void {
  const from = Math.max(0, Math.floor(start * sr))
  const to = seconds === Infinity ? out.length : Math.min(out.length, from + Math.ceil(seconds * sr))
  let ph = phase - Math.floor(phase)
  let f1 = valueAt(freq, 0)
  let a1 = valueAt(amp, 0)
  for (let i = from; i < to; i += BLOCK) {
    const n = Math.min(BLOCK, to - i)
    const t = (i + n - from) / sr
    const f0 = f1
    const a0 = a1
    f1 = valueAt(freq, t)
    a1 = valueAt(amp, t)
    const df = (f1 - f0) / n
    const da = (a1 - a0) / n
    for (let j = 0; j < n; j++) {
      const dt = (f0 + df * j) / sr
      out[i + j] = (out[i + j] as number) + (a0 + da * j) * waveSample(wave, ph, dt)
      ph += dt
      if (ph >= 1) ph -= 1
      else if (ph < 0) ph += 1
    }
  }
}

/** 生成一段单振荡器音色 */
export function tone(sr: number, seconds: number, wave: Wave, freq: Param, env: Param = 1): Float32Array {
  const out = createBuffer(sr, seconds)
  addOsc(out, sr, wave, freq, env)
  return out
}

/** 生成白噪声，取值 [-1, 1] */
export function noise(sr: number, seconds: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, seconds)
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1
  return out
}

/* ── 处理 ── */

/**
 * 原地做二阶滤波（RBJ biquad）。freq 可随时间变化（滤波扫描）。
 * @param q 品质因数；带通时越大越窄
 */
export function filter(data: Float32Array, sr: number, kind: FilterKind, freq: Param, q = 0.707): Float32Array {
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let a1 = 0
  let a2 = 0
  const setCoefficients = (f: number): void => {
    const w = (TWO_PI * clamp(f, 10, sr * 0.45)) / sr
    const cos = Math.cos(w)
    const alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    if (kind === 'lowpass') {
      b1 = (1 - cos) / a0
      b0 = b1 / 2
      b2 = b0
    } else if (kind === 'highpass') {
      b1 = -(1 + cos) / a0
      b0 = -b1 / 2
      b2 = b0
    } else {
      b0 = alpha / a0
      b1 = 0
      b2 = -b0
    }
    a1 = (-2 * cos) / a0
    a2 = (1 - alpha) / a0
  }

  const dynamic = typeof freq !== 'number'
  setCoefficients(valueAt(freq, 0))
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < data.length; i++) {
    if (dynamic && i % BLOCK === 0) setCoefficients(valueAt(freq, i / sr))
    const x = data[i] as number
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    data[i] = y
  }
  return data
}

/** 原地乘上包络 */
export function applyEnv(data: Float32Array, sr: number, env: Envelope): Float32Array {
  let e1 = env(0)
  for (let i = 0; i < data.length; i += BLOCK) {
    const n = Math.min(BLOCK, data.length - i)
    const e0 = e1
    e1 = env((i + n) / sr)
    const de = (e1 - e0) / n
    for (let j = 0; j < n; j++) data[i + j] = (data[i + j] as number) * (e0 + de * j)
  }
  return data
}

/**
 * 把 src 叠加进 dst。
 * @param gain 增益
 * @param start src 在 dst 中的起始时刻（秒）
 */
export function mix(dst: Float32Array, sr: number, src: Float32Array, gain = 1, start = 0): void {
  const offset = Math.max(0, Math.floor(start * sr))
  const n = Math.min(src.length, dst.length - offset)
  for (let i = 0; i < n; i++) dst[offset + i] = (dst[offset + i] as number) + (src[i] as number) * gain
}

/** 原地归一化到指定峰值 */
export function normalize(data: Float32Array, peak = 0.9): Float32Array {
  let max = 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i] as number)
    if (v > max) max = v
  }
  if (max > 1e-6) {
    const k = peak / max
    for (let i = 0; i < data.length; i++) data[i] = (data[i] as number) * k
  }
  return data
}

/** 原地做 tanh 饱和失真；amount 越大越脏、越厚 */
export function saturate(data: Float32Array, amount: number): Float32Array {
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh((data[i] as number) * amount)
  return data
}

/** 原地在首尾做线性淡入淡出，避免爆音 */
export function fadeEdges(data: Float32Array, sr: number, fadeIn = 0.001, fadeOut = 0.01): Float32Array {
  const nIn = Math.min(data.length, Math.floor(fadeIn * sr))
  const nOut = Math.min(data.length, Math.floor(fadeOut * sr))
  for (let i = 0; i < nIn; i++) data[i] = ((data[i] as number) * i) / nIn
  for (let i = 0; i < nOut; i++) {
    const idx = data.length - 1 - i
    data[idx] = ((data[idx] as number) * i) / nOut
  }
  return data
}

/** 原地叠加反馈延迟（梳状回声） */
export function comb(data: Float32Array, sr: number, delay: number, feedback: number): Float32Array {
  const d = Math.max(1, Math.round(delay * sr))
  for (let i = d; i < data.length; i++) data[i] = (data[i] as number) + (data[i - d] as number) * feedback
  return data
}

/**
 * 用左右声道的微小延迟（Haas 效应）把单声道展宽成立体声。
 * @param delay 右声道延迟（秒）
 */
export function haas(mono: Float32Array, sr: number, delay: number): Float32Array[] {
  const d = Math.min(mono.length, Math.max(1, Math.round(delay * sr)))
  const right = new Float32Array(mono.length)
  for (let i = d; i < mono.length; i++) right[i] = (mono[i - d] as number) * 0.92
  return [mono, right]
}

/* ── 常用音色层 ── */

/**
 * 一段滤波后的噪声：白噪声 → 滤波 → 归一化 → 包络。
 */
export function noiseBand(
  sr: number,
  rng: Rng,
  seconds: number,
  kind: FilterKind,
  freq: Param,
  q: number,
  env: Envelope,
): Float32Array {
  const out = noise(sr, seconds, rng)
  filter(out, sr, kind, freq, q)
  normalize(out, 1)
  return applyEnv(out, sr, env)
}

/**
 * 金属碰撞的短促“咔”声：窄带噪声 + 两个不和谐泛音。
 * @param freq 中心频率
 */
export function metalClick(sr: number, rng: Rng, freq: number, seconds: number): Float32Array {
  const out = noiseBand(sr, rng, seconds, 'bandpass', freq, 4, decay(seconds / 6))
  addOsc(out, sr, 'sine', freq * 0.62, (t) => 0.5 * Math.exp(-t / (seconds / 4)))
  addOsc(out, sr, 'sine', freq * 1.47, (t) => 0.35 * Math.exp(-t / (seconds / 7)))
  return out
}

/**
 * 低频撞击：正弦下扫 + 低通噪声。
 * @param from 起始频率
 * @param to 结束频率
 * @param tau 衰减时间常数
 * @param noiseCutoff 噪声层低通截止频率
 */
export function thud(
  sr: number,
  rng: Rng,
  seconds: number,
  from: number,
  to: number,
  tau: number,
  noiseCutoff: number,
): Float32Array {
  const out = createBuffer(sr, seconds)
  addOsc(out, sr, 'sine', sweep(from, to, tau * 2.2), decay(tau))
  const slap = noiseBand(sr, rng, Math.min(seconds, tau * 4), 'lowpass', noiseCutoff, 0.8, attackDecay(0.003, tau * 0.5))
  mix(out, sr, slap, 0.7)
  return out
}

/**
 * 生物音效：普通丧尸、快速丧尸、坦克丧尸与 Boss（阿奎尔巨兽）。
 * Boss 的叫声用“声带源（锯齿波）+ LFO 颤音 + 共振峰带通 + 振幅调制粗糙度”的模型（vocal）合成；
 * 三种丧尸用更细的 zombieVoice：带抖动的声带源 + 次谐波（气泡音）+ 随时间滑动的元音共振峰
 * + 不规则喉部颤动 + 湿润的咕噜气泡，靠基频、元音、粗糙度区分种类。
 */

import type { Rng } from '../../utils/random'
import type { Envelope, Wave } from './synth'
import {
  addOsc,
  applyEnv,
  attackDecay,
  bell,
  comb,
  createBuffer,
  decay,
  fadeEdges,
  filter,
  haas,
  mix,
  noise,
  noiseBand,
  normalize,
  saturate,
  slowRandom,
  sweep,
  thud,
  tone,
  trapezoid,
} from './synth'

const TWO_PI = Math.PI * 2

interface VocalConfig {
  seconds: number
  /** 基频曲线（Hz） */
  pitch: Envelope
  /** 颤音 LFO 频率（Hz） */
  vibratoRate: number
  /** 颤音深度（基频的比例） */
  vibratoDepth: number
  /** 粗糙度：振幅调制频率（Hz） */
  roughRate: number
  /** 粗糙度深度 0..1 */
  roughDepth: number
  /** 共振峰频率（Hz），并联带通，越靠后越弱 */
  formants: readonly number[]
  formantQ: number
  /** 气声噪声量 */
  breath: number
  /** 整体音量包络 */
  env: Envelope
  wave?: Wave
}

/** 合成一段叫声，输出峰值归一化为 1 */
function vocal(sr: number, rng: Rng, c: VocalConfig): Float32Array {
  const phase = rng.next() * TWO_PI
  const roughPhase = rng.next() * TWO_PI
  const drift = slowRandom(rng, c.seconds, 4)
  const swell = slowRandom(rng, c.seconds, 6)
  const pitch = (t: number): number =>
    c.pitch(t) * (1 + c.vibratoDepth * Math.sin(TWO_PI * c.vibratoRate * t + phase) + 0.025 * drift(t))

  // 声带源：两个略微失谐的振荡器 + 气声
  const source = createBuffer(sr, c.seconds)
  addOsc(source, sr, c.wave ?? 'saw', pitch, 0.6)
  addOsc(source, sr, 'saw', (t) => pitch(t) * 1.011, 0.35)
  if (c.breath > 0) mix(source, sr, noise(sr, c.seconds, rng), c.breath * 0.5)

  // 共振峰：并联带通
  const out = createBuffer(sr, c.seconds)
  c.formants.forEach((freq, i) => {
    mix(out, sr, filter(source.slice(), sr, 'bandpass', freq, c.formantQ), 1 / (1 + i * 0.8))
  })
  mix(out, sr, filter(source, sr, 'lowpass', (c.formants[0] ?? 500) * 0.8, 0.7), 0.25)

  applyEnv(out, sr, (t) => {
    const rough = 1 - c.roughDepth * (0.5 + 0.5 * Math.sin(TWO_PI * c.roughRate * t + roughPhase))
    return c.env(t) * rough * (1 + 0.25 * swell(t))
  })
  return normalize(out, 1)
}

/* ── 丧尸嗓音模型 ── */

/** 元音共振峰（F1, F2, F3，Hz），丧尸喉咙里含混的几种口型 */
type Vowel = readonly [number, number, number]
const VOWEL_U: Vowel = [330, 760, 2300]
const VOWEL_O: Vowel = [460, 860, 2450]
const VOWEL_A: Vowel = [720, 1180, 2550]
const VOWEL_E: Vowel = [520, 1650, 2500]

/** 线性滑动：seconds 秒内从 from 到 to，之后保持 */
function glide(from: number, to: number, seconds: number): Envelope {
  return (t) => from + (to - from) * Math.min(1, Math.max(0, t / seconds))
}

/** 两个包络相加（双音节呻吟） */
function sumEnv(a: Envelope, b: Envelope, offset: number, gain: number): Envelope {
  return (t) => a(t) + (t >= offset ? gain * b(t - offset) : 0)
}

interface ZombieVoiceConfig {
  seconds: number
  /** 基频曲线（Hz） */
  pitch: Envelope
  /** 基频的快速随机抖动（比例），越大越像破锣嗓子 */
  jitter: number
  /** 次谐波（基频一半）的量：低沉的气泡音 */
  sub: number
  /** 元音：起始与结束口型，seconds × morph 秒内滑过去 */
  from: Vowel
  to: Vowel
  morph: number
  /** 共振峰带通的 Q */
  q: number
  /** 气声（高通噪声）量 */
  breath: number
  /** 喉部颤动：振幅调制频率与深度，频率带随机漂移 */
  rattleRate: number
  rattleDepth: number
  /** 每秒的咕噜气泡数量 */
  gurgle: number
  /** 整体音量包络 */
  env: Envelope
  /** 最后的饱和量（提高响度密度） */
  drive: number
}

/**
 * 丧尸嗓音：带抖动的双锯齿波 + 次谐波 + 气声 → 三个随时间滑动的共振峰带通 + 低通胸腔共鸣
 * → 不规则喉部颤动 → 叠加湿润的咕噜气泡 → 饱和。输出峰值归一化为 1。
 */
function zombieVoice(sr: number, rng: Rng, c: ZombieVoiceConfig): Float32Array {
  const fast = slowRandom(rng, c.seconds, 34)
  const drift = slowRandom(rng, c.seconds, 3)
  const wobble = slowRandom(rng, c.seconds, 5)
  const pitch = (t: number): number => c.pitch(t) * (1 + c.jitter * fast(t) + 0.035 * drift(t))

  const source = createBuffer(sr, c.seconds)
  addOsc(source, sr, 'saw', pitch, 0.6, 0, Infinity, rng.next())
  addOsc(source, sr, 'saw', (t) => pitch(t) * 1.014, 0.32, 0, Infinity, rng.next())
  if (c.sub > 0) addOsc(source, sr, 'square', (t) => pitch(t) * 0.5, (t) => c.sub * 0.3 * (0.6 + 0.4 * wobble(t)))
  if (c.breath > 0) {
    const air = filter(noise(sr, c.seconds, rng), sr, 'highpass', 900, 0.7)
    mix(source, sr, air, c.breath * 0.55)
  }

  const span = Math.max(0.05, c.seconds * c.morph)
  const out = createBuffer(sr, c.seconds)
  mix(out, sr, filter(source.slice(), sr, 'bandpass', glide(c.from[0], c.to[0], span), c.q), 1)
  mix(out, sr, filter(source.slice(), sr, 'bandpass', glide(c.from[1], c.to[1], span), c.q), 0.55)
  mix(out, sr, filter(source.slice(), sr, 'bandpass', glide(c.from[2], c.to[2], span), c.q * 0.8), 0.22)
  // 胸腔共鸣：低通保留基频与次谐波的厚度
  mix(out, sr, filter(source, sr, 'lowpass', glide(c.from[0] * 0.8, c.to[0] * 0.8, span), 0.8), 0.4)

  const phase = rng.next() * TWO_PI
  applyEnv(out, sr, (t) => {
    const rattle = 1 - c.rattleDepth * (0.5 + 0.5 * Math.sin(TWO_PI * c.rattleRate * t + phase + 2.5 * wobble(t)))
    return c.env(t) * rattle * (1 + 0.2 * drift(t))
  })
  normalize(out, 1)

  // 咕噜气泡：喉咙里的液体，跟随整体包络
  const count = Math.round(c.gurgle * c.seconds)
  for (let i = 0; i < count; i++) {
    const at = rng.range(0, c.seconds * 0.92)
    const length = rng.range(0.02, 0.065)
    const freq = rng.range(170, 520)
    const level = c.env(at) * rng.range(0.12, 0.3)
    if (level < 0.02) continue
    mix(out, sr, tone(sr, length, 'sine', sweep(freq, freq * rng.range(1.4, 2.3), length), bell(length / 2, length / 4)), level, at)
  }

  saturate(out, c.drive)
  return normalize(out, 1)
}

/* ── 普通丧尸 ── */

/** 呻吟的六种嗓音：基频（Hz）与元音走向；奇数变体是两段式呻吟 */
const GROAN_VOICES: ReadonlyArray<{ base: number; from: Vowel; to: Vowel }> = [
  { base: 82, from: VOWEL_O, to: VOWEL_A },
  { base: 96, from: VOWEL_U, to: VOWEL_O },
  { base: 108, from: VOWEL_A, to: VOWEL_U },
  { base: 74, from: VOWEL_U, to: VOWEL_A },
  { base: 118, from: VOWEL_E, to: VOWEL_O },
  { base: 90, from: VOWEL_O, to: VOWEL_U },
]

/** 丧尸呻吟：低沉含混的“呃——啊”，带气泡音与咕噜声。variant 0..5 对应不同嗓音 */
export function renderZombieGroan(sr: number, rng: Rng, variant: number): Float32Array {
  const voice = GROAN_VOICES[variant % GROAN_VOICES.length] ?? { base: 96, from: VOWEL_O, to: VOWEL_A }
  const twoPart = variant % 2 === 1
  const seconds = twoPart ? rng.range(1.7, 2.1) : rng.range(1.3, 1.7)
  const base = voice.base * rng.range(0.95, 1.05)
  const first = trapezoid(0.18, twoPart ? 0.35 : 0.55, twoPart ? 0.35 : 0.6)
  const env = twoPart ? sumEnv(first, trapezoid(0.12, 0.3, 0.45), 0.85, 0.8) : first
  const out = zombieVoice(sr, rng, {
    seconds,
    pitch: (t) => base * (1.1 - 0.22 * Math.min(1, t / seconds)) * (twoPart && t > 0.85 ? 1.06 : 1),
    jitter: 0.06,
    sub: 0.55,
    from: voice.from,
    to: voice.to,
    morph: 0.8,
    q: 5,
    breath: 0.3,
    rattleRate: 11 + (variant % 3) * 3,
    rattleDepth: 0.45,
    gurgle: 5,
    env,
    drive: 1.8,
  })
  return normalize(fadeEdges(out, sr, 0.01, 0.06), 0.9)
}

/** 丧尸发现目标：吸气后一声上扬的嘶吼。3 个变体 */
export function renderZombieAlert(sr: number, rng: Rng, variant: number): Float32Array {
  const seconds = 1
  const out = createBuffer(sr, seconds + 0.2)
  // 先一口粗重的吸气
  mix(out, sr, noiseBand(sr, rng, 0.22, 'bandpass', glide(900, 1600, 0.2), 1.4, bell(0.11, 0.06)), 0.25)
  const peak = 165 + variant * 18
  const roar = zombieVoice(sr, rng, {
    seconds,
    pitch: (t) => (t < 0.3 ? 105 + (peak - 105) * (t / 0.3) : peak * (1 - 0.3 * Math.min(1, (t - 0.3) / 0.6))),
    jitter: 0.09,
    sub: 0.45,
    from: VOWEL_O,
    to: variant === 1 ? VOWEL_E : VOWEL_A,
    morph: 0.35,
    q: 4,
    breath: 0.5,
    rattleRate: 27 + variant * 4,
    rattleDepth: 0.5,
    gurgle: 4,
    env: trapezoid(0.07, 0.4, 0.5),
    drive: 2.4,
  })
  mix(out, sr, roar, 0.95, 0.18)
  return normalize(fadeEdges(out, sr, 0.005, 0.05), 0.92)
}

/** 丧尸中弹：短促的闷哼 + 喉咙里一下湿响。4 个变体 */
export function renderZombieHurt(sr: number, rng: Rng, variant: number): Float32Array {
  const seconds = 0.38
  const start = 150 + variant * 12
  const out = zombieVoice(sr, rng, {
    seconds,
    pitch: sweep(start, start * 0.6, 0.3),
    jitter: 0.1,
    sub: 0.4,
    from: variant % 2 === 0 ? VOWEL_A : VOWEL_E,
    to: VOWEL_O,
    morph: 0.6,
    q: 3.5,
    breath: 0.55,
    rattleRate: 33,
    rattleDepth: 0.5,
    gurgle: 10,
    env: attackDecay(0.012, 0.09),
    drive: 2.2,
  })
  return normalize(fadeEdges(out, sr, 0.002, 0.03), 0.9)
}

/** 丧尸脚步：拖着脚的闷响 + 鞋底擦地。4 个变体 */
export function renderZombieStep(sr: number, rng: Rng, variant: number): Float32Array {
  const seconds = 0.32
  const out = createBuffer(sr, seconds)
  const drag = variant % 2 === 0
  // 拖步：先擦地再落脚；踏步：先落脚再带一点擦地
  const hitAt = drag ? 0.07 : 0
  mix(out, sr, thud(sr, rng, 0.22, rng.range(80, 105), 45, 0.035, 520), 1, hitAt)
  mix(out, sr, noiseBand(sr, rng, 0.25, 'bandpass', sweep(rng.range(1500, 2200), 800, 0.2), 0.9, bell(drag ? 0.06 : 0.11, 0.05)), drag ? 0.5 : 0.3)
  // 碎石沙沙声
  mix(out, sr, noiseBand(sr, rng, 0.12, 'highpass', 3200, 0.7, decay(0.025)), 0.12, hitAt + 0.01)
  return normalize(fadeEdges(out, sr, 0.002, 0.03), 0.85)
}

/** 丧尸攻击：短促凶狠的嘶吼 + 张口的咬合声。3 个变体 */
export function renderZombieAttack(sr: number, rng: Rng, variant: number): Float32Array {
  const start = 160 + variant * 15
  const out = zombieVoice(sr, rng, {
    seconds: 0.6,
    pitch: sweep(start, 95, 0.45),
    jitter: 0.1,
    sub: 0.35,
    from: VOWEL_A,
    to: VOWEL_O,
    morph: 0.7,
    q: 3.5,
    breath: 0.55,
    rattleRate: 29 + variant * 3,
    rattleDepth: 0.6,
    gurgle: 6,
    env: attackDecay(0.025, 0.17),
    drive: 2.2,
  })
  mix(out, sr, noiseBand(sr, rng, 0.12, 'bandpass', sweep(2600, 900, 0.1), 1.2, attackDecay(0.01, 0.03)), 0.3)
  // 咬合：一下清脆的牙齿碰撞
  mix(out, sr, noiseBand(sr, rng, 0.03, 'highpass', 2500, 0.8, decay(0.006)), 0.35, 0.32)
  return normalize(fadeEdges(out, sr, 0.003, 0.03), 0.92)
}

/** 丧尸死亡：下滑的喉音，最后是带咕噜的咽气。3 个变体 */
export function renderZombieDie(sr: number, rng: Rng, variant: number): Float32Array {
  const seconds = 1.3
  const out = zombieVoice(sr, rng, {
    seconds,
    pitch: sweep(140 + variant * 10, 46, 1.1),
    jitter: 0.09,
    sub: 0.6,
    from: VOWEL_A,
    to: VOWEL_U,
    morph: 0.85,
    q: 4,
    breath: 0.45,
    rattleRate: 15 + variant * 3,
    rattleDepth: 0.7,
    gurgle: 9,
    env: trapezoid(0.03, 0.4, 0.8),
    drive: 1.9,
  })
  // 咽气：最后一口带痰的呼气
  mix(out, sr, noiseBand(sr, rng, 0.45, 'bandpass', glide(1100, 500, 0.4), 1.2, bell(0.22, 0.12)), 0.18, seconds - 0.5)
  return normalize(fadeEdges(out, sr, 0.003, 0.06), 0.9)
}

/* ── 快速丧尸 ── */

/** 快速丧尸：尖锐嘶叫，底下垫一层撕裂的喉音。3 个变体（音高与长度不同） */
export function renderRunnerScreech(sr: number, rng: Rng, variant: number): Float32Array {
  const seconds = 0.75 + variant * 0.1
  const low = 900 + variant * 90
  const out = vocal(sr, rng, {
    seconds,
    pitch: (t) => low + 550 * Math.sin(Math.PI * Math.min(1, t / (seconds * 0.75)) * 0.85),
    vibratoRate: 23 + variant * 3,
    vibratoDepth: 0.07,
    roughRate: 55,
    roughDepth: 0.5,
    formants: [1800, 2900, 4200],
    formantQ: 3,
    breath: 0.4,
    env: trapezoid(0.03, seconds * 0.55, 0.3),
  })
  const rasp = zombieVoice(sr, rng, {
    seconds,
    pitch: glide(210, 260, seconds),
    jitter: 0.12,
    sub: 0.2,
    from: VOWEL_A,
    to: VOWEL_E,
    morph: 0.6,
    q: 3,
    breath: 0.6,
    rattleRate: 45,
    rattleDepth: 0.55,
    gurgle: 3,
    env: trapezoid(0.03, seconds * 0.5, 0.3),
    drive: 2.5,
  })
  mix(out, sr, rasp, 0.45)
  filter(out, sr, 'highpass', 350, 0.7)
  return normalize(fadeEdges(out, sr, 0.003, 0.04), 0.85)
}

/** 快速丧尸中弹：尖促的嘶鸣。3 个变体 */
export function renderRunnerHurt(sr: number, rng: Rng, variant: number): Float32Array {
  const start = 520 + variant * 60
  const out = zombieVoice(sr, rng, {
    seconds: 0.32,
    pitch: sweep(start, start * 0.55, 0.25),
    jitter: 0.08,
    sub: 0.15,
    from: VOWEL_E,
    to: VOWEL_A,
    morph: 0.5,
    q: 3,
    breath: 0.6,
    rattleRate: 48,
    rattleDepth: 0.45,
    gurgle: 6,
    env: attackDecay(0.01, 0.07),
    drive: 2.2,
  })
  filter(out, sr, 'highpass', 300, 0.7)
  return normalize(fadeEdges(out, sr, 0.002, 0.03), 0.88)
}

/** 快速丧尸扑击：上滑的短尖叫 + 爪击破风 */
export function renderRunnerAttack(sr: number, rng: Rng): Float32Array {
  const out = vocal(sr, rng, {
    seconds: 0.4,
    pitch: sweep(650, 1700, 0.14),
    vibratoRate: 30,
    vibratoDepth: 0.05,
    roughRate: 70,
    roughDepth: 0.5,
    formants: [1500, 2600, 3800],
    formantQ: 3,
    breath: 0.4,
    env: attackDecay(0.02, 0.09),
  })
  mix(out, sr, noiseBand(sr, rng, 0.2, 'bandpass', sweep(3500, 700, 0.15), 1.5, attackDecay(0.02, 0.05)), 0.6, 0.12)
  filter(out, sr, 'highpass', 400, 0.7)
  return normalize(fadeEdges(out, sr, 0.003, 0.03), 0.85)
}

/* ── 坦克丧尸 ── */

/** 坦克咆哮：低沉、粗糙、带失真 */
export function renderTankRoar(sr: number, rng: Rng): Float32Array {
  const seconds = 1.7
  const pitch: Envelope = (t) => 62 * (1 + 0.18 * Math.sin(Math.PI * Math.min(1, t / 1.3)))
  const env = trapezoid(0.12, 0.9, 0.65)
  const out = vocal(sr, rng, {
    seconds,
    pitch,
    vibratoRate: 4,
    vibratoDepth: 0.04,
    roughRate: 19,
    roughDepth: 0.65,
    formants: [260, 560, 1100],
    formantQ: 3,
    breath: 0.5,
    env,
  })
  addOsc(out, sr, 'sine', (t) => pitch(t) * 0.5, (t) => 0.5 * env(t))
  // 这里只做轻度饱和：播放时还会再过一道 WaveShaper
  saturate(out, 1.4)
  return normalize(fadeEdges(out, sr, 0.005, 0.05), 0.9)
}

/** 坦克中弹：沉重的闷哼。2 个变体 */
export function renderTankHurt(sr: number, rng: Rng, variant: number): Float32Array {
  const start = 78 + variant * 8
  const out = zombieVoice(sr, rng, {
    seconds: 0.5,
    pitch: sweep(start, start * 0.7, 0.4),
    jitter: 0.07,
    sub: 0.7,
    from: VOWEL_A,
    to: VOWEL_U,
    morph: 0.7,
    q: 3,
    breath: 0.45,
    rattleRate: 17,
    rattleDepth: 0.6,
    gurgle: 6,
    env: attackDecay(0.02, 0.13),
    drive: 2.4,
  })
  return normalize(fadeEdges(out, sr, 0.003, 0.04), 0.9)
}

/** 坦克脚步：沉重的落地 */
export function renderTankStep(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.5)
  mix(out, sr, thud(sr, rng, 0.5, 62, 30, 0.09, 180), 1)
  mix(out, sr, noiseBand(sr, rng, 0.15, 'bandpass', 900, 0.7, attackDecay(0.01, 0.04)), 0.14)
  saturate(out, 1.5)
  return normalize(fadeEdges(out, sr, 0, 0.03), 0.9)
}

/** 坦克重击：砸地的爆裂感撞击 + 碎屑 */
export function renderTankSlam(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 1)
  mix(out, sr, tone(sr, 0.9, 'sine', sweep(95, 26, 0.35), decay(0.16)), 1)
  mix(out, sr, noiseBand(sr, rng, 0.7, 'lowpass', sweep(2600, 140, 0.4), 0.8, decay(0.12)), 0.9)
  mix(out, sr, noiseBand(sr, rng, 0.04, 'highpass', 2000, 0.7, decay(0.006)), 0.5)
  mix(out, sr, noiseBand(sr, rng, 0.8, 'bandpass', 1200, 0.6, attackDecay(0.08, 0.25)), 0.18, 0.05)
  saturate(out, 2.5)
  return normalize(fadeEdges(out, sr, 0, 0.05), 0.95)
}

/** 坦克死亡：下滑的哀嚎，然后轰然倒地 */
export function renderTankDie(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 2)
  const cry = vocal(sr, rng, {
    seconds: 1.35,
    pitch: sweep(72, 30, 1.3),
    vibratoRate: 4.5,
    vibratoDepth: 0.05,
    roughRate: 14,
    roughDepth: 0.7,
    formants: [230, 480, 900],
    formantQ: 3,
    breath: 0.5,
    env: trapezoid(0.05, 0.5, 0.75),
  })
  mix(out, sr, cry, 0.9)
  mix(out, sr, thud(sr, rng, 0.7, 80, 30, 0.14, 220), 1, 1.25)
  mix(out, sr, noiseBand(sr, rng, 0.5, 'bandpass', 1400, 0.6, attackDecay(0.04, 0.15)), 0.15, 1.28)
  saturate(out, 2)
  return normalize(fadeEdges(out, sr, 0.005, 0.05), 0.9)
}

/* ── Boss ── */

/** Boss 出场咆哮：30Hz 超低频 + 低吼 + 高频尖啸，左右声道延迟做立体声相位。返回立体声 */
export function renderBossRoar(sr: number, rng: Rng): Float32Array[] {
  const seconds = 3.2
  const env = trapezoid(0.25, 1.7, 1.2)
  const out = createBuffer(sr, seconds)

  // 超低频：30Hz 正弦，外加 60Hz 让小扬声器也有存在感
  addOsc(out, sr, 'sine', 30, (t) => 0.9 * env(t))
  addOsc(out, sr, 'sine', 60, (t) => 0.45 * env(t) * (0.8 + 0.2 * Math.sin(TWO_PI * 6 * t)))

  const growl = vocal(sr, rng, {
    seconds,
    pitch: (t) => 52 * (1 + 0.15 * Math.sin(Math.PI * Math.min(1, t / 2.4))),
    vibratoRate: 3.5,
    vibratoDepth: 0.05,
    roughRate: 13,
    roughDepth: 0.7,
    formants: [180, 420, 900],
    formantQ: 2.5,
    breath: 0.6,
    env,
  })
  mix(out, sr, growl, 0.9)

  const screech = vocal(sr, rng, {
    seconds,
    pitch: (t) => 1700 + 900 * Math.sin(Math.PI * Math.min(1, t / 2.6) * 0.9),
    vibratoRate: 17,
    vibratoDepth: 0.05,
    roughRate: 43,
    roughDepth: 0.45,
    formants: [2200, 3400, 5200],
    formantQ: 3,
    breath: 0.4,
    env: trapezoid(0.4, 1.5, 1.1),
  })
  mix(out, sr, screech, 0.42)

  // 主要的失真由播放链路上的 WaveShaper 完成，这里只轻度饱和把各层粘在一起
  saturate(out, 1.2)
  normalize(fadeEdges(out, sr, 0.01, 0.1), 0.95)
  return haas(out, sr, 0.011)
}

/** 触手横扫：粗重的破风声 */
export function renderBossSweep(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.8)
  const swing = bell(0.3, 0.14)
  mix(out, sr, noiseBand(sr, rng, 0.8, 'bandpass', (t) => 300 + 2600 * swing(t), 1.6, swing), 1)
  mix(out, sr, noiseBand(sr, rng, 0.8, 'highpass', 3000, 0.7, (t) => swing(t) * swing(t)), 0.25)
  mix(out, sr, tone(sr, 0.8, 'sine', sweep(140, 55, 0.6), swing), 0.6)
  return normalize(fadeEdges(out, sr, 0.01, 0.05), 0.9)
}

/** 触手突刺：急促上扬的破风 + 刺入地面的撞击与湿响 */
export function renderBossStab(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.7)
  const rush: Envelope = (t) => (t < 0.13 ? (t / 0.13) * (t / 0.13) : Math.exp(-(t - 0.13) / 0.02))
  mix(out, sr, noiseBand(sr, rng, 0.25, 'bandpass', sweep(700, 5200, 0.13), 2, rush), 0.9)
  mix(out, sr, thud(sr, rng, 0.5, 110, 38, 0.09, 400), 1, 0.14)
  mix(out, sr, noiseBand(sr, rng, 0.3, 'lowpass', sweep(3000, 300, 0.1), 0.8, decay(0.04)), 0.9, 0.14)
  const squelch = noiseBand(sr, rng, 0.35, 'bandpass', sweep(900, 500, 0.3), 3, decay(0.1))
  applyEnv(squelch, sr, (t) => 0.5 + 0.5 * Math.sin(TWO_PI * 35 * t))
  mix(out, sr, squelch, 0.4, 0.17)
  saturate(out, 1.8)
  return normalize(fadeEdges(out, sr, 0.003, 0.04), 0.9)
}

/** 喷射毒液：喉咙里的咕噜气泡 + 干呕 + 喷吐 */
export function renderBossSpit(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 1.2)
  const retch = vocal(sr, rng, {
    seconds: 0.75,
    pitch: sweep(78, 58, 0.7),
    vibratoRate: 6,
    vibratoDepth: 0.06,
    roughRate: 21,
    roughDepth: 0.8,
    formants: [300, 650, 1300],
    formantQ: 3,
    breath: 0.5,
    env: trapezoid(0.05, 0.45, 0.25),
  })
  mix(out, sr, retch, 0.7)

  // 咕噜：一串音高上滑的短气泡
  for (let i = 0; i < 10; i++) {
    const at = 0.04 + i * 0.065 + rng.range(0, 0.03)
    const length = rng.range(0.04, 0.08)
    const freq = rng.range(180, 420)
    mix(out, sr, tone(sr, length, 'sine', sweep(freq, freq * 1.9, length), bell(length / 2, length / 4)), 0.55, at)
  }

  // 喷吐
  mix(out, sr, noiseBand(sr, rng, 0.45, 'bandpass', sweep(2200, 900, 0.3), 1.2, attackDecay(0.015, 0.09)), 0.9, 0.72)
  mix(out, sr, noiseBand(sr, rng, 0.3, 'highpass', 3500, 0.7, attackDecay(0.01, 0.05)), 0.3, 0.72)
  return normalize(fadeEdges(out, sr, 0.005, 0.05), 0.9)
}

/** 召唤小怪：穿透力很强的双音尖啸，带回声 */
export function renderBossSummon(sr: number, rng: Rng): Float32Array {
  const seconds = 1.9
  const out = createBuffer(sr, seconds)
  const glide: Envelope = (t) => 2100 + 1100 * Math.min(1, t / 0.5)
  const config = {
    seconds,
    vibratoRate: 9,
    vibratoDepth: 0.04,
    roughRate: 31,
    roughDepth: 0.35,
    formants: [2600, 3900, 5600],
    formantQ: 3,
    breath: 0.25,
    env: trapezoid(0.08, 1.1, 0.7),
  }
  mix(out, sr, vocal(sr, rng, { ...config, pitch: glide }), 1)
  mix(out, sr, vocal(sr, rng, { ...config, pitch: (t) => glide(t) * 1.5 }), 0.4)
  // 环形调制：加一点非人的金属感
  applyEnv(out, sr, (t) => 0.7 + 0.3 * Math.sin(TWO_PI * 70 * t))
  comb(out, sr, 0.13, 0.35)
  filter(out, sr, 'highpass', 500, 0.7)
  return normalize(fadeEdges(out, sr, 0.005, 0.08), 0.85)
}

/** 冲击波蓄力：约 2 秒持续上升，颤动越来越快，结尾戒然而止 */
export function renderBossCharge(sr: number, rng: Rng): Float32Array {
  const seconds = 2.1
  const rise = 2
  const grow = (power: number): Envelope => (t) => Math.pow(Math.min(1, t / rise), power)
  const out = createBuffer(sr, seconds)

  addOsc(out, sr, 'sine', sweep(38, 240, rise), (t) => 0.3 + 0.7 * grow(2)(t))
  const buzz = tone(sr, seconds, 'saw', sweep(55, 440, rise), grow(1.5))
  filter(buzz, sr, 'lowpass', sweep(200, 3500, rise), 1.5)
  mix(out, sr, buzz, 0.5)
  mix(out, sr, noiseBand(sr, rng, seconds, 'bandpass', sweep(250, 5000, rise), 2, grow(2)), 0.5)

  // 颤动从 6Hz 加速到 32Hz
  applyEnv(out, sr, (t) => 1 - 0.35 * (0.5 + 0.5 * Math.sin(TWO_PI * (6 * t + 6.5 * t * t))))
  saturate(out, 1.5)
  return normalize(fadeEdges(out, sr, 0.02, 0.06), 0.9)
}

/** 冲击波爆发：爆炸式的全频冲击 + 漫长的低频余震。返回立体声 */
export function renderBossShockwave(sr: number, rng: Rng): Float32Array[] {
  const seconds = 2.4
  const out = createBuffer(sr, seconds)
  mix(out, sr, tone(sr, seconds, 'sine', sweep(130, 24, 0.9), decay(0.4)), 1)
  mix(out, sr, noiseBand(sr, rng, seconds, 'lowpass', sweep(7000, 110, 1.3), 0.8, decay(0.35)), 1)
  mix(out, sr, noiseBand(sr, rng, 0.06, 'highpass', 2500, 0.7, decay(0.01)), 0.6)
  const rumble = noiseBand(sr, rng, seconds, 'lowpass', 90, 1.2, attackDecay(0.1, 0.7))
  applyEnv(rumble, sr, (t) => 1 + 0.4 * Math.sin(TWO_PI * 9 * t))
  mix(out, sr, rumble, 0.6)
  saturate(out, 2)
  normalize(fadeEdges(out, sr, 0, 0.1), 0.95)
  return haas(out, sr, 0.014)
}

/** Boss 受伤：高频嘶鸣迅速下滑 + 一声闷哼 */
export function renderBossHurt(sr: number, rng: Rng): Float32Array {
  const out = vocal(sr, rng, {
    seconds: 0.55,
    pitch: sweep(1500, 850, 0.35),
    vibratoRate: 21,
    vibratoDepth: 0.05,
    roughRate: 47,
    roughDepth: 0.55,
    formants: [1900, 3100, 4600],
    formantQ: 3,
    breath: 0.5,
    env: attackDecay(0.015, 0.14),
  })
  const grunt = tone(sr, 0.4, 'saw', sweep(95, 60, 0.3), decay(0.1))
  filter(grunt, sr, 'lowpass', 400, 1)
  mix(out, sr, grunt, 0.5)
  saturate(out, 1.6)
  return normalize(fadeEdges(out, sr, 0.003, 0.04), 0.9)
}

/** Boss 死亡：由尖啸一路滑落的长啸，最后轰然塌倒。返回立体声 */
export function renderBossDie(sr: number, rng: Rng): Float32Array[] {
  const seconds = 4.8
  const out = createBuffer(sr, seconds)

  const howl = vocal(sr, rng, {
    seconds: 4,
    pitch: sweep(2300, 280, 3.6),
    vibratoRate: 6,
    vibratoDepth: 0.07,
    roughRate: 24,
    roughDepth: 0.5,
    formants: [1500, 2600, 4200],
    formantQ: 2,
    breath: 0.4,
    env: trapezoid(0.1, 2.4, 1.4),
  })
  mix(out, sr, howl, 0.6)

  const growl = vocal(sr, rng, {
    seconds: 4.1,
    pitch: sweep(60, 28, 3.8),
    vibratoRate: 3,
    vibratoDepth: 0.06,
    roughRate: 11,
    roughDepth: 0.75,
    formants: [170, 400, 850],
    formantQ: 2.5,
    breath: 0.6,
    env: trapezoid(0.2, 2.2, 1.6),
  })
  mix(out, sr, growl, 0.9)

  const sub = trapezoid(0.3, 2.5, 1.5)
  addOsc(out, sr, 'sine', 30, (t) => 0.7 * sub(t))
  addOsc(out, sr, 'sine', 60, (t) => 0.3 * sub(t))

  // 塌倒
  mix(out, sr, thud(sr, rng, 1, 90, 24, 0.25, 300), 1, 3.7)
  mix(out, sr, noiseBand(sr, rng, 0.9, 'lowpass', sweep(1800, 100, 0.5), 0.8, decay(0.2)), 0.7, 3.7)

  saturate(out, 1.2)
  normalize(fadeEdges(out, sr, 0.01, 0.15), 0.95)
  return haas(out, sr, 0.013)
}

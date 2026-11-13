/**
 * 生物音效：普通丧尸、快速丧尸、坦克丧尸与 Boss（阿奎尔巨兽）。
 * 叫声统一用“声带源（锯齿波）+ LFO 颤音 + 共振峰带通 + 振幅调制粗糙度”的模型合成，
 * 靠基频、共振峰与粗糙度的不同区分种类。
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

/* ── 普通丧尸 ── */

/** 丧尸呻吟：80–120Hz 锯齿波 + LFO 颤抖。variant 0..2 对应低 / 中 / 高三种嗓音 */
export function renderZombieGroan(sr: number, rng: Rng, variant: number): Float32Array {
  const seconds = 1.5
  const base = [86, 100, 116][variant % 3] ?? 100
  const out = vocal(sr, rng, {
    seconds,
    pitch: (t) => base * (1.08 - 0.2 * (t / seconds)),
    vibratoRate: 5.5 + variant * 0.7,
    vibratoDepth: 0.05,
    roughRate: 9 + variant,
    roughDepth: 0.35,
    formants: [420 + variant * 40, 780, 2300],
    formantQ: 4,
    breath: 0.25,
    env: trapezoid(0.25, 0.6, 0.6),
  })
  return normalize(fadeEdges(out, sr, 0.01, 0.05), 0.85)
}

/** 丧尸攻击：短促凶狠的嘶吼 */
export function renderZombieAttack(sr: number, rng: Rng): Float32Array {
  const out = vocal(sr, rng, {
    seconds: 0.55,
    pitch: sweep(150, 95, 0.4),
    vibratoRate: 11,
    vibratoDepth: 0.08,
    roughRate: 28,
    roughDepth: 0.6,
    formants: [650, 1250, 2600],
    formantQ: 3,
    breath: 0.5,
    env: attackDecay(0.03, 0.16),
  })
  mix(out, sr, noiseBand(sr, rng, 0.12, 'bandpass', sweep(2600, 900, 0.1), 1.2, attackDecay(0.01, 0.03)), 0.35)
  saturate(out, 1.6)
  return normalize(fadeEdges(out, sr, 0.003, 0.03), 0.9)
}

/** 丧尸死亡：下滑的喉音，越到后面越像咽气 */
export function renderZombieDie(sr: number, rng: Rng): Float32Array {
  const out = vocal(sr, rng, {
    seconds: 1.1,
    pitch: sweep(135, 48, 1),
    vibratoRate: 7,
    vibratoDepth: 0.07,
    roughRate: 16,
    roughDepth: 0.7,
    formants: [380, 700, 1900],
    formantQ: 3.5,
    breath: 0.4,
    env: trapezoid(0.03, 0.35, 0.7),
  })
  return normalize(fadeEdges(out, sr, 0.003, 0.05), 0.85)
}

/* ── 快速丧尸 ── */

/** 快速丧尸：尖锐嘶叫 */
export function renderRunnerScreech(sr: number, rng: Rng): Float32Array {
  const out = vocal(sr, rng, {
    seconds: 0.8,
    pitch: (t) => 950 + 550 * Math.sin(Math.PI * Math.min(1, t / 0.6) * 0.85),
    vibratoRate: 23,
    vibratoDepth: 0.06,
    roughRate: 55,
    roughDepth: 0.5,
    formants: [1800, 2900, 4200],
    formantQ: 3,
    breath: 0.35,
    env: trapezoid(0.03, 0.45, 0.3),
  })
  filter(out, sr, 'highpass', 600, 0.7)
  return normalize(fadeEdges(out, sr, 0.003, 0.04), 0.8)
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

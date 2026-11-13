/**
 * 反馈类音效：UI、命中提示、玩家受伤 / 倒地 / 救援、脚步、空投、倒计时、心跳、波次提示。
 * 每个函数返回预渲染好的样本，由 sfx-bank.ts 登记。
 */

import { smoothstep } from '../../utils/math'
import type { Rng } from '../../utils/random'
import {
  addOsc,
  applyEnv,
  attackDecay,
  bell,
  createBuffer,
  decay,
  fadeEdges,
  filter,
  metalClick,
  mix,
  noise,
  noiseBand,
  normalize,
  saturate,
  sweep,
  thud,
  tone,
  trapezoid,
} from './synth'

const TWO_PI = Math.PI * 2

/** 拾取：上行两音 + 一点高频闪光 */
export function renderPickup(sr: number): Float32Array {
  const out = createBuffer(sr, 0.34)
  mix(out, sr, tone(sr, 0.14, 'triangle', 660, attackDecay(0.004, 0.045)), 0.6, 0)
  mix(out, sr, tone(sr, 0.24, 'triangle', 990, attackDecay(0.004, 0.07)), 0.6, 0.075)
  mix(out, sr, tone(sr, 0.24, 'sine', 1980, attackDecay(0.004, 0.09)), 0.2, 0.075)
  return normalize(fadeEdges(out, sr, 0, 0.02), 0.8)
}

/** UI 点击：短促下滑的“嗒” */
export function renderClick(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.08)
  mix(out, sr, tone(sr, 0.07, 'sine', sweep(1100, 750, 0.04), decay(0.014)), 0.8)
  mix(out, sr, noiseBand(sr, rng, 0.012, 'highpass', 3000, 0.7, decay(0.002)), 0.35)
  return normalize(fadeEdges(out, sr, 0, 0.01), 0.7)
}

/** 命中反馈：干脆的短“嗒” */
export function renderHit(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.09)
  mix(out, sr, noiseBand(sr, rng, 0.05, 'bandpass', 2100, 2, decay(0.007)), 0.8)
  mix(out, sr, tone(sr, 0.08, 'sine', sweep(950, 700, 0.04), decay(0.018)), 0.6)
  return normalize(fadeEdges(out, sr, 0, 0.01), 0.8)
}

/** 爆头：更清脆的金属泛音 + 低频“噗” */
export function renderHeadshot(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.36)
  addOsc(out, sr, 'sine', 1900, (t) => 0.7 * Math.exp(-t / 0.06))
  addOsc(out, sr, 'sine', 2850, (t) => 0.5 * Math.exp(-t / 0.045))
  addOsc(out, sr, 'sine', 3800, (t) => 0.3 * Math.exp(-t / 0.03))
  mix(out, sr, noiseBand(sr, rng, 0.03, 'highpass', 4000, 0.7, decay(0.004)), 0.7)
  mix(out, sr, tone(sr, 0.15, 'sine', sweep(260, 120, 0.06), decay(0.03)), 0.6)
  mix(out, sr, tone(sr, 0.28, 'sine', 2530, attackDecay(0.003, 0.08)), 0.35, 0.06)
  return normalize(fadeEdges(out, sr, 0, 0.02), 0.85)
}

/** 草地脚步：闷的踩踏 + 草叶摩擦。variant 取 0..2 略改音色 */
export function renderFootstep(sr: number, rng: Rng, variant: number): Float32Array {
  const out = createBuffer(sr, 0.24)
  mix(out, sr, noiseBand(sr, rng, 0.2, 'lowpass', 300 + variant * 45, 0.8, attackDecay(0.004, 0.035)), 0.9)
  mix(out, sr, noiseBand(sr, rng, 0.2, 'bandpass', 2200 + rng.range(0, 700), 0.7, attackDecay(0.015, 0.05)), 0.32, 0.01)
  mix(out, sr, tone(sr, 0.15, 'sine', sweep(95, 55, 0.06), decay(0.03)), 0.5)
  return normalize(fadeEdges(out, sr, 0.001, 0.02), 0.75)
}

/** 受伤：撞击 + 一声短促的闷哼 */
export function renderHurt(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.42)
  mix(out, sr, noiseBand(sr, rng, 0.15, 'lowpass', sweep(1800, 300, 0.08), 0.8, decay(0.03)), 0.9)
  mix(out, sr, tone(sr, 0.3, 'sine', sweep(130, 60, 0.12), decay(0.06)), 0.9)
  const grunt = createBuffer(sr, 0.36)
  const pitch = sweep(168, 104, 0.3)
  addOsc(grunt, sr, 'saw', (t) => pitch(t) * (1 + 0.03 * Math.sin(TWO_PI * 9 * t)), 1)
  filter(grunt, sr, 'bandpass', 680, 1.6)
  applyEnv(grunt, sr, attackDecay(0.02, 0.09))
  mix(out, sr, normalize(grunt, 1), 0.7, 0.02)
  saturate(out, 1.4)
  return normalize(fadeEdges(out, sr, 0, 0.02), 0.9)
}

/** 倒地：重物砸在草地上，带一次较轻的二次触地 */
export function renderBodyFall(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.7)
  mix(out, sr, thud(sr, rng, 0.5, 85, 38, 0.09, 260), 1)
  mix(out, sr, thud(sr, rng, 0.4, 70, 36, 0.06, 200), 0.5, 0.14)
  mix(out, sr, noiseBand(sr, rng, 0.5, 'bandpass', 1800, 0.6, attackDecay(0.03, 0.12)), 0.18, 0.02)
  return normalize(fadeEdges(out, sr, 0, 0.03), 0.9)
}

/** 倒地警告：高—低—高三声警报 */
export function renderDownedAlert(sr: number): Float32Array {
  const out = createBuffer(sr, 0.62)
  const beeps: ReadonlyArray<readonly [time: number, freq: number]> = [
    [0, 932],
    [0.2, 698],
    [0.4, 932],
  ]
  beeps.forEach(([time, freq]) => {
    const beep = tone(sr, 0.16, 'square', freq, trapezoid(0.005, 0.1, 0.04))
    addOsc(beep, sr, 'sine', freq * 2, trapezoid(0.005, 0.08, 0.04))
    mix(out, sr, beep, 0.5, time)
  })
  filter(out, sr, 'lowpass', 3500, 0.7)
  return normalize(fadeEdges(out, sr, 0, 0.02), 0.7)
}

/** 救起：明亮的上行琵音 */
export function renderRevive(sr: number): Float32Array {
  const out = createBuffer(sr, 0.95)
  const notes = [523.25, 659.25, 783.99, 1046.5]
  notes.forEach((freq, i) => {
    const tau = i === notes.length - 1 ? 0.28 : 0.16
    const note = tone(sr, 0.6, 'sine', freq, attackDecay(0.005, tau))
    addOsc(note, sr, 'triangle', freq * 2, (t) => 0.25 * Math.exp(-t / (tau * 0.6)))
    mix(out, sr, note, 0.5, i * 0.09)
  })
  mix(out, sr, tone(sr, 0.6, 'sine', 2093, attackDecay(0.01, 0.22)), 0.12, 0.27)
  return normalize(fadeEdges(out, sr, 0, 0.04), 0.8)
}

/** 空投飞机飞过：螺旋桨轰鸣由左至右掠过，带多普勒降调。返回立体声 */
export function renderPlane(sr: number, rng: Rng): Float32Array[] {
  const seconds = 5
  const loud = bell(2.4, 1.15)
  // 接近时音调偏高，飞过头顶后偏低
  const doppler = (t: number): number => 1.1 - 0.2 * smoothstep((t - 1.8) / 1.2)

  const mono = createBuffer(sr, seconds)
  addOsc(mono, sr, 'saw', (t) => 92 * doppler(t), 0.5)
  addOsc(mono, sr, 'saw', (t) => 138.6 * doppler(t), 0.3)
  addOsc(mono, sr, 'square', (t) => 46 * doppler(t), 0.3)
  filter(mono, sr, 'lowpass', (t) => 350 + 900 * loud(t), 0.8)
  // 桨叶调制
  applyEnv(mono, sr, (t) => 0.75 + 0.25 * Math.sin(TWO_PI * 23 * doppler(t) * t))
  const wash = filter(noise(sr, seconds, rng), sr, 'lowpass', (t) => 300 + 2600 * loud(t), 0.7)
  mix(mono, sr, wash, 0.45)
  applyEnv(mono, sr, loud)
  normalize(fadeEdges(mono, sr, 0.05, 0.1), 0.9)

  // 等功率声像：从左扫到右
  const left = new Float32Array(mono.length)
  const right = new Float32Array(mono.length)
  for (let i = 0; i < mono.length; i++) {
    const angle = (0.1 + 0.8 * smoothstep((i / sr - 1.2) / 2.4)) * (Math.PI / 2)
    const v = mono[i] as number
    left[i] = v * Math.cos(angle)
    right[i] = v * Math.sin(angle)
  }
  return [left, right]
}

/** 空投箱落地：沉闷撞击 + 木箱共鸣 + 金属件晃动 */
export function renderCrateLand(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.75)
  mix(out, sr, thud(sr, rng, 0.5, 120, 48, 0.07, 500), 1)
  mix(out, sr, noiseBand(sr, rng, 0.2, 'bandpass', 620, 5, decay(0.03)), 0.8)
  mix(out, sr, noiseBand(sr, rng, 0.15, 'bandpass', 1150, 6, decay(0.02)), 0.4)
  mix(out, sr, noiseBand(sr, rng, 0.12, 'lowpass', sweep(3000, 400, 0.05), 0.8, decay(0.02)), 0.6)
  for (let i = 0; i < 4; i++) {
    const at = 0.07 + i * 0.05 + rng.range(0, 0.03)
    mix(out, sr, metalClick(sr, rng, rng.range(2200, 3600), 0.04), 0.25 - i * 0.05, at)
  }
  mix(out, sr, noiseBand(sr, rng, 0.6, 'bandpass', 1500, 0.5, attackDecay(0.05, 0.15)), 0.12, 0.03)
  saturate(out, 1.5)
  return normalize(fadeEdges(out, sr, 0, 0.03), 0.9)
}

/** 倒计时滴答 */
export function renderTick(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.07)
  addOsc(out, sr, 'sine', 1500, (t) => 0.8 * Math.exp(-t / 0.008))
  addOsc(out, sr, 'sine', 3000, (t) => 0.3 * Math.exp(-t / 0.004))
  mix(out, sr, noiseBand(sr, rng, 0.02, 'bandpass', 2600, 3, decay(0.003)), 0.5)
  return normalize(fadeEdges(out, sr, 0, 0.01), 0.7)
}

/** 单次心跳：“咚—哒”两下，约 0.5 秒。循环心跳复用这段样本 */
export function renderHeartbeat(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.5)
  const beat = (freq: number): Float32Array => {
    const b = createBuffer(sr, 0.26)
    const env = attackDecay(0.006, 0.045)
    addOsc(b, sr, 'sine', sweep(freq, freq * 0.55, 0.09), env)
    // 二次谐波：小扬声器上也能听见
    addOsc(b, sr, 'sine', sweep(freq * 2, freq * 1.1, 0.09), (t) => 0.25 * env(t))
    mix(b, sr, noiseBand(sr, rng, 0.12, 'lowpass', 130, 0.8, attackDecay(0.004, 0.03)), 0.3)
    return b
  }
  mix(out, sr, beat(68), 1, 0)
  mix(out, sr, beat(82), 0.7, 0.21)
  return normalize(fadeEdges(out, sr, 0.002, 0.03), 0.9)
}

/** 波次完成：上行大三和弦钟琴 */
export function renderWaveClear(sr: number): Float32Array {
  const out = createBuffer(sr, 1.7)
  const notes = [392, 493.88, 587.33, 783.99]
  notes.forEach((freq, i) => {
    const tau = i === notes.length - 1 ? 0.55 : 0.32
    const note = createBuffer(sr, 1.3)
    addOsc(note, sr, 'sine', freq, attackDecay(0.004, tau))
    addOsc(note, sr, 'sine', freq * 2, (t) => 0.35 * Math.exp(-t / (tau * 0.6)))
    addOsc(note, sr, 'sine', freq * 3, (t) => 0.14 * Math.exp(-t / (tau * 0.3)))
    mix(out, sr, note, 0.5, i * 0.11)
  })
  return normalize(fadeEdges(out, sr, 0, 0.05), 0.8)
}

/** 一声铜管式的合成号角 */
function hornStab(sr: number, seconds: number, root: number): Float32Array {
  const out = createBuffer(sr, seconds)
  addOsc(out, sr, 'saw', root, 0.4)
  addOsc(out, sr, 'saw', root * 1.006, 0.4)
  addOsc(out, sr, 'saw', root * 1.5, 0.3)
  addOsc(out, sr, 'square', root / 2, 0.3)
  filter(out, sr, 'lowpass', (t) => 350 + 1500 * Math.min(1, t / 0.04) * Math.exp(-t / (seconds * 0.4)), 1.2)
  return applyEnv(out, sr, trapezoid(0.03, seconds * 0.45, seconds * 0.5))
}

/** 波次开始：不祥的两声低音号角 + 鼓击 */
export function renderWaveStart(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 1.6)
  mix(out, sr, hornStab(sr, 0.3, 110), 0.8, 0)
  mix(out, sr, hornStab(sr, 1.2, 103.83), 1, 0.34)
  mix(out, sr, thud(sr, rng, 0.6, 100, 40, 0.1, 300), 0.9, 0)
  mix(out, sr, thud(sr, rng, 0.8, 95, 36, 0.14, 300), 1, 0.34)
  saturate(out, 1.3)
  return normalize(fadeEdges(out, sr, 0, 0.05), 0.85)
}

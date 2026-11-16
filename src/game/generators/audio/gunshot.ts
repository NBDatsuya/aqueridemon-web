/**
 * 武器音效：四把枪的射击声、空枪、换弹、弹壳落地、切枪。
 * 枪声 = 噪声爆发 + 低通（截止频率快速下扫，模拟枪腔共鸣）+ 快衰减包络，再叠低频冲击与空旷尾音。
 */

import type { WeaponId } from '../../core/types'
import type { Rng } from '../../utils/random'
import {
  addOsc,
  attackDecay,
  createBuffer,
  decay,
  fadeEdges,
  metalClick,
  mix,
  noiseBand,
  normalize,
  saturate,
  sweep,
  tone,
  trapezoid,
} from './synth'

export interface GunSoundConfig {
  /** 基础频率（Hz）：枪腔共鸣与低频冲击的中心 */
  frequency: number
  /** 总时长（秒，含尾音） */
  duration: number
  /** 主体衰减时间（秒） */
  decay: number
  /** 枪口高频爆裂声的量 */
  crack: number
  /** 低频冲击的量 */
  thump: number
  /** 主体噪声低通的起始截止频率（Hz），越高越脆 */
  brightness: number
  /** 空旷尾音的量 */
  tail: number
  /** 饱和失真强度，越大越厚重 */
  drive: number
  /** 枪声之后拉栓上膛 + 弹壳落地的后音：起始时间（秒），缺省为没有 */
  bolt?: number
}

/** 四把枪的音色：AK 低沉、MP5 较脆、MG3 厚重、QBZ 干净 */
export const GUN_SOUNDS: Record<WeaponId, GunSoundConfig> = {
  ak47: { frequency: 150, duration: 0.5, decay: 0.15, crack: 0.7, thump: 1, brightness: 2400, tail: 0.4, drive: 2.4 },
  mp5: { frequency: 300, duration: 0.32, decay: 0.1, crack: 1, thump: 0.45, brightness: 5200, tail: 0.22, drive: 1.7 },
  mg3: { frequency: 105, duration: 0.6, decay: 0.2, crack: 0.85, thump: 1.25, brightness: 2000, tail: 0.55, drive: 3.2 },
  qbz95: { frequency: 220, duration: 0.38, decay: 0.12, crack: 0.6, thump: 0.65, brightness: 3600, tail: 0.25, drive: 1.3 },
  barrett: { frequency: 70, duration: 1.5, decay: 0.28, crack: 1, thump: 1.6, brightness: 1800, tail: 0.8, drive: 3.6, bolt: 0.75 },
}

/**
 * 合成一发枪声。
 * @param sr 采样率
 * @param rng 种子随机数
 * @param config 音色参数
 * @returns 单声道样本
 */
export function synthesizeGunshot(sr: number, rng: Rng, config: GunSoundConfig): Float32Array {
  const { frequency: f, duration, decay: d } = config
  const out = createBuffer(sr, duration)

  // 主体：噪声爆发，低通截止频率从亮到暗快速下扫
  const body = noiseBand(sr, rng, duration, 'lowpass', sweep(config.brightness, f * 2, d * 1.5), 0.9, decay(d / 4.5))
  mix(out, sr, body, 1)

  // 枪口爆裂：极短的高频噪声
  const crack = noiseBand(sr, rng, 0.06, 'highpass', 2500, 0.7, decay(0.004 + d * 0.03))
  mix(out, sr, crack, config.crack)

  // 低频冲击：正弦下扫
  addOsc(out, sr, 'sine', sweep(f * 1.7, f * 0.45, d), (t) => config.thump * Math.exp(-t / (d / 3)))

  // 尾音：空旷场地的回响
  const tail = noiseBand(sr, rng, duration, 'bandpass', sweep(f * 5, f * 2.5, duration), 0.8, attackDecay(0.02, duration / 4))
  mix(out, sr, tail, config.tail)

  // 枪机往复的金属声
  mix(out, sr, metalClick(sr, rng, 3200, 0.03), 0.1, 0.03 + d * 0.15)

  saturate(out, config.drive)

  // 拉栓上膛 + 弹壳落地：在失真之后叠加，保持清脆
  if (config.bolt !== undefined) {
    const at = config.bolt
    mix(out, sr, metalClick(sr, rng, 1900, 0.04), 0.25, at)
    mix(out, sr, noiseBand(sr, rng, 0.14, 'bandpass', sweep(1100, 3000, 0.13), 3, trapezoid(0.015, 0.08, 0.04)), 0.12, at + 0.01)
    mix(out, sr, metalClick(sr, rng, 1600, 0.06), 0.3, at + 0.15)
    mix(out, sr, tone(sr, 0.08, 'sine', sweep(180, 120, 0.05), decay(0.02)), 0.2, at + 0.15)
    mix(out, sr, renderShell(sr, rng), 0.18, at + 0.26)
  }

  fadeEdges(out, sr, 0, 0.03)
  return normalize(out, 0.95)
}

/** 空枪：击锤落空的两声轻响 */
export function renderDry(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.14)
  mix(out, sr, metalClick(sr, rng, 2800, 0.03), 0.9)
  mix(out, sr, metalClick(sr, rng, 1700, 0.05), 0.6, 0.035)
  mix(out, sr, tone(sr, 0.03, 'sine', 420, decay(0.008)), 0.3, 0.035)
  return normalize(fadeEdges(out, sr, 0, 0.01), 0.8)
}

/** 换弹：退弹匣 → 装弹匣（两段“咔哒”）→ 拉栓（频率扫描的滑动感） */
export function renderReload(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 1.55)

  // ① 退弹匣：卡榫解锁 + 弹匣滑出
  mix(out, sr, metalClick(sr, rng, 2200, 0.04), 0.8, 0)
  mix(out, sr, noiseBand(sr, rng, 0.24, 'bandpass', sweep(1900, 700, 0.22), 2, trapezoid(0.02, 0.08, 0.12)), 0.3, 0.03)
  mix(out, sr, noiseBand(sr, rng, 0.1, 'lowpass', 420, 0.8, attackDecay(0.003, 0.02)), 0.35, 0.27)

  // ② 装弹匣：摩擦插入 + 咔 + 哒
  mix(out, sr, noiseBand(sr, rng, 0.13, 'bandpass', sweep(900, 2100, 0.12), 2, trapezoid(0.02, 0.05, 0.05)), 0.28, 0.62)
  mix(out, sr, metalClick(sr, rng, 1500, 0.06), 1, 0.74)
  mix(out, sr, tone(sr, 0.08, 'sine', sweep(210, 150, 0.05), decay(0.018)), 0.55, 0.74)
  mix(out, sr, metalClick(sr, rng, 2600, 0.035), 0.55, 0.81)

  // ③ 拉栓：向后拉（上扫）→ 松手复进（下扫 + 撞击）
  mix(out, sr, metalClick(sr, rng, 2000, 0.03), 0.5, 1.1)
  mix(out, sr, noiseBand(sr, rng, 0.15, 'bandpass', sweep(1200, 3300, 0.14), 3, trapezoid(0.015, 0.09, 0.04)), 0.45, 1.11)
  mix(out, sr, noiseBand(sr, rng, 0.06, 'bandpass', sweep(3200, 1500, 0.05), 3, trapezoid(0.005, 0.03, 0.02)), 0.4, 1.28)
  mix(out, sr, metalClick(sr, rng, 1800, 0.07), 1, 1.32)
  mix(out, sr, tone(sr, 0.08, 'sine', sweep(190, 130, 0.05), decay(0.02)), 0.5, 1.32)

  return normalize(fadeEdges(out, sr, 0, 0.02), 0.85)
}

/** 弹壳落地：黄铜壳弹跳几下的清脆“叮”声 */
export function renderShell(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.45)
  const bounces: ReadonlyArray<readonly [time: number, amp: number]> = [
    [0, 1],
    [0.11, 0.55],
    [0.19, 0.3],
    [0.24, 0.16],
  ]
  bounces.forEach(([time, amp]) => {
    const pitch = 1 + rng.range(-0.08, 0.08)
    const ping = createBuffer(sr, 0.18)
    addOsc(ping, sr, 'sine', 3100 * pitch, (t) => Math.exp(-t / 0.035))
    addOsc(ping, sr, 'sine', 4750 * pitch, (t) => 0.6 * Math.exp(-t / 0.025))
    addOsc(ping, sr, 'sine', 6900 * pitch, (t) => 0.35 * Math.exp(-t / 0.014))
    mix(ping, sr, noiseBand(sr, rng, 0.01, 'highpass', 5000, 0.7, decay(0.002)), 0.5)
    mix(out, sr, ping, amp, time)
  })
  return normalize(fadeEdges(out, sr, 0, 0.02), 0.7)
}

/** 切枪：衣物摩擦 + 两声金属卡位 */
export function renderSwitch(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.32)
  mix(out, sr, noiseBand(sr, rng, 0.16, 'bandpass', sweep(700, 1300, 0.14), 0.8, trapezoid(0.03, 0.03, 0.09)), 0.35)
  mix(out, sr, metalClick(sr, rng, 1300, 0.05), 0.8, 0.1)
  mix(out, sr, metalClick(sr, rng, 2400, 0.035), 0.6, 0.19)
  return normalize(fadeEdges(out, sr, 0.002, 0.02), 0.8)
}

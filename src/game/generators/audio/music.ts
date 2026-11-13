/**
 * 程序化背景音乐：lookahead 调度器（定时器只负责把未来 0.2 秒内的音符排进 AudioContext 时间线）
 * + 预定义的和声 / 旋律 / 节奏素材 + 种子随机变化（每段随机选和声进行、贝斯型、琶音型、加花）。
 * 旋律乐器用实时振荡器，打击乐用预渲染的 AudioBuffer。音高一律用 MIDI 音符号表示。
 */

import type { MusicTrack } from '../../core/types'
import type { Rng } from '../../utils/random'
import { createRng, hashSeed } from '../../utils/random'
import type { DnbAssets } from './dnb'
import { buildDnb, renderDnbAssets } from './dnb'
import { addOsc, attackDecay, createBuffer, decay, fadeEdges, mix, noiseBand, normalize, saturate, sweep } from './synth'

/** 提前调度的时间窗（秒） */
const LOOKAHEAD = 0.2
/** 调度定时器间隔（毫秒） */
const TICK_MS = 40
/** 每小节 16 步（十六分音符） */
const STEPS = 16
/** 切换曲目时旧曲淡出时长（秒） */
const FADE_OUT = 1.8
/** 间歇期相对战斗期的音量 */
const INTERMISSION_LEVEL = 0.3
/** 定音鼓样本的基准音（C2） */
const TIMPANI_BASE = 36

/** bossLegacy 是被 Drum and Bass 取代的原版 Boss 曲，游戏内不再播放，只在音乐鉴赏里离线渲染 */
export type SongId = 'menu' | 'combat' | 'boss' | 'bossLegacy' | 'he' | 'ne'

/** 曲目 → 素材。battle 与 intermission 共用同一首（间歇期去鼓、降音量）；none / be 无音乐 */
const SONG_OF: Record<MusicTrack, SongId | null> = {
  none: null,
  be: null,
  menu: 'menu',
  battle: 'combat',
  intermission: 'combat',
  boss: 'boss',
  he: 'he',
  ne: 'ne',
}

const LEVEL: Record<SongId, number> = { menu: 0.9, combat: 0.8, boss: 0.85, bossLegacy: 0.85, he: 0.8, ne: 0.9 }
const FADE_IN: Record<SongId, number> = { menu: 2.5, combat: 0.8, boss: 0.6, bossLegacy: 1, he: 1.5, ne: 2.5 }
/** Boss 曲（Drum and Bass）的鼓和贝斯要干，整体发送很少；铺底与主音在 dnb.ts 里单独发送混响 */
const REVERB_SEND: Record<SongId, number> = { menu: 0.5, combat: 0.12, boss: 0.05, bossLegacy: 0.3, he: 0.35, ne: 0.5 }

interface Chord {
  /** 低音 */
  bass: number
  /** 和弦音（中音区） */
  tones: readonly number[]
}

/** 旋律音符：[小节内起始步, MIDI 音高, 时值（步）] */
type MelodyNote = readonly [step: number, midi: number, length: number]
/** 一段 8 小节的旋律 */
type Phrase = readonly (readonly MelodyNote[])[]

const chord = (bass: number, ...tones: number[]): Chord => ({ bass, tones })

/** 循环取值（下标自动取模） */
const at = <T>(items: readonly T[], index: number): T =>
  items[((index % items.length) + items.length) % items.length] as T

const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/* ── 素材：战斗（D 小调，132 BPM） ── */

const C_DM = chord(38, 62, 65, 69)
const C_BB = chord(34, 62, 65, 70)
const C_C = chord(36, 60, 64, 67)
const C_F = chord(41, 60, 65, 69)
const C_GM = chord(43, 62, 67, 70)
const C_A = chord(33, 61, 64, 69)

const COMBAT_PROGRESSIONS: readonly (readonly Chord[])[] = [
  [C_DM, C_DM, C_BB, C_C, C_DM, C_DM, C_GM, C_A],
  [C_DM, C_BB, C_F, C_C, C_DM, C_BB, C_GM, C_A],
  [C_DM, C_C, C_BB, C_A, C_DM, C_F, C_GM, C_A],
]

/** 贝斯型：每步相对根音的半音数，-1 为休止 */
const BASS_PATTERNS: readonly (readonly number[])[] = [
  [0, -1, 0, 0, 12, -1, 0, 0, 0, -1, 0, 12, 0, -1, 7, 12],
  [0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 12, 0, 7, 0, 12, 10],
  [0, -1, -1, 0, -1, -1, 0, -1, 0, -1, -1, 0, -1, 12, -1, 0],
]

/** 琶音型：每步取第几个和弦音（超出个数则高八度），-1 为休止 */
const ARP_PATTERNS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, -1],
  [0, -1, 2, 0, 3, -1, 2, 0, 4, -1, 3, 2, 0, 2, 3, 5],
  [3, 2, 1, 0, 3, 2, 1, 0, 4, 3, 2, 1, 4, 3, 2, 1],
]

/** 弦乐断奏落在哪几步（3+3+2 切分） */
const STAB_STEPS: readonly number[] = [0, 3, 6, 8, 11, 14]

/* ── 素材：Boss ──
 * Drum and Bass（174 BPM，F 小调，Amen 式切片碎拍 + reese 贝斯），见 dnb.ts */

/* ── 素材：原版 Boss（C 小调，108 BPM，仅音乐鉴赏使用） ── */

const B_CM = chord(36, 60, 63, 67)
const B_AB = chord(32, 60, 63, 68)
const B_BB = chord(34, 58, 62, 65)
const B_EB = chord(39, 58, 63, 67)
const B_FM = chord(41, 60, 65, 68)
const B_G = chord(31, 59, 62, 67)

const BOSS_PROGRESSION: readonly Chord[] = [B_CM, B_CM, B_AB, B_BB, B_CM, B_EB, B_FM, B_G]

/** 定音鼓型：每步力度，0 为休止 */
const BOSS_TIMPANI: readonly (readonly number[])[] = [
  [1, 0, 0, 0.5, 0, 0, 0.6, 0, 0.9, 0, 0, 0.5, 0, 0, 0.7, 0],
  [1, 0, 0, 0, 0, 0, 0.6, 0, 0.9, 0, 0.5, 0, 0.6, 0, 0.7, 0.4],
  [1, 0, 0.4, 0.5, 0, 0, 0.7, 0, 1, 0, 0.4, 0.5, 0, 0, 0.7, 0.5],
]

/** 弦乐固定音型：每个八分音符相对根音的半音数 */
const BOSS_OSTINATO: readonly number[] = [0, 0, 7, 0, 0, 0, 7, 12]

/** 铜管和弦节奏：[起始步, 时值（步）] */
const BRASS_LONG: readonly (readonly [number, number])[] = [[0, 14]]
const BRASS_RHYTHM: readonly (readonly [number, number])[] = [
  [0, 5],
  [6, 1.5],
  [8, 7],
]

const BOSS_MELODIES: readonly Phrase[] = [
  [
    [[0, 55, 8], [8, 60, 8]],
    [[0, 63, 6], [6, 62, 2], [8, 60, 8]],
    [[0, 56, 8], [8, 60, 4], [12, 63, 4]],
    [[0, 62, 12], [12, 58, 4]],
    [[0, 60, 8], [8, 67, 8]],
    [[0, 67, 6], [6, 65, 2], [8, 63, 8]],
    [[0, 65, 8], [8, 68, 4], [12, 67, 4]],
    [[0, 67, 8], [8, 62, 8]],
  ],
  [
    [[0, 60, 4], [4, 62, 4], [8, 63, 8]],
    [[0, 67, 12], [12, 65, 4]],
    [[0, 63, 8], [8, 60, 8]],
    [[0, 62, 8], [8, 65, 8]],
    [[0, 63, 4], [4, 65, 4], [8, 67, 8]],
    [[0, 70, 12], [12, 67, 4]],
    [[0, 68, 8], [8, 65, 8]],
    [[0, 67, 16]],
  ],
]

/* ── 素材：主菜单（D 小调，极慢） ── */

const MENU_CHORDS: readonly Chord[] = [
  chord(38, 50, 57, 64, 65),
  chord(34, 46, 53, 57, 62),
  chord(31, 43, 55, 58, 62),
  chord(33, 45, 52, 55, 62),
]

/** 零星钟音的可选音高（含一个不安的升 C） */
const MENU_BELLS: readonly number[] = [69, 72, 74, 76, 77, 81, 73]

/* ── 素材：HE（C 大调，88 BPM） ── */

const HE_CHORDS: readonly Chord[] = [
  chord(36, 60, 64, 67),
  chord(31, 59, 62, 67),
  chord(33, 60, 64, 69),
  chord(29, 60, 65, 69),
  chord(40, 60, 64, 67),
  chord(41, 60, 65, 69),
  chord(43, 59, 62, 67),
  chord(36, 60, 64, 67),
]

const HE_ARP: readonly number[] = [0, 1, 2, 3, 4, 5, 4, 2]

const HE_MELODY: Phrase = [
  [[0, 76, 4], [4, 79, 4], [8, 84, 8]],
  [[0, 83, 6], [6, 81, 2], [8, 79, 8]],
  [[0, 81, 4], [4, 84, 4], [8, 88, 8]],
  [[0, 84, 6], [6, 81, 2], [8, 77, 8]],
  [[0, 79, 4], [4, 84, 4], [8, 88, 8]],
  [[0, 89, 6], [6, 88, 2], [8, 84, 8]],
  [[0, 86, 8], [8, 83, 4], [12, 86, 4]],
  [[0, 84, 16]],
]

/* ── 素材：NE（D 小调，54 BPM） ── */

const NE_CHORDS: readonly Chord[] = [
  chord(38, 50, 57, 62, 65),
  chord(34, 46, 53, 58, 62),
  chord(31, 43, 55, 58, 62),
  chord(33, 45, 52, 57, 61),
  chord(38, 50, 57, 62, 65),
  chord(29, 48, 53, 57, 60),
  chord(31, 43, 55, 58, 62),
  chord(33, 45, 52, 57, 61),
]

const NE_MELODY: Phrase = [
  [[0, 69, 8], [8, 65, 4], [12, 64, 4]],
  [[0, 62, 12], [12, 65, 4]],
  [[0, 67, 8], [8, 70, 8]],
  [[0, 69, 10], [10, 67, 2], [12, 64, 4]],
  [[0, 65, 8], [8, 74, 8]],
  [[0, 72, 8], [8, 69, 8]],
  [[0, 70, 6], [6, 69, 2], [8, 67, 8]],
  [[0, 64, 8], [8, 61, 8]],
]

/* ── 打击乐（预渲染） ── */

interface DrumKit {
  kick: AudioBuffer
  snare: AudioBuffer
  hat: AudioBuffer
  /** 定音鼓，基准音 C2，靠播放速率变调 */
  timpani: AudioBuffer
  /** 大鼓 / 冲击 */
  impact: AudioBuffer
  cymbal: AudioBuffer
}

function renderKick(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.4)
  addOsc(out, sr, 'sine', sweep(150, 45, 0.12), decay(0.11))
  mix(out, sr, noiseBand(sr, rng, 0.02, 'highpass', 2000, 0.7, decay(0.003)), 0.4)
  saturate(out, 1.6)
  return normalize(fadeEdges(out, sr, 0, 0.03), 0.95)
}

function renderSnare(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 0.28)
  mix(out, sr, noiseBand(sr, rng, 0.25, 'bandpass', 1900, 0.7, decay(0.06)), 1)
  mix(out, sr, noiseBand(sr, rng, 0.2, 'highpass', 5000, 0.7, decay(0.04)), 0.5)
  addOsc(out, sr, 'sine', sweep(210, 170, 0.05), (t) => 0.6 * Math.exp(-t / 0.04))
  return normalize(fadeEdges(out, sr, 0, 0.03), 0.9)
}

function renderHat(sr: number, rng: Rng): Float32Array {
  const out = noiseBand(sr, rng, 0.09, 'highpass', 7000, 0.7, decay(0.018))
  return normalize(fadeEdges(out, sr, 0, 0.01), 0.8)
}

function renderTimpani(sr: number, rng: Rng): Float32Array {
  const f = hz(TIMPANI_BASE)
  const out = createBuffer(sr, 1.7)
  // 鼓皮：基频起音时略高，叠几个不整数倍的泛音
  addOsc(out, sr, 'sine', (t) => f * (1 + 0.08 * Math.exp(-t / 0.03)), decay(0.5))
  addOsc(out, sr, 'sine', f * 1.5, (t) => 0.45 * Math.exp(-t / 0.3))
  addOsc(out, sr, 'sine', f * 1.99, (t) => 0.25 * Math.exp(-t / 0.2))
  addOsc(out, sr, 'sine', f * 2.44, (t) => 0.1 * Math.exp(-t / 0.12))
  mix(out, sr, noiseBand(sr, rng, 0.1, 'lowpass', 600, 0.8, attackDecay(0.002, 0.02)), 0.5)
  saturate(out, 1.2)
  return normalize(fadeEdges(out, sr, 0, 0.1), 0.9)
}

function renderImpact(sr: number, rng: Rng): Float32Array {
  const out = createBuffer(sr, 1.6)
  addOsc(out, sr, 'sine', sweep(90, 32, 0.4), decay(0.35))
  mix(out, sr, noiseBand(sr, rng, 1, 'lowpass', sweep(1500, 100, 0.3), 0.8, decay(0.12)), 0.8)
  saturate(out, 2)
  return normalize(fadeEdges(out, sr, 0, 0.1), 0.95)
}

function renderCymbal(sr: number, rng: Rng): Float32Array {
  const out = noiseBand(sr, rng, 1.8, 'highpass', 4000, 0.7, attackDecay(0.005, 0.5))
  mix(out, sr, noiseBand(sr, rng, 1.8, 'bandpass', 8000, 1, attackDecay(0.005, 0.35)), 0.5)
  return normalize(fadeEdges(out, sr, 0, 0.1), 0.8)
}

function buildKit(ctx: BaseAudioContext): DrumKit {
  const sr = ctx.sampleRate
  const rng = createRng(hashSeed('cis2-drum-kit'))
  const toBuffer = (data: Float32Array): AudioBuffer => {
    const buffer = ctx.createBuffer(1, data.length, sr)
    buffer.getChannelData(0).set(data)
    return buffer
  }
  return {
    kick: toBuffer(renderKick(sr, rng)),
    snare: toBuffer(renderSnare(sr, rng)),
    hat: toBuffer(renderHat(sr, rng)),
    timpani: toBuffer(renderTimpani(sr, rng)),
    impact: toBuffer(renderImpact(sr, rng)),
    cymbal: toBuffer(renderCymbal(sr, rng)),
  }
}

/* ── 播放器 ── */

interface NoteSpec {
  /** 起始时刻（AudioContext 时间） */
  time: number
  midi: number
  /** 按住时长（秒），之后进入释音 */
  duration: number
  gain: number
  wave: Exclude<OscillatorType, 'custom'>
  /** 每个振荡器的失谐（音分），数组长度即振荡器数量；默认单个不失谐 */
  detune?: readonly number[]
  attack?: number
  release?: number
  /** 低通起始截止频率（Hz）；不给则不过滤波器 */
  cutoff?: number
  /** 低通结束截止频率：高于起始值是铜管式的“张开”，低于起始值是拨弦式的“收拢” */
  cutoffEnd?: number
  /** 截止频率过渡时长（秒） */
  cutoffTime?: number
  resonance?: number
  /** 颤音深度（音分） */
  vibrato?: number
}

interface SongParts {
  /** 一步（十六分音符）的时长 */
  stepDur: number
  /** 把第 step 步的全部音符排到 time 时刻 */
  schedule: (step: number, time: number) => void
  /** 同一素材内切换模式（battle ↔ intermission），返回音量倍率 */
  setMode?: (track: MusicTrack) => number
  /** 常驻声源（长音、LFO），销毁时停止 */
  sustained: AudioScheduledSourceNode[]
}

interface Song {
  id: SongId
  out: GainNode
  send: GainNode
  parts: SongParts
  step: number
  nextTime: number
  /** 淡出结束时刻；0 表示仍在正常播放 */
  endAt: number
}

export interface MusicPlayer {
  /** 切换曲目（交叉淡入淡出）；相同曲目重复调用无效果 */
  setTrack(track: MusicTrack): void
  dispose(): void
}

/** 乐器、打击乐样本、共享混响与各曲目的搭建函数；实时播放器与离线渲染共用 */
interface SongBank {
  /** 共享混响的输入 */
  reverb: ConvolverNode
  /** 混响返回（接到 output） */
  reverbReturn: GainNode
  /** 搭建一首曲子的节点图，返回按步调度的回调 */
  build: (id: SongId, out: GainNode, rng: Rng, track: MusicTrack) => SongParts
}

/**
 * 创建曲库。只搭共享节点，不启动任何定时器，所以也能用在 OfflineAudioContext 上。
 * @param ctx 音频上下文（实时或离线）
 * @param output 混响返回接到哪里
 * @param impulse 混响用的冲激响应
 * @param eagerDnb 是否立刻渲染 Boss 曲的碎拍素材（实时播放在解锁时渲染，Boss 登场时不卡顿）
 */
function createSongBank(ctx: BaseAudioContext, output: AudioNode, impulse: AudioBuffer, eagerDnb: boolean): SongBank {
  const kit = buildKit(ctx)
  /** Boss 曲的碎拍与效果缓冲：渲染一次，每场 Boss 战复用 */
  let dnb: DnbAssets | null = eagerDnb ? renderDnbAssets(ctx) : null

  const reverb = ctx.createConvolver()
  reverb.buffer = impulse
  const reverbReturn = ctx.createGain()
  reverbReturn.gain.value = 0.7
  reverb.connect(reverbReturn)
  reverbReturn.connect(output)

  /* ── 乐器 ── */

  /** 合成器音符：若干失谐振荡器 →（低通）→ 音量包络 */
  const playNote = (dest: AudioNode, n: NoteSpec): void => {
    const attack = n.attack ?? 0.01
    const release = n.release ?? 0.1
    const hold = Math.max(n.duration, attack)
    const end = n.time + hold + release

    const env = ctx.createGain()
    env.gain.setValueAtTime(0, n.time)
    env.gain.linearRampToValueAtTime(n.gain, n.time + attack)
    env.gain.setValueAtTime(n.gain, n.time + hold)
    env.gain.linearRampToValueAtTime(0, end)
    env.connect(dest)

    let input: AudioNode = env
    if (n.cutoff !== undefined) {
      const lowpass = ctx.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.Q.value = n.resonance ?? 0.8
      lowpass.frequency.setValueAtTime(n.cutoff, n.time)
      if (n.cutoffEnd !== undefined) {
        lowpass.frequency.exponentialRampToValueAtTime(Math.max(40, n.cutoffEnd), n.time + (n.cutoffTime ?? hold))
      }
      lowpass.connect(env)
      input = lowpass
    }

    let vibrato: GainNode | null = null
    if (n.vibrato) {
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 5.3
      vibrato = ctx.createGain()
      // 颤音渐入，像弦乐 / 铜管的长音
      vibrato.gain.setValueAtTime(0, n.time)
      vibrato.gain.linearRampToValueAtTime(n.vibrato, n.time + Math.min(hold, 0.4))
      lfo.connect(vibrato)
      lfo.start(n.time)
      lfo.stop(end + 0.05)
    }

    const freq = hz(n.midi)
    const detunes = n.detune ?? [0]
    detunes.forEach((cents, i) => {
      const osc = ctx.createOscillator()
      osc.type = n.wave
      osc.frequency.value = freq
      osc.detune.value = cents
      if (vibrato) vibrato.connect(osc.detune)
      osc.connect(input)
      osc.start(n.time)
      osc.stop(end + 0.05)
      if (i === 0) osc.onended = () => env.disconnect()
    })
  }

  /** 打击乐：播放预渲染样本，rate 用来变调 */
  const playDrum = (dest: AudioNode, buffer: AudioBuffer, time: number, gain: number, rate = 1): void => {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = rate
    const level = ctx.createGain()
    level.gain.value = gain
    source.connect(level)
    level.connect(dest)
    source.onended = () => level.disconnect()
    source.start(time)
  }

  /** 定音鼓：按音高换算播放速率 */
  const playTimpani = (dest: AudioNode, time: number, midi: number, gain: number): void => {
    playDrum(dest, kit.timpani, time, gain, Math.pow(2, (midi - TIMPANI_BASE) / 12))
  }

  /** 按旋律表找出这一步起音的音符 */
  const notesAt = (phrase: Phrase, bar: number, step: number): MelodyNote[] =>
    at(phrase, bar).filter((note) => note[0] === step)

  /* ── 各曲目 ── */

  /** 战斗 / 间歇：底鼓 + 锯齿波贝斯 + 合成弦 + 滤波扫描；间歇期去掉鼓、贝斯只留四分音符 */
  const buildCombat = (out: GainNode, rng: Rng, track: MusicTrack): SongParts => {
    const stepDur = 60 / 132 / 4
    const barDur = stepDur * STEPS

    // 弦乐与琶音共用的扫频低通
    const sweepFilter = ctx.createBiquadFilter()
    sweepFilter.type = 'lowpass'
    sweepFilter.Q.value = 2.5
    sweepFilter.frequency.value = 600
    sweepFilter.connect(out)

    let drums = track === 'battle'
    let progression = at(COMBAT_PROGRESSIONS, 0)
    let bassPattern = at(BASS_PATTERNS, 0)
    let arpPattern = at(ARP_PATTERNS, 0)
    let extraKick = false
    let cutoff = 600

    const schedule = (step: number, time: number): void => {
      const s = step % STEPS
      const bar = Math.floor(step / STEPS)
      const barInSection = bar % 8
      const section = Math.floor(bar / 8) % 4

      if (s === 0) {
        // 每 8 小节换一组素材（种子随机）
        if (barInSection === 0 && bar > 0) {
          progression = rng.pick(COMBAT_PROGRESSIONS)
          bassPattern = rng.pick(BASS_PATTERNS)
          arpPattern = rng.pick(ARP_PATTERNS)
        }
        extraKick = rng.chance(0.3)
        // 滤波扫描：8 小节一个来回，450Hz ↔ 3150Hz
        const position = 0.5 - 0.5 * Math.cos((Math.PI * 2 * (barInSection + 1)) / 8)
        const target = 450 * Math.pow(7, position)
        sweepFilter.frequency.setValueAtTime(cutoff, time)
        sweepFilter.frequency.linearRampToValueAtTime(target, time + barDur)
        cutoff = target
      }

      const harmony = at(progression, barInSection)
      const breakdown = section === 3 && barInSection < 4
      const lastBar = barInSection === 7

      if (drums) {
        if (s === 0 && barInSection === 0) playDrum(out, kit.cymbal, time, 0.16)
        if (!breakdown) {
          if (s % 4 === 0) playDrum(out, kit.kick, time, 0.85)
          else if (extraKick && s === 14) playDrum(out, kit.kick, time, 0.55)
          // 每段最后一小节末尾加花
          if (lastBar && s >= 12) playDrum(out, kit.snare, time, 0.22 + 0.08 * (s - 12))
          else if (section >= 1 && (s === 4 || s === 12)) playDrum(out, kit.snare, time, 0.42)
        }
        if (s % 4 === 2) playDrum(out, kit.hat, time, breakdown ? 0.1 : 0.2)
        else if (section >= 2 && !breakdown && s % 2 === 1) playDrum(out, kit.hat, time, 0.07)
      }

      // 锯齿波贝斯：每个音自带一次低通“收拢”，张开程度跟随扫描位置
      const offset = at(bassPattern, s)
      if (offset >= 0 && (drums || s % 4 === 0)) {
        const midi = harmony.bass + (drums ? offset : 0)
        playNote(out, {
          time,
          midi,
          duration: stepDur * (drums ? 0.7 : 2.5),
          gain: drums ? 0.15 : 0.11,
          wave: 'sawtooth',
          detune: [-6, 6],
          attack: 0.004,
          release: 0.06,
          cutoff: 300 + cutoff * 0.8,
          cutoffEnd: 180,
          cutoffTime: 0.14,
          resonance: 5,
        })
        if (s % 4 === 0) {
          playNote(out, { time, midi, duration: stepDur * 1.5, gain: 0.16, wave: 'sine', attack: 0.005, release: 0.08 })
        }
      }

      // 合成弦：长音铺底或 3+3+2 断奏
      const pad = !drums || section === 1 || breakdown
      const stabs = drums && !breakdown && section >= 2
      if (pad && s === 0) {
        harmony.tones.forEach((midi) => {
          playNote(sweepFilter, {
            time,
            midi,
            duration: barDur - 0.3,
            gain: 0.03,
            wave: 'sawtooth',
            detune: [-9, 8],
            attack: 0.12,
            release: 0.3,
          })
        })
      }
      if (stabs && STAB_STEPS.includes(s)) {
        harmony.tones.forEach((midi) => {
          playNote(sweepFilter, {
            time,
            midi,
            duration: stepDur * 1.3,
            gain: 0.034,
            wave: 'sawtooth',
            detune: [-9, 8],
            attack: 0.008,
            release: 0.08,
          })
        })
      }

      // 方波琶音
      const arp = drums ? section >= 2 : bar % 2 === 1
      const index = at(arpPattern, s)
      if (arp && index >= 0) {
        const tones = harmony.tones
        const midi = at(tones, index) + 12 * Math.floor(index / tones.length) + 12
        playNote(sweepFilter, {
          time,
          midi,
          duration: stepDur * 0.6,
          gain: 0.03,
          wave: 'square',
          attack: 0.004,
          release: 0.06,
        })
      }
    }

    const setMode = (next: MusicTrack): number => {
      drums = next === 'battle'
      return drums ? 1 : INTERMISSION_LEVEL
    }

    return { stepDur, schedule, setMode, sustained: [] }
  }

  /** Boss 战：Drum and Bass（Amen 式切片碎拍 + reese 贝斯 + 暗色铺底 / hoover），前奏 8 小节后落拍，见 dnb.ts */
  const buildBoss = (out: GainNode, rng: Rng): SongParts => {
    dnb ??= renderDnbAssets(ctx)
    return buildDnb(ctx, out, reverb, rng, dnb)
  }

  /** 原版 Boss 战（已被 Drum and Bass 取代）：低音铜管式合成 + 定音鼓 + 弦乐固定音型 + 圆号主题，逐段加厚 */
  const buildBossLegacy = (out: GainNode, rng: Rng): SongParts => {
    const stepDur = 60 / 108 / 4
    const barDur = stepDur * STEPS
    let melody = at(BOSS_MELODIES, 0)
    let timpani = at(BOSS_TIMPANI, 0)

    const brass = (time: number, midi: number, duration: number): void => {
      playNote(out, {
        time,
        midi,
        duration,
        gain: 0.07,
        wave: 'sawtooth',
        detune: [-5, 5],
        attack: 0.05,
        release: 0.2,
        cutoff: 180,
        cutoffEnd: 1300,
        cutoffTime: 0.09,
        resonance: 1.2,
      })
    }

    const horn = (time: number, midi: number, duration: number, gain: number): void => {
      playNote(out, {
        time,
        midi,
        duration,
        gain,
        wave: 'sawtooth',
        detune: [-6, 0, 6],
        attack: 0.06,
        release: 0.18,
        cutoff: 260,
        cutoffEnd: 1900,
        cutoffTime: 0.1,
        resonance: 1,
        vibrato: 7,
      })
    }

    const schedule = (step: number, time: number): void => {
      const s = step % STEPS
      const bar = Math.floor(step / STEPS)
      const barInSection = bar % 8
      const section = Math.floor(bar / 8) % 4
      const harmony = at(BOSS_PROGRESSION, barInSection)

      if (s === 0 && barInSection === 0) {
        if (bar > 0) {
          melody = rng.pick(BOSS_MELODIES)
          timpani = rng.pick(BOSS_TIMPANI)
        }
        playDrum(out, kit.cymbal, time, 0.2)
      }
      if (s === 0 && barInSection % 4 === 0) playDrum(out, kit.impact, time, 0.6)

      // 定音鼓：每段最后一小节后半是渐强滚奏
      if (barInSection === 7 && s >= 8) {
        playTimpani(out, time, harmony.bass + 12, 0.2 + 0.07 * (s - 8))
      } else {
        const hit = at(timpani, s)
        if (hit > 0) playTimpani(out, time, harmony.bass + (s === 14 ? 7 : 0) + (harmony.bass < 34 ? 12 : 0), hit * 0.6)
      }

      // 低音铜管：根音 + 五度 + 八度的强力和弦
      const rhythm = section >= 2 ? BRASS_RHYTHM : BRASS_LONG
      rhythm.forEach(([start, length]) => {
        if (start !== s) return
        const duration = length * stepDur
        brass(time, harmony.bass, duration)
        brass(time, harmony.bass + 7, duration)
        brass(time, harmony.bass + 12, duration)
      })

      // 弦乐固定音型：八分音符，后两段加密成十六分
      if (s % 2 === 0 || section >= 2) {
        playNote(out, {
          time,
          midi: harmony.bass + 12 + at(BOSS_OSTINATO, Math.floor(s / 2)),
          duration: stepDur * 0.5,
          gain: s % 2 === 0 ? 0.05 : 0.03,
          wave: 'sawtooth',
          detune: [-4, 4],
          attack: 0.004,
          release: 0.05,
          cutoff: 1500,
        })
      }

      // 圆号主题：第二段起进入，最后一段叠高八度
      if (section >= 1) {
        notesAt(melody, barInSection, s).forEach((note) => {
          const duration = note[2] * stepDur - 0.05
          horn(time, note[1], duration, 0.05)
          if (section === 3) horn(time, note[1] + 12, duration, 0.028)
        })
      }

      // 高音区铺底（合唱感）
      if (section >= 2 && s === 0) {
        harmony.tones.forEach((midi) => {
          playNote(out, {
            time,
            midi: midi + 12,
            duration: barDur - 0.7,
            gain: 0.03,
            wave: 'triangle',
            detune: [-8, 8],
            attack: 0.5,
            release: 0.6,
          })
        })
      }
    }

    return { stepDur, schedule, sustained: [] }
  }

  /** 主菜单：持续的低频 drone + 缓慢起伏的暗色和弦 + 零星钟音 */
  const buildMenu = (out: GainNode, rng: Rng): SongParts => {
    const stepDur = 0.5

    // drone：D1 两个失谐锯齿波 + D2 正弦，过一个被 LFO 缓慢推动的低通
    const droneFilter = ctx.createBiquadFilter()
    droneFilter.type = 'lowpass'
    droneFilter.frequency.value = 180
    droneFilter.Q.value = 3
    const droneGain = ctx.createGain()
    droneGain.gain.value = 0.5
    droneFilter.connect(droneGain)
    droneGain.connect(out)

    const sustained: AudioScheduledSourceNode[] = []
    const droneOsc = (type: OscillatorType, freq: number, cents: number): void => {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = freq
      osc.detune.value = cents
      osc.connect(droneFilter)
      sustained.push(osc)
    }
    droneOsc('sawtooth', hz(26), -6)
    droneOsc('sawtooth', hz(26), 7)
    droneOsc('sine', hz(38), 0)

    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.06
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 70
    lfo.connect(lfoDepth)
    lfoDepth.connect(droneFilter.frequency)
    sustained.push(lfo)
    sustained.forEach((source) => source.start())

    const schedule = (step: number, time: number): void => {
      const s = step % STEPS
      const bar = Math.floor(step / STEPS)

      // 暗色和弦：每小节（8 秒）一个，慢起慢落，前后交叠
      if (s === 0) {
        at(MENU_CHORDS, bar).tones.forEach((midi) => {
          playNote(out, {
            time,
            midi,
            duration: 4.5,
            gain: 0.028,
            wave: 'sawtooth',
            detune: [-7, 7],
            attack: 3,
            release: 3.5,
            cutoff: 500,
            resonance: 0.7,
          })
        })
        if (bar % 2 === 0) playDrum(out, kit.impact, time, 0.35, 0.7)
      }
      if (s === 8 && bar % 4 === 3) playDrum(out, kit.cymbal, time, 0.06, 0.25)

      // 零星钟音 + 一次回声
      if (rng.chance(0.2)) {
        const midi = rng.pick(MENU_BELLS)
        const bell = (when: number, gain: number): void => {
          playNote(out, { time: when, midi, duration: 0.05, gain, wave: 'sine', attack: 0.005, release: 2.2 })
          playNote(out, { time: when, midi: midi + 19, duration: 0.05, gain: gain * 0.2, wave: 'sine', attack: 0.005, release: 1 })
        }
        bell(time, 0.07)
        bell(time + 0.75, 0.03)
      }
    }

    return { stepDur, schedule, sustained }
  }

  /** HE：明亮舒缓的胜利段落——柔和铺底 + 上行琶音 + 三角波主旋律 + 轻轻的进行曲鼓点 */
  const buildHe = (out: GainNode, rng: Rng): SongParts => {
    const stepDur = 60 / 88 / 4
    const barDur = stepDur * STEPS
    let shift = 0

    const schedule = (step: number, time: number): void => {
      const s = step % STEPS
      const bar = Math.floor(step / STEPS)
      const barInPhrase = bar % 8
      const harmony = at(HE_CHORDS, barInPhrase)

      if (s === 0) {
        // 每轮重复时随机决定主旋律是否低八度
        if (barInPhrase === 0 && bar > 0) shift = rng.chance(0.5) ? -12 : 0
        if (barInPhrase === 0) playDrum(out, kit.cymbal, time, 0.1)
        playTimpani(out, time, harmony.bass < 34 ? harmony.bass + 12 : harmony.bass, 0.3)
        harmony.tones.forEach((midi) => {
          playNote(out, {
            time,
            midi,
            duration: barDur - 0.5,
            gain: 0.05,
            wave: 'triangle',
            detune: [-6, 6],
            attack: 0.35,
            release: 0.5,
          })
          playNote(out, {
            time,
            midi,
            duration: barDur - 0.5,
            gain: 0.014,
            wave: 'sawtooth',
            attack: 0.4,
            release: 0.5,
            cutoff: 1200,
          })
        })
      }

      // 低音：每小节两下
      if (s === 0 || s === 8) {
        playNote(out, {
          time,
          midi: harmony.bass + 12,
          duration: stepDur * 6,
          gain: 0.2,
          wave: 'triangle',
          attack: 0.02,
          release: 0.3,
        })
      }

      // 进行曲式的轻军鼓，句尾滚奏
      if (barInPhrase === 7 && s >= 12) playDrum(out, kit.snare, time, 0.04 + 0.02 * (s - 12))
      else if (s === 4 || s === 12) playDrum(out, kit.snare, time, 0.05)

      // 上行琶音（八分音符）
      if (s % 2 === 0) {
        const index = at(HE_ARP, s / 2)
        const tones = harmony.tones
        const midi = at(tones, index) + 12 * Math.floor(index / tones.length) + 12
        playNote(out, { time, midi, duration: 0.05, gain: 0.07, wave: 'triangle', attack: 0.004, release: 0.45 })
      }

      // 主旋律
      notesAt(HE_MELODY, barInPhrase, s).forEach((note) => {
        playNote(out, {
          time,
          midi: note[1] + shift,
          duration: note[2] * stepDur - 0.06,
          gain: 0.08,
          wave: 'triangle',
          detune: [-3, 3],
          attack: 0.03,
          release: 0.25,
          vibrato: 5,
        })
      })
    }

    return { stepDur, schedule, sustained: [] }
  }

  /** NE：低沉悲伤的弦乐——慢起的低音与和弦 + 带颤音的独奏线条，没有打击乐 */
  const buildNe = (out: GainNode, rng: Rng): SongParts => {
    const stepDur = 60 / 54 / 4
    const barDur = stepDur * STEPS
    let shift = 0

    const schedule = (step: number, time: number): void => {
      const s = step % STEPS
      const bar = Math.floor(step / STEPS)
      const barInPhrase = bar % 8
      const harmony = at(NE_CHORDS, barInPhrase)

      if (s === 0) {
        // 重复时独奏有一半机会降到大提琴音区
        if (barInPhrase === 0 && bar > 0) shift = rng.chance(0.5) ? -12 : 0
        playNote(out, {
          time,
          midi: harmony.bass,
          duration: barDur - 0.9,
          gain: 0.09,
          wave: 'sawtooth',
          detune: [-5, 5],
          attack: 0.8,
          release: 1.6,
          cutoff: 380,
        })
        harmony.tones.forEach((midi) => {
          playNote(out, {
            time,
            midi,
            duration: barDur - 1,
            gain: 0.026,
            wave: 'sawtooth',
            detune: [-7, 7],
            attack: 1,
            release: 1.8,
            cutoff: 950,
            resonance: 0.7,
          })
        })
      }

      notesAt(NE_MELODY, barInPhrase, s).forEach((note) => {
        // 偶尔省掉小节里靠后的经过音，让每轮略有不同
        if (note[0] > 0 && note[2] <= 2 && rng.chance(0.4)) return
        playNote(out, {
          time,
          midi: note[1] + shift,
          duration: note[2] * stepDur - 0.1,
          gain: 0.055,
          wave: 'sawtooth',
          attack: 0.22,
          release: 0.5,
          cutoff: 1500,
          vibrato: 9,
        })
      })
    }

    return { stepDur, schedule, sustained: [] }
  }

  const BUILDERS: Record<SongId, (out: GainNode, rng: Rng, track: MusicTrack) => SongParts> = {
    menu: buildMenu,
    combat: buildCombat,
    boss: buildBoss,
    bossLegacy: buildBossLegacy,
    he: buildHe,
    ne: buildNe,
  }

  return { reverb, reverbReturn, build: (id, out, rng, track) => BUILDERS[id](out, rng, track) }
}

/**
 * 创建音乐播放器。
 * @param ctx 已创建的 AudioContext
 * @param output 输出总线（music 总线）
 * @param impulse 混响用的冲激响应
 */
export function createMusic(ctx: AudioContext, output: AudioNode, impulse: AudioBuffer): MusicPlayer {
  const { reverb, reverbReturn, build } = createSongBank(ctx, output, impulse, true)

  const songs: Song[] = []
  let active: Song | null = null
  let current: MusicTrack = 'none'
  let timer: ReturnType<typeof setInterval> | null = null
  let plays = 0

  /* ── 调度 ── */

  const destroy = (song: Song): void => {
    song.parts.sustained.forEach((source) => {
      try {
        source.stop()
      } catch {
        // 已经停止
      }
    })
    song.out.disconnect()
    song.send.disconnect()
  }

  const tick = (): void => {
    const now = ctx.currentTime
    for (let i = songs.length - 1; i >= 0; i--) {
      const song = songs[i]
      if (!song) continue
      if (song.endAt > 0 && now >= song.endAt) {
        destroy(song)
        songs.splice(i, 1)
        continue
      }
      const stepDur = song.parts.stepDur
      // 定时器被节流（后台标签页）时跳过错过的步，不补发
      if (song.nextTime < now - 0.02) {
        const missed = Math.ceil((now + 0.02 - song.nextTime) / stepDur)
        song.step += missed
        song.nextTime += missed * stepDur
      }
      const horizon = song.endAt > 0 ? Math.min(now + LOOKAHEAD, song.endAt) : now + LOOKAHEAD
      while (song.nextTime < horizon) {
        try {
          song.parts.schedule(song.step, song.nextTime)
        } catch {
          // 单步出错不能卡住调度器
        }
        song.step++
        song.nextTime += stepDur
      }
    }
    if (songs.length === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const startSong = (id: SongId, track: MusicTrack): Song => {
    const out = ctx.createGain()
    out.gain.value = 0
    out.connect(output)
    const send = ctx.createGain()
    send.gain.value = REVERB_SEND[id]
    out.connect(send)
    send.connect(reverb)

    // 同一首每次重新开始换一个种子，变化不同但可复现
    const rng = createRng(hashSeed(`music:${id}`) + plays * 0x9e3779b1)
    plays++
    const parts = build(id, out, rng, track)
    const mode = parts.setMode ? parts.setMode(track) : 1
    const now = ctx.currentTime
    out.gain.setTargetAtTime(LEVEL[id] * mode, now, FADE_IN[id] / 3)

    const song: Song = { id, out, send, parts, step: 0, nextTime: now + 0.08, endAt: 0 }
    songs.push(song)
    if (timer === null) timer = setInterval(tick, TICK_MS)
    tick()
    return song
  }

  const setTrack = (track: MusicTrack): void => {
    if (track === current) return
    current = track
    const id = SONG_OF[track]
    const now = ctx.currentTime

    // 同一素材（battle ↔ intermission）：不重新开始，只切模式与音量
    if (active && id === active.id) {
      const mode = active.parts.setMode ? active.parts.setMode(track) : 1
      active.out.gain.setTargetAtTime(LEVEL[active.id] * mode, now, 0.5)
      return
    }

    // 交叉淡入淡出：旧曲继续演奏到淡出结束
    if (active) {
      active.out.gain.setTargetAtTime(0, now, FADE_OUT / 4)
      active.endAt = now + FADE_OUT
    }
    active = id ? startSong(id, track) : null
  }

  const dispose = (): void => {
    if (timer !== null) clearInterval(timer)
    timer = null
    songs.forEach(destroy)
    songs.length = 0
    active = null
    current = 'none'
    reverbReturn.disconnect()
  }

  return { setTrack, dispose }
}

/* ── 离线渲染（音乐鉴赏） ── */

/** 离线渲染时第一步的起始时刻（秒），给第一下的起音留一点余量 */
const RENDER_START = 0.05

export interface RenderSongOptions {
  /** 演奏时长（秒）：超过这个时刻的步不再排音符 */
  duration: number
  /** 曲尾时长（秒）：留给释音与混响，期间整体淡出 */
  tail: number
  /** 随机种子名：同名的渲染结果每次相同 */
  seed: string
  /** 同一素材的演奏模式（battle / intermission 等） */
  track: MusicTrack
  sampleRate?: number
}

/**
 * 把一首曲子离线渲染成定长的立体声 AudioBuffer：一次性排好全部音符，不需要用户手势，也方便拖动进度。
 * 输出与游戏内 music 总线（音量倍率之前）的电平一致。
 * @param id 曲目素材
 * @param options 时长、种子与模式
 * @param createImpulse 混响冲激响应的生成函数（与游戏内混响一致）
 */
export function renderSong(
  id: SongId,
  options: RenderSongOptions,
  createImpulse: (ctx: BaseAudioContext) => AudioBuffer,
): Promise<AudioBuffer> {
  const sampleRate = options.sampleRate ?? 44100
  const total = RENDER_START + options.duration + options.tail
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate)
  const bank = createSongBank(ctx, ctx.destination, createImpulse(ctx), false)

  const out = ctx.createGain()
  out.gain.value = 0
  out.connect(ctx.destination)
  const send = ctx.createGain()
  send.gain.value = REVERB_SEND[id]
  out.connect(send)
  send.connect(bank.reverb)

  const parts = bank.build(id, out, createRng(hashSeed(options.seed)), options.track)
  const mode = parts.setMode ? parts.setMode(options.track) : 1
  out.gain.setTargetAtTime(LEVEL[id] * mode, 0, FADE_IN[id] / 3)

  const end = RENDER_START + options.duration
  for (let step = 0; ; step++) {
    const time = RENDER_START + step * parts.stepDur
    if (time >= end - 1e-6) break
    parts.schedule(step, time)
  }
  out.gain.setTargetAtTime(0, end, options.tail / 5)
  parts.sustained.forEach((source) => source.stop(total))
  return ctx.startRendering()
}

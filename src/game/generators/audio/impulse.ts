/**
 * 共享混响的冲激响应。游戏内音频系统与音乐鉴赏的离线渲染共用，保证两边听到的空间感一致。
 */

import { createRng, hashSeed } from '../../utils/random'

/** 混响冲激响应：指数衰减的噪声（高频衰减更快）+ 两次早期反射，模拟空旷的球场 */
export function createImpulse(ctx: BaseAudioContext): AudioBuffer {
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

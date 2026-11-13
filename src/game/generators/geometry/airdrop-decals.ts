/**
 * 空投箱的喷印标识：用 Canvas 现画一张贴花图集（透明底），箱体上的贴花面片按区域取用。
 * 图集由所有空投箱共享，只生成一次，不随模型释放。
 */

import type { Texture } from 'three'
import { createRng } from '../../utils/random'
import type { Rng } from '../../utils/random'
import { createCanvasTexture, createDrawSurface } from './helicopter-airdrop-kit'

/** 图集边长（像素） */
const ATLAS = 1024

/** 图集里的一块区域（像素，原点在左上） */
export interface AtlasRect {
  x: number
  y: number
  w: number
  h: number
}

/** 各贴花在图集里的位置。宽高比与箱体上的面片一致 */
export const AIRDROP_DECALS = {
  /** 正面大标签：0.90m × 0.56m */
  label: { x: 0, y: 0, w: 1024, h: 637 },
  /** 侧面小标识：0.24m × 0.30m */
  side: { x: 0, y: 648, w: 300, h: 375 },
  /** 顶盖编号：0.40m × 0.40m */
  top: { x: 312, y: 648, w: 368, h: 368 },
  /** 两条磕碰污渍带：0.96m × 0.32m */
  wearA: { x: 692, y: 648, w: 332, h: 111 },
  wearB: { x: 692, y: 770, w: 332, h: 111 },
} as const satisfies Record<string, AtlasRect>

const STENCIL_WHITE = 'rgba(228, 224, 204, 0.94)'
const STENCIL_YELLOW = 'rgba(222, 174, 44, 0.95)'
const FONT_LATIN = '"Arial Black", "Impact", "Microsoft YaHei", "PingFang SC", sans-serif'

/**
 * 区域对应的 UV 矩形 [u0, v0, u1, v1]（v0 为区域下边缘）。
 * @param rect 图集区域
 */
export function atlasUv(rect: AtlasRect): [number, number, number, number] {
  return [rect.x / ATLAS, 1 - (rect.y + rect.h) / ATLAS, (rect.x + rect.w) / ATLAS, 1 - rect.y / ATLAS]
}

/** 模板字：写完后在字腰处擦掉一道横缝，模拟喷漆模板的连筋 */
function stencil(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  ctx.font = `900 ${size}px ${FONT_LATIN}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  const width = ctx.measureText(text).width
  const left = ctx.textAlign === 'center' ? x - width / 2 : x
  ctx.clearRect(left - 2, y - size * 0.4, width + 4, Math.max(2, size * 0.05))
}

/** 向上箭头（“此面向上”）：(x, top) 为箭头尖端 */
function upArrow(ctx: CanvasRenderingContext2D, x: number, top: number, height: number): void {
  const head = height * 0.42
  const halfHead = height * 0.2
  const halfShaft = height * 0.07
  ctx.beginPath()
  ctx.moveTo(x, top)
  ctx.lineTo(x + halfHead, top + head)
  ctx.lineTo(x + halfShaft, top + head)
  ctx.lineTo(x + halfShaft, top + height)
  ctx.lineTo(x - halfShaft, top + height)
  ctx.lineTo(x - halfShaft, top + head)
  ctx.lineTo(x - halfHead, top + head)
  ctx.closePath()
  ctx.fill()
  // 箭杆上的模板连筋
  ctx.clearRect(x - halfHead, top + head + height * 0.2, halfHead * 2, height * 0.035)
}

/** 重心标记：圆圈内对角两个象限涂实 */
function gravityMark(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.lineWidth = radius * 0.14
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.stroke()
  for (const start of [0, Math.PI]) {
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.arc(x, y, radius, start, start + Math.PI / 2)
    ctx.closePath()
    ctx.fill()
  }
  ctx.beginPath()
  ctx.moveTo(x - radius * 1.3, y)
  ctx.lineTo(x + radius * 1.3, y)
  ctx.moveTo(x, y - radius * 1.3)
  ctx.lineTo(x, y + radius * 1.3)
  ctx.lineWidth = radius * 0.07
  ctx.stroke()
}

/** 用随机小点与划痕擦掉一部分喷漆，做出脱落感 */
function erode(ctx: CanvasRenderingContext2D, rng: Rng, rect: AtlasRect, dots: number, scratches: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < dots; i++) {
    ctx.globalAlpha = rng.range(0.35, 1)
    const size = rng.range(1, 5)
    ctx.fillRect(rect.x + rng.range(0, rect.w), rect.y + rng.range(0, rect.h), size, size * rng.range(0.5, 1.5))
  }
  ctx.strokeStyle = '#000'
  for (let i = 0; i < scratches; i++) {
    ctx.globalAlpha = rng.range(0.4, 0.9)
    ctx.lineWidth = rng.range(1, 3.5)
    const x = rect.x + rng.range(0, rect.w)
    const y = rect.y + rng.range(0, rect.h)
    const angle = rng.range(-0.5, 0.5) + (rng.chance(0.5) ? 0 : Math.PI / 2)
    const length = rng.range(20, 120)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
    ctx.stroke()
  }
  ctx.restore()
}

/** 正面大标签 */
function drawLabel(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const r = AIRDROP_DECALS.label
  ctx.save()
  ctx.translate(r.x, r.y)

  // 顶部黄色识别带（分段，像用模板喷出来的）
  ctx.fillStyle = STENCIL_YELLOW
  ctx.fillRect(22, 20, r.w - 44, 34)
  for (let x = 140; x < r.w - 60; x += 122) ctx.clearRect(x, 18, 9, 38)

  ctx.fillStyle = STENCIL_WHITE
  ctx.strokeStyle = STENCIL_WHITE
  // 左侧：两个向上箭头 + 方框编号
  upArrow(ctx, 104, 92, 250)
  upArrow(ctx, 226, 92, 250)
  ctx.lineWidth = 9
  ctx.strokeRect(54, 384, 222, 150)
  ctx.clearRect(160, 376, 10, 16)
  ctx.clearRect(160, 526, 10, 16)
  stencil(ctx, '07', 92, 506, 128, STENCIL_WHITE)

  // 中部：单位、品名、编号、重量
  stencil(ctx, 'CIS2', 326, 216, 168, STENCIL_WHITE)
  stencil(ctx, '空投补给', 328, 344, 108, STENCIL_WHITE)
  stencil(ctx, 'AIRDROP SUPPLY', 330, 418, 56, STENCIL_WHITE)
  stencil(ctx, 'NO.2026-1112-07', 330, 488, 46, STENCIL_YELLOW)
  stencil(ctx, 'GW 120KG   CUBE 1.3', 330, 546, 38, STENCIL_WHITE)
  stencil(ctx, '此面向上  THIS SIDE UP  严禁倒置', 330, 602, 30, STENCIL_WHITE)

  // 右侧：重心标记
  ctx.fillStyle = STENCIL_WHITE
  ctx.strokeStyle = STENCIL_WHITE
  gravityMark(ctx, 916, 190, 58)
  stencil(ctx, 'CG', 876, 326, 56, STENCIL_WHITE)
  ctx.restore()

  erode(ctx, rng, r, 900, 26)
}

/** 侧面小标识（把手下方） */
function drawSide(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const r = AIRDROP_DECALS.side
  ctx.save()
  ctx.translate(r.x, r.y)
  ctx.fillStyle = STENCIL_WHITE
  ctx.strokeStyle = STENCIL_WHITE
  gravityMark(ctx, 150, 96, 56)
  stencil(ctx, 'CIS2', 34, 262, 92, STENCIL_WHITE)
  stencil(ctx, '120 KG', 38, 326, 54, STENCIL_YELLOW)
  ctx.fillStyle = STENCIL_YELLOW
  ctx.fillRect(30, 344, 240, 14)
  ctx.clearRect(146, 342, 8, 18)
  ctx.restore()
  erode(ctx, rng, r, 260, 8)
}

/** 顶盖编号：圆圈 + 数字，从空中也能认出来 */
function drawTop(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const r = AIRDROP_DECALS.top
  const c = r.w / 2
  ctx.save()
  ctx.translate(r.x, r.y)
  ctx.strokeStyle = STENCIL_WHITE
  ctx.lineWidth = 20
  ctx.beginPath()
  ctx.arc(c, c, c - 16, 0, Math.PI * 2)
  ctx.stroke()
  // 圆圈上的四处连筋
  ctx.clearRect(c - 7, 0, 14, 40)
  ctx.clearRect(c - 7, r.h - 40, 14, 40)
  ctx.clearRect(0, c - 7, 40, 14)
  ctx.clearRect(r.w - 40, c - 7, 40, 14)
  ctx.textAlign = 'center'
  stencil(ctx, '07', c, c + 68, 196, STENCIL_WHITE)
  ctx.textAlign = 'left'
  ctx.restore()
  erode(ctx, rng, r, 300, 10)
}

/** 磕碰污渍带：底部泥污 + 飞溅点 + 露出底漆 / 铁皮的划痕 */
function drawWear(ctx: CanvasRenderingContext2D, rng: Rng, r: AtlasRect): void {
  ctx.save()
  ctx.beginPath()
  ctx.rect(r.x, r.y, r.w, r.h)
  ctx.clip()

  const dirt = ctx.createLinearGradient(0, r.y + r.h, 0, r.y)
  dirt.addColorStop(0, 'rgba(58, 44, 28, 0.62)')
  dirt.addColorStop(0.35, 'rgba(58, 44, 28, 0.22)')
  dirt.addColorStop(1, 'rgba(58, 44, 28, 0)')
  ctx.fillStyle = dirt
  ctx.fillRect(r.x, r.y, r.w, r.h)

  // 飞溅的泥点，越靠下越密
  for (let i = 0; i < 160; i++) {
    const t = rng.next()
    const radius = rng.range(0.8, 3.2)
    ctx.fillStyle = `rgba(46, 36, 24, ${rng.range(0.25, 0.7).toFixed(2)})`
    ctx.beginPath()
    ctx.arc(r.x + rng.range(0, r.w), r.y + r.h * (1 - t * t), radius, 0, Math.PI * 2)
    ctx.fill()
  }
  // 划痕：深色底边 + 浅色露铁
  for (let i = 0; i < 22; i++) {
    const x = r.x + rng.range(0, r.w)
    const y = r.y + rng.range(r.h * 0.1, r.h)
    const angle = rng.range(-0.35, 0.35)
    const length = rng.range(10, 60)
    const dx = Math.cos(angle) * length
    const dy = Math.sin(angle) * length
    ctx.lineWidth = rng.range(1.2, 2.6)
    ctx.strokeStyle = 'rgba(20, 22, 14, 0.5)'
    ctx.beginPath()
    ctx.moveTo(x, y + 1)
    ctx.lineTo(x + dx, y + dy + 1)
    ctx.stroke()
    ctx.lineWidth *= 0.6
    ctx.strokeStyle = `rgba(196, 196, 184, ${rng.range(0.35, 0.75).toFixed(2)})`
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + dx, y + dy)
    ctx.stroke()
  }
  ctx.restore()
}

let texture: Texture | null = null

/**
 * 取得空投箱贴花图集（首次调用时现画）。共享实例，调用方不要释放。
 */
export function getAirdropDecalTexture(): Texture {
  if (!texture) {
    const { canvas, ctx } = createDrawSurface(ATLAS, ATLAS)
    const rng = createRng(0x41d20)
    ctx.clearRect(0, 0, ATLAS, ATLAS)
    drawLabel(ctx, rng)
    drawSide(ctx, rng)
    drawTop(ctx, rng)
    drawWear(ctx, rng, AIRDROP_DECALS.wearA)
    drawWear(ctx, rng, AIRDROP_DECALS.wearB)
    texture = createCanvasTexture(canvas)
  }
  return texture
}

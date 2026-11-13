/**
 * 直升机的 Canvas 现画贴图：
 * - 蒙皮细节图集：接缝、铆钉排、口盖、窗框胶条、机身编号与警示标识、防眩漆、废气熏黑与污渍。
 *   横向对应机身纵向（尾尖 → 机头），纵向对应截面周长（画布底边是机腹中线，往上依次是 +X 侧、
 *   机背中线、-X 侧，顶边回到机腹中线）。舱门洞口对应的那块区域留给门板自己的贴花层。
 * - 桨盘残影：高速旋转时代替桨叶的半透明圆盘。
 * - 航行灯发光色块。
 * 贴图由所有实例共享，只生成一次，不随模型释放。
 */

import type { Texture } from 'three'
import { createRng } from '../../utils/random'
import type { Rng } from '../../utils/random'
import { createCanvasTexture, createDrawSurface } from './helicopter-airdrop-kit'
import { DOOR_PANEL, OPENINGS, THETA, atlasU, atlasV, hullBottom, hullPerimeter, hullTop, thetaAtHeight } from './helicopter-hull'
import { ATLAS, CABIN_Z, DOOR_Z1, Z_NOSE, Z_TAIL } from './helicopter-layout'

const W = ATLAS.width
const H = ATLAS.height
const HALF_PI = Math.PI / 2

const FONT = '"Arial Black", "Impact", "Microsoft YaHei", "PingFang SC", sans-serif'
const MARK_LIGHT = 'rgba(216, 212, 196, 0.92)'
const MARK_YELLOW = 'rgba(222, 172, 40, 0.94)'
const MARK_RED = 'rgba(190, 44, 34, 0.94)'
const SEAM_DARK = 'rgba(8, 10, 6, 0.62)'
const SEAM_LIGHT = 'rgba(255, 255, 255, 0.09)'
const GASKET = 'rgba(10, 11, 12, 0.95)'

type Ctx = CanvasRenderingContext2D
type Point = readonly [number, number]

/** 纵向位置 z 对应的画布 x */
const px = (z: number): number => atlasU(z) * W
/** (z, 截面参数) 对应的画布 y */
const py = (z: number, theta: number): number => (1 - atlasV(z, theta)) * H
/** 某一侧（+1 为 +X 侧）高度 y 处的截面参数 */
const sideTheta = (z: number, side: number, y: number): number => (side > 0 ? thetaAtHeight(z, y) : Math.PI - thetaAtHeight(z, y))
/** 把 +X 侧的截面参数换到指定一侧 */
const onSide = (side: number, theta: number): number => (side > 0 ? theta : Math.PI - theta)

/** 沿 z 方向、截面参数不变的一条线在画布上的折线 */
function alongZ(theta: number, z0: number, z1: number): Point[] {
  const steps = Math.max(1, Math.ceil(Math.abs(z1 - z0) / 0.12))
  const points: Point[] = []
  for (let k = 0; k <= steps; k++) {
    const z = z0 + ((z1 - z0) * k) / steps
    points.push([px(z), py(z, theta)])
  }
  return points
}

/** 某一站位上沿截面的一段在画布上是一条竖直线段 */
function alongSection(z: number, t0: number, t1: number): Point[] {
  return [
    [px(z), py(z, t0)],
    [px(z), py(z, t1)],
  ]
}

function strokePath(ctx: Ctx, points: readonly Point[], dx = 0, dy = 0): void {
  ctx.beginPath()
  ctx.moveTo(points[0][0] + dx, points[0][1] + dy)
  for (let k = 1; k < points.length; k++) ctx.lineTo(points[k][0] + dx, points[k][1] + dy)
  ctx.stroke()
}

/** 沿折线每隔 step 像素取一个点，并向两侧各偏 offset 像素，追加到 out（铆钉位置） */
function collectRivets(points: readonly Point[], step: number, offset: number, out: number[]): void {
  let carry = step / 2
  for (let k = 1; k < points.length; k++) {
    const ax = points[k - 1][0]
    const ay = points[k - 1][1]
    const dx = points[k][0] - ax
    const dy = points[k][1] - ay
    const length = Math.hypot(dx, dy)
    if (length < 1e-6) continue
    const ux = dx / length
    const uy = dy / length
    let d = carry
    while (d < length) {
      const x = ax + ux * d
      const y = ay + uy * d
      out.push(x - uy * offset, y + ux * offset, x + uy * offset, y - ux * offset)
      d += step
    }
    carry = d - length
  }
}

/** 画一批铆钉：深色钉头 + 左上角一点高光 */
function drawRivets(ctx: Ctx, rivets: readonly number[]): void {
  ctx.fillStyle = 'rgba(14, 16, 10, 0.55)'
  for (let k = 0; k < rivets.length; k += 2) ctx.fillRect(rivets[k] - 1.6, rivets[k + 1] - 1.6, 3.2, 3.2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'
  for (let k = 0; k < rivets.length; k += 2) ctx.fillRect(rivets[k] - 1.6, rivets[k + 1] - 1.6, 1.4, 1.4)
}

/** 一道蒙皮接缝：深色缝 + 一侧的细高光，两侧各一排铆钉 */
function seam(ctx: Ctx, points: readonly Point[], rivets: number[]): void {
  ctx.lineWidth = 2
  ctx.strokeStyle = SEAM_DARK
  strokePath(ctx, points)
  ctx.lineWidth = 1
  ctx.strokeStyle = SEAM_LIGHT
  strokePath(ctx, points, 1.5, 1.5)
  collectRivets(points, 13, 6, rivets)
}

/**
 * 在机身侧面的 (z, y) 处建立一个局部画布坐标系再作画：单位厘米，x 朝观察者的右手方向，y 朝下。
 * +X 侧的观察者右手边是机尾，-X 侧的观察者右手边是机头，所以两侧的镜像方式不同。
 */
function stamp(ctx: Ctx, z: number, side: number, y: number, draw: (aft: number) => void): void {
  const theta = sideTheta(z, side, y)
  const sx = W / (Z_NOSE - Z_TAIL) / 100
  const sy = H / hullPerimeter(z) / 100
  ctx.save()
  ctx.translate(px(z), py(z, theta))
  ctx.scale(side > 0 ? -sx : sx, side > 0 ? sy : -sy)
  // aft：局部 x 轴上指向机尾的方向（+1 或 -1）
  draw(side > 0 ? 1 : -1)
  ctx.restore()
}

/** 居中写一行字（局部坐标，厘米） */
function label(ctx: Ctx, text: string, x: number, baseline: number, size: number, color: string): void {
  ctx.font = `900 ${size}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = color
  ctx.fillText(text, x, baseline)
}

/** 实心三角箭头：尖端在 (x, y)，dir 为 +1 / -1（局部 x 方向） */
function arrowHead(ctx: Ctx, x: number, y: number, size: number, dir: number, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - dir * size, y - size * 0.6)
  ctx.lineTo(x - dir * size, y + size * 0.6)
  ctx.closePath()
  ctx.fill()
}

/** 蒙皮上一块“矩形”（z 范围 × 截面参数范围）的轮廓折线，首尾相接 */
function outline(z0: number, z1: number, t0: number, t1: number): Point[] {
  const low = alongZ(t0, z0, z1)
  const high = alongZ(t1, z1, z0)
  return [...low, ...high, low[0]]
}

/** 口盖：轮廓缝 + 四周的快卸螺钉 */
function hatch(ctx: Ctx, z0: number, z1: number, t0: number, t1: number, rivets: number[]): void {
  const points = outline(z0, z1, t0, t1)
  ctx.lineWidth = 2
  ctx.strokeStyle = SEAM_DARK
  strokePath(ctx, points)
  ctx.lineWidth = 1
  ctx.strokeStyle = SEAM_LIGHT
  strokePath(ctx, points, 1.5, 1.5)
  const inner: number[] = []
  collectRivets(points, 34, 7, inner)
  // 只保留轮廓内侧的那一排
  for (let k = 0; k < inner.length; k += 4) rivets.push(inner[k], inner[k + 1])
}

/** 柔和的深浅斑块，打破大面积单色漆面的均匀感 */
function mottle(ctx: Ctx, rng: Rng, x0: number, y0: number, w: number, h: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = x0 + rng.range(0, w)
    const y = y0 + rng.range(0, h)
    const radius = rng.range(50, 240)
    const dark = rng.chance(0.6)
    const alpha = rng.range(0.04, 0.1)
    const tone = dark ? '18, 20, 12' : '214, 210, 180'
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
    g.addColorStop(0, `rgba(${tone}, ${alpha.toFixed(3)})`)
    g.addColorStop(1, `rgba(${tone}, 0)`)
    ctx.fillStyle = g
    ctx.fillRect(Math.max(x0, x - radius), Math.max(y0, y - radius), Math.min(w, radius * 2), Math.min(h, radius * 2))
  }
}

/** 机身主体的接缝、铆钉与口盖 */
function drawStructure(ctx: Ctx): void {
  const rivets: number[] = []

  // 环向接缝（隔框位置）：整圈
  for (const z of [-8.3, -7.45, -6.55, -5.65, -4.95, -4.25, -3.55, -2.85, -2.08, -1.0, 1.38, 1.68, 2.68, 3.82, 4.22]) {
    seam(ctx, alongSection(z, -HALF_PI, HALF_PI * 3), rivets)
  }
  // 纵向接缝（桁条位置）：左右对称
  for (const side of [1, -1]) {
    seam(ctx, alongZ(onSide(side, THETA.floor - 0.12), -2.08, 3.82), rivets)
    seam(ctx, alongZ(onSide(side, THETA.roofLow), -2.85, 1.68), rivets)
    seam(ctx, alongZ(onSide(side, 1.32), -4.25, -2.08), rivets)
    seam(ctx, alongZ(onSide(side, -0.95), -5.65, -2.08), rivets)
    seam(ctx, alongZ(onSide(side, -0.2), -8.3, -5.65), rivets)
    seam(ctx, alongZ(onSide(side, 0.55), 3.82, 4.4), rivets)
    seam(ctx, alongZ(onSide(side, -1.05), 1.38, 3.45), rivets)
    // 口盖：后机身设备舱、机鼻电子舱
    hatch(ctx, -3.35, -2.55, onSide(side, -0.22), onSide(side, 0.24), rivets)
    hatch(ctx, 3.92, 4.3, onSide(side, -0.55), onSide(side, 0.4), rivets)
  }
  seam(ctx, alongZ(HALF_PI, -8.3, -4.25), rivets)
  drawRivets(ctx, rivets)
}

/** 窗框胶条、机鼻防眩漆、机背防滑走道 */
function drawTrim(ctx: Ctx): void {
  // 机鼻顶部的哑光黑防眩漆：风挡前方，左右对称的一片
  ctx.fillStyle = 'rgba(16, 18, 17, 0.93)'
  ctx.beginPath()
  const front = alongZ(0.62, 3.78, 4.47)
  const back = alongZ(Math.PI - 0.62, 4.47, 3.78)
  ctx.moveTo(front[0][0], front[0][1])
  for (const p of front) ctx.lineTo(p[0], p[1])
  for (const p of back) ctx.lineTo(p[0], p[1])
  ctx.closePath()
  ctx.fill()

  // 机背两侧的防滑走道
  ctx.fillStyle = 'rgba(22, 24, 22, 0.8)'
  for (const side of [1, -1]) {
    const inner = alongZ(onSide(side, 1.05), -1.7, 1.45)
    const outer = alongZ(onSide(side, 1.27), 1.45, -1.7)
    ctx.beginPath()
    ctx.moveTo(inner[0][0], inner[0][1])
    for (const p of inner) ctx.lineTo(p[0], p[1])
    for (const p of outer) ctx.lineTo(p[0], p[1])
    ctx.closePath()
    ctx.fill()
  }

  // 各窗洞四周的黑色胶条
  ctx.strokeStyle = GASKET
  ctx.lineWidth = 9
  ctx.lineJoin = 'round'
  for (const o of OPENINGS) {
    if (o.kind === 'door') continue
    strokePath(ctx, outline(o.z0, o.z1, o.t0, o.t1))
  }
}

/** 机身编号与警示标识 */
function drawMarkings(ctx: Ctx): void {
  // 尾梁末段的黄色警示环
  ctx.fillStyle = MARK_YELLOW
  ctx.fillRect(px(-8.5), 0, px(-8.34) - px(-8.5), H)

  for (const side of [1, -1]) {
    // 尾梁：机身编号
    const boomZ = -5.92
    stamp(ctx, boomZ, side, (hullTop(boomZ) + hullBottom(boomZ)) / 2, () => {
      label(ctx, 'CIS2-07', 0, 7, 20, MARK_LIGHT)
    })
    // 尾桨附近：危险警示 + 指向机尾的箭头
    const warnZ = -7.82
    stamp(ctx, warnZ, side, (hullTop(warnZ) + hullBottom(warnZ)) / 2 - 0.02, (aft) => {
      label(ctx, '危险 DANGER', -aft * 5, 3, 8, MARK_RED)
      arrowHead(ctx, aft * 31, 0, 7, aft, MARK_RED)
    })
    // 客舱后方：救援标识
    stamp(ctx, -1.5, side, 0.22, () => {
      label(ctx, '救援', 0, -6, 24, MARK_LIGHT)
      label(ctx, 'RESCUE', 0, 17, 20, MARK_LIGHT)
    })
    // 驾驶舱门：大号机号 + 单位名
    stamp(ctx, 2.17, side, -0.46, () => {
      label(ctx, '07', 0, 12, 34, MARK_LIGHT)
    })
    stamp(ctx, 2.17, side, -0.12, () => {
      label(ctx, 'CIS2 航空救援队', 0, 2, 6.5, MARK_LIGHT)
    })
    // 舱门前方的踏步提示
    stamp(ctx, 1.52, side, -0.92, () => {
      ctx.fillStyle = MARK_YELLOW
      ctx.fillRect(-9, -5, 18, 10)
      ctx.clearRect(-7.6, -3.6, 15.2, 7.2)
      label(ctx, '踏 STEP', 0, 2, 4.6, MARK_YELLOW)
    })
  }

  // -X 侧：加油口
  stamp(ctx, -1.52, -1, -0.38, () => {
    ctx.fillStyle = 'rgba(24, 26, 24, 0.9)'
    ctx.beginPath()
    ctx.arc(0, 0, 6.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = MARK_RED
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(0, 0, 8.6, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(150, 154, 150, 0.8)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(-4, 0)
    ctx.lineTo(4, 0)
    ctx.stroke()
    label(ctx, 'JP-8 燃油', 0, 17, 4.6, MARK_RED)
  })
}

/** 废气熏黑、机腹污垢、沿蒙皮下淌的污痕 */
function drawWeathering(ctx: Ctx, rng: Rng): void {
  mottle(ctx, rng, 0, 0, W, H, 90)

  // 排气管后方、尾梁背部的熏黑：越靠近机背中线越浓，向机尾渐淡
  const sootX0 = px(-6.6)
  const sootX1 = px(-3.3)
  for (let band = 0; band < 8; band++) {
    const half = (0.03 + band * 0.026) * H
    const g = ctx.createLinearGradient(sootX0, 0, sootX1, 0)
    g.addColorStop(0, 'rgba(12, 11, 10, 0)')
    g.addColorStop(0.75, 'rgba(12, 11, 10, 0.075)')
    g.addColorStop(1, 'rgba(12, 11, 10, 0.02)')
    ctx.fillStyle = g
    ctx.fillRect(sootX0, H / 2 - half, sootX1 - sootX0, half * 2)
  }

  // 机腹污垢：画布的上下两条边都是机腹中线
  const grimeHeight = H * 0.13
  const bottom = ctx.createLinearGradient(0, H, 0, H - grimeHeight)
  bottom.addColorStop(0, 'rgba(30, 25, 17, 0.5)')
  bottom.addColorStop(1, 'rgba(30, 25, 17, 0)')
  ctx.fillStyle = bottom
  ctx.fillRect(0, H - grimeHeight, W, grimeHeight)
  const top = ctx.createLinearGradient(0, 0, 0, grimeHeight)
  top.addColorStop(0, 'rgba(30, 25, 17, 0.5)')
  top.addColorStop(1, 'rgba(30, 25, 17, 0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, W, grimeHeight)

  // 下淌的污痕：从机背（画布中线）流向机腹（上下两边）
  for (let i = 0; i < 320; i++) {
    const x = rng.range(0, W)
    const y = rng.range(H * 0.08, H * 0.92)
    const length = rng.range(30, 190) * (y < H / 2 ? -1 : 1)
    const width = rng.range(1, 3.5)
    const tone = rng.chance(0.75) ? '16, 15, 10' : '200, 196, 170'
    const g = ctx.createLinearGradient(0, y, 0, y + length)
    g.addColorStop(0, `rgba(${tone}, ${rng.range(0.1, 0.26).toFixed(3)})`)
    g.addColorStop(1, `rgba(${tone}, 0)`)
    ctx.fillStyle = g
    ctx.fillRect(x, Math.min(y, y + length), width, Math.abs(length))
  }
}

/** 舱门自己的贴花：占用图集中舱门洞口对应的区域 */
function drawDoor(ctx: Ctx, rng: Rng): void {
  const x0 = px(DOOR_PANEL.z0)
  const x1 = px(DOOR_PANEL.z1)
  const yTop = py(CABIN_Z, DOOR_PANEL.t1)
  const yBottom = py(CABIN_Z, DOOR_PANEL.t0)
  ctx.clearRect(x0 - 1, yTop - 1, x1 - x0 + 2, yBottom - yTop + 2)

  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, yTop, x1 - x0, yBottom - yTop)
  ctx.clip()
  mottle(ctx, rng, x0, yTop, x1 - x0, yBottom - yTop, 10)

  const rivets: number[] = []
  // 门板四周的包边缝
  const inset = 7
  const border: Point[] = [
    [x0 + inset, yTop + inset],
    [x1 - inset, yTop + inset],
    [x1 - inset, yBottom - inset],
    [x0 + inset, yBottom - inset],
    [x0 + inset, yTop + inset],
  ]
  seam(ctx, border, rivets)
  // 窗下的横向加强筋与两道竖缝
  seam(ctx, alongZ(thetaAtHeight(CABIN_Z, -0.595), DOOR_PANEL.z0, DOOR_PANEL.z1), rivets)
  for (const z of [DOOR_PANEL.windowZ0 - 0.12, DOOR_PANEL.windowZ1 + 0.12]) {
    seam(ctx, alongSection(z, DOOR_PANEL.t0, DOOR_PANEL.t1), rivets)
  }
  drawRivets(ctx, rivets)

  // 窗框胶条
  ctx.strokeStyle = GASKET
  ctx.lineWidth = 9
  ctx.lineJoin = 'round'
  strokePath(ctx, outline(DOOR_PANEL.windowZ0, DOOR_PANEL.windowZ1, THETA.windowLow, THETA.windowTop))

  // 窗下：救援标识 + 开门方向（舱门向机尾滑开）
  stamp(ctx, CABIN_Z, 1, -0.5, () => {
    label(ctx, '救援 RESCUE', 0, 4, 12, MARK_YELLOW)
  })
  stamp(ctx, CABIN_Z, 1, -0.67, (aft) => {
    label(ctx, '向后滑开 SLIDE AFT TO OPEN', -aft * 4, 2, 5, MARK_LIGHT)
    arrowHead(ctx, aft * 52, 0, 5, aft, MARK_LIGHT)
  })
  // 把手周围的黄色警示框
  stamp(ctx, DOOR_Z1 - 0.13, 1, -0.36, () => {
    ctx.strokeStyle = MARK_YELLOW
    ctx.lineWidth = 1.6
    ctx.setLineDash([4, 2.4])
    ctx.strokeRect(-8.5, -14, 17, 28)
    ctx.setLineDash([])
  })

  // 门板下沿被鞋蹭出来的划痕
  for (let i = 0; i < 40; i++) {
    const x = rng.range(x0 + 20, x1 - 20)
    const y = rng.range(yBottom - 70, yBottom - 12)
    ctx.strokeStyle = `rgba(196, 194, 178, ${rng.range(0.2, 0.55).toFixed(2)})`
    ctx.lineWidth = rng.range(0.8, 2)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + rng.range(-26, 26), y + rng.range(-6, 6))
    ctx.stroke()
  }
  ctx.restore()
}

let overlayTexture: Texture | null = null

/**
 * 取得蒙皮细节贴花图集（首次调用时现画）。共享实例，调用方不要释放。
 */
export function getHullOverlayTexture(): Texture {
  if (!overlayTexture) {
    const { canvas, ctx } = createDrawSurface(W, H)
    const rng = createRng(0x48e11)
    ctx.clearRect(0, 0, W, H)
    drawWeathering(ctx, rng)
    drawTrim(ctx)
    drawStructure(ctx)
    drawMarkings(ctx)
    drawDoor(ctx, rng)
    overlayTexture = createCanvasTexture(canvas)
  }
  return overlayTexture
}

let blurTexture: Texture | null = null

/**
 * 取得桨盘残影贴图：淡淡的整盘薄雾 + 四片被拉宽的桨叶残影 + 桨尖黄色光环。共享实例，调用方不要释放。
 */
export function getRotorBlurTexture(): Texture {
  if (!blurTexture) {
    const size = 512
    const { canvas, ctx } = createDrawSurface(size, size)
    const c = size / 2
    const radius = c - 4
    ctx.clearRect(0, 0, size, size)

    // 整盘薄雾：靠近桨毂与桨尖处较淡
    const haze = ctx.createRadialGradient(c, c, 0, c, c, radius)
    haze.addColorStop(0, 'rgba(20, 21, 23, 0)')
    haze.addColorStop(0.1, 'rgba(20, 21, 23, 0.02)')
    haze.addColorStop(0.22, 'rgba(20, 21, 23, 0.13)')
    haze.addColorStop(0.9, 'rgba(20, 21, 23, 0.17)')
    haze.addColorStop(1, 'rgba(20, 21, 23, 0.03)')
    ctx.fillStyle = haze
    ctx.beginPath()
    ctx.arc(c, c, radius, 0, Math.PI * 2)
    ctx.fill()

    // 桨叶残影：每片桨叶由若干片很淡的扇形叠成，中间浓、两侧淡
    ctx.fillStyle = 'rgba(16, 17, 19, 0.035)'
    for (let blade = 0; blade < 4; blade++) {
      const center = (blade / 4) * Math.PI * 2
      for (let k = 1; k <= 9; k++) {
        const half = 0.045 * k
        ctx.beginPath()
        ctx.moveTo(c, c)
        ctx.arc(c, c, radius, center - half, center + half)
        ctx.closePath()
        ctx.fill()
      }
    }

    // 桨尖的黄色光环
    ctx.strokeStyle = 'rgba(216, 165, 32, 0.34)'
    ctx.lineWidth = radius * 0.045
    ctx.beginPath()
    ctx.arc(c, c, radius * 0.975, 0, Math.PI * 2)
    ctx.stroke()
    blurTexture = createCanvasTexture(canvas)
  }
  return blurTexture
}

let lightTexture: Texture | null = null

/**
 * 取得航行灯发光贴图：横向四个色块（红 / 绿 / 白 / 琥珀），灯罩网格用固定 UV 取色。共享实例，调用方不要释放。
 */
export function getLightAtlasTexture(): Texture {
  if (!lightTexture) {
    const { canvas, ctx } = createDrawSurface(64, 16)
    const colors = ['#ff2a1c', '#1cff5e', '#fff4dc', '#ffae30']
    for (let k = 0; k < colors.length; k++) {
      ctx.fillStyle = colors[k]
      ctx.fillRect(k * 16, 0, 16, 16)
    }
    lightTexture = createCanvasTexture(canvas)
  }
  return lightTexture
}

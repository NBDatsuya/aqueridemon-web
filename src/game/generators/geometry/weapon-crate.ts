/**
 * 开局主武器箱模型：长条形的聚合物枪械硬箱，与空投补给箱（立方军用箱 + 降落伞）明显区分。
 * 深炭灰箱体 + 亮橙锁扣与端盖 + 顶盖上的步枪剪影与“PRIMARY 主武器”喷印，摆在地上就能认出来。
 * 箱子是静态的：update 为空，开箱后整个移除。
 */

import { DoubleSide, Group, Mesh, MeshStandardMaterial } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { AirdropAnimInput, AirdropRig, CrateModelOptions } from '../../core/types'
import { createRng } from '../../utils/random'
import { createSurfaceMaterial } from '../textures/pbr'
import {
  MeshBuilder,
  createCanvasTexture,
  createDrawSurface,
  enableShadows,
} from './helicopter-airdrop-kit'
import { createParachute } from './parachute'
import type { ParachuteRig } from './parachute'

/* ── 尺寸（米） ── */

/** 箱长（x） */
const LENGTH = 1.35
/** 箱宽（z） */
const WIDTH = 0.44
/** 箱高（y） */
const HEIGHT = 0.34
/** 箱身与箱盖之间的接缝高度 */
const SEAM_Y = 0.2
/** 顶盖喷印面片的半长 / 半宽 */
const DECAL_HALF_X = 0.42
const DECAL_HALF_Z = 0.14

/* ── 配色 ── */

const TINT = {
  body: 0x33383d,
  lid: 0x3d4348,
  rib: 0x2a2f33,
  seam: 0x212529,
  corner: 0x26292d,
  rubber: 0x17181a,
  accent: 0xd96a1f,
} as const

/** 顶盖喷印画布尺寸（像素），宽高比与面片一致 */
const DECAL_W = 1024
const DECAL_H = 342

const STENCIL_WHITE = 'rgba(232, 229, 214, 0.95)'
const STENCIL_ORANGE = 'rgba(232, 122, 34, 0.96)'
const FONT_LATIN = '"Arial Black", "Impact", "Microsoft YaHei", "PingFang SC", sans-serif'

/** 模板字：写完后在字腰擦一道横缝，模拟喷漆模板的连筋 */
function stencil(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  ctx.font = `900 ${size}px ${FONT_LATIN}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  const width = ctx.measureText(text).width
  const left = ctx.textAlign === 'center' ? x - width / 2 : x
  ctx.clearRect(left - 2, y - size * 0.4, width + 4, Math.max(2, size * 0.05))
}

/** 步枪剪影：枪托、机匣、握把、弹匣、护木、枪管与准星拼成的实心侧影 */
function rifleSilhouette(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(0.88, 0.88)
  // 枪托
  ctx.beginPath()
  ctx.moveTo(0, 26)
  ctx.lineTo(26, 12)
  ctx.lineTo(58, 16)
  ctx.lineTo(58, 48)
  ctx.lineTo(0, 48)
  ctx.closePath()
  ctx.fill()
  // 机匣
  ctx.fillRect(54, 12, 150, 32)
  // 照门
  ctx.fillRect(126, 2, 46, 12)
  // 握把
  ctx.save()
  ctx.translate(76, 44)
  ctx.rotate(0.35)
  ctx.fillRect(0, 0, 17, 36)
  ctx.restore()
  // 弹匣
  ctx.save()
  ctx.translate(126, 42)
  ctx.rotate(0.22)
  ctx.fillRect(0, 0, 27, 48)
  ctx.restore()
  // 护木、枪管、枪口与准星
  ctx.fillRect(202, 18, 92, 20)
  ctx.fillRect(292, 23, 92, 10)
  ctx.fillRect(380, 18, 16, 19)
  ctx.fillRect(356, 8, 9, 15)
  ctx.restore()
}

/** 顶盖喷印：步枪剪影 + PRIMARY / 主武器 字样，透明底 */
function drawDecal(): HTMLCanvasElement {
  const { canvas, ctx } = createDrawSurface(DECAL_W, DECAL_H)
  const rng = createRng(0x51a7e)
  ctx.clearRect(0, 0, DECAL_W, DECAL_H)

  // 左侧步枪剪影
  ctx.fillStyle = STENCIL_WHITE
  rifleSilhouette(ctx, 26, 74)

  // 右侧文字与橙色识别带
  stencil(ctx, 'PRIMARY', 420, 156, 96, STENCIL_WHITE)
  stencil(ctx, '主武器', 424, 248, 72, STENCIL_ORANGE)
  ctx.fillStyle = STENCIL_ORANGE
  ctx.fillRect(420, 266, 540, 16)
  for (let x = 520; x < 950; x += 110) ctx.clearRect(x, 264, 9, 20)

  // 掉漆与划痕
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 500; i++) {
    ctx.globalAlpha = rng.range(0.3, 1)
    const size = rng.range(1, 4)
    ctx.fillRect(rng.range(0, DECAL_W), rng.range(0, DECAL_H), size, size * rng.range(0.5, 1.5))
  }
  ctx.strokeStyle = '#000'
  for (let i = 0; i < 14; i++) {
    ctx.globalAlpha = rng.range(0.4, 0.9)
    ctx.lineWidth = rng.range(1, 3)
    const x = rng.range(0, DECAL_W)
    const y = rng.range(0, DECAL_H)
    const angle = rng.range(-0.4, 0.4)
    const length = rng.range(16, 90)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length)
    ctx.stroke()
  }
  ctx.restore()
  return canvas
}

let decalTexture: ReturnType<typeof createCanvasTexture> | null = null

/** 取得顶盖喷印贴图（首次调用时现画）。共享实例，调用方不要释放 */
function getDecalTexture(): ReturnType<typeof createCanvasTexture> {
  if (!decalTexture) decalTexture = createCanvasTexture(drawDecal())
  return decalTexture
}

/** 共享几何体：所有主武器箱实例复用同一批 BufferGeometry */
interface CrateGeometries {
  body: BufferGeometry
  accent: BufferGeometry
  steel: BufferGeometry
}

let shared: CrateGeometries | null = null

function geometries(): CrateGeometries {
  if (shared) return shared

  const halfX = LENGTH / 2
  const halfZ = WIDTH / 2

  /* ── 箱体（聚合物） ── */

  const body = new MeshBuilder()
  body.uvScale = 2.4
  // 箱身与四个橡胶脚
  body.tint(TINT.body)
  body.box(LENGTH, SEAM_Y - 0.04, WIDTH, 0, (SEAM_Y - 0.04) / 2 + 0.04, 0)
  body.tint(TINT.rubber)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) body.box(0.16, 0.05, 0.1, sx * (halfX - 0.14), 0.025, sz * (halfZ - 0.1))
  }
  // 接缝唇边：比箱身略宽一圈，压住箱盖下沿
  body.tint(TINT.seam)
  body.box(LENGTH + 0.02, 0.03, WIDTH + 0.02, 0, SEAM_Y + 0.015, 0)
  // 箱盖与两端加强肋
  body.tint(TINT.lid)
  body.box(LENGTH - 0.02, HEIGHT - SEAM_Y - 0.03, WIDTH - 0.02, 0, (HEIGHT + SEAM_Y + 0.03) / 2, 0)
  body.tint(TINT.rib)
  for (const sx of [-1, 1]) {
    body.box(0.05, 0.014, WIDTH - 0.12, sx * 0.48, HEIGHT + 0.007, 0)
    body.box(0.05, 0.014, WIDTH - 0.12, sx * 0.55, HEIGHT + 0.007, 0)
  }
  // 四角护角
  body.tint(TINT.corner)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) body.box(0.07, SEAM_Y, 0.07, sx * (halfX - 0.02), SEAM_Y / 2 + 0.04, sz * (halfZ - 0.02))
  }

  /* ── 橙色锁扣与端盖 ── */

  const accent = new MeshBuilder()
  accent.uvScale = 3
  accent.tint(TINT.accent)
  for (const sx of [-1, 1]) {
    // 前后两面的锁扣，跨过接缝
    for (const sz of [-1, 1]) accent.box(0.1, 0.12, 0.022, sx * 0.4, SEAM_Y + 0.01, sz * (halfZ + 0.008))
    // 箱盖两端的橙色端板：比箱盖略大一圈，从侧面也能认出主武器箱
    accent.box(0.09, HEIGHT - SEAM_Y - 0.025, WIDTH - 0.005, sx * (halfX - 0.04), (HEIGHT + SEAM_Y + 0.03) / 2, 0)
  }

  /* ── 钢件：提手与铰链 ── */

  const steel = new MeshBuilder()
  steel.uvScale = 3
  steel.tube(
    [
      [-0.17, SEAM_Y + 0.01, halfZ + 0.015],
      [-0.17, SEAM_Y + 0.055, halfZ + 0.045],
      [0.17, SEAM_Y + 0.055, halfZ + 0.045],
      [0.17, SEAM_Y + 0.01, halfZ + 0.015],
    ],
    0.014,
  )
  for (const sx of [-1, 1]) steel.box(0.11, 0.06, 0.02, sx * 0.4, SEAM_Y + 0.01, -(halfZ + 0.006))
  // 顶面四个吊环：空投变体的降落伞吊带挂在这里
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      steel.ring(0.028, 0.006, sx * 0.6, HEIGHT + 0.045 - 0.028, sz * 0.15, 0, Math.atan2(sz, -sx), 0, 6, 12)
    }
  }

  shared = { body: body.build(), accent: accent.build(), steel: steel.build() }
  return shared
}

/**
 * 创建主武器箱模型。
 * @param options parachute 为 true 时带上降落伞（空投变体）；摆在地上的开局箱不传
 * @returns 与空投箱同形的绑定：root 原点在箱底中心；无伞时 update 不做任何事
 */
export function createWeaponCrate(options: CrateModelOptions = {}): AirdropRig {
  const geo = geometries()

  const bodyMat = createSurfaceMaterial('polymer')
  const accentMat = createSurfaceMaterial('paintedMetal', { roughness: 0.55 })
  const steelMat = createSurfaceMaterial('steel', { roughness: 0.45 })
  for (const mat of [bodyMat, accentMat, steelMat]) mat.vertexColors = true
  const decalMat = new MeshStandardMaterial({
    map: getDecalTexture(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    roughness: 0.9,
    metalness: 0,
  })
  const materials: Material[] = [bodyMat, accentMat, steelMat, decalMat]

  let chute: ParachuteRig | null = null
  if (options.parachute === true) {
    const webbingMat = createSurfaceMaterial('canvas')
    const canopyMat = createSurfaceMaterial('fabric', { roughness: 0.82 })
    canopyMat.side = DoubleSide
    webbingMat.vertexColors = true
    canopyMat.vertexColors = true
    materials.push(webbingMat, canopyMat)
    chute = createParachute({ attachY: HEIGHT, spreadX: 0.6, spreadZ: 0.15, webbing: webbingMat, canopy: canopyMat })
  }

  const root = new Group()
  root.name = 'weapon-crate'
  const body = new Mesh(geo.body, bodyMat)
  body.name = 'weapon-crate-body'
  enableShadows(body)
  const accent = new Mesh(geo.accent, accentMat)
  accent.name = 'weapon-crate-accent'
  enableShadows(accent)
  const steel = new Mesh(geo.steel, steelMat)
  steel.name = 'weapon-crate-steel'
  enableShadows(steel)
  root.add(body, accent, steel)

  // 顶盖喷印：从上方与第一人称视角都能认出是主武器箱
  const decal = new MeshBuilder()
  decal.patch(
    [-DECAL_HALF_X, HEIGHT + 0.016, DECAL_HALF_Z],
    [DECAL_HALF_X, HEIGHT + 0.016, DECAL_HALF_Z],
    [DECAL_HALF_X, HEIGHT + 0.016, -DECAL_HALF_Z],
    [-DECAL_HALF_X, HEIGHT + 0.016, -DECAL_HALF_Z],
    [0, 0, 1, 1],
  )
  const decalMesh = new Mesh(decal.build(), decalMat)
  decalMesh.name = 'weapon-crate-decal'
  enableShadows(decalMesh, false)
  root.add(decalMesh)
  if (chute) root.add(chute.root)

  return {
    root,
    size: LENGTH,

    update(dt: number, anim: AirdropAnimInput) {
      chute?.update(dt, anim)
    },

    dispose() {
      root.removeFromParent()
      decalMesh.geometry.dispose()
      for (const mat of materials) mat.dispose()
    },
  }
}

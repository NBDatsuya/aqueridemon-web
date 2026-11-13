/**
 * 场地四周的构筑物：红砖围墙、校门、铁丝网围栏、教学楼与体育馆。
 * 全部按材质槽位合并成少量网格；教学楼与体育馆只做视觉（世界系统摆放时不登记碰撞）。
 */

import { DoubleSide, MeshStandardMaterial, Vector3 } from 'three'
import type { Material } from 'three'
import {
  HALF_PI,
  assemble,
  bevelBox,
  cylinder,
  extrude,
  geometrySet,
  glass,
  gridBox,
  hash01,
  limb,
  material,
  meshMaterial,
  patch,
  plane,
  surface,
} from './props-kit'
import type { Assembly, Prop } from './props-kit'

/* ── 材质 ── */

function masonryMaterials(): Record<string, Material> {
  return {
    brick: surface('brick'),
    concrete: surface('concrete'),
    plaster: surface('plaster'),
    metal: surface('paintedMetal', { roughness: 0.55 }),
    steel: surface('steel', { roughness: 0.55 }),
    glass: glass(),
    tape: surface('polymer', { roughness: 0.5 }, 'tape'),
  }
}

/** 教学楼：窗框用白色喷漆金属，其余与围墙共用 */
function schoolMaterials(): Record<string, Material> {
  return { ...masonryMaterials(), frame: surface('paintedMetal', { roughness: 0.45 }, 'frame'), glass: windowGlass() }
}

/* ── 围墙 / 校门 / 围栏 ── */

/** 砖柱 + 混凝土柱帽 */
function pillar(a: Assembly, x: number, height: number, size: number): void {
  a.add('brick', bevelBox(size, height, size, 0.015), x, height / 2, 0)
  a.add('concrete', bevelBox(size + 0.14, 0.14, size + 0.14, 0.03), x, height + 0.07, 0)
  a.add('concrete', bevelBox(size - 0.08, 0.08, size - 0.08, 0.03), x, height + 0.18, 0)
}

/**
 * 一段围墙（沿 X）：混凝土勒脚、红砖墙身、压顶，每 4 米左右一根砖柱。
 * @param length 长度（米）
 * @param height 墙身高度（米，不含柱帽）
 * @param endPillar 是否在 +X 端也立一根砖柱（相邻墙段相接时传 false，避免两根柱子重叠）
 */
export function generateWall(length = 8, height = 2.6, endPillar = true): Prop {
  const set = geometrySet(`wall:${length}:${height}:${endPillar}`, (a) => {
    a.tile('brick', 0.9).tile('concrete', 2)
    a.grime('brick', 0.9, 0.6).grime('concrete', 0.5, 0.7)
    const base = 0.45
    const body = height - base - 0.12
    a.add('concrete', bevelBox(length, base, 0.42, 0.02), 0, base / 2, 0)
    a.add('brick', bevelBox(length, body, 0.3, 0.01), 0, base + body / 2, 0)
    a.add('concrete', bevelBox(length, 0.12, 0.44, 0.03), 0, height - 0.06, 0)
    const pillars = [-length / 2]
    const bays = Math.max(1, Math.round(length / 4))
    for (let i = 1; i < bays; i++) pillars.push(-length / 2 + (i * length) / bays)
    if (endPillar) pillars.push(length / 2)
    for (const x of pillars) pillar(a, x, height + 0.25, 0.56)
  })
  return { group: assemble(set, masonryMaterials()), boxes: [] }
}

/** 已封锁的校门（沿 X）：砖门柱、两扇带矛头的铁栅门、铁链挂锁、红色交叉封条 */
export function generateGate(): Prop {
  const set = geometrySet('gate', (a) => {
    a.tile('brick', 0.9).tile('concrete', 2).tile('metal', 1).tile('tape', 1)
    a.grime('brick', 0.9, 0.6)
    for (const x of [-3.2, 3.2]) pillar(a, x, 3.4, 0.8)
    // 门柱上的校牌（朝场内 -Z）
    a.tint(0xd8d0b0)
    a.add('metal', bevelBox(0.5, 0.9, 0.03, 0.01), -3.2, 2.1, -0.42)
    a.tint(0x2a2c30)
    for (let i = 0; i < 4; i++) a.add('metal', bevelBox(0.06, 0.12, 0.012, 0.004), -3.2, 2.45 - i * 0.2, -0.44)

    // 铁栅门：每扇 2.7 米
    a.tint(0x34383e)
    for (const side of [-1, 1]) {
      const inner = side * 0.06
      const outer = side * 2.78
      for (const y of [0.25, 1.35, 2.45]) a.rod('metal', inner, y, 0, outer, y, 0, 0.035, 6)
      a.rod('metal', inner, 0.1, 0, inner, 2.6, 0, 0.045, 6)
      a.rod('metal', outer, 0.1, 0, outer, 2.6, 0, 0.05, 6)
      for (let i = 1; i < 19; i++) {
        const x = inner + (outer - inner) * (i / 19)
        a.rod('metal', x, 0.1, 0, x, 2.62, 0, 0.018, 5)
        a.add('metal', cylinder(0, 0.035, 0.14, 5), x, 2.69, 0)
      }
      // 斜撑
      a.rod('metal', inner, 0.25, 0, outer, 2.45, 0, 0.022, 5)
    }
    // 铁链与挂锁
    a.add('steel', limb([new Vector3(-0.2, 1.35, -0.06), new Vector3(0, 1.2, -0.1), new Vector3(0.2, 1.35, -0.06)], () => 0.018, 5, 0.3))
    a.tint(0x8a7a40)
    a.add('steel', bevelBox(0.12, 0.14, 0.05, 0.015), 0, 1.16, -0.11)

    // 封条：朝场内一侧的两条交叉红带
    a.tint(0xc0281e)
    a.add('tape', bevelBox(6.2, 0.22, 0.012, 0.004), 0, 1.4, -0.12, 0, 0, 0.42)
    a.add('tape', bevelBox(6.2, 0.22, 0.012, 0.004), 0, 1.4, -0.14, 0, 0, -0.42)
    a.tint()
  })
  return { group: assemble(set, masonryMaterials()), boxes: [] }
}

/** 菱形铁丝网的透明度贴图：每张 4 × 4 个菱形 */
function chainLink(): Material {
  return meshMaterial('chainlink', 0xa4aab0, 0.7, (ctx, w) => {
    ctx.lineWidth = 3
    const step = w / 4
    ctx.beginPath()
    for (let i = -w; i <= w * 2; i += step) {
      ctx.moveTo(i, 0)
      ctx.lineTo(i + w, w)
      ctx.moveTo(i, w)
      ctx.lineTo(i + w, 0)
    }
    ctx.stroke()
  })
}

/**
 * 一段铁丝网围栏（沿 X）：镀锌钢管立柱与横杆、略微松弛的菱形网，顶上向外（-Z）斜挑三道刺丝。
 * @param length 长度（米）
 */
export function generateFence(length = 4): Prop {
  const set = geometrySet(`fence:${length}`, (a) => {
    a.tile('steel', 1)
    const h = length / 2
    for (const x of [-h, h]) {
      a.rod('steel', x, 0, 0, x, 2.25, 0, 0.045, 8)
      a.joint('steel', x, 2.25, 0, 0.05)
      a.rod('steel', x, 2.25, 0, x, 2.6, -0.32, 0.02, 5)
    }
    a.rod('steel', -h, 2.15, 0, h, 2.15, 0, 0.025, 6)
    a.rod('steel', -h, 0.1, 0, h, 0.1, 0, 0.008, 4)
    for (let k = 1; k <= 3; k++) {
      const y = 2.25 + (0.35 * k) / 3
      const z = (-0.32 * k) / 3
      a.add('steel', limb([new Vector3(-h, y, z), new Vector3(0, y - 0.05, z), new Vector3(h, y, z)], () => 0.006, 3, 0.5))
    }
    const net = patch(
      [new Vector3(-h, 0.08, 0), new Vector3(h, 0.08, 0), new Vector3(h, 2.15, 0), new Vector3(-h, 2.15, 0)],
      8,
      4,
      0.25,
      (u, v, p) => {
        p.z += 0.05 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI)
      },
    )
    a.addUV('net', net)
  })
  const group = assemble(set, { steel: surface('steel', { roughness: 0.6 }), net: chainLink() }, ['net'])
  return { group, boxes: [] }
}

/* ── 招牌字 ── */

/**
 * 在 local +X 朝外的立面上画一排“字”：每个字由几笔横竖短条组成，远看像一行标牌文字。
 * 调用前用 a.pose 把字排的中心放到立面上。
 */
function glyphs(a: Assembly, slot: string, count: number, size: number, seed: number): void {
  const pitch = size * 1.25
  const stroke = size * 0.12
  for (let i = 0; i < count; i++) {
    const cz = (i - (count - 1) / 2) * pitch
    // 每个字一横一竖打底，再加 2-3 笔
    a.add(slot, gridBox(0.04, stroke, size * 0.9), 0, size * 0.15, cz)
    a.add(slot, gridBox(0.04, size * 0.9, stroke), 0, 0, cz + (hash01(seed, i) - 0.5) * size * 0.4)
    const extra = 2 + Math.floor(hash01(seed + 7, i) * 2)
    for (let k = 0; k < extra; k++) {
      const horizontal = hash01(seed + k, i * 3) > 0.5
      const oy = (hash01(seed + k * 5, i) - 0.5) * size * 0.7
      const oz = (hash01(seed + k * 9, i) - 0.5) * size * 0.6
      if (horizontal) a.add(slot, gridBox(0.04, stroke, size * 0.5), 0, oy, cz + oz * 0.4)
      else a.add(slot, gridBox(0.04, size * 0.5, stroke), 0, oy * 0.5, cz + oz)
    }
  }
}

/* ── 教学楼 ── */

/** 楼层高（米） */
const STOREY = 3.4

/** 窗框条宽（米） */
const FRAME_BAR = 0.06
/** 玻璃离墙面的距离（米）：远处深度精度约 1-3 cm，留足间隙再配合 polygonOffset，玻璃不会和墙面打架 */
const PANE_GAP = 0.05

/**
 * 楼窗玻璃：不透明、中等光滑、非金属（高金属度 + 极低粗糙度在远处会闪成一片高光噪点），
 * 并用 polygonOffset 把深度往相机方向推一点，进一步杜绝与墙面的深度冲突。
 */
function windowGlass(): Material {
  return material(
    'glass:window',
    () =>
      new MeshStandardMaterial({
        color: 0x1c252c,
        roughness: 0.22,
        metalness: 0,
        envMapIntensity: 1.2,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      }),
  )
}

/**
 * 一扇窗（local +X 朝外，中心在窗洞中心，墙面在 x = 0）：白色铝框（一圈框条，不是实心板）、
 * 离墙 PANE_GAP 的玻璃、竖梃与横档、混凝土窗台。框条从墙里伸出到 +0.10，玻璃夹在框里。
 * @param w 玻璃宽 @param h 玻璃高
 */
function windowUnit(a: Assembly, w: number, h: number): void {
  const t = FRAME_BAR
  a.add('frame', bevelBox(0.12, t, w + 2 * t, 0.01), 0.04, h / 2 + t / 2, 0)
  a.add('frame', bevelBox(0.12, t, w + 2 * t, 0.01), 0.04, -h / 2 - t / 2, 0)
  a.add('frame', bevelBox(0.12, h, t, 0.01), 0.04, 0, w / 2 + t / 2)
  a.add('frame', bevelBox(0.12, h, t, 0.01), 0.04, 0, -w / 2 - t / 2)
  a.add('glass', plane(w, h), PANE_GAP, 0, 0, 0, HALF_PI, 0)
  a.add('frame', gridBox(0.03, h, 0.05), 0.075, 0, 0)
  a.add('frame', gridBox(0.03, 0.05, w), 0.075, h * 0.22, 0)
  a.add('concrete', gridBox(0.2, 0.08, w + 2 * t + 0.2), 0.09, -h / 2 - t - 0.04, 0)
}

/**
 * 教学楼（远景，原点在底面中心）：五层，正立面朝 +X（球场），南北两端也有窗。
 * 带层间腰线、勒脚、转角壁柱、门厅雨篷与台阶、楼名招牌、女儿墙与屋顶设备。
 * @param width X 方向尺寸
 * @param height 总高（含女儿墙）
 * @param depth Z 方向尺寸
 * @param color 墙面颜色
 */
export function generateSchool(width = 44, height = 18, depth = 84, color = 0xd8d0c0): Prop {
  const set = geometrySet(`school:${width}:${height}:${depth}:${color}`, (a) => {
    a.tile('plaster', 3).tile('concrete', 2).tile('frame', 1).tile('steel', 1).tile('metal', 1)
    a.grime('plaster', 2.5, 0.72)
    const hx = width / 2
    const hz = depth / 2
    const floors = Math.max(1, Math.floor((height - 1) / STOREY))
    const top = floors * STOREY

    // 主体、勒脚、腰线、转角壁柱
    a.tint(color)
    a.add('plaster', bevelBox(width, top, depth, 0.05), 0, top / 2, 0)
    a.tint(0xc8c2b6)
    a.add('concrete', bevelBox(width + 0.3, 0.8, depth + 0.3, 0.03), 0, 0.4, 0)
    for (let f = 1; f < floors; f++) a.add('concrete', bevelBox(width + 0.24, 0.3, depth + 0.24, 0.04), 0, f * STOREY, 0)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) a.add('concrete', bevelBox(0.9, top, 0.9, 0.03), sx * (hx - 0.27), top / 2, sz * (hz - 0.27))

    // 女儿墙与压顶、屋面
    a.tint(color)
    a.add('plaster', bevelBox(width, 1, 0.3, 0.02), 0, top + 0.5, hz - 0.15)
    a.add('plaster', bevelBox(width, 1, 0.3, 0.02), 0, top + 0.5, -hz + 0.15)
    a.add('plaster', bevelBox(0.3, 1, depth, 0.02), hx - 0.15, top + 0.5, 0)
    a.add('plaster', bevelBox(0.3, 1, depth, 0.02), -hx + 0.15, top + 0.5, 0)
    a.tint(0xb8b2a6)
    a.add('concrete', bevelBox(width + 0.2, 0.12, 0.5, 0.03), 0, top + 1.06, hz - 0.15)
    a.add('concrete', bevelBox(width + 0.2, 0.12, 0.5, 0.03), 0, top + 1.06, -hz + 0.15)
    a.add('concrete', bevelBox(0.5, 0.12, depth, 0.03), hx - 0.15, top + 1.06, 0)
    a.add('concrete', bevelBox(0.5, 0.12, depth, 0.03), -hx + 0.15, top + 1.06, 0)
    a.tint(0x6a6862)
    a.add('concrete', bevelBox(width - 0.6, 0.06, depth - 0.6, 0.02), 0, top + 0.03, 0)

    // 窗：正立面（+X）每 3.6 米一开间，南北两端每 3.6 米一扇；门厅两侧的底层不开窗
    a.tint()
    const bay = 3.6
    const ww = 2.2
    const wh = 1.8
    const along = (span: number): number[] => {
      const n = Math.floor((span - 2.4) / bay)
      const out: number[] = []
      for (let i = 0; i < n; i++) out.push((i - (n - 1) / 2) * bay)
      return out
    }
    for (let f = 0; f < floors; f++) {
      const y = f * STOREY + 1.85
      for (const z of along(depth)) {
        if (f === 0 && Math.abs(z) < 6.5) continue
        a.pose(hx, y, z, 0, 0, 0)
        windowUnit(a, ww, wh)
      }
      for (const x of along(width)) {
        a.pose(x, y, hz, 0, -HALF_PI, 0)
        windowUnit(a, ww, wh)
        a.pose(x, y, -hz, 0, HALF_PI, 0)
        windowUnit(a, ww, wh)
      }
    }
    a.pose()

    // 门厅：玻璃门、雨篷、两根圆柱、三级台阶
    a.add('glass', plane(8, 2.9), hx + PANE_GAP, 0.8 + 1.45, 0, 0, HALF_PI, 0)
    for (let i = 0; i <= 4; i++) a.add('frame', gridBox(0.08, 2.9, 0.1), hx + 0.06, 0.8 + 1.45, -4 + i * 2)
    a.add('frame', gridBox(0.08, 0.1, 8), hx + 0.06, 0.8 + 2.9, 0)
    a.tint(0xd6d0c4)
    a.add('concrete', bevelBox(3.8, 0.4, 11, 0.06), hx + 1.9, STOREY + 0.2, 0)
    for (const z of [-4.6, 4.6]) a.add('concrete', cylinder(0.26, 0.26, STOREY, 16), hx + 3.2, STOREY / 2, z)
    for (let s = 0; s < 3; s++) a.add('concrete', bevelBox(3.2 - s * 0.5, 0.27, 9.6, 0.02), hx + 1.6 - s * 0.25, 0.135 + s * 0.27, 0)

    // 楼名招牌：立在雨篷前沿上的暗红底板 + 金色字
    const signY = STOREY + 0.4 + 0.5
    a.tint(0x6e1c1a)
    a.add('metal', bevelBox(0.12, 1.0, 9.4, 0.03), hx + 3.7, signY, 0)
    a.tint(0xd8b048)
    a.pose(hx + 3.78, signY, 0, 0, 0, 0)
    glyphs(a, 'metal', 5, 0.72, 11)
    a.pose()

    // 屋顶：楼梯间、空调外机、水箱、天线
    a.tint(color)
    a.add('plaster', bevelBox(5, 3, 6, 0.04), -hx * 0.4, top + 1.5, hz * 0.45)
    a.tint(0x5a4a3c)
    a.add('metal', bevelBox(0.06, 2.1, 1.0, 0.01), -hx * 0.4 + 2.52, top + 1.05, hz * 0.45)
    a.tint(0xc8ccd0)
    for (let i = 0; i < 4; i++) {
      const z = -hz * 0.5 + i * 2.4
      a.add('metal', bevelBox(1.6, 1.1, 1.2, 0.05), hx * 0.35, top + 0.6, z)
      a.tint(0x2a2c30)
      a.add('metal', cylinder(0.42, 0.42, 0.04, 16), hx * 0.35, top + 1.17, z)
      a.tint(0xc8ccd0)
    }
    a.tint()
    a.add('steel', cylinder(1.2, 1.2, 2.2, 18), -hx * 0.45, top + 2.5, -hz * 0.4)
    for (const sx of [-0.8, 0.8]) for (const sz of [-0.8, 0.8]) a.rod('steel', -hx * 0.45 + sx, top, -hz * 0.4 + sz, -hx * 0.45 + sx, top + 1.4, -hz * 0.4 + sz, 0.06, 6)
    a.rod('steel', -hx * 0.4, top + 3, hz * 0.45, -hx * 0.4, top + 7, hz * 0.45, 0.04, 5)
  })
  return { group: assemble(set, schoolMaterials(), ['glass']), boxes: [] }
}

/* ── 体育馆 ── */

/**
 * 体育馆（远景，原点在底面中心）：正立面朝 -X（球场），南北向的筒形拱屋顶带直立锁边，
 * 大块墙板与钢壁柱、高侧窗、门厅悬挑雨篷与招牌，屋脊上一排通风帽。
 * @param width X 方向尺寸（拱的跨度）
 * @param height 总高（拱顶）
 * @param depth Z 方向尺寸
 * @param color 墙板颜色
 */
export function generateGym(width = 44, height = 14, depth = 72, color = 0xb8c6d4): Prop {
  const set = geometrySet(`gym:${width}:${height}:${depth}:${color}`, (a) => {
    a.tile('metal', 2).tile('concrete', 2).tile('frame', 1).tile('steel', 1).tile('roof', 2)
    a.grime('metal', 2, 0.7)
    const hx = width / 2
    const hz = depth / 2
    const wallH = height - 4
    const eaveX = hx + 0.6
    const roofAt = (x: number): number => wallH - 0.15 + 4.15 * (1 - (x / eaveX) ** 2)

    // 勒脚与墙身
    a.tint(0xbab4a8)
    a.add('concrete', bevelBox(width + 0.3, 1.2, depth + 0.3, 0.03), 0, 0.6, 0)
    a.tint(color)
    a.add('metal', bevelBox(width, wallH - 1.2, depth, 0.05), 0, 1.2 + (wallH - 1.2) / 2, 0)
    // 山墙（拱形填充板）
    const gable: [number, number][] = [
      // 与墙身顶面只重叠 2 cm，避免两块共面的墙板在远处深度冲突
      [-hx, wallH - 0.02],
      [hx, wallH - 0.02],
    ]
    for (let i = 0; i <= 24; i++) {
      const x = hx - (i / 24) * width
      gable.push([x, roofAt(x) - 0.05])
    }
    for (const z of [-hz + 0.15, hz - 0.15]) a.add('metal', extrude(gable, 0.3, 0.02), 0, 0, z)

    // 墙板分缝与钢壁柱（正立面与两端）
    a.tint(0x5c636a)
    for (const y of [4.2, 7.0]) a.add('frame', gridBox(0.06, 0.08, depth), -hx - 0.02, y, 0)
    for (let z = -hz; z <= hz + 1e-3; z += 6) a.add('frame', bevelBox(0.5, wallH - 1.2, 0.5, 0.03), -hx - 0.1, 1.2 + (wallH - 1.2) / 2, z)
    for (const sz of [-1, 1]) for (let x = -hx + 5.5; x < hx - 2; x += 5.5) a.add('frame', bevelBox(0.4, wallH - 1.2, 0.4, 0.03), x, 1.2 + (wallH - 1.2) / 2, sz * (hz + 0.1))

    // 高侧窗：正立面每个开间一扇，两端一排
    // 窗都落在两根壁柱之间（壁柱间距：正立面 6 米、两端 5.5 米）
    a.tint(0xe4e6e4)
    for (let z = -hz + 3; z < hz - 1; z += 6) {
      a.pose(-hx, 8.1, z, 0, Math.PI, 0)
      windowUnit(a, 4.5, 1.6)
    }
    for (const sz of [-1, 1]) {
      for (let x = -hx + 2.75; x < hx - 2; x += 5.5) {
        a.pose(x, 8.4, sz * hz, 0, sz > 0 ? -HALF_PI : HALF_PI, 0)
        windowUnit(a, 4.1, 1.4)
      }
    }
    a.pose()

    // 屋顶：抛物线筒拱（单层曲面，材质双面），直立锁边、封檐与屋脊通风帽
    a.tint(0x8c949a)
    const roof = patch(
      [new Vector3(-eaveX, 0, hz + 0.8), new Vector3(eaveX, 0, hz + 0.8), new Vector3(eaveX, 0, -hz - 0.8), new Vector3(-eaveX, 0, -hz - 0.8)],
      28,
      1,
      2,
      (_u, _v, p) => {
        p.y = roofAt(p.x)
      },
    )
    a.add('roof', roof)
    const curve = (z: number, lift: number): Vector3[] => {
      const pts: Vector3[] = []
      for (let i = 0; i <= 16; i++) {
        const x = -eaveX + (i / 16) * eaveX * 2
        pts.push(new Vector3(x, roofAt(x) + lift, z))
      }
      return pts
    }
    a.tint(0x9aa2a8)
    for (let z = -hz - 0.3; z <= hz + 0.3; z += 1.5) a.add('roof', limb(curve(z, 0.03), () => 0.035, 3, 1))
    a.tint(0x4a5056)
    for (const z of [-hz - 0.8, hz + 0.8]) a.add('frame', limb(curve(z, 0), () => 0.12, 6, 1))
    a.add('frame', gridBox(0.25, 0.3, depth + 1.6), -eaveX, wallH - 0.25, 0)
    a.add('frame', gridBox(0.25, 0.3, depth + 1.6), eaveX, wallH - 0.25, 0)
    a.tint(0xa8aeb2)
    for (let z = -hz + 6; z < hz - 3; z += 12) {
      a.add('steel', cylinder(0.45, 0.55, 0.9, 14), 0, roofAt(0) + 0.4, z)
      a.add('steel', cylinder(0.75, 0.1, 0.3, 14), 0, roofAt(0) + 1.0, z)
    }

    // 门厅：玻璃门、悬挑雨篷（两根拉杆）、台阶
    a.tint()
    a.add('glass', plane(9, 3.2), -hx - PANE_GAP, 1.6 + 0.2, 0, 0, -HALF_PI, 0)
    a.tint(0x3a3e44)
    for (let i = 0; i <= 6; i++) a.add('frame', gridBox(0.1, 3.2, 0.1), -hx - 0.08, 1.8, -4.5 + i * 1.5)
    a.add('frame', gridBox(0.1, 0.12, 9), -hx - 0.08, 3.4, 0)
    a.tint(0xd2d4d6)
    a.add('concrete', bevelBox(4.5, 0.35, 12, 0.05), -hx - 2.25, 4.3, 0)
    a.tint(0x6a7076)
    for (const z of [-5.4, 5.4]) a.rod('steel', -hx - 4.2, 4.45, z, -hx - 0.1, 7.2, z, 0.05, 6)
    a.tint(0xc8c4bc)
    for (let s = 0; s < 3; s++) a.add('concrete', bevelBox(3.0 - s * 0.6, 0.2, 10, 0.02), -hx - 1.5 + s * 0.3, 0.1 + s * 0.2, 0)

    // 招牌：白底蓝字
    a.tint(0xf0f0ec)
    a.add('frame', bevelBox(0.12, 1.2, 12, 0.03), -hx - 0.12, 5.6, 0)
    a.tint(0x1e4a8a)
    a.pose(-hx - 0.2, 5.6, 0, 0, Math.PI, 0)
    glyphs(a, 'frame', 7, 0.8, 23)
    a.pose()
    a.tint()
  })
  const mats: Record<string, Material> = {
    metal: surface('paintedMetal', { roughness: 0.55 }),
    concrete: surface('concrete'),
    frame: surface('paintedMetal', { roughness: 0.45 }, 'frame'),
    steel: surface('steel', { roughness: 0.55 }),
    glass: windowGlass(),
    roof: surface('paintedMetal', { roughness: 0.5 }, 'roof', (m) => {
      m.side = DoubleSide
    }),
  }
  return { group: assemble(set, mats, ['glass']), boxes: [] }
}


/**
 * 直升机机身以外的部件：主旋翼、尾桨、尾翼、滑橇，以及天线、空速管、切缆器、救援绞车、灯具等外部附件。
 * 旋翼与尾桨建在各自的本地坐标系里（原点在桨毂中心），其余在机体系（见 helicopter-layout.ts）。
 */

import type { Vec3, WingSection } from './helicopter-airdrop-kit'
import { hullBottom, hullHalfWidth, hullSurface, hullTop } from './helicopter-hull'
import { ROTOR_RADIUS, SKID, TAIL_ROTOR, TINT } from './helicopter-layout'
import type { HeliBuilders } from './helicopter-layout'

const HALF_PI = Math.PI / 2

/** 发光贴图上各色块的取样点（横向四格：红 / 绿 / 白 / 琥珀） */
export const LIGHT_UV = {
  red: [0.125, 0.5],
  green: [0.375, 0.5],
  white: [0.625, 0.5],
  amber: [0.875, 0.5],
} as const

/* ── 主旋翼 ── */

/** 桨叶片数 */
const BLADES = 4
/** 桨叶各站位：[半径, 弦长, 最大厚度]。根部是收窄的桨根套，桨尖略收 */
const BLADE_STATIONS: readonly (readonly [number, number, number])[] = [
  [0.62, 0.2, 0.05],
  [0.95, 0.36, 0.046],
  [2, 0.36, 0.043],
  [3.2, 0.36, 0.042],
  [4.4, 0.36, 0.04],
  [5.24, 0.35, 0.037],
  [5.25, 0.35, 0.037],
  [ROTOR_RADIUS, 0.27, 0.028],
]
/** 桨根安装角与桨尖相对桨根的扭转（弧度，前缘上抬为正） */
const BLADE_ROOT_PITCH = 0.17
const BLADE_TWIST = -0.2
/** 静止时桨尖的下垂量 */
const BLADE_DROOP = 0.05

/**
 * 生成主旋翼（本地系：原点在桨毂中心，绕 +Y 逆时针旋转）：四片带翼型与扭转的桨叶 + 桨毂、挥舞铰、变距拉杆、倾斜盘。
 */
export function buildMainRotor(s: HeliBuilders): void {
  const hub = s.rotorHub
  const blades = s.rotorBlades

  // 桨毂筒、顶盖、旋转的倾斜盘
  hub.tint(TINT.steelDark)
  hub.rod([0, -0.2, 0], [0, 0.09, 0], 0.14, 0.13, 16)
  hub.rod([0, -0.245, 0], [0, -0.205, 0], 0.32, 0.32, 20)
  hub.tint(TINT.rail)
  hub.ball(0.19, 0.075, 0.19, 0, 0.088, 0, 14, 5, HALF_PI)

  for (let k = 0; k < BLADES; k++) {
    const psi = (k / BLADES) * Math.PI * 2
    // er：展向；et：桨叶的运动方向（前缘朝向）
    const er: Vec3 = [Math.cos(psi), 0, -Math.sin(psi)]
    const et: Vec3 = [-Math.sin(psi), 0, -Math.cos(psi)]
    const at = (r: number, t: number, y: number): Vec3 => [er[0] * r + et[0] * t, y, er[2] * r + et[2] * t]

    // 桨毂臂、挥舞铰、桨叶夹板
    hub.tint(TINT.steel)
    hub.beam(at(0.08, 0, 0), at(0.42, 0, 0), 0.2, 0.05)
    hub.tint(TINT.steelDark)
    hub.rod(at(0.42, -0.13, 0), at(0.42, 0.13, 0), 0.045, 0.045, 10)
    hub.beam(at(0.4, 0, 0), at(0.76, 0, 0), 0.15, 0.064)
    hub.tint(TINT.steel)
    for (const r of [0.52, 0.68]) hub.rod(at(r, 0, -0.04), at(r, 0, 0.04), 0.018, 0.018, 6)
    // 变距摇臂 + 拉杆（连到倾斜盘），摆振减震器
    hub.beam(at(0.56, 0.06, -0.01), at(0.56, 0.2, -0.01), 0.03, 0.03)
    hub.rod(at(0.56, 0.2, -0.01), at(0.24, 0.2, -0.21), 0.012, 0.012, 6)
    hub.tint(TINT.black)
    hub.rod(at(0.18, -0.1, 0.02), at(0.6, -0.09, 0.02), 0.022, 0.022, 8)

    // 桨叶：按站位放样，安装角从桨根到桨尖线性扭转
    const sections: WingSection[] = BLADE_STATIONS.map(([r, chord, thickness]) => {
      const pitch = BLADE_ROOT_PITCH + BLADE_TWIST * (r / ROTOR_RADIUS)
      const cp = Math.cos(pitch)
      const sp = Math.sin(pitch)
      const droop = -BLADE_DROOP * (r / ROTOR_RADIUS) ** 2
      return {
        origin: [er[0] * r, droop, er[2] * r],
        chordDir: [-et[0] * cp, -sp, -et[2] * cp],
        thickDir: [-et[0] * sp, cp, -et[2] * sp],
        chord,
        thickness,
        color: r >= 5.25 ? TINT.tip : TINT.blade,
      }
    })
    blades.wing(sections)
    // 后缘调整片
    blades.tint(TINT.steelDark)
    blades.beam(at(3.7, -0.3, -0.012), at(4.15, -0.3, -0.014), 0.07, 0.004)
  }
}

/* ── 尾桨 ── */

/** 尾桨桨叶各站位：[半径, 弦长, 最大厚度] */
const TAIL_BLADE_STATIONS: readonly (readonly [number, number, number])[] = [
  [0.14, 0.11, 0.03],
  [0.3, 0.18, 0.028],
  [0.76, 0.17, 0.022],
  [0.86, 0.165, 0.02],
  [0.865, 0.165, 0.02],
  [TAIL_ROTOR.radius, 0.13, 0.016],
]

/**
 * 生成尾桨（本地系：原点在桨毂中心，绕 +X 旋转，桨盘在 YZ 平面内）：两片桨叶 + 桨毂。
 */
export function buildTailRotor(s: HeliBuilders): void {
  const hub = s.tailHub
  hub.tint(TINT.steelDark)
  hub.rod([-0.07, 0, 0], [0.06, 0, 0], 0.06, 0.06, 12)
  hub.tint(TINT.steel)
  hub.rod([-0.11, 0, 0], [-0.07, 0, 0], 0.035, 0.05, 10)

  for (const phi of [0, Math.PI]) {
    const er: Vec3 = [0, Math.cos(phi), Math.sin(phi)]
    const et: Vec3 = [0, -Math.sin(phi), Math.cos(phi)]
    hub.tint(TINT.steelDark)
    hub.beam([0, er[1] * 0.04, er[2] * 0.04], [0, er[1] * 0.2, er[2] * 0.2], 0.085, 0.04, [1, 0, 0])
    const pitch = 0.14
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const sections: WingSection[] = TAIL_BLADE_STATIONS.map(([r, chord, thickness]) => ({
      origin: [0, er[1] * r, er[2] * r],
      chordDir: [-sp, -et[1] * cp, -et[2] * cp],
      thickDir: [cp, -et[1] * sp, -et[2] * sp],
      chord,
      thickness,
      color: r >= 0.865 ? TINT.tip : TINT.blade,
    }))
    s.tailBlades.wing(sections)
  }
}

/* ── 尾翼 ── */

/**
 * 生成尾部：平尾、后掠垂尾、腹鳍与尾撑、尾桨减速器、尾梁背上的传动轴整流罩。
 */
export function buildTail(s: HeliBuilders): void {
  const paint = s.paint
  paint.tint(TINT.hull)

  // 平尾：左右各一片，略带后掠与收尖
  const stabZ = -6.85
  const stabY = (hullTop(stabZ) + hullBottom(stabZ)) / 2
  for (const side of [-1, 1]) {
    paint.wing(
      [
        { origin: [side * (hullHalfWidth(stabZ) - 0.08), stabY, stabZ], chordDir: [0, 0, -1], thickDir: [0, 1, 0], chord: 0.62, thickness: 0.07, pivot: 0.3 },
        { origin: [side * 1.2, stabY, stabZ - 0.1], chordDir: [0, 0, -1], thickDir: [0, 1, 0], chord: 0.42, thickness: 0.045, pivot: 0.3 },
      ],
      false,
      true,
    )
  }

  // 垂尾：从尾梁末端向后上方伸出
  paint.wing(
    [
      { origin: [0, 0.78, -8.38], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.9, thickness: 0.11, pivot: 0.5 },
      { origin: [0, 1.5, -8.62], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.72, thickness: 0.09, pivot: 0.5 },
      { origin: [0, 2.2, -8.85], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.5, thickness: 0.06, pivot: 0.5 },
    ],
    false,
    true,
  )
  // 腹鳍
  paint.wing(
    [
      { origin: [0, 0.72, -8.3], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.55, thickness: 0.06, pivot: 0.5 },
      { origin: [0, 0.38, -8.5], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.28, thickness: 0.035, pivot: 0.5 },
    ],
    false,
    true,
  )
  // 尾撑：防止尾桨触地的弯钢管
  s.steel.tint(TINT.steelDark)
  s.steel.tube(
    [
      [0, 0.64, -7.95],
      [0, 0.42, -8.35],
      [0, 0.26, -8.7],
      [0, 0.23, -8.9],
      [0, 0.26, -9.02],
    ],
    0.02,
    6,
  )

  // 尾桨减速器与输出轴
  paint.tint(TINT.hullDark)
  paint.ball(0.11, 0.13, 0.17, 0, TAIL_ROTOR.y, TAIL_ROTOR.z, 10, 6)
  s.steel.tint(TINT.steelDark)
  s.steel.rod([-0.05, TAIL_ROTOR.y, TAIL_ROTOR.z], [TAIL_ROTOR.x + 0.06, TAIL_ROTOR.y, TAIL_ROTOR.z], 0.036, 0.036, 10)

  // 尾梁背上的传动轴整流罩，沿垂尾前缘继续向上
  paint.tint(TINT.hull)
  const spine = [-4.5, -5.4, -6.5, -7.6, -8.2]
  for (let k = 0; k < spine.length - 1; k++) {
    paint.beam([0, hullTop(spine[k]) + 0.012, spine[k]], [0, hullTop(spine[k + 1]) + 0.012, spine[k + 1]], 0.14, 0.07)
  }
  paint.beam([0, hullTop(-8.2) + 0.012, -8.2], [0, 1.66, -8.42], 0.1, 0.07, [0, 0, 1])
}

/* ── 滑橇 ── */

/**
 * 生成滑橇起落架：两根前端上翘的滑管、两根拱形横撑管、机腹鞍座、耐磨板与防滑条。
 */
export function buildSkids(s: HeliBuilders): void {
  const y = SKID.y
  for (const side of [-1, 1]) {
    const x = side * SKID.x
    s.steel.tint(TINT.skid)
    s.steel.tube(
      [
        [x, y, -2.35],
        [x, y, -1],
        [x, y, 0.6],
        [x, y, 2.25],
        [x, y + 0.012, 2.48],
        [x, y + 0.05, 2.68],
        [x, y + 0.12, 2.84],
        [x, y + 0.22, 2.95],
      ],
      SKID.radius,
      8,
    )
    // 耐磨板：板底即 root 的 y = 0
    s.steel.tint(TINT.steelDark)
    for (const z of [-1.85, 1.75]) s.steel.box(0.075, 0.016, 0.5, x, y - SKID.radius, z)
    // 防滑条：舱门下方踩踏的一段
    s.polymer.tint(TINT.black)
    s.polymer.box(0.05, 0.01, 2.5, x, y + SKID.radius - 0.002, 0.2)
  }

  // 前后两根拱形横撑管，从一侧滑管经机腹下方到另一侧
  for (const z of [-1.4, 1.55]) {
    const belly = hullBottom(z) - 0.02
    s.steel.tint(TINT.skid)
    s.steel.tube(
      [
        [-SKID.x, y + 0.02, z],
        [-1.24, y + 0.16, z],
        [-1.08, belly - 0.12, z],
        [-0.82, belly - 0.01, z],
        [0.82, belly - 0.01, z],
        [1.08, belly - 0.12, z],
        [1.24, y + 0.16, z],
        [SKID.x, y + 0.02, z],
      ],
      0.045,
      8,
    )
    s.paint.tint(TINT.hullDark)
    for (const side of [-1, 1]) s.paint.box(0.16, 0.07, 0.16, side * 0.6, belly + 0.01, z)
  }
}

/* ── 外部附件 ── */

/**
 * 生成外部附件：空速管、切缆器、天线、雨刷、救援绞车、航行灯、着陆灯与防撞灯。
 */
export function buildFittings(s: HeliBuilders): void {
  const { steel, paint, polymer } = s

  // 机鼻两根空速管
  for (const side of [-1, 1]) {
    const base = hullSurface(4.2, side > 0 ? 0.9 : Math.PI - 0.9)
    steel.tint(TINT.steelDark)
    steel.rod(base, [base[0], base[1] + 0.05, base[2] + 0.04], 0.012, 0.012, 6)
    steel.tint(TINT.steel)
    steel.rod([base[0], base[1] + 0.05, base[2] + 0.02], [base[0], base[1] + 0.055, base[2] + 0.36], 0.011, 0.007, 6)
  }

  // 切缆器：风挡上方与机鼻下方各一片刀片形的板
  paint.tint(TINT.hullDark)
  paint.wing(
    [
      { origin: [0, hullTop(2.8) - 0.02, 2.8], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.3, thickness: 0.03, pivot: 0.2 },
      { origin: [0, hullTop(2.8) + 0.42, 2.5], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.1, thickness: 0.016, pivot: 0.2 },
    ],
    false,
    true,
  )
  paint.wing(
    [
      { origin: [0, hullBottom(3.5) + 0.02, 3.5], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.3, thickness: 0.03, pivot: 0.2 },
      { origin: [0, hullBottom(3.5) - 0.36, 3.24], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.1, thickness: 0.016, pivot: 0.2 },
    ],
    false,
    true,
  )

  // 天线：尾梁上的鞭状天线、机腹与座舱顶的刀状天线、尾梁两侧的导航天线杆
  const whipZ = -5.7
  steel.tint(TINT.steelDark)
  steel.rod([0.1, hullTop(whipZ) - 0.03, whipZ], [0.1, hullTop(whipZ) + 0.06, whipZ - 0.01], 0.022, 0.014, 8)
  steel.rod([0.1, hullTop(whipZ) + 0.05, whipZ - 0.01], [0.1, hullTop(whipZ) + 0.95, whipZ - 0.34], 0.007, 0.004, 5)
  paint.tint(TINT.white)
  paint.wing(
    [
      { origin: [0, hullBottom(0.5) + 0.02, 0.5], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.24, thickness: 0.022, pivot: 0.3 },
      { origin: [0, hullBottom(0.5) - 0.22, 0.42], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.11, thickness: 0.014, pivot: 0.3 },
    ],
    false,
    true,
  )
  paint.wing(
    [
      { origin: [0, hullTop(2.2) - 0.02, 2.2], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.22, thickness: 0.022, pivot: 0.3 },
      { origin: [0, hullTop(2.2) + 0.2, 2.12], chordDir: [0, 0, -1], thickDir: [1, 0, 0], chord: 0.1, thickness: 0.014, pivot: 0.3 },
    ],
    false,
    true,
  )
  steel.tint(TINT.steelDark)
  for (const side of [-1, 1]) {
    const theta = side > 0 ? 0.25 : Math.PI - 0.25
    const a = hullSurface(-7.3, theta, -0.01)
    const b = hullSurface(-7.9, theta, -0.01)
    steel.tube([a, hullSurface(-7.34, theta, 0.07), hullSurface(-7.86, theta, 0.07), b], 0.008, 5, false)
  }

  // 雨刷：每块风挡一支
  polymer.tint(TINT.black)
  for (const side of [-1, 1]) {
    const map = (t: number): number => (side > 0 ? t : Math.PI - t)
    polymer.rod(hullSurface(3.72, map(0.62), 0.012), hullSurface(3.36, map(1.0), 0.016), 0.007, 0.007, 5)
    polymer.rod(hullSurface(3.74, map(0.6), 0.004), hullSurface(3.72, map(0.62), 0.016), 0.012, 0.012, 6)
  }

  // 救援绞车：舱门上方的吊臂 + 绞盘 + 吊钩
  steel.tint(TINT.rail)
  const hoistZ = 0.95
  steel.rod([0.72, 1.1, hoistZ], [0.8, 1.26, hoistZ], 0.06, 0.05, 10)
  steel.rod([0.78, 1.25, hoistZ], [1.43, 1.36, hoistZ], 0.045, 0.04, 10)
  steel.rod([0.82, 1.12, hoistZ - 0.2], [1.2, 1.31, hoistZ - 0.02], 0.02, 0.02, 6)
  polymer.tint(TINT.cableGrey)
  polymer.rod([1.43, 1.36, hoistZ - 0.14], [1.43, 1.36, hoistZ + 0.14], 0.1, 0.1, 14)
  polymer.tint(TINT.black)
  polymer.rod([1.43, 1.36, hoistZ - 0.16], [1.43, 1.36, hoistZ - 0.14], 0.115, 0.115, 14)
  polymer.rod([1.43, 1.36, hoistZ + 0.14], [1.43, 1.36, hoistZ + 0.16], 0.115, 0.115, 14)
  steel.tint(TINT.steel)
  steel.rod([1.5, 1.3, hoistZ], [1.5, 1.1, hoistZ], 0.005, 0.005, 5)
  steel.rod([1.5, 1.1, hoistZ], [1.5, 1.05, hoistZ], 0.022, 0.016, 8)
  steel.ring(0.03, 0.007, 1.5, 1.02, hoistZ, 0, HALF_PI, 0, 5, 10, Math.PI * 1.5)

  /* ── 灯具 ── */

  // 航行灯：平尾尖端（+X 侧为机身左舷，红色；-X 侧绿色），尾尖白色
  const lights = s.navLights
  const stabZ = -6.95
  const stabY = (hullTop(-6.85) + hullBottom(-6.85)) / 2
  lights.fixedUv = LIGHT_UV.red
  lights.ball(0.035, 0.03, 0.05, 1.215, stabY, stabZ + 0.02, 8, 5)
  lights.fixedUv = LIGHT_UV.green
  lights.ball(0.035, 0.03, 0.05, -1.215, stabY, stabZ + 0.02, 8, 5)
  lights.fixedUv = LIGHT_UV.white
  lights.ball(0.03, 0.03, 0.04, 0, 0.86, -8.985, 8, 5)
  // 机鼻下方的着陆灯与机腹搜索灯
  const landing = hullSurface(3.86, -HALF_PI)
  lights.ball(0.075, 0.025, 0.075, landing[0], landing[1] - 0.004, landing[2], 10, 4)
  steel.tint(TINT.steelDark)
  steel.ring(0.08, 0.012, landing[0], landing[1] + 0.002, landing[2], HALF_PI, 0, 0, 5, 14)
  polymer.tint(TINT.black)
  polymer.ball(0.11, 0.11, 0.13, 0.42, hullBottom(2.5) - 0.07, 2.5, 10, 6)
  lights.ball(0.085, 0.085, 0.03, 0.42, hullBottom(2.5) - 0.07, 2.62, 10, 5)
  lights.fixedUv = null

  // 防撞灯：整流罩顶部与机腹各一盏
  s.beacon.ball(0.055, 0.06, 0.055, 0, 1.775, -1.7, 10, 5, HALF_PI)
  s.beacon.ball(0.05, 0.05, 0.05, 0, hullBottom(-0.5) - 0.035, -0.5, 10, 6)
  steel.tint(TINT.steelDark)
  steel.rod([0, 1.74, -1.7], [0, 1.778, -1.7], 0.07, 0.066, 12)
  steel.rod([0, hullBottom(-0.5) + 0.01, -0.5], [0, hullBottom(-0.5) - 0.03, -0.5], 0.065, 0.06, 12)
}

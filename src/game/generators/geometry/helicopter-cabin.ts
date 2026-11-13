/**
 * 直升机舱内：客舱（防滑地板、隔框与桁条、线缆、三联帆布座椅与安全带、隔板上的救援器材、红色舱灯）
 * 与驾驶舱（仪表板、中央操纵台、顶部开关板、两名飞行员及座椅、操纵杆）。
 * 坐标在机体系（见 helicopter-layout.ts）。
 *
 * 视野约束：座位锚点在机体系 (-0.7, 0.35, CABIN_Z)，主控登机后相机就在这里并且可以环顾。
 * 所以锚点周围 0.3m 内不放任何零件，锚点与 +X 侧舱门洞口之间、舱门上沿连线以下也不放东西。
 */

import type { Vec3 } from './helicopter-airdrop-kit'
import { THETA, hullNormal, hullSurface, thetaAtHeight } from './helicopter-hull'
import { CABIN_Z, DOOR_Z0, DOOR_Z1, FLOOR_Y, TINT, WALL } from './helicopter-layout'
import type { HeliBuilders } from './helicopter-layout'

const HALF_PI = Math.PI / 2
const CABIN_LENGTH = DOOR_Z1 - DOOR_Z0

/** 舱顶红灯的位置（点光源挂在它正下方） */
export const CABIN_LAMP = { x: 0, y: 1.1, z: CABIN_Z } as const

/** 只在舱内用到的顶点色 */
const LOCAL = {
  screen: 0x163a44,
  amber: 0xc98a1e,
  visor: 0x0a0c0f,
  kit: 0xdcd9cc,
} as const

/** 客舱内衬上的一点，再向舱内探出 depth 米 */
function lining(z: number, theta: number, depth = 0): Vec3 {
  return hullSurface(z, theta, -(WALL + depth))
}

/* ── 客舱 ── */

/** 地板：纵向防滑棱、舱门口的黄黑警示踏板、系留环 */
function buildFloor(s: HeliBuilders): void {
  // 防滑棱：与进出舱门的方向垂直；座椅下方不铺
  s.polymer.tint(TINT.skid)
  for (let k = 0; k < 23; k++) {
    s.polymer.box(0.02, 0.006, CABIN_LENGTH - 0.08, -0.56 + k * 0.07, FLOOR_Y + 0.002, CABIN_Z)
  }

  // 舱门口的警示踏板
  const blocks = 20
  const length = (CABIN_LENGTH - 0.04) / blocks
  for (let k = 0; k < blocks; k++) {
    s.paint.tint(k % 2 === 0 ? TINT.tip : TINT.black)
    s.paint.box(0.085, 0.008, length, 1.07, FLOOR_Y + 0.003, DOOR_Z0 + 0.02 + length * (k + 0.5))
  }

  // 系留环：底座 + 平躺的环
  for (const x of [0.16, 0.72]) {
    for (const z of [-0.6, 1]) {
      s.steel.tint(TINT.steelDark)
      s.steel.box(0.11, 0.004, 0.11, x, FLOOR_Y + 0.008, z)
      s.steel.tint(TINT.steel)
      s.steel.ring(0.036, 0.007, x, FLOOR_Y + 0.016, z, HALF_PI, 0, 0, 5, 10)
    }
  }
}

/** 舱壁结构：三道隔框、舱顶与窗上的桁条、舱顶扶手与拉环 */
function buildStructure(s: HeliBuilders): void {
  const depth = 0.036
  // 隔框：从 +X 侧舱门上沿绕过舱顶，到 -X 侧地板线以下
  const from = THETA.doorTop + 0.03
  const to = Math.PI - THETA.floor + 0.03
  const steps = 18
  s.paint.tint(TINT.interiorDark)
  for (const z of [DOOR_Z0 + 0.04, 0.15, DOOR_Z1 - 0.04]) {
    let previous = lining(z, from, depth / 2 - 0.004)
    for (let k = 1; k <= steps; k++) {
      const theta = from + ((to - from) * k) / steps
      const point = lining(z, theta, depth / 2 - 0.004)
      s.paint.beam(previous, point, 0.05, depth, hullNormal(z, theta - (to - from) / steps / 2))
      previous = point
    }
  }

  // 桁条：舱顶两根、-X 侧窗上一根
  for (const theta of [0.98, Math.PI - 0.98, Math.PI - thetaAtHeight(CABIN_Z, 0.79)]) {
    s.paint.beam(lining(DOOR_Z0 + 0.02, theta, 0.006), lining(DOOR_Z1 - 0.02, theta, 0.006), 0.03, 0.02, hullNormal(CABIN_Z, theta))
  }

  // 舱顶扶手：在舱门上沿连线以上，不挡座位朝舱门外的视线
  s.steel.tint(TINT.steel)
  s.steel.tube(
    [
      [0.72, 0.99, DOOR_Z0 + 0.12],
      [0.72, 0.99, DOOR_Z1 - 0.12],
    ],
    0.014,
    8,
  )
  s.steel.tint(TINT.steelDark)
  for (const z of [DOOR_Z0 + 0.2, CABIN_Z, DOOR_Z1 - 0.2]) s.steel.rod([0.72, 0.99, z], [0.72, 1.1, z], 0.01, 0.01, 6)
  // 两个拉环，避开座位正前方
  for (const z of [-0.45, 0.85]) {
    s.fabric.tint(TINT.belt)
    s.fabric.box(0.005, 0.19, 0.035, 0.72, 0.885, z)
    s.steel.tint(TINT.steel)
    s.steel.ring(0.042, 0.007, 0.72, 0.755, z, 0, HALF_PI, 0, 5, 10)
  }
}

/** 线缆：沿 -X 侧舱顶转角走的三根线束、线卡，以及通到舱顶灯的分支 */
function buildWiring(s: HeliBuilders): void {
  const run = (theta0: number, radius: number, tint: number, phase: number): void => {
    const points: Vec3[] = []
    const count = 12
    for (let k = 0; k < count; k++) {
      const z = DOOR_Z0 + 0.03 + ((CABIN_LENGTH - 0.06) * k) / (count - 1)
      points.push(lining(z, theta0 + Math.sin(k * 1.3 + phase) * 0.012, radius + 0.003))
    }
    s.polymer.tint(tint)
    s.polymer.tube(points, radius, 6, false)
  }
  run(Math.PI - 1.12, 0.011, TINT.cable, 0)
  run(Math.PI - 1.2, 0.007, TINT.cableGrey, 1.1)
  run(Math.PI - 1.26, 0.007, TINT.cable, 2.3)

  // 线卡
  s.steel.tint(TINT.steel)
  for (const z of [-0.45, 0.62]) {
    s.steel.beam(lining(z, Math.PI - 1.08, 0.024), lining(z, Math.PI - 1.3, 0.024), 0.022, 0.005, hullNormal(z, Math.PI - 1.19))
  }

  // 舱顶灯的供电线
  const feedZ = CABIN_Z + 0.07
  s.polymer.tint(TINT.cable)
  s.polymer.tube(
    [
      lining(feedZ, Math.PI - 1.12, 0.012),
      lining(feedZ, Math.PI - 1.26, 0.01),
      lining(feedZ, Math.PI - 1.4, 0.01),
      lining(feedZ, HALF_PI + 0.09, 0.01),
    ],
    0.006,
    5,
    false,
  )
}

/** -X 侧面向舱门的三联帆布座椅：钢管骨架、坐垫、靠背、肩带与腰带 */
function buildTroopSeats(s: HeliBuilders): void {
  const panY = FLOOR_Y + 0.43
  const topY = FLOOR_Y + 1.02
  const frontX = -0.63
  const rearX = -1.08
  const z0 = -0.7
  const z1 = 1.1
  const pitch = 0.6

  // 骨架：三根纵向管 + 四组立柱与斜撑
  s.steel.tint(TINT.steelDark)
  const rail = (x: number, y: number): void => {
    s.steel.tube(
      [
        [x, y, z0],
        [x, y, z1],
      ],
      0.014,
      6,
    )
  }
  rail(frontX, panY)
  rail(rearX, panY)
  rail(rearX, topY)
  for (let k = 0; k < 4; k++) {
    const z = z0 + 0.02 + ((z1 - z0 - 0.04) * k) / 3
    s.steel.rod([frontX, FLOOR_Y, z], [frontX, panY, z], 0.012, 0.012, 6)
    s.steel.rod([rearX, FLOOR_Y, z], [rearX, topY, z], 0.012, 0.012, 6)
    s.steel.rod([frontX, panY - 0.02, z], [rearX, FLOOR_Y + 0.08, z], 0.009, 0.009, 5)
  }

  for (let seat = 0; seat < 3; seat++) {
    const z = z0 + 0.3 + seat * pitch
    // 坐垫与靠背
    s.fabric.tint(TINT.seat)
    s.fabric.box(0.44, 0.03, 0.54, -0.845, panY + 0.004, z)
    s.fabric.box(0.03, 0.56, 0.54, -1.05, FLOOR_Y + 0.74, z)
    s.fabric.tint(TINT.seatDark)
    s.fabric.box(0.38, 0.035, 0.46, -0.83, panY + 0.03, z)
    // 靠背上的两道加固缝带
    s.fabric.box(0.006, 0.03, 0.54, -1.033, FLOOR_Y + 0.56, z)
    s.fabric.box(0.006, 0.03, 0.54, -1.033, FLOOR_Y + 0.92, z)

    // 肩带（挂在靠背上）与腰带（搭在坐垫上），中间是带扣
    s.fabric.tint(TINT.belt)
    for (const side of [-1, 1]) {
      s.fabric.box(0.006, 0.5, 0.045, -1.031, FLOOR_Y + 0.75, z + side * 0.1)
      s.fabric.box(0.045, 0.006, 0.19, -0.9, panY + 0.05, z + side * 0.125)
      s.fabric.box(0.045, 0.07, 0.006, -0.9, panY + 0.018, z + side * 0.222)
    }
    s.steel.tint(TINT.steel)
    s.steel.box(0.06, 0.014, 0.065, -0.9, panY + 0.054, z)
    for (const side of [-1, 1]) s.steel.box(0.05, 0.012, 0.02, -1.028, FLOOR_Y + 0.99, z + side * 0.1)
  }

  // 座椅下方塞着的两只器材箱
  s.paint.tint(TINT.hullDark)
  s.paint.box(0.34, 0.2, 0.44, -0.86, FLOOR_Y + 0.1, z0 + 0.3)
  s.paint.box(0.34, 0.24, 0.4, -0.86, FLOOR_Y + 0.12, z0 + 0.3 + pitch * 2)
  s.steel.tint(TINT.steel)
  s.steel.box(0.012, 0.03, 0.08, -0.686, FLOOR_Y + 0.13, z0 + 0.3)
  s.steel.box(0.012, 0.03, 0.08, -0.686, FLOOR_Y + 0.17, z0 + 0.3 + pitch * 2)
}

/** 前后隔板上的器材：急救箱、灭火器、机内通话盒、折叠担架、救援绳 */
function buildBulkheadGear(s: HeliBuilders): void {
  const front = DOOR_Z1
  const rear = DOOR_Z0

  // 急救箱：白色箱体 + 红十字
  s.paint.tint(LOCAL.kit)
  s.paint.box(0.34, 0.24, 0.09, 0.35, 0.25, front - 0.045)
  s.paint.tint(TINT.red)
  s.paint.box(0.14, 0.042, 0.004, 0.35, 0.25, front - 0.092)
  s.paint.box(0.042, 0.14, 0.004, 0.35, 0.25, front - 0.092)
  s.steel.tint(TINT.steel)
  s.steel.box(0.05, 0.02, 0.012, 0.35, 0.375, front - 0.085)

  // 灭火器：红色瓶身 + 黑色瓶头与喷管 + 两道卡箍
  const exX = 0.86
  const exZ = front - 0.085
  s.paint.tint(TINT.red)
  s.paint.rod([exX, -0.72, exZ], [exX, -0.36, exZ], 0.055, 0.055, 12)
  s.paint.ball(0.055, 0.03, 0.055, exX, -0.36, exZ, 12, 4, HALF_PI)
  s.polymer.tint(TINT.black)
  s.polymer.rod([exX, -0.34, exZ], [exX, -0.28, exZ], 0.02, 0.016, 8)
  s.polymer.rod([exX, -0.29, exZ], [exX - 0.08, -0.3, exZ - 0.01], 0.008, 0.008, 5)
  s.polymer.box(0.07, 0.014, 0.022, exX + 0.01, -0.27, exZ)
  s.steel.tint(TINT.steel)
  for (const y of [-0.62, -0.44]) s.steel.box(0.13, 0.022, 0.1, exX, y, front - 0.05)

  // 机内通话盒 + 话筒 + 垂下来的一圈线，上方一根线管通到舱顶
  s.polymer.tint(TINT.cableGrey)
  s.polymer.box(0.16, 0.22, 0.06, -0.35, 0.45, front - 0.03)
  s.polymer.tint(TINT.black)
  s.polymer.box(0.05, 0.17, 0.04, -0.2, 0.42, front - 0.03)
  s.polymer.box(0.1, 0.06, 0.006, -0.35, 0.5, front - 0.062)
  s.polymer.tube(
    [
      [-0.35, 0.34, front - 0.03],
      [-0.34, 0.16, front - 0.04],
      [-0.3, 0.05, front - 0.05],
      [-0.24, 0.07, front - 0.045],
      [-0.2, 0.2, front - 0.035],
      [-0.2, 0.335, front - 0.03],
    ],
    0.006,
    5,
    false,
  )
  s.steel.tint(TINT.steelDark)
  s.steel.rod([-0.35, 0.56, front - 0.02], [-0.35, 1.08, front - 0.02], 0.01, 0.01, 6)

  // 后隔板：卷起的折叠担架（两根担架杆夹着帆布卷，两道绑带）
  s.steel.tint(TINT.steel)
  for (const y of [-0.28, -0.52]) s.steel.rod([-0.45, y, rear + 0.05], [0.95, y, rear + 0.05], 0.018, 0.018, 8)
  s.fabric.tint(TINT.seatDark)
  s.fabric.rod([-0.36, -0.4, rear + 0.085], [0.86, -0.4, rear + 0.085], 0.085, 0.085, 12)
  s.fabric.tint(TINT.belt)
  for (const x of [-0.1, 0.6]) {
    s.fabric.box(0.045, 0.34, 0.006, x, -0.4, rear + 0.172)
    s.fabric.box(0.045, 0.006, 0.17, x, -0.232, rear + 0.087)
    s.fabric.box(0.045, 0.006, 0.17, x, -0.568, rear + 0.087)
  }
  s.steel.tint(TINT.steelDark)
  for (const x of [-0.42, 0.92]) s.steel.box(0.04, 0.34, 0.03, x, -0.4, rear + 0.016)

  // 后隔板：挂在钩子上的一盘救援绳
  s.fabric.tint(TINT.rope)
  for (let k = 0; k < 3; k++) s.fabric.ring(0.15 - k * 0.006, 0.022, 0.5, 0.33, rear + 0.03 + k * 0.034, 0, 0, 0, 6, 14)
  s.steel.tint(TINT.steelDark)
  s.steel.rod([0.5, 0.475, rear], [0.5, 0.475, rear + 0.13], 0.012, 0.012, 6)
  s.steel.rod([0.5, 0.475, rear + 0.13], [0.5, 0.515, rear + 0.13], 0.012, 0.012, 6)
}

/** 红色舱灯：舱顶一盏带护圈的圆灯，前后隔板上各一条灯带 */
function buildLamps(s: HeliBuilders): void {
  s.steel.tint(TINT.steelDark)
  s.steel.rod([CABIN_LAMP.x, 1.155, CABIN_LAMP.z], [CABIN_LAMP.x, CABIN_LAMP.y + 0.012, CABIN_LAMP.z], 0.1, 0.092, 14)
  s.steel.ring(0.082, 0.006, CABIN_LAMP.x, CABIN_LAMP.y - 0.022, CABIN_LAMP.z, HALF_PI, 0, 0, 5, 14)
  s.cabinLamp.ball(0.078, 0.04, 0.078, CABIN_LAMP.x, CABIN_LAMP.y + 0.012, CABIN_LAMP.z, 12, 6)

  for (const [z, inward] of [
    [DOOR_Z1, -1],
    [DOOR_Z0, 1],
  ] as const) {
    s.steel.tint(TINT.steelDark)
    s.steel.box(0.44, 0.09, 0.02, 0, 0.85, z + inward * 0.01)
    s.cabinLamp.box(0.38, 0.05, 0.016, 0, 0.85, z + inward * 0.026)
  }
}

/* ── 驾驶舱 ── */

/** 一名飞行员及其座椅、驾驶杆、总距杆与脚蹬。x 为座椅中线 */
function buildPilot(s: HeliBuilders, x: number): void {
  const p = s.polymer
  const z = 2.2

  // 座椅：坐垫、靠背、装甲背板与侧板、底座、肩带
  s.fabric.tint(TINT.seatDark)
  s.fabric.box(0.42, 0.08, 0.44, x, -0.44, z + 0.05)
  s.fabric.box(0.42, 0.66, 0.07, x, -0.09, z - 0.2, -0.09)
  s.paint.tint(TINT.hullDark)
  s.paint.box(0.5, 0.74, 0.025, x, -0.08, z - 0.255, -0.09)
  for (const side of [-1, 1]) s.paint.box(0.025, 0.36, 0.36, x + side * 0.25, -0.3, z - 0.06)
  s.steel.tint(TINT.steelDark)
  s.steel.box(0.3, 0.3, 0.34, x, -0.63, z + 0.03)

  // 躯干与髋部
  p.tint(TINT.suit)
  p.ball(0.19, 0.3, 0.13, x, -0.1, z - 0.08, 10, 6)
  p.ball(0.2, 0.11, 0.17, x, -0.36, z + 0.02, 10, 5)
  // 双腿：大腿前伸，小腿踩向脚蹬
  for (const side of [-1, 1]) {
    const knee: Vec3 = [x + side * 0.13, -0.33, z + 0.5]
    p.tint(TINT.suit)
    p.rod([x + side * 0.09, -0.36, z + 0.08], knee, 0.075, 0.06, 8)
    p.rod(knee, [x + side * 0.15, -0.71, z + 0.78], 0.058, 0.045, 8)
    p.ball(0.06, 0.06, 0.06, knee[0], knee[1], knee[2], 8, 5)
    p.tint(TINT.black)
    p.box(0.09, 0.07, 0.22, x + side * 0.15, -0.735, z + 0.84)
  }
  // 双臂：-X 侧的手握驾驶杆，+X 侧的手握总距杆
  const arm = (shoulder: Vec3, elbow: Vec3, hand: Vec3): void => {
    p.tint(TINT.suit)
    p.ball(0.062, 0.062, 0.062, shoulder[0], shoulder[1], shoulder[2], 8, 5)
    p.rod(shoulder, elbow, 0.055, 0.046, 8)
    p.ball(0.046, 0.046, 0.046, elbow[0], elbow[1], elbow[2], 8, 5)
    p.rod(elbow, hand, 0.044, 0.034, 8)
    p.tint(TINT.black)
    p.ball(0.042, 0.04, 0.05, hand[0], hand[1], hand[2], 8, 5)
  }
  arm([x - 0.2, 0.1, z - 0.1], [x - 0.25, -0.17, z + 0.06], [x - 0.02, -0.25, z + 0.34])
  arm([x + 0.2, 0.1, z - 0.1], [x + 0.28, -0.19, z - 0.03], [x + 0.29, -0.39, z + 0.15])

  // 头部：颈、头盔、深色护目镜、耳罩、送话器
  p.tint(TINT.suit)
  p.rod([x, 0.16, z - 0.09], [x, 0.3, z - 0.07], 0.055, 0.05, 8)
  p.tint(TINT.helmet)
  p.ball(0.125, 0.135, 0.14, x, 0.4, z - 0.06, 12, 8)
  p.tint(LOCAL.visor)
  p.ball(0.097, 0.062, 0.085, x, 0.385, z + 0.036, 10, 6)
  p.tint(TINT.black)
  for (const side of [-1, 1]) p.ball(0.03, 0.058, 0.058, x + side * 0.118, 0.365, z - 0.055, 8, 5)
  p.rod([x + 0.118, 0.34, z - 0.02], [x + 0.05, 0.305, z + 0.085], 0.005, 0.005, 5)
  // 肩带
  s.fabric.tint(TINT.belt)
  for (const side of [-1, 1]) s.fabric.beam([x + side * 0.08, 0.13, z - 0.04], [x + side * 0.1, -0.3, z + 0.06], 0.045, 0.006, [0, 0, 1])

  // 驾驶杆、总距杆、脚蹬
  s.steel.tint(TINT.steelDark)
  s.steel.rod([x, FLOOR_Y, z + 0.44], [x - 0.02, -0.31, z + 0.35], 0.012, 0.012, 6)
  s.steel.rod([x + 0.27, -0.74, z - 0.27], [x + 0.29, -0.43, z + 0.13], 0.014, 0.014, 6)
  for (const side of [-1, 1]) {
    s.steel.box(0.1, 0.12, 0.018, x + side * 0.15, -0.66, z + 0.97, -0.4)
    s.steel.rod([x + side * 0.15, FLOOR_Y, z + 0.99], [x + side * 0.15, -0.66, z + 0.97], 0.01, 0.01, 5)
  }
  p.tint(TINT.black)
  p.rod([x - 0.02, -0.32, z + 0.352], [x - 0.02, -0.21, z + 0.336], 0.02, 0.024, 8)
  p.rod([x + 0.288, -0.46, z + 0.09], [x + 0.292, -0.36, z + 0.2], 0.02, 0.022, 8)
}

/** 驾驶舱：地板、仪表板与遮光罩、仪表、中央操纵台、顶部开关板、两名飞行员 */
function buildCockpit(s: HeliBuilders): void {
  const p = s.polymer
  s.paint.tint(TINT.floor)
  s.paint.box(1.6, 0.04, 2.05, 0, FLOOR_Y - 0.02, 2.375)

  // 仪表板与遮光罩
  const face = 3.09
  p.tint(TINT.black)
  p.box(1.5, 0.44, 0.06, 0, -0.05, face + 0.03)
  p.box(1.56, 0.03, 0.36, 0, 0.185, face + 0.11)
  // 圆形仪表：灰色表圈 + 黑色表盘 + 白色指针，左右各两排
  for (const side of [-1, 1]) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const gx = side * (0.33 + col * 0.125)
        const gy = 0.075 - row * 0.125
        p.tint(TINT.cableGrey)
        p.rod([gx, gy, face], [gx, gy, face - 0.008], 0.05, 0.05, 8)
        p.tint(TINT.black)
        p.rod([gx, gy, face - 0.008], [gx, gy, face - 0.01], 0.041, 0.041, 8)
        p.tint(TINT.white)
        p.box(0.005, 0.034, 0.002, gx + 0.008, gy + 0.01, face - 0.011, 0, 0, 0.7 + col * 0.9 + row * 1.7)
      }
    }
    // 多功能显示屏与下方的一排开关
    p.tint(LOCAL.screen)
    p.box(0.19, 0.15, 0.004, side * 0.115, 0.03, face - 0.002)
    s.steel.tint(TINT.steel)
    for (let k = 0; k < 6; k++) s.steel.box(0.012, 0.03, 0.02, side * (0.3 + k * 0.07), -0.215, face - 0.008, 0.5)
  }
  p.tint(LOCAL.amber)
  p.box(0.3, 0.028, 0.004, 0, 0.135, face - 0.002)

  // 中央操纵台：台面上的旋钮与油门杆
  p.tint(TINT.black)
  p.box(0.24, 0.4, 0.85, 0, -0.58, 2.7)
  s.steel.tint(TINT.steel)
  for (let k = 0; k < 4; k++) {
    for (const side of [-1, 1]) s.steel.rod([side * 0.06, -0.38, 2.42 + k * 0.14], [side * 0.06, -0.36, 2.42 + k * 0.14], 0.016, 0.014, 6)
  }
  p.tint(LOCAL.screen)
  p.box(0.16, 0.004, 0.12, 0, -0.378, 2.98)

  // 顶部开关板与两根发动机油门杆
  p.tint(TINT.black)
  p.box(0.46, 0.05, 0.62, 0, 1.03, 2.15)
  s.paint.tint(TINT.red)
  for (const side of [-1, 1]) {
    s.paint.rod([side * 0.07, 1.01, 2.28], [side * 0.07, 0.93, 2.35], 0.011, 0.011, 6)
    s.paint.ball(0.02, 0.02, 0.02, side * 0.07, 0.925, 2.355, 6, 4)
  }
  s.steel.tint(TINT.steel)
  for (let k = 0; k < 5; k++) {
    for (const side of [-1, 1]) s.steel.box(0.012, 0.025, 0.012, side * 0.15, 0.995, 1.93 + k * 0.09)
  }

  buildPilot(s, -0.47)
  buildPilot(s, 0.47)
}

/**
 * 生成舱内的全部零件（客舱 + 驾驶舱）。
 */
export function buildCabin(s: HeliBuilders): void {
  buildFloor(s)
  buildStructure(s)
  buildWiring(s)
  buildTroopSeats(s)
  buildBulkheadGear(s)
  buildLamps(s)
  buildCockpit(s)
}

/**
 * 直升机模型的共用布局：关键尺寸、颜色，以及按材质分组的网格构建器。
 *
 * 坐标系：除特别说明外，所有坐标都在“机体系”里 —— 原点在机身轴线上（root 上方 HULL_Y 处），
 * 机头朝 +Z，+Y 向上，舱门在 +X 侧（即驾驶员的左手边）。
 */

import { MeshBuilder } from './helicopter-airdrop-kit'

/** 机身轴线离地高度（相对 root） */
export const HULL_Y = 1.7
/** 机头尖端与尾锥尖端的 z */
export const Z_NOSE = 4.5
export const Z_TAIL = -8.98

/** 舱门洞口（也是客舱）的前后范围与中点 */
export const DOOR_Z0 = -0.9
export const DOOR_Z1 = 1.3
export const CABIN_Z = (DOOR_Z0 + DOOR_Z1) / 2
/** 客舱地板顶面高度（也是舱门洞口下沿） */
export const FLOOR_Y = -0.781
/** 舱门洞口上沿 */
export const DOOR_TOP_Y = 0.86
/** 舱门窗下沿、腰线（侧窗下沿）、窗上沿 */
export const WINDOW_LOW_Y = -0.36
export const WAIST_Y = 0
export const WINDOW_TOP_Y = 0.7
/** 舱壁厚度：外蒙皮到内衬的距离 */
export const WALL = 0.05

/** 舱门全开时向后滑动的距离，以及起步时向外弹出的距离 */
export const DOOR_SLIDE = DOOR_Z1 - DOOR_Z0 + 0.02
export const DOOR_POP = 0.06
/** 舱门上、下滑轨的位置（沿 Z 的直轨） */
export const RAIL_TOP = { x: 1.15, y: 0.905 } as const
export const RAIL_BOTTOM = { x: 1.16, y: -0.835 } as const

/** 主旋翼半径与桨毂高度（root 上方 3.72m） */
export const ROTOR_RADIUS = 5.5
export const ROTOR_Y = 2.02
/** 尾桨：在垂尾的 -X 一侧，绕 X 轴旋转 */
export const TAIL_ROTOR = { x: -0.3, y: 1.7, z: -8.63, radius: 0.95 } as const
/** 滑橇：左右间距的一半、管径、管心高度（管底再往下 8mm 是耐磨板，板底正好在 root 的 y = 0） */
export const SKID = { x: 1.3, radius: 0.055, y: 0.063 - HULL_Y } as const

/** 座位锚点（root 本地坐标）：-X 侧座椅上方的坐姿眼高，正对舱门中线 */
export const SEAT = { x: -0.7, y: 2.05, z: CABIN_Z } as const
/** 登机点（root 本地坐标）：舱门外的地面上 */
export const DOOR_POINT = { x: 2.5, y: 0, z: CABIN_Z } as const

/** 蒙皮细节贴花图集的尺寸（像素）：横向对应机身纵向，纵向对应截面周长 */
export const ATLAS = { width: 4096, height: 2048 } as const

/** 顶点色（sRGB） */
export const TINT = {
  hull: 0x56633a,
  hullDark: 0x424d2c,
  interior: 0x717a6c,
  interiorDark: 0x565e54,
  cockpit: 0x242726,
  floor: 0x4c504e,
  black: 0x131415,
  gasket: 0x0f1011,
  rail: 0x3a3d40,
  steel: 0xb2b6ba,
  steelDark: 0x6c7074,
  exhaust: 0x6a5a4b,
  skid: 0x2c2e31,
  blade: 0x1e2022,
  tip: 0xd8a520,
  white: 0xd9d6c8,
  red: 0xa32a22,
  seat: 0x6f6a49,
  seatDark: 0x4d4a35,
  belt: 0x2c3329,
  rope: 0xb09a5e,
  helmet: 0x4b5341,
  suit: 0x3c4533,
  cable: 0x1c1d1f,
  cableGrey: 0x5a5e62,
} as const

/** 按材质分组的构建器：每一组最终合并成一个网格（一次 draw call） */
export interface HeliBuilders {
  /* 机体（静态） */
  /** 喷漆金属：蒙皮、整流罩、尾翼、内衬、地板 */
  paint: MeshBuilder
  /** 钢件：滑橇、滑轨、排气管、旋翼轴、天线、座椅骨架 */
  steel: MeshBuilder
  /** 哑光塑料 / 橡胶：防滑条、进气口内壁、仪表板、线缆、飞行员 */
  polymer: MeshBuilder
  /** 帆布织物：座椅、安全带、绳索 */
  fabric: MeshBuilder
  /** 驾驶舱玻璃 */
  glass: MeshBuilder
  /** 客舱侧窗玻璃（更透） */
  cabinGlass: MeshBuilder
  /** 蒙皮细节贴花层（接缝、铆钉、编号、污渍） */
  overlay: MeshBuilder
  /** 航行灯（发光贴图取色） */
  navLights: MeshBuilder
  /** 舱内红灯灯罩 */
  cabinLamp: MeshBuilder
  /** 防撞灯灯罩 */
  beacon: MeshBuilder

  /* 舱门（整体滑动） */
  doorPaint: MeshBuilder
  doorGlass: MeshBuilder
  doorOverlay: MeshBuilder

  /* 旋翼（整体旋转） */
  /** 主旋翼桨叶 */
  rotorBlades: MeshBuilder
  /** 主旋翼桨毂 */
  rotorHub: MeshBuilder
  /** 尾桨桨叶 */
  tailBlades: MeshBuilder
  /** 尾桨桨毂 */
  tailHub: MeshBuilder
}

/** 创建一组空的构建器，并设好各材质的贴图密度 */
export function createBuilders(): HeliBuilders {
  const make = (uvScale: number): MeshBuilder => {
    const builder = new MeshBuilder()
    builder.uvScale = uvScale
    return builder
  }
  return {
    paint: make(0.8),
    steel: make(2.5),
    polymer: make(2),
    fabric: make(5),
    glass: make(1),
    cabinGlass: make(1),
    overlay: make(1),
    navLights: make(1),
    cabinLamp: make(1),
    beacon: make(1),
    doorPaint: make(0.8),
    doorGlass: make(1),
    doorOverlay: make(1),
    rotorBlades: make(0.8),
    rotorHub: make(2.5),
    tailBlades: make(0.8),
    tailHub: make(2.5),
  }
}

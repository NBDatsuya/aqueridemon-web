/**
 * 救援直升机模型（军用运输直升机，写实质感）。
 *
 * 约定：root 原点在滑橇底部中心，机头朝本地 +Z，舱门在本地 +X 侧。外部系统只控制 root 的位置与朝向，这里只动子节点。
 *
 * 组成（各部分的几何体在同目录的 helicopter-*.ts 里生成）：
 * - helicopter-hull：放样机身（机鼻、风挡与各窗、舱门洞口、内衬、尾梁）、舱门、发动机整流罩
 * - helicopter-parts：主旋翼、尾桨、尾翼、滑橇、天线与灯具
 * - helicopter-cabin：舱内
 * - helicopter-decals：Canvas 现画的蒙皮细节（接缝、铆钉、编号、污渍）与桨盘残影
 *
 * 所有静态零件按材质合并：机体每种材质一个网格，舱门、主旋翼、尾桨各自成组（要整体运动）。
 * 几何体与 Canvas 贴图由所有实例共享（模块级懒创建）；材质每个实例独占，dispose 时释放。
 */

import { CircleGeometry, DoubleSide, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PointLight } from 'three'
import type { BufferGeometry, Material } from 'three'
import type { HelicopterAnimInput, HelicopterRig } from '../../core/types'
import { clamp, damp, smoothstep } from '../../utils/math'
import { createSurfaceMaterial } from '../textures/pbr'
import { enableShadows } from './helicopter-airdrop-kit'
import { CABIN_LAMP, buildCabin } from './helicopter-cabin'
import { getHullOverlayTexture, getLightAtlasTexture, getRotorBlurTexture } from './helicopter-decals'
import { buildCowl, buildDoor, buildHull } from './helicopter-hull'
import { DOOR_POINT, DOOR_POP, DOOR_SLIDE, HULL_Y, ROTOR_RADIUS, ROTOR_Y, SEAT, TAIL_ROTOR, createBuilders } from './helicopter-layout'
import type { HeliBuilders } from './helicopter-layout'
import { buildFittings, buildMainRotor, buildSkids, buildTail, buildTailRotor } from './helicopter-parts'

const TAU = Math.PI * 2

/* ── 动画参数 ── */

/** 主旋翼全速时的角速度（弧度/秒）与转速趋近速率 */
const ROTOR_MAX_SPEED = 30
const ROTOR_RATE = 2.5
/** 尾桨相对主旋翼的转速比 */
const TAIL_RATIO = 4.3
/** 桨盘残影：转速比例超过 BLUR_START 后开始淡入，到 BLUR_FULL 时完全显现 */
const BLUR_START = 0.25
const BLUR_FULL = 0.7
/** 转速比例超过该值后不再画清晰的桨叶（此时残影已完全显现），避免逐帧跳动的频闪 */
const BLADE_HIDE = 0.74
/** 残影的表观转速（弧度/秒）：模拟高速旋翼在眼中缓慢转动的频闪效应 */
const GHOST_SPEED = 2.4
/** 舱门开度的趋近速率 */
const DOOR_RATE = 10
/** 舱内红灯：闪烁角频率（约 1.2 次/秒）、亮度趋近速率、点光源峰值强度 */
const BLINK_SPEED = TAU * 1.2
const BLINK_RATE = 14
const LIGHT_INTENSITY = 5
/** 红灯灯罩的自发光强度：熄灭时的底色与闪亮时的增量（大于 1 的部分会产生泛光） */
const LAMP_IDLE = 0.08
const LAMP_PEAK = 4
/** 航行灯的自发光强度 */
const NAV_INTENSITY = 3
/** 防撞灯：闪烁周期、每次亮起的时长（秒），亮 / 灭时的自发光强度 */
const BEACON_PERIOD = 1.1
const BEACON_FLASH = 0.11
const BEACON_ON = 7
const BEACON_OFF = 0.12

/* ── 共享几何体（模块级懒创建，永不释放） ── */

type SharedGeometries = { [K in keyof HeliBuilders]: BufferGeometry | null } & {
  /** 半径 1 的圆盘（朝 +Z）：桨盘残影 */
  disc: CircleGeometry
}

let shared: SharedGeometries | null = null

function geometries(): SharedGeometries {
  if (!shared) {
    const builders = createBuilders()
    buildHull(builders)
    buildDoor(builders)
    buildCowl(builders)
    buildTail(builders)
    buildSkids(builders)
    buildFittings(builders)
    buildCabin(builders)
    buildMainRotor(builders)
    buildTailRotor(builders)

    const built = {} as { [K in keyof HeliBuilders]: BufferGeometry | null }
    for (const key of Object.keys(builders) as (keyof HeliBuilders)[]) {
      built[key] = builders[key].empty ? null : builders[key].build()
    }
    shared = { ...built, disc: new CircleGeometry(1, 56) }
  }
  return shared
}

/**
 * 创建救援直升机模型。
 * @returns 直升机绑定：root 原点在滑橇底部中心，机头朝本地 +Z；seat 为舱内座位锚点，doorPoint 为 +X 侧舱门外地面上的登机点
 */
export function createHelicopter(): HelicopterRig {
  const geo = geometries()

  /* ── 材质（本实例独占；颜色差异由顶点色提供） ── */

  const paintMat = createSurfaceMaterial('paintedMetal')
  const steelMat = createSurfaceMaterial('steel')
  const polymerMat = createSurfaceMaterial('polymer', { roughness: 0.72 })
  const fabricMat = createSurfaceMaterial('canvas')
  for (const mat of [paintMat, steelMat, polymerMat, fabricMat]) mat.vertexColors = true

  // 驾驶舱玻璃：深色、光滑、有清漆层反射，适度透明
  const glassMat = new MeshPhysicalMaterial({
    color: 0x16211f,
    roughness: 0.06,
    metalness: 0,
    ior: 1.52,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.8,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
  })
  // 客舱侧窗与舱门窗：更透，从舱内也要看得出去，双面渲染
  const cabinGlassMat = new MeshPhysicalMaterial({
    color: 0x2b3a37,
    roughness: 0.05,
    metalness: 0,
    ior: 1.52,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.6,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: DoubleSide,
  })
  // 蒙皮细节贴花层：紧贴蒙皮的透明壳，靠多边形偏移避免与蒙皮闪烁
  const overlayMat = new MeshStandardMaterial({
    map: getHullOverlayTexture(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    roughness: 0.72,
    metalness: 0.1,
  })
  const navMat = createSurfaceMaterial('polymer', { color: 0x1c1c1c, emissive: 0xffffff, emissiveIntensity: NAV_INTENSITY })
  navMat.emissiveMap = getLightAtlasTexture()
  const lampMat = createSurfaceMaterial('polymer', { color: 0x5a1410, emissive: 0xff2a18, emissiveIntensity: LAMP_IDLE, roughness: 0.4 })
  const beaconMat = createSurfaceMaterial('polymer', { color: 0x4a100c, emissive: 0xff2412, emissiveIntensity: BEACON_OFF, roughness: 0.35 })
  const blurMat = new MeshStandardMaterial({
    map: getRotorBlurTexture(),
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    depthWrite: false,
  })
  const materials: Material[] = [
    paintMat,
    steelMat,
    polymerMat,
    fabricMat,
    glassMat,
    cabinGlassMat,
    overlayMat,
    navMat,
    lampMat,
    beaconMat,
    blurMat,
  ]

  const root = new Group()
  root.name = 'helicopter'

  // 机体节点：原点在机身轴线上，所有几何体都建在这个坐标系里
  const body = new Group()
  body.name = 'helicopter-body'
  body.position.y = HULL_Y
  root.add(body)

  /**
   * 把一组合并好的几何体挂到 parent 下；该组为空时返回 null。
   * @param castShadow 是否投影（玻璃、贴花、残影不投影）
   * @param renderOrder 半透明网格的绘制次序：贴花 → 玻璃 → 桨盘残影
   */
  const addMesh = (
    parent: Object3D,
    geometry: BufferGeometry | null,
    material: Material,
    name: string,
    castShadow = true,
    renderOrder = 0,
  ): Mesh | null => {
    if (!geometry) return null
    const mesh = new Mesh(geometry, material)
    mesh.name = name
    mesh.renderOrder = renderOrder
    enableShadows(mesh, castShadow)
    parent.add(mesh)
    return mesh
  }

  /* ── 机体（静态） ── */

  addMesh(body, geo.paint, paintMat, 'hull-paint')
  addMesh(body, geo.steel, steelMat, 'hull-steel')
  addMesh(body, geo.polymer, polymerMat, 'hull-polymer')
  addMesh(body, geo.fabric, fabricMat, 'hull-fabric')
  addMesh(body, geo.overlay, overlayMat, 'hull-overlay', false, 1)
  addMesh(body, geo.glass, glassMat, 'hull-glass', false, 2)
  addMesh(body, geo.cabinGlass, cabinGlassMat, 'cabin-glass', false, 2)
  addMesh(body, geo.navLights, navMat, 'nav-lights', false)
  addMesh(body, geo.cabinLamp, lampMat, 'cabin-lamp', false)
  addMesh(body, geo.beacon, beaconMat, 'beacon', false)

  // 舱内红光：始终留在场景里、靠强度开关（切换 visible 会改变光源数量，触发全场材质重新编译）
  const light = new PointLight(0xff3020, 0, 6, 2)
  light.position.set(CABIN_LAMP.x + 0.1, CABIN_LAMP.y - 0.25, CABIN_LAMP.z)
  body.add(light)

  /* ── 舱门 ── */

  const door = new Group()
  door.name = 'helicopter-door'
  body.add(door)
  addMesh(door, geo.doorPaint, paintMat, 'door-paint')
  addMesh(door, geo.doorOverlay, overlayMat, 'door-overlay', false, 1)
  addMesh(door, geo.doorGlass, cabinGlassMat, 'door-glass', false, 2)

  /* ── 主旋翼与尾桨 ── */

  const rotor = new Group()
  rotor.name = 'helicopter-rotor'
  rotor.position.y = ROTOR_Y
  body.add(rotor)
  addMesh(rotor, geo.rotorHub, steelMat, 'rotor-hub')
  const rotorBlades = addMesh(rotor, geo.rotorBlades, paintMat, 'rotor-blades')

  const tailRotor = new Group()
  tailRotor.name = 'helicopter-tail-rotor'
  tailRotor.position.set(TAIL_ROTOR.x, TAIL_ROTOR.y, TAIL_ROTOR.z)
  body.add(tailRotor)
  addMesh(tailRotor, geo.tailHub, steelMat, 'tail-hub')
  const tailBlades = addMesh(tailRotor, geo.tailBlades, paintMat, 'tail-blades')

  // 高速旋转时代替桨叶的半透明桨盘（只缓慢转动）
  const rotorBlur = new Mesh(geo.disc, blurMat)
  rotorBlur.name = 'rotor-blur'
  rotorBlur.scale.setScalar(ROTOR_RADIUS)
  rotorBlur.position.y = ROTOR_Y
  rotorBlur.rotation.x = -Math.PI / 2
  rotorBlur.renderOrder = 3
  rotorBlur.visible = false
  body.add(rotorBlur)

  const tailBlur = new Mesh(geo.disc, blurMat)
  tailBlur.name = 'tail-blur'
  tailBlur.scale.setScalar(TAIL_ROTOR.radius)
  tailBlur.position.set(TAIL_ROTOR.x, TAIL_ROTOR.y, TAIL_ROTOR.z)
  tailBlur.rotation.y = -Math.PI / 2
  tailBlur.renderOrder = 3
  tailBlur.visible = false
  body.add(tailBlur)

  /* ── 锚点 ── */

  // 座位：按模型约定让锚点的本地 +Z 朝向舱门（+X）
  const seat = new Object3D()
  seat.name = 'helicopter-seat'
  seat.position.set(SEAT.x, SEAT.y, SEAT.z)
  seat.rotation.y = Math.PI / 2
  root.add(seat)

  const doorPoint = new Object3D()
  doorPoint.name = 'helicopter-door-point'
  doorPoint.position.set(DOOR_POINT.x, DOOR_POINT.y, DOOR_POINT.z)
  root.add(doorPoint)

  /* ── 动画状态 ── */

  /** 主旋翼当前角速度（弧度/秒） */
  let rotorSpeed = 0
  let rotorAngle = 0
  let tailAngle = 0
  /** 桨盘残影的表观转角 */
  let ghostAngle = 0
  /** 平滑后的舱门开度 0..1 */
  let doorOpen = 0
  let blinkPhase = 0
  /** 平滑后的红灯亮度 0..1 */
  let lampLevel = 0
  let beaconTime = 0

  return {
    root,
    seat,
    doorPoint,

    update(dt, anim: HelicopterAnimInput) {
      // 旋翼：转速带惯性，角度取模避免无限增长
      rotorSpeed = damp(rotorSpeed, clamp(anim.rotor, 0, 1) * ROTOR_MAX_SPEED, ROTOR_RATE, dt)
      rotorAngle = (rotorAngle + rotorSpeed * dt) % TAU
      tailAngle = (tailAngle + rotorSpeed * TAIL_RATIO * dt) % TAU
      rotor.rotation.y = rotorAngle
      tailRotor.rotation.x = tailAngle

      // 转速升高时桨盘残影淡入，完全显现后藏起清晰的桨叶；转速低时残影淡出
      const spin = rotorSpeed / ROTOR_MAX_SPEED
      const blur = smoothstep((spin - BLUR_START) / (BLUR_FULL - BLUR_START))
      const blurred = blur > 0.01
      blurMat.opacity = blur
      rotorBlur.visible = blurred
      tailBlur.visible = blurred
      const sharp = spin < BLADE_HIDE
      if (rotorBlades) rotorBlades.visible = sharp
      if (tailBlades) tailBlades.visible = sharp
      ghostAngle = (ghostAngle + GHOST_SPEED * spin * dt) % TAU
      rotorBlur.rotation.z = ghostAngle
      tailBlur.rotation.z = -ghostAngle * 2

      // 舱门：先向外弹出一点，再沿机身向后滑开
      doorOpen = damp(doorOpen, clamp(anim.door, 0, 1), DOOR_RATE, dt)
      door.position.x = DOOR_POP * smoothstep(doorOpen / 0.15)
      door.position.z = -DOOR_SLIDE * smoothstep((doorOpen - 0.05) / 0.95)

      // 舱内红灯：打开时按正弦脉冲闪烁，关闭时平滑熄灭
      let target = 0
      if (anim.cabinLight) {
        blinkPhase = (blinkPhase + dt * BLINK_SPEED) % TAU
        const pulse = 0.5 + 0.5 * Math.sin(blinkPhase)
        target = pulse * pulse
      } else {
        blinkPhase = 0
      }
      lampLevel = damp(lampLevel, target, BLINK_RATE, dt)
      lampMat.emissiveIntensity = LAMP_IDLE + lampLevel * LAMP_PEAK
      light.intensity = lampLevel * LIGHT_INTENSITY

      // 防撞灯：每个周期短促地亮一下
      beaconTime = (beaconTime + dt) % BEACON_PERIOD
      beaconMat.emissiveIntensity = beaconTime < BEACON_FLASH ? BEACON_ON : BEACON_OFF
    },

    dispose() {
      root.removeFromParent()
      for (const mat of materials) mat.dispose()
      light.dispose()
    },
  }
}

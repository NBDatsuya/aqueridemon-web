/**
 * 世界系统：足球场、四周封锁物与远景、掩体、天空、光照，以及基于轴对齐包围盒的碰撞 / 射线 / 避障。
 * PLAY_BOUNDS 之外的物体只做视觉（小队由边界限制挡住，丧尸与 Boss 要从那里走进场地）。
 */

import {
  AmbientLight,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three'
import type { BufferGeometry, Material, Object3D, PerspectiveCamera } from 'three'
import {
  AIRDROP_POINTS,
  BLEACHERS,
  BOSS_ENTRY,
  CORNER_COVER,
  FIELD,
  PAD,
  PLAYER,
  PLAYER_START,
  PLAY_BOUNDS,
  SPAWN_POINTS,
} from '../core/config'
import type { Collider, GameContext, RayHit, WorldSystem } from '../core/types'
import {
  createForest,
  disposeProps,
  generateBarrier,
  generateBench,
  generateBillboard,
  generateBleacherWreck,
  generateBus,
  generateCar,
  generateDeskPile,
  generateFallenTree,
  generateFence,
  generateGate,
  generateGoal,
  generateGym,
  generateLampPost,
  generateLocker,
  generateSandbags,
  generateSchool,
  generateTires,
  generateTrashBin,
  generateWall,
} from '../generators/geometry/props'
import type { Prop, TreeSpot } from '../generators/geometry/props'
import { createHills } from '../generators/geometry/terrain'
import { createSkyMaterial } from '../generators/textures'
import { createSurfaceMaterial } from '../generators/textures/pbr'
import { QUALITY_PROFILES, renderState } from '../render/settings'
import { clamp, rayAabb } from '../utils/math'

/** 内部碰撞体：stair 标记的台阶不参与避障（可以直接走上去） */
interface WorldCollider extends Collider {
  stair: boolean
}

interface BreachPiece {
  object: Object3D
  delay: number
  time: number
  spin: number
}

/** 雾：近处清晰，远景淡出；直升机从约 350m 外飞来时仍隐约可见 */
const FOG_COLOR = 0xcfe3f2
const FOG_NEAR = 90
const FOG_FAR = 420
/** 天空穹顶半径（相机 far 为 800） */
const SKY_RADIUS = 600
/**
 * 写实光照：太阳直射光投射实时阴影，天光主要来自天空烘焙的环境贴图（不含日轮，避免与太阳重复），
 * 半球光补一点天地色差，环境光只防止死黑。这套数值取代了 SPEC 早先的“环境光 0.6 + 方向光 0.8、不用实时阴影”，
 * 依据是后来“高质感写实画风”的要求。
 */
const AMBIENT_INTENSITY = 0.06
const HEMI_INTENSITY = 0.42
const SUN_INTENSITY = 3.3
/** 天空环境贴图的照明与反射强度 */
const ENV_INTENSITY = 0.85
/** 太阳方向（从地面指向太阳）：东北方高空，+X 东，-Z 北 */
const SUN_DIR = new Vector3(60, 80, -50).normalize()
/** 阴影相机离阴影框中心的距离（米），要高过最高的投影物 */
const SUN_DISTANCE = 160
/** 没有游戏相机（标题背景）时的静态阴影框半边长（米）：盖住整个可活动区域 */
const STATIC_SHADOW_EXTENT = 72
/** 阴影框中心放在相机前方多远（占半边长的比例），把精度花在视野里 */
const SHADOW_LEAD = 0.5
/** 北侧树林、南侧墙外、两栋楼周边的树木数量上限与最小间距（米） */
const TREE_COUNT = 96
const TREE_SPACING = 4.6
/** 避障：向前探测的距离（米） */
const STEER_LOOK = 2.5
/** 避障：绕行拐角距障碍物的额外间隙（米） */
const STEER_CORNER_GAP = 0.35
/** 随机掩体数量 */
const COVER_COUNT = 12
/** 围栏倒塌动画时长（秒） */
const BREACH_TIME = 0.9

const HALF_PI = Math.PI / 2

/**
 * 线段与矩形（xz 平面）求交。
 * @returns 进入矩形时的参数 t（0..1，起点在矩形内为 0）；不相交返回 -1
 */
function segBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  if (Math.abs(dx) < 1e-9) {
    if (ax < minX || ax > maxX) return -1
  } else {
    let a = (minX - ax) / dx
    let b = (maxX - ax) / dx
    if (a > b) {
      const s = a
      a = b
      b = s
    }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return -1
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < minZ || az > maxZ) return -1
  } else {
    let a = (minZ - az) / dz
    let b = (maxZ - az) / dz
    if (a > b) {
      const s = a
      a = b
      b = s
    }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return -1
  }
  return t0
}

/**
 * 创建世界系统。
 * @param ctx 游戏上下文（工厂期间只使用 scene 与 rng）
 */
export function createWorld(ctx: GameContext): WorldSystem {
  const { scene } = ctx
  const rng = ctx.rng.fork()
  const root = new Group()
  root.name = 'world'
  scene.add(root)

  const colliders: WorldCollider[] = []
  const ownGeometries: BufferGeometry[] = []
  const ownMaterials: Material[] = []
  const breachPieces: BreachPiece[] = []
  let breached = false

  const previousFog = scene.fog
  scene.fog = new Fog(FOG_COLOR, FOG_NEAR, FOG_FAR)

  /* ── 光照 ── */

  const ambient = new AmbientLight(0xffffff, AMBIENT_INTENSITY)
  const sun = new DirectionalLight(0xfff0d8, SUN_INTENSITY)
  sun.castShadow = true
  const shadowSize = QUALITY_PROFILES[renderState.quality].shadowMapSize
  sun.shadow.mapSize.set(shadowSize, shadowSize)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = SUN_DISTANCE + 90
  sun.shadow.bias = -0.0002
  const hemi = new HemisphereLight(0xbfdcff, 0x55663f, HEMI_INTENSITY)
  root.add(ambient, sun, sun.target, hemi)

  // 阴影相机的朝向固定（沿 -SUN_DIR 看，up 为 +Y），它的横纵轴用来把阴影框中心对齐到阴影像素
  const lightRight = new Vector3().crossVectors(new Vector3(0, 1, 0), SUN_DIR).normalize()
  const lightUp = new Vector3().crossVectors(SUN_DIR, lightRight)
  const shadowCenter = new Vector3()
  let shadowExtent = 0

  /**
   * 把阴影框放到 (x, z) 附近：中心在光照平面内按阴影像素取整，相机移动时阴影边缘不会闪烁。
   * @param extent 阴影框半边长（米）
   */
  const placeShadow = (x: number, z: number, extent: number): void => {
    const cam = sun.shadow.camera
    if (extent !== shadowExtent) {
      shadowExtent = extent
      cam.left = -extent
      cam.right = extent
      cam.top = extent
      cam.bottom = -extent
      cam.updateProjectionMatrix()
    }
    const texel = (extent * 2) / sun.shadow.mapSize.x
    // 偏移量与阴影像素相当：既不漏光也不让细物体的阴影脱离底座
    sun.shadow.normalBias = texel * 1.5
    const r = Math.round((x * lightRight.x + z * lightRight.z) / texel) * texel
    const u = Math.round((x * lightUp.x + z * lightUp.z) / texel) * texel
    const d = x * SUN_DIR.x + z * SUN_DIR.z
    shadowCenter.set(0, 0, 0).addScaledVector(lightRight, r).addScaledVector(lightUp, u).addScaledVector(SUN_DIR, d)
    sun.target.position.copy(shadowCenter)
    sun.position.copy(shadowCenter).addScaledVector(SUN_DIR, SUN_DISTANCE)
  }
  placeShadow(0, 0, STATIC_SHADOW_EXTENT)

  // 标题背景只给了 scene / rng / renderer，没有游戏相机：此时阴影框固定盖住整个场地
  const viewCamera: PerspectiveCamera | undefined = ctx.camera
  const viewDir = new Vector3()

  /* ── 天空 ── */

  const skyMaterial = createSkyMaterial()
  const skySun = skyMaterial.uniforms.uSunDir as { value: Vector3 }
  skySun.value.copy(SUN_DIR)
  const skyGeometry = new SphereGeometry(SKY_RADIUS, 32, 20)
  const sky = new Mesh(skyGeometry, skyMaterial)
  sky.frustumCulled = false
  sky.renderOrder = -1
  root.add(sky)

  // 环境反射与天光：把天空（不含日轮）烘焙成预滤波环境贴图，金属与光滑表面靠它产生反射
  const pmrem = new PMREMGenerator(ctx.renderer)
  const envScene = new Scene()
  const envSkyMaterial = skyMaterial.clone()
  const envDisc = envSkyMaterial.uniforms.uDisc as { value: number }
  envDisc.value = 0
  envScene.add(new Mesh(skyGeometry, envSkyMaterial))
  const envTarget = pmrem.fromScene(envScene, 0, 1, SKY_RADIUS * 2)
  pmrem.dispose()
  envSkyMaterial.dispose()
  const previousEnvironment = scene.environment
  const previousEnvIntensity = scene.environmentIntensity
  scene.environment = envTarget.texture
  scene.environmentIntensity = ENV_INTENSITY
  ownGeometries.push(skyGeometry)
  ownMaterials.push(skyMaterial)
  const skyTime = skyMaterial.uniforms.uTime as { value: number }

  /* ── 地面与场地标线 ── */

  const plane = new PlaneGeometry(1, 1)
  ownGeometries.push(plane)

  /** 贴地的矩形片（w 沿 X，d 沿 Z） */
  const flat = (mat: Material, w: number, d: number, x: number, y: number, z: number): Mesh => {
    const mesh = new Mesh(plane, mat)
    mesh.rotation.x = -HALF_PI
    mesh.scale.set(w, d, 1)
    mesh.position.set(x, y, z)
    mesh.receiveShadow = true
    root.add(mesh)
    return mesh
  }

  // 场外：长得更杂、偏黄的草地（约 4 米一铺）
  const outerMaterial = createSurfaceMaterial('grass', { seed: 1, repeat: 125, color: 0xb9c79c })
  flat(outerMaterial, 500, 500, 0, -0.03, 0)

  // 球场：10 条深浅相间的草皮条纹（每条 10 米宽，贴图约 4 米一铺）
  const stripeA = createSurfaceMaterial('grass', { repeat: [2.5, 17.5], color: 0xffffff })
  const stripeB = createSurfaceMaterial('grass', { repeat: [2.5, 17.5], color: 0xcfe2c4 })
  ownMaterials.push(outerMaterial, stripeA, stripeB)
  const stripeWidth = (FIELD.halfX * 2) / 10
  for (let i = 0; i < 10; i++) {
    flat(i % 2 === 0 ? stripeA : stripeB, stripeWidth, FIELD.halfZ * 2, -FIELD.halfX + stripeWidth * (i + 0.5), 0, 0)
  }

  const white = new MeshBasicMaterial({ color: 0xf4f4f0 })
  const yellow = new MeshBasicMaterial({ color: 0xf2c80f })
  ownMaterials.push(white, yellow)
  const LINE = 0.14
  const LINE_Y = 0.015
  // 边线、底线、中线
  flat(white, FIELD.halfX * 2, LINE, 0, LINE_Y, -FIELD.halfZ)
  flat(white, FIELD.halfX * 2, LINE, 0, LINE_Y, FIELD.halfZ)
  flat(white, LINE, FIELD.halfZ * 2, -FIELD.halfX, LINE_Y, 0)
  flat(white, LINE, FIELD.halfZ * 2, FIELD.halfX, LINE_Y, 0)
  flat(white, LINE, FIELD.halfZ * 2, 0, LINE_Y, 0)
  // 两端禁区
  for (const side of [-1, 1]) {
    const edge = side * FIELD.halfX
    flat(white, LINE, 40.3, edge - side * 16.5, LINE_Y, 0)
    flat(white, 16.5, LINE, edge - side * 8.25, LINE_Y, -20.15)
    flat(white, 16.5, LINE, edge - side * 8.25, LINE_Y, 20.15)
  }

  /** 贴地圆环 */
  const ring = (mat: Material, inner: number, outer: number, y: number): void => {
    const g = new RingGeometry(inner, outer, 64)
    ownGeometries.push(g)
    const mesh = new Mesh(g, mat)
    mesh.rotation.x = -HALF_PI
    mesh.position.set(PAD.x, y, PAD.z)
    root.add(mesh)
  }
  ring(white, 9.0, 9.15, LINE_Y)
  // 停机坪：黄色圆环 + “H”
  ring(yellow, PAD.radius - 0.3, PAD.radius, 0.02)
  flat(yellow, 0.5, 3.2, PAD.x - 1.1, 0.02, PAD.z)
  flat(yellow, 0.5, 3.2, PAD.x + 1.1, 0.02, PAD.z)
  flat(yellow, 2.2, 0.5, PAD.x, 0.02, PAD.z)

  /* ── 道具摆放 ── */

  /**
   * 摆放一个道具并登记碰撞体。
   * @param quarter 绕 Y 轴旋转的 90° 倍数
   * @param withColliders 是否登记碰撞（PLAY_BOUNDS 之外的传 false）
   */
  const put = (prop: Prop, x: number, z: number, quarter = 0, withColliders = true): Group => {
    const q = ((quarter % 4) + 4) % 4
    prop.group.position.set(x, 0, z)
    prop.group.rotation.y = q * HALF_PI
    root.add(prop.group)
    if (!withColliders) return prop.group
    const cos = Math.round(Math.cos(q * HALF_PI))
    const sin = Math.round(Math.sin(q * HALF_PI))
    for (const b of prop.boxes) {
      const cx = x + b.x * cos + b.z * sin
      const cz = z - b.x * sin + b.z * cos
      const hx = q % 2 === 0 ? b.hx : b.hz
      const hz = q % 2 === 0 ? b.hz : b.hx
      colliders.push({
        minX: cx - hx,
        maxX: cx + hx,
        minZ: cz - hz,
        maxZ: cz + hz,
        height: b.height,
        walkable: b.walkable,
        blocksShots: b.blocksShots,
        stair: false,
      })
    }
    return prop.group
  }

  // 两端球门（只有门框，不挡路）
  put(generateGoal(), -FIELD.halfX, 0, 0, false)
  put(generateGoal(), FIELD.halfX, 0, 2, false)

  // 四角掩体
  const ne = CORNER_COVER.northEast
  put(generateGoal(true), ne.x - 1, ne.z - 1, 1)
  put(generateBleacherWreck(), ne.x + 3, ne.z + 3)
  const se = CORNER_COVER.southEast
  put(generateDeskPile(4, 2), se.x, se.z, 1)
  put(generateDeskPile(3, 2), se.x + 2.6, se.z - 2.4)
  const sw = CORNER_COVER.southWest
  put(generateBus(), sw.x, sw.z)
  const nw = CORNER_COVER.northWest
  put(generateSandbags(5, 3), nw.x, nw.z + 2)
  put(generateSandbags(4, 3), nw.x - 2.4, nw.z, 1)
  put(generateSandbags(4, 3), nw.x + 2.4, nw.z, 1)

  // 北侧看台：最低一级靠场内（南），往北逐级升高
  const stepMaterial = createSurfaceMaterial('concrete', { repeat: [8, 1], color: 0xd2cec6 })
  ownMaterials.push(stepMaterial)
  const stepDepth = (BLEACHERS.maxZ - BLEACHERS.minZ) / BLEACHERS.steps
  for (let i = 0; i < BLEACHERS.steps; i++) {
    const height = (i + 1) * BLEACHERS.stepHeight
    const maxZ = BLEACHERS.maxZ - i * stepDepth
    const minZ = maxZ - stepDepth
    const step = new Mesh(plane, stepMaterial)
    // 顶面
    step.rotation.x = -HALF_PI
    step.scale.set(BLEACHERS.maxX - BLEACHERS.minX, stepDepth, 1)
    step.position.set((BLEACHERS.minX + BLEACHERS.maxX) / 2, height, (minZ + maxZ) / 2)
    step.receiveShadow = true
    step.castShadow = true
    root.add(step)
    // 朝南的立面
    const riser = new Mesh(plane, stepMaterial)
    riser.scale.set(BLEACHERS.maxX - BLEACHERS.minX, BLEACHERS.stepHeight, 1)
    riser.position.set((BLEACHERS.minX + BLEACHERS.maxX) / 2, height - BLEACHERS.stepHeight / 2, maxZ)
    riser.receiveShadow = true
    riser.castShadow = true
    root.add(riser)
    colliders.push({
      minX: BLEACHERS.minX,
      maxX: BLEACHERS.maxX,
      minZ,
      maxZ,
      height,
      walkable: true,
      blocksShots: true,
      stair: true,
    })
  }

  // 随机中小型掩体：避开停机坪、出生点、空投点、Boss 进场通道、四角掩体和彼此
  const coverMakers: (() => Prop)[] = [
    generateBench,
    generateLocker,
    generateTires,
    () => generateSandbags(4, 3),
    () => generateDeskPile(2, 2),
    generateTrashBin,
    generateBarrier,
    generateBench,
    generateLocker,
    generateTires,
    () => generateCar(0x3a5a7a, { style: 'hatch' }),
    () => generateSandbags(3, 3),
  ]
  const coverSpots: { x: number; z: number }[] = []
  const corners = [ne, se, sw, nw]
  const spotFree = (x: number, z: number): boolean => {
    if (Math.hypot(x - PAD.x, z - PAD.z) < 9 + 2) return false
    if (Math.hypot(x - PLAYER_START.x, z - PLAYER_START.z) < 6 + 2) return false
    if (Math.abs(x) < 9 + 2 && z < -20) return false
    if (x > BLEACHERS.minX - 3 && x < BLEACHERS.maxX + 3 && z < BLEACHERS.maxZ + 4) return false
    for (const p of AIRDROP_POINTS) if (Math.hypot(x - p.x, z - p.z) < 3 + 2.2) return false
    for (const c of corners) if (Math.hypot(x - c.x, z - c.z) < 9) return false
    for (const s of coverSpots) if (Math.hypot(x - s.x, z - s.z) < 7) return false
    return true
  }
  for (let i = 0; i < COVER_COUNT; i++) {
    const make = coverMakers[i % coverMakers.length]
    if (!make) continue
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = rng.range(-46, 46)
      const z = rng.range(-31, 31)
      if (!spotFree(x, z)) continue
      coverSpots.push({ x, z })
      put(make(), x, z, rng.int(0, 3))
      break
    }
  }

  /* ── 四周封锁物与远景（只有视觉） ── */

  /** x 是否落在某个南 / 北刷新点的进场通道上 */
  const onSpawnLane = (x: number, side: 'north' | 'south'): boolean =>
    SPAWN_POINTS.some((p) => p.side === side && Math.abs(x - p.x) < 5)

  // 北：倒塌的围栏（中间一段留给 Boss 撕开）、横倒的大树、树林与后山
  const FENCE_LEN = 4
  for (let x = -PLAY_BOUNDS.halfX + 1; x <= PLAY_BOUNDS.halfX - 1; x += FENCE_LEN) {
    if (onSpawnLane(x, 'north')) continue
    const group = put(generateFence(FENCE_LEN), x, BOSS_ENTRY.breachZ, 0, false)
    if (Math.abs(x - BOSS_ENTRY.startX) <= BOSS_ENTRY.breachHalfWidth) {
      breachPieces.push({ object: group, delay: rng.range(0, 0.25), time: 0, spin: rng.range(-0.5, 0.5) })
    } else if (rng.chance(0.3)) {
      // 部分围栏已经歪倒
      group.rotation.x = rng.range(-0.5, 0.5)
    }
  }
  put(generateFallenTree(), 20, BOSS_ENTRY.breachZ - 2.5, 0, false)
  put(generateFallenTree(), -22, BOSS_ENTRY.breachZ - 3.5, 2, false)

  // 树木：北侧树林为主，南侧墙外与两栋楼周边零散几棵；避开 Boss 进场通道、刷新点进场路线、校门前的路和建筑
  const SCHOOL = { x: -100, z: 0, hx: 22, hz: 42 }
  const GYM = { x: 100, z: 0, hx: 22, hz: 36 }
  const treeSpots: TreeSpot[] = []
  const treeFree = (x: number, z: number): boolean => {
    if (Math.abs(x) < PLAY_BOUNDS.halfX + 8 && Math.abs(z) < PLAY_BOUNDS.halfZ + 9) return false
    for (const b of [SCHOOL, GYM]) {
      if (Math.abs(x - b.x) < b.hx + 7 && Math.abs(z - b.z) < b.hz + 5) return false
    }
    if (z < 0 && Math.abs(x - BOSS_ENTRY.startX) < BOSS_ENTRY.breachHalfWidth + 3 && z > -90) return false
    if (z < 0 && onSpawnLane(x, 'north') && z > -72) return false
    if (z > 0 && onSpawnLane(x, 'south') && z < 72) return false
    if (z > 0 && Math.abs(x) < 8) return false
    for (const p of SPAWN_POINTS) if (Math.hypot(x - p.x, z - p.z) < 9) return false
    for (const s of treeSpots) if (Math.hypot(x - s.x, z - s.z) < TREE_SPACING) return false
    return true
  }
  for (let attempt = 0; attempt < TREE_COUNT * 8 && treeSpots.length < TREE_COUNT; attempt++) {
    // 七成落在北侧树林
    const north = rng.chance(0.7)
    const x = rng.range(-135, 135)
    const z = north ? rng.range(-130, -52) : rng.range(-60, 105)
    if (treeFree(x, z)) treeSpots.push({ x, z })
  }
  const forest = createForest(rng, treeSpots, 0.4)
  root.add(forest.group)

  // 后山：北侧树林背后的缓坡草丘（Boss 从这个方向爬出）
  const hills = createHills()
  root.add(hills.mesh)

  // 东：体育馆、废弃汽车、公告板
  put(generateGym(44, 14, 72, 0xb8c6d4), GYM.x, GYM.z, 0, false)
  put(generateCar(0x7a2f2a, { flat: true }), PLAY_BOUNDS.halfX + 4, -32, 1, false)
  put(generateCar(0x2f4a3a, { style: 'hatch' }), PLAY_BOUNDS.halfX + 5.5, 3, 1, false)
  put(generateCar(0x8a8a8e), PLAY_BOUNDS.halfX + 4, 31, 1, false)
  put(generateBillboard(), PLAY_BOUNDS.halfX + 3, -8, 1, false)

  // 南：校门围墙（已封锁）、课桌椅障碍墙、倾斜的路灯
  const WALL_LEN = 8
  const wallZ = PLAY_BOUNDS.halfZ + 4.5
  const wallXs: number[] = []
  for (let x = -PLAY_BOUNDS.halfX - 3; x <= PLAY_BOUNDS.halfX + 3; x += WALL_LEN) {
    if (Math.abs(x) < 5 || onSpawnLane(x, 'south')) continue
    wallXs.push(x)
  }
  wallXs.forEach((x, i) => {
    // 和下一段相接时，那一段左端的砖柱就是这一段的右端柱
    const next = wallXs[i + 1]
    const joined = next !== undefined && Math.abs(next - x - WALL_LEN) < 1e-6
    put(generateWall(WALL_LEN, 2.6, !joined), x, wallZ, 0, false)
  })
  put(generateGate(), 0, wallZ, 0, false)
  put(generateDeskPile(5, 3), -11, PLAY_BOUNDS.halfZ + 2.2, 0, false)
  put(generateDeskPile(5, 3), 12, PLAY_BOUNDS.halfZ + 2.4, 0, false)
  put(generateLampPost(0.32), -21, PLAY_BOUNDS.halfZ + 1.5, 0, false)
  put(generateLampPost(-0.24), 22, PLAY_BOUNDS.halfZ + 2, 2, false)

  // 西：教学楼、翻倒的垃圾桶、木板铁丝网路障
  put(generateSchool(44, 18, 84, 0xd8d0c0), SCHOOL.x, SCHOOL.z, 0, false)
  put(generateTrashBin(), -PLAY_BOUNDS.halfX - 2.5, -8, 0, false)
  put(generateTrashBin(), -PLAY_BOUNDS.halfX - 3, 9, 1, false)
  put(generateBarrier(), -PLAY_BOUNDS.halfX - 2, -30, 1, false)
  put(generateBarrier(), -PLAY_BOUNDS.halfX - 2, 0, 1, false)
  put(generateBarrier(), -PLAY_BOUNDS.halfX - 2, 30, 1, false)

  /* ── 碰撞与射线 ── */

  const hit: RayHit = { distance: 0, point: new Vector3(), normal: new Vector3(), kind: 'world' }
  const tmpDir = new Vector3()

  /** 射线到某个碰撞体的距离；未命中返回 -1 */
  const rayCollider = (origin: Vector3, dir: Vector3, c: WorldCollider): number =>
    rayAabb(origin, dir, c.minX, 0, c.minZ, c.maxX, c.height, c.maxZ)

  const system: WorldSystem = {
    colliders,

    resolveMove(pos, radius, feetY, clampToBounds) {
      for (let pass = 0; pass < 2; pass++) {
        for (const c of colliders) {
          // 已经在顶面之上，或可以直接踏上去的台阶：不阻挡
          if (feetY >= c.height - 0.02) continue
          if (c.walkable && c.height <= feetY + PLAYER.stepHeight) continue
          const nx = clamp(pos.x, c.minX, c.maxX)
          const nz = clamp(pos.z, c.minZ, c.maxZ)
          const ox = pos.x - nx
          const oz = pos.z - nz
          const d2 = ox * ox + oz * oz
          if (d2 >= radius * radius) continue
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2)
            const push = (radius - d) / d
            pos.x += ox * push
            pos.z += oz * push
            continue
          }
          // 圆心在盒内：从最近的一面推出
          const left = pos.x - c.minX
          const right = c.maxX - pos.x
          const north = pos.z - c.minZ
          const south = c.maxZ - pos.z
          const m = Math.min(left, right, north, south)
          if (m === left) pos.x = c.minX - radius
          else if (m === right) pos.x = c.maxX + radius
          else if (m === north) pos.z = c.minZ - radius
          else pos.z = c.maxZ + radius
        }
      }
      if (clampToBounds) {
        pos.x = clamp(pos.x, -PLAY_BOUNDS.halfX + radius, PLAY_BOUNDS.halfX - radius)
        pos.z = clamp(pos.z, -PLAY_BOUNDS.halfZ + radius, PLAY_BOUNDS.halfZ - radius)
      }
    },

    groundHeight(x, z, feetY) {
      let ground = 0
      const limit = feetY + PLAYER.stepHeight
      for (const c of colliders) {
        if (!c.walkable || c.height > limit || c.height <= ground) continue
        if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue
        ground = c.height
      }
      return ground
    },

    raycast(origin, dir, maxDist) {
      let best = maxDist
      let found: WorldCollider | null = null
      let ground = false
      if (dir.y < -1e-6 && origin.y > 0) {
        const t = -origin.y / dir.y
        if (t <= best) {
          best = t
          ground = true
        }
      }
      for (const c of colliders) {
        if (!c.blocksShots) continue
        const t = rayCollider(origin, dir, c)
        if (t >= 0 && t < best) {
          best = t
          found = c
          ground = false
        }
      }
      if (!found && !ground) return null
      hit.distance = best
      hit.point.copy(origin).addScaledVector(dir, best)
      if (!found) {
        hit.normal.set(0, 1, 0)
        return hit
      }
      // 命中点离哪个面最近，就取那个面的法线
      const p = hit.point
      const dTop = Math.abs(p.y - found.height)
      const dMinX = Math.abs(p.x - found.minX)
      const dMaxX = Math.abs(p.x - found.maxX)
      const dMinZ = Math.abs(p.z - found.minZ)
      const dMaxZ = Math.abs(p.z - found.maxZ)
      const m = Math.min(dTop, dMinX, dMaxX, dMinZ, dMaxZ)
      if (m === dTop) hit.normal.set(0, 1, 0)
      else if (m === dMinX) hit.normal.set(-1, 0, 0)
      else if (m === dMaxX) hit.normal.set(1, 0, 0)
      else if (m === dMinZ) hit.normal.set(0, 0, -1)
      else hit.normal.set(0, 0, 1)
      return hit
    },

    hasLineOfSight(from, to) {
      tmpDir.subVectors(to, from)
      const dist = tmpDir.length()
      if (dist < 1e-4) return true
      tmpDir.multiplyScalar(1 / dist)
      for (const c of colliders) {
        if (!c.blocksShots) continue
        const t = rayCollider(from, tmpDir, c)
        if (t >= 0 && t < dist) return false
      }
      return true
    },

    steer(from, to, radius, out) {
      let dx = to.x - from.x
      let dz = to.z - from.z
      const dist = Math.hypot(dx, dz)
      if (dist < 1e-4) return out.set(0, 0, 0)
      dx /= dist
      dz /= dist

      // 前方一小段路是否被挡：盒子只外扩略小于自身半径，贴墙滑行时不会误判
      const look = Math.min(dist, STEER_LOOK + radius)
      const ex = from.x + dx * look
      const ez = from.z + dz * look
      const grow = radius * 0.9
      let blocker: WorldCollider | null = null
      let nearest = Infinity
      for (const c of colliders) {
        if (c.stair) continue
        const t = segBox(from.x, from.z, ex, ez, c.minX - grow, c.maxX + grow, c.minZ - grow, c.maxZ + grow)
        if (t >= 0 && t < nearest) {
          nearest = t
          blocker = c
        }
      }
      if (!blocker) return out.set(dx, 0, dz)

      // 在障碍物四个外扩拐角里，选“经拐角到目标”总路程最短且能直线到达的那个。
      // 按路程选择是稳定的：朝选中的拐角前进只会让它更优，不会在两侧来回抖动。
      const gap = radius + STEER_CORNER_GAP
      const core = radius * 0.5
      let bestCost = Infinity
      let cx = 0
      let cz = 0
      for (let i = 0; i < 4; i++) {
        const px = i & 1 ? blocker.maxX + gap : blocker.minX - gap
        const pz = i & 2 ? blocker.maxZ + gap : blocker.minZ - gap
        const blocked =
          segBox(
            from.x,
            from.z,
            px,
            pz,
            blocker.minX - core,
            blocker.maxX + core,
            blocker.minZ - core,
            blocker.maxZ + core,
          ) >= 0
        if (blocked) continue
        const cost = Math.hypot(px - from.x, pz - from.z) + Math.hypot(to.x - px, to.z - pz)
        if (cost < bestCost) {
          bestCost = cost
          cx = px
          cz = pz
        }
      }
      // 没有可达拐角（已经挤在障碍物里）：沿垂直方向滑出去
      if (bestCost === Infinity) return out.set(-dz, 0, dx)
      const ox = cx - from.x
      const oz = cz - from.z
      const len = Math.hypot(ox, oz)
      if (len < 0.15) return out.set(dx, 0, dz)
      return out.set(ox / len, 0, oz / len)
    },

    breakNorthBarrier() {
      // 围栏在 PLAY_BOUNDS 之外，没有碰撞体，这里只做倒塌表现
      breached = true
    },

    update(dt) {
      skyTime.value += dt
      // 阴影框跟随相机（世界系统在玩家之后更新，相机位置已是本帧的）
      if (viewCamera) {
        const extent = QUALITY_PROFILES[renderState.quality].shadowExtent
        viewCamera.getWorldDirection(viewDir)
        viewDir.y = 0
        const len = viewDir.length()
        const lead = len > 1e-4 ? (extent * SHADOW_LEAD) / len : 0
        placeShadow(viewCamera.position.x + viewDir.x * lead, viewCamera.position.z + viewDir.z * lead, extent)
      }
      if (!breached) return
      for (const piece of breachPieces) {
        if (piece.time >= BREACH_TIME) continue
        if (piece.delay > 0) {
          piece.delay -= dt
          continue
        }
        piece.time = Math.min(BREACH_TIME, piece.time + dt)
        const k = piece.time / BREACH_TIME
        const ease = k * k
        // 朝场内（南）拍倒，并略微甩开
        piece.object.rotation.x = ease * 1.5
        piece.object.rotation.z = ease * piece.spin
        piece.object.position.z = BOSS_ENTRY.breachZ + ease * 1.2
      }
    },

    dispose() {
      root.removeFromParent()
      scene.fog = previousFog
      scene.environment = previousEnvironment
      scene.environmentIntensity = previousEnvIntensity
      envTarget.dispose()
      forest.dispose()
      hills.dispose()
      ownGeometries.forEach((g) => g.dispose())
      ownMaterials.forEach((m) => m.dispose())
      disposeProps()
      colliders.length = 0
      breachPieces.length = 0
    },
  }

  return system
}

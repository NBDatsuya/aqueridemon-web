/**
 * 标题菜单背景：实时渲染操场俯视图（真实的游戏场地），相机缓慢漂移并跟随鼠标做轻微视差。
 * 首次创建会同步跑程序贴图，调用方应先显示加载遮罩。世界与渲染器在菜单类页面之间复用，
 * 进入游戏前调用 disposeTitleBackdrop() 释放，避免与游戏渲染器同时占用两份显存。
 */

import { ACESFilmicToneMapping, MathUtils, PCFSoftShadowMap, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { GAME_SEED } from '../core/config'
import type { GameContext, WorldSystem } from '../core/types'
import { createWorld } from '../systems/world'
import { createRng } from '../utils/random'

/** 背景图的曝光：俯视时大片草地受光，比游戏内（1）略暗一点 */
const EXPOSURE = 0.95
/** 垂直视角（度） */
const FOV = 40
/** 相机偏离正俯视的角度（度）：相机在南侧上空，略微朝北看，显出看台与建筑的立面 */
const TILT = 14
/** 画面中心（场地中心略偏北，给北侧看台和围栏留位置） */
const TARGET = new Vector3(0, 0, -2)
/** 画面至少要盖住的半高（南北，米）：南墙约 z=47.5，北侧围栏 z=-45 */
const MIN_HALF_DEPTH = 48
/** 画面至少要盖住的半宽（东西，米）：可活动范围 ±57 再留一点场边 */
const MIN_HALF_WIDTH = 62
/** 像素比上限：背景整屏实时渲染，高分屏不按满分辨率画 */
const MAX_PIXEL_RATIO = 1.5
/** 相机摆动后画面边缘会多露出一点场外，取景按这个比例放宽 */
const COVER_MARGIN = 1.06

/* 相机漂移：各分量周期互不成倍数，叠加后看不出循环 */
/** 绕竖直轴的摆动幅度（度）与周期（秒） */
const SWAY_YAW = 4
const SWAY_YAW_PERIOD = 58
/** 俯仰摆动幅度（度）与周期（秒），围绕 TILT 上下摆 */
const SWAY_TILT = 3
const SWAY_TILT_PERIOD = 41
/** 画面中心东西 / 南北方向的平移幅度（米）与周期（秒） */
const DRIFT_X = 4
const DRIFT_X_PERIOD = 67
const DRIFT_Z = 2.5
const DRIFT_Z_PERIOD = 53
/** 推拉幅度（相对距离的比例）与周期（秒） */
const DOLLY = 0.03
const DOLLY_PERIOD = 37
/** 鼠标视差：指针在屏幕边缘时画面中心偏移的米数 */
const PARALLAX = 2.5
/** 视差跟随速度（1/秒），越大跟得越紧 */
const PARALLAX_SMOOTH = 2
/** 单帧 dt 上限（秒）：切回标签页时不跳 */
const MAX_DT = 0.1
/** 灯光脉动为 1 时曝光的增幅（音乐鉴赏页随节拍调亮） */
const PULSE_EXPOSURE = 0.3

interface Backdrop {
  readonly renderer: WebGLRenderer
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly world: WorldSystem
  /** 累计动画时间（秒），跨页面保持连续，回到菜单时镜头接着上次的位置走 */
  elapsed: number
}

interface PlanarPoint {
  x: number
  y: number
}

/** 当前（或正在创建的）背景实例；被释放后置空 */
let pending: Promise<Backdrop> | null = null
/** 当前挂载的清理函数；释放实例时先停掉它的渲染循环 */
let activeCleanup: (() => void) | null = null

/** 灯光脉动 0..1：由页面每帧写入，下一帧渲染时折算成曝光 */
let pulse = 0

const aimTarget = new Vector3()

/** 等下一帧画完（连续两次 rAF 才能保证上一帧的遮罩已经上屏） */
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

const wave = (t: number, period: number, phase: number): number => Math.sin((t / period) * Math.PI * 2 + phase)

/** 创建渲染器与游戏场地（同步跑程序贴图，较重） */
async function create(): Promise<Backdrop> {
  // 先让加载遮罩真正画出来，再开始同步的重活
  await nextFrame()
  await nextFrame()

  const renderer = new WebGLRenderer({ antialias: true })
  let world: WorldSystem | null = null
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    // 与游戏渲染管线一致：软阴影 + ACES 色调映射。场景里投影的物体都不动，阴影只画一次
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFSoftShadowMap
    renderer.shadowMap.autoUpdate = false
    renderer.shadowMap.needsUpdate = true
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = EXPOSURE

    const canvas = renderer.domElement
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'

    const scene = new Scene()
    // createWorld 在工厂期间只用到 scene、rng、renderer（rng 用来派生子序列，renderer 用来烘焙环境贴图），
    // 其余字段不会被访问，所以这里只给这三个字段再转型
    const ctx = { scene, rng: createRng(GAME_SEED), renderer } as unknown as GameContext
    world = createWorld(ctx)
    // 世界设置的雾（近 90 远 420）在高空会把画面洗白，背景不需要雾
    scene.fog = null

    const camera = new PerspectiveCamera(FOV, 1, 1, 1000)
    aim(camera, 0, { x: 0, y: 0 })
    // 支持并行编译时着色器在后台编译，主线程少卡一点
    await renderer.compileAsync(scene, camera)
    return { renderer, scene, camera, world, elapsed: 0 }
  } catch (error) {
    world?.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    throw error
  }
}

function destroy(backdrop: Backdrop): void {
  backdrop.world.dispose()
  backdrop.renderer.dispose()
  backdrop.renderer.forceContextLoss()
  backdrop.renderer.domElement.remove()
}

/**
 * 按时间与视差摆放相机。基础取景与旧版静态背景相同：相机在南侧上空偏离正俯视 TILT 度，
 * 画面至少盖住 ±MIN_HALF_WIDTH × ±MIN_HALF_DEPTH，再叠加摆动、平移和推拉。
 */
function aim(camera: PerspectiveCamera, t: number, parallax: PlanarPoint): void {
  const halfHeight = Math.max(MIN_HALF_DEPTH, MIN_HALF_WIDTH / camera.aspect) * COVER_MARGIN
  const distance = (halfHeight / Math.tan(MathUtils.degToRad(FOV / 2))) * (1 + DOLLY * wave(t, DOLLY_PERIOD, 0))
  const tilt = MathUtils.degToRad(TILT + SWAY_TILT * wave(t, SWAY_TILT_PERIOD, 1.3))
  const yaw = MathUtils.degToRad(SWAY_YAW * wave(t, SWAY_YAW_PERIOD, 0.4))
  aimTarget.set(
    TARGET.x + DRIFT_X * wave(t, DRIFT_X_PERIOD, 0) + parallax.x * PARALLAX,
    TARGET.y,
    TARGET.z + DRIFT_Z * wave(t, DRIFT_Z_PERIOD, 2.1) + parallax.y * PARALLAX,
  )
  const horizontal = distance * Math.sin(tilt)
  camera.position.set(
    aimTarget.x + horizontal * Math.sin(yaw),
    aimTarget.y + distance * Math.cos(tilt),
    aimTarget.z + horizontal * Math.cos(yaw),
  )
  camera.far = distance * 3
  camera.updateProjectionMatrix()
  camera.lookAt(aimTarget)
  camera.updateMatrixWorld()
}

function acquire(): Promise<Backdrop> {
  if (!pending) {
    const task = create()
    pending = task
    // 创建失败不留缓存，下次进入菜单可以重试
    task.catch(() => {
      if (pending === task) pending = null
    })
  }
  return pending
}

/**
 * 把实时背景挂到 host 里并开始渲染。首帧画完后才 resolve，调用方可以据此淡入。
 * 用户开启“减少动态效果”时只画静止画面。
 * @param host 背景容器，画布会铺满它
 * @returns 卸载函数：停止渲染并移除画布（实例保留，下次挂载直接复用）
 */
export async function mountTitleBackdrop(host: HTMLElement): Promise<() => void> {
  activeCleanup?.()
  const task = acquire()
  const backdrop = await task
  // 等待期间已被释放
  if (pending !== task) throw new Error('title backdrop disposed')
  activeCleanup?.()

  const { renderer, scene, camera, world } = backdrop
  const canvas = renderer.domElement
  host.appendChild(canvas)

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const pointer: PlanarPoint = { x: 0, y: 0 }
  const parallax: PlanarPoint = { x: 0, y: 0 }

  const draw = (dt: number): void => {
    if (!still) {
      backdrop.elapsed += dt
      const k = 1 - Math.exp(-PARALLAX_SMOOTH * dt)
      parallax.x += (pointer.x - parallax.x) * k
      parallax.y += (pointer.y - parallax.y) * k
      world.update(dt)
    }
    aim(camera, backdrop.elapsed, parallax)
    renderer.toneMappingExposure = EXPOSURE * (1 + PULSE_EXPOSURE * pulse)
    renderer.render(scene, camera)
  }

  const resize = (): void => {
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
  }

  const observer = new ResizeObserver(() => {
    resize()
    if (still) draw(0)
  })
  observer.observe(host)

  const onPointerMove = (event: PointerEvent): void => {
    pointer.x = (event.clientX / Math.max(1, window.innerWidth)) * 2 - 1
    pointer.y = (event.clientY / Math.max(1, window.innerHeight)) * 2 - 1
  }
  if (!still) window.addEventListener('pointermove', onPointerMove, { passive: true })

  let frame = 0
  let last = performance.now()
  const tick = (now: number): void => {
    const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000))
    last = now
    draw(dt)
    frame = requestAnimationFrame(tick)
  }

  resize()
  draw(0)
  if (!still) frame = requestAnimationFrame(tick)

  let released = false
  const cleanup = (): void => {
    if (released) return
    released = true
    if (frame) cancelAnimationFrame(frame)
    observer.disconnect()
    window.removeEventListener('pointermove', onPointerMove)
    canvas.remove()
    if (activeCleanup === cleanup) activeCleanup = null
  }
  activeCleanup = cleanup
  return cleanup
}

/**
 * 设置背景灯光的脉动强度（音乐鉴赏页随节拍调用，离开时置 0）。
 * 开启“减少动态效果”时背景不逐帧重绘，脉动不会生效。
 * @param level 0..1
 */
export function setTitleBackdropPulse(level: number): void {
  pulse = Math.min(1, Math.max(0, level))
}

/** 释放背景的渲染器与场地（进入游戏前调用）；正在挂载的背景会先停止渲染 */
export function disposeTitleBackdrop(): void {
  activeCleanup?.()
  const task = pending
  pending = null
  task?.then(destroy, () => {})
}

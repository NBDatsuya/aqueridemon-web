<template>
  <TresGroup :visible="false" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { HalfFloatType, Mesh, PerspectiveCamera, ShaderMaterial, Texture, WebGLRenderTarget, WebGLRenderer } from 'three'
import type { Material, Scene } from 'three'
import { useLoop, useTresContext } from '@tresjs/core'
import { EVENT_KEYS, useEventBus } from '@/core'
import { useSettingsStore } from '@/hud'
import { gameLoading } from '../core/loading'
import { createRenderPipeline } from '../render/pipeline'
import type { RenderPipeline } from '../render/pipeline'
import { QUALITY_PROFILES, renderState } from '../render/settings'
import { createEngine } from '../systems/engine'
import type { GameEngine } from '../systems/engine'
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR } from './constants'

const tres = useTresContext()
const eventBus = useEventBus()
const settings = useSettingsStore()

// 相机由引擎的玩家系统驱动；这里只负责创建并注册为活动相机（Tres 会随窗口尺寸更新宽高比）
const camera = new PerspectiveCamera(CAMERA_FOV, window.innerWidth / Math.max(1, window.innerHeight), CAMERA_NEAR, CAMERA_FAR)
camera.rotation.order = 'YXZ'
tres.camera.registerCamera(camera, true)

let engine: GameEngine | null = null
let pipeline: RenderPipeline | null = null

/** 把设置页的音量（0..100）同步给引擎 */
function applyVolumes(): void {
  engine?.setVolumes(settings.bgmVolume / 100, settings.sfxVolume / 100, settings.muted)
}

/** 加载遮罩文案 */
const LOADING_LABEL = '正在加载战场…'
/** 预上传贴图时每传这么多张让出一帧，避免长时间无响应 */
const TEXTURES_PER_FRAME = 8

/** 每次开局递增；异步流程在每个 await 之后比对，不一致说明已被新一局或卸载取代 */
let loadToken = 0
let unmounted = false

/** 等一帧（连续两次才能保证遮罩已经上屏） */
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** 收集材质上的全部贴图（各类 map 属性与 ShaderMaterial 的 uniform），跳过渲染目标贴图 */
function collectTextures(material: Material, out: Set<Texture>): void {
  const add = (value: unknown): void => {
    if (value instanceof Texture && value.isRenderTargetTexture !== true) out.add(value)
  }
  // map / normalMap / roughnessMap / metalnessMap / aoMap / emissiveMap / alphaMap / clearcoat* 等都是材质的自有属性
  for (const value of Object.values(material as unknown as Record<string, unknown>)) add(value)
  if (material instanceof ShaderMaterial) {
    for (const uniform of Object.values(material.uniforms)) add((uniform as { value: unknown }).value)
  }
}

/**
 * 预编译场景里全部材质（包括不可见的 Boss、直升机、空投箱）。
 * 渲染管线开后处理时场景画在 HDR 缓冲里，着色器变体（无色调映射、线性输出）与直接画到屏幕不同，
 * 所以编译时临时切到同类型的渲染目标，让编译出的程序与实际渲染一致。
 */
async function compileScene(renderer: WebGLRenderer, scene: Scene): Promise<void> {
  const post = pipeline !== null && QUALITY_PROFILES[renderState.quality].post
  const previousTarget = renderer.getRenderTarget()
  const target = post ? new WebGLRenderTarget(1, 1, { type: HalfFloatType }) : null
  let task: Promise<unknown>
  try {
    renderer.setRenderTarget(target)
    // compileAsync 在调用时同步确定着色器变体，之后只是等待编译完成，所以可以立刻恢复渲染目标
    task = renderer.compileAsync(scene, camera)
  } finally {
    renderer.setRenderTarget(previousTarget)
  }
  try {
    await task
  } finally {
    target?.dispose()
  }
}

/** 提前把场景里全部贴图上传到 GPU，避免物体第一次出现时卡顿 */
async function uploadTextures(renderer: WebGLRenderer, scene: Scene, token: number): Promise<void> {
  const textures = new Set<Texture>()
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const material: Material | Material[] = object.material
    if (Array.isArray(material)) material.forEach((m) => collectTextures(m, textures))
    else collectTextures(material, textures)
  })
  let count = 0
  for (const texture of textures) {
    renderer.initTexture(texture)
    count++
    if (count % TEXTURES_PER_FRAME !== 0) continue
    await nextFrame()
    if (token !== loadToken || unmounted) return
  }
}

/**
 * 创建一局新游戏（先销毁上一局）。整个过程显示加载遮罩：
 * 等遮罩上屏 → 创建渲染管线与引擎 → 预编译着色器 → 预上传贴图 → 渲染一帧 → 撤掉遮罩。
 */
async function startEngine(): Promise<void> {
  const token = ++loadToken
  const stale = (): boolean => token !== loadToken || unmounted
  engine?.dispose()
  engine = null
  gameLoading.label = LOADING_LABEL
  gameLoading.active = true
  try {
    // 先让遮罩真正画出来，再开始同步的重活
    await nextFrame()
    await nextFrame()
    if (stale()) return

    const renderer = tres.renderer.instance
    if (!(renderer instanceof WebGLRenderer)) return
    const scene = tres.scene.value
    if (!pipeline) pipeline = createRenderPipeline(renderer, scene, camera)
    engine = createEngine({
      scene,
      camera,
      renderer,
      dom: renderer.domElement,
    })
    applyVolumes()

    await compileScene(renderer, scene)
    if (stale()) return
    await uploadTextures(renderer, scene, token)
    if (stale()) return
    // 再渲染一帧：编译后处理着色器、阴影深度材质，并把可见物体的状态都走一遍
    pipeline.render(0)
    await nextFrame()
  } finally {
    if (!stale()) gameLoading.active = false
  }
}

const onPause = (): void => engine?.setPaused(true)
const onResume = (): void => engine?.setPaused(false)
const onRestart = (): void => {
  void startEngine()
}

const { onBeforeRender, render } = useLoop()
let frameDelta = 0
onBeforeRender(({ delta }) => {
  frameDelta = delta
  engine?.update(delta)
})

// 接管 Tres 的渲染函数：由渲染管线负责阴影与后处理；管线还没建好时直接渲染
render((notifySuccess) => {
  if (pipeline) {
    pipeline.render(frameDelta)
  } else {
    const renderer = tres.renderer.instance
    if (renderer instanceof WebGLRenderer) renderer.render(tres.scene.value, camera)
  }
  notifySuccess()
})

watch(() => [settings.bgmVolume, settings.sfxVolume, settings.muted], applyVolumes)

onMounted(() => {
  // 渲染管线在 startEngine 里等遮罩上屏后创建（只建一次），之前由渲染函数直接渲染
  void startEngine()
  eventBus.on(EVENT_KEYS.GAME_PAUSE, onPause)
  eventBus.on(EVENT_KEYS.GAME_RESUME, onResume)
  eventBus.on(EVENT_KEYS.GAME_RESTART, onRestart)
})

onUnmounted(() => {
  // 让进行中的加载流程在下一个 await 之后放弃
  unmounted = true
  loadToken++
  gameLoading.active = false
  eventBus.off(EVENT_KEYS.GAME_PAUSE, onPause)
  eventBus.off(EVENT_KEYS.GAME_RESUME, onResume)
  eventBus.off(EVENT_KEYS.GAME_RESTART, onRestart)
  engine?.dispose()
  engine = null
  pipeline?.dispose()
  pipeline = null
  tres.camera.deregisterCamera(camera)
})
</script>

<template>
  <TresGroup :visible="false" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { PerspectiveCamera, WebGLRenderer } from 'three'
import { useLoop, useTresContext } from '@tresjs/core'
import { EVENT_KEYS, useEventBus } from '@/core'
import { useSettingsStore } from '@/hud'
import { createRenderPipeline } from '../render/pipeline'
import type { RenderPipeline } from '../render/pipeline'
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

/** 创建一局新游戏（先销毁上一局） */
function startEngine(): void {
  engine?.dispose()
  engine = null
  const renderer = tres.renderer.instance
  if (!(renderer instanceof WebGLRenderer)) return
  engine = createEngine({
    scene: tres.scene.value,
    camera,
    renderer,
    dom: renderer.domElement,
  })
  applyVolumes()
}

const onPause = (): void => engine?.setPaused(true)
const onResume = (): void => engine?.setPaused(false)
const onRestart = (): void => startEngine()

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
  const renderer = tres.renderer.instance
  if (renderer instanceof WebGLRenderer) pipeline = createRenderPipeline(renderer, tres.scene.value, camera)
  startEngine()
  eventBus.on(EVENT_KEYS.GAME_PAUSE, onPause)
  eventBus.on(EVENT_KEYS.GAME_RESUME, onResume)
  eventBus.on(EVENT_KEYS.GAME_RESTART, onRestart)
})

onUnmounted(() => {
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

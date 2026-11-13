<template>
  <TresGroup :visible="false" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { HalfFloatType, PerspectiveCamera, WebGLRenderTarget, WebGLRenderer } from "three";
import { useLoop, useTresContext } from "@tresjs/core";
import { EVENT_KEYS, beginLoading, endLoading, setLoadingLabel, setLoadingProgress, useEventBus } from "@/core";
import { useSettingsStore } from "@/hud";
import { GAME_LOADING_STAGES, LOADING_LABELS } from "../core/loading";
import { createRenderPipeline } from "../render/pipeline";
import type { RenderPipeline } from "../render/pipeline";
import { QUALITY_PROFILES, renderState } from "../render/settings";
import {
  compileWithProgress,
  nextFrame,
  progressRange,
  uploadTexturesWithProgress,
} from "../render/warmup";
import type { ProgressCallback } from "../render/warmup";
import { createEngine } from "../systems/engine";
import type { GameEngine } from "../systems/engine";
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR } from "./constants";

const tres = useTresContext();
const eventBus = useEventBus();
const settings = useSettingsStore();

// 相机由引擎的玩家系统驱动；这里只负责创建并注册为活动相机（Tres 会随窗口尺寸更新宽高比）
const camera = new PerspectiveCamera(
  CAMERA_FOV,
  window.innerWidth / Math.max(1, window.innerHeight),
  CAMERA_NEAR,
  CAMERA_FAR,
);
camera.rotation.order = "YXZ";
tres.camera.registerCamera(camera, true);

let engine: GameEngine | null = null;
let pipeline: RenderPipeline | null = null;

/** 把设置页的音量（0..100）同步给引擎 */
function applyVolumes(): void {
  engine?.setVolumes(settings.bgmVolume / 100, settings.sfxVolume / 100, settings.muted);
}

/** 每次开局递增；异步流程在每个 await 之后比对，不一致说明已被新一局或卸载取代 */
let loadToken = 0;
let unmounted = false;

/** 写进度与阶段文案：各阶段自己说明在做什么，不用笼统的“加载中” */
const reportLoading: ProgressCallback = (ratio, label) => {
  if (label) setLoadingLabel(label);
  setLoadingProgress(ratio);
};

/**
 * 创建一局新游戏（先销毁上一局）。整个过程显示加载遮罩和进度条：
 * 等遮罩上屏 → 创建渲染管线与引擎（含场地生成）→ 预编译着色器 → 预上传贴图 → 渲染一帧 → 撤掉遮罩。
 * 从菜单进入时遮罩已由路由守卫打开，进度从“游戏代码已下载”接着走；局内重新开始时从同一位置起步。
 */
async function startEngine(): Promise<void> {
  const token = ++loadToken;
  const stale = (): boolean => token !== loadToken || unmounted;
  engine?.dispose();
  engine = null;
  beginLoading(LOADING_LABELS.renderer, GAME_LOADING_STAGES.code);
  try {
    // 先让遮罩真正画出来，再开始同步的重活
    await nextFrame();
    await nextFrame();
    if (stale()) return;

    const renderer = tres.renderer.instance;
    if (!(renderer instanceof WebGLRenderer)) return;
    const scene = tres.scene.value;
    if (!pipeline) pipeline = createRenderPipeline(renderer, scene, camera);
    const created = await createEngine(
      { scene, camera, renderer, dom: renderer.domElement },
      progressRange(reportLoading, GAME_LOADING_STAGES.code, GAME_LOADING_STAGES.engine),
    );
    if (stale()) {
      created.dispose();
      return;
    }
    engine = created;
    applyVolumes();

    // 预编译场景里全部材质（包括不可见的 Boss、直升机、空投箱）。
    // 渲染管线开后处理时场景画在 HDR 缓冲里，着色器变体（无色调映射、线性输出）与直接画到屏幕不同，
    // 所以编译时临时切到同类型的渲染目标，让编译出的程序与实际渲染一致
    const post = QUALITY_PROFILES[renderState.quality].post;
    const target = post ? new WebGLRenderTarget(1, 1, { type: HalfFloatType }) : null;
    try {
      await compileWithProgress(
        renderer,
        scene,
        camera,
        progressRange((ratio) => reportLoading(ratio, LOADING_LABELS.shaders), GAME_LOADING_STAGES.engine, GAME_LOADING_STAGES.shaders),
        stale,
        target,
      );
    } finally {
      target?.dispose();
    }
    if (stale()) return;
    await uploadTexturesWithProgress(
      renderer,
      scene,
      progressRange((ratio) => reportLoading(ratio, LOADING_LABELS.textures), GAME_LOADING_STAGES.shaders, GAME_LOADING_STAGES.textures),
      stale,
    );
    if (stale()) return;
    // 再渲染一帧：编译后处理着色器、阴影深度材质，并把可见物体的状态都走一遍
    reportLoading(GAME_LOADING_STAGES.textures, LOADING_LABELS.firstFrame);
    await nextFrame();
    pipeline.render(0);
    setLoadingProgress(1);
    await nextFrame();
  } finally {
    if (!stale()) endLoading();
  }
}

const onPause = (): void => engine?.setPaused(true);
const onResume = (): void => engine?.setPaused(false);
const onRestart = (): void => {
  void startEngine();
};

const { onBeforeRender, render } = useLoop();
let frameDelta = 0;
onBeforeRender(({ delta }) => {
  frameDelta = delta;
  engine?.update(delta);
});

// 接管 Tres 的渲染函数：由渲染管线负责阴影与后处理；管线还没建好时直接渲染
render((notifySuccess) => {
  if (pipeline) {
    pipeline.render(frameDelta);
  } else {
    const renderer = tres.renderer.instance;
    if (renderer instanceof WebGLRenderer) renderer.render(tres.scene.value, camera);
  }
  notifySuccess();
});

watch(() => [settings.bgmVolume, settings.sfxVolume, settings.muted], applyVolumes);

onMounted(() => {
  // 渲染管线在 startEngine 里等遮罩上屏后创建（只建一次），之前由渲染函数直接渲染
  void startEngine();
  eventBus.on(EVENT_KEYS.GAME_PAUSE, onPause);
  eventBus.on(EVENT_KEYS.GAME_RESUME, onResume);
  eventBus.on(EVENT_KEYS.GAME_RESTART, onRestart);
});

onUnmounted(() => {
  // 让进行中的加载流程在下一个 await 之后放弃
  unmounted = true;
  loadToken++;
  endLoading();
  eventBus.off(EVENT_KEYS.GAME_PAUSE, onPause);
  eventBus.off(EVENT_KEYS.GAME_RESUME, onResume);
  eventBus.off(EVENT_KEYS.GAME_RESTART, onRestart);
  engine?.dispose();
  engine = null;
  pipeline?.dispose();
  pipeline = null;
  tres.camera.deregisterCamera(camera);
});
</script>

/**
 * 渲染管线：实时阴影 + HDR 后处理（环境光遮蔽、泛光、ACES 色调映射）。
 * 接管 TresCanvas 的渲染函数；帧率持续过低时逐级降档，最低档直接渲染到屏幕。
 */

import { ACESFilmicToneMapping, DirectionalLight, HalfFloatType, PCFSoftShadowMap, Vector2, WebGLRenderTarget } from 'three'
import type { Object3D, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import {
  DOWNGRADE_FPS,
  DOWNGRADE_SECONDS,
  QUALITY_PROFILES,
  forcedQuality,
  initialQuality,
  renderState,
} from './settings'
import type { RenderQuality } from './settings'

/** 曝光（ACES 色调映射前的亮度倍率） */
const EXPOSURE = 1
/** 泛光：只让超过 1 的高亮（太阳、枪口火光、Boss 核心）溢出 */
const BLOOM = { strength: 0.32, radius: 0.55, threshold: 1 } as const
/** 环境光遮蔽：半径为世界单位（米） */
const AO = { radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1.1, samples: 12, blend: 0.9 } as const
/** 启动后的这段时间不统计帧率（着色器编译会卡顿） */
const WARMUP_SECONDS = 3
/** 特效根节点的名字：粒子与贴地图形不参与环境光遮蔽 */
const EFFECTS_ROOT = 'effects'

const ORDER: readonly RenderQuality[] = ['high', 'medium', 'low']

/** 计算遮蔽时把半透明特效藏起来，避免粒子周围出现暗边 */
class SceneAoPass extends GTAOPass {
  private readonly hiddenRoots: Object3D[] = []

  overrideVisibility(): void {
    super.overrideVisibility()
    this.hiddenRoots.length = 0
    for (const child of this.scene.children) {
      if (child.name === EFFECTS_ROOT && child.visible) {
        child.visible = false
        this.hiddenRoots.push(child)
      }
    }
  }

  restoreVisibility(): void {
    super.restoreVisibility()
    for (const child of this.hiddenRoots) child.visible = true
    this.hiddenRoots.length = 0
  }
}

export interface RenderPipeline {
  /** 当前画质档位 */
  readonly quality: RenderQuality
  /**
   * 渲染一帧。
   * @param delta 距上一帧的真实秒数，用于帧率统计
   */
  render(delta: number): void
  dispose(): void
}

/**
 * 创建渲染管线，并把渲染器设置为阴影 + ACES 色调映射。
 * @param renderer TresCanvas 的 WebGL 渲染器
 * @param scene 场景
 * @param camera 主相机
 */
export function createRenderPipeline(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): RenderPipeline {
  const forced = forcedQuality()
  let quality: RenderQuality = initialQuality()
  renderState.quality = quality

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = EXPOSURE

  const size = new Vector2()
  let lastWidth = 0
  let lastHeight = 0
  let lastRatio = 0

  let composer: EffectComposer | null = null
  let aoPass: SceneAoPass | null = null

  /** 按需创建后处理链（最低档用不到） */
  const ensureComposer = (): EffectComposer => {
    if (composer) return composer
    const profile = QUALITY_PROFILES[quality]
    renderer.getSize(size)
    const ratio = renderer.getPixelRatio()
    const target = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
      type: HalfFloatType,
      samples: profile.samples,
    })
    const created = new EffectComposer(renderer, target)
    created.addPass(new RenderPass(scene, camera))

    aoPass = new SceneAoPass(scene, camera, size.x, size.y)
    aoPass.updateGtaoMaterial({
      radius: AO.radius,
      distanceExponent: AO.distanceExponent,
      thickness: AO.thickness,
      scale: AO.scale,
      samples: AO.samples,
      screenSpaceRadius: false,
    })
    aoPass.blendIntensity = AO.blend
    aoPass.enabled = profile.ao
    created.addPass(aoPass)

    created.addPass(new UnrealBloomPass(new Vector2(size.x, size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold))
    created.addPass(new OutputPass())
    composer = created
    // 强制下一帧同步尺寸
    lastWidth = 0
    return created
  }

  /** 画布尺寸或像素比变化时同步后处理缓冲 */
  const syncSize = (target: EffectComposer): void => {
    renderer.getSize(size)
    const ratio = renderer.getPixelRatio()
    if (size.x === lastWidth && size.y === lastHeight && ratio === lastRatio) return
    lastWidth = size.x
    lastHeight = size.y
    lastRatio = ratio
    target.setPixelRatio(ratio)
    target.setSize(size.x, size.y)
  }

  /** 把阴影贴图尺寸应用到场景里投影的方向光（只在换档时调用） */
  const applyShadowSize = (): void => {
    const mapSize = QUALITY_PROFILES[quality].shadowMapSize
    scene.traverse((object) => {
      if (!(object instanceof DirectionalLight) || !object.castShadow) return
      if (object.shadow.mapSize.x === mapSize) return
      object.shadow.mapSize.set(mapSize, mapSize)
      object.shadow.map?.dispose()
      object.shadow.map = null
    })
  }

  const setQuality = (next: RenderQuality): void => {
    quality = next
    renderState.quality = next
    if (aoPass) aoPass.enabled = QUALITY_PROFILES[next].ao
    applyShadowSize()
  }

  let uptime = 0
  let slowFor = 0

  /** 帧率持续过低时降一档（地址参数固定了档位则不降） */
  const trackFrameRate = (delta: number): void => {
    if (forced || quality === 'low') return
    // 切走标签页后的超长帧不算
    if (delta <= 0 || delta > 0.5) return
    uptime += delta
    if (uptime < WARMUP_SECONDS) return
    if (delta > 1 / DOWNGRADE_FPS) slowFor += delta
    else slowFor = Math.max(0, slowFor - delta * 2)
    if (slowFor < DOWNGRADE_SECONDS) return
    slowFor = 0
    const index = ORDER.indexOf(quality)
    const next = ORDER[index + 1]
    if (next) setQuality(next)
  }

  return {
    get quality(): RenderQuality {
      return quality
    },

    render(delta: number): void {
      trackFrameRate(delta)
      if (!QUALITY_PROFILES[quality].post) {
        renderer.render(scene, camera)
        return
      }
      const target = ensureComposer()
      syncSize(target)
      target.render(delta)
    },

    dispose(): void {
      if (!composer) return
      composer.passes.forEach((pass) => pass.dispose())
      composer.renderTarget1.dispose()
      composer.renderTarget2.dispose()
      composer.dispose()
      composer = null
      aoPass = null
    },
  }
}

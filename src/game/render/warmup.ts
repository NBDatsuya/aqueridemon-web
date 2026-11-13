/**
 * 渲染预热：预编译场景全部着色器、预上传全部贴图，并按实际完成数量回报进度。
 * 标题背景与游戏开局共用，避免物体第一次出现时卡顿。
 */

import { Mesh, ShaderMaterial, Texture } from 'three'
import type { Camera, Material, Object3D, WebGLRenderTarget, WebGLRenderer } from 'three'

/** 进度回调：0..1，可选带上该阶段的说明文案 */
export type ProgressCallback = (ratio: number, label?: string) => void

/** 返回 true 表示流程已被取代（新一局或卸载），应尽快放弃 */
export type StaleCheck = () => boolean

/** 预上传贴图时每传这么多张让出一帧，进度条才能刷新 */
const TEXTURES_PER_FRAME = 8

/** 等一帧 */
export const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * 按时间预算让出主线程：距上次让出不足 budget 毫秒就直接返回。
 * 预算取 64 毫秒（约每秒 15 次刷新）：进度条看着是连续走的，
 * 又不会因为每小步都等一帧把总耗时拖长（每次让出平均要花半帧）。
 * @param budget 毫秒
 */
export function frameBudget(budget = 64): () => Promise<void> {
  let last = 0
  return async () => {
    const now = performance.now()
    if (last !== 0 && now - last < budget) return
    last = now
    await nextFrame()
  }
}

/** WebGLProgram 上用到的部分（类型声明里没有 isReady） */
interface ProgramLike {
  isReady(): boolean
}

function isProgramLike(value: unknown): value is ProgramLike {
  return typeof value === 'object' && value !== null && typeof (value as { isReady?: unknown }).isReady === 'function'
}

/** 材质的着色器程序是否已链接完成；没有程序（不需要编译）视为完成 */
function programReady(renderer: WebGLRenderer, material: Material): boolean {
  const props = renderer.properties.get(material)
  if (typeof props !== 'object' || props === null) return true
  const program = (props as { currentProgram?: unknown }).currentProgram
  return !isProgramLike(program) || program.isReady()
}

/**
 * 编译场景里全部材质（包括不可见的物体），每帧检查链接状态并回报进度。
 * 支持 KHR_parallel_shader_compile 时着色器在后台编译，进度随完成数增长；
 * 不支持时 compile 本身同步完成，进度直接到 1。
 * @param target 编译时使用的渲染目标：渲染管线开后处理时场景画进 HDR 缓冲，着色器变体与直接画到屏幕不同
 */
export async function compileWithProgress(
  renderer: WebGLRenderer,
  scene: Object3D,
  camera: Camera,
  onProgress: ProgressCallback,
  stale: StaleCheck,
  target: WebGLRenderTarget | null = null,
): Promise<void> {
  const previousTarget = renderer.getRenderTarget()
  let materials: Set<Material>
  try {
    renderer.setRenderTarget(target)
    // compile 在调用时同步确定着色器变体并提交编译，之后只需等待链接完成，所以可以立刻恢复渲染目标
    materials = renderer.compile(scene, camera)
  } finally {
    renderer.setRenderTarget(previousTarget)
  }
  const total = materials.size
  if (total === 0) {
    onProgress(1)
    return
  }
  const pending = new Set(materials)
  for (;;) {
    for (const material of pending) if (programReady(renderer, material)) pending.delete(material)
    onProgress((total - pending.size) / total)
    if (pending.size === 0 || stale()) return
    await nextFrame()
    if (stale()) return
  }
}

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

/** 提前把场景里全部贴图上传到 GPU，按已上传数量回报进度 */
export async function uploadTexturesWithProgress(
  renderer: WebGLRenderer,
  scene: Object3D,
  onProgress: ProgressCallback,
  stale: StaleCheck,
): Promise<void> {
  const textures = new Set<Texture>()
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const material: Material | Material[] = object.material
    if (Array.isArray(material)) material.forEach((m) => collectTextures(m, textures))
    else collectTextures(material, textures)
  })
  const total = textures.size
  let count = 0
  for (const texture of textures) {
    renderer.initTexture(texture)
    count++
    if (count % TEXTURES_PER_FRAME !== 0) continue
    onProgress(count / total)
    await nextFrame()
    if (stale()) return
  }
  onProgress(1)
}

/**
 * 把子阶段的 0..1 进度映射到总进度的 [from, to] 区间。
 * @param report 总进度回调
 */
export function progressRange(report: ProgressCallback, from: number, to: number): ProgressCallback {
  return (ratio, label) => report(from + (to - from) * Math.min(1, Math.max(0, ratio)), label);
}

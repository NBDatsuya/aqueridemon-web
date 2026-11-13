/**
 * 全部视觉特效：粒子、枪口火光、曳光、贴花、毒液池、冲击波环、地面预警、光柱、烟柱、下洗气流与屏幕震动。
 *
 * 设计要点：
 * - 对象全部在创建时放进池里，运行期只改缓冲区与 uniform，update 不产生垃圾。
 * - 粒子按混合模式分成两个定长的实例化公告板池（普通 420 + 加色 180，合计 600），各一次绘制调用。
 * - 曳光、贴花各用一个实例化网格；枪口火光是 Sprite 池；毒池 / 波环 / 预警 / 光柱是带独立 uniform 的网格池，不够时才扩容。
 * - 贴图用 Canvas 2D 现画；血迹贴花复用纹理生成器的 'blood'。
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three'
import type { Blending, IUniform, Texture } from 'three'
import type { BurstKind, EffectHandle, EffectsSystem, GameContext, ImpactKind } from '../core/types'
import { getTexture } from '../generators/textures'
import { clamp, smoothstep } from '../utils/math'
import { getNoise } from '../utils/noise'
import { createRng } from '../utils/random'

/* ── 容量与时长 ── */

/** 普通混合粒子上限（尘土、烟、血、粘液） */
const NORMAL_PARTICLES = 420
/** 加色混合粒子上限（火花、光点）。两池合计 600 */
const ADDITIVE_PARTICLES = 180
const MUZZLE_POOL = 10
const TRACER_POOL = 16
/** 弹孔与血迹合计上限 */
const DECAL_LIMIT = 50

const MUZZLE_LIFE = 0.1
/** 枪口火光基础直径（米） */
const MUZZLE_SIZE = 0.42
const TRACER_LIFE = 0.06
/** 曳光刚生成的标记：首次 update 不计时，保证至少完整显示一帧 */
const TRACER_FRESH = -1
const HOLE_LIFE = 14
const BLOOD_LIFE = 24
/** 贴花寿命末尾的淡出时长 */
const DECAL_FADE = 2.5

/** 毒池摊开、淡出的时长 */
const POOL_GROW = 0.35
const POOL_FADE = 0.6
/** 着色器里毒池轮廓的平均半径是 0.84，网格按此放大，让视觉半径与判定半径一致 */
const POOL_VISUAL_SCALE = 1 / 0.84
/** 每个毒池每秒冒出的雾气粒子数（寿命最长 1.9 秒，同时存在不超过 18 个） */
const POOL_FOG_RATE = 9

/** 一圈冲击波沿途扬起的尘土粒子总数 */
const RING_DUST_TOTAL = 56
const RING_COLOR = 0xffe0b0
const TELEGRAPH_COLOR = 0xff2a1f
/** 预警到时后的收尾淡出 */
const TELEGRAPH_OUT = 0.12

const BEAM_HEIGHT = 40
const BEAM_RADIUS = 0.45
const BEAM_ALPHA = 0.5
const BEAM_FADE_IN = 0.35
const BEAM_FADE_OUT = 0.4
/** 每根光柱每秒升起的光点数 */
const BEAM_MOTE_RATE = 5
/** 每根烟柱每秒冒出的烟团数 */
const SMOKE_RATE = 11

/** 下洗气流满强度时每秒的尘土 / 草屑粒子数 */
const WASH_DUST_RATE = 26
const WASH_GRASS_RATE = 40
const WASH_INNER = 1.5
const WASH_OUTER = 6.5
/** 下洗气流始终贴着球场地面 */
const WASH_GROUND_Y = 0

/** 震动偏移上限（米），防止相机被甩进墙里 */
const SHAKE_MAX = 0.6
/** 震动噪声的采样频率（Hz） */
const SHAKE_FREQUENCY = 26

/** 带 floor 标记的粒子落到该高度后停住 */
const FLOOR_Y = 0.03
const BURST_MAX = 80
const TAU = Math.PI * 2

/** 半透明对象的绘制次序：贴地图形在前，粒子与发光体在后 */
const ORDER = { decal: 1, pool: 2, telegraph: 3, ring: 4, beam: 5, particle: 6, glow: 7, tracer: 8, muzzle: 9 } as const

/* ── Canvas 贴图 ── */

const ATLAS_CELL = 64
/** 粒子图集的四个格子 */
const FRAME_SOFT = 0
const FRAME_PUFF = 1
const FRAME_CHIP = 2
const FRAME_SPARK = 3

function createCanvas(size: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')
  if (!g) throw new Error('无法创建 Canvas 2D 上下文')
  return g
}

function toTexture(g: CanvasRenderingContext2D): CanvasTexture {
  const texture = new CanvasTexture(g.canvas)
  texture.colorSpace = SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  return texture
}

/** 画一个白色径向渐变光斑 */
function softDot(g: CanvasRenderingContext2D, x: number, y: number, radius: number, alpha: number): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, radius)
  grad.addColorStop(0, `rgba(255,255,255,${alpha})`)
  grad.addColorStop(0.4, `rgba(255,255,255,${alpha * 0.5})`)
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(x, y, radius, 0, TAU)
  g.fill()
}

/** 粒子图集 2×2：柔光斑 / 烟团 / 碎屑 / 火花。全部画成白色，颜色由粒子顶点色决定 */
function drawParticleAtlas(): CanvasTexture {
  const g = createCanvas(ATLAS_CELL * 2)
  const rng = createRng(0x5eed01)
  const half = ATLAS_CELL / 2

  // 0：柔光斑
  softDot(g, half, half, half - 2, 1)

  // 1：烟团，多个半透明圆叠出凹凸的轮廓
  const puffX = ATLAS_CELL + half
  for (let i = 0; i < 9; i++) {
    const angle = rng.range(0, TAU)
    const dist = rng.range(0, 11)
    softDot(g, puffX + Math.cos(angle) * dist, half + Math.sin(angle) * dist, rng.range(12, 18), 0.42)
  }

  // 2：碎屑，硬边的不规则多边形
  const chipY = ATLAS_CELL + half
  const shade = g.createLinearGradient(half - 22, chipY - 22, half + 22, chipY + 22)
  shade.addColorStop(0, 'rgba(255,255,255,1)')
  shade.addColorStop(1, 'rgba(170,170,170,1)')
  g.fillStyle = shade
  g.beginPath()
  const corners = 6
  for (let i = 0; i < corners; i++) {
    const angle = ((i + rng.range(-0.3, 0.3)) / corners) * TAU
    const radius = rng.range(13, 24)
    const x = half + Math.cos(angle) * radius
    const y = chipY + Math.sin(angle) * radius
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
  g.fill()

  // 3：火花，亮核加十字光芒
  const sparkX = ATLAS_CELL + half
  const sparkY = ATLAS_CELL + half
  g.globalCompositeOperation = 'lighter'
  softDot(g, sparkX, sparkY, 11, 1)
  g.save()
  g.translate(sparkX, sparkY)
  g.scale(1, 0.14)
  softDot(g, 0, 0, 28, 0.9)
  g.restore()
  g.save()
  g.translate(sparkX, sparkY)
  g.scale(0.14, 1)
  softDot(g, 0, 0, 28, 0.9)
  g.restore()

  return toTexture(g)
}

/** 枪口火光：放射状火舌 + 黄白渐变的核心 */
function drawMuzzleTexture(): CanvasTexture {
  const size = 128
  const g = createCanvas(size)
  const rng = createRng(0x5eed02)
  const c = size / 2
  g.globalCompositeOperation = 'lighter'

  const spikes = 7
  for (let i = 0; i < spikes; i++) {
    const angle = (i / spikes) * TAU + rng.range(-0.25, 0.25)
    const length = rng.range(0.55, 0.95) * (c - 4)
    const width = rng.range(5, 10)
    g.save()
    g.translate(c, c)
    g.rotate(angle)
    const flame = g.createLinearGradient(0, 0, length, 0)
    flame.addColorStop(0, 'rgba(255,240,190,0.9)')
    flame.addColorStop(0.5, 'rgba(255,180,70,0.5)')
    flame.addColorStop(1, 'rgba(255,110,20,0)')
    g.fillStyle = flame
    g.beginPath()
    g.moveTo(0, -width)
    g.lineTo(length, 0)
    g.lineTo(0, width)
    g.closePath()
    g.fill()
    g.restore()
  }

  const coreRadius = c * 0.62
  const core = g.createRadialGradient(c, c, 0, c, c, coreRadius)
  core.addColorStop(0, 'rgba(255,255,255,1)')
  core.addColorStop(0.3, 'rgba(255,238,170,0.9)')
  core.addColorStop(0.65, 'rgba(255,170,60,0.35)')
  core.addColorStop(1, 'rgba(255,120,20,0)')
  g.fillStyle = core
  g.beginPath()
  g.arc(c, c, coreRadius, 0, TAU)
  g.fill()

  return toTexture(g)
}

/** 弹孔：焦黑外圈 + 崩裂碎点 + 不规则的孔洞 */
function drawBulletHoleTexture(): CanvasTexture {
  const size = 64
  const g = createCanvas(size)
  const rng = createRng(0x5eed03)
  const c = size / 2

  const scorch = g.createRadialGradient(c, c, 4, c, c, c - 2)
  scorch.addColorStop(0, 'rgba(30,26,22,0.85)')
  scorch.addColorStop(0.55, 'rgba(45,40,34,0.45)')
  scorch.addColorStop(1, 'rgba(45,40,34,0)')
  g.fillStyle = scorch
  g.beginPath()
  g.arc(c, c, c - 2, 0, TAU)
  g.fill()

  g.fillStyle = 'rgba(20,18,16,0.7)'
  for (let i = 0; i < 14; i++) {
    const angle = rng.range(0, TAU)
    const dist = rng.range(9, 22)
    g.beginPath()
    g.arc(c + Math.cos(angle) * dist, c + Math.sin(angle) * dist, rng.range(0.8, 2.2), 0, TAU)
    g.fill()
  }

  g.fillStyle = 'rgba(6,6,6,0.96)'
  g.beginPath()
  const corners = 9
  for (let i = 0; i < corners; i++) {
    const angle = (i / corners) * TAU
    const radius = rng.range(7.5, 11)
    const x = c + Math.cos(angle) * radius
    const y = c + Math.sin(angle) * radius
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
  g.fill()

  return toTexture(g)
}

/* ── 着色器 ── */

/** 片元着色器结尾：与场景其余材质一致的色调映射与输出色彩空间转换 */
const OUTPUT_CHUNK = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`

/** 加色混合不能往雾色上混（会越雾越亮），改为按雾浓度降低透明度 */
const FOG_FADE_CHUNK = /* glsl */ `
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.a *= 1.0 - fogFactor;
  #endif`

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aColor;
attribute vec4 aParams;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>

void main() {
  // aParams：x 直径（米），y 自转角，z 图集帧
  float c = cos(aParams.y);
  float s = sin(aParams.y);
  vec2 corner = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aParams.x;
  vec4 mvPosition = modelViewMatrix * vec4(aOffset, 1.0);
  mvPosition.xy += corner;
  gl_Position = projectionMatrix * mvPosition;

  // 画布第 0 行在贴图上方（flipY），格内略微内缩避免相邻格渗色
  vec2 cell = vec2(mod(aParams.z, 2.0), 1.0 - floor(aParams.z * 0.5));
  vUv = (cell + uv * 0.94 + 0.03) * 0.5;
  vColor = aColor;
  #include <fog_vertex>
}
`

function particleFragment(additive: boolean): string {
  return /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>

void main() {
  vec4 tex = texture2D(uMap, vUv);
  gl_FragColor = vec4(vColor.rgb * tex.rgb, vColor.a * tex.a);
  if (gl_FragColor.a < 0.004) discard;
${OUTPUT_CHUNK}
${additive ? FOG_FADE_CHUNK : '  #include <fog_fragment>'}
}
`
}

const TRACER_VERT = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute float aAge;
varying vec2 vUv;
varying float vFade;

void main() {
  // aAge：0..1 的寿命进度，>= 1 表示空闲槽位
  float live = step(aAge, 0.999);
  // 尾端随时间向前收拢，产生飞行感
  vec3 tail = mix(aStart, aEnd, clamp(aAge, 0.0, 1.0) * 0.65);
  vec3 a = (modelViewMatrix * vec4(tail, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(aEnd, 1.0)).xyz;
  vec3 p = mix(a, b, position.x);
  // 垂直于线段与视线的方向：让四边形始终正对相机
  vec3 side = cross(b - a, p);
  float len = length(side);
  side = len > 1e-6 ? side / len : vec3(1.0, 0.0, 0.0);
  // 远处加宽，保证至少约两个像素
  float width = max(0.028, -p.z * 0.0032) * live;
  p += side * position.y * width;
  gl_Position = projectionMatrix * vec4(p, 1.0);
  vUv = vec2(position.x, position.y + 0.5);
  vFade = (1.0 - aAge) * live;
}
`

const TRACER_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
varying float vFade;

void main() {
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  // 弹头一端更亮
  float along = 0.2 + 0.8 * vUv.x * vUv.x;
  vec3 color = mix(uColor, vec3(1.0), across * 0.6);
  gl_FragColor = vec4(color, across * across * along * vFade);
${OUTPUT_CHUNK}
}
`

const DECAL_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aNormal;
attribute vec4 aParams;
varying vec2 vUv;
varying float vAlpha;
varying float vKind;
#include <fog_pars_vertex>

void main() {
  // aParams：x 边长（米），y 面内旋转，z 透明度，w 种类（0 弹孔 / 1 血迹）
  vec3 n = normalize(aNormal);
  vec3 axis = abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tangent = normalize(cross(axis, n));
  vec3 bitangent = cross(n, tangent);
  float c = cos(aParams.y);
  float s = sin(aParams.y);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aParams.x;
  // 沿法线抬起一点，避免与表面深度冲突
  vec3 world = aCenter + n * 0.012 + tangent * q.x + bitangent * q.y;
  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  vAlpha = aParams.z;
  vKind = aParams.w;
  #include <fog_vertex>
}
`

const DECAL_FRAG = /* glsl */ `
uniform sampler2D uHole;
uniform sampler2D uBlood;
varying vec2 vUv;
varying float vAlpha;
varying float vKind;
#include <fog_pars_fragment>

void main() {
  vec4 hole = texture2D(uHole, vUv);
  vec4 blood = texture2D(uBlood, vUv);
  // 血迹再做一次圆形羽化：即使贴图不透明或铺满整张，也不会露出方形硬边
  float d = length(vUv - 0.5) * 2.0;
  blood.a *= 1.0 - smoothstep(0.72, 1.0, d);
  vec4 tex = mix(hole, blood, step(0.5, vKind));
  gl_FragColor = vec4(tex.rgb, tex.a * vAlpha);
  if (gl_FragColor.a < 0.004) discard;
${OUTPUT_CHUNK}
  #include <fog_fragment>
}
`

/** 贴地图形共用的顶点着色器：vPos 为本地 XZ 坐标（-1..1） */
const GROUND_VERT = /* glsl */ `
varying vec2 vPos;

void main() {
  vPos = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const POISON_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform float uSeed;
varying vec2 vPos;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * valueNoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return sum / 0.875;
}

void main() {
  float d = length(vPos);
  vec2 seed = vec2(uSeed, uSeed * 1.7);
  // 不规则轮廓：半径随噪声起伏，sd 是到轮廓的距离场（内正外负）
  float rim = 0.84 + (fbm(vPos * 1.6 + seed) - 0.5) * 0.26;
  float sd = rim - d;
  float body = smoothstep(0.0, 0.05, sd);

  // 噪声扭曲 + UV 滚动
  vec2 warp = vec2(
    fbm(vPos * 2.4 + seed + vec2(uTime * 0.21, 0.0)),
    fbm(vPos * 2.4 - seed + vec2(0.0, uTime * 0.17))
  ) - 0.5;
  vec2 flowUv = vPos * 3.2 + warp * 1.5 + vec2(uTime * 0.13, -uTime * 0.09) + seed;
  float n = fbm(flowUv);
  vec3 color = mix(vec3(0.03, 0.2, 0.03), vec3(0.4, 0.95, 0.12), smoothstep(0.32, 0.72, n));

  // 鼓起又破裂的气泡亮点
  float bubbles = smoothstep(0.74, 0.8, valueNoise(flowUv * 2.6 + uTime * 0.4));
  color += vec3(0.25, 0.3, 0.1) * bubbles;

  // 边缘泡沫：距离场贴近 0 的一圈，用噪声打碎
  float foam = (1.0 - smoothstep(0.02, 0.15, sd)) * body;
  foam *= 0.55 + 0.45 * valueNoise(vPos * 14.0 + seed + uTime * 0.6);
  color = mix(color, vec3(0.78, 1.0, 0.6), foam * 0.85);

  float alpha = max(body * (0.5 + 0.28 * n), foam * 0.9) * uAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
${OUTPUT_CHUNK}
}
`

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uRadius;
uniform float uWidth;
uniform float uAlpha;
varying vec2 vPos;

void main() {
  // uRadius / uWidth 已按网格尺寸归一化
  float d = length(vPos);
  // 前沿锐利、后侧拖尾
  float front = 1.0 - smoothstep(uRadius, uRadius + uWidth * 0.12, d);
  float tail = smoothstep(uRadius - uWidth, uRadius, d);
  float band = front * tail * tail;
  // 环内残留的淡淡余波
  float wake = 0.07 * front * smoothstep(uRadius * 0.35, uRadius, d);
  float alpha = (band + wake) * uAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
${OUTPUT_CHUNK}
}
`

const TELEGRAPH_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uShape;
uniform float uHalfArc;
uniform vec2 uSize;
uniform float uProgress;
uniform float uAlpha;
varying vec2 vPos;

void main() {
  // uShape：0 圆 / 1 扇形 / 2 条带；uSize：本地单位对应的世界半尺寸（米）
  float d = length(vPos);
  // border：到图形边界的世界距离（米），外侧为负；reach：填充推进坐标 0..1
  float border;
  float reach;
  if (uShape < 0.5) {
    border = (1.0 - d) * uSize.x;
    reach = d;
  } else if (uShape < 1.5) {
    // 本地 +Z 为扇形中线
    float ang = abs(atan(vPos.x, vPos.y + 1e-6));
    float flank = d * sin(clamp(uHalfArc - ang, -1.5708, 1.5708)) * uSize.x;
    border = min((1.0 - d) * uSize.x, flank);
    reach = d;
  } else {
    border = min((1.0 - abs(vPos.x)) * uSize.x, (1.0 - abs(vPos.y)) * uSize.y);
    reach = vPos.y * 0.5 + 0.5;
  }
  float inside = smoothstep(0.0, 0.04, border);
  float outline = 1.0 - smoothstep(0.06, 0.2, border);
  // 已填充区域随进度向外（或沿条带）推进，前沿带一道亮边
  float filled = 1.0 - smoothstep(uProgress - 0.02, uProgress + 0.001, reach);
  float front = smoothstep(uProgress - 0.14, uProgress, reach) * filled;
  float alpha = 0.1 + 0.16 * uProgress + filled * (0.2 + 0.22 * uProgress) + front * 0.25 + outline * 0.55;
  alpha = min(alpha, 0.92) * inside * uAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor * (1.0 + outline * 0.35 + front * 0.25), alpha);
${OUTPUT_CHUNK}
}
`

const BEAM_VERT = /* glsl */ `
varying float vHeight;
varying vec3 vNormalView;
varying vec3 vViewPosition;

void main() {
  vHeight = position.y;
  vNormalView = normalMatrix * normal;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
varying float vHeight;
varying vec3 vNormalView;
varying vec3 vViewPosition;

void main() {
  // 正对视线的部分最亮，轮廓边缘柔和消隐
  float facing = abs(dot(normalize(vNormalView), normalize(-vViewPosition)));
  float soft = pow(facing, 1.5);
  // 上端渐隐
  float fade = pow(1.0 - clamp(vHeight, 0.0, 1.0), 1.6);
  float pulse = 0.84 + 0.16 * sin(uTime * 3.1);
  // 向上流动的细纹
  float flow = 0.86 + 0.14 * sin(vHeight * 46.0 - uTime * 5.5);
  gl_FragColor = vec4(uColor, soft * fade * pulse * flow * uAlpha);
${OUTPUT_CHUNK}
}
`

/* ── 几何与材质工具 ── */

/** 往几何体里写一个 XY 平面上的四边形（含 uv 与索引） */
function setQuad(geometry: BufferGeometry, x0: number, y0: number, x1: number, y1: number): void {
  geometry.setAttribute('position', new Float32BufferAttribute([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], 3))
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
}

/** 贴地单位四边形：XZ 平面上 -1..1，正面朝上 */
function createGroundQuad(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([-1, 0, -1, -1, 0, 1, 1, 0, 1, 1, 0, -1], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  return geometry
}

/** 场景雾 uniform：material.fog 为 true 时由渲染器每帧写入 */
function fogUniforms(): Record<string, IUniform> {
  return {
    fogColor: { value: new Color(0xffffff) },
    fogNear: { value: 1 },
    fogFar: { value: 2000 },
    fogDensity: { value: 0.00025 },
  }
}

/** 贴地图形材质：半透明、不写深度，并用多边形偏移压住地面 */
function groundMaterial(fragmentShader: string, uniforms: Record<string, IUniform>, blending: Blending): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: GROUND_VERT,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
}

/** 取一个空闲槽位；全部占用时扩容 */
function acquire<T extends { active: boolean }>(slots: T[], create: () => T): T {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as T
    if (!slot.active) return slot
  }
  const slot = create()
  slots.push(slot)
  return slot
}

/* ── 粒子 ── */

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  age: number
  life: number
  /** 起始 / 结束直径（米） */
  size0: number
  size1: number
  r: number
  g: number
  b: number
  alpha: number
  /** 淡入占寿命的比例 */
  fadeIn: number
  /** 淡出曲线指数：透明度 ×(1 - t^fadePow) */
  fadePow: number
  /** 竖直加速度（负 = 下落，正 = 上飘） */
  gravity: number
  drag: number
  rot: number
  spin: number
  frame: number
  /** 落到地面后停住 */
  floor: boolean
}

interface ParticleStyle {
  readonly additive: boolean
  readonly frame: number
  readonly lifeMin: number
  readonly lifeMax: number
  /** 起始直径范围（米） */
  readonly sizeMin: number
  readonly sizeMax: number
  /** 结束直径 = 起始直径 × grow */
  readonly grow: number
  readonly alpha: number
  readonly fadeIn: number
  readonly fadePow: number
  readonly gravity: number
  readonly drag: number
  /** 自转角速度上限（弧度 / 秒） */
  readonly spin: number
  readonly floor: boolean
  /** 颜色在 from 与 to 之间随机取 */
  readonly from: Color
  readonly to: Color
}

interface StyleOptions {
  life: readonly [number, number]
  size: readonly [number, number]
  additive?: boolean
  frame?: number
  grow?: number
  alpha?: number
  fadeIn?: number
  fadePow?: number
  gravity?: number
  drag?: number
  spin?: number
  floor?: boolean
}

function defineStyle(colorA: number, colorB: number, o: StyleOptions): ParticleStyle {
  return {
    additive: o.additive ?? false,
    frame: o.frame ?? FRAME_SOFT,
    lifeMin: o.life[0],
    lifeMax: o.life[1],
    sizeMin: o.size[0],
    sizeMax: o.size[1],
    grow: o.grow ?? 1,
    alpha: o.alpha ?? 1,
    fadeIn: o.fadeIn ?? 0,
    fadePow: o.fadePow ?? 2,
    gravity: o.gravity ?? 0,
    drag: o.drag ?? 0,
    spin: o.spin ?? 0,
    floor: o.floor ?? false,
    from: new Color(colorA),
    to: new Color(colorB),
  }
}

/** 命中墙体 / 地面崩出的碎屑 */
const CHIP = defineStyle(0x8a8272, 0x5c564b, {
  frame: FRAME_CHIP, life: [0.35, 0.7], size: [0.03, 0.07], grow: 0.8, gravity: -14, drag: 0.6, spin: 12, floor: true, fadePow: 3,
})
/** 命中点的小团扬尘 */
const DUST_PUFF = defineStyle(0xa89f8c, 0x7d7566, {
  frame: FRAME_PUFF, life: [0.4, 0.7], size: [0.12, 0.2], grow: 3.2, alpha: 0.4, gravity: 0.3, drag: 2.5, spin: 1, fadePow: 1,
})
const DUST = defineStyle(0xb5a98a, 0x857a62, {
  frame: FRAME_PUFF, life: [0.8, 1.5], size: [0.45, 0.8], grow: 2.6, alpha: 0.42, gravity: 0.4, drag: 1.8, spin: 0.8, fadeIn: 0.08, fadePow: 1,
})
const BLOOD_DROP = defineStyle(0x8a0b0b, 0x4d0404, {
  life: [0.35, 0.65], size: [0.05, 0.1], grow: 0.7, alpha: 0.95, gravity: -12, drag: 0.8, floor: true,
})
const BLOOD_MIST = defineStyle(0x9c1414, 0x5e0808, {
  frame: FRAME_PUFF, life: [0.3, 0.55], size: [0.18, 0.3], grow: 2.6, alpha: 0.5, gravity: -0.6, drag: 3, fadePow: 1,
})
/** Boss 粘液：紫与绿之间随机 */
const GOO_DROP = defineStyle(0x7a2fb0, 0x66c21e, {
  life: [0.4, 0.75], size: [0.07, 0.13], grow: 0.7, alpha: 0.95, gravity: -11, drag: 0.8, floor: true,
})
const GOO_MIST = defineStyle(0x5d2a8a, 0x4f9a1c, {
  frame: FRAME_PUFF, life: [0.35, 0.6], size: [0.2, 0.34], grow: 2.4, alpha: 0.45, gravity: -0.4, drag: 3, fadePow: 1,
})
const SPARK = defineStyle(0xffb347, 0xff6a12, {
  additive: true, frame: FRAME_SPARK, life: [0.25, 0.6], size: [0.08, 0.16], grow: 0.35, gravity: -9, drag: 1.2,
})
/** 弱点命中瞬间的一团橙光 */
const FLASH = defineStyle(0xffd27a, 0xff8a2a, {
  additive: true, life: [0.1, 0.16], size: [0.45, 0.7], grow: 0.4, alpha: 0.9,
})
const SMOKE_GREY = defineStyle(0x8c8c8c, 0x5f5f5f, {
  frame: FRAME_PUFF, life: [1.6, 2.6], size: [0.5, 0.8], grow: 3.2, alpha: 0.5, gravity: 0.9, drag: 1.2, spin: 0.6, fadeIn: 0.12, fadePow: 1,
})
const SMOKE_RED = defineStyle(0xd2362c, 0x8f1d18, {
  frame: FRAME_PUFF, life: [1.6, 2.6], size: [0.5, 0.8], grow: 3.2, alpha: 0.5, gravity: 0.9, drag: 1.2, spin: 0.6, fadeIn: 0.12, fadePow: 1,
})
const POISON_MIST = defineStyle(0x6fd42a, 0x2f7d12, {
  frame: FRAME_PUFF, life: [1, 1.8], size: [0.4, 0.7], grow: 2.4, alpha: 0.4, gravity: 0.5, drag: 1.5, spin: 0.6, fadeIn: 0.15, fadePow: 1,
})
const POISON_DROP = defineStyle(0x9be33a, 0x4fa018, {
  life: [0.5, 0.9], size: [0.07, 0.13], grow: 0.6, alpha: 0.9, gravity: -10, drag: 0.6, floor: true,
})
/** 毒池上方的雾气 */
const POOL_FOG = defineStyle(0x7fd43a, 0x3f8f1c, {
  frame: FRAME_PUFF, life: [1.3, 1.9], size: [0.5, 0.8], grow: 2, alpha: 0.28, gravity: 0.35, drag: 0.8, spin: 0.4, fadeIn: 0.25, fadePow: 1,
})
const GLOW = defineStyle(0xbfe8ff, 0xffffff, {
  additive: true, life: [0.6, 1.2], size: [0.22, 0.4], grow: 0.2, alpha: 0.85, gravity: 1.2, drag: 1.5, fadeIn: 0.1,
})
/** 光柱里缓缓升起的光点（颜色取光柱色） */
const BEAM_MOTE = defineStyle(0xffffff, 0xffffff, {
  additive: true, life: [1, 1.6], size: [0.08, 0.16], grow: 0.3, alpha: 0.8, gravity: 0.6, drag: 0.3, fadeIn: 0.15,
})
const RING_DUST = defineStyle(0xb8ab8c, 0x8a7d63, {
  frame: FRAME_PUFF, life: [0.7, 1.2], size: [0.6, 1], grow: 2.4, alpha: 0.38, gravity: 0.5, drag: 2.2, spin: 0.8, fadeIn: 0.1, fadePow: 1,
})
const WASH_DUST = defineStyle(0xb9ad90, 0x8f846b, {
  frame: FRAME_PUFF, life: [0.7, 1.1], size: [0.5, 0.9], grow: 2.2, alpha: 0.22, gravity: 0.2, drag: 1.6, spin: 0.8, fadeIn: 0.15, fadePow: 1,
})
const WASH_GRASS = defineStyle(0x5f9a3a, 0x3c6b24, {
  frame: FRAME_CHIP, life: [0.6, 1.1], size: [0.05, 0.1], gravity: -5, drag: 1, spin: 14, floor: true, fadePow: 3,
})
/** 烟柱的烟团（颜色取调用方给的颜色） */
const COLUMN_SMOKE = defineStyle(0xffffff, 0xffffff, {
  frame: FRAME_PUFF, life: [2.4, 3.4], size: [0.45, 0.7], grow: 4, alpha: 0.5, gravity: 0.5, drag: 0.5, spin: 0.5, fadeIn: 0.1, fadePow: 1,
})

function blankParticle(): Particle {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size0: 0, size1: 0, r: 1, g: 1, b: 1, alpha: 1,
    fadeIn: 0, fadePow: 2, gravity: 0, drag: 0, rot: 0, spin: 0, frame: 0, floor: false,
  }
}

interface ParticlePool {
  readonly mesh: Mesh
  /** 取一个粒子槽，调用方必须写满全部字段。池满时顶替一个现有粒子 */
  take(): Particle
  update(dt: number): void
  dispose(): void
}

/**
 * 定长粒子池：一个实例化的公告板四边形网格。
 * 存活粒子始终排在数组前部（死亡时与末尾交换），每帧把存活部分写进实例缓冲。
 */
function createParticlePool(capacity: number, additive: boolean, map: Texture): ParticlePool {
  const offsets = new Float32Array(capacity * 3)
  const colors = new Float32Array(capacity * 4)
  const params = new Float32Array(capacity * 4)
  const offsetAttr = new InstancedBufferAttribute(offsets, 3).setUsage(DynamicDrawUsage)
  const colorAttr = new InstancedBufferAttribute(colors, 4).setUsage(DynamicDrawUsage)
  const paramAttr = new InstancedBufferAttribute(params, 4).setUsage(DynamicDrawUsage)

  const geometry = new InstancedBufferGeometry()
  setQuad(geometry, -0.5, -0.5, 0.5, 0.5)
  geometry.setAttribute('aOffset', offsetAttr)
  geometry.setAttribute('aColor', colorAttr)
  geometry.setAttribute('aParams', paramAttr)
  geometry.instanceCount = 0

  const material = new ShaderMaterial({
    uniforms: { uMap: { value: map }, ...fogUniforms() },
    vertexShader: PARTICLE_VERT,
    fragmentShader: particleFragment(additive),
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
    fog: true,
  })

  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.visible = false
  mesh.renderOrder = additive ? ORDER.glow : ORDER.particle

  const list: Particle[] = []
  for (let i = 0; i < capacity; i++) list.push(blankParticle())
  let count = 0
  let cursor = 0

  return {
    mesh,

    take() {
      if (count < capacity) return list[count++] as Particle
      const p = list[cursor] as Particle
      cursor = (cursor + 1) % capacity
      return p
    },

    update(dt) {
      let i = 0
      while (i < count) {
        const p = list[i] as Particle
        p.age += dt
        if (p.age >= p.life) {
          // 与末尾的存活粒子交换，下一轮继续处理换过来的那个
          count--
          list[i] = list[count] as Particle
          list[count] = p
          continue
        }

        const k = 1 / (1 + p.drag * dt)
        p.vy += p.gravity * dt
        p.vx *= k
        p.vy *= k
        p.vz *= k
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.z += p.vz * dt
        if (p.floor && p.y < FLOOR_Y) {
          p.y = FLOOR_Y
          p.vx = 0
          p.vy = 0
          p.vz = 0
          p.gravity = 0
          p.spin = 0
        }
        p.rot += p.spin * dt

        const t = p.age / p.life
        const inv = 1 - t
        let alpha = p.alpha * (1 - Math.pow(t, p.fadePow))
        if (t < p.fadeIn) alpha *= t / p.fadeIn

        const o3 = i * 3
        const o4 = i * 4
        offsets[o3] = p.x
        offsets[o3 + 1] = p.y
        offsets[o3 + 2] = p.z
        colors[o4] = p.r
        colors[o4 + 1] = p.g
        colors[o4 + 2] = p.b
        colors[o4 + 3] = alpha
        // 尺寸先快后慢地趋近结束值
        params[o4] = p.size0 + (p.size1 - p.size0) * (1 - inv * inv)
        params[o4 + 1] = p.rot
        params[o4 + 2] = p.frame
        i++
      }

      geometry.instanceCount = count
      mesh.visible = count > 0
      if (count > 0) {
        offsetAttr.needsUpdate = true
        colorAttr.needsUpdate = true
        paramAttr.needsUpdate = true
      }
    },

    dispose() {
      count = 0
      geometry.instanceCount = 0
      mesh.visible = false
      geometry.dispose()
      material.dispose()
    },
  }
}

/* ── 池内槽位 ── */

interface FlashSlot {
  readonly sprite: Sprite
  readonly material: SpriteMaterial
  active: boolean
  age: number
  size: number
}

interface PoisonSlot {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  readonly uTime: IUniform<number>
  readonly uAlpha: IUniform<number>
  readonly uSeed: IUniform<number>
  active: boolean
  age: number
  life: number
  radius: number
  fogAcc: number
}

interface RingSlot {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  readonly uColor: IUniform<Color>
  readonly uRadius: IUniform<number>
  readonly uWidth: IUniform<number>
  readonly uAlpha: IUniform<number>
  active: boolean
  age: number
  duration: number
  maxRadius: number
  /** 网格半边长（略大于最大半径，给前沿留余量） */
  extent: number
  dustAcc: number
}

interface TelegraphSlot {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  readonly uColor: IUniform<Color>
  readonly uShape: IUniform<number>
  readonly uHalfArc: IUniform<number>
  readonly uSize: IUniform<Vector2>
  readonly uProgress: IUniform<number>
  readonly uAlpha: IUniform<number>
  active: boolean
  age: number
  duration: number
}

interface BeamSlot {
  readonly mesh: Mesh
  readonly material: ShaderMaterial
  readonly uColor: IUniform<Color>
  readonly uTime: IUniform<number>
  readonly uAlpha: IUniform<number>
  active: boolean
  /** 已请求移除，正在淡出 */
  removing: boolean
  /** 显现程度 0..1 */
  fade: number
  time: number
  height: number
  moteAcc: number
  /** 每次复用 +1，让旧句柄失效 */
  serial: number
}

interface SmokeSlot {
  readonly color: Color
  active: boolean
  x: number
  y: number
  z: number
  acc: number
  serial: number
}

const SHAPE_CIRCLE = 0
const SHAPE_SECTOR = 1
const SHAPE_LINE = 2

/**
 * 创建特效系统。工厂执行期间只使用 ctx.scene 与 ctx.rng；全部对象挂在一个根 Group 下，dispose 时整体移除。
 * @param ctx 游戏上下文
 */
export function createEffects(ctx: GameContext): EffectsSystem {
  // 派生独立的随机序列：特效的随机消耗不影响玩法随机数
  const rng = ctx.rng.fork()
  const root = new Group()
  root.name = 'effects'
  ctx.scene.add(root)

  const atlas = drawParticleAtlas()
  const muzzleMap = drawMuzzleTexture()
  const holeMap = drawBulletHoleTexture()
  // 血迹贴图归纹理生成器的缓存所有，这里只引用、不释放
  const bloodMap = getTexture('blood')

  /* 粒子 */

  const dustPool = createParticlePool(NORMAL_PARTICLES, false, atlas)
  const glowPool = createParticlePool(ADDITIVE_PARTICLES, true, atlas)
  root.add(dustPool.mesh, glowPool.mesh)

  const emit = (
    style: ParticleStyle,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    tint: Color | null = null,
  ): void => {
    const p = (style.additive ? glowPool : dustPool).take()
    p.x = x
    p.y = y
    p.z = z
    p.vx = vx
    p.vy = vy
    p.vz = vz
    p.age = 0
    p.life = rng.range(style.lifeMin, style.lifeMax)
    p.size0 = rng.range(style.sizeMin, style.sizeMax)
    p.size1 = p.size0 * style.grow
    if (tint) {
      const k = rng.range(0.75, 1.1)
      p.r = tint.r * k
      p.g = tint.g * k
      p.b = tint.b * k
    } else {
      const k = rng.next()
      p.r = style.from.r + (style.to.r - style.from.r) * k
      p.g = style.from.g + (style.to.g - style.from.g) * k
      p.b = style.from.b + (style.to.b - style.from.b) * k
    }
    p.alpha = style.alpha
    p.fadeIn = style.fadeIn
    p.fadePow = style.fadePow
    p.gravity = style.gravity
    p.drag = style.drag
    p.rot = rng.range(0, TAU)
    p.spin = style.spin === 0 ? 0 : rng.range(-style.spin, style.spin)
    p.frame = style.frame
    p.floor = style.floor
  }

  const dir = new Vector3()

  /** 球面均匀随机方向，写入 dir */
  const randomDir = (): void => {
    const u = rng.range(-1, 1)
    const a = rng.range(0, TAU)
    const s = Math.sqrt(1 - u * u)
    dir.set(s * Math.cos(a), u, s * Math.sin(a))
  }

  /** 沿法线方向喷出：法线为主方向，叠加 spread 比例的随机散布 */
  const spray = (
    style: ParticleStyle,
    point: Vector3,
    normal: Vector3,
    count: number,
    speedMin: number,
    speedMax: number,
    spread: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      randomDir()
      const speed = rng.range(speedMin, speedMax)
      emit(
        style,
        point.x + normal.x * 0.03,
        point.y + normal.y * 0.03,
        point.z + normal.z * 0.03,
        (normal.x + dir.x * spread) * speed,
        (normal.y + dir.y * spread) * speed,
        (normal.z + dir.z * spread) * speed,
      )
    }
  }

  /** 向四周水平散开并带一点上升速度的烟尘团 */
  const puffs = (
    style: ParticleStyle,
    position: Vector3,
    count: number,
    outMin: number,
    outMax: number,
    upMin: number,
    upMax: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, TAU)
      const out = rng.range(outMin, outMax)
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      emit(
        style,
        position.x + cos * rng.range(0, 0.3),
        position.y + rng.range(0.05, 0.35),
        position.z + sin * rng.range(0, 0.3),
        cos * out,
        rng.range(upMin, upMax),
        sin * out,
      )
    }
  }

  /** 向上半球四散飞溅 */
  const scatter = (style: ParticleStyle, position: Vector3, count: number, speedMin: number, speedMax: number): void => {
    for (let i = 0; i < count; i++) {
      randomDir()
      const speed = rng.range(speedMin, speedMax)
      emit(
        style,
        position.x,
        position.y + 0.05,
        position.z,
        dir.x * speed,
        Math.abs(dir.y) * speed,
        dir.z * speed,
      )
    }
  }

  /* 枪口火光 */

  const flashes: FlashSlot[] = []
  for (let i = 0; i < MUZZLE_POOL; i++) {
    const material = new SpriteMaterial({
      map: muzzleMap,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    })
    const sprite = new Sprite(material)
    sprite.visible = false
    sprite.renderOrder = ORDER.muzzle
    root.add(sprite)
    flashes.push({ sprite, material, active: false, age: 0, size: MUZZLE_SIZE })
  }
  let flashCursor = 0

  /* 曳光 */

  const tracerStart = new InstancedBufferAttribute(new Float32Array(TRACER_POOL * 3), 3).setUsage(DynamicDrawUsage)
  const tracerEnd = new InstancedBufferAttribute(new Float32Array(TRACER_POOL * 3), 3).setUsage(DynamicDrawUsage)
  const tracerAge = new InstancedBufferAttribute(new Float32Array(TRACER_POOL).fill(1), 1).setUsage(DynamicDrawUsage)
  /** 各槽位已存在的秒数；>= TRACER_LIFE 为空闲 */
  const tracerTime = new Float32Array(TRACER_POOL).fill(TRACER_LIFE)
  let tracerCursor = 0

  const tracerGeometry = new InstancedBufferGeometry()
  setQuad(tracerGeometry, 0, -0.5, 1, 0.5)
  tracerGeometry.setAttribute('aStart', tracerStart)
  tracerGeometry.setAttribute('aEnd', tracerEnd)
  tracerGeometry.setAttribute('aAge', tracerAge)
  tracerGeometry.instanceCount = TRACER_POOL
  const tracerMaterial = new ShaderMaterial({
    uniforms: { uColor: { value: new Color(0xffd27a) } },
    vertexShader: TRACER_VERT,
    fragmentShader: TRACER_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  })
  const tracerMesh = new Mesh(tracerGeometry, tracerMaterial)
  tracerMesh.frustumCulled = false
  tracerMesh.matrixAutoUpdate = false
  tracerMesh.visible = false
  tracerMesh.renderOrder = ORDER.tracer
  root.add(tracerMesh)

  /* 贴花（弹孔 + 血迹） */

  const decalCenter = new InstancedBufferAttribute(new Float32Array(DECAL_LIMIT * 3), 3).setUsage(DynamicDrawUsage)
  const decalNormal = new InstancedBufferAttribute(new Float32Array(DECAL_LIMIT * 3), 3).setUsage(DynamicDrawUsage)
  const decalParams = new InstancedBufferAttribute(new Float32Array(DECAL_LIMIT * 4), 4).setUsage(DynamicDrawUsage)
  for (let i = 0; i < DECAL_LIMIT; i++) decalNormal.setXYZ(i, 0, 1, 0)
  const decalAge = new Float32Array(DECAL_LIMIT)
  /** 各槽位的寿命；0 为空闲 */
  const decalLife = new Float32Array(DECAL_LIMIT)
  const decalBase = new Float32Array(DECAL_LIMIT)
  let decalLive = 0

  const decalGeometry = new InstancedBufferGeometry()
  setQuad(decalGeometry, -0.5, -0.5, 0.5, 0.5)
  decalGeometry.setAttribute('aCenter', decalCenter)
  decalGeometry.setAttribute('aNormal', decalNormal)
  decalGeometry.setAttribute('aParams', decalParams)
  decalGeometry.instanceCount = DECAL_LIMIT
  const decalMaterial = new ShaderMaterial({
    uniforms: { uHole: { value: holeMap }, uBlood: { value: bloodMap }, ...fogUniforms() },
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const decalMesh = new Mesh(decalGeometry, decalMaterial)
  decalMesh.frustumCulled = false
  decalMesh.matrixAutoUpdate = false
  decalMesh.visible = false
  decalMesh.renderOrder = ORDER.decal
  root.add(decalMesh)

  /** 放一张贴花：优先用空闲槽位，满 50 张时顶替最旧的一张 */
  const addDecal = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    size: number,
    kind: number,
    life: number,
    alpha: number,
  ): void => {
    let slot = 0
    let oldest = -1
    let free = false
    for (let i = 0; i < DECAL_LIMIT; i++) {
      if ((decalLife[i] as number) <= 0) {
        slot = i
        free = true
        break
      }
      const age = decalAge[i] as number
      if (age > oldest) {
        oldest = age
        slot = i
      }
    }
    if (free) decalLive++
    decalAge[slot] = 0
    decalLife[slot] = life
    decalBase[slot] = alpha
    decalCenter.setXYZ(slot, x, y, z)
    decalNormal.setXYZ(slot, nx, ny, nz)
    decalParams.setXYZW(slot, size, rng.range(0, TAU), alpha, kind)
    decalCenter.needsUpdate = true
    decalNormal.needsUpdate = true
    decalParams.needsUpdate = true
    decalMesh.visible = true
  }

  /* 贴地图形与光柱 */

  const groundQuad = createGroundQuad()
  const beamGeometry = new CylinderGeometry(1, 1, 1, 24, 1, true)
  beamGeometry.translate(0, 0.5, 0)

  const pools: PoisonSlot[] = []
  const rings: RingSlot[] = []
  const telegraphs: TelegraphSlot[] = []
  const beams: BeamSlot[] = []
  const smokes: SmokeSlot[] = []

  const createPoisonSlot = (): PoisonSlot => {
    const uTime: IUniform<number> = { value: 0 }
    const uAlpha: IUniform<number> = { value: 0 }
    const uSeed: IUniform<number> = { value: 0 }
    const material = groundMaterial(POISON_FRAG, { uTime, uAlpha, uSeed }, NormalBlending)
    const mesh = new Mesh(groundQuad, material)
    mesh.visible = false
    mesh.renderOrder = ORDER.pool
    root.add(mesh)
    return { mesh, material, uTime, uAlpha, uSeed, active: false, age: 0, life: 0, radius: 1, fogAcc: 0 }
  }

  const createRingSlot = (): RingSlot => {
    const uColor: IUniform<Color> = { value: new Color(RING_COLOR) }
    const uRadius: IUniform<number> = { value: 0 }
    const uWidth: IUniform<number> = { value: 0.1 }
    const uAlpha: IUniform<number> = { value: 0 }
    const material = groundMaterial(RING_FRAG, { uColor, uRadius, uWidth, uAlpha }, AdditiveBlending)
    const mesh = new Mesh(groundQuad, material)
    mesh.visible = false
    mesh.renderOrder = ORDER.ring
    root.add(mesh)
    return {
      mesh, material, uColor, uRadius, uWidth, uAlpha,
      active: false, age: 0, duration: 1, maxRadius: 1, extent: 1, dustAcc: 0,
    }
  }

  const createTelegraphSlot = (): TelegraphSlot => {
    const uColor: IUniform<Color> = { value: new Color(TELEGRAPH_COLOR) }
    const uShape: IUniform<number> = { value: SHAPE_CIRCLE }
    const uHalfArc: IUniform<number> = { value: Math.PI }
    const uSize: IUniform<Vector2> = { value: new Vector2(1, 1) }
    const uProgress: IUniform<number> = { value: 0 }
    const uAlpha: IUniform<number> = { value: 0 }
    const material = groundMaterial(
      TELEGRAPH_FRAG,
      { uColor, uShape, uHalfArc, uSize, uProgress, uAlpha },
      NormalBlending,
    )
    const mesh = new Mesh(groundQuad, material)
    mesh.visible = false
    mesh.renderOrder = ORDER.telegraph
    root.add(mesh)
    return { mesh, material, uColor, uShape, uHalfArc, uSize, uProgress, uAlpha, active: false, age: 0, duration: 1 }
  }

  const createBeamSlot = (): BeamSlot => {
    const uColor: IUniform<Color> = { value: new Color(0xffffff) }
    const uTime: IUniform<number> = { value: 0 }
    const uAlpha: IUniform<number> = { value: 0 }
    const material = new ShaderMaterial({
      uniforms: { uColor, uTime, uAlpha },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    const mesh = new Mesh(beamGeometry, material)
    mesh.visible = false
    mesh.renderOrder = ORDER.beam
    root.add(mesh)
    return {
      mesh, material, uColor, uTime, uAlpha,
      active: false, removing: false, fade: 0, time: 0, height: BEAM_HEIGHT, moteAcc: 0, serial: 0,
    }
  }

  const createSmokeSlot = (): SmokeSlot => ({ color: new Color(), active: false, x: 0, y: 0, z: 0, acc: 0, serial: 0 })

  // 预建常见数量的槽位，战斗中一般不再扩容
  for (let i = 0; i < 6; i++) pools.push(createPoisonSlot())
  for (let i = 0; i < 2; i++) rings.push(createRingSlot())
  for (let i = 0; i < 6; i++) telegraphs.push(createTelegraphSlot())
  for (let i = 0; i < 4; i++) beams.push(createBeamSlot())
  for (let i = 0; i < 4; i++) smokes.push(createSmokeSlot())

  const startTelegraph = (
    shape: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    halfX: number,
    halfZ: number,
    halfArc: number,
    duration: number,
    color: number,
  ): void => {
    const slot = acquire(telegraphs, createTelegraphSlot)
    slot.active = true
    slot.age = 0
    slot.duration = Math.max(duration, 0.01)
    slot.uColor.value.set(color)
    slot.uShape.value = shape
    slot.uHalfArc.value = halfArc
    slot.uSize.value.set(halfX, halfZ)
    slot.uProgress.value = 0
    slot.uAlpha.value = 0
    slot.mesh.position.set(x, y + 0.05, z)
    slot.mesh.rotation.set(0, yaw, 0)
    slot.mesh.scale.set(halfX, 1, halfZ)
    slot.mesh.visible = true
  }

  /* 下洗气流 */

  let washStrength = 0
  let washX = 0
  let washZ = 0
  let washDustAcc = 0
  let washGrassAcc = 0

  const emitWash = (style: ParticleStyle, speedMin: number, speedMax: number, upMin: number, upMax: number): void => {
    const a = rng.range(0, TAU)
    const dist = rng.range(WASH_INNER, WASH_OUTER)
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const speed = rng.range(speedMin, speedMax) * (0.5 + 0.5 * washStrength)
    // 径向向外，略带顺旋翼方向的切向分量
    emit(
      style,
      washX + cos * dist,
      WASH_GROUND_Y + rng.range(0.05, 0.3),
      washZ + sin * dist,
      (cos - sin * 0.3) * speed,
      rng.range(upMin, upMax),
      (sin + cos * 0.3) * speed,
    )
  }

  /* 屏幕震动 */

  const shakeOffset = new Vector3()
  const shakeNoise = getNoise(9173)
  let shakeStrength = 0
  let shakeDuration = 0
  let shakeTime = 0
  let shakeClock = 0

  /** 当前剩余的震动幅度（米） */
  const shakeLevel = (): number => {
    if (shakeDuration <= 0) return 0
    const k = 1 - shakeTime / shakeDuration
    return k > 0 ? shakeStrength * k * k : 0
  }

  const system: EffectsSystem = {
    shakeOffset,

    muzzleFlash(position, direction, scale = 1) {
      // 轮转复用：寿命只有 0.1 秒，轮到的槽位总是最旧的
      const slot = flashes[flashCursor] as FlashSlot
      flashCursor = (flashCursor + 1) % MUZZLE_POOL
      slot.active = true
      slot.age = 0
      slot.size = MUZZLE_SIZE * scale * rng.range(0.85, 1.15)
      slot.material.rotation = rng.range(0, TAU)
      slot.material.opacity = 1
      slot.sprite.position.copy(position).addScaledVector(direction, 0.06 * scale)
      slot.sprite.scale.setScalar(slot.size * 0.7)
      slot.sprite.visible = true
    },

    tracer(from, to) {
      const i = tracerCursor
      tracerCursor = (tracerCursor + 1) % TRACER_POOL
      tracerTime[i] = TRACER_FRESH
      tracerStart.setXYZ(i, from.x, from.y, from.z)
      tracerEnd.setXYZ(i, to.x, to.y, to.z)
      tracerAge.setX(i, 0)
      tracerStart.needsUpdate = true
      tracerEnd.needsUpdate = true
      tracerAge.needsUpdate = true
      tracerMesh.visible = true
    },

    impact(point, normal, kind: ImpactKind) {
      switch (kind) {
        case 'world':
          spray(CHIP, point, normal, 4, 1.5, 4, 0.7)
          spray(DUST_PUFF, point, normal, 1, 0.3, 0.8, 0.5)
          break
        case 'blood':
          spray(BLOOD_DROP, point, normal, 5, 1.5, 4, 0.8)
          spray(BLOOD_MIST, point, normal, 2, 0.4, 1.2, 0.6)
          break
        case 'goo':
          spray(GOO_DROP, point, normal, 5, 1.5, 4.5, 0.8)
          spray(GOO_MIST, point, normal, 2, 0.4, 1.2, 0.6)
          break
        case 'core':
          spray(SPARK, point, normal, 7, 3, 7, 0.9)
          emit(FLASH, point.x, point.y, point.z, 0, 0, 0)
          break
      }
    },

    bulletHole(point, normal) {
      const len = normal.length()
      if (len < 1e-6) addDecal(point.x, point.y, point.z, 0, 1, 0, rng.range(0.09, 0.14), 0, HOLE_LIFE, 1)
      else {
        const inv = 1 / len
        addDecal(
          point.x,
          point.y,
          point.z,
          normal.x * inv,
          normal.y * inv,
          normal.z * inv,
          rng.range(0.09, 0.14),
          0,
          HOLE_LIFE,
          1,
        )
      }
    },

    bloodDecal(position, size = 0.9) {
      addDecal(position.x, position.y, position.z, 0, 1, 0, size * rng.range(0.85, 1.2), 1, BLOOD_LIFE, 0.85)
    },

    burst(position, kind: BurstKind, count) {
      switch (kind) {
        case 'dust':
          puffs(DUST, position, clamp(count ?? 14, 0, BURST_MAX), 1, 3.5, 0.3, 1.5)
          break
        case 'smokeRed':
          puffs(SMOKE_RED, position, clamp(count ?? 24, 0, BURST_MAX), 0.3, 1.6, 0.6, 2.2)
          break
        case 'smokeGrey':
          puffs(SMOKE_GREY, position, clamp(count ?? 20, 0, BURST_MAX), 0.3, 1.6, 0.6, 2.2)
          break
        case 'poison': {
          // 三分之二是毒雾，其余是飞溅的毒液滴
          const total = clamp(count ?? 16, 0, BURST_MAX)
          const drops = Math.floor(total / 3)
          puffs(POISON_MIST, position, total - drops, 0.4, 1.6, 0.3, 1.4)
          scatter(POISON_DROP, position, drops, 2, 5)
          break
        }
        case 'spark':
          scatter(SPARK, position, clamp(count ?? 14, 0, BURST_MAX), 2.5, 7)
          break
        case 'glow':
          scatter(GLOW, position, clamp(count ?? 10, 0, BURST_MAX), 0.4, 1.6)
          break
      }
    },

    poisonPool(center, radius, life) {
      const slot = acquire(pools, createPoisonSlot)
      slot.active = true
      slot.age = 0
      slot.life = Math.max(life, 0)
      slot.radius = radius
      slot.fogAcc = 0
      slot.uTime.value = 0
      slot.uAlpha.value = 0
      slot.uSeed.value = rng.range(0, 40)
      slot.mesh.position.set(center.x, center.y + 0.03, center.z)
      slot.mesh.rotation.set(0, rng.range(0, TAU), 0)
      slot.mesh.scale.set(radius * 0.3, 1, radius * 0.3)
      slot.mesh.visible = true
    },

    shockwaveRing(center, maxRadius, duration, color = RING_COLOR) {
      const slot = acquire(rings, createRingSlot)
      const extent = Math.max(maxRadius, 0.1) * 1.06
      slot.active = true
      slot.age = 0
      slot.duration = Math.max(duration, 0.05)
      slot.maxRadius = maxRadius
      slot.extent = extent
      slot.dustAcc = 0
      slot.uColor.value.set(color)
      slot.uRadius.value = 0
      slot.uWidth.value = clamp(maxRadius * 0.12, 0.6, 2.5) / extent
      slot.uAlpha.value = 0.85
      slot.mesh.position.set(center.x, center.y + 0.07, center.z)
      slot.mesh.scale.set(extent, 1, extent)
      slot.mesh.visible = true
    },

    telegraphCircle(center, radius, duration, color = TELEGRAPH_COLOR) {
      startTelegraph(SHAPE_CIRCLE, center.x, center.y, center.z, 0, radius, radius, Math.PI, duration, color)
    },

    telegraphSector(center, facing, arc, radius, duration, color = TELEGRAPH_COLOR) {
      // 网格本地 +Z 是扇形中线，绕 Y 转 facing 后即指向 (sin facing, 0, cos facing)
      startTelegraph(SHAPE_SECTOR, center.x, center.y, center.z, facing, radius, radius, arc * 0.5, duration, color)
    },

    telegraphLine(from, to, width, duration, color = TELEGRAPH_COLOR) {
      const dx = to.x - from.x
      const dz = to.z - from.z
      const length = Math.hypot(dx, dz)
      if (length < 1e-4) return
      // 本地 +Z 从 from 指向 to，填充沿这个方向推进
      startTelegraph(
        SHAPE_LINE,
        (from.x + to.x) * 0.5,
        Math.min(from.y, to.y),
        (from.z + to.z) * 0.5,
        Math.atan2(dx, dz),
        width * 0.5,
        length * 0.5,
        Math.PI,
        duration,
        color,
      )
    },

    lightBeam(position, color, height = BEAM_HEIGHT): EffectHandle {
      const slot = acquire(beams, createBeamSlot)
      slot.active = true
      slot.removing = false
      slot.fade = 0
      slot.time = rng.range(0, 10)
      slot.height = height
      slot.moteAcc = 0
      slot.serial++
      slot.uColor.value.set(color)
      slot.uAlpha.value = 0
      slot.mesh.position.copy(position)
      slot.mesh.scale.set(BEAM_RADIUS, height, BEAM_RADIUS)
      slot.mesh.visible = true
      const serial = slot.serial
      return {
        remove: () => {
          // 槽位被复用后旧句柄失效
          if (slot.active && slot.serial === serial) slot.removing = true
        },
      }
    },

    smokeColumn(position, color): EffectHandle {
      const slot = acquire(smokes, createSmokeSlot)
      slot.active = true
      slot.x = position.x
      slot.y = position.y
      slot.z = position.z
      slot.acc = 0
      slot.serial++
      slot.color.set(color)
      const serial = slot.serial
      return {
        remove: () => {
          // 只停止冒烟，已有的烟团自然散去
          if (slot.serial === serial) slot.active = false
        },
      }
    },

    rotorWash(center, strength) {
      // 这里只登记请求，粒子在 update 里按 dt 发射；不再被调用时自动停止
      const s = clamp(strength, 0, 1)
      if (s <= 0) return
      washStrength = Math.max(washStrength, s)
      washX = center.x
      washZ = center.z
    },

    shake(strength, duration) {
      if (!(strength > 0) || !(duration > 0)) return
      // 多次调用取较强者：新的震动不弱于当前剩余幅度时才接管
      const capped = Math.min(strength, SHAKE_MAX)
      if (capped >= shakeLevel()) {
        shakeStrength = capped
        shakeDuration = duration
        shakeTime = 0
      }
    },

    update(dt) {
      /* 屏幕震动 */
      if (shakeDuration > 0) {
        shakeTime += dt
        shakeClock += dt
        const level = shakeLevel()
        if (level <= 0) {
          shakeDuration = 0
          shakeOffset.set(0, 0, 0)
        } else {
          const s = shakeClock * SHAKE_FREQUENCY
          shakeOffset.set(
            shakeNoise.noise2D(s, 11.3) * level,
            shakeNoise.noise2D(s, 47.7) * level,
            shakeNoise.noise2D(s, 83.1) * level * 0.5,
          )
        }
      }

      /* 枪口火光 */
      for (let i = 0; i < flashes.length; i++) {
        const slot = flashes[i] as FlashSlot
        if (!slot.active) continue
        slot.age += dt
        if (slot.age >= MUZZLE_LIFE) {
          slot.active = false
          slot.sprite.visible = false
          continue
        }
        const t = slot.age / MUZZLE_LIFE
        slot.material.opacity = 1 - t * t
        slot.sprite.scale.setScalar(slot.size * (0.7 + 0.5 * t))
      }

      /* 曳光 */
      if (tracerMesh.visible) {
        let alive = false
        for (let i = 0; i < TRACER_POOL; i++) {
          let t = tracerTime[i] as number
          if (t >= TRACER_LIFE) continue
          t = t < 0 ? 0 : t + dt
          tracerTime[i] = t
          if (t < TRACER_LIFE) {
            tracerAge.setX(i, t / TRACER_LIFE)
            alive = true
          } else {
            tracerAge.setX(i, 1)
          }
        }
        tracerAge.needsUpdate = true
        tracerMesh.visible = alive
      }

      /* 贴花：寿命末尾淡出，到期清空槽位 */
      if (decalLive > 0) {
        let dirty = false
        for (let i = 0; i < DECAL_LIMIT; i++) {
          const life = decalLife[i] as number
          if (life <= 0) continue
          const age = (decalAge[i] as number) + dt
          decalAge[i] = age
          if (age >= life) {
            decalLife[i] = 0
            decalParams.setX(i, 0)
            decalParams.setZ(i, 0)
            decalLive--
            dirty = true
          } else if (age > life - DECAL_FADE) {
            decalParams.setZ(i, ((decalBase[i] as number) * (life - age)) / DECAL_FADE)
            dirty = true
          }
        }
        if (dirty) decalParams.needsUpdate = true
        decalMesh.visible = decalLive > 0
      }

      /* 毒液池 */
      for (let i = 0; i < pools.length; i++) {
        const slot = pools[i] as PoisonSlot
        if (!slot.active) continue
        slot.age += dt
        const over = slot.age - slot.life
        if (over >= POOL_FADE) {
          slot.active = false
          slot.mesh.visible = false
          continue
        }
        const spread = slot.radius * POOL_VISUAL_SCALE * (0.3 + 0.7 * smoothstep(slot.age / POOL_GROW))
        slot.mesh.scale.set(spread, 1, spread)
        slot.uTime.value = slot.age
        slot.uAlpha.value = over > 0 ? 1 - over / POOL_FADE : Math.min(1, slot.age / 0.2)
        if (over < 0) {
          slot.fogAcc += dt * POOL_FOG_RATE
          while (slot.fogAcc >= 1) {
            slot.fogAcc -= 1
            const a = rng.range(0, TAU)
            const d = Math.sqrt(rng.next()) * slot.radius * 0.85
            emit(
              POOL_FOG,
              slot.mesh.position.x + Math.cos(a) * d,
              slot.mesh.position.y + 0.1,
              slot.mesh.position.z + Math.sin(a) * d,
              rng.range(-0.15, 0.15),
              rng.range(0.2, 0.5),
              rng.range(-0.15, 0.15),
            )
          }
        }
      }

      /* 冲击波环：半径线性扩散（与判定同步），沿前沿扬尘 */
      for (let i = 0; i < rings.length; i++) {
        const slot = rings[i] as RingSlot
        if (!slot.active) continue
        slot.age += dt
        const t = slot.age / slot.duration
        if (t >= 1) {
          slot.active = false
          slot.mesh.visible = false
          continue
        }
        const radius = slot.maxRadius * t
        slot.uRadius.value = radius / slot.extent
        slot.uAlpha.value = (1 - t * t) * 0.85
        slot.dustAcc += (dt * RING_DUST_TOTAL) / slot.duration
        while (slot.dustAcc >= 1) {
          slot.dustAcc -= 1
          const a = rng.range(0, TAU)
          const cos = Math.cos(a)
          const sin = Math.sin(a)
          const speed = rng.range(1.5, 3)
          emit(
            RING_DUST,
            slot.mesh.position.x + cos * radius,
            slot.mesh.position.y + 0.15,
            slot.mesh.position.z + sin * radius,
            cos * speed,
            rng.range(0.4, 1.2),
            sin * speed,
          )
        }
      }

      /* 地面预警：进度推进，到时快速淡出 */
      for (let i = 0; i < telegraphs.length; i++) {
        const slot = telegraphs[i] as TelegraphSlot
        if (!slot.active) continue
        slot.age += dt
        if (slot.age < slot.duration) {
          slot.uProgress.value = slot.age / slot.duration
          slot.uAlpha.value = Math.min(1, slot.age / 0.1)
          continue
        }
        const out = (slot.age - slot.duration) / TELEGRAPH_OUT
        if (out >= 1) {
          slot.active = false
          slot.mesh.visible = false
        } else {
          slot.uProgress.value = 1
          slot.uAlpha.value = 1 - out
        }
      }

      /* 光柱 */
      for (let i = 0; i < beams.length; i++) {
        const slot = beams[i] as BeamSlot
        if (!slot.active) continue
        slot.time += dt
        if (slot.removing) {
          slot.fade -= dt / BEAM_FADE_OUT
          if (slot.fade <= 0) {
            slot.active = false
            slot.mesh.visible = false
            continue
          }
        } else {
          slot.fade = Math.min(1, slot.fade + dt / BEAM_FADE_IN)
          slot.moteAcc += dt * BEAM_MOTE_RATE
          while (slot.moteAcc >= 1) {
            slot.moteAcc -= 1
            emit(
              BEAM_MOTE,
              slot.mesh.position.x + rng.range(-BEAM_RADIUS, BEAM_RADIUS),
              slot.mesh.position.y + rng.range(0, 2.5),
              slot.mesh.position.z + rng.range(-BEAM_RADIUS, BEAM_RADIUS),
              0,
              rng.range(1.5, 3),
              0,
              slot.uColor.value,
            )
          }
        }
        // 轻微脉动：亮度在着色器里，粗细在这里
        const girth = BEAM_RADIUS * (1 + 0.06 * Math.sin(slot.time * 3.1))
        slot.mesh.scale.set(girth, slot.height, girth)
        slot.uTime.value = slot.time
        slot.uAlpha.value = slot.fade * BEAM_ALPHA
      }

      /* 烟柱 */
      for (let i = 0; i < smokes.length; i++) {
        const slot = smokes[i] as SmokeSlot
        if (!slot.active) continue
        slot.acc += dt * SMOKE_RATE
        while (slot.acc >= 1) {
          slot.acc -= 1
          emit(
            COLUMN_SMOKE,
            slot.x + rng.range(-0.15, 0.15),
            slot.y + 0.1,
            slot.z + rng.range(-0.15, 0.15),
            rng.range(-0.25, 0.25) + 0.3,
            rng.range(1.6, 2.4),
            rng.range(-0.25, 0.25),
            slot.color,
          )
        }
      }

      /* 下洗气流：消费本帧登记的请求 */
      if (washStrength > 0) {
        washDustAcc += dt * washStrength * WASH_DUST_RATE
        while (washDustAcc >= 1) {
          washDustAcc -= 1
          emitWash(WASH_DUST, 3, 6, 0.2, 0.8)
        }
        washGrassAcc += dt * washStrength * WASH_GRASS_RATE
        while (washGrassAcc >= 1) {
          washGrassAcc -= 1
          emitWash(WASH_GRASS, 5, 10, 1, 3)
        }
        washStrength = 0
      }

      /* 粒子放在最后：本帧新发射的粒子也一并推进并写入缓冲 */
      dustPool.update(dt)
      glowPool.update(dt)
    },

    dispose() {
      ctx.scene.remove(root)
      root.clear()

      dustPool.dispose()
      glowPool.dispose()

      for (let i = 0; i < flashes.length; i++) {
        const slot = flashes[i] as FlashSlot
        slot.active = false
        slot.sprite.visible = false
        slot.material.dispose()
      }

      tracerTime.fill(TRACER_LIFE)
      tracerMesh.visible = false
      tracerGeometry.dispose()
      tracerMaterial.dispose()

      decalLife.fill(0)
      decalLive = 0
      decalMesh.visible = false
      decalGeometry.dispose()
      decalMaterial.dispose()

      for (let i = 0; i < pools.length; i++) (pools[i] as PoisonSlot).material.dispose()
      for (let i = 0; i < rings.length; i++) (rings[i] as RingSlot).material.dispose()
      for (let i = 0; i < telegraphs.length; i++) (telegraphs[i] as TelegraphSlot).material.dispose()
      for (let i = 0; i < beams.length; i++) (beams[i] as BeamSlot).material.dispose()
      pools.length = 0
      rings.length = 0
      telegraphs.length = 0
      beams.length = 0
      smokes.length = 0
      groundQuad.dispose()
      beamGeometry.dispose()

      atlas.dispose()
      muzzleMap.dispose()
      holeMap.dispose()

      washStrength = 0
      shakeDuration = 0
      shakeOffset.set(0, 0, 0)
    },
  }

  return system
}

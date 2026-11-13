/**
 * 天空穹顶材质：按高度蓝→白渐变 + 噪声云层 + 太阳高光。贴在一个朝内的大球上使用。
 */

import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'

const VERTEX = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform float uDisc;
varying vec3 vDir;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * valueNoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  vec3 sun = normalize(uSunDir);
  float h = clamp(d.y, 0.0, 1.0);
  float s = max(dot(d, sun), 0.0);
  // 天顶更深、地平线发白（大气厚度），朝太阳一侧的地平线偏暖
  vec3 col = mix(uHorizon, uTop, pow(h, 0.5));
  float horizonGlow = pow(1.0 - h, 5.0);
  col = mix(col, uHorizon * vec3(1.06, 1.02, 0.94), horizonGlow * pow(s, 2.0) * 0.6);

  // 云层：把视线投到一个水平面上采样噪声，靠近地平线处淡出；底部偏灰、朝阳的边缘更亮
  if (d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.3 + vec2(uTime * 0.006, uTime * 0.003);
    float density = fbm(uv);
    float cloud = smoothstep(0.5, 0.82, density) * smoothstep(0.02, 0.25, d.y);
    float shade = mix(1.0, 0.82, smoothstep(0.6, 0.95, density));
    vec3 cloudCol = vec3(0.97, 0.98, 1.0) * shade + vec3(0.25, 0.2, 0.12) * pow(s, 6.0);
    col = mix(col, cloudCol, cloud * 0.85);
  }

  // 太阳：日轮（超过 1 的高光交给泛光）+ 米氏散射光晕。烘焙环境贴图时关掉日轮，避免与方向光重复照明
  float disc = smoothstep(0.99985, 0.99993, s) * uDisc;
  col += vec3(1.0, 0.95, 0.82) * (disc * 18.0 + pow(s, 350.0) * 1.2 + pow(s, 48.0) * 0.18 + pow(s, 8.0) * 0.12);

  // 地平线以下压成雾色
  col = mix(uHorizon * 0.9, col, smoothstep(-0.2, 0.0, d.y));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * 创建天空穹顶材质。每帧把 uniforms.uTime.value 加上 dt 即可让云缓慢移动。
 * 太阳方向默认在东北方（+X 东，-Z 北）；世界系统会把 uSunDir 设成与方向光一致。
 * uDisc 为 0 时不画日轮（烘焙环境贴图用）。
 */
export function createSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new Vector3(0.6, 0.7, -0.5).normalize() },
      uTop: { value: new Color(0x3f7fd0) },
      uHorizon: { value: new Color(0xcfe3f2) },
      uDisc: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  })
}

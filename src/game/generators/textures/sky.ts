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
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.55));

  // 云层：把视线投到一个水平面上采样噪声，靠近地平线处淡出
  if (d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.3 + vec2(uTime * 0.006, uTime * 0.003);
    float cloud = smoothstep(0.5, 0.82, fbm(uv)) * smoothstep(0.02, 0.25, d.y);
    col = mix(col, vec3(1.0), cloud * 0.85);
  }

  // 太阳：小而亮的核心 + 大范围光晕
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  col += vec3(1.0, 0.93, 0.75) * (pow(s, 350.0) * 1.5 + pow(s, 12.0) * 0.22);

  // 地平线以下压成雾色
  col = mix(uHorizon * 0.9, col, smoothstep(-0.2, 0.0, d.y));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * 创建天空穹顶材质。每帧把 uniforms.uTime.value 加上 dt 即可让云缓慢移动。
 * 太阳方向固定在东北方（+X 东，-Z 北），与场景方向光一致。
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
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  })
}

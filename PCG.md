
# 🎲 CIS2 Prologue - 极简程序化生成设计

## Zero-Asset Procedural Generation Design Document

---

## 🎯 核心理念：完全无资源文件

### Saltline启发

**目标**：

- ❌ 不导入 .glb / .fbx 模型
- ❌ 不导入 .png / .jpg 贴图
- ❌ 不导入 .mp3 / .wav 音频
- ✅ 一切通过代码生成（Geometry + Material + WebAudio API）

**优势**：

- 🚀 加载速度飞快（无网络请求）
- 📦 体积极小（压缩后可能<2MB）
- 🎨 无版权问题
- 🔧 易于迭代（改参数而非换文件）

---

## 🏗️ 三大支柱

### 1. 几何体程序生成（Geometry Generation）

**核心思想**：用数学和算法构建所有3D模型

#### 角色模型

**人类角色（Samuel等4人）**：

- 身体：`BoxGeometry` 拉伸组合
- 头部：`SphereGeometry`
- 四肢：`CylinderGeometry`
- 武器：`BoxGeometry` + `CylinderGeometry` 组合

```
角色组装伪代码：
├─ 头（球体 0.4半径）
├─ 身体（长方体 0.6×0.8×0.3）
├─ 左臂（圆柱 0.15×0.7）
├─ 右臂（圆柱 0.15×0.7）
├─ 左腿（圆柱 0.18×0.8）
└─ 右腿（圆柱 0.18×0.8）
```

**差异化**：

- Samuel：蓝色身体 + 灰色头部
- Football Master：红色 + 更宽的身体（1.1倍）
- Manman：白色 + 稍小的body（0.9倍）
- 91Z：黑色 + 戴"口罩"（额外平面）

**丧尸模型**：

- 复用人类骨架
- 扭曲参数：随机倾斜 ±15°
- 材质：灰绿色 + 粗糙表面

**Boss章鱼**：

- 头部：`SphereGeometry` 拉伸（椭球）
- 触手：8条 `TubeGeometry` 沿贝塞尔曲线
- 核心：发光的小球（`SphereGeometry` + EmissiveMaterial）

#### 场景模型

**足球场**：

- 草地：`PlaneGeometry` 100×70
- 草地纹理：程序化噪声（后面讲）
- 白线：白色 `BoxGeometry` 薄条
- 中圈：`RingGeometry`

**掩体杂物**：

- 车辆残骸：多个 `BoxGeometry` 组合
- 长椅：`BoxGeometry` 矩阵排列
- 沙袋：`SphereGeometry` 压扁 + 堆叠
- 路障：`CylinderGeometry` 横放

**直升机**：

- 机身：拉长的 `CapsuleGeometry`
- 螺旋桨：旋转的 `BoxGeometry` 扁条
- 舱门：`PlaneGeometry` 动画开合

---

### 2. 材质与纹理程序生成（Procedural Textures）

**核心思想**：用Canvas 2D API或Shader生成纹理，转为DataTexture

#### Canvas纹理生成

**草地纹理**：

```
伪代码思路：
1. 创建 512×512 Canvas
2. 填充基础绿色（#3a7d44）
3. 用Simplex Noise生成明暗变化
4. 随机绘制深绿色"草丛"短线（1000根）
5. 添加泥土斑点（褐色圆点）
6. 转为 THREE.CanvasTexture
```

**混凝土纹理**（建筑物、路障）：

```
伪代码：
1. 灰色基底（#808080）
2. Perlin Noise 生成裂纹图案
3. 随机深色污渍（噪点）
4. 调整粗糙度贴图（同步生成）
```

**金属纹理**（武器、车辆）：

```
伪代码：
1. 银色基底（#c0c0c0）
2. 划痕：随机白色细线
3. 锈迹：橙褐色斑块（noise驱动）
4. 金属度贴图 = 基础1.0 - 锈迹区域0.3
```

**丧尸皮肤**：

```
伪代码：
1. 灰绿色基底（#5a6b5a）
2. 腐烂斑块：深色不规则形状
3. 血迹：随机暗红色splatter
4. 法线贴图：凹凸感（噪声）
```

**血迹贴花**：

```
伪代码：
1. 透明Canvas 256×256
2. 随机绘制不规则红色形状
3. 边缘羽化（gradientAlpha）
4. 用 DecalGeometry 投射到表面
```

#### Shader程序纹理

**实时天空**：

```
Fragment Shader思路：
- 根据Y坐标渐变（蓝→白）
- 添加云层（噪声函数）
- 太阳位置高光
```

**水面/毒液池**：

```
Fragment Shader思路：
- 绿色半透明基底
- UV滚动 + 噪声扭曲
- 边缘泡沫（距离场）
```

---

### 3. 音频程序生成（Web Audio API）

**核心思想**：不用音频文件，用振荡器和滤波器合成

#### 武器音效

**枪声合成**：

```
API方向：
1. OscillatorNode (白噪声) 0.05秒爆发
2. BiquadFilterNode 低通滤波（模拟枪腔共鸣）
3. GainNode 快速衰减包络（ADSR）
4. 不同武器：调整频率和衰减时间
   - AK47：低频150Hz，衰减0.15s
   - MP5：中频300Hz，衰减0.1s
```

**换弹音效**：

```
API方向：
1. 金属碰撞：短促高频noise + 快速衰减
2. 弹匣插入：中频"咔哒"（两段音）
3. 拉栓：滑动感（频率扫描）
```

#### 环境音效

**丧尸呻吟**：

```
API方向：
1. OscillatorNode (sawtooth波) 低频80-120Hz
2. LFO调制音高（颤抖感）
3. 随机音量变化
4. 添加混响（ConvolverNode）
```

**直升机螺旋桨**：

```
API方向：
1. 低频震动（40Hz正弦波）
2. 高频"呼呼"声（白噪声带通滤波）
3. 音量渐强（由远及近）
4. 多普勒效应（AudioListener位置变化）
```

**Boss咆哮**：

```
API方向：
1. 超低频（30Hz）+ 高频尖啸混合
2. 失真效果（WaveShaperNode）
3. 立体声相位（左右声道延迟）
```

#### BGM音乐

**战斗音乐**：

```
API方向：
1. 低音鼓：低频pulse（120 BPM）
2. 合成弦乐：锯齿波 + 滤波器扫描
3. 旋律：预定义音符序列（程序化生成？）
4. 分层：根据战况叠加音轨
```

**间歇期音乐**：

```
降低鼓点音量，保留环境pad音色
```

---

## 🎨 核心算法与API

### 噪声生成

**需要的噪声类型**：

1. **Perlin Noise**：平滑连续（地形高度）
2. **Simplex Noise**：更快，无方向性（纹理）
3. **Worley Noise**：细胞状（石头、混凝土裂纹）

**实现方式**：

- 自己实现（100行左右）
- 或用轻量库：`simplex-noise`（3KB）

**关键函数签名**：

```typescript
noise2D(x: number, y: number): number  // 返回[-1, 1]
noise3D(x: number, y: number, z: number): number
```

---

### 几何体生成器

**角色生成器API**：

```typescript
interface CharacterConfig {
  bodyColor: string
  height: number
  width: number
  headSize: number
}

function generateCharacter(config: CharacterConfig): THREE.Group {
  // 返回组装好的角色模型
}
```

**场景物体生成器**：

```typescript
function generateCar(): THREE.Group { }
function generateBench(): THREE.Group { }
function generateSandbags(): THREE.Group { }
// ... 等等
```

**Boss生成器**：

```typescript
interface TentacleConfig {
  length: number
  segments: number
  curvature: number
}

function generateOctopusBoss(tentacleConfigs: TentacleConfig[]): THREE.Group {
  // 生成章鱼+8条触手
}
```

---

### 纹理生成器

**通用纹理生成器API**：

```typescript
interface TextureGeneratorConfig {
  size: number          // 512 / 1024
  baseColor: string
  noiseScale: number
  noiseOctaves: number
}

function generateTexture(
  type: 'grass' | 'concrete' | 'metal' | 'skin',
  config: TextureGeneratorConfig
): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = config.size
  canvas.height = config.size
  const ctx = canvas.getContext('2d')!

  // ... 绘制逻辑 ...

  return new THREE.CanvasTexture(canvas)
}
```

**专用生成器**：

```typescript
function generateGrassTexture(seed: number): THREE.Texture { }
function generateBloodDecal(intensity: number): THREE.Texture { }
function generateNormalMap(heightMap: Float32Array): THREE.Texture { }
```

---

### 音频合成器

**枪声合成API**：

```typescript
interface GunSoundConfig {
  frequency: number    // 基础频率
  duration: number     // 持续时间
  decay: number        // 衰减时间
}

function synthesizeGunshot(
  audioContext: AudioContext,
  config: GunSoundConfig
): AudioBuffer {
  // 返回合成的音频Buffer
}

// 播放
function playGunshot(buffer: AudioBuffer, position: THREE.Vector3) {
  // 3D定位音效
}
```

**音乐生成API**：

```typescript
interface MusicTrack {
  tempo: number        // BPM
  notes: NoteSequence  // 音符序列
  instruments: Instrument[]
}

function generateBattleMusic(seed: number): MusicTrack {
  // 程序化生成音乐
}
```

---

## 🧮 数学与算法核心

### 贝塞尔曲线（Boss触手）

**用途**：生成平滑的触手弯曲路径

**API**：

```typescript
function createBezierCurve(
  start: THREE.Vector3,
  control1: THREE.Vector3,
  control2: THREE.Vector3,
  end: THREE.Vector3
): THREE.CubicBezierCurve3 {
  return new THREE.CubicBezierCurve3(start, control1, control2, end)
}

// 沿曲线生成管状触手
function createTentacle(curve: THREE.Curve<THREE.Vector3>): THREE.Mesh {
  const geometry = new THREE.TubeGeometry(curve, 32, 0.3, 8, false)
  const material = new THREE.MeshStandardMaterial({ color: 0x8B4789 })
  return new THREE.Mesh(geometry, material)
}
```

---

### 立方体行进算法（Marching Cubes）

**用途**：生成有机形状（Boss身体、地形起伏）

**思路**：

- 3D网格的每个点赋值（密度场）
- 根据密度阈值生成表面
- 输出三角面片

**是否需要**：可选，如果想要Boss更有机感

---

### L-System（植物/有机物）

**用途**：生成树木、草丛（如果场景需要）

**思路**：

```
规则：
F -> FF+[+F-F-F]-[-F+F+F]

迭代3次 → 绘制成树
```

**CIS2中可能不需要**（足球场没树），但可以用来生成：

- 血管纹理（丧尸皮肤）
- 裂纹（地面）

---

### Signed Distance Fields (SDF)

**用途**：

- 布尔运算组合形状
- 柔和混合多个几何体
- 生成复杂Boss形状

**示例**：

```glsl
// Shader中定义球体SDF
float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

// 合并多个球体（Boss的头部）
float bossHead = min(
  sdSphere(p, 2.0),
  sdSphere(p + vec3(0.5, 0, 0), 1.0)
);
```

---

## 🎮 实现策略

### 分层生成

**Level 1：基础几何**

- 只用原始形状（Box, Sphere, Cylinder）
- 纯色材质
- 先跑通玩法

**Level 2：材质增强**

- 加入程序纹理
- 光照优化
- 视觉升级

**Level 3：细节打磨**

- 音效合成
- 粒子特效（程序生成）
- 动画细节

---

### 性能考量

**纹理缓存**：

- 同类纹理只生成一次（如草地）
- 存在Map中复用

**几何体实例化**：

- 丧尸使用 `InstancedMesh`
- 相同掩体复用Geometry

**音频预合成**：

- 启动时合成常用音效
- 存为AudioBuffer
- 播放时直接用

---

## 📦 SPA集成思路

### Vue3 + Tres架构

**项目结构**：

```
src/
├── generators/           # 生成器模块
│   ├── geometry/
│   │   ├── character.ts
│   │   ├── enemy.ts
│   │   ├── boss.ts
│   │   └── props.ts
│   ├── textures/
│   │   ├── grass.ts
│   │   ├── concrete.ts
│   │   └── blood.ts
│   └── audio/
│       ├── gunshot.ts
│       ├── ambient.ts
│       └── music.ts
├── utils/
│   ├── noise.ts         # 噪声函数
│   ├── random.ts        # 种子随机
│   └── math.ts          # 数学工具
├── composables/
│   ├── useProceduralScene.ts
│   └── useProceduralAudio.ts
└── components/
    └── Game/
        └── MainScene.vue
```

**组件化**：

```vue
<script setup>
import { useProceduralScene } from '@/composables/useProceduralScene'

const { 
  characters,    // 程序生成的角色模型
  enemies,       // 程序生成的敌人
  props,         // 程序生成的场景物体
  boss           // 程序生成的Boss
} = useProceduralScene(gameSeed)
</script>

<template>
  <TresCanvas>
    <!-- 所有模型都是运行时生成的 -->
    <TresGroup v-for="char in characters" :key="char.id">
      <primitive :object="char.model" />
    </TresGroup>
  
    <!-- ... -->
  </TresCanvas>
</template>
```

---

## 🔑 关键决策点

### 1. 噪声库选择

**选项A**：自己实现（纯净，100行代码）
**选项B**：用 `simplex-noise`（3KB，成熟）

**茄子建议**：用simplex-noise，节省时间

---

### 2. 音频实现

**选项A**：完全Web Audio API合成
**选项B**：base64内嵌极小wav文件（关键音效）

**茄子建议**：关键音效（枪声、Boss吼叫）可以内嵌base64，环境音全合成

---

### 3. 角色动画

**问题**：程序生成的角色如何动画？

**选项A**：手写关键帧（调整骨骼旋转）
**选项B**：程序化动画（sin/cos函数驱动）
**选项C**：简化成静态+位移（牺牲质量）

**茄子建议**：用程序化动画——

```typescript
// 行走动画
function updateWalkAnimation(character: Character, time: number) {
  const leftLeg = character.getObjectByName('leftLeg')
  const rightLeg = character.getObjectByName('rightLeg')

  leftLeg.rotation.x = Math.sin(time * 5) * 0.5   // 前后摆动
  rightLeg.rotation.x = Math.sin(time * 5 + Math.PI) * 0.5

  // 手臂同步
  character.leftArm.rotation.x = -leftLeg.rotation.x * 0.3
  character.rightArm.rotation.x = -rightLeg.rotation.x * 0.3
}
```

---

## 🎯 给AI打工豹的任务清单

### Phase 1: 基础几何生成

- [ ] 实现噪声函数（或集成simplex-noise）
- [ ] 生成角色模型（4个配置）
- [ ] 生成丧尸模型（3种类型）
- [ ] 生成Boss基础形状
- [ ] 生成场景物体（10种掩体）
- [ ] 生成足球场地面

### Phase 2: 材质系统

- [ ] Canvas纹理生成器（草地、混凝土、金属）
- [ ] 丧尸皮肤变体生成
- [ ] 血迹贴花生成
- [ ] 法线贴图生成（可选）
- [ ] 天空盒Shader

### Phase 3: 音频合成

- [ ] 枪声合成器（4种武器）
- [ ] 环境音（直升机、风声）
- [ ] 丧尸音效
- [ ] Boss音效
- [ ] 背景音乐生成

### Phase 4: 动画系统

- [ ] 程序化行走动画
- [ ] 射击后坐力动画
- [ ] Boss触手蠕动动画
- [ ] 直升机螺旋桨旋转

### Phase 5: 集成与优化

- [ ] 性能监控（生成耗时）
- [ ] 纹理/几何体缓存
- [ ] 音频池管理
- [ ] 加载进度显示

---

## 💡 灵感参考

### 类似项目

1. **.kkrieger**（97KB的3D游戏，2004年）
2. **Saltline**（1.4MB HTML5 FPS）
3. **Farbrausch的Demo Scene作品**

### 技术参考

- **Shadertoy**：Shader纹理生成
- **WebAudio Examples**：音频合成
- **Three.js Examples**：几何体构建

---

## 📏 体积预估

**最终文件大小预测**：

| 组成部分 | 大小 |
| --------- | ------ |
| Three.js (压缩) | ~600KB |
| Vue3 + Tres | ~100KB |
| 游戏逻辑代码 | ~200KB |
| 生成器代码 | ~150KB |
| Simplex Noise库 | ~3KB |
| 内嵌音效(base64) | ~100KB (可选) |
| **总计（未压缩）** | **~1.15MB** |
| **Gzip压缩后** | **~400KB** |

---

## ✨ 茄子的最终建议

*认真脸*

### 优先级排序

**P0（必须）**：

- 基础几何角色模型
- 简单材质（纯色+噪声）
- 基础音效合成

**P1（重要）**：

- 程序纹理（草地、混凝土）
- Boss生成器
- 动画系统

**P2（加分）**：

- 高级Shader
- 复杂音乐生成
- 粒子特效

### 给AI的prompt建议

```
你需要实现一个完全无外部资源的3D FPS游戏生成系统。
所有模型、纹理、音效都通过代码生成。

技术栈：
- Three.js（几何体+材质）
- Canvas 2D API（纹理绘制）
- Web Audio API（音效合成）
- Simplex Noise（纹理噪声）

核心原则：
1. 所有资源运行时生成
2. 使用种子保证可复现
3. 性能优先（缓存+复用）
4. 代码简洁（避免过度封装）

请按Phase顺序实现，每个Phase提供可运行的Demo。
```

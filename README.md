# 混沌校园2前传：阿奎尔巨兽

Chaos in School 2 Prologue: Aqueridemon

这是一个浏览器端第一人称生存射击游戏。你扮演学生 Samuel，与三名队友（暂时由 AI 控制）在被感染爆发的校园足球场上建立防线：抵御三波尸潮，击败巨型章鱼 Boss 阿奎尔，提取样本，并在 60 秒倒计时内全员登上救援直升机撤离。

## 玩法

- 波次防守：三波逐渐增强的尸潮，包含普通、快速、坦克三种丧尸；波间与 Boss 战期间有空投补给箱，按弹药、武器、医疗包分箱型呈现。
- 小队协同：准星指向队友可查看其状态；血量归零会倒地，15 秒内无人救援则阵亡，Samuel 阵亡直接任务失败。
- Boss 战：阿奎尔有 3000 生命值和两个阶段。硬直时头部核心受 2 倍伤害；狂暴期释放全场冲击波（可跳跃躲避），之后趴倒 3 秒，背部核心受 3 倍伤害。
- 直升机攻防终局：Boss 死亡释放信息素，尸潮源源不断涌向已降落的直升机并啃咬机身；直升机血量归零则任务失败，机身侧门机枪会自动还击。
- 多结局与计分：全员登机并带回样本达成完美结局（HE），否则为普通结局（NE）；Samuel 阵亡、直升机被毁或未按时登机为失败结局（BE）。击杀、爆头与命中分别计分，小队总分加直升机撤离加成，按总分评定青铜、白银、黄金、水晶四档评级。

## 操作

| 按键 | 动作 |
| :--- | :--- |
| WASD / Shift / 空格 | 移动 / 冲刺 / 跳跃 |
| 鼠标 / 左键 / R | 瞄准 / 射击 / 换弹 |
| 1、2 或滚轮 | 切换武器（最多携带 2 把） |
| E | 交互：拾取空投；按住可救援队友（3 秒）、提取样本（3 秒） |
| F | 直升机降落后在机身旁领取弹夹（每人限 6 个） |
| ESC | 暂停 |

爆头造成 2 倍伤害。没有自动回血。

## 武器

AK-47、MG3、MP5、QBZ-95 与反器材狙击枪 Barrett M82A1。开局从中圈南侧的 8 个武器硬箱中随机取得，每人最多开 2 箱；每把武器备弹上限 6 个弹匣，后续补给依靠空投。

## 本地运行

需要 Node.js 与 pnpm。

```bash
pnpm install
pnpm dev        # 打开 http://localhost:5173/
pnpm build      # 抓取字体、类型检查并构建
pnpm preview    # 预览构建产物
```

## 技术栈

本游戏基于 [Momako](https://github.com/momakoding/momako)（momako-san）GameJam 框架制作。

Vue 3（`<script setup>` + TypeScript）、TresJS / Three.js 渲染、Tailwind CSS v4、Pinia、Vue Router、Vue i18n（中英文界面）、Vite 构建。

## 项目结构

| 目录 | 内容 |
| :--- | :--- |
| `src/game/systems/` | 玩家、敌人、Boss、空投、撤离、计分等游戏系统 |
| `src/game/scenes/` | 主场景与数值常量 |
| `src/game/render/` | 渲染管线与主菜单 3D 背景 |
| `src/game/components/` | HUD、结算面板等局内界面组件 |
| `src/pages/` | 主页、玩法介绍、设置、关于、音乐鉴赏页面 |
| `src/contents/meta-info/` | 玩法文案、团队信息等页面内容 |

## 文档

- [游戏设计规范](docs/spec/spec.md)：核心机制、数值与结局判定的基准文档
- [CHANGELOG](CHANGELOG)：版本变更记录

## 许可

本仓库原创内容以 [MIT](LICENSE) 发布；其中来自 [Momako](https://github.com/momakoding/momako) 脚手架的框架代码沿用其原始 MIT 许可（Copyright (c) 2026 Momakoding Team），全文见 [LICENSE](LICENSE) 末尾的第三方声明。

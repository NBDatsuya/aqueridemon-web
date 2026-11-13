/**
 * 游戏元信息（简体中文）— schema 事实源，en.ts 以 `typeof zhCN` 锁定结构一致。
 * 只放数据，类型定义见 ../types.ts。
 *
 * ── 修改指引 ──────────────────────────────────────────
 *  title       游戏名称，显示在主页标题和 About 页游戏卡片
 *  subtitle    副标题（可选），显示在主页标题下方
 *  description 游戏简介（可选），显示在 About 页游戏卡片
 *  tags        游戏标签列表（可选），如 ['动作', '解谜', 'Game Jam']
 * ─────────────────────────────────────────────────────
 */

import type { GameMeta } from '../types'

const zhCN: GameMeta = {
  title: '混乱校园2前传：阿奎尔巨兽',
  subtitle: 'Chaos in School 2 Prologue: Aqueridemon',
  description:
    '感染爆发的校园足球场上，四名学生幸存者必须抵御越来越强的尸潮，击败巨型章鱼Boss阿奎尔，并全员登上救援直升机。所有模型、纹理和音效都由代码生成。',
  tags: ['FPS', '合作生存', '单关Demo', '程序化生成'],
  showGameCard: true, // 填好游戏信息后改为 true，About 页会显示游戏卡片
}

export default zhCN

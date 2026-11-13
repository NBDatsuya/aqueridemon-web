/**
 * Game meta (English) — typed as `typeof zhCN` so structure stays in sync with zh-CN.ts.
 * 新增 key 时先改 zh-CN.ts，再在此文件补齐，否则类型检查会报错。
 */

import type zhCN from './zh-CN'

const en: typeof zhCN = {
  title: 'Chaos in School 2 Prologue',
  subtitle: 'Aqueridemon',
  description:
    'On an infected school football pitch, four student survivors hold off growing zombie waves, defeat the giant octopus boss Aqueridemon and board the rescue helicopter together. Every model, texture and sound is generated in code.',
  tags: ['FPS', 'Co-op survival', 'Single-level demo', 'Procedural'],
  showGameCard: true,
}

export default en

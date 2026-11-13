/**
 * 游戏页的加载状态：开局准备（创建引擎、预编译着色器、预上传贴图）期间显示加载遮罩。
 * 独立于 core/state.ts，那里的 HUD 状态会在每局开始时被引擎整体重置。
 */

import { reactive } from 'vue'

export interface GameLoadingState {
  /** 是否正在加载 */
  active: boolean
  /** 遮罩文案 */
  label: string
}

export const gameLoading = reactive<GameLoadingState>({ active: false, label: '' })

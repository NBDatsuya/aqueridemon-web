/**
 * 游戏页的加载状态：进入游戏（下载游戏代码、创建引擎、生成场地、预编译着色器、预上传贴图）期间显示加载遮罩。
 * 状态与 App 根部的全屏遮罩共用（@/core 的 loadingScreen），跨路由不会断开。
 * 独立于 core/state.ts，那里的 HUD 状态会在每局开始时被引擎整体重置。
 */

export { loadingScreen as gameLoading } from '@/core'

/** 各阶段在遮罩上显示的说明：写当前真正在做的事，不用笼统的“加载中” */
export const LOADING_LABELS = {
  /** TresCanvas 的渲染器与渲染管线 */
  renderer: '正在初始化渲染器…',
  /** 世界系统的前缀，后面接具体阶段名（程序贴图、几何与场地布置） */
  world: '正在生成场地',
  /** 引擎各系统：输入、特效、玩家、队友、敌人、Boss、空投、撤离 */
  systems: '正在搭建战场…',
  /** 着色器变体链接 */
  shaders: '正在编译着色器…',
  /** 贴图上传到显存 */
  textures: '正在上传贴图…',
  /** 首帧：后处理与阴影深度材质 */
  firstFrame: '正在渲染首帧…',
} as const

/** 进入游戏各阶段在总进度条上的终点（0..1）。权重按各阶段实际工作量估计，阶段内部的进度是实测的 */
export const GAME_LOADING_STAGES = {
  /** 游戏代码下载并执行完毕（路由守卫里完成） */
  code: 0.08,
  /** 渲染管线、世界与全部系统创建完毕 */
  engine: 0.45,
  /** 全部着色器编译完毕 */
  shaders: 0.85,
  /** 全部贴图上传完毕 */
  textures: 0.97,
} as const

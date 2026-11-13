/**
 * @momako/core - 全屏加载遮罩状态
 *
 * App 根部只有一个加载遮罩，跨路由常驻：进入游戏时从点击开始一直盖到游戏准备完毕，
 * 中途切换页面不会重新淡入，也不会露出底下的页面。
 * 游戏侧写入 active / label / progress，App 负责渲染并在淡入完成时回报。
 */

import { reactive } from 'vue';

export interface LoadingScreenState {
  /** 是否显示遮罩 */
  active: boolean;
  /** 遮罩文案 */
  label: string;
  /** 进度 0..1 */
  progress: number;
}

export const loadingScreen = reactive<LoadingScreenState>({ active: false, label: '', progress: 0 });

/** 等待遮罩淡入的最长时间（毫秒）：遮罩没有挂载时不至于一直卡住 */
const SHOWN_TIMEOUT = 1000;

let shown = false;
let waiters: Array<() => void> = [];

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * 开始加载并显示遮罩。遮罩已经显示时只更新文案，进度不回退。
 * @param label 遮罩文案
 * @param progress 起始进度 0..1
 */
export function beginLoading(label: string, progress = 0): void {
  const start = clamp01(progress);
  loadingScreen.label = label;
  loadingScreen.progress = loadingScreen.active ? Math.max(loadingScreen.progress, start) : start;
  loadingScreen.active = true;
}

/** 推进进度（0..1）；只增不减 */
export function setLoadingProgress(progress: number): void {
  loadingScreen.progress = Math.max(loadingScreen.progress, clamp01(progress));
}

/** 更新遮罩文案（各加载阶段写自己的说明，例如“正在编译着色器…”） */
export function setLoadingLabel(label: string): void {
  loadingScreen.label = label;
}

/** 结束加载，撤掉遮罩 */
export function endLoading(): void {
  loadingScreen.active = false;
}

/** 遮罩淡入完成（由渲染遮罩的组件调用） */
export function notifyLoadingScreenShown(): void {
  shown = true;
  const pending = waiters;
  waiters = [];
  pending.forEach((resolve) => resolve());
}

/** 遮罩开始淡出（由渲染遮罩的组件调用） */
export function notifyLoadingScreenHidden(): void {
  shown = false;
}

/** 等遮罩完全不透明（已显示则立即返回），超时也返回 */
export function waitLoadingScreenShown(): Promise<void> {
  if (shown) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      waiters = waiters.filter((waiter) => waiter !== finish);
      resolve();
    };
    waiters.push(finish);
    window.setTimeout(finish, SHOWN_TIMEOUT);
  });
}

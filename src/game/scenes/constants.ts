/**
 * 画布与相机的视觉常量。玩法数值见 ../core/config.ts。
 */

/** 画布清屏颜色（天空穹顶加载前的底色） */
export const CLEAR_COLOR = '#9fc4e4'

/** 第一人称视场角（度） */
export const CAMERA_FOV = 75

/** 近裁剪面：要小到能容下贴近相机的第一人称武器模型 */
export const CAMERA_NEAR = 0.05

/** 远裁剪面：直升机从约 350m 外飞来 */
export const CAMERA_FAR = 800

/** 设备像素比范围（限制上限以保证帧率） */
export const CANVAS_DPR: [number, number] = [1, 1.5]

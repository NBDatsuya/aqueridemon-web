/**
 * 画质档位。默认 auto：从高画质起步，帧率持续过低时由渲染管线逐级降档。
 * 可用地址参数固定档位，例如 #/game?quality=high（调试与截图用）。
 */

export type RenderQuality = 'high' | 'medium' | 'low'

export interface QualityProfile {
  /** 是否走后处理管线（HDR 缓冲 + 泛光 + 色调映射） */
  post: boolean
  /** 环境光遮蔽（需要额外渲染一遍场景） */
  ao: boolean
  /** 后处理缓冲的 MSAA 采样数 */
  samples: number
  /** 太阳阴影贴图边长 */
  shadowMapSize: number
}

export const QUALITY_PROFILES: Record<RenderQuality, QualityProfile> = {
  high: { post: true, ao: true, samples: 4, shadowMapSize: 4096 },
  medium: { post: true, ao: false, samples: 4, shadowMapSize: 2048 },
  low: { post: false, ao: false, samples: 0, shadowMapSize: 2048 },
}

/** 低于该帧率并持续 DOWNGRADE_SECONDS 秒时降一档 */
export const DOWNGRADE_FPS = 26
export const DOWNGRADE_SECONDS = 4

/** 地址参数里固定的画质档位；没有或不合法时返回 null（即 auto） */
export function forcedQuality(): RenderQuality | null {
  if (typeof window === 'undefined') return null
  const query = window.location.hash.split('?')[1] ?? window.location.search.slice(1)
  const value = new URLSearchParams(query).get('quality')
  return value === 'high' || value === 'medium' || value === 'low' ? value : null
}

/** 开局时使用的画质档位 */
export function initialQuality(): RenderQuality {
  return forcedQuality() ?? 'high'
}

/**
 * 当前画质档位（渲染管线写入）。世界系统在创建阴影光源时读取，
 * 这样重新开始一局时会沿用已经降过的档位。
 */
export const renderState: { quality: RenderQuality } = { quality: 'high' }

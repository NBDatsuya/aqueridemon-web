/**
 * 菜单 UI 音效（CS 1.6 菜单式的悬停“嗒”声）。用 Web Audio 振荡器现场合成，不依赖音频文件与游戏音频系统。
 * 浏览器要求用户手势后才能出声：第一次点击或按键之前的悬停不发声。
 */

import { useSettingsStore } from '../stores';

/** 悬停音的峰值增益（音效音量 100% 时） */
const HOVER_GAIN = 0.12;
/** 悬停音时长（秒） */
const HOVER_DURATION = 0.05;
/** 起止频率（Hz）：短促下滑，听起来是轻微的“嗒” */
const HOVER_FREQ_FROM = 1500;
const HOVER_FREQ_TO = 900;
/** 两次悬停音的最小间隔（秒）：鼠标快速扫过整列菜单时不连成一串 */
const HOVER_THROTTLE = 0.04;

let context: AudioContext | null = null;
let unlockInstalled = false;
let lastHoverAt = -Infinity;

/** 在用户手势里创建或恢复 AudioContext；手势之外创建会被浏览器挂起并报警告 */
function unlock(): void {
  if (!context) {
    if (typeof window.AudioContext !== 'function') return;
    context = new window.AudioContext();
  }
  if (context.state === 'suspended') void context.resume();
}

function installUnlock(): void {
  if (unlockInstalled) return;
  unlockInstalled = true;
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

/**
 * 菜单音效。音量跟随设置里的音效音量与静音开关。
 * @returns playHover：悬停菜单项时调用
 */
export function useUiSound() {
  const settings = useSettingsStore();
  installUnlock();

  const playHover = (): void => {
    const ctx = context;
    if (!ctx || ctx.state !== 'running') return;
    if (settings.muted || settings.sfxVolume <= 0) return;
    const now = ctx.currentTime;
    if (now - lastHoverAt < HOVER_THROTTLE) return;
    lastHoverAt = now;

    const peak = HOVER_GAIN * Math.min(1, settings.sfxVolume / 100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(HOVER_FREQ_FROM, now);
    osc.frequency.exponentialRampToValueAtTime(HOVER_FREQ_TO, now + HOVER_DURATION * 0.6);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + HOVER_DURATION);

    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => gain.disconnect();
    osc.start(now);
    osc.stop(now + HOVER_DURATION + 0.01);
  };

  return { playHover };
}

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { createJamI18n } from '@/hud';
import { beginLoading, endLoading, waitLoadingScreenShown } from '@/core';
import { preloadGamePage, router } from './router';
import App from './App.vue';
import { META_MESSAGES, getHowToPlayMarkdown, getOssCredits } from '@/contents/meta-info';
import './style.css';

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const i18n = createJamI18n({
  messages: META_MESSAGES,
});

const app = createApp(App);
app.provide('jam:get-how-to-play', getHowToPlayMarkdown);
app.provide('jam:get-oss-credits', getOssCredits);
// 标题菜单实时 3D 背景：动态 import，three 与游戏代码不进主包
let titleBackdrop: Promise<typeof import('@/game/render/title-backdrop')> | null = null;
const loadTitleBackdrop = () =>
  (titleBackdrop ??= import('@/game/render/title-backdrop').catch((error: unknown) => {
    // 加载失败不缓存，下次进入菜单重试
    titleBackdrop = null;
    throw error;
  }));
/** 已加载的背景模块；灯光脉动每帧调用，不经过 Promise */
let titleBackdropModule: typeof import('@/game/render/title-backdrop') | null = null;
/** 背景代码下载完在首屏进度条上的位置：之后才是建场地、编译着色器、上传贴图 */
const BACKDROP_CODE_PROGRESS = 0.06;
/** 下载背景与 three 时的文案 */
const BACKDROP_CODE_LABEL = '正在加载渲染引擎…';
app.provide(
  'jam:mount-title-backdrop',
  (host: HTMLElement, onProgress: (ratio: number, label?: string) => void) => {
    onProgress(0, BACKDROP_CODE_LABEL);
    return loadTitleBackdrop().then((m) => {
      titleBackdropModule = m;
      onProgress(BACKDROP_CODE_PROGRESS, BACKDROP_CODE_LABEL);
      // 背景模块内部的进度与文案只占剩下的区间
      return m.mountTitleBackdrop(host, (ratio, label) =>
        onProgress(BACKDROP_CODE_PROGRESS + (1 - BACKDROP_CODE_PROGRESS) * ratio, label),
      );
    });
  },
);
// 音乐鉴赏：背景灯光随节拍变亮（背景还没加载时忽略）
app.provide('jam:set-backdrop-pulse', (level: number) => {
  titleBackdropModule?.setTitleBackdropPulse(level);
});
// 音乐鉴赏的播放器：动态 import，只带音频生成代码
app.provide('jam:load-music-gallery', () => import('@/game/generators/audio/gallery'));
// 标题菜单 BGM（原版 Boss 曲）：同样动态 import
app.provide('jam:load-menu-music', () => import('@/game/generators/audio/menu-music'));
// 进入游戏：点击后立刻盖上全屏加载遮罩，等它完全不透明再释放背景画布、提交导航。
// 顺序很重要——旧实现在遮罩淡入之前就撤掉背景，页面底色又是透明的，会闪一下白底，
// 之后才看到游戏自己的遮罩淡入，中间那几百毫秒会露出没准备好的画面。
// 现在遮罩从点击那一刻一直盖到游戏准备完毕（进度与文案由游戏侧接着写），跨路由不断开
const GAME_ENTER_LABEL = '正在下载游戏代码…';
router.beforeEach(async (to) => {
  if (to.name !== 'game') return true;
  beginLoading(GAME_ENTER_LABEL, 0);
  try {
    // 路由组件工厂用的是同一个模块，不会重复下载；执行模块会占住主线程，所以放在等遮罩之前
    await preloadGamePage();
  } catch (error) {
    // 游戏代码没下载下来，导航会被拒绝，撤掉遮罩把菜单还回来
    endLoading();
    throw error;
  }
  await waitLoadingScreenShown();
  // 遮罩已经盖住，这时释放背景的渲染器与场地，不和游戏渲染器同时占显存
  if (titleBackdrop) {
    await titleBackdrop.then((m) => m.disposeTitleBackdrop()).catch(() => {});
  }
  return true;
});
app.use(pinia);
app.use(router);
app.use(i18n);
app.mount('#app');

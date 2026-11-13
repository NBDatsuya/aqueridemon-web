import { createApp } from 'vue';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { createJamI18n } from '@/hud';
import { router } from './router';
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
app.provide('jam:mount-title-backdrop', (host: HTMLElement) =>
  loadTitleBackdrop().then((m) => {
    titleBackdropModule = m;
    return m.mountTitleBackdrop(host);
  }),
);
// 音乐鉴赏：背景灯光随节拍变亮（背景还没加载时忽略）
app.provide('jam:set-backdrop-pulse', (level: number) => {
  titleBackdropModule?.setTitleBackdropPulse(level);
});
// 音乐鉴赏的播放器：动态 import，只带音频生成代码
app.provide('jam:load-music-gallery', () => import('@/game/generators/audio/gallery'));
// 标题菜单 BGM（原版 Boss 曲）：同样动态 import
app.provide('jam:load-menu-music', () => import('@/game/generators/audio/menu-music'));
// 进入游戏前释放背景的渲染器与场地，不和游戏渲染器同时占显存
router.beforeEach((to) => {
  if (to.name === 'game' && titleBackdrop) {
    titleBackdrop.then((m) => m.disposeTitleBackdrop()).catch(() => {});
  }
});
app.use(pinia);
app.use(router);
app.use(i18n);
app.mount('#app');

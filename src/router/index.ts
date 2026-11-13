import { createRouter, createWebHashHistory } from 'vue-router';
import { HomePage, HowToPlayPage, SettingsPage, AboutUsPage, MusicGalleryPage } from '@/hud';

/** 游戏页组件工厂：three 与全部游戏代码只在进入游戏时下载，菜单页不受游戏模块影响 */
const loadGamePage = () => import('@/game').then((m) => m.GamePage);

/**
 * 供 main.ts 的路由守卫提前触发下载（守卫里先盖上加载遮罩再等它）。
 * 模块加载器会缓存结果，路由组件工厂随后再调用一次不会重复下载。
 */
export const preloadGamePage = loadGamePage;

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/how-to-play', name: 'how-to-play', component: HowToPlayPage },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/about-us', name: 'about-us', component: AboutUsPage },
    { path: '/music-gallery', name: 'music-gallery', component: MusicGalleryPage },
    // 游戏页懒加载
    { path: '/game', name: 'game', component: loadGamePage },
  ],
});

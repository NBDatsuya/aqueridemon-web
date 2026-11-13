import { createRouter, createWebHashHistory } from 'vue-router';
import { HomePage, HowToPlayPage, SettingsPage, AboutUsPage, MusicGalleryPage } from '@/hud';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/how-to-play', name: 'how-to-play', component: HowToPlayPage },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/about-us', name: 'about-us', component: AboutUsPage },
    { path: '/music-gallery', name: 'music-gallery', component: MusicGalleryPage },
    // 游戏页懒加载：three 与全部游戏代码只在进入游戏时下载，菜单页不受游戏模块影响
    { path: '/game', name: 'game', component: () => import('@/game').then((m) => m.GamePage) },
  ],
});

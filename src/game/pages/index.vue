<template>
  <GameShellLayout ref="shell" :show-score="false" :show-round="false">
    <template #game>
      <div class="game-page__canvas">
        <TresCanvas window-size shadows :clear-color="CLEAR_COLOR" :dpr="CANVAS_DPR">
          <MainScene />
        </TresCanvas>
        <GameHud v-if="!hud.ending" />
        <WeaponReplace v-if="hud.weaponChoice" :choice="hud.weaponChoice" />
        <CheatWindow v-if="hud.cheatOpen" />
        <EndingScreen v-if="hud.ending" :ending="hud.ending" />
      </div>
    </template>
  </GameShellLayout>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { TresCanvas } from '@tresjs/core';
import { beginLoading } from '@/core';
import { GameShellLayout } from '@/hud';
import { CheatWindow, EndingScreen, GameHud, WeaponReplace } from '../components';
import { GAME_LOADING_STAGES, LOADING_LABELS } from '../core/loading';
import { hud } from '../core/state';
import { CANVAS_DPR, CLEAR_COLOR, MainScene } from '../scenes';

// 进入游戏页时先盖上遮罩（App 根部那一个，跨路由常驻），等场景组件挂载并接管加载流程。
// 直开 /game 时路由守卫已经打开遮罩，这里只是把文案换成当前阶段
beginLoading(LOADING_LABELS.renderer, GAME_LOADING_STAGES.code);

const shell = ref<InstanceType<typeof GameShellLayout> | null>(null);

// 游戏中按 ESC 只会让浏览器退出指针锁定；引擎检测到后在这里直接打开暂停菜单
watch(
  () => hud.pauseRequest,
  () => shell.value?.pause(),
);
</script>

<style scoped>
@reference "@/style.css";

.game-page__canvas {
  @apply relative h-full w-full overflow-hidden;
}
</style>

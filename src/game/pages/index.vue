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
        <LoadingOverlay :active="gameLoading.active" :label="gameLoading.label || LOADING_LABEL" />
      </div>
    </template>
  </GameShellLayout>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { TresCanvas } from '@tresjs/core';
import { GameShellLayout, LoadingOverlay } from '@/hud';
import { CheatWindow, EndingScreen, GameHud, WeaponReplace } from '../components';
import { gameLoading } from '../core/loading';
import { hud } from '../core/state';
import { CANVAS_DPR, CLEAR_COLOR, MainScene } from '../scenes';

const LOADING_LABEL = '正在加载战场…';

// 进入游戏页时先盖上遮罩，等场景组件挂载并接管加载流程（它在准备完成或卸载时撤掉遮罩）
gameLoading.label = LOADING_LABEL;
gameLoading.active = true;

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

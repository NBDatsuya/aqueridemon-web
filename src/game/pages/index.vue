<template>
  <GameShellLayout ref="shell" :show-score="false" :show-round="false">
    <template #game>
      <div class="game-page__canvas">
        <TresCanvas window-size shadows :clear-color="CLEAR_COLOR" :dpr="CANVAS_DPR">
          <MainScene />
        </TresCanvas>
        <GameHud v-if="hud.phase !== 'select' && !hud.ending" />
        <WeaponSelect v-if="hud.phase === 'select'" />
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
import { GameShellLayout } from '@/hud';
import { CheatWindow, EndingScreen, GameHud, WeaponReplace, WeaponSelect } from '../components';
import { hud } from '../core/state';
import { CANVAS_DPR, CLEAR_COLOR, MainScene } from '../scenes';

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

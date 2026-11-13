/**
 * 模型工厂入口：把各模型生成器汇总成 ActorModels，由引擎放进 GameContext.models。
 * 场景道具（props.ts）由世界系统直接引用，不经过这里。
 */

import type { ActorModels } from '../../core/types'
import { createAirdrop } from './airdrop'
import { createBossRig } from './boss'
import { createCharacter } from './character'
import { createHelicopter } from './helicopter'
import { createMedkitCrate } from './medkit-crate'
import { createWeapon } from './weapon'
import { createWeaponCrate } from './weapon-crate'
import { createZombie } from './zombie'

/** 角色 / 敌人 / 武器 / Boss / 直升机 / 空投箱 / 主武器箱 / 医疗包箱的程序化模型工厂 */
export const actorModels: ActorModels = {
  createCharacter,
  createZombie,
  createWeapon,
  createBoss: createBossRig,
  createHelicopter,
  createAirdrop,
  createWeaponCrate,
  createMedkitCrate,
}

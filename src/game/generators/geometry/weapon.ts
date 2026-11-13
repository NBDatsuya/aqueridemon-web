/**
 * 武器模型：AK-47 / MG3 / MP5 / QBZ-95。
 *
 * 约定：root 原点在握把顶端（虎口位置），枪管朝本地 +Z，+Y 向上；枪的左侧是 +X、右侧（抛壳口）是 -X。
 * 每个型号由 weapon-*.ts 生成一份蓝图：侧面轮廓挤出（带倒角）、截面放样与车削得到的零件按材质合并，
 * 一把枪 3–5 个网格。蓝图模块级懒创建，几何体由同型号的所有实例共享、永不释放；
 * 材质每个实例独占，dispose 时释放；贴图来自 PBR 表面库（共享，不释放）。
 */

import { Group, Mesh, Object3D } from 'three'
import type { MeshStandardMaterial } from 'three'
import type { WeaponId, WeaponRig } from '../../core/types'
import { createSurfaceMaterial } from '../textures/pbr'
import { buildAk47 } from './weapon-ak47'
import type { WeaponBlueprint } from './weapon-kit'
import { buildMg3 } from './weapon-mg3'
import { buildMp5 } from './weapon-mp5'
import { buildQbz95 } from './weapon-qbz95'

/** 各型号的蓝图生成函数 */
const BLUEPRINTS: Record<WeaponId, () => WeaponBlueprint> = {
  ak47: buildAk47,
  mg3: buildMg3,
  mp5: buildMp5,
  qbz95: buildQbz95,
}

/** 各型号的蓝图缓存：几何体由同型号的所有实例共享，永不释放 */
const blueprintCache = new Map<WeaponId, WeaponBlueprint>()

/** 取得（首次使用时生成）某型号的蓝图 */
function blueprintOf(id: WeaponId): WeaponBlueprint {
  let blueprint = blueprintCache.get(id)
  if (!blueprint) {
    blueprint = BLUEPRINTS[id]()
    blueprintCache.set(id, blueprint)
  }
  return blueprint
}

/**
 * 创建一把武器模型。
 * @param id 武器型号
 * @returns 武器绑定：root 原点在握把，枪管朝本地 +Z；muzzle 为枪口处的空节点
 */
export function createWeapon(id: WeaponId): WeaponRig {
  const root = new Group()
  root.name = `weapon-${id}`
  const materials: MeshStandardMaterial[] = []

  // 每个材质图层一个网格：几何体共享，材质本实例独占
  const blueprint = blueprintOf(id)
  blueprint.layers.forEach((layer, index) => {
    const mat = createSurfaceMaterial(layer.kind, layer.options)
    materials.push(mat)
    const mesh = new Mesh(layer.geometry, mat)
    mesh.name = `${id}-${index}-${layer.kind}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    root.add(mesh)
  })

  const muzzle = new Object3D()
  muzzle.name = 'muzzle'
  muzzle.position.set(0, blueprint.muzzle[1], blueprint.muzzle[0])
  root.add(muzzle)

  return {
    id,
    root,
    muzzle,
    dispose() {
      root.removeFromParent()
      for (const mat of materials) mat.dispose()
      materials.length = 0
    },
  }
}

/**
 * CIS2 Prologue 全局契约：类型与系统接口。
 *
 * 架构：TresCanvas 提供 scene / camera / renderer，GameEngine（systems/engine.ts）按固定顺序创建各系统并每帧调用 update。
 * 各系统只依赖 core/ 与 utils/，彼此只通过 GameContext 上的接口和 events 互相访问，不直接 import 对方的实现文件。
 * HUD（Vue）只读 core/state.ts 的响应式状态，由引擎统一同步；各系统不接触 Vue。
 *
 * 坐标约定：Y 向上；+X 东（体育馆），-X 西（教学楼）；-Z 北（后山），+Z 南（校门）。单位：米、秒、弧度。
 * 模型约定：原点在脚底 / 底面中心，正面朝本地 +Z。朝向水平方向 d 时 root.rotation.y = Math.atan2(d.x, d.z)。
 * 位置约定：Combatant / EnemyActor 的 position 均为脚底世界坐标。
 */

import type { Group, Object3D, PerspectiveCamera, Scene, Texture, Vector3, WebGLRenderer } from 'three'
import type { Rng } from '../utils/random'

/* ── 基础枚举 ── */

export type WeaponId = 'ak47' | 'mg3' | 'mp5' | 'qbz95' | 'barrett'
/** 小队编号：0 = 主控，1..3 = AI 队友；名字只在 config 的 CHARACTERS 里设置 */
export type CharacterId = 0 | 1 | 2 | 3
export type TeammateId = Exclude<CharacterId, 0>
export type EnemyType = 'common' | 'runner' | 'tank'
/** alive 可行动；downed 倒地待救；dead 阵亡；boarded 已登机（锁定） */
export type ActorStatus = 'alive' | 'downed' | 'dead' | 'boarded'
export type GamePhase = 'prep' | 'wave' | 'boss' | 'evac' | 'ending'
export type EndingKind = 'HE' | 'NE_CASUALTY' | 'NE_NO_SAMPLE' | 'BE'
export type DamageSource =
  | 'common'
  | 'runner'
  | 'tank'
  | 'bossSweep'
  | 'bossStab'
  | 'bossPoison'
  | 'bossShockwave'
  | 'abandoned'
export type BossZone = 'body' | 'tentacle' | 'headCore' | 'backCore'
/** 当前暴露的弱点：head = 硬直期头部核心；back = 冲击波后趴倒的背部核心 */
export type BossWeakWindow = 'none' | 'head' | 'back'
export type HeliState = 'absent' | 'approaching' | 'hovering' | 'descending' | 'landed' | 'departing' | 'departed'
export type SpawnSide = 'north' | 'east' | 'south' | 'west'
export type TextureKind = 'grass' | 'concrete' | 'metal' | 'rust' | 'skin' | 'blood' | 'cloth' | 'wood' | 'asphalt'

/* ── 数据定义（数值在 config.ts） ── */

export interface WeaponDef {
  id: WeaponId
  name: string
  /** 类型文案 */
  kind: string
  /** 特点文案（设计说明，暂无界面使用） */
  trait: string
  damage: number
  rpm: number
  magSize: number
  /** 备弹上限（6 个弹匣） */
  reserveMax: number
  reloadTime: number
  /** 伤害开始衰减的距离 */
  falloffStart: number
  /** 伤害衰减到 falloffMin 倍的距离 */
  falloffEnd: number
  falloffMin: number
  /** 后坐力系数（低 0.6 / 中 1 / 高 1.5） */
  recoil: number
  /** 基础散布（弧度） */
  spread: number
  /** 持枪移动速度倍率 */
  moveMul: number
}

export interface WeaponState {
  id: WeaponId
  /** 弹匣内子弹 */
  mag: number
  /** 备弹 */
  reserve: number
}

export interface CharacterDef {
  id: CharacterId
  name: string
  isPlayer: boolean
  /** 身体主色 */
  bodyColor: number
  /** 腿部颜色 */
  legColor: number
  /** 头部 / 皮肤颜色 */
  headColor: number
  /** 点缀色（袖标、口罩、马尾等） */
  accentColor: number
  /** 身体宽度倍率 */
  bodyScale: number
  /** HUD 中的代表色（CSS 颜色） */
  hudColor: string
}

export interface TeammateAiDef {
  /** 射击距离阈值 */
  engageRange: number
  headshotRate: number
  /** 周围敌人数小于该值才去救人；Infinity 表示无视敌人 */
  rescueEnemyLimit: number
  /** 弹匣比例低于该值时找机会换弹 */
  reloadThreshold: number
  preferredWeapons: WeaponId[]
  style: 'aggressive' | 'support' | 'flank'
  /** 跟随槽位：相对主控朝向的右 / 前偏移（米） */
  followRight: number
  followForward: number
  moveSpeed: number
  /** 自主站位：离主控的距离带（米） */
  postMin: number
  postMax: number
  /** 自主站位相对主控朝向的偏好方位（弧度）：0 正前方，正值偏右，π 正后方 */
  postBearing: number
  /** 交战时离主控的最远距离（米），超出后回到自己的站位 */
  leash: number
}

export interface EnemyDef {
  type: EnemyType
  name: string
  hp: number
  speed: number
  damage: number
  attackInterval: number
  /** 攻击前摇（秒） */
  windup: number
  /** 距离目标表面多近可发起攻击 */
  attackReach: number
  /** 命中时击退距离（米） */
  knockback: number
  radius: number
  height: number
  /** 模型整体缩放 */
  scale: number
}

export interface WaveStage {
  /** 距波次开始多少秒后投入本批（场上敌人很少时会提前投入） */
  at: number
  spawn: Partial<Record<EnemyType, number>>
}

export interface WaveDef {
  wave: number
  stages: WaveStage[]
  /** 本波结束后的空投数量 */
  airdrops: number
}

export interface SpawnPoint {
  id: string
  side: SpawnSide
  x: number
  z: number
}

/* ── 战斗单位 ── */

/** 四人小队成员（主控或 AI 队友）。实现见 core/combatant.ts 的 CombatantBase。 */
export interface Combatant {
  readonly id: CharacterId
  readonly name: string
  readonly isPlayer: boolean
  /** 脚底世界坐标 */
  readonly position: Vector3
  /** 当前水平速度（m/s），由所有者每帧写入，供 AI / 动画 / 命中率参考 */
  readonly velocity: Vector3
  /** 残余击退速度，由所有者的移动代码用 consumeKnockback 积分 */
  readonly knockback: Vector3
  readonly radius: number
  status: ActorStatus
  hp: number
  /** 倒地剩余秒数 */
  downedTimer: number
  /** 无敌剩余秒数（被救起后） */
  invulnTimer: number
  /** 眩晕剩余秒数（眩晕时不能移动 / 射击 / 交互） */
  stunTimer: number
  /** 是否离地（跳跃中），用于躲避冲击波 */
  airborne: boolean
  hasSample: boolean
  weapons: WeaponState[]
  currentWeapon: number
  readonly weapon: WeaponState | undefined
  /** 正在救援自己的人（避免多人同时救同一人） */
  rescuer: CharacterId | null
  /** 每次受伤 +1。读条开始时记下该值，变化即表示被打断 */
  damageSerial: number
  /** 受到伤害。非 alive、无敌或 amount<=0 时无效，返回是否生效。HP 归零自动倒地 */
  takeDamage(amount: number, source: DamageSource): boolean
  /** 沿水平方向 (dirX, dirZ) 击退 distance 米 */
  applyKnockback(dirX: number, dirZ: number, distance: number): void
  /** 取出本帧击退位移并衰减残余速度；out 的 y 恒为 0 */
  consumeKnockback(dt: number, out: Vector3): Vector3
  stun(seconds: number): void
  /** 回血。overheal 为 true 时可超过最大 HP（上限见 PLAYER.overhealMax） */
  heal(amount: number, overheal?: boolean): void
  /** 被救起：恢复 REVIVE HP 并获得短暂无敌 */
  revive(): void
  /** 直接阵亡（倒地超时、未登机等） */
  die(source: DamageSource): void
  /** 登机并锁定 */
  board(): void
  /**
   * 获得武器。已有同型号 → 补满弹药返回 'refilled'；未满 2 把 → 加入并返回 'added'；
   * 已满且为新型号 → 不改动并返回 'full'（由调用方决定替换哪一把）。
   */
  giveWeapon(id: WeaponId): 'added' | 'refilled' | 'full'
  /** 把指定槽位换成满弹的新武器 */
  replaceWeapon(slot: number, id: WeaponId): void
  /** 补满指定槽位（默认当前武器）的弹匣与备弹 */
  refillWeapon(slot?: number): void
  /** 推进倒地 / 无敌 / 眩晕计时；倒地超时自动阵亡。由所有者每帧调用一次 */
  tickStatus(dt: number): void
}

/** 场上的一只丧尸 */
export interface EnemyActor {
  readonly id: number
  readonly type: EnemyType
  /** 脚底世界坐标 */
  readonly position: Vector3
  readonly radius: number
  readonly height: number
  hp: number
  maxHp: number
  alive: boolean
  /** 头部中心世界坐标 */
  headCenter(out: Vector3): Vector3
  /** 躯干中心世界坐标（AI 瞄准点） */
  aimCenter(out: Vector3): Vector3
}

export interface DamageInfo {
  /** 攻击者；null 表示环境 */
  attacker: CharacterId | null
  headshot: boolean
  /** 命中点（可选，用于特效） */
  point?: Vector3
  /** 子弹方向（可选，用于受击反馈） */
  direction?: Vector3
}

/** 射线命中结果。各系统可复用自己的内部对象，调用方必须立即使用，不要保存引用 */
export interface RayHit {
  distance: number
  point: Vector3
  normal: Vector3
  kind: 'world' | 'enemy' | 'boss'
  enemy?: EnemyActor
  headshot?: boolean
  bossZone?: BossZone
}

/* ── 程序化模型（generators/geometry） ── */

export type HumanoidPose = 'stand' | 'downed' | 'dead'
export type HumanoidAction = 'none' | 'attack' | 'shoot' | 'reload' | 'interact'

export interface HumanoidAnimInput {
  /** 水平移动速度（m/s），决定待机 / 行走 / 奔跑循环；downed 时表示爬行速度 */
  speed: number
  pose: HumanoidPose
  action: HumanoidAction
  /** 当前 action 的进度 0..1（attack：0 前摇开始，约 0.5 击中，1 收招） */
  actionProgress: number
  /** 是否举枪瞄准（双臂前举） */
  aiming?: boolean
  /** 瞄准俯仰（弧度，向上为正） */
  aimPitch?: number
}

/** 人形绑定：四名角色与三种丧尸共用。动画完全由 update 驱动，逻辑层不直接动骨骼 */
export interface HumanoidRig {
  /** 原点在脚底，正面朝 +Z */
  readonly root: Group
  /** 站立总高度（已含缩放） */
  readonly height: number
  /** 站立时头部中心相对脚底的高度（已含缩放） */
  readonly headHeight: number
  readonly headRadius: number
  /** 当前所持武器的枪口；未持枪为 null */
  readonly muzzle: Object3D | null
  /** 把武器装到右手（传 null 卸下）。丧尸调用无效果 */
  attachWeapon(weapon: WeaponRig | null): void
  update(dt: number, anim: HumanoidAnimInput): void
  /** 受击闪烁反馈 */
  flash(): void
  /** 复位到初始姿态（对象池复用时调用） */
  reset(): void
  dispose(): void
}

export interface WeaponRig {
  readonly id: WeaponId
  /** 原点在握把，枪管朝 +Z */
  readonly root: Group
  /** 枪口挂点（取世界坐标生成枪口火光） */
  readonly muzzle: Object3D
  dispose(): void
}

export type BossAnimMode =
  | 'emerge'
  | 'idle'
  | 'crawl'
  | 'sweepWindup'
  | 'sweep'
  | 'stabWindup'
  | 'stab'
  | 'spitWindup'
  | 'spit'
  | 'summon'
  | 'stagger'
  | 'roar'
  | 'shockCharge'
  | 'shockRelease'
  | 'prone'
  | 'dying'
  | 'dead'

export interface BossAnimInput {
  mode: BossAnimMode
  /** 当前 mode 的进度 0..1 */
  progress: number
  /** 是否已狂暴（皮肤深红、动作更剧烈） */
  enraged: boolean
  /** 当前移动速度（m/s） */
  moveSpeed: number
  /** 突刺 / 喷射的目标点（世界坐标） */
  target?: Vector3
}

export interface BossHitSphere {
  /** 世界坐标球心 */
  center: Vector3
  radius: number
  zone: BossZone
}

export interface BossRig {
  /** 原点在地面，正面朝 +Z */
  readonly root: Group
  /** 命中判定用的世界空间球体，每次 update 后刷新。数组与元素被复用 */
  getHitSpheres(): readonly BossHitSphere[]
  headCoreWorld(out: Vector3): Vector3
  backCoreWorld(out: Vector3): Vector3
  /** 第 index 条触手的尖端世界坐标（0..7） */
  tentacleTipWorld(index: number, out: Vector3): Vector3
  update(dt: number, anim: BossAnimInput): void
  /** 受击闪烁；命中弱点时更亮 */
  flash(zone: BossZone): void
  dispose(): void
}

export interface HelicopterAnimInput {
  /** 旋翼转速 0..1 */
  rotor: number
  /** 舱门开度 0（关）..1（全开） */
  door: number
  /** 舱内红灯是否闪烁 */
  cabinLight: boolean
}

export interface HelicopterRig {
  /** 原点在起落架底部中心，机头朝 +Z */
  readonly root: Group
  /** 主控相机锚点：主控座位（seats[playerSeat]）上方的坐姿眼高，本地 +Z 朝向舱门 */
  readonly seat: Object3D
  /**
   * 舱内全部座位的坐姿锚点：原点是骨盆落座的位置（坐垫顶面），本地 +Z 朝向舱门、+Y 向上。
   * 人形模型（原点在脚底、正面朝 +Z）挂在这里再摆成坐姿即可
   */
  readonly seats: readonly Object3D[]
  /** 主控座位在 seats 里的下标 */
  readonly playerSeat: number
  /** 舱门外的登机点（角色跑向这里） */
  readonly doorPoint: Object3D
  update(dt: number, anim: HelicopterAnimInput): void
  dispose(): void
}

export interface AirdropAnimInput {
  /** 降落伞张开程度 0..1（落地后传 0 让伞塌落消失） */
  parachute: number
  landed: boolean
}

export interface AirdropRig {
  /** 原点在箱底中心 */
  readonly root: Group
  /** 箱体约略边长（米） */
  readonly size: number
  update(dt: number, anim: AirdropAnimInput): void
  dispose(): void
}

/** 箱类模型选项 */
export interface CrateModelOptions {
  /** 是否带降落伞（空投变体）；摆在地上的箱子不传，默认 false */
  parachute?: boolean
}

/** 角色 / 敌人 / 载具等模型工厂（generators/geometry/index.ts 导出 actorModels） */
export interface ActorModels {
  createCharacter(id: CharacterId): HumanoidRig
  /** seed 决定歪斜角度、肤色与破损等变体 */
  createZombie(type: EnemyType, seed: number): HumanoidRig
  createWeapon(id: WeaponId): WeaponRig
  createBoss(): BossRig
  createHelicopter(): HelicopterRig
  createAirdrop(): AirdropRig
  /** 主武器箱：与空投补给箱是不同的模型；parachute 为 true 时带伞 */
  createWeaponCrate(options?: CrateModelOptions): AirdropRig
  /** 医疗包箱：白箱蓝十字；parachute 为 true 时带伞 */
  createMedkitCrate(options?: CrateModelOptions): AirdropRig
}

/** 程序纹理入口（generators/textures/index.ts 导出 getTexture）。同 kind + seed 只生成一次 */
export type GetTexture = (kind: TextureKind, seed?: number) => Texture

/* ── 音频（generators/audio） ── */

export type SfxId =
  | 'shot_ak47'
  | 'shot_mg3'
  | 'shot_mp5'
  | 'shot_qbz95'
  | 'shot_barrett'
  | 'dry'
  | 'reload'
  | 'shell'
  | 'switch'
  | 'pickup'
  | 'click'
  | 'hit'
  | 'headshot'
  | 'voice_headshot_kill'
  | 'footstep'
  | 'hurt'
  | 'body_fall'
  | 'downed_alert'
  | 'revive'
  | 'zombie_groan'
  | 'zombie_attack'
  | 'zombie_die'
  | 'zombie_alert'
  | 'zombie_hurt'
  | 'zombie_step'
  | 'runner_screech'
  | 'runner_attack'
  | 'runner_hurt'
  | 'tank_roar'
  | 'tank_step'
  | 'tank_slam'
  | 'tank_die'
  | 'tank_hurt'
  | 'boss_roar'
  | 'boss_sweep'
  | 'boss_stab'
  | 'boss_spit'
  | 'boss_summon'
  | 'boss_charge'
  | 'boss_shockwave'
  | 'boss_hurt'
  | 'boss_die'
  | 'plane'
  | 'crate_land'
  | 'tick'
  | 'heartbeat'
  | 'wave_clear'
  | 'wave_start'

export type MusicTrack = 'none' | 'menu' | 'title' | 'battle' | 'intermission' | 'boss' | 'he' | 'ne' | 'be'

export interface SfxOptions {
  /** 世界坐标；给出则按距离衰减并做左右声像，不给则为 2D 音效 */
  position?: Vector3
  /** 音量倍率，默认 1 */
  volume?: number
  /** 播放速率，默认 1；可加少量随机避免机械感 */
  rate?: number
}

export interface AudioSystem {
  /** 必须在用户手势回调中调用：创建 / 恢复 AudioContext 并预合成常用音效。可重复调用 */
  unlock(): Promise<void>
  /** 音量 0..1 */
  setVolumes(bgm: number, sfx: number, muted: boolean): void
  /** 每帧更新听者位置与朝向 */
  setListener(position: Vector3, forward: Vector3): void
  /** 播放一次性音效。未 unlock 时静默忽略；同时发声数有上限，次要音效会被丢弃 */
  play(id: SfxId, options?: SfxOptions): void
  /** 切换背景音乐（带淡入淡出）；相同曲目重复调用无效果 */
  setMusic(track: MusicTrack): void
  /** 直升机螺旋桨循环音量 0..1（0 停止） */
  setHelicopter(level: number): void
  /** 心跳循环开关（倒地 / 撤离最后 5 秒 / BE） */
  setHeartbeat(on: boolean): void
  /** 全局低沉失真（倒地、BE 结局） */
  setMuffled(on: boolean): void
  /** 暂停 / 恢复全部声音（游戏暂停） */
  setPaused(paused: boolean): void
  dispose(): void
}

/* ── 系统接口 ── */

export interface System {
  /** 全部系统创建完成后调用一次，此时可以访问 ctx 上的其他系统 */
  init?(): void
  /** 每帧调用；dt 已乘时间缩放并截断 */
  update(dt: number): void
  /** 移除自己加入场景的全部对象、监听与定时器 */
  dispose(): void
}

export interface InputSystem extends System {
  /** 指针是否已锁定 */
  readonly locked: boolean
  /** 按键（KeyboardEvent.code）是否按住 */
  isDown(code: string): boolean
  /** 按键是否在本帧刚按下 */
  wasPressed(code: string): boolean
  /** 鼠标按键是否按住（0 左键，2 右键） */
  isMouseDown(button: number): boolean
  wasMousePressed(button: number): boolean
  /** 取走并清零累计的鼠标位移（像素），写入 out.x / out.y */
  consumeLook(out: { x: number; y: number }): void
  /** 取走并清零累计的滚轮格数（正 = 向下滚） */
  consumeWheel(): number
  requestLock(): void
  exitLock(): void
  /** 清空全部按键状态（暂停 / 失焦时） */
  reset(): void
  /** 引擎在每帧末尾调用，清除“刚按下”边沿 */
  endFrame(): void
}

export interface Collider {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** 顶面高度 */
  height: number
  /** 顶面是否可站立（看台台阶、车顶等） */
  walkable: boolean
  /** 是否阻挡子弹与视线 */
  blocksShots: boolean
}

export interface WorldSystem extends System {
  readonly colliders: readonly Collider[]
  /**
   * 圆形单位的水平碰撞求解：把 pos（只改 x / z）推出所有阻挡物。
   * 顶面不高于 feetY + PLAYER.stepHeight 的可站立碰撞体视为可踏上，不阻挡。
   * @param clampToBounds 为 true 时同时把单位限制在 PLAY_BOUNDS 内（小队成员用；丧尸与 Boss 传 false）
   */
  resolveMove(pos: Vector3, radius: number, feetY: number, clampToBounds: boolean): void
  /** (x, z) 处不高于 feetY + PLAYER.stepHeight 的最高可站立面高度；空地返回 0 */
  groundHeight(x: number, z: number, feetY: number): number
  /** 射线与地面、阻挡子弹的碰撞体求交；返回最近命中或 null */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): RayHit | null
  /** 两点之间是否没有被阻挡子弹的碰撞体挡住 */
  hasLineOfSight(from: Vector3, to: Vector3): boolean
  /**
   * 简易避障转向：给出从 from 走向 to 的建议水平单位方向（前方被挡时沿障碍物边缘绕行）。
   * 写入 out 并返回；from 与 to 重合时 out 为零向量。
   */
  steer(from: Vector3, to: Vector3, radius: number, out: Vector3): Vector3
  /** Boss 登场时撕开北侧围栏（视觉表现 + 移除缺口处碰撞） */
  breakNorthBarrier(): void
}

export type ImpactKind = 'world' | 'blood' | 'goo' | 'core'
export type BurstKind = 'dust' | 'smokeRed' | 'smokeGrey' | 'poison' | 'spark' | 'glow'

export interface EffectHandle {
  remove(): void
}

export interface EffectsSystem extends System {
  /** 枪口火光（Sprite，持续约 0.1 秒，随机旋转） */
  muzzleFlash(position: Vector3, direction: Vector3, scale?: number): void
  /** 子弹曳光 */
  tracer(from: Vector3, to: Vector3): void
  /** 命中粒子：world 尘屑 / blood 血雾 / goo Boss 粘液 / core 弱点火花 */
  impact(point: Vector3, normal: Vector3, kind: ImpactKind): void
  /** 弹孔贴花（与血迹共用上限 50，旧的自动移除） */
  bulletHole(point: Vector3, normal: Vector3): void
  /** 地面血迹贴花 */
  bloodDecal(position: Vector3, size?: number): void
  /** 一次性粒子爆发 */
  burst(position: Vector3, kind: BurstKind, count?: number): void
  /** 毒液池（纯视觉：绿色半透明圆面 + UV 滚动 + 雾气粒子），life 秒后淡出 */
  poisonPool(center: Vector3, radius: number, life: number): void
  /** 沿地面扩散的冲击波环 */
  shockwaveRing(center: Vector3, maxRadius: number, duration: number, color?: number): void
  /** 地面预警：圆形 */
  telegraphCircle(center: Vector3, radius: number, duration: number, color?: number): void
  /** 地面预警：扇形。facing 为朝向角 atan2(x, z)，arc 为总张角（弧度） */
  telegraphSector(center: Vector3, facing: number, arc: number, radius: number, duration: number, color?: number): void
  /** 地面预警：直线条带 */
  telegraphLine(from: Vector3, to: Vector3, width: number, duration: number, color?: number): void
  /** 竖直光柱（空投绿色 / 样本蓝色），返回句柄用于移除 */
  lightBeam(position: Vector3, color: number, height?: number): EffectHandle
  /** 持续冒烟（空投红色烟雾弹），返回句柄用于停止 */
  smokeColumn(position: Vector3, color: number): EffectHandle
  /** 直升机下洗气流：每帧调用，在 center 周围吹起贴地草屑。strength 0..1 */
  rotorWash(center: Vector3, strength: number): void
  /** 屏幕震动 */
  shake(strength: number, duration: number): void
  /** 当前震动偏移，由玩家系统叠加到相机位置 */
  readonly shakeOffset: Vector3
}

export type InteractionKind = 'rescue' | 'airdrop' | 'sample' | 'board'

export interface InteractionInfo {
  kind: InteractionKind
  /** 提示文案，如 “按住 E 救援 Manman” */
  text: string
  /** 读条进度 0..1；瞬时交互恒为 0 */
  progress: number
}

export interface PlayerSystem extends System {
  /** 主控 Samuel */
  readonly actor: Combatant
  /** 视线方向（单位向量） */
  readonly forward: Vector3
  /** 眼睛世界坐标 */
  readonly eye: Vector3
  /** 水平朝向角 atan2(forward.x, forward.z) */
  readonly yaw: number
  /** 换弹进度 0..1；未在换弹为 -1 */
  readonly reloadProgress: number
  /** 当前准星散布（弧度），HUD 用来画准星开合 */
  readonly spread: number
  /** 是否正在开火（按住左键且武器可射击） */
  readonly firing: boolean
  /** 准星射线当前是否指向敌人（丧尸 / Boss；被场景挡住不算） */
  readonly aimingEnemy: boolean
  /** 当前可用的交互；没有则为 null */
  readonly interaction: InteractionInfo | null
  /** 登机就座过渡中相机相对座位眼位的偏移（世界坐标）；过渡结束或未登机时为零向量 */
  readonly seatOffset: Vector3
  /** 开关玩家操作（结局时关闭）。关闭时仍继续更新相机 */
  setControl(enabled: boolean): void
}

export interface TeammateSystem extends System {
  /** 三名 AI 队友，编号 1..3 */
  readonly actors: readonly Combatant[]
}

export interface EnemySystem extends System {
  /** 场上存活的丧尸 */
  readonly active: readonly EnemyActor[]
  readonly waveActive: boolean
  /** 当前 / 最近一波的编号，未开始为 0 */
  readonly wave: number
  /** 本波总数 */
  readonly waveTotal: number
  /** 本波已击杀数 */
  readonly waveKilled: number
  /** 开始指定波次（1..3）：发出 waveStarted，全部击杀后发出 waveCleared */
  startWave(wave: number): void
  /** 额外刷怪（Boss 召唤），不计入波次进度，仍受同屏上限与刷新规则约束 */
  spawnExtra(type: EnemyType, count: number): void
  /** 射线检测丧尸；命中头部时 headshot 为 true */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): RayHit | null
  /** 造成伤害（amount 已含爆头倍率）；击杀时发出 enemyKilled */
  applyDamage(enemy: EnemyActor, amount: number, info: DamageInfo): void
  /** pos 附近 maxDist 内最近的存活丧尸 */
  nearest(pos: Vector3, maxDist: number): EnemyActor | null
  /** pos 周围 radius 内的存活丧尸数量 */
  countWithin(pos: Vector3, radius: number): number
  /** 清场（不计击杀、不发事件） */
  clearAll(): void
}

/** Boss 毒池的只读视图 */
export interface BossPoisonPool {
  /** 0 空闲；1 已喷出、落点在预警；2 已落地 */
  readonly status: number
  /** 落点中心 */
  readonly center: Vector3
}

export interface BossSystem extends System {
  /** 是否已登场（死亡后尸体仍在，保持 true） */
  readonly active: boolean
  readonly alive: boolean
  readonly hp: number
  readonly maxHp: number
  readonly phase: 1 | 2
  readonly weakWindow: BossWeakWindow
  /** 身体中心的地面投影 */
  readonly position: Vector3
  /** 身体碰撞半径（小队成员不能穿过） */
  readonly radius: number
  /** 当前招式的预警文案（HUD 显示），没有则为空串 */
  readonly warning: string
  /** 从后山爬出登场：发出 bossSpawned */
  spawn(): void
  raycast(origin: Vector3, dir: Vector3, maxDist: number): RayHit | null
  /** 造成伤害，内部按部位与弱点窗口乘倍率；返回实际伤害 */
  applyDamage(amount: number, zone: BossZone, info: DamageInfo): number
  /** AI 队友的瞄准点（弱点暴露时为弱点） */
  aimPoint(out: Vector3): Vector3
  /** 毒池槽位（含空闲槽，按 status 区分），供 AI 队友提前躲避；半径见 BOSS.spit.poolRadius */
  readonly poisonPools: readonly BossPoisonPool[]
  /** Boss 死后样本提取点是否可用 */
  readonly sampleAvailable: boolean
  readonly samplePoint: Vector3
  /** 提取样本：移除光柱并发出 sampleTaken（持有标记由调用方写到 Combatant.hasSample） */
  takeSample(): void
}

export type AirdropContent = { kind: 'weapon'; weapon: WeaponId } | { kind: 'ammo' } | { kind: 'medkit' }

/** 空投来源：wave = 波次空投（子弹 + 主武器）；boss = Boss 战补给（子弹 + 医疗包） */
export type AirdropSource = 'wave' | 'boss'

export interface AirdropCrate {
  readonly id: number
  /** 箱底中心世界坐标（下落过程中 y > 0） */
  readonly position: Vector3
  readonly landed: boolean
  readonly content: AirdropContent
  /** 开局摆在地上的主武器箱：计入每人限开次数；空投下来的箱子为 false */
  readonly limited: boolean
}

export interface AirdropSystem extends System {
  /** 尚未被拾取的空投箱（含下落中的与开局摆在地上的主武器箱） */
  readonly crates: readonly AirdropCrate[]
  /** 开局在出生点周围摆好主武器箱：箱内主武器随机，每人限开 WEAPON_CRATES.perPerson 个 */
  deployWeaponCrates(): void
  /** 投下 count 个空投，落点从 AIRDROP_POINTS 随机选取且不重复；内容按来源混配 */
  drop(count: number, source?: AirdropSource): void
  /** who 是否已经开满开局主武器箱（每人只有 WEAPON_CRATES.perPerson 次机会） */
  hasOpenedWeaponCrate(who: Combatant): boolean
  /**
   * 拾取空投并应用内容。主控已有 2 把且箱内是新型号时返回 'needsChoice' 并发出 weaponChoice，箱子保留；
   * AI 队友遇到同样情况直接替换当前武器。开局主武器箱超出每人的开箱次数时返回 'blocked'，箱子保留给别人。
   */
  pickup(crate: AirdropCrate, who: Combatant): 'picked' | 'needsChoice' | 'blocked'
  /** 主控在替换界面选定后由引擎调用；slot 为 null 表示放弃（箱子保留） */
  resolveChoice(crate: AirdropCrate, who: Combatant, slot: number | null): void
}

export interface EvacSystem extends System {
  readonly heliState: HeliState
  /** 降落后的撤离倒计时剩余秒数；未开始为 -1 */
  readonly countdown: number
  /** Boss 登场时由引擎调用：直升机从远处飞来并悬停缓降 */
  begin(): void
  /** Boss 死亡时由引擎调用：加速降落，EVAC.landAfterBossDeath 秒后落地并开始倒计时 */
  bossDefeated(): void
  /** who 当前能否登机（已降落、存活、在舱门登机范围 INTERACT.boardRange 内、且还有空座位） */
  canBoard(who: Combatant): boolean
  /** 登机：分配座位（主控固定坐 playerSeat，队友按登机先后坐其余空位），置为 boarded 并发出 boarded */
  board(who: Combatant): void
  /** 直升机是否已起飞离场（此时进入结局判定） */
  readonly departed: boolean
  /** 座位总数 */
  readonly seatCount: number
  /** 各座位上的乘员，下标与座位编号一致；空座位为 null */
  readonly occupants: readonly (Combatant | null)[]
  /** who 的座位编号；未登机为 -1 */
  seatOf(who: Combatant): number
  /** 座位的坐姿锚点（原点在骨盆落座处，本地 +Z 朝向舱门），随机身移动；编号越界为 null */
  seatAnchor(index: number): Object3D | null
  /** 主控相机锚点在机舱里的朝向角（atan2(dir.x, dir.z)，正对舱门）；登机后的环顾范围以它为中心 */
  seatYaw(): number
  /** 主控座位上的眼睛世界坐标（主控登机后的相机位置） */
  seatWorld(out: Vector3): Vector3
  /** 舱门外登机点的世界坐标（AI 跑向这里） */
  doorWorld(out: Vector3): Vector3
}

/* ── 事件 ── */

export interface GameEventMap {
  /** 任意小队成员开了一枪（统计命中率只看主控） */
  shotFired: { shooter: CharacterId; weapon: WeaponId; hit: boolean }
  /** 主控子弹命中了敌人 / Boss（准星命中标记与慢动作） */
  playerHit: { headshot: boolean; kill: boolean; weak: boolean }
  enemyKilled: { type: EnemyType; attacker: CharacterId | null; headshot: boolean; position: Vector3 }
  waveStarted: { wave: number; total: number }
  waveCleared: { wave: number }
  combatantDamaged: { who: Combatant; amount: number; source: DamageSource }
  combatantDowned: { who: Combatant }
  combatantRevived: { who: Combatant }
  combatantDied: { who: Combatant; source: DamageSource }
  bossSpawned: Record<string, never>
  bossPhase2: Record<string, never>
  bossDied: { position: Vector3 }
  sampleTaken: Record<string, never>
  airdropIncoming: { count: number }
  airdropLanded: { crate: AirdropCrate }
  airdropPicked: { crate: AirdropCrate; who: Combatant }
  /** 主控需要选择替换哪把武器 */
  weaponChoice: { crate: AirdropCrate; weapon: WeaponId }
  heliLanded: Record<string, never>
  boarded: { who: Combatant }
  heliDeparted: Record<string, never>
  /** 角色喊话（HUD 字幕） */
  voice: { speaker: CharacterId; text: string }
}

export type GameEventType = keyof GameEventMap

export interface GameEvents {
  /** 订阅事件，返回取消订阅函数 */
  on<K extends GameEventType>(type: K, handler: (payload: GameEventMap[K]) => void): () => void
  off<K extends GameEventType>(type: K, handler: (payload: GameEventMap[K]) => void): void
  emit<K extends GameEventType>(type: K, payload: GameEventMap[K]): void
  clear(): void
}

/* ── 上下文 ── */

export interface GameClock {
  /** 游戏内已流逝秒数（选完武器后开始，暂停不计） */
  elapsed: number
  phase: GamePhase
  /** 当前时间缩放（爆头慢动作时 < 1） */
  scale: number
  /** 帧计数，可用来错开低频更新 */
  frame: number
}

export interface GameStats {
  /** 全队击杀（按类型） */
  kills: Record<EnemyType, number>
  /** 主控开枪数 */
  shotsFired: number
  /** 主控命中数 */
  shotsHit: number
  /** 主控爆头数 */
  headshots: number
}

/**
 * 各系统共享的上下文。工厂函数（createXxx(ctx)）执行期间只能使用：
 * scene / camera / renderer / rng / events / time / stats / models / audio。
 * 其他系统（input、world、player …）与 combatants 要到 init() 及之后才能访问。
 * 创建顺序：input → world → effects → player → teammates → enemies → boss → airdrops → evac。
 * 每帧 update 顺序：player → teammates → enemies → boss → airdrops → evac → world → effects → input.endFrame()。
 */
export interface GameContext {
  readonly scene: Scene
  /** 相机变换只由玩家系统写入 */
  readonly camera: PerspectiveCamera
  readonly renderer: WebGLRenderer
  readonly rng: Rng
  readonly events: GameEvents
  readonly time: GameClock
  readonly stats: GameStats
  readonly models: ActorModels
  readonly audio: AudioSystem
  readonly input: InputSystem
  readonly world: WorldSystem
  readonly effects: EffectsSystem
  readonly player: PlayerSystem
  readonly teammates: TeammateSystem
  readonly enemies: EnemySystem
  readonly boss: BossSystem
  readonly airdrops: AirdropSystem
  readonly evac: EvacSystem
  /** 四人小队，按 SQUAD_ORDER：编号 0 为主控，1..3 为 AI 队友 */
  readonly combatants: readonly Combatant[]
}

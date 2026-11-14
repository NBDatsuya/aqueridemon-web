/**
 * 空投系统：选点、带伞下落、落地标记（红色烟雾 + 绿色光柱）、拾取与武器替换。
 * 同时负责开局摆在地上的主武器箱：箱内主武器随机，每人限开 WEAPON_CRATES.perPerson 个。
 * 箱子没有碰撞体。模型来自 ctx.models.createAirdrop()，这里只负责 root 的位置朝向并每帧驱动 rig.update。
 */

import { AIRDROP, AIRDROP_POINTS, WEAPON_CRATES, WEAPON_ORDER } from "../core/config";
import type {
  AirdropAnimInput,
  AirdropContent,
  AirdropCrate,
  AirdropRig,
  AirdropSystem,
  CharacterId,
  Combatant,
  EffectHandle,
  GameContext,
} from "../core/types";
import { smoothstep } from "../utils/math";

/* ── 表现参数（补充，不涉及玩法数值） ── */

/** 落点地面高度：6 个空投点都在平坦的球场草地上 */
const GROUND_Y = 0;
/** 红色烟雾弹颜色 */
const SMOKE_COLOR = 0xd8281e;
/** 绿色光柱颜色 */
const BEAM_COLOR = 0x3cff6a;
/** 出舱后降落伞完全张开所需时间（秒） */
const CHUTE_OPEN_TIME = 0.5;
/** 下落时箱体摆动的最大倾角（弧度） */
const SWAY_ANGLE = 0.12;
/** 下落时水平漂移的最大幅度（米），随高度降低收敛到 0，保证落在预设点上 */
const SWAY_DRIFT = 0.8;
/** 摆动角速度（弧度 / 秒） */
const SWAY_SPEED = 2.1;
/** 剩余下落进度低于该比例后倾角逐渐收平 */
const SWAY_SETTLE = 0.25;
/** 开局主武器箱不占用空投落点，用这个下标区分 */
const NO_POINT = -1;

/** 内部箱子记录：对外只暴露 AirdropCrate 的只读部分 */
interface Crate extends AirdropCrate {
  landed: boolean;
  /** 占用的 AIRDROP_POINTS 下标；开局主武器箱为 NO_POINT */
  readonly pointIndex: number;
  /** 落点 x */
  readonly x: number;
  /** 落点 z */
  readonly z: number;
  /** 箱体水平朝向（随机） */
  readonly yaw: number;
  /** 摆动初相，让同时下落的箱子不同步 */
  readonly swayPhase: number;
  readonly rig: AirdropRig;
  /** 已下落秒数 */
  fall: number;
  beam: EffectHandle | null;
  smoke: EffectHandle | null;
}

/**
 * 创建空投系统。
 * @param ctx 游戏上下文。工厂执行期间只用到 scene / rng / events / models / audio；effects 在 drop 之后才会访问
 * @returns 空投系统
 */
export function createAirdrops(ctx: GameContext): AirdropSystem {
  const crates: Crate[] = [];
  /** drop 时复用的空闲落点下标表 */
  const freePoints: number[] = [];
  /** 每帧复用的动画输入 */
  const anim: AirdropAnimInput = { parachute: 0, landed: false };
  /** 每名成员已经开掉的主武器箱数 */
  const openedCrates = new Map<CharacterId, number>();
  let nextId = 1;

  /** 按一组权重随机箱内物品 */
  const rollContent = (
    mix: Readonly<{ weapon: number; ammo: number; medkit: number }>,
  ): AirdropContent => {
    const roll = ctx.rng.next() * (mix.weapon + mix.ammo + mix.medkit);
    if (roll < mix.weapon) return { kind: "weapon", weapon: ctx.rng.pick(WEAPON_ORDER) };
    if (roll < mix.weapon + mix.ammo) return { kind: "ammo" };
    return { kind: "medkit" };
  };

  /** 落点是否被尚未拾取的箱子占用 */
  const isOccupied = (pointIndex: number): boolean => {
    for (let i = 0; i < crates.length; i++) {
      if (crates[i]?.pointIndex === pointIndex) return true;
    }
    return false;
  };

  /** 把对外的箱子引用换成内部记录；箱子已不存在时返回 null */
  const findOwn = (crate: AirdropCrate): Crate | null => {
    let ownRef: Crate | null = null;
    crates.forEach((item) => {
      if (item === crate) ownRef = item;
    });
    return ownRef;
  };

  /** 这名成员还剩几次开主武器箱的机会 */
  const canOpenWeaponCrate = (who: Combatant): boolean =>
    (openedCrates.get(who.id) ?? 0) < WEAPON_CRATES.perPerson;

  /** 记一次开箱 */
  const markOpened = (who: Combatant): void => {
    openedCrates.set(who.id, (openedCrates.get(who.id) ?? 0) + 1);
  };

  /**
   * 生成一个箱子。
   * @param placed true 时直接摆在地面上（开局主武器箱），否则从高空带伞下落
   * @param limited 是否计入每人限开次数（只有开局摆在地上的主武器箱为 true）
   */
  const createCrate = (
    x: number,
    z: number,
    pointIndex: number,
    content: AirdropContent,
    placed: boolean,
    limited: boolean,
  ): Crate => {
    // 三种内容三种箱型：子弹是原补给箱，主武器是硬箱，医疗包是白箱蓝十字
    const rig =
      content.kind === "weapon"
        ? ctx.models.createWeaponCrate({ parachute: !placed })
        : content.kind === "medkit"
          ? ctx.models.createMedkitCrate({ parachute: !placed })
          : ctx.models.createAirdrop();
    const yaw = ctx.rng.range(0, Math.PI * 2);
    rig.root.position.set(x, placed ? GROUND_Y : GROUND_Y + AIRDROP.startHeight, z);
    rig.root.rotation.set(0, yaw, 0);
    ctx.scene.add(rig.root);
    const crate: Crate = {
      id: nextId++,
      // 直接复用模型 root 的位置向量：箱底中心就是模型原点
      position: rig.root.position,
      landed: placed,
      content,
      limited,
      pointIndex,
      x,
      z,
      yaw,
      swayPhase: ctx.rng.range(0, Math.PI * 2),
      rig,
      fall: 0,
      beam: null,
      smoke: null,
    };
    crates.push(crate);
    return crate;
  };

  /** 在指定落点上空生成一个带伞下落的箱子 */
  const spawn = (
    pointIndex: number,
    mix: Readonly<{ weapon: number; ammo: number; medkit: number }>,
  ): void => {
    const point = AIRDROP_POINTS[pointIndex];
    if (!point) return;
    createCrate(point.x, point.z, pointIndex, rollContent(mix), false, false);
  };

  /** 落地：摆正箱体，立起红烟与绿色光柱并通知其他系统 */
  const land = (crate: Crate): void => {
    const root = crate.rig.root;
    root.position.set(crate.x, GROUND_Y, crate.z);
    root.rotation.set(0, crate.yaw, 0);
    crate.landed = true;
    ctx.audio.play("crate_land", { position: crate.position });
    ctx.effects.burst(crate.position, "smokeRed");
    ctx.effects.burst(crate.position, "dust");
    crate.smoke = ctx.effects.smokeColumn(crate.position, SMOKE_COLOR);
    crate.beam = ctx.effects.lightBeam(crate.position, BEAM_COLOR);
    ctx.events.emit("airdropLanded", { crate });
  };

  /** 释放一个箱子的模型与特效句柄（不改动 crates 列表） */
  const release = (crate: Crate): void => {
    ctx.scene.remove(crate.rig.root);
    crate.rig.dispose();
    crate.beam?.remove();
    crate.smoke?.remove();
    crate.beam = null;
    crate.smoke = null;
  };

  /** 拾取成功后的收尾：移除箱子、播放音效并发出 airdropPicked */
  const finish = (crate: Crate, who: Combatant): void => {
    const index = crates.indexOf(crate);
    if (index >= 0) crates.splice(index, 1);
    release(crate);
    ctx.audio.play("pickup", { position: crate.position });
    ctx.events.emit("airdropPicked", { crate, who });
  };

  /** 推进一个下落中的箱子；到时间则落地 */
  const fallStep = (crate: Crate, dt: number): void => {
    crate.fall += dt;
    const t = AIRDROP.fallTime > 0 ? Math.min(1, crate.fall / AIRDROP.fallTime) : 1;
    if (t >= 1) {
      land(crate);
      return;
    }
    const remain = 1 - t;
    const phase = crate.swayPhase + crate.fall * SWAY_SPEED;
    const tilt = SWAY_ANGLE * Math.min(1, remain / SWAY_SETTLE);
    const root = crate.rig.root;
    root.position.set(
      crate.x + Math.sin(phase) * SWAY_DRIFT * remain,
      GROUND_Y + AIRDROP.startHeight * remain,
      crate.z + Math.cos(phase * 0.8) * SWAY_DRIFT * remain,
    );
    root.rotation.set(Math.cos(phase * 0.8) * tilt, crate.yaw, Math.sin(phase) * tilt);
  };

  return {
    get crates(): readonly AirdropCrate[] {
      return crates;
    },

    deployWeaponCrates() {
      const points = WEAPON_CRATES.points;
      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (!point) continue;
        createCrate(
          point.x,
          point.z,
          NO_POINT,
          { kind: "weapon", weapon: ctx.rng.pick(WEAPON_ORDER) },
          true,
          true,
        );
      }
    },

    drop(count, source = "wave") {
      const mix = source === "boss" ? AIRDROP.bossMix : AIRDROP.waveMix;
      freePoints.length = 0;
      for (let i = 0; i < AIRDROP_POINTS.length; i++) {
        if (!isOccupied(i)) freePoints.push(i);
      }
      ctx.rng.shuffle(freePoints);
      // 空闲落点不够时只投下能放得下的数量
      const total = Math.min(Math.max(0, Math.floor(count)), freePoints.length);
      if (total <= 0) return;
      ctx.events.emit("airdropIncoming", { count: total });
      ctx.audio.play("plane");
      for (let i = 0; i < total; i++) {
        const pointIndex = freePoints[i];
        if (pointIndex !== undefined) spawn(pointIndex, mix);
      }
    },

    hasOpenedWeaponCrate(who) {
      return !canOpenWeaponCrate(who);
    },

    pickup(crate, who) {
      const own = findOwn(crate);
      // 箱子已不存在（被别人取走）：不产生任何效果，按“已取走”返回
      if (!own) return "picked";
      // 还在空中：不能拾取，箱子保留，也不发 weaponChoice
      if (!own.landed) return "needsChoice";

      const content = own.content;
      if (content.kind === "weapon") {
        // 开局摆在地上的主武器箱每人只有固定的开箱次数，用完了箱子留给别人；空投下来的不限
        if (own.limited && !canOpenWeaponCrate(who)) return "blocked";
        if (who.giveWeapon(content.weapon) === "full") {
          if (who.isPlayer) {
            ctx.events.emit("weaponChoice", { crate: own, weapon: content.weapon });
            return "needsChoice";
          }
          who.replaceWeapon(who.currentWeapon, content.weapon);
        }
        if (own.limited) markOpened(who);
      } else if (content.kind === "ammo") {
        who.refillWeapon();
      } else {
        who.heal(AIRDROP.medkitHeal, true);
      }
      finish(own, who);
      return "picked";
    },

    resolveChoice(crate, who, slot) {
      if (slot === null) return;
      const own = findOwn(crate);
      if (!own || !own.landed || own.content.kind !== "weapon") return;
      // 槽位无效时 replaceWeapon 不会生效，这里提前拦下，避免白白消耗箱子
      if (slot < 0 || slot >= who.weapons.length) return;
      who.replaceWeapon(slot, own.content.weapon);
      who.currentWeapon = slot;
      if (own.limited) markOpened(who);
      finish(own, who);
    },

    update(dt) {
      // 倒序遍历：落地事件的处理函数即使立刻拾走箱子，也不会跳过其他元素
      for (let i = crates.length - 1; i >= 0; i--) {
        const crate = crates[i];
        if (!crate) continue;
        if (!crate.landed) fallStep(crate, dt);
        if (crates[i] !== crate) continue;
        anim.landed = crate.landed;
        // 落地后传 0，由模型自己演出伞衣塌落
        anim.parachute = crate.landed ? 0 : smoothstep(crate.fall / CHUTE_OPEN_TIME);
        crate.rig.update(dt, anim);
      }
    },

    dispose() {
      for (let i = 0; i < crates.length; i++) {
        const crate = crates[i];
        if (crate) release(crate);
      }
      crates.length = 0;
    },
  };
}

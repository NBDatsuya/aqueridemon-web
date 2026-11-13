/**
 * 游戏引擎：创建各系统、推进每帧更新、管理阶段流转（选枪 → 准备 → 三波 → Boss → 撤离 → 结局）、
 * 统计数据，并把状态同步到 HUD（core/state.ts）。
 */

import { Vector3 } from 'three'
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { ammoRatio } from '../core/combatant'
import {
  AIRDROP,
  BOSS,
  CHARACTERS,
  EVAC,
  GAME_SEED,
  HEADSHOT,
  MAX_DELTA_TIME,
  PREP_DURATION,
  VOICE,
  WAVES,
  WEAPONS,
} from '../core/config'
import { createEvents } from '../core/events'
import { bindHudActions, hud, resetHud } from '../core/state'
import type { HudEnding } from '../core/state'
import type {
  AirdropCrate,
  Combatant,
  EndingKind,
  GameContext,
  GamePhase,
  MusicTrack,
  System,
  TeammateId,
  WeaponId,
} from '../core/types'
import { createAudio } from '../generators/audio'
import { actorModels } from '../generators/geometry'
import { createRng } from '../utils/random'
import { damp } from '../utils/math'
import { createAirdrops } from './airdrops'
import { createBoss } from './boss'
import { createEffects } from './effects'
import { createEnemies } from './enemies'
import { createEvac } from './evac'
import { createInput } from './input'
import { createPlayer } from './player'
import { createTeammates } from './teammates'
import { createWorld } from './world'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** 横幅默认停留时间（秒） */
const BANNER_TIME = 3.5
/** 字幕停留时间（秒） */
const SUBTITLE_TIME = 3.5
/** 同时显示的字幕条数上限 */
const SUBTITLE_MAX = 4
/** 两次爆头慢动作之间的最短间隔（秒，补充：避免连射时一直慢放） */
const SLOWMO_COOLDOWN = 1.5
/** 主控阵亡到显示结局的延迟（秒，补充：留给倒地视角演出） */
const DEATH_DELAY = 3.2
/** BE 结局心跳持续多久后停止（秒） */
const BE_HEARTBEAT_TIME = 7
/** 弹药不足的判定比例 */
const AMMO_LOW_RATIO = 0.25
/** 作弊切换键（反引号） */
const CHEAT_TOGGLE_KEY = 'Backquote'
/** 作弊指令提交后延迟多少秒生效 */
const CHEAT_DELAY = 5
/** Round Clear 横幅停留多久后开始下一波 / Boss 战（秒） */
const ROUND_CLEAR_DELAY = 2.5

/** 准星指向队友的最远判定距离（米） */
const AIM_MAX_DISTANCE = 50
/** 队友身体中心的近似高度：站立 / 倒地爬行 */
const AIM_CENTER_STAND = 0.9
const AIM_CENTER_DOWNED = 0.4
/** 指向判定的命中半径（米） */
const AIM_RADIUS = 0.55

export interface GameEngine {
  /** 每帧调用；delta 为距上一帧的秒数 */
  update(delta: number): void
  /** 外壳暂停菜单的暂停 / 继续 */
  setPaused(paused: boolean): void
  /** 音量 0..1 */
  setVolumes(bgm: number, sfx: number, muted: boolean): void
  dispose(): void
}

export interface EngineOptions {
  scene: Scene
  camera: PerspectiveCamera
  renderer: WebGLRenderer
  /** 接收指针锁定与鼠标输入的元素（画布） */
  dom: HTMLElement
}

/**
 * 创建一局游戏。销毁后需重新创建才能再开一局。
 * @param options 由 TresCanvas 提供的场景、相机、渲染器与画布
 */
export function createEngine(options: EngineOptions): GameEngine {
  const { scene, camera, renderer, dom } = options

  resetHud()

  const events = createEvents()
  const audio = createAudio()
  const ctx = {
    scene,
    camera,
    renderer,
    rng: createRng(GAME_SEED ^ (Date.now() & 0xffff)),
    events,
    time: { elapsed: 0, phase: 'select' as GamePhase, scale: 1, frame: 0 },
    stats: { kills: { common: 0, runner: 0, tank: 0 }, shotsFired: 0, shotsHit: 0, headshots: 0 },
    models: actorModels,
    audio,
  } as Mutable<GameContext>

  if (!camera.parent) scene.add(camera)

  // 创建顺序即契约规定的顺序；工厂执行期间不能访问尚未创建的系统
  ctx.input = createInput(ctx, dom)
  ctx.world = createWorld(ctx)
  ctx.effects = createEffects(ctx)
  ctx.player = createPlayer(ctx)
  ctx.teammates = createTeammates(ctx)
  ctx.enemies = createEnemies(ctx)
  ctx.boss = createBoss(ctx)
  ctx.airdrops = createAirdrops(ctx)
  ctx.evac = createEvac(ctx)
  ctx.combatants = [ctx.player.actor, ...ctx.teammates.actors]

  const { input, world, effects, player, teammates, enemies, boss, airdrops, evac, time, stats } = ctx
  const updateOrder: System[] = [player, teammates, enemies, boss, airdrops, evac, world, effects]
  const allSystems: System[] = [input, ...updateOrder]
  allSystems.forEach((system) => system.init?.())
  player.setControl(false)

  // 选枪界面期间一次性编译全场着色器：Boss、直升机与特效此刻都已挂在场景里（不可见），
  // 提前编译掉 Boss 登场那一刻才会触发的首次编译，消除登场卡顿
  renderer.compile(scene, camera)

  /* ── 内部状态 ── */

  let disposed = false
  let shellPaused = false
  let frozen = false
  let wasLocked = false
  /** 准备期剩余秒数 */
  let phaseTimer = 0
  /** Round Clear 到下一波 / Boss 战的剩余秒数；未触发为 -1 */
  let clearTimer = -1
  /** 等待开启的下一波序号（clearTimer >= 0 时有效） */
  let nextWave = 0
  /** Boss 战中距下一批补给空投的秒数 */
  let bossSupplyTimer = 0
  let slowMoTimer = 0
  let slowMoCooldown = 0
  let bannerTimer = 0
  let bannerSerial = 0
  let subtitleSerial = 0
  const subtitleTimers: number[] = []
  let pendingCrate: AirdropCrate | null = null
  /** 主控阵亡后到显示结局的倒计时；未触发为 -1 */
  let deathTimer = -1
  let beHeartbeatTimer = -1
  let beHeartbeatReasserted = false
  /** 进行中的作弊剩余秒数；没有为 -1 */
  let cheatTimer = -1
  let musicTrack: MusicTrack = 'none'
  let volumes = { bgm: 0.8, sfx: 1, muted: false }

  /* ── 音频 ── */

  /** 记住目标曲目；解锁完成后会重新应用 */
  const setMusic = (track: MusicTrack): void => {
    musicTrack = track
    audio.setMusic(track)
  }

  /** 解锁音频并重放当前的音量与曲目设置（需在用户手势内调用才一定成功） */
  const unlockAudio = (): void => {
    audio
      .unlock()
      .then(() => {
        if (disposed) return
        audio.setVolumes(volumes.bgm, volumes.sfx, volumes.muted)
        audio.setMusic(musicTrack)
      })
      .catch(() => {
        // 浏览器拒绝时保持静音运行
      })
  }

  /* ── HUD 辅助 ── */

  const showBanner = (title: string, sub: string, tone: 'info' | 'danger' | 'success', duration = BANNER_TIME): void => {
    bannerSerial += 1
    hud.banner = { id: bannerSerial, title, sub, tone }
    bannerTimer = duration
  }

  const pushSubtitle = (speaker: string, color: string, text: string): void => {
    subtitleSerial += 1
    hud.subtitles.push({ id: subtitleSerial, speaker, color, text })
    subtitleTimers.push(SUBTITLE_TIME)
    while (hud.subtitles.length > SUBTITLE_MAX) {
      hud.subtitles.shift()
      subtitleTimers.shift()
    }
  }

  /** 让一名存活的队友喊话 */
  const teammateVoice = (lines: Record<TeammateId, string>): void => {
    const alive = teammates.actors.filter((c) => c.status === 'alive')
    if (alive.length === 0) return
    const who = ctx.rng.pick(alive)
    events.emit('voice', { speaker: who.id, text: lines[who.id as TeammateId] })
  }

  const objectiveFor = (phase: GamePhase): string => {
    switch (phase) {
      case 'select':
        return '选择你的武器'
      case 'prep':
        return '感染者正在逼近，守住绿茵场'
      case 'wave':
        return `抵御第 ${enemies.wave} 波尸潮`
      case 'boss':
        return boss.phase === 2 ? '击败狂暴的阿奎尔巨兽' : '击败阿奎尔巨兽'
      case 'evac':
        if (evac.heliState !== 'landed') return player.actor.hasSample ? '等待直升机降落' : '提取阿奎尔样本'
        if (player.actor.status === 'boarded') return '等待起飞'
        return player.actor.hasSample ? '前往停机坪登机' : '提取样本后前往停机坪登机'
      case 'ending':
        return ''
    }
  }

  /* ── 阶段流转 ── */

  const beginWave = (wave: number): void => {
    time.phase = 'wave'
    enemies.startWave(wave)
    setMusic('battle')
  }

  const beginBoss = (): void => {
    time.phase = 'boss'
    boss.spawn()
    evac.begin()
    if (AIRDROP.atBoss > 0) airdrops.drop(AIRDROP.atBoss)
    setMusic('boss')
    showBanner(`${BOSS.name}登场`, '救援直升机正在赶来', 'danger', 5)
  }

  /** 判定结局 */
  const resolveEnding = (): EndingKind => {
    const actor = player.actor
    if (actor.status !== 'boarded') return 'BE'
    const allBoarded = ctx.combatants.every((c) => c.status === 'boarded')
    if (!allBoarded) return 'NE_CASUALTY'
    return actor.hasSample ? 'HE' : 'NE_NO_SAMPLE'
  }

  const finish = (kind: EndingKind): void => {
    if (time.phase === 'ending') return
    time.phase = 'ending'
    time.scale = 1
    slowMoTimer = 0
    cheatTimer = -1
    hud.cheatCountdown = -1
    hud.cheatOpen = false
    hud.cheatError = ''
    player.setControl(false)
    input.exitLock()

    const total = stats.kills.common + stats.kills.runner + stats.kills.tank
    const ending: HudEnding = {
      kind,
      time: time.elapsed,
      kills: { ...stats.kills },
      totalKills: total,
      accuracy: stats.shotsFired > 0 ? stats.shotsHit / stats.shotsFired : 0,
      headshots: stats.headshots,
      squad: ctx.combatants.map((c) => ({
        id: c.id,
        name: c.name,
        isPlayer: c.isPlayer,
        survived: c.status === 'boarded',
      })),
      hasSample: player.actor.hasSample && player.actor.status === 'boarded',
      lastWords:
        kind === 'BE'
          ? teammates.actors
              .filter((c) => c.status === 'alive' || c.status === 'boarded')
              .map((c) => ({ speaker: c.name, text: VOICE.playerDeath[c.id as TeammateId] }))
          : [],
    }
    hud.ending = ending

    if (kind === 'HE') setMusic('he')
    else if (kind === 'BE') setMusic('be')
    else setMusic('ne')
  }

  /* ── 事件订阅 ── */

  const unsubscribe = [
    events.on('shotFired', ({ shooter, hit }) => {
      if (shooter !== 'samuel') return
      stats.shotsFired += 1
      if (hit) stats.shotsHit += 1
    }),
    events.on('playerHit', ({ headshot, kill, weak }) => {
      hud.hitMarker.serial += 1
      hud.hitMarker.headshot = headshot
      hud.hitMarker.kill = kill
      hud.hitMarker.weak = weak
      // 爆头 / Boss 弱点击杀播报语音（Qwen-Audio-TTS 预生成，资源缺失时静默）
      if (kill && (headshot || weak)) audio.play('voice_headshot_kill')
      if (headshot && slowMoCooldown <= 0) {
        slowMoTimer = HEADSHOT.slowMoDuration
        slowMoCooldown = SLOWMO_COOLDOWN
      }
    }),
    events.on('enemyKilled', ({ type, attacker, headshot }) => {
      stats.kills[type] += 1
      if (attacker === 'samuel' && headshot) stats.headshots += 1
    }),
    events.on('waveStarted', ({ wave, total }) => {
      audio.play('wave_start')
      showBanner(`第 ${wave} 波来袭`, `${total} 只感染者`, 'danger')
    }),
    events.on('waveCleared', ({ wave }) => {
      const def = WAVES[wave - 1]
      if (!def || time.phase !== 'wave') return
      audio.play('wave_clear')
      // 先弹 Round Clear，短暂停顿后再开下一波（最后一波之后是 Boss 战）
      const last = wave >= WAVES.length
      showBanner(
        `ROUND ${wave} CLEAR!`,
        last ? '后山传来动静……' : '下一波即将来袭',
        'success',
        ROUND_CLEAR_DELAY,
      )
      if (def.airdrops > 0) airdrops.drop(def.airdrops)
      nextWave = wave + 1
      clearTimer = ROUND_CLEAR_DELAY
    }),
    events.on('combatantDamaged', ({ who, amount }) => {
      if (!who.isPlayer) return
      hud.damage.serial += 1
      hud.damage.amount = amount
    }),
    events.on('combatantDowned', ({ who }) => {
      audio.play('body_fall', { position: who.position })
      if (who.isPlayer) {
        audio.play('downed_alert')
        audio.setMuffled(true)
        audio.setHeartbeat(true)
      } else {
        showBanner(`${who.name} 倒地！`, '15 秒内靠近并按住 E 救援', 'danger')
      }
    }),
    events.on('combatantRevived', ({ who }) => {
      if (!who.isPlayer) return
      audio.setMuffled(false)
      // 心跳开关与撤离倒计时共用：倒计时最后几秒被救起时保持开启
      audio.setHeartbeat(evac.heliState === 'landed' && evac.countdown >= 0 && evac.countdown <= EVAC.heartbeatFrom)
    }),
    events.on('combatantDied', ({ who }) => {
      if (!who.isPlayer) {
        if (time.phase !== 'ending') showBanner(`${who.name} 阵亡`, '', 'danger')
        return
      }
      if (deathTimer >= 0 || time.phase === 'ending') return
      deathTimer = DEATH_DELAY
      beHeartbeatTimer = BE_HEARTBEAT_TIME
      audio.setMuffled(true)
      audio.setHeartbeat(true)
      setMusic('be')
      teammates.actors
        .filter((c) => c.status === 'alive')
        .forEach((c) => events.emit('voice', { speaker: c.id, text: VOICE.playerDeath[c.id as TeammateId] }))
    }),
    events.on('bossSpawned', () => teammateVoice(VOICE.bossSpawn)),
    events.on('bossPhase2', () => showBanner('狂暴形态', '全场冲击波：看准时机跳跃躲避', 'danger', 5)),
    events.on('bossDied', () => {
      if (time.phase !== 'boss') return
      time.phase = 'evac'
      evac.bossDefeated()
      setMusic('battle')
      showBanner(`${BOSS.name}已倒下`, `提取样本 · 直升机 ${EVAC.landAfterBossDeath} 秒后降落`, 'success', 5)
    }),
    events.on('sampleTaken', () => showBanner('已获得阿奎尔样本', '带着它登上直升机', 'success')),
    events.on('airdropIncoming', ({ count }) => {
      if (time.phase === 'boss') return
      pushSubtitle('指挥部', '#9fe6a0', `已空投下 ${count} 个补给包，希望对你们有帮助`)
    }),
    events.on('airdropPicked', ({ crate, who }) => {
      if (!who.isPlayer) return
      const content = crate.content
      if (content.kind === 'weapon') showBanner(`获得 ${WEAPONS[content.weapon].name}`, '弹药已补满', 'info', 2.5)
      else if (content.kind === 'ammo') showBanner('弹药箱', '当前武器弹药已补满', 'info', 2.5)
      else showBanner('医疗包', `生命 +${AIRDROP.medkitHeal}`, 'success', 2.5)
    }),
    events.on('weaponChoice', ({ crate, weapon }) => {
      pendingCrate = crate
      hud.weaponChoice = { weapon, name: WEAPONS[weapon].name }
      input.exitLock()
    }),
    events.on('heliLanded', () => {
      showBanner('直升机已降落', `${EVAC.countdown} 秒内全员登机`, 'info', 5)
      teammateVoice(VOICE.heliLanded)
    }),
    events.on('boarded', ({ who }) => {
      if (who.isPlayer) showBanner('已登机', '等待队友与起飞', 'success')
      else pushSubtitle(who.name, CHARACTERS[who.id].hudColor, '我上来了！')
    }),
    events.on('heliDeparted', () => finish(resolveEnding())),
    events.on('voice', ({ speaker, text }) => {
      const def = CHARACTERS[speaker]
      pushSubtitle(def.name, def.hudColor, text)
    }),
  ]

  /* ── 作弊控制台 ── */

  /** 控制台关闭后回到游戏；仅在需要指针锁定的场合重新锁定（须在用户手势里调用） */
  const resumeFromCheat = (): void => {
    if (shellPaused || time.phase === 'select' || hud.weaponChoice !== null) return
    input.requestLock()
  }

  const closeCheat = (): void => {
    if (!hud.cheatOpen) return
    hud.cheatOpen = false
    hud.cheatError = ''
    // 清掉输入指令时残留的按键，避免泄漏到移动 / 射击
    input.reset()
    resumeFromCheat()
  }

  /** 按 ` 切换控制台；打开时冻结游戏并放开指针 */
  const toggleCheat = (): void => {
    if (hud.cheatOpen) {
      closeCheat()
      return
    }
    if (time.phase === 'ending' || hud.weaponChoice !== null) return
    hud.cheatOpen = true
    hud.cheatError = ''
    input.exitLock()
  }

  const submitCheat = (code: string): void => {
    if (!hud.cheatOpen) return
    const cmd = code.trim().toLowerCase()
    if (cmd.length === 0) return
    if (cmd !== 'boss') {
      hud.cheatError = '未知指令 · 可用指令：boss'
      return
    }
    const bossPending = time.phase === 'prep' || time.phase === 'wave'
    if (!bossPending) {
      hud.cheatError = time.phase === 'select' ? '先选好武器再使用作弊' : '阿奎尔已经到场'
      return
    }
    audio.play('click')
    closeCheat()
    cheatTimer = CHEAT_DELAY
    hud.cheatCountdown = CHEAT_DELAY
  }

  /* ── 指针锁定恢复 ── */

  /**
   * 点击画面重新锁定指针。
   * 用户按 ESC 退出锁定后浏览器有一段冷却期（Chrome 约 1.25 秒），暂停菜单点“继续”时的
   * 立即重锁可能被静默拒绝；此后在画面上点一下即可恢复鼠标控制（点击算用户手势）。
   */
  const onCanvasClick = (): void => {
    if (disposed) return
    if (time.phase === 'select' || time.phase === 'ending') return
    if (shellPaused || hud.cheatOpen || hud.weaponChoice !== null) return
    input.requestLock()
  }
  dom.addEventListener('click', onCanvasClick)

  /* ── HUD 操作 ── */

  bindHudActions({
    selectWeapon(weapon: WeaponId): void {
      if (time.phase !== 'select') return
      unlockAudio()
      audio.play('click')
      player.equipInitial(weapon)
      player.setControl(true)
      time.phase = 'prep'
      phaseTimer = PREP_DURATION
      setMusic('intermission')
      input.requestLock()
      showBanner('守住绿茵场', `第 1 波 ${PREP_DURATION} 秒后到来`, 'info', 4)
    },
    resolveWeaponChoice(slot: number | null): void {
      if (!pendingCrate) return
      airdrops.resolveChoice(pendingCrate, player.actor, slot)
      pendingCrate = null
      hud.weaponChoice = null
      audio.play('click')
      input.requestLock()
    },
    submitCheat(code: string): void {
      submitCheat(code)
    },
    closeCheat(): void {
      closeCheat()
    },
  })

  // 进入游戏页通常已有过用户点击，先尝试解锁以播放选枪界面的氛围音
  setMusic('menu')
  unlockAudio()

  /* ── HUD 同步 ── */

  const syncSquadMember = (index: number, c: Combatant): void => {
    const m = hud.squad[index]
    if (!m) return
    m.status = c.status
    m.hp = Math.ceil(c.hp)
    m.downedTimer = Math.ceil(c.downedTimer)
    m.weapon = c.weapon ? WEAPONS[c.weapon.id].name : ''
    m.ammoLow = c.weapon ? ammoRatio(c.weapon) < AMMO_LOW_RATIO : false
  }

  /* ── 准星指向队友 ── */

  const vAimCenter = new Vector3()
  /** findAimTarget 命中时写入与主控的距离（米） */
  let aimDistance = 0

  /**
   * 找出准星射线指向的队友：以身体中心做球形近似取最近命中，再检查视线是否被场景挡住。
   * 只统计存活与倒地的队友（阵亡 / 已登机不显示）。
   */
  const findAimTarget = (): Combatant | null => {
    const eye = player.eye
    const dir = player.forward
    let best: Combatant | null = null
    let bestDist = AIM_MAX_DISTANCE
    for (let i = 0; i < ctx.combatants.length; i++) {
      const c = ctx.combatants[i]
      if (!c || c.isPlayer) continue
      if (c.status !== 'alive' && c.status !== 'downed') continue
      const center = c.status === 'downed' ? AIM_CENTER_DOWNED : AIM_CENTER_STAND
      vAimCenter.set(c.position.x - eye.x, c.position.y + center - eye.y, c.position.z - eye.z)
      const t = vAimCenter.dot(dir)
      if (t < 0.5 || t >= bestDist) continue
      // 射线到中心的最近距离平方（点到射线距离 = |向量|² - 投影²）
      if (vAimCenter.lengthSq() - t * t > AIM_RADIUS * AIM_RADIUS) continue
      // 中途有墙则视为被挡住
      if (ctx.world.raycast(eye, dir, t - 0.3)) continue
      best = c
      bestDist = t
    }
    aimDistance = bestDist
    return best
  }

  /** 把指向的队友同步到 HUD；对象只在目标切换时重建，其余帧原地修改 */
  const syncAimTarget = (): void => {
    const target = player.actor.status === 'alive' ? findAimTarget() : null
    if (!target) {
      hud.aimTarget = null
      return
    }
    if (!hud.aimTarget || hud.aimTarget.id !== target.id) {
      hud.aimTarget = {
        id: target.id,
        name: target.name,
        color: CHARACTERS[target.id].hudColor,
        status: target.status,
        hp: 0,
        downedTimer: 0,
        weapon: '',
        distance: 0,
      }
    }
    const t = hud.aimTarget
    if (!t) return
    t.status = target.status
    t.hp = Math.ceil(target.hp)
    t.downedTimer = Math.ceil(target.downedTimer)
    t.weapon = target.weapon ? WEAPONS[target.weapon.id].name : ''
    t.distance = Math.round(aimDistance)
  }

  const syncHud = (): void => {
    const actor = player.actor
    hud.phase = time.phase
    hud.locked = input.locked
    hud.paused = shellPaused
    hud.elapsed = Math.floor(time.elapsed)
    hud.objective = objectiveFor(time.phase)

    hud.wave = enemies.wave
    hud.waveTotal = enemies.waveTotal
    hud.waveKilled = enemies.waveKilled
    // 剩余NPC = 本波总数 - 已击杀（含尚未刷出的），开局即等于关卡规定数量；
    // Boss 战波次已清零，回退为场上存活数，把召唤的小怪也计入
    hud.enemiesAlive = Math.max(enemies.waveTotal - enemies.waveKilled, enemies.active.length)
    hud.timer = time.phase === 'prep' ? Math.ceil(phaseTimer) : -1

    hud.hp = Math.ceil(actor.hp)
    hud.status = actor.status
    hud.downedTimer = Math.ceil(actor.downedTimer)
    hud.stunned = actor.stunTimer > 0
    if (hud.weapons.length !== actor.weapons.length) {
      hud.weapons = actor.weapons.map((w) => ({
        id: w.id,
        name: WEAPONS[w.id].name,
        mag: w.mag,
        magSize: WEAPONS[w.id].magSize,
        reserve: w.reserve,
        active: false,
      }))
    }
    actor.weapons.forEach((w, i) => {
      const slot = hud.weapons[i]
      if (!slot) return
      if (slot.id !== w.id) {
        slot.id = w.id
        slot.name = WEAPONS[w.id].name
        slot.magSize = WEAPONS[w.id].magSize
      }
      slot.mag = w.mag
      slot.reserve = w.reserve
      slot.active = i === actor.currentWeapon
    })
    const reload = player.reloadProgress
    hud.reloadProgress = reload < 0 ? -1 : Math.round(reload * 100) / 100
    hud.spread = Math.round(player.spread * 1000) / 1000
    hud.crosshairHot = player.aimingEnemy && player.firing

    const interaction = player.interaction
    if (!interaction) {
      hud.interaction = null
    } else {
      const progress = Math.round(interaction.progress * 100) / 100
      if (hud.interaction) {
        hud.interaction.text = interaction.text
        hud.interaction.progress = progress
      } else {
        hud.interaction = { text: interaction.text, progress }
      }
    }
    hud.hasSample = actor.hasSample
    hud.kills = stats.kills.common + stats.kills.runner + stats.kills.tank

    ctx.combatants.forEach((c, i) => syncSquadMember(i, c))
    syncAimTarget()

    hud.boss.active = boss.active
    hud.boss.alive = boss.alive
    hud.boss.hp = Math.max(0, Math.ceil(boss.hp))
    hud.boss.maxHp = boss.maxHp
    hud.boss.phase = boss.phase
    hud.boss.weak = boss.weakWindow
    hud.boss.warning = boss.warning

    hud.heli = evac.heliState
    hud.evacCountdown = evac.countdown < 0 ? -1 : Math.ceil(evac.countdown)
    hud.slowMo = slowMoTimer > 0
  }

  /** 推进横幅、字幕等只跟真实时间走的计时 */
  const tickUi = (realDt: number): void => {
    if (bannerTimer > 0) {
      bannerTimer -= realDt
      if (bannerTimer <= 0) hud.banner = null
    }
    for (let i = subtitleTimers.length - 1; i >= 0; i--) {
      const left = (subtitleTimers[i] ?? 0) - realDt
      if (left <= 0) {
        subtitleTimers.splice(i, 1)
        hud.subtitles.splice(i, 1)
      } else {
        subtitleTimers[i] = left
      }
    }
  }

  /** 推进阶段计时（准备期、Round Clear 停顿、阵亡延迟、作弊生效倒计时） */
  const tickPhase = (realDt: number): void => {
    if (time.phase === 'prep') {
      phaseTimer -= realDt
      if (phaseTimer <= 0) beginWave(1)
    }
    if (clearTimer >= 0) {
      clearTimer -= realDt
      if (clearTimer <= 0) {
        clearTimer = -1
        // 结局可能已经触发（阵亡演出期间）；只有还在波次阶段才推进
        if (time.phase === 'wave') {
          if (nextWave > WAVES.length) beginBoss()
          else beginWave(nextWave)
        }
      }
    }
    if (cheatTimer >= 0) {
      cheatTimer -= realDt
      hud.cheatCountdown = Math.max(0, Math.ceil(cheatTimer))
      if (cheatTimer <= 0) {
        cheatTimer = -1
        hud.cheatCountdown = -1
        // 倒计时期间结局可能已经触发，只有还在开局阶段才真的跳 Boss
        if (time.phase === 'prep' || time.phase === 'wave') {
          enemies.clearAll()
          beginBoss()
        }
      }
    }
    if (deathTimer >= 0) {
      deathTimer -= realDt
      if (deathTimer < 0) finish('BE')
    }
    if (beHeartbeatTimer >= 0) {
      // 未登机阵亡时，撤离系统会在阵亡事件之后关掉共用的心跳开关，这里补开一次
      if (!beHeartbeatReasserted) {
        beHeartbeatReasserted = true
        audio.setHeartbeat(true)
      }
      beHeartbeatTimer -= realDt
      if (beHeartbeatTimer < 0) audio.setHeartbeat(false)
    }
  }

  const setFrozen = (value: boolean): void => {
    if (frozen === value) return
    frozen = value
    audio.setPaused(value)
    if (value) input.reset()
  }

  /* ── 对外接口 ── */

  return {
    update(delta: number): void {
      if (disposed) return
      const realDt = Math.min(Math.max(delta, 0), MAX_DELTA_TIME)
      const playing = time.phase !== 'select' && time.phase !== 'ending'

      // 选枪与结局界面需要鼠标点击：外壳“重新开始”可能带着锁定进来，这里放开
      if (!playing && input.locked) input.exitLock()

      // 游戏中按 ESC（或切走窗口）会被浏览器用来退出指针锁定，这次按键到不了暂停菜单。
      // 所以把“进行中失去锁定”当作打开暂停菜单的请求；引擎自己放开锁定的情况（换枪界面、作弊控制台、结局）不算
      const lockedNow = input.locked
      if (playing && wasLocked && !lockedNow && !shellPaused && !hud.cheatOpen && hud.weaponChoice === null)
        hud.pauseRequest += 1
      wasLocked = lockedNow

      // 控制台用 ` 切换；打开时游戏处于冻结态，所以这行必须放在冻结早退之前
      if (input.wasPressed(CHEAT_TOGGLE_KEY)) toggleCheat()

      // 游戏进行中失去锁定（按 ESC、切走窗口）由暂停菜单接管，这里只认三类主动冻结
      const halted = shellPaused || hud.cheatOpen || hud.weaponChoice !== null
      setFrozen(halted)

      if (halted) {
        hud.locked = input.locked
        hud.paused = shellPaused
        hud.crosshairHot = false
        input.endFrame()
        return
      }

      if (slowMoCooldown > 0) slowMoCooldown -= realDt
      if (slowMoTimer > 0) slowMoTimer -= realDt
      // 时间缩放用指数趋近平滑进出慢动作：瞬间跳变会让世界突然卡住又突然加速，像掉帧
      const targetScale = slowMoTimer > 0 ? HEADSHOT.slowMoScale : 1
      time.scale = damp(time.scale, targetScale, slowMoTimer > 0 ? 26 : 8.5, realDt)
      if (Math.abs(time.scale - targetScale) < 0.005) time.scale = targetScale
      time.frame += 1
      if (playing) time.elapsed += realDt

      const dt = realDt * time.scale
      for (const system of updateOrder) system.update(dt)

      tickPhase(realDt)
      tickUi(realDt)
      syncHud()
      input.endFrame()
    },

    setPaused(paused: boolean): void {
      shellPaused = paused
      if (!paused && time.phase !== 'select' && time.phase !== 'ending') input.requestLock()
    },

    setVolumes(bgm: number, sfx: number, muted: boolean): void {
      volumes = { bgm, sfx, muted }
      audio.setVolumes(bgm, sfx, muted)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      dom.removeEventListener('click', onCanvasClick)
      bindHudActions(null)
      unsubscribe.forEach((off) => off())
      input.exitLock()
      for (let i = allSystems.length - 1; i >= 0; i--) allSystems[i]?.dispose()
      events.clear()
      audio.dispose()
      if (camera.parent === scene) scene.remove(camera)
    },
  }
}

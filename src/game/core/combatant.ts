/**
 * 小队成员的共用状态实现：血量、倒地、救起、击退、武器栏。
 * 主控与 AI 队友各自持有一个 CombatantBase，移动与输入由各自的系统负责。
 */

import { Vector3 } from 'three'
import { CHARACTERS, PLAYER, VOICE, WEAPONS } from './config'
import type {
  ActorStatus,
  CharacterId,
  Combatant,
  DamageSource,
  GameEvents,
  WeaponId,
  WeaponState,
} from './types'

/** 创建一把满弹的武器状态 */
export function createWeaponState(id: WeaponId): WeaponState {
  const def = WEAPONS[id]
  return { id, mag: def.magSize, reserve: def.reserveMax }
}

/** 武器剩余弹药占满弹的比例 0..1 */
export function ammoRatio(weapon: WeaponState | undefined): number {
  if (!weapon) return 0
  const def = WEAPONS[weapon.id]
  return (weapon.mag + weapon.reserve) / (def.magSize + def.reserveMax)
}

export class CombatantBase implements Combatant {
  readonly id: CharacterId
  readonly name: string
  readonly isPlayer: boolean
  readonly position = new Vector3()
  readonly velocity = new Vector3()
  readonly knockback = new Vector3()
  readonly radius: number = PLAYER.radius
  status: ActorStatus = 'alive'
  hp: number = PLAYER.maxHp
  downedTimer = 0
  invulnTimer = 0
  stunTimer = 0
  airborne = false
  hasSample = false
  weapons: WeaponState[] = []
  currentWeapon = 0
  rescuer: CharacterId | null = null
  damageSerial = 0
  score = 0

  private readonly events: GameEvents

  /**
   * @param id 角色 ID
   * @param events 本局事件总线
   */
  constructor(id: CharacterId, events: GameEvents) {
    const def = CHARACTERS[id]
    this.id = id
    this.name = def.name
    this.isPlayer = def.isPlayer
    this.events = events
  }

  get weapon(): WeaponState | undefined {
    return this.weapons[this.currentWeapon]
  }

  takeDamage(amount: number, source: DamageSource): boolean {
    if (this.status !== 'alive' || this.invulnTimer > 0 || amount <= 0) return false
    this.hp = Math.max(0, this.hp - amount)
    this.damageSerial += 1
    this.events.emit('combatantDamaged', { who: this, amount, source })
    if (this.hp <= 0) this.goDown()
    return true
  }

  applyKnockback(dirX: number, dirZ: number, distance: number): void {
    if (this.status !== 'alive' || distance <= 0) return
    const len = Math.hypot(dirX, dirZ)
    if (len < 1e-5) return
    const speed = distance * PLAYER.knockbackDecay
    this.knockback.x += (dirX / len) * speed
    this.knockback.z += (dirZ / len) * speed
  }

  consumeKnockback(dt: number, out: Vector3): Vector3 {
    out.set(this.knockback.x * dt, 0, this.knockback.z * dt)
    const decay = Math.exp(-PLAYER.knockbackDecay * dt)
    this.knockback.x *= decay
    this.knockback.z *= decay
    if (Math.abs(this.knockback.x) < 0.01) this.knockback.x = 0
    if (Math.abs(this.knockback.z) < 0.01) this.knockback.z = 0
    return out
  }

  stun(seconds: number): void {
    if (this.status !== 'alive') return
    this.stunTimer = Math.max(this.stunTimer, seconds)
  }

  heal(amount: number, overheal = false): void {
    if (this.status !== 'alive') return
    const cap = overheal ? PLAYER.overhealMax : Math.max(PLAYER.maxHp, this.hp)
    this.hp = Math.min(cap, this.hp + amount)
  }

  revive(): void {
    if (this.status !== 'downed') return
    this.status = 'alive'
    this.hp = PLAYER.reviveHp
    this.invulnTimer = PLAYER.reviveInvuln
    this.downedTimer = 0
    this.rescuer = null
    this.events.emit('combatantRevived', { who: this })
  }

  die(source: DamageSource): void {
    if (this.status === 'dead' || this.status === 'boarded') return
    this.status = 'dead'
    this.hp = 0
    this.downedTimer = 0
    this.rescuer = null
    this.knockback.set(0, 0, 0)
    this.events.emit('combatantDied', { who: this, source })
  }

  board(): void {
    if (this.status !== 'alive') return
    this.status = 'boarded'
    this.knockback.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
  }

  giveWeapon(id: WeaponId): 'added' | 'refilled' | 'full' {
    const slot = this.weapons.findIndex((w) => w.id === id)
    if (slot >= 0) {
      this.refillWeapon(slot)
      return 'refilled'
    }
    if (this.weapons.length < PLAYER.maxWeapons) {
      this.weapons.push(createWeaponState(id))
      return 'added'
    }
    return 'full'
  }

  replaceWeapon(slot: number, id: WeaponId): void {
    if (slot < 0 || slot >= this.weapons.length) return
    this.weapons[slot] = createWeaponState(id)
  }

  refillWeapon(slot: number = this.currentWeapon): void {
    const weapon = this.weapons[slot]
    if (!weapon) return
    const def = WEAPONS[weapon.id]
    weapon.mag = def.magSize
    weapon.reserve = def.reserveMax
  }

  tickStatus(dt: number): void {
    if (this.invulnTimer > 0) this.invulnTimer = Math.max(0, this.invulnTimer - dt)
    if (this.stunTimer > 0) this.stunTimer = Math.max(0, this.stunTimer - dt)
    if (this.status !== 'downed') return
    this.downedTimer -= dt
    if (this.downedTimer <= 0) this.die('abandoned')
  }

  /** HP 归零：进入倒地并喊话 */
  private goDown(): void {
    this.status = 'downed'
    this.downedTimer = PLAYER.downedDuration
    this.stunTimer = 0
    this.knockback.set(0, 0, 0)
    this.rescuer = null
    this.events.emit('combatantDowned', { who: this })
    this.events.emit('voice', { speaker: this.id, text: VOICE.downed[this.id] })
  }
}

/**
 * 直升机座位上的 AI 队友：把人形模型挂到座位锚点（EvacSystem.seatAnchor）下，从舱门口爬进座位并保持坐姿。
 * 模型成为机身的子节点，起飞后随机舱一起移动、俯仰与滚转，不会落后一帧。
 *
 * 人形绑定没有坐姿：每帧先按站立待机更新一次，再改写骨盆与双腿的关节角。
 * 骨盆和腿的节点取自 humanoid.ts 的 HumanoidBuild.parts（运行时检查，取不到时只摆位置不弯腿）。
 */

import { Object3D, Quaternion, Vector3 } from 'three'
import type { HumanoidAnimInput, HumanoidRig } from '../core/types'
import { lerp, smoothstep } from '../utils/math'

/** 坐姿：大腿前抬的角度（略小于 90°，大腿向膝盖微微下倾，脚能踩到地板）、屈膝角、两腿外张角（弧度） */
const HIP_FLEX = -1.4
const KNEE_BEND = 1.4
const LEG_SPLAY = 0.1
/** 骨盆落座点比座位锚点高出多少（米），抵掉大腿的粗细，避免陷进坐垫 */
const SEAT_LIFT = 0.06
/** 爬进座位时竖直方向比水平方向快多少：先抬到地板以上再往里挪，脚不会穿过舱门下沿 */
const CLIMB_RISE = 1.6

/** 坐着时每帧喂给人形绑定的输入：站立、静止、无动作 */
const SEATED_INPUT: HumanoidAnimInput = { speed: 0, pose: 'stand', action: 'none', actionProgress: 0 }

/** 坐姿要改写的节点 */
interface SeatParts {
  /** 骨盆：原点在髋部中心 */
  body: Object3D
  thighL: Object3D
  thighR: Object3D
  shinL: Object3D
  shinR: Object3D
}

/** 从人形绑定上取出骨盆与腿部节点；不是 humanoid.ts 生成的绑定时返回 null */
function seatPartsOf(rig: HumanoidRig): SeatParts | null {
  if (!('parts' in rig)) return null
  const parts: unknown = rig.parts
  if (typeof parts !== 'object' || parts === null) return null
  const record = parts as Record<string, unknown>
  const pick = (key: keyof SeatParts): Object3D | null => {
    const node = record[key]
    return node instanceof Object3D ? node : null
  }
  const body = pick('body')
  const thighL = pick('thighL')
  const thighR = pick('thighR')
  const shinL = pick('shinL')
  const shinR = pick('shinR')
  if (!body || !thighL || !thighR || !shinL || !shinR) return null
  return { body, thighL, thighR, shinL, shinR }
}

/** 坐在座位上的一名队友 */
export interface SeatedRig {
  /** 推进爬进座位的过渡并刷新坐姿；每帧调用 */
  update(dt: number): void
}

/**
 * 把人形模型挂到座位锚点下（保持当前世界位姿），之后在 climbTime 秒内挪进座位坐下。
 * @param rig 人形绑定（原点在脚底、正面朝 +Z），此时应站在舱门口
 * @param anchor 座位锚点：原点在骨盆落座处，本地 +Z 朝向舱门
 * @param climbTime 从舱门口挪进座位的时长（秒）；不为正时立刻坐好
 */
export function createSeatedRig(rig: HumanoidRig, anchor: Object3D, climbTime: number): SeatedRig {
  const root = rig.root
  const parts = seatPartsOf(rig)
  root.visible = true
  anchor.attach(root)

  const fromPos = root.position.clone()
  const fromQuat = root.quaternion.clone()
  const seatPos = new Vector3(0, SEAT_LIFT, 0)
  const seatQuat = new Quaternion()
  let time = 0

  /** 按坐姿权重 k 改写骨盆与双腿（在人形绑定本帧的站立姿态之上混合） */
  const poseSeated = (k: number): void => {
    if (!parts) return
    const { body, thighL, thighR, shinL, shinR } = parts
    // 骨盆落到锚点（root 原点）上，身体摆正
    body.position.set(lerp(body.position.x, 0, k), lerp(body.position.y, 0, k), lerp(body.position.z, 0, k))
    body.rotation.set(lerp(body.rotation.x, 0, k), lerp(body.rotation.y, 0, k), lerp(body.rotation.z, 0, k))
    thighL.rotation.set(lerp(thighL.rotation.x, HIP_FLEX, k), 0, lerp(thighL.rotation.z, LEG_SPLAY, k))
    thighR.rotation.set(lerp(thighR.rotation.x, HIP_FLEX, k), 0, lerp(thighR.rotation.z, -LEG_SPLAY, k))
    shinL.rotation.x = lerp(shinL.rotation.x, KNEE_BEND, k)
    shinR.rotation.x = lerp(shinR.rotation.x, KNEE_BEND, k)
  }

  return {
    update(dt) {
      time += dt
      const u = climbTime > 0 ? Math.min(1, time / climbTime) : 1
      const across = smoothstep(u)
      const rise = smoothstep(Math.min(1, u * CLIMB_RISE))
      root.position.set(
        lerp(fromPos.x, seatPos.x, across),
        lerp(fromPos.y, seatPos.y, rise),
        lerp(fromPos.z, seatPos.z, across),
      )
      root.quaternion.slerpQuaternions(fromQuat, seatQuat, across)
      rig.update(dt, SEATED_INPUT)
      poseSeated(rise)
    },
  }
}

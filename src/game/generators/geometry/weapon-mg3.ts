/**
 * MG3（银色杀手）：银灰色冲压机匣、带长圆散热孔的方形枪管护套、喇叭口助退器、展开的两脚架、
 * 左侧弹箱与一段弹链、鱼尾形枪托。
 * 坐标：root 原点在握把顶端虎口处，枪管朝 +Z，轴线高度 0.066；全长约 1.183m（Z -0.383..0.800）。
 */

import type { BufferGeometry } from 'three'
import { box, createLayer, lathe, loft, outline, profile, rect, ring, rod, sec, slot, tube } from './weapon-kit'
import type { Pt, WeaponBlueprint } from './weapon-kit'

/** 枪管轴线高度 */
const AXIS = 0.066
/** 机匣半宽 */
const HALF = 0.022
/** 枪管护套：半宽、前后端、上下沿、棱角圆杆半径 */
const JACKET = 0.021
const J0 = 0.205
const J1 = 0.7
const J_LO = 0.04
const J_HI = 0.092
const J_EDGE = 0.0028
/** 散热孔：第一个孔的起点、孔长、孔距 */
const VENT_Z = 0.224
const VENT_LEN = 0.044
const VENT_PITCH = 0.058

/** 第 i 个散热孔（可跨 span 个孔位）的轮廓 */
function vent(i: number, lo: number, hi: number, span = 1): Pt[] {
  const z0 = VENT_Z + i * VENT_PITCH
  return slot(z0, z0 + (span - 1) * VENT_PITCH + VENT_LEN, lo, hi, 4)
}

/** 弹链中心线（从正前方看的 X-Y 平面）：在托弹板上平走一段，向外下弯，再垂入弹箱 */
function beltPoint(s: number): readonly [number, number] {
  const flat = 0.013
  const radius = 0.025
  const arc = (radius * Math.PI) / 2
  if (s < flat) return [0.027 + s, 0.104]
  if (s < flat + arc) {
    const a = (s - flat) / radius
    return [0.04 + Math.sin(a) * radius, 0.079 + Math.cos(a) * radius]
  }
  return [0.065, 0.079 - (s - flat - arc)]
}

/** 一发枪弹（弹壳 + 弹头），轴线平行于枪管 */
function cartridge(x: number, y: number): BufferGeometry {
  return lathe(
    [
      [0.034, 0.0055],
      [0.074, 0.0052],
      [0.079, 0.0042],
      [0.084, 0.0042],
      [0.096, 0.0012],
    ],
    y,
    x,
    8,
  )
}

/**
 * 生成 MG3 的模型蓝图。
 * @returns 拉丝钢、发黑钢、聚合物、军绿漆弹箱、黄铜枪弹五个图层与枪口位置
 */
export function buildMg3(): WeaponBlueprint {
  const silver = createLayer('steel', { roughness: 0.44 }, [7, 7])
  const dark = createLayer('gunmetal', {}, [6, 6])
  const poly = createLayer('polymer', { color: 0x1d1e21 }, [8, 8])
  const olive = createLayer('paintedMetal', { color: 0x5f6d3e }, [5, 5])
  const brass = createLayer('steel', { color: 0xdcaa4c, roughness: 0.36 }, [10, 10])

  /* ── 机匣与受弹机盖 ── */

  // 冲压机匣：后下缘收斜，前端下缘抬高后接枪管护套
  silver.add(
    profile(
      outline([
        [-0.15, 0.095, 0.003],
        [-0.15, 0.036, 0.006],
        [-0.07, 0.026, 0.004],
        [0.105, 0.026, 0.004],
        [0.125, 0.04, 0.004],
        [0.212, 0.04],
        [0.212, 0.095],
      ]),
      HALF * 2,
      { bevel: 0.002 },
    ),
  )
  // 机匣尾的缓冲器套箍
  dark.add(
    loft(
      [
        sec(-0.162, 0.041, 0.089, 0.019, 3),
        sec(-0.16, 0.039, 0.091, 0.0205, 3),
        sec(-0.149, 0.039, 0.091, 0.0205, 3),
      ],
      { segments: 20 },
    ),
  )

  // 受弹机盖：扁平的盒盖，前端铰接，后端卡锁
  silver.add(
    loft(
      [
        sec(-0.052, 0.094, 0.106, 0.019, 4),
        sec(-0.044, 0.094, 0.116, 0.0225, 4),
        sec(0.15, 0.094, 0.119, 0.0235, 4),
        sec(0.166, 0.094, 0.108, 0.021, 4),
      ],
      { segments: 20 },
    ),
  )
  for (const side of [-1, 1]) silver.add(box(0.005, 0.004, 0.16, side * 0.011, 0.1195, 0.055, 0.001))
  dark.add(box(0.016, 0.008, 0.012, 0, 0.108, -0.054, 0.0012))
  dark.add(rod(0.004, [-0.0245, 0.1, 0.168], [0.0245, 0.1, 0.168], 10))
  // 左侧托弹板、右侧弹链节出口
  silver.add(box(0.012, 0.006, 0.07, 0.028, 0.096, 0.064, 0.001))
  silver.add(box(0.007, 0.018, 0.058, -0.0245, 0.086, 0.064, 0.0015))

  // 右侧拉机柄滑槽与拉机柄
  dark.add(box(0.0016, 0.007, 0.21, -HALF - 0.0006, 0.066, 0.03, 0.0005))
  dark.add(box(0.008, 0.012, 0.014, -0.027, 0.066, 0.115, 0.0012))
  dark.add(rod(0.0045, [-0.03, 0.066, 0.115], [-0.052, 0.066, 0.115], 10, 0.006))

  // 铆钉与销轴（贯穿两侧，略微凸出）
  const pins: readonly Pt[] = [
    [-0.138, 0.046],
    [-0.138, 0.084],
    [-0.09, 0.04],
    [-0.03, 0.036],
    [0.02, 0.036],
    [0.085, 0.036],
    [0.14, 0.05],
    [0.19, 0.05],
    [0.19, 0.084],
  ]
  for (const [z, y] of pins) dark.add(rod(0.0026, [-HALF - 0.0008, y, z], [HALF + 0.0008, y, z], 8))

  /* ── 枪管护套 ── */

  // 左侧板：一排长圆散热孔
  const leftVents: Pt[][] = []
  for (let i = 0; i < 8; i++) leftVents.push(vent(i, 0.054, 0.078))
  silver.add(
    profile(rect(J0, J1, J_LO + J_EDGE, J_HI - J_EDGE), 0.002, { bevel: 0.0005, x: JACKET - 0.001, holes: leftVents }),
  )
  // 右侧板：后段是更换枪管用的长槽，前段是散热孔
  const rightVents: Pt[][] = [vent(0, 0.051, 0.081, 3)]
  for (let i = 3; i < 8; i++) rightVents.push(vent(i, 0.054, 0.078))
  silver.add(
    profile(rect(J0, J1, J_LO + J_EDGE, J_HI - J_EDGE), 0.002, {
      bevel: 0.0005,
      x: -(JACKET - 0.001),
      holes: rightVents,
    }),
  )
  // 顶板：先在侧视平面里挤出，再转成水平
  const topVents: Pt[][] = []
  for (let i = 0; i < 7; i++) topVents.push(vent(i, -0.009, 0.009))
  const topPlate = profile(rect(J0, J1, -(JACKET - J_EDGE), JACKET - J_EDGE), 0.002, { bevel: 0.0005, holes: topVents })
  topPlate.rotateZ(Math.PI / 2).translate(0, J_HI - 0.001, 0)
  silver.add(topPlate)
  // 底板与四条圆棱
  silver.add(box((JACKET - J_EDGE) * 2, 0.002, J1 - J0, 0, J_LO + 0.001, (J0 + J1) / 2, 0.0005))
  for (const sx of [-1, 1]) {
    for (const y of [J_LO + J_EDGE, J_HI - J_EDGE]) {
      silver.add(tube(J_EDGE, J0, J1, y, sx * (JACKET - J_EDGE), 8))
    }
  }
  // 护套前端收成圆口
  silver.add(
    loft(
      [
        sec(J1 - 0.001, J_LO, J_HI, JACKET, 6),
        sec(J1 + 0.008, 0.043, 0.089, 0.0205, 3),
        sec(J1 + 0.02, 0.048, 0.084, 0.018, 2),
      ],
      { segments: 20 },
    ),
  )

  // 护套内的枪管（从散热孔里能看到）
  dark.add(
    lathe(
      [
        [0.15, 0.0135],
        [0.25, 0.0135],
        [0.256, 0.012],
        [0.716, 0.012],
      ],
      AXIS,
    ),
  )
  // 枪口助退器：套筒、锁紧环、喇叭形消焰罩（带内膛）
  dark.add(
    lathe(
      [
        [0.714, 0.0165],
        [0.74, 0.0165],
        [0.74, 0.0195],
        [0.752, 0.0195],
        [0.752, 0.0135],
        [0.76, 0.0125],
        [0.8, 0.0175],
        [0.8, 0.0152],
        [0.765, 0.0075],
        [0.765, 0],
      ],
      AXIS,
      0,
      20,
    ),
  )

  /* ── 瞄具 ── */

  // 表尺：座、斜板、两片照门耳
  dark.add(box(0.02, 0.007, 0.034, 0, 0.0985, 0.195, 0.001))
  dark.add(
    profile(
      outline(
        [
          [0.181, 0.101],
          [0.211, 0.101],
          [0.211, 0.105, 0.001],
          [0.19, 0.111, 0.002],
          [0.181, 0.111, 0.001],
        ],
        2,
      ),
      0.012,
      { bevel: 0.0008 },
    ),
  )
  for (const side of [-1, 1]) dark.add(box(0.0045, 0.013, 0.004, side * 0.00375, 0.1165, 0.184, 0.0006))
  // 准星：座与三角立片
  dark.add(box(0.014, 0.005, 0.022, 0, 0.0945, 0.672, 0.001))
  dark.add(
    profile(
      [
        [0.664, 0.096],
        [0.68, 0.096],
        [0.6745, 0.122],
        [0.6695, 0.122],
      ],
      0.004,
      { bevel: 0.0007 },
    ),
  )

  /* ── 握把与扳机组 ── */

  // 握把座
  dark.add(
    profile(
      outline([
        [-0.045, 0.028],
        [-0.045, 0.016, 0.004],
        [-0.02, 0.008, 0.004],
        [0.03, 0.008, 0.003],
        [0.035, 0.018],
        [0.088, 0.018, 0.003],
        [0.09, 0.028],
      ]),
      0.03,
      { bevel: 0.002 },
    ),
  )
  // 聚合物握把：向后下方倾斜
  poly.add(
    loft(
      [
        { t: -0.102, c: -0.037, a: 0.019, w: 0.0135, n: 3 },
        { t: -0.098, c: -0.036, a: 0.0225, w: 0.016, n: 3 },
        { t: -0.06, c: -0.023, a: 0.0215, w: 0.016, n: 3 },
        { t: -0.02, c: -0.01, a: 0.021, w: 0.0155, n: 3 },
        { t: 0.012, c: 0, a: 0.021, w: 0.015, n: 3 },
      ],
      { axis: 'y', segments: 20 },
    ),
  )
  // 握把座上的横推式保险
  silver.add(rod(0.0042, [-0.0172, 0.017, -0.012], [0.0172, 0.017, -0.012], 10))
  // 扳机护圈与扳机
  dark.add(
    profile(
      outline([
        [0.022, 0.02],
        [0.084, 0.02],
        [0.084, -0.03, 0.01],
        [0.022, -0.03, 0.01],
      ]),
      0.012,
      {
        bevel: 0.0008,
        holes: [
          outline([
            [0.0248, 0.0175],
            [0.0812, 0.0175],
            [0.0812, -0.0272, 0.008],
            [0.0248, -0.0272, 0.008],
          ]),
        ],
      },
    ),
  )
  dark.add(
    profile(
      outline(
        [
          [0.042, 0.02],
          [0.051, 0.02],
          [0.0495, 0.006, 0.004],
          [0.046, -0.008, 0.003],
          [0.049, -0.016, 0.002],
          [0.045, -0.017, 0.002],
          [0.041, -0.006, 0.004],
          [0.0425, 0.008, 0.004],
        ],
        2,
      ),
      0.006,
      { bevel: 0.0008 },
    ),
  )

  /* ── 鱼尾形枪托 ── */

  // 前段是细颈，向后下沿迅速下沉，展开成高而扁的托底
  poly.add(
    loft(
      [
        sec(-0.383, -0.012, 0.1, 0.0135, 3),
        sec(-0.376, -0.02, 0.104, 0.0175, 3),
        sec(-0.35, -0.012, 0.1, 0.0185, 3),
        sec(-0.31, 0.012, 0.093, 0.018, 3),
        sec(-0.26, 0.034, 0.088, 0.017, 3),
        sec(-0.2, 0.044, 0.087, 0.017, 3),
        sec(-0.162, 0.043, 0.088, 0.0185, 3),
        sec(-0.152, 0.043, 0.088, 0.0185, 3),
      ],
      { segments: 20 },
    ),
  )
  // 托底背带环与护套左侧背带环
  dark.add(ring(0.008, 0.0014, 0, 0.004, -0.318, 'x', 14, 6))
  dark.add(ring(0.007, 0.0013, JACKET + 0.004, AXIS, 0.652, 'z', 14, 6))

  /* ── 两脚架（展开） ── */

  const hingeY = 0.033
  const bipodZ = 0.6
  dark.add(box(0.034, 0.014, 0.03, 0, 0.0345, bipodZ, 0.002))
  dark.add(rod(0.0035, [-0.02, hingeY, bipodZ], [0.02, hingeY, bipodZ], 8))
  const legLength = 0.27
  const splay = 0.38
  for (const side of [-1, 1]) {
    const footX = side * (0.012 + Math.sin(splay) * legLength)
    const footY = hingeY - Math.cos(splay) * legLength
    const footZ = bipodZ + 0.016
    silver.add(rod(0.0058, [side * 0.012, hingeY, bipodZ], [footX, footY, footZ], 10, 0.005))
    // 脚掌：平板 + 前端上翘
    dark.add(
      profile(
        outline(
          [
            [footZ - 0.017, footY - 0.004],
            [footZ + 0.012, footY - 0.004, 0.004],
            [footZ + 0.019, footY + 0.004, 0.002],
            [footZ + 0.016, footY + 0.006, 0.002],
            [footZ + 0.01, footY + 0.001, 0.003],
            [footZ - 0.017, footY + 0.001],
          ],
          2,
        ),
        0.03,
        // 脚掌前端只有约 3mm 厚，倒角过大会让内缩后的轮廓自交
        { bevel: 0.0007, x: footX + side * 0.003 },
      ),
    )
  }

  /* ── 左侧弹箱与弹链 ── */

  const boxX = 0.068
  // 箱体：四壁 + 底，顶部后半敞开让弹链出来
  const walls = profile(rect(0.015, 0.165, -0.035, 0.035, 0.004), 0.105, {
    bevel: 0.0008,
    holes: [rect(0.018, 0.162, -0.032, 0.032, 0.002)],
  })
  walls.rotateZ(Math.PI / 2).translate(boxX, -0.012, 0)
  olive.add(walls)
  olive.add(box(0.068, 0.004, 0.148, boxX, -0.0615, 0.09, 0.001))
  // 前半的箱盖、外侧压筋
  olive.add(box(0.074, 0.008, 0.07, boxX, 0.0415, 0.132, 0.002))
  olive.add(box(0.002, 0.062, 0.104, boxX + 0.0355, -0.014, 0.09, 0.0008))
  // 搭扣、提环、挂在机匣上的托架
  dark.add(box(0.014, 0.022, 0.004, boxX, 0.026, 0.1665, 0.001))
  dark.add(ring(0.012, 0.0014, boxX + 0.037, 0.012, 0.09, 'x', 14, 6))
  silver.add(box(0.013, 0.012, 0.06, 0.0275, 0.03, 0.09, 0.0015))

  // 弹链：从受弹口向左伸出，垂入弹箱
  for (let i = 0; i < 9; i++) {
    const [x, y] = beltPoint(0.004 + i * 0.0125)
    brass.add(cartridge(x, y))
    dark.add(tube(0.0062, 0.046, 0.064, y, x, 8))
  }
  // 箱内平铺的一层
  for (const x of [0.044, 0.0535, 0.0785, 0.091]) {
    brass.add(cartridge(x, 0.018))
    dark.add(tube(0.0062, 0.046, 0.064, 0.018, x, 8))
  }

  return {
    layers: [silver.build(), dark.build(), poly.build(), olive.build(), brass.build()],
    muzzle: [0.8, AXIS],
  }
}

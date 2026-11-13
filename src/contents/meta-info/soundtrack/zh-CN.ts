/**
 * 音乐鉴赏的曲目文案（简体中文），schema 事实源，en.ts 以 `typeof zhCN` 锁定结构一致。
 * 键与 src/game/generators/audio/gallery.ts 的 GalleryTrackId 对应。
 */

const zhCN = {
  round: {
    title: '回合战斗',
    desc: 'D 小调，132 BPM。底鼓、锯齿波贝斯、合成弦与方波琶音，滤波每 8 小节扫一个来回。每波进攻时播放，间歇期去掉鼓并压低音量。',
  },
  boss: {
    title: 'Boss 战',
    desc: 'F 小调，174 BPM 的 Drum and Bass。Amen 式切片碎拍与 reese 贝斯，8 小节前奏后落拍。Boss 登场时播放。',
  },
  idle: {
    title: '闲时',
    desc: 'D 小调。低频 drone、缓慢起伏的暗色和弦与零星钟音。原用于开局选枪界面。',
  },
  bossLegacy: {
    title: 'Boss 战（原版）',
    desc: 'C 小调，108 BPM。低音铜管、定音鼓、弦乐固定音型与圆号主题，逐段加厚。',
  },
}

export default zhCN

/**
 * ════════════════════════════════════════════════════════════════
 *  core/items.ts —— 物品
 * ════════════════════════════════════════════════════════════════
 *
 *  三类东西撑起这一层内容：
 *
 *   · narrative（叙事物件）—— 清空房间后掉落，拾起即开全屏剧情。
 *     storyNode 必须能在 stories.ts 里找到同 id 的节点。
 *
 *   · consumable（消耗品）—— hollow_tonic 是本作的核心张力：
 *     它用理智买命。角色变强和保命共用同一个池子，
 *     所以每一次"喝"都是在替后面的自己做一个决定。
 *
 *   · relic（遗物）—— 拿不到主动能力，只留一个 flag 和一句话。
 *     遗物的 effects 在获得时结算（引擎把 relic 的 effects 当被动处理）。
 *
 *  约定：所有 flag 名一律小写蛇形，结局判定只读 flag，不读分支树。
 * ════════════════════════════════════════════════════════════════
 */

import type { ItemDef } from '@core/types';

export const ITEMS: readonly ItemDef[] = [
  /* ─────────────────── 叙事物件（3）─────────────────── */

  {
    id: 'torn_case_notes',
    name: '撕裂的病历 · 第三页',
    kind: 'narrative',
    glyph: '?',
    desc: '纸是湿的，字却是干的。上面写着你的名字，笔迹也是你的。',
    storyNode: 'story_case_page',
  },
  {
    id: 'cracked_mirror_shard',
    name: '裂镜残片',
    kind: 'narrative',
    glyph: '(',
    desc: '一块镜子碎片。你举起它的时候，里面的那个人比你慢半拍。',
    storyNode: 'story_mirror_face',
  },
  {
    id: 'wax_cylinder',
    name: '蜡筒',
    kind: 'narrative',
    glyph: '~',
    desc: '值班室的机器还能转。录进去的声音一直在说同一句：交接完毕。',
    storyNode: 'story_cylinder_playback',
  },

  /* ─────────────────── 消耗品（3）─────────────────── */

  {
    id: 'hollow_tonic',
    name: '空瓶酊',
    kind: 'consumable',
    glyph: '!',
    desc: '瓶里是满的，瓶身是空的——两个事实同时成立。喝下去不疼，疼的是第二天你还记得自己喝过。',
    effects: [
      { kind: 'sanity', delta: -7 },
      { kind: 'heal', amount: 14 },
      { kind: 'setFlag', key: 'traded_flesh', value: true },
      { kind: 'message', text: '伤口合上了。你听见自己脑子里有什么东西跟着一起合上了。', tone: 'danger' },
    ],
  },
  {
    id: 'sedative_ampoule',
    name: '镇静安瓿',
    kind: 'consumable',
    glyph: '!',
    desc: '标签上写着"一次一支"。你想不起来上一次是什么时候。',
    effects: [
      { kind: 'sanity', delta: 8 },
      { kind: 'heal', amount: 2 },
      { kind: 'message', text: '走廊安静下来。安静得不像是走廊本身安静了。', tone: 'gain' },
    ],
  },
  {
    id: 'salt_chalk',
    name: '半截盐笔',
    kind: 'consumable',
    glyph: '!',
    desc: '在地上画一道线，线以内归你管。老护士都这么教，规程上从来没写过。',
    effects: [
      { kind: 'sanity', delta: 4 },
      { kind: 'setFlag', key: 'drew_the_line', value: true },
      { kind: 'message', text: '你画了一道线。线很直。画完你才发现，自己一直在往线的这一侧退。', tone: 'lore' },
    ],
  },

  /* ─────────────────── 遗物（3）─────────────────── */

  {
    id: 'sleepers_ledger',
    name: '睡眠者名册',
    kind: 'relic',
    glyph: '=',
    desc: '一整本名字，每一行后面有两个日期。第二个日期全都是今天。',
    effects: [
      { kind: 'setFlag', key: 'holds_the_ledger', value: true },
      { kind: 'message', text: '名册上的字很小，写得很省。你翻到最后一页，那一页是空的，但纸已经皱了。', tone: 'lore' },
    ],
  },
  {
    id: 'cracked_watch',
    name: '停在三点十七分的怀表',
    kind: 'relic',
    glyph: '=',
    desc: '秒针还在抖。放进兜里，隔着布你也能感觉到那点抖。',
    effects: [
      { kind: 'setFlag', key: 'stopped_watch', value: true },
      { kind: 'message', text: '表壳上有一道很深的划痕，正好划过表冠。像是有人试过把它拧停。', tone: 'ambient' },
    ],
  },
  {
    id: 'returning_coin',
    name: '回到口袋的硬币',
    kind: 'relic',
    glyph: '$',
    desc: '你把它扔过一次。下一次醒来，它又在口袋里，边缘被摸得发亮。',
    effects: [
      { kind: 'setFlag', key: 'carries_the_coin', value: true },
      { kind: 'message', text: '硬币正面是数字，背面也是数字。两面都是三。', tone: 'lore' },
    ],
  },

  /* ─────────────────── 钥匙（1）─────────────────── */

  {
    id: 'ward_key',
    name: '三号病区钥匙',
    kind: 'key',
    glyph: '+',
    desc: '钥匙牌上套着一段褪色的红绳。绳子的断口很旧了，旧得不像这一晚弄断的。',
    effects: [
      { kind: 'setFlag', key: 'holds_ward_key', value: true },
      { kind: 'message', text: '钥匙和锁眼对得上。你不记得自己什么时候试过。', tone: 'info' },
    ],
  },
];

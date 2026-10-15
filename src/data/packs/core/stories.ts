/**
 * ════════════════════════════════════════════════════════════════
 *  core/stories.ts —— 第一幕的剧情节点
 * ════════════════════════════════════════════════════════════════
 *
 *  十条走廊。没有人赢，只有人是第几次走到这里。
 *
 *  三条线交织：
 *
 *   1. 槽位线（slots）—— 地图生成器预留 ENTRY / MID / PREBOSS / SECRET，
 *      叙事引擎按槽位类型和 requires 挑节点填。
 *      ENTRY：story_entry_wake、story_missing_minute
 *      MID  ：story_repeat_room、story_chart_name
 *      PREBOSS：story_third_bell、story_handover
 *
 *   2. 物品线（storyNode）—— items.ts 里的叙事物件指向这里，
 *      拾起即打开，所以这三个节点【不写 requires / slots】，
 *      否则会出现"东西拿到了，剧情却不出现"。
 *      torn_case_notes       → story_case_page
 *      cracked_mirror_shard  → story_mirror_face
 *      wax_cylinder          → story_cylinder_playback
 *
 *   3. 链式线（next / goto）—— 全部指向 story_the_other_bed。
 *      它只挂在 SECRET 槽上，所以不会被随机塞进普通房间。
 *
 *  角色门控（requiresTag）散落在 7 个节点里：
 *   scholar 看到"记梦者"，healer 看到"值夜护士"，
 *   badge 只负责显示，不参与判定。
 *
 *  结局不走分支树，只认 flag。这里写下的每一个 setFlag，
 *  都在 act1.ts 的 endings 里被读一次。
 * ════════════════════════════════════════════════════════════════
 */

import type { StoryNode } from '@core/types';

export const STORIES: readonly StoryNode[] = [
  /* ═══════════════ 槽位线 ═══════════════ */

  {
    id: 'story_entry_wake',
    text:
      '你在走廊上醒过来。地砖是凉的，灯是值班室那种白，亮得没有影子。\n' +
      '墙上的钟停在三点十七分。秒针在抖，抖得很轻，但一直没走过去。\n' +
      '你穿着值班的外套。口袋里有什么东西，你想不起来是什么。',
    quote: '「三号病区，夜班，一人。」',
    slots: ['ENTRY'],
    // 刻意不设 maxDepth：ENTRY 槽每层必有 1 个，而 story_missing_minute
    // 要玩家在上一层看过钟才出现。不设上限才能保证任何一层都填得满。
    // 主题上也成立 —— 你确实又在走廊开头醒了一次。
    weight: 10,
    choices: [
      {
        text: '看那口钟',
        effects: [
          { kind: 'message', text: '你盯着秒针看了很久。它没有动。但你确定刚才它动过。', tone: 'ambient' },
          { kind: 'setFlag', key: 'saw_clock', value: true },
          { kind: 'sanity', delta: -2 },
        ],
      },
      {
        text: '摸一摸口袋',
        effects: [
          { kind: 'message', text: '一枚硬币，还有一张写着自己名字的纸条。你把纸条塞回去了。', tone: 'gain' },
          { kind: 'setFlag', key: 'checked_pockets', value: true },
        ],
      },
      {
        text: '把门口的值班牌读一遍',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '牌子上只有一行：本班无人接班。漆是新的，字是刚写的。', tone: 'lore' },
          { kind: 'setFlag', key: 'read_the_sign', value: true },
          { kind: 'sanity', delta: -3 },
        ],
      },
      {
        text: '先数一数还躺着几个人',
        requiresTag: 'healer',
        badge: '值夜护士',
        effects: [
          { kind: 'message', text: '四张床。三号床是空的，被子掀开着，还是温的。', tone: 'lore' },
          { kind: 'setFlag', key: 'counted_the_living', value: true },
          { kind: 'sanity', delta: 2 },
        ],
      },
    ],
  },

  {
    id: 'story_missing_minute',
    text:
      '钟还挂在那儿。这一次你看清了：秒针从五十九跳到零，又跳回五十九。\n' +
      '中间少了一分钟。你确定少了一分钟——因为你记得自己在这一分钟里做过一件事，却想不起来是什么事。',
    quote: '「值班记录第七页：三点十八分，无异常。」',
    requires: [{ kind: 'flag', key: 'saw_clock', value: true }],
    slots: ['ENTRY'],
    minDepth: 2,
    weight: 8,
    choices: [
      {
        text: '站在原地，把那一分钟想完',
        effects: [
          { kind: 'message', text: '你想了。你想不起来。但你确定那一分钟里有人跟你说了话。', tone: 'danger' },
          { kind: 'setFlag', key: 'chased_the_minute', value: true },
          { kind: 'sanity', delta: -5 },
        ],
      },
      {
        text: '把钟摘下来看看背面',
        effects: [
          { kind: 'message', text: '背面用指甲刻着两个字：别动。刻痕很新。', tone: 'lore' },
          { kind: 'setFlag', key: 'took_the_clock_down', value: true },
          { kind: 'sanity', delta: -2 },
        ],
      },
      {
        text: '在值班记录上把那一分钟补上',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '你写下"三点十七分至三点十八分，有人进来过"。写完你才发现，这一页上早就有你的签名。', tone: 'danger' },
          { kind: 'setFlag', key: 'wrote_the_gap', value: true },
          { kind: 'setFlag', key: 'knows_the_name', value: true },
          { kind: 'sanity', delta: -4 },
        ],
      },
    ],
  },

  {
    id: 'story_repeat_room',
    text:
      '这间屋子你来过。床的位置、墙上掉漆的形状、窗台上那半杯水，都一样。\n' +
      '连水面上那层灰都一样。你确定上一次自己也是站在这个位置，先看窗台，再看床。\n' +
      '你没办法向任何人证明这一点。',
    quote: '「你已经来过这里了。」——某页纸的边角',
    requires: [{ kind: 'deaths', op: '>=', value: 1 }],
    slots: ['MID'],
    weight: 6,
    choices: [
      {
        text: '把水杯挪开一寸',
        effects: [
          { kind: 'message', text: '你挪了。屋子安静下来，像是在等你确认什么。', tone: 'ambient' },
          { kind: 'setFlag', key: 'moved_the_cup', value: true },
        ],
      },
      {
        text: '什么都不动，原样退出去',
        effects: [
          { kind: 'message', text: '你退出去。门在身后关上的声音，比上一次早了半秒。', tone: 'ambient' },
          { kind: 'setFlag', key: 'left_it_alone', value: true },
          { kind: 'sanity', delta: 3 },
        ],
      },
      {
        text: '在墙上记下这一次',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '你在墙上划了一道。旁边已经有三十八道了，刻痕新旧不一。最后一道是你刚划的。', tone: 'danger' },
          { kind: 'addFlag', key: 'loop_marks', delta: 1 },
          { kind: 'sanity', delta: -6 },
        ],
      },
      {
        text: '给三号床的人盖好被子',
        requiresTag: 'healer',
        badge: '值夜护士',
        effects: [
          { kind: 'message', text: '你把被子掖好。被子里没有人，但是有温度。', tone: 'lore' },
          { kind: 'setFlag', key: 'covered_the_bed', value: true },
          { kind: 'sanity', delta: 4 },
        ],
      },
    ],
  },

  {
    id: 'story_chart_name',
    text:
      '床头卡上写着床号、姓名、入院日期。三号床的姓名栏是空的。\n' +
      '你翻过卡片，背面用铅笔写过一个名字，擦掉过很多次，纸都起毛了。\n' +
      '那三个字是你的名字。你想起口袋里那一页——笔迹是一样的。',
    quote: '「患者拒绝透露姓名，已按床号称呼。」',
    requires: [{ kind: 'hasItem', defId: 'torn_case_notes' }],
    slots: ['MID'],
    minDepth: 2,
    weight: 9,
    choices: [
      {
        text: '把床头卡放回去，就按床号叫他',
        effects: [
          { kind: 'message', text: '你把卡片放平。三号床安静了。你听见有人翻了个身。', tone: 'ambient' },
          { kind: 'setFlag', key: 'kept_the_number', value: true },
        ],
      },
      {
        text: '在姓名栏里补上名字',
        effects: [
          { kind: 'message', text: '你写下了。写完，卡片上别的字都淡了，只剩你刚写的三个字。', tone: 'danger' },
          { kind: 'setFlag', key: 'wrote_the_name', value: true },
          { kind: 'setFlag', key: 'knows_the_name', value: true },
          { kind: 'sanity', delta: -5 },
        ],
      },
      {
        text: '把卡片夹进病历带走',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '你把它夹进那一页。两处的笔迹叠在一起，像是同一只手写的。', tone: 'lore' },
          { kind: 'setFlag', key: 'kept_the_card', value: true },
          { kind: 'giveItem', defId: 'sleepers_ledger' },
        ],
        next: 'story_the_other_bed',
      },
      {
        text: '把三号床的床栏拉起来扣好',
        requiresTag: 'healer',
        badge: '值夜护士',
        effects: [
          { kind: 'message', text: '这是你上夜班第一天学的第一件事。做完，你的手不抖了。', tone: 'gain' },
          { kind: 'setFlag', key: 'raised_the_rail', value: true },
          { kind: 'sanity', delta: 4 },
          { kind: 'heal', amount: 3 },
        ],
      },
    ],
  },

  {
    id: 'story_third_bell',
    text:
      '走廊尽头有一扇门，门上有个小窗。窗里面是黑的，黑里面有一口钟。\n' +
      '钟没有响，可你已经在数它的次数了：一下、两下、三下。\n' +
      '数到第三下的时候你才发现自己在数，而且停不下来。',
    quote: '「夜间铃响三次以上，通知值班医师。医师未到之前，不得离开岗位。」',
    slots: ['PREBOSS'],
    minDepth: 2,
    weight: 9,
    choices: [
      {
        text: '伸手把指针拨过去',
        effects: [
          { kind: 'message', text: '你把指针拨过了三点十八分。走廊的灯同时暗了一下，又亮了。钟开始走。', tone: 'danger' },
          { kind: 'setFlag', key: 'moved_the_hand', value: true },
          { kind: 'sanity', delta: -8 },
        ],
      },
      {
        text: '捂住耳朵，等它数完',
        effects: [
          { kind: 'message', text: '你等了。它数到十七就停了。值班规程里没有十七这个数。', tone: 'ambient' },
          { kind: 'setFlag', key: 'waited_out_the_bell', value: true },
          { kind: 'sanity', delta: -3 },
        ],
      },
      {
        text: '按规程去找值班医师',
        effects: [
          { kind: 'message', text: '你敲了值班室的门。里面有人应了一声，说"就来"。你等到灯灭，门没有开。', tone: 'danger' },
          { kind: 'setFlag', key: 'called_the_doctor', value: true },
          { kind: 'sanity', delta: -4 },
        ],
      },
      {
        text: '在记录上写"三点十七分，铃响三次"',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '你写完抬头，记录上已经有了一行一模一样的字，笔迹一样，墨还没干。', tone: 'danger' },
          { kind: 'setFlag', key: 'logged_the_bell', value: true },
          { kind: 'sanity', delta: -5 },
        ],
      },
    ],
  },

  {
    id: 'story_handover',
    text:
      '值班室的门开着。桌上摊着一本交班记录，钢笔搁在纸边上，笔帽没盖。\n' +
      '最后一行是上一班写的：本班无人接班。下面留着空行，等你写。\n' +
      '窗外有一点亮了，但钟还是三点十七分。',
    quote: '「交班人签名：______　接班人签名：______」',
    slots: ['PREBOSS'],
    minDepth: 3,
    weight: 10,
    choices: [
      {
        text: '在接班人那一栏签名',
        effects: [
          { kind: 'message', text: '你签了。笔尖离开纸面的时候，窗外亮了一下，又黑回去。', tone: 'danger' },
          { kind: 'setFlag', key: 'signed_the_handover', value: true },
          { kind: 'sanity', delta: -10 },
        ],
      },
      {
        text: '把记录合上',
        effects: [
          { kind: 'message', text: '合上之前你看见了交班人那一栏。那儿也有一个名字，也是你的字。', tone: 'lore' },
          { kind: 'setFlag', key: 'refused_the_handover', value: true },
          { kind: 'setFlag', key: 'knows_the_name', value: true },
          { kind: 'sanity', delta: -4 },
        ],
      },
      {
        text: '先把三号床的记录补齐',
        requiresTag: 'healer',
        badge: '值夜护士',
        effects: [
          { kind: 'message', text: '你一笔一笔补完了七条。补到第四条你才发现，这七条今晚你都做过。', tone: 'danger' },
          { kind: 'setFlag', key: 'completed_the_log', value: true },
          { kind: 'setFlag', key: 'signed_the_handover', value: true },
          { kind: 'heal', amount: 6 },
          { kind: 'sanity', delta: -6 },
        ],
      },
      {
        text: '拉开桌子下面的抽屉',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '抽屉里有一支没用过的针和一小瓶东西。标签被撕了，只剩下"必要时"三个字。', tone: 'gain' },
          { kind: 'setFlag', key: 'opened_the_drawer', value: true },
          { kind: 'giveItem', defId: 'hollow_tonic' },
          { kind: 'sanity', delta: -2 },
        ],
      },
    ],
  },

  /* ═══════════════ 物品线（拾起即开，故不设 requires / slots）═══════════════ */

  {
    id: 'story_case_page',
    text:
      '病历的第三页。入院日期那一栏被撕掉了，剩下的字你一个一个读下来：\n' +
      '主诉：反复梦见同一条走廊。\n' +
      '现病史：患者坚称自己是值夜的人。\n' +
      '最后一行是签名。签名是你的。',
    quote: '「处理意见：继续观察，勿使患者接触值班室。」',
    choices: [
      {
        text: '把这一页读到底',
        effects: [
          { kind: 'message', text: '处理意见后面还有一行小字：本页由患者本人填写。', tone: 'danger' },
          { kind: 'setFlag', key: 'knows_the_name', value: true },
          { kind: 'sanity', delta: -5 },
        ],
      },
      {
        text: '折起来，塞回口袋',
        effects: [
          { kind: 'message', text: '你折得很整齐。折到第三折的时候，纸自己合上了。', tone: 'ambient' },
          { kind: 'setFlag', key: 'folded_the_page', value: true },
          { kind: 'sanity', delta: 2 },
        ],
      },
      {
        text: '比对一下笔迹',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '起笔、收笔、连笔，全都一样。可你没有写过这一页。', tone: 'danger' },
          { kind: 'setFlag', key: 'matched_the_handwriting', value: true },
          { kind: 'setFlag', key: 'knows_the_name', value: true },
          { kind: 'sanity', delta: -7 },
        ],
      },
      {
        text: '翻到背面',
        effects: [
          { kind: 'message', text: '背面只有一句话，被水泡开了一半：别签。', tone: 'lore' },
          { kind: 'setFlag', key: 'read_the_back', value: true },
          { kind: 'goto', nodeId: 'story_the_other_bed' },
        ],
      },
    ],
  },

  {
    id: 'story_mirror_face',
    text:
      '碎片里有一张脸。是你，但比你慢半拍——你眨眼，它过一会儿才眨；你停下，它还在动。\n' +
      '你把碎片举高一点，想看清它后面。碎片后面的走廊里没有人。\n' +
      '可那条走廊里站着一个人。',
    quote: '「镜子里的人先到的。」',
    choices: [
      {
        text: '盯着它，直到它先停下',
        effects: [
          { kind: 'message', text: '它先停了。停的时候它的嘴动了一下，像是在数数。', tone: 'danger' },
          { kind: 'setFlag', key: 'mirror_looked_back', value: true },
          { kind: 'sanity', delta: -6 },
        ],
      },
      {
        text: '把碎片扣在地上',
        effects: [
          { kind: 'message', text: '碎片扣住了。你还是能听见底下有很轻的呼吸声。', tone: 'ambient' },
          { kind: 'setFlag', key: 'dropped_the_shard', value: true },
          { kind: 'sanity', delta: -2 },
        ],
      },
      {
        text: '照一照自己的手，确认自己还在这里',
        requiresTag: 'healer',
        badge: '值夜护士',
        effects: [
          { kind: 'message', text: '手是热的，指甲缝里有干掉的碘伏。你确认过了：你在这里。', tone: 'gain' },
          { kind: 'setFlag', key: 'checked_hands', value: true },
          { kind: 'sanity', delta: 5 },
          { kind: 'heal', amount: 2 },
        ],
      },
    ],
  },

  {
    id: 'story_cylinder_playback',
    text:
      '值班室的机器还能转。你把蜡筒装上去，针落下去，先是一段很长的空白，然后是你的声音。\n' +
      '「三号病区交接，交班人——」\n' +
      '声音停在这里。第二遍还是停在这里。第三遍的时候，那个声音换了个说法：「接班人——」',
    quote: '「录音设备一台，功能正常。」——设备清单第 4 项',
    choices: [
      {
        text: '再听一遍，听清后面',
        effects: [
          { kind: 'message', text: '第四遍，后面多了一个名字。名字是你在心里默念的那个。', tone: 'danger' },
          { kind: 'setFlag', key: 'played_the_cylinder', value: true },
          { kind: 'setFlag', key: 'knows_the_name', value: true },
          { kind: 'sanity', delta: -6 },
        ],
      },
      {
        text: '把蜡筒退出来',
        effects: [
          { kind: 'message', text: '你退出来了。机器空转了几秒，自己停了。', tone: 'ambient' },
          { kind: 'setFlag', key: 'stopped_the_cylinder', value: true },
        ],
      },
      {
        text: '在设备清单上找这台机器的编号',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '第 4 项旁边有人用铅笔添了一句：本机不归本科室管理。', tone: 'lore' },
          { kind: 'setFlag', key: 'found_the_machine', value: true },
          { kind: 'sanity', delta: -3 },
        ],
      },
    ],
  },

  /* ═══════════════ 链式线（next / goto 的落点，只挂 SECRET）═══════════════ */

  {
    id: 'story_the_other_bed',
    text:
      '三号床旁边还有一张床。你一直没往那边看，因为这间屋子只有三张床。\n' +
      '床上躺着一个人，被子盖到下巴，脸朝着墙。\n' +
      '你没有走过去。你已经知道被子底下是谁了。',
    quote: '「加床一张，未登记。」',
    slots: ['SECRET'],
    weight: 5,
    choices: [
      {
        text: '把被子拉下来',
        effects: [
          { kind: 'message', text: '被子底下没有人。枕头是凹的，还是温的，凹成一个头的形状。', tone: 'danger' },
          { kind: 'setFlag', key: 'saw_the_other_bed', value: true },
          { kind: 'sanity', delta: -7 },
        ],
      },
      {
        text: '退出去，把门带上',
        effects: [
          { kind: 'message', text: '你退出去。关门的时候，你听见床上的人换了个姿势。', tone: 'ambient' },
          { kind: 'setFlag', key: 'left_the_other_bed', value: true },
          { kind: 'sanity', delta: -1 },
        ],
      },
      {
        text: '替他把被子掖好',
        requiresTag: 'healer',
        badge: '值夜护士',
        effects: [
          { kind: 'message', text: '你掖好了。手指碰到枕头的时候，枕头是凉的——刚才还是温的。', tone: 'lore' },
          { kind: 'setFlag', key: 'tucked_him_in', value: true },
          { kind: 'sanity', delta: 3 },
        ],
      },
      {
        text: '看床尾的牌子',
        requiresTag: 'scholar',
        badge: '记梦者',
        effects: [
          { kind: 'message', text: '牌子背面有铅笔字：加床一张，未登记。登记日期是今天。', tone: 'danger' },
          { kind: 'setFlag', key: 'read_the_extra_tag', value: true },
          { kind: 'sanity', delta: -3 },
        ],
      },
    ],
  },
];

/**
 * ════════════════════════════════════════════════════════════════
 *  core/act1.ts —— 第一幕
 * ════════════════════════════════════════════════════════════════
 *
 *  三层，一层比一层低。往下走不需要钥匙，只需要还想得起来自己是谁。
 *
 *  ── 三个结局，都是死 ──
 *  官方内容只写绝望线：本幕结束时所有角色都会死。区别只在于怎么死。
 *  救赎线留给社区扩展 —— 官方负责定义"什么是不可能的"。
 *
 *  判定只看 flag，不看走过了哪条分支：
 *
 *   ending_signed_the_shift    priority 30  knows_the_name
 *                                          + signed_the_handover
 *                                          + carries_the_coin
 *                              你成了这个夜班的一部分。
 *
 *   ending_seventeenth_minute  priority 20  moved_the_hand
 *                                          + （traded_flesh 或 deaths >= 1）
 *                              你换到了力量，时间把你收回去。
 *
 *   ending_nobody_came         priority 0   requires: []（兜底）
 *                              没有人来接班，也没有人来接你。
 *
 *  数组按 priority 从大到小排列，引擎"第一个满足的即命中"
 *  和"取 priority 最大的"两种实现都能得到同一结果。
 *
 *  flag 来源（改动数据时同步检查）：
 *    knows_the_name       story_missing_minute / story_case_page /
 *                         story_chart_name / story_cylinder_playback /
 *                         story_handover
 *    signed_the_handover  story_handover（healer 选项也会置位）
 *    carries_the_coin     items.ts → returning_coin（遗物，获得时置位）
 *    moved_the_hand       story_third_bell
 *    traded_flesh         items.ts → hollow_tonic（拿理智换命）
 *    deaths               引擎维护的跨局累计死亡数
 * ════════════════════════════════════════════════════════════════
 */

import type { ActDef } from '@core/types';

export const ACT_1: ActDef = {
  id: 'act_1',
  name: '第一幕 · 三点十七分',
  desc:
    '三号病区的夜班一向只有一个人。你在一间不断往下沉的病房楼里醒过来，' +
    '每往下一层，走廊就更像你昨天走过的那一条。\n' +
    '这里没有出口，只有更深的地方。死了也不会出去——你只会又在走廊开头醒一次，' +
    '并且记得更多一点。',

  floors: 3,
  floorSize: { w: 21, h: 15 },
  roomsPerFloor: [6, 8],
  //  ── 2026-10 平衡调整（有实测依据）──
  //
  //  原本是 [4, 7]。实测发现这是「清房间掉叙事物件」这条核心链路的瓶颈：
  //
  //    记梦者 hp22 / def1：打一只 depth-1 的怪要挨 4~9 血
  //                        → 一条命只能打 2~5 架
  //    值夜护士 hp26 / def2：每架挨 2~6 血
  //                        → 一条命能打 4~13 架
  //    而一层有 4~7 只怪。
  //
  //  结果：护士清得完一层，记梦者清不完 —— 死 → 重开 → 又清不完，
  //  实测死亡 100+ 次。玩家还没看到剧情就先死了，
  //  而「清房间掉剧情」是本作的核心内容链路。
  //
  //  降密度而不是加血量：这是剧情向游戏，战斗不该占满整层。
  //  而且加记梦者的血会直接抹掉它 "frail" 的身份。
  enemiesPerFloor: [3, 5],

  endings: [
    {
      id: 'ending_signed_the_shift',
      name: '接班的人是你',
      priority: 30,
      requires: [
        {
          kind: 'all',
          of: [
            { kind: 'flag', key: 'knows_the_name', value: true },
            { kind: 'flag', key: 'signed_the_handover', value: true },
            { kind: 'flag', key: 'carries_the_coin', value: true },
          ],
        },
      ],
      text:
        '你写完了最后一个字。钢笔搁回纸边，笔帽还是没有盖。\n' +
        '走廊的灯一排一排灭下去，从最里面那盏开始，很守规矩。你没有跑。\n' +
        '你想起来了：你一直是接班的那个人，只是每一次都忘了。\n' +
        '天亮之前，值班表上会多出一行。名字是你的，班次是夜班，日期是今天。\n' +
        '下一个推门进来的人，会看见桌上摊着一本记录，翻开着，等他签名。',
      hint: '在还记得那个名字的时候，把手续签下去 —— 并且别把那枚硬币落下。',
      victory: false,
    },
    {
      id: 'ending_seventeenth_minute',
      name: '第十七分钟',
      priority: 20,
      requires: [
        {
          kind: 'all',
          of: [
            { kind: 'flag', key: 'moved_the_hand', value: true },
            {
              kind: 'any',
              of: [
                { kind: 'flag', key: 'traded_flesh', value: true },
                { kind: 'deaths', op: '>=', value: 1 },
              ],
            },
          ],
        },
      ],
      text:
        '指针拨过去的时候没有声音。走廊安静了一瞬，然后所有的钟一起开始走。\n' +
        '三点十七分。三点十八分。你听见自己在数。数到十七的时候你停住了——不是你想停，是数不下去。\n' +
        '你被放回走廊的开头。地砖是凉的，灯是白的，秒针在抖。\n' +
        '这一轮的事你全都记得。连外套口袋里有什么，你都记得。\n' +
        '你确实比上一次强了。这就是变强要付的东西。',
      hint: '去拨那口钟的指针。但拨针的手得有分量 —— 你得先拿什么去换过一次。',
      victory: false,
    },
    {
      id: 'ending_nobody_came',
      name: '没有人来接班',
      priority: 0,
      requires: [],
      text:
        '你走到了最深的地方。那里没有门，只有一张床，床单是新的，铺得很平。\n' +
        '你在床边坐了一会儿。没有人来，也没有人叫你。值班室那本记录还摊开着，空行还是空行。\n' +
        '钟停在三点十七分，终于不动了，秒针不用再抖。\n' +
        '你躺下了。这一次你没有做梦——你只是被留在了这里，' +
        '成了一间空病房里最后一件没有登记的东西。',
      victory: false,
    },
  ],
};

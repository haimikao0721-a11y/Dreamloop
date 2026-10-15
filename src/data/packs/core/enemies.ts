/**
 * ════════════════════════════════════════════════════════════════
 *  core/enemies.ts —— 第一幕的敌人
 * ════════════════════════════════════════════════════════════════
 *
 *  这里没有怪物，只有值班室里本来就有的东西：
 *  睡不着的病人、忘了自己是谁的护工、慢你半拍的影子、
 *  被剪掉的一分钟，以及上一班那个没能走掉的人。
 *
 *  它们不咆哮，也不追你很远。它们只是出现在你昨天站过的位置上。
 *
 *  数值曲线（minDepth 1 → 3）：
 *    hp 7~20 / atk 3~7 / def 0~2
 *  叙事物品（narrative）的掉落挂在 3 个怪身上，
 *  其中 repeated_patient / offgoing_nurse 是 guaranteed，
 *  保证"打到它们就一定会翻开一页剧情"。
 *
 *  tags 留着给将来的条件判定用（比如"只对 staff 生效的选项"）。
 * ════════════════════════════════════════════════════════════════
 */

import type { EnemyDef } from '@core/types';

export const ENEMIES: readonly EnemyDef[] = [
  {
    id: 'restless_sleeper',
    name: '睡不安稳的人',
    glyph: 'z',
    hp: 7,
    atk: 2,
    def: 0,
    /** 不主动。你从他床边走过三次，他才会睁眼 */
    ai: 'idle',
    tags: ['dreamt', 'slow'],
    minDepth: 1,
    drop: [
      { kind: 'nothing', weight: 6 },
      { kind: 'consumable', pool: ['sedative_ampoule', 'salt_chalk'], weight: 3 },
    ],
  },
  {
    id: 'blank_orderly',
    name: '空白的护工',
    glyph: 'o',
    hp: 11,
    atk: 3,
    def: 1,
    ai: 'aggressive',
    tags: ['staff', 'silent'],
    minDepth: 1,
    drop: [
      { kind: 'consumable', pool: ['salt_chalk', 'hollow_tonic'], weight: 4 },
      { kind: 'nothing', weight: 4 },
      {
        kind: 'key',
        pool: ['ward_key'],
        weight: 1,
        requires: [{ kind: 'depth', op: '>=', value: 2 }],
      },
    ],
  },
  {
    id: 'repeated_patient',
    name: '重复出现的病人',
    glyph: 'p',
    hp: 12,
    atk: 3,
    def: 1,
    ai: 'aggressive',
    tags: ['repeat', 'shame'],
    minDepth: 2,
    drop: [
      /** 同一个房间里的第三张床，永远是他 */
      { kind: 'narrative', pool: ['torn_case_notes'], weight: 1, guaranteed: true },
      { kind: 'nothing', weight: 4 },
    ],
  },
  {
    id: 'your_own_back',
    name: '你自己的背影',
    glyph: 'X',
    hp: 14,
    atk: 4,
    def: 1,
    ai: 'aggressive',
    tags: ['mirror', 'self'],
    minDepth: 2,
    drop: [
      { kind: 'narrative', pool: ['cracked_mirror_shard'], weight: 2 },
      { kind: 'nothing', weight: 3 },
    ],
  },
  {
    id: 'missing_minute',
    name: '缺失的一分钟',
    glyph: '?',
    hp: 16,
    atk: 5,
    def: 1,
    ai: 'aggressive',
    tags: ['time', 'absent'],
    minDepth: 3,
    drop: [
      { kind: 'relic', pool: ['cracked_watch', 'returning_coin'], weight: 2 },
      { kind: 'nothing', weight: 2 },
    ],
  },
  {
    id: 'offgoing_nurse',
    name: '交班的人',
    glyph: 'W',
    hp: 20,
    atk: 6,
    def: 1,
    ai: 'aggressive',
    tags: ['staff', 'knows_you'],
    minDepth: 3,
    drop: [
      { kind: 'narrative', pool: ['wax_cylinder'], weight: 1, guaranteed: true },
      { kind: 'consumable', pool: ['hollow_tonic'], weight: 2 },
    ],
  },
];

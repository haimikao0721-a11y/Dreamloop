/**
 * ════════════════════════════════════════════════════════════════
 *  data/rt/enemies.ts —— 实时层的敌人
 * ════════════════════════════════════════════════════════════════
 *
 *  两个敌人，设计上【刻意做成互补的】：
 *
 *    爬行物  快、脆、起手短  → 逼玩家不能站桩，必须走位
 *    护工    慢、厚、起手长  → 教玩家"看抬手、绕后、反击"
 *
 *  只有前者的话，游戏是纯反应测试；只有后者的话，游戏太慢。
 *  两个一起，玩家才会同时用上"躲"和"读"两种能力。
 * ════════════════════════════════════════════════════════════════
 */

import type { ActionDef, SpawnTemplate } from '@core/rt/types.js';

import { CRAWLER_BITE, ORDERLY_SLAM } from './actions.js';

export interface RtEnemyDef {
  readonly id: string;
  readonly name: string;
  readonly hp: number;
  /** 像素/秒 */
  readonly speed: number;
  readonly hw: number;
  readonly hh: number;
  readonly attack: ActionDef;
  readonly detectRange: number;
  readonly attackRange: number;
  readonly stopDistance: number;
  readonly cooldown: number;
  /**
   * 待在它旁边每秒扣多少理智（见 docs/06 第九节）。
   * 第 3 步才会真的用上，先写在数据里 —— 数值是设计的一部分，
   * 拆到两个文件里改起来容易漏。
   */
  readonly sanDrain: number;
  /** 渲染用：动作帧素材的目录名 */
  readonly sprite: string;
}

export const CRAWLER: RtEnemyDef = {
  id: 'crawler',
  name: '爬行物',
  hp: 6,
  speed: 62,
  hw: 5,
  hh: 5,
  attack: CRAWLER_BITE,
  detectRange: 150,
  attackRange: 20,
  stopDistance: 14,
  cooldown: 30,
  sanDrain: 0.5,
  sprite: 'crawler',
};

export const ORDERLY: RtEnemyDef = {
  id: 'orderly',
  name: '护工',
  hp: 20,
  speed: 34,
  hw: 6,
  hh: 7,
  attack: ORDERLY_SLAM,
  detectRange: 130,
  attackRange: 34,
  stopDistance: 24,
  cooldown: 60,
  sanDrain: 1.2,
  sprite: 'orderly',
};

export const RT_ENEMIES: readonly RtEnemyDef[] = [CRAWLER, ORDERLY];

/**
 * 敌人定义 → 实时层的刷怪模板。
 *
 * 【为什么要有这个函数】core 不认识"爬行物"是什么，只认识
 * SpawnTemplate。手写转换的话，摆三只敌人要写一遍、测试再写一遍 ——
 * 而且已经因此漏过一个字段（sanDrain 没传，"怪靠近掉理智"
 * 在原型里根本不生效，还不报错）。
 *
 * 一处转换，两边共用。
 */
export function toSpawnTemplate(def: RtEnemyDef): SpawnTemplate {
  return {
    name: def.name,
    hp: def.hp,
    speed: def.speed,
    hw: def.hw,
    hh: def.hh,
    attack: def.attack,
    sanDrain: def.sanDrain,
    ai: {
      cooldownMax: def.cooldown,
      detectRange: def.detectRange,
      attackRange: def.attackRange,
      stopDistance: def.stopDistance,
    },
  };
}

export function findRtEnemy(id: string): RtEnemyDef | undefined {
  return RT_ENEMIES.find((e) => e.id === id);
}

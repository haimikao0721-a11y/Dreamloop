/**
 * ════════════════════════════════════════════════════════════════
 *  data/rt/actions.ts —— 实时层的帧数据
 * ════════════════════════════════════════════════════════════════
 *
 *  全部以 tick 为单位（60 tick = 1 秒）。
 *
 *  【和回合制内容分开放】—— 回合制那套还在 src/data/packs/core/ 里跑着，
 *  两边的数值体系完全不同（那边是"每回合伤害"，这边是"每帧判定"），
 *  混在一个文件里迟早会有人改错一边。
 *
 *  初值来自 docs/06-实时架构.md 第六节，待试玩调整。
 * ════════════════════════════════════════════════════════════════
 */

import type { ActionDef } from '@core/rt/types.js';

/** 一个通用的近身横挥 */
function swing(
  id: string,
  startup: number,
  active: number,
  recovery: number,
  range: number,
  damage: number,
  knockback: number,
): ActionDef {
  return {
    id,
    startup,
    active,
    recovery,
    range,
    // 90 度：身前一个扇形。360 会变成"原地转圈"，看不出打向哪
    arc: 90,
    damage,
    knockback,
    moveX: 0,
    moveY: 0,
  };
}

/* ── 记梦者：起手快、范围大、伤害低。靠"打一下就撤"活着 ── */

export const ARCHIVIST_LIGHT = swing('archivist_light', 6, 3, 9, 20, 3, 6);
export const ARCHIVIST_HEAVY = swing('archivist_heavy', 14, 5, 20, 28, 7, 14);

/* ── 值夜护士：起手慢、范围小、伤害高、收招长。每次出手都是赌博 ── */

export const NURSE_LIGHT = swing('nurse_light', 8, 4, 11, 18, 4, 5);
export const NURSE_HEAVY = swing('nurse_heavy', 18, 6, 24, 24, 9, 12);

/* ── 敌人 ── */

/** 爬行物：快、脆、起手短。逼玩家不能站桩 */
export const CRAWLER_BITE = swing('crawler_bite', 10, 4, 14, 16, 2, 4);

/** 护工：慢、厚、**起手很长**。它的存在就是为了教玩家"看抬手" */
export const ORDERLY_SLAM = swing('orderly_slam', 26, 6, 30, 30, 6, 16);

export const RT_ACTIONS = {
  ARCHIVIST_LIGHT,
  ARCHIVIST_HEAVY,
  NURSE_LIGHT,
  NURSE_HEAVY,
  CRAWLER_BITE,
  ORDERLY_SLAM,
} as const;

/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/rng.ts —— 确定性随机
 * ════════════════════════════════════════════════════════════════
 *
 *  和回合制那边同一套 mulberry32。
 *
 *  【禁止 Math.random()】—— 随机性只能来自 state.rngState。
 *  否则同一个 seed 复现不出同一局，神种分享、bug 复现、回放录像
 *  全部失效。这条比回合制那边更重要：实时循环一秒跑 60 次，
 *  任何一处漏网的 Math.random 都会让两侧迅速分岔。
 * ════════════════════════════════════════════════════════════════
 */

import type { RtState } from './types.js';

/** 推进 rngState 并返回 [0, 1)。确定性：同样的 state 必然给同样的值 */
export function nextFloat(state: RtState): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [min, max] 闭区间整数 */
export function nextInt(state: RtState, min: number, max: number): number {
  return min + Math.floor(nextFloat(state) * (max - min + 1));
}

/** 从数组里挑一个。空数组返回 undefined，不抛 */
export function pick<T>(state: RtState, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[nextInt(state, 0, items.length - 1)];
}

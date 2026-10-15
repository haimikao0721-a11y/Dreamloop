/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/light.ts —— 光源与理智恢复
 * ════════════════════════════════════════════════════════════════
 *
 *  理智【只能】靠光恢复。没有"吃药回理智"。
 *
 *  三种光源（见 docs/06 第九节）：
 *
 *    壁灯        固定，拿不走，半径大，回得慢
 *    手持蜡烛    能边走边回，回得慢，燃料烧完就没了
 *    插地蜡烛    回得快、范围大，但你得留在这儿，而且烧得更快
 *
 *  手持 vs 插地是一个真实取舍 —— 和整个游戏的主题一致：
 *  【想要什么，都得拿东西换。】
 * ════════════════════════════════════════════════════════════════
 */

import type { Body, Entity, LightSource, RtState } from './types.js';

/** 一个点是否在光源半径内。用圆形不是矩形 —— 光照看起来才自然 */
export function inLight(body: Body, light: LightSource, source: Body): boolean {
  const dx = body.x - source.x;
  const dy = body.y - source.y;
  // 把目标自身的体积算进去，否则"贴着蜡烛站"反而照不到
  const reach = light.radius + Math.max(body.hw, body.hh);
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * 玩家此刻每秒能恢复多少理智。
 *
 * 【取最大值，不是求和】—— 求和的话，往地上插一排蜡烛就能无限回理智，
 * 那"蜡烛会烧完"这个代价就形同虚设了。
 */
export function restoreRateAt(state: RtState, body: Body): number {
  let best = 0;
  for (const e of state.entities) {
    if (!e.alive) continue;
    const light = e.light;
    if (light === undefined) continue;
    if (light.fuel === 0) continue; // 烧完了
    if (!inLight(body, light, e.body)) continue;
    if (light.rate > best) best = light.rate;
  }
  return best;
}

/** 这个光源还亮着吗 */
export function isLit(entity: Entity): boolean {
  return entity.light !== undefined && entity.light.fuel !== 0;
}

/**
 * 烧掉燃料。返回这一 tick 有没有光源烧完。
 *
 * 燃料 -1 表示无限（壁灯），不烧。
 */
export function burnFuel(state: RtState): Entity[] {
  const exhausted: Entity[] = [];
  for (const e of state.entities) {
    if (!e.alive) continue;
    const light = e.light;
    if (light === undefined || light.fuel < 0) continue;
    light.fuel--;
    if (light.fuel === 0) exhausted.push(e);
  }
  void state;
  return exhausted;
}

/**
 * 把蜡烛插到地上。
 *
 * 【插地之后拿不回来】—— 这是那个取舍的代价。能拔起来的话，
 * "插地回得快"就成了纯增益，没有取舍可言。
 * 烧完之后原地留个空壳（prop），玩家能看见"这里曾经有根蜡烛"。
 *
 * 返回是否真的插下去了（手上没蜡烛就插不了）。
 */
export function plantCandle(holder: Entity): boolean {
  const light = holder.light;
  if (light === undefined || light.planted === true) return false;
  return true;
}

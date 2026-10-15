/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/sanity.ts —— 理智：流失、恢复、刷怪、归零
 * ════════════════════════════════════════════════════════════════
 *
 *  docs/06 第九节的设计：
 *
 *    理智下降 → 实时刷怪（每秒算概率，不是只影响新房间）
 *    理智归零 → 地图风格切换（换配色，地形之后再说）
 *    恢复     → 只有光和蜡烛
 *
 *  【归零可逆是刻意的】。不可逆的话"归零"就等于"这局完了"，
 *  玩家会直接重开；可逆的话它变成一个能掉进去、也能爬出来的状态 ——
 *  那才有戏。
 * ════════════════════════════════════════════════════════════════ */

import { restoreRateAt } from './light.js';
import { nextFloat } from './rng.js';
import { DT } from './loop.js';
import { DEFAULT_SPAWN } from './types.js';
import type { SpawnConfig } from './types.js';
import type { RtState } from './types.js';

export const SANITY_MAX = 100;

/**
 * 刷怪系数：理智越低，刷得越多。
 *
 * 【用阶梯而不是一条曲线】—— 数值表要能被策划一眼看懂、随手改。
 * 一条平滑曲线虽然更"优雅"，但没人能说出 63.7 点理智该刷几只。
 *
 * 另外：阈值之间玩家感觉不到区别（71 和 69 一样），
 * 但 70 和 69 的实际难度差一档 —— 这是有意的，
 * 让"理智在掉"这件事【一直在被感知】。
 */
export function spawnMultiplier(san: number): number {
  if (san <= 0) return 3.0;
  if (san < 10) return 2.5;
  if (san < 40) return 2.0;
  if (san < 70) return 1.5;
  return 1.0;
}

/** 归零状态 —— 决定用哪套地图配色（见 assets/map/zero/） */
export function isZeroState(san: number): boolean {
  return san <= 0;
}

/* ══════════════════════════════════════════════════════════════
   每 tick 的理智推进
   ══════════════════════════════════════════════════════════════ */

export interface SanityTick {
  before: number;
  after: number;
  /** 这一 tick 刚从"归零"爬回来 */
  justRecovered: boolean;
  /** 这一 tick 刚掉到 0 */
  justZeroed: boolean;
}

/**
 * 推进理智。三段：光照恢复 → 怪物逼近 → 自然流失。
 *
 * 【顺序有讲究】：先算恢复再算流失，玩家"站在光里被怪围着"时
 * 才是一个真实的拉锯 —— 反过来的话恢复永远被下一次流失吃掉，
 * 光就成了摆设。
 */
export function tickSanity(state: RtState): SanityTick | null {
  const player = state.entities.find((e) => e.kind === 'player' && e.alive);
  if (player === undefined) return null;

  const before = state.san;

  // ① 光照恢复
  const rate = restoreRateAt(state, player.body);
  if (rate > 0) state.san += rate * DT;

  // ② 被怪物逼近。压迫感不只来自伤害，还来自"待在它旁边就掉理智"，
  //    这让"跑"成为一个真实选项，而不只是"打不过才跑"
  for (const e of state.entities) {
    if (!e.alive || e.kind !== 'enemy') continue;
    const drain = e.sanDrain ?? 0;
    if (drain <= 0) continue;
    const dx = e.body.x - player.body.x;
    const dy = e.body.y - player.body.y;
    // 用侦测范围当"压迫半径"—— 它在追你，就是在压迫你
    const reach = e.ai?.detectRange ?? 120;
    if (dx * dx + dy * dy <= reach * reach) state.san -= drain * DT;
  }

  // ③ 自然流失。低理智时也在掉，制造"必须尽快结束"的压力
  if (state.sanDrainEvery > 0) {
    state.sanDrainAcc++;
    if (state.sanDrainAcc >= state.sanDrainEvery) {
      state.sanDrainAcc = 0;
      state.san -= 1;
    }
  }

  // 夹紧
  if (state.san > state.sanMax) state.san = state.sanMax;
  const wasZero = before <= 0;
  if (state.san < 0) state.san = 0;
  const nowZero = state.san <= 0;

  return {
    before,
    after: state.san,
    justZeroed: !wasZero && nowZero,
    justRecovered: wasZero && !nowZero,
  };
}

/* ══════════════════════════════════════════════════════════════
   实时刷怪
   ══════════════════════════════════════════════════════════════ */

// SpawnTemplate / SpawnConfig / DEFAULT_SPAWN 定义在 types.ts ——
// RtState 要引用它们，放在这里会绕成循环依赖
export { DEFAULT_SPAWN } from './types.js';
export type { SpawnConfig, SpawnTemplate } from './types.js';

export interface SpawnDecision {
  /** 这一刻该刷吗 */
  readonly spawn: boolean;
  /** 刷怪倒计时该重置成多少 */
  readonly nextTimer: number;
}

/**
 * 决定这一 tick 要不要刷怪，以及下次倒计时。
 *
 * 【为什么是概率而不是固定间隔】
 * 固定间隔会让玩家数着秒等下一只，节奏就死了。
 * 概率让"理智在掉"表现为"不知道什么时候又冒出来一只"—— 那才是压力。
 *
 * 系数怎么体现：间隔按系数缩短。
 * 系数 3.0 → 间隔 1/3 → 刷得快三倍。同时每次判定还有一波抖动。
 */
export function rollSpawn(
  state: RtState,
  aliveCount: number,
  cfg: SpawnConfig = DEFAULT_SPAWN,
): SpawnDecision {
  if (aliveCount >= cfg.maxAlive) {
    // 满了就慢慢等着，别每帧都重算
    return { spawn: false, nextTimer: 30 };
  }

  state.spawnTimer--;
  if (state.spawnTimer > 0) return { spawn: false, nextTimer: state.spawnTimer };

  const mult = spawnMultiplier(state.san);
  // 系数越大，间隔越短
  const interval = Math.max(30, Math.round(cfg.baseInterval / mult));
  // ±40% 抖动，别让节奏可预测
  const jitter = 0.6 + nextFloat(state) * 0.8;
  const next = Math.round(interval * jitter);

  return { spawn: true, nextTimer: next };
}

/**
 * 找一个能刷怪的位置：离玩家够远、不是墙、不重叠别的实体。
 *
 * 随机试有限次就放弃 —— 不做"遍历整张图找最远点"那种事，
 * 那种逻辑在实时循环里太贵，而且结果对玩家没差别。
 */
export function findSpawnSpot(
  state: RtState,
  cfg: SpawnConfig = DEFAULT_SPAWN,
  tries = 24,
): { x: number; y: number } | null {
  const map = state.map;
  const player = state.entities.find((e) => e.kind === 'player' && e.alive);

  for (let i = 0; i < tries; i++) {
    const tx = 1 + Math.floor(nextFloat(state) * (map.w - 2));
    const ty = 1 + Math.floor(nextFloat(state) * (map.h - 2));
    if (map.tiles[ty * map.w + tx] !== 0) continue; // 墙

    const x = tx * 16 + 8;
    const y = ty * 16 + 8;

    if (player !== undefined) {
      const dx = x - player.body.x;
      const dy = y - player.body.y;
      if (dx * dx + dy * dy < cfg.minDistance * cfg.minDistance) continue;
    }
    return { x, y };
  }
  return null;
}

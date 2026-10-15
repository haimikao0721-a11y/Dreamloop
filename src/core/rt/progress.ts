/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/progress.ts —— 楼层推进
 * ════════════════════════════════════════════════════════════════
 *
 *  这一步补上整个循环缺的那一环：
 *
 *      清空房间 → 掉叙事物件 + 楼梯开通 → 捡东西看剧情
 *        → 走楼梯下一层 → 更难 → 再清空 …
 *
 *  【楼梯在清空之前不生效】—— "打不完就走"必须不是一个选项，
 *  否则玩家会一路跑到出口，战斗设计全部作废。
 *
 *  【难度随层数涨】理智流失加快、刷怪变密、障碍变多。
 *  三条一起涨，玩家能感觉到"越来越喘不过气"。
 * ════════════════════════════════════════════════════════════════
 */

import { generateRoom, onStairs } from './dungeon.js';
import { pushLog } from './log.js';
import { nextFloat } from './rng.js';
import { roomCleared } from './story.js';
import { TILE } from './types.js';
import type { GameEvent } from '../types.js';
import type { RtState } from './types.js';

/**
 * 第 N 层的自然理智流失速率（每多少 tick 掉 1 点）。
 *
 * 第 1 层 720（12 秒 1 点）—— 慢到感觉不到，让玩家先熟悉操作。
 * 每深一层快 90 tick，最快到 180（3 秒 1 点）。
 */
export function drainForDepth(depth: number): number {
  return Math.max(180, 720 - (depth - 1) * 90);
}

/** 第 N 层的刷怪基准间隔（tick） */
export function spawnIntervalForDepth(depth: number): number {
  return Math.max(150, 480 - (depth - 1) * 50);
}

/** 这一层该刷哪些怪、几只。深度决定上限，理智再乘系数 */
export function maxAliveForDepth(depth: number): number {
  return Math.min(14, 4 + depth * 2);
}

/**
 * 玩家站在楼梯上、而且房间已经清空 —— 可以下楼了。
 *
 * 【和清空判定绑在一起】理由见文件头：能跳过战斗的话，
 * 战斗设计就白做了。
 */
export function canDescend(state: RtState): boolean {
  if (state.phase !== 'playing') return false;
  if (state.pendingStory !== undefined) return false;
  if (!roomCleared(state)) return false;

  const player = state.entities.find((e) => e.kind === 'player' && e.alive);
  if (player === undefined) return false;
  return onStairs(state.map, player.body.x, player.body.y);
}

/**
 * 下一层。
 *
 * 【整张地图换掉】—— 不是"走到隔壁房间"，是新的一层。
 * 所以：清空所有非玩家实体、换地图、玩家回入口、
 * 房间状态全部重置。
 */
export function descend(state: RtState, events: GameEvent[]): boolean {
  if (!canDescend(state)) return false;

  const player = state.entities.find((e) => e.kind === 'player');
  if (player === undefined) return false;

  state.depth++;

  // ① 新地图。用当前的 rngState —— 确定性不能在这里断掉
  const plan = generateRoom({
    cols: state.map.w,
    rows: state.map.h,
    rand: () => nextFloat(state),
    depth: state.depth,
  });
  state.map = plan.map;

  // ② 清场。只留玩家 —— 上一层的怪不该跟下来，
  //    地上的东西也不该（不然玩家可以攒一地的叙事物件）
  state.entities = state.entities.filter((e) => e.kind === 'player');

  // ③ 玩家回入口
  player.body.x = TILE * 2.5;
  player.body.y = TILE * 2.5;
  player.body.vx = 0;
  player.body.vy = 0;
  player.facing = { x: 1, y: 0 };

  // ④ 房间状态重置。不重置的话新房间会直接算"已清空"，
  //    剧情和楼梯立刻触发，玩家一进新层就懵
  state.roomStoryFired = false;
  state.noEnemyTicks = 0;
  state.spawnTimer = Math.max(60, Math.round(spawnIntervalForDepth(state.depth) / 2));

  // ⑤ 难度
  state.sanDrainEvery = drainForDepth(state.depth);
  state.spawnConfig = {
    ...state.spawnConfig,
    baseInterval: spawnIntervalForDepth(state.depth),
    maxAlive: maxAliveForDepth(state.depth),
  };

  // 和回合制那边同一句（engine.ts）。层数写进文字里，
  // 玩家才知道自己在往下走 —— 房间长得都差不多
  pushLog(state, `你向下走了一层。第 ${state.depth} 层。`, 'ambient');

  events.push({ type: 'floorChanged', depth: state.depth });
  return true;
}

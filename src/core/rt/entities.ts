/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/entities.ts —— 实体的增删查
 * ════════════════════════════════════════════════════════════════
 *
 *  铁律：销毁走"打 alive = false + 帧末统一清理"，
 *  【不在遍历中改数组】。
 *
 *  在 for 循环里 splice 是实时循环最经典的 bug：
 *  要么跳过一个元素，要么索引越界，而且不一定每次都复现。
 * ════════════════════════════════════════════════════════════════
 */

import { emptyAction } from './types.js';
import type {
  ActionDef,
  AiState,
  Body,
  Entity,
  EntityKind,
  LightSource,
  RtState,
  Vec2,
} from './types.js';

export interface SpawnOptions {
  kind: EntityKind;
  x: number;
  y: number;
  hw?: number;
  hh?: number;
  hp?: number;
  speed?: number;
  facing?: Vec2;
  /** 能出什么招 */
  attack?: ActionDef;
  /** 有 ai 的就是会被驱动着追人的 */
  ai?: AiState;
  /** 发光体（壁灯、蜡烛） */
  light?: LightSource;
  /** 待在它旁边每秒扣多少理智 */
  sanDrain?: number;
  /** 这个物品对应哪段剧情 */
  storyNode?: string;
  /** 物品定义 id */
  itemDefId?: string;
}

/** 造一个实体。id 从 state.nextUid 取 —— 不用全局计数器，否则回放会串号 */
export function spawn(state: RtState, opts: SpawnOptions): Entity {
  const body: Body = {
    x: opts.x,
    y: opts.y,
    hw: opts.hw ?? 5,
    hh: opts.hh ?? 6,
    vx: 0,
    vy: 0,
  };
  const hp = opts.hp ?? 10;
  const entity: Entity = {
    id: `e${state.nextUid}`,
    kind: opts.kind,
    body,
    facing: opts.facing ?? { x: 1, y: 0 },
    alive: true,
    hp,
    hpMax: hp,
    speed: opts.speed ?? 90,
    action: emptyAction(),
    ai: opts.ai,
    attack: opts.attack,
    light: opts.light,
    sanDrain: opts.sanDrain,
    storyNode: opts.storyNode,
    itemDefId: opts.itemDefId,
  };
  state.nextUid++;
  state.entities.push(entity);
  return entity;
}

/** 标记死亡。真正移除在 sweep() */
export function kill(entity: Entity): void {
  entity.alive = false;
}

/**
 * 清理死掉的实体。每 tick 末尾调用一次。
 *
 * 用 filter 重建数组而不是原地 splice —— 重建是 O(n) 且行为可预测，
 * 原地删除在实体多起来之后容易出现"这一帧删了、下一帧索引错位"。
 */
export function sweep(state: RtState): number {
  const before = state.entities.length;
  state.entities = state.entities.filter((e) => e.alive);
  return before - state.entities.length;
}

export function findPlayer(state: RtState): Entity | undefined {
  return state.entities.find((e) => e.kind === 'player');
}

export function findById(state: RtState, id: string): Entity | undefined {
  return state.entities.find((e) => e.id === id);
}

export function countKind(state: RtState, kind: EntityKind): number {
  let n = 0;
  for (const e of state.entities) {
    if (e.kind === kind && e.alive) n++;
  }
  return n;
}

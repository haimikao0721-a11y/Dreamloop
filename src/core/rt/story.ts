/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/story.ts —— 房间清空 → 叙事（迁移计划第 4 步）
 * ════════════════════════════════════════════════════════════════
 *
 *  把实时层接回叙事层。整条链路：
 *
 *      房间清空 → 挑一个剧情节点 → 掉叙事物件 → 玩家走过去捡
 *        → 全屏剧情（模拟冻结）→ 选项 → flag → 影响结局
 *
 *  【叙事层一行都没改】—— 靠 narrative-bridge.ts 的活视图，
 *  RtState 在叙事层眼里长得就像 GameState。
 *
 *  ── "清空"的定义 ──
 *
 *  实时刷怪会让房间【永远不清空】：刚打完一只，下一只又冒出来。
 *  所以清空 = 【连续 90 tick（1.5 秒）没有敌人】。
 *  这段时间也正好是玩家喘口气、看清地上掉了什么的窗口。
 * ════════════════════════════════════════════════════════════════
 */

import { allStories, findAct, findItem, findStory } from '../content.js';
import { evalAll } from '../conditions.js';
import { applyEffects } from '../effects.js';
import { judgeEnding } from '../endings.js';
import {
  closeStory,
  findNarrativeItem,
  getVisibleChoiceIndices,
  openStory,
} from '../narrative.js';
import { spawn } from './entities.js';
import { narrativeView } from './narrative-bridge.js';
import { findOpenCell } from './physics.js';
import { nextFloat } from './rng.js';
import { TILE } from './types.js';
import type { GameEvent, SlotType, StoryNode } from '../types.js';
import type { RtState } from './types.js';

/** 连续这么多 tick 没有敌人，才算"房间清空" */
export const CLEAR_TICKS = 90;

/* ══════════════════════════════════════════════════════════════
   清空判定
   ══════════════════════════════════════════════════════════════ */

/** 推进"已经多久没敌人了"。每 tick 调一次 */
export function updateClearCounter(state: RtState): void {
  const anyFoe = state.entities.some((e) => e.alive && e.kind === 'enemy');
  state.noEnemyTicks = anyFoe ? 0 : state.noEnemyTicks + 1;
}

export function roomCleared(state: RtState): boolean {
  return state.noEnemyTicks >= CLEAR_TICKS;
}

/* ══════════════════════════════════════════════════════════════
   挑一个剧情节点
   ══════════════════════════════════════════════════════════════ */

/**
 * 按权重挑一个【能用的】节点。
 *
 * 能用的条件：没见过、requires 满足、层数范围合适。
 *
 * 【权重用确定性随机，不用 Math.random】—— 否则同一个 seed
 * 复现不出同一局，神种分享就废了。
 */
/**
 * 这一层该出什么类型的剧情。
 *
 * 【第一版忽略了槽位】—— 只按权重平铺，结果节奏是平的：
 * 引入性内容可能出现在最后一层，高潮可能出现在第一层。
 *
 * 回合制那边是地图生成器预留槽位、叙事引擎往里填。
 * 实时层没有"地图上的槽位"这个东西（一屏一房间），
 * 所以【用层数代替槽位】—— 语义是一样的：
 *
 *     第 1 层        ENTRY    引入。玩家还不知道自己是谁
 *     中间层         MID      支线 / lore
 *     最后一层       PREBOSS  高潮 / 重大抉择
 */
export function slotForDepth(depth: number, floors: number): SlotType {
  if (depth <= 1) return 'ENTRY';
  if (depth >= floors) return 'PREBOSS';
  return 'MID';
}

/** 这一层有几层。读不出来时按 3 层兜底（第一幕的实际值） */
function actFloors(state: RtState): number {
  return findAct(state.actId)?.floors ?? 3;
}

export function pickStory(state: RtState): string | null {
  const view = narrativeView(state);
  const slot = slotForDepth(state.depth, actFloors(state));

  const candidates = allStories().filter((node) => {
    if (state.seenStories.includes(node.id)) return false;
    if (node.minDepth !== undefined && state.depth < node.minDepth) return false;
    if (node.maxDepth !== undefined && state.depth > node.maxDepth) return false;
    // slots 没写 = 任何槽位都能放。写了就必须包含当前槽位
    if (node.slots !== undefined && !node.slots.includes(slot)) return false;
    return evalAll(node.requires, view);
  });
  /*
   * 【一条内容都挑不出来时，放宽槽位限制再试一次】
   *
   * 严格按槽位挑的话，某一层可能一个节点都不剩（都被看过了、
   * 或者 requires 都不满足）。结果是那一层空着 —— 玩家什么都看不到。
   *
   * 没内容可播，比播一个"槽位不太对"的内容更糟。
   */
  if (candidates.length === 0) {
    const relaxed = allStories().filter((node) => {
      if (state.seenStories.includes(node.id)) return false;
      if (node.minDepth !== undefined && state.depth < node.minDepth) return false;
      if (node.maxDepth !== undefined && state.depth > node.maxDepth) return false;
      return evalAll(node.requires, view);
    });
    if (relaxed.length === 0) return null;
    return weightedPick(state, relaxed);
  }

  return weightedPick(state, candidates);
}

/** 按 weight 挑一个。用确定性随机 —— 否则同一个 seed 复现不出同一局 */
function weightedPick(state: RtState, nodes: readonly StoryNode[]): string | null {
  let total = 0;
  for (const c of nodes) total += c.weight ?? 1;

  let roll = nextFloat(state) * total;
  for (const c of nodes) {
    roll -= c.weight ?? 1;
    if (roll <= 0) return c.id;
  }
  // 浮点收尾：roll 恰好落到 0 附近时上面可能没返回
  return nodes[nodes.length - 1]?.id ?? null;
}

/* ══════════════════════════════════════════════════════════════
   触发
   ══════════════════════════════════════════════════════════════ */

/**
 * 房间清空后触发一次叙事。
 *
 * 两种走法（和回合制那边一致）：
 *   有对应的叙事物件 → 掉在地上，玩家【自己走过去捡】
 *   没有             → 直接弹剧情（不让内容浪费）
 *
 * 优先第一种：读剧情因此变成【主动选择】。讨厌被打断的玩家
 * 可以直接走开，剧情党一定会去捡。一个机制同时服务两类人。
 */
export function triggerRoomStory(state: RtState, events: GameEvent[]): void {
  if (state.roomStoryFired) return;
  if (state.phase !== 'playing') return;
  if (!roomCleared(state)) return;

  state.roomStoryFired = true;

  const nodeId = pickStory(state);
  if (nodeId === null) return;

  const node = findStory(nodeId);
  if (node === undefined) return;

  // 找它的叙事物件
  const itemDef = findNarrativeItem(nodeId);

  if (itemDef !== undefined) {
    // 掉在玩家附近一个空地上。太远玩家找不到，太近没有"走过去"的感觉
    const px = Math.round((state.entities.find((e) => e.kind === 'player')?.body.x ?? 0) / TILE);
    const py = Math.round((state.entities.find((e) => e.kind === 'player')?.body.y ?? 0) / TILE);
    const cell = findOpenCell(state.map, px + 2, py + 1);
    spawn(state, {
      kind: 'item',
      x: cell.x * TILE + TILE / 2,
      y: cell.y * TILE + TILE / 2,
      hw: 5,
      hh: 5,
      storyNode: nodeId,
      itemDefId: itemDef.id,
    });
    // 用回合制那套已有的事件词汇表 —— 表现层认的是它
    events.push({ type: 'drop', defId: itemDef.id, kind: 'narrative', pos: { x: cell.x, y: cell.y } });
    return;
  }

  // 没有物品就直接开
  openStory(narrativeView(state), nodeId, events);
}


/* ══════════════════════════════════════════════════════════════
   拾取
   ══════════════════════════════════════════════════════════════ */

/**
 * 玩家按下交互键时，看看脚下有没有东西可捡。
 *
 * 返回是否真的捡到了 —— 调用方据此决定要不要播反馈。
 */
export function tryPickup(state: RtState, events: GameEvent[]): boolean {
  if (state.phase !== 'playing') return false;

  const player = state.entities.find((e) => e.kind === 'player' && e.alive);
  if (player === undefined) return false;

  for (const e of state.entities) {
    if (!e.alive || e.kind !== 'item') continue;
    const dx = e.body.x - player.body.x;
    const dy = e.body.y - player.body.y;
    // 拾取范围比碰撞体宽松一点 —— 硬要求完全重叠会让玩家觉得"捡不起来"
    if (Math.hypot(dx, dy) > 14) continue;

    e.alive = false;

    if (e.itemDefId !== undefined) {
      state.inventory.push({
        uid: `i${state.nextItemUid}`,
        defId: e.itemDefId,
        kind: 'narrative',
      });
      state.nextItemUid++;
    }

    if (e.storyNode !== undefined) {
      openStory(narrativeView(state), e.storyNode, events);
    }
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════
   选项
   ══════════════════════════════════════════════════════════════ */

/**
 * 选一个选项。
 *
 * `index` 是【原始下标】（选项数组里的位置），不是可见列表里的位置 ——
 * 因为 `once` 要按原始下标记 `nodeId:idx`。
 */
export function chooseInStory(state: RtState, index: number, events: GameEvent[]): boolean {
  if (state.phase !== 'story') return false;

  const nodeId = state.pendingStory;
  if (nodeId === undefined) return false;

  // 【必须用可见下标再确认一次】—— 直接信调用方给的下标，
  // 一个越界的数字就能让玩家卡在剧情里出不去（这个坑回合制那边踩过）
  const visible = getVisibleChoiceIndices(narrativeView(state));
  if (!visible.includes(index)) return false;

  const node = findStory(nodeId);
  const choice = node?.choices[index];
  if (choice === undefined) return false;

  state.takenChoices.push(`${nodeId}:${index}`);

  applyEffects(choice.effects, narrativeView(state), events);

  // goto 会把 pendingStory 换成另一个节点（由 effect 写进去），
  // 这时【不能】关剧情 —— 玩家要接着看下一段
  if (state.pendingStory === nodeId) {
    closeStory(narrativeView(state), events);
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
   结局
   ══════════════════════════════════════════════════════════════ */

/** 走完所有该走的，判定结局。返回是否真的结束了 */
export function endRun(state: RtState, events: GameEvent[]): boolean {
  if (state.phase === 'dead') return false;
  const view = narrativeView(state);
  const ending = judgeEnding(view);
  state.ending = ending;
  state.phase = 'dead';
  events.push({ type: 'actEnded', ending });
  return true;
}

/** 这次捡到的物品是什么，给表现层用 */
export function itemDefOf(defId: string): ReturnType<typeof findItem> {
  return findItem(defId);
}

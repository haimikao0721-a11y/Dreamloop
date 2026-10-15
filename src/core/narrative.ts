/**
 * ════════════════════════════════════════════════════════════════
 *  core/narrative.ts —— 叙事引擎
 * ════════════════════════════════════════════════════════════════
 *
 *  这里是「随机的容器」和「编排的剧情」之间的缝合层。
 *
 *  工作流程：
 *
 *    1. 每生成一层，地图生成器已预留好 slots（槽位）
 *    2. fillSlots() 按槽位类型 + 当前进度，挑剧情节点填进去
 *    3. 玩家把某房间的怪清空 → 该房间的槽位触发
 *    4. 触发方式：内容库里有对应叙事物件就掉物品（推荐路径，
 *       读剧情变成玩家的主动选择）；没有就直接弹剧情，不浪费内容
 *    5. 选项 → Effect → flags（跨层持久）
 *
 *  关键设计：分支【不写在流程里，写在 flag 里】。
 *  否则 12~18 幕的分支树会指数爆炸，一个人永远做不完。
 * ════════════════════════════════════════════════════════════════
 */

import { allItems, allStories, findItem, findStory } from './content.js';
import { evalAll } from './conditions.js';
import { makeItem } from './effects.js';
import type { Rng } from './rng.js';
import type {
  GameEvent,
  GameState,
  ItemDef,
  NarrativeSlot,
  StoryChoice,
  StoryNode,
} from './types.js';

/**
 * 给【一个】槽位挑内容。
 *
 * 筛选条件叠加得越多，内容作者的负担越轻 ——
 * 他只要声明「我这段适合放在入口」，引擎负责在对的时机用上它。
 */
function pickStoryForSlot(
  slot: NarrativeSlot,
  state: GameState,
  rng: Rng,
): StoryNode | undefined {
  const candidates = allStories().filter((node) => {
    // 槽位类型限定
    if (node.slots && node.slots.length > 0 && !node.slots.includes(slot.type)) return false;
    // 层数区间
    if (node.minDepth !== undefined && state.depth < node.minDepth) return false;
    if (node.maxDepth !== undefined && state.depth > node.maxDepth) return false;
    // 出现条件（flag / san / deaths / hasItem / tag …）
    if (!evalAll(node.requires, state)) return false;
    // 本局已看过的剧情不再重复填
    if (state.seenStories.includes(node.id)) return false;
    return true;
  });

  return rng.weighted(candidates.map((s) => ({ weight: s.weight ?? 1, value: s })));
}

/**
 * 把本层所有空槽位一次性填满。
 *
 * ⚠️ 这不是主路径。真正的填槽发生在【触发的那一刻】（见 triggerSlotForRoom）。
 *    保留这个函数是给测试和调试用的：想看看"这层理论上能出什么内容"时调它。
 *
 * 为什么不在地图生成时就填好：
 *    内容的出现条件里常有 hasItem / san / flag 这类【会随时间变化】的量。
 *    生成楼层时玩家还没走到那里，条件往往尚未成立，
 *    结果就是这些内容永远填不上 —— 作者写了却没人看得见。
 */
export function fillSlots(state: GameState, rng: Rng, events: GameEvent[]): void {
  for (const slot of state.floor.slots) {
    if (slot.filled) continue;
    const picked = pickStoryForSlot(slot, state, rng);
    if (!picked) continue;
    slot.nodeId = picked.id;
    slot.filled = true;
    events.push({ type: 'slotFilled', slotId: slot.id, nodeId: picked.id });
  }
}

/**
 * 找一段剧情对应的叙事物件。
 *
 * 约定：ItemDef.kind === 'narrative' 且 ItemDef.storyNode === nodeId。
 * 同一段剧情可以被多个物品引用（比如不同角色捡到不同的东西）。
 */
export function findNarrativeItem(nodeId: string): ItemDef | undefined {
  return allItems().find((i) => i.kind === 'narrative' && i.storyNode === nodeId);
}

/**
 * 某个房间被清空时，触发它的叙事槽位。
 *
 * 这是「关卡怪物清空之后产生交互剧情的内容物品」的落点。
 *
 * 关键：内容是在【这一刻】才被选中的（惰性填槽）。
 * 这样 hasItem / san / flag 这类条件反映的是玩家当下的真实状态。
 */
export function triggerSlotForRoom(
  state: GameState,
  roomId: number,
  rng: Rng,
  events: GameEvent[],
): void {
  const slot = state.floor.slots.find((s) => s.roomId === roomId);
  if (!slot) return;

  // ── 惰性填槽 ──
  if (!slot.nodeId) {
    const picked = pickStoryForSlot(slot, state, rng);
    if (!picked) return; // 没有合适的内容 → 留空，不影响游戏
    slot.nodeId = picked.id;
    slot.filled = true;
    events.push({ type: 'slotFilled', slotId: slot.id, nodeId: picked.id });
  }

  const nodeId = slot.nodeId;
  if (state.seenStories.includes(nodeId)) return;

  // ── 路径 A（推荐）：掉一件叙事物件，玩家自己走过去捡 ──
  //    读剧情因此变成【主动选择】：讨厌被打断的肉鸽玩家可以直接走开，
  //    而剧情党一定会去捡。
  const itemDef = findNarrativeItem(nodeId);
  if (itemDef) {
    const alreadyHere = state.floor.items.some((it) => it.item.defId === itemDef.id);
    const alreadyHeld = state.player.inventory.some((it) => it.defId === itemDef.id);
    if (!alreadyHere && !alreadyHeld) {
      const inst = makeItem(state, itemDef.id);
      if (inst) {
        state.floor.items.push({ pos: slot.pos, item: inst });
        events.push({
          type: 'drop',
          defId: itemDef.id,
          kind: itemDef.kind,
          pos: slot.pos,
        });
        return;
      }
    }
  }

  // ── 路径 B（兜底）：没有对应物品就直接开剧情，不让内容浪费 ──
  openStory(state, nodeId, events);
}

/**
 * 打开全屏剧情层。
 *
 * 注意：这里只改 state.phase 和 pendingStory，【不碰 DOM】。
 * UI 收到 { type:'story' } 事件后自己决定怎么呈现（全屏、动效、震动…）。
 */
export function openStory(state: GameState, nodeId: string, events: GameEvent[]): void {
  const node = findStory(nodeId);
  if (!node) {
    // 内容错配：不崩，留个痕迹方便排查
    events.push({
      type: 'message',
      text: `（内容缺失：剧情节点 "${nodeId}" 不存在）`,
      tone: 'ambient',
    });
    return;
  }
  state.pendingStory = nodeId;
  state.phase = 'story';
  if (!state.seenStories.includes(nodeId)) state.seenStories.push(nodeId);
  events.push({ type: 'story', nodeId });
}

/**
 * 取得当前剧情节点【当前可见】的选项。
 *
 * 这就是「角色选择产生不同剧情选项」的实现：
 *   · requiresTag —— 只有拥有该 tag 的角色能看到
 *   · requires    —— 条件门控（flag / san / deaths …）
 *   · once        —— 选过一次就不再显示
 *
 * ⚠️ UI 必须用这个函数的返回值渲染选项，并用它的下标 dispatch
 *    { type:'choose', index }。UI 若自己过滤，下标会错位，
 *    玩家会选到自己没看见的那个选项。
 */
export function getVisibleChoices(state: GameState): StoryChoice[] {
  const node = getCurrentStory(state);
  if (!node) return [];
  // 复用下标过滤，保证两者【永远一致】——
  // 各写一遍过滤逻辑迟早会漂移，那会导致玩家选到看不见的选项
  return getVisibleChoiceIndices(state)
    .map((i) => node.choices[i])
    .filter((c): c is StoryChoice => c !== undefined);
}

/** 取得当前剧情节点本身（UI 要拿 text / quote 来排版） */
export function getCurrentStory(state: GameState): StoryNode | undefined {
  return state.pendingStory ? findStory(state.pendingStory) : undefined;
}

/**
 * 可见选项在【原始 choices 数组】里的下标。
 *
 * 为什么需要这个：
 *   getVisibleChoices() 会把 requiresTag 不满足的选项过滤掉，
 *   所以"第 2 个可见选项"和"第 2 个原始选项"往往不是同一个。
 *   `once` 判定必须用原始下标记录，否则会记错。
 *
 * 约定：getVisibleChoiceIndices(state)[i] 就是
 *       getVisibleChoices(state)[i] 在原始数组里的位置。
 */
export function getVisibleChoiceIndices(state: GameState): number[] {
  const nodeId = state.pendingStory;
  if (!nodeId) return [];
  const node = findStory(nodeId);
  if (!node) return [];

  const out: number[] = [];
  node.choices.forEach((c, idx) => {
    if (c.requiresTag && !state.player.tags.includes(c.requiresTag)) return;
    if (!evalAll(c.requires, state)) return;
    if (c.once && state.takenChoices.includes(`${nodeId}:${idx}`)) return;
    out.push(idx);
  });
  return out;
}

/** 关掉剧情层，回到地牢 */
export function closeStory(state: GameState, events: GameEvent[]): void {
  state.phase = 'playing';
  state.pendingStory = undefined;
  events.push({ type: 'storyClosed' });
}

export { findItem };

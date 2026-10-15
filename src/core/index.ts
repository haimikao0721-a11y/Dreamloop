/**
 * ════════════════════════════════════════════════════════════════
 *  core/index.ts —— 公共 API
 * ════════════════════════════════════════════════════════════════
 *
 *  这是 UI 层唯一允许 import 的文件。
 *
 *  ⚠️ 纪律：core 里【禁止】出现 window / document / DOM / CSS。
 *     一旦破坏这条，core 就无法在 node 里跑测试，
 *     也没法复用到将来的 TUI、桌面壳或服务端。
 * ════════════════════════════════════════════════════════════════
 */

/* ── 类型 ── */
export type {
  ActDef,
  Actor,
  AiKind,
  CompareOp,
  Condition,
  ContentPack,
  Direction,
  DropEntry,
  Effect,
  EndingDef,
  EnemyDef,
  Flags,
  Floor,
  GameEvent,
  GameState,
  InitOptions,
  Intent,
  ItemDef,
  ItemInstance,
  ItemKind,
  MessageTone,
  NarrativeSlot,
  Phase,
  Player,
  Pos,
  ReduceResult,
  RoleDef,
  Room,
  SlotType,
  StoryChoice,
  StoryNode,
  TileKind,
} from './types.js';

export { DIR_VECTORS } from './types.js';

/* ── 状态机（唯一入口）── */
export { createInitialState, reduce, legalIntents } from './engine.js';

/* ── 内容包 ── */
export {
  loadPacks,
  getPack,
  getLoadedPacks,
  findAct,
  findEnemy,
  findItem,
  findRole,
  findStory,
  allEndings,
  allEnemies,
  allItems,
  allStories,
} from './content.js';

/* ── 随机（种子分享用）── */
export { Rng, seedFromString, randomSeed } from './rng.js';

/* ── 剧情（UI 渲染选项必须用这两个）── */
export {
  getCurrentStory,
  getVisibleChoices,
  getVisibleChoiceIndices,
} from './narrative.js';

/* ── 结局（结算界面用）── */
export {
  judgeEnding,
  nearMissEndings,
  unmetConditions,
  unmetCount,
} from './endings.js';

/* ── 条件求值（给内容校验工具用）── */
export { evalCondition, evalAll } from './conditions.js';

/* ── 地图（UI 渲染地图需要这些纯查询）── */
export {
  actorAt,
  inBounds,
  isWalkable,
  roomAt,
  tileAt,
} from './map.js';

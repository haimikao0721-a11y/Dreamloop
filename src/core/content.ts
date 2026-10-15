/**
 * ════════════════════════════════════════════════════════════════
 *  core/content.ts —— 内容包注册表
 * ════════════════════════════════════════════════════════════════
 *
 *  core 里【不允许】import 任何具体内容（data/ 目录）。
 *  内容包由外部注入，core 只按 id 查。这样：
 *
 *    · 原版内容 = 一个 ContentPack
 *    · 社区 mod   = 另一个 ContentPack，同一个引擎跑
 *    · 加 100 个怪不用改一行引擎代码
 *
 *  注册表是模块级的单例。这在游戏引擎里是常见做法：
 *  内容包是不可变的全局常量，没必要在每次 reduce 时当参数传。
 *  createInitialState() 会负责切换成正确的内容包。
 * ════════════════════════════════════════════════════════════════
 */

import type {
  ActDef,
  ContentPack,
  EndingDef,
  EnemyDef,
  ItemDef,
  RoleDef,
  StoryNode,
} from './types.js';

const EMPTY_PACK: ContentPack = {
  id: '__empty__',
  name: '（空内容包）',
  version: '0.0.0',
  namespace: '__empty__',
};

let active: ContentPack = EMPTY_PACK;

/** 同时加载的多个包（原版 + 社区 mod）。查表时按顺序找，先找到的赢。 */
let loaded: ContentPack[] = [];

/**
 * 装载内容包。
 *
 * 允许多个包共存：社区扩展包可以引用原版的物品和敌人。
 * 查找顺序 = 数组顺序，靠前的优先 —— 这就是 mod 覆盖原版内容的机制。
 */
export function loadPacks(packs: readonly ContentPack[]): void {
  loaded = [...packs];
  const first = loaded[0];
  active = first ?? EMPTY_PACK;
}

export function getPack(): ContentPack {
  return active;
}

export function getLoadedPacks(): readonly ContentPack[] {
  return loaded;
}

/** 跨所有已加载的包按 id 查找 */
function findIn<T extends { id: string }>(
  pick: (p: ContentPack) => readonly T[] | undefined,
  id: string,
): T | undefined {
  for (const p of loaded) {
    const hit = pick(p)?.find((x) => x.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 带命名空间的查找。
 * 'abyss:goblin' 只在 namespace 为 abyss 的包里找；
 * 'goblin' 则在所有包里按顺序找。
 */
export function findRole(id: string): RoleDef | undefined {
  return findIn((p) => p.roles, id);
}

export function findEnemy(id: string): EnemyDef | undefined {
  return findIn((p) => p.enemies, id);
}

export function findItem(id: string): ItemDef | undefined {
  return findIn((p) => p.items, id);
}

export function findStory(id: string): StoryNode | undefined {
  return findIn((p) => p.stories, id);
}

export function findAct(id: string): ActDef | undefined {
  return findIn((p) => p.acts, id);
}

/** 全部已加载的结局表（原版 + mod） */
export function allEndings(): EndingDef[] {
  const out: EndingDef[] = [];
  for (const p of loaded) {
    for (const act of p.acts ?? []) out.push(...act.endings);
  }
  return out;
}

/** 全部已加载的物品定义 */
export function allItems(): ItemDef[] {
  const out: ItemDef[] = [];
  for (const p of loaded) {
    for (const i of p.items ?? []) out.push(i);
  }
  return out;
}

/** 全部已加载的怪物定义 */
export function allEnemies(): EnemyDef[] {
  const out: EnemyDef[] = [];
  for (const p of loaded) {
    for (const e of p.enemies ?? []) out.push(e);
  }
  return out;
}

/** 全部已加载的剧情节点 */
export function allStories(): StoryNode[] {
  const out: StoryNode[] = [];
  for (const p of loaded) {
    for (const s of p.stories ?? []) out.push(s);
  }
  return out;
}

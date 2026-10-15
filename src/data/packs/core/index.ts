/**
 * ════════════════════════════════════════════════════════════════
 *  core/index.ts —— 原版内容包
 * ════════════════════════════════════════════════════════════════
 *
 *  这个文件是 data 层唯一对外的东西。
 *  引擎只认 ContentPack 和下面这几个查找函数，
 *  不直接 import 任何一个具体数据文件 —— 换包不用改引擎。
 *
 *  查找函数是 O(n) 线性扫。内容量级的 n 是几十，
 *  不为此建索引：一个 Map 也是 hidden state，能省则省。
 * ════════════════════════════════════════════════════════════════
 */

import type { ActDef, ContentPack, EnemyDef, ItemDef, RoleDef, StoryNode } from '@core/types';
import { ROLES } from './roles';
import { ENEMIES } from './enemies';
import { ITEMS } from './items';
import { STORIES } from './stories';
import { ACT_1 } from './act1';

export const CORE_PACK: ContentPack = {
  id: 'core',
  name: '梦境循环 · 原版',
  version: '0.1.0',
  namespace: 'core',
  roles: ROLES,
  enemies: ENEMIES,
  items: ITEMS,
  stories: STORIES,
  acts: [ACT_1],
};

export function findRole(id: string): RoleDef | undefined {
  return ROLES.find((role) => role.id === id);
}

export function findEnemy(id: string): EnemyDef | undefined {
  return ENEMIES.find((enemy) => enemy.id === id);
}

export function findItem(id: string): ItemDef | undefined {
  return ITEMS.find((item) => item.id === id);
}

export function findStory(id: string): StoryNode | undefined {
  return STORIES.find((story) => story.id === id);
}

export function findAct(id: string): ActDef | undefined {
  return CORE_PACK.acts?.find((act) => act.id === id);
}

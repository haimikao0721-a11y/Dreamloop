/**
 * ════════════════════════════════════════════════════════════════
 *  data/packs/core/index.ts —— 原版内容包
 * ════════════════════════════════════════════════════════════════
 *
 *  这个文件只组装并导出 CORE_PACK。
 *  跨包查找在 core/content.ts：引擎和 UI 都走那一套，
 *  这里不再做只扫原版数组的第二套 find*。
 *
 *  引擎不直接 import 本文件。对外入口是 src/data/index.ts。
 * ════════════════════════════════════════════════════════════════
 */

import type { ContentPack } from '@core/types';
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

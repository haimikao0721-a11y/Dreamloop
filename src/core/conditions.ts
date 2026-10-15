/**
 * ════════════════════════════════════════════════════════════════
 *  core/conditions.ts —— 条件求值
 * ════════════════════════════════════════════════════════════════
 *
 *  Condition 是声明式的数据（见 types.ts）。
 *  它被三处使用：
 *    · 剧情节点 / 选项的出现条件
 *    · 结局判定
 *    · 掉落表的过滤
 *
 *  求值必须是纯函数：只看 state，不看任何外部变量。
 * ════════════════════════════════════════════════════════════════
 */

import type { CompareOp, Condition, GameState } from './types.js';

function compare(left: number, op: CompareOp, right: number): boolean {
  switch (op) {
    case '>=': return left >= right;
    case '>':  return left > right;
    case '<=': return left <= right;
    case '<':  return left < right;
    case '==': return left === right;
    case '!=': return left !== right;
  }
}

/** 求值单个条件 */
export function evalCondition(c: Condition, state: GameState): boolean {
  switch (c.kind) {
    case 'flag': {
      const v = state.flags[c.key];
      if (v === undefined) return false;
      // 不指定 value 时，只要求 flag 存在且为真
      if (c.value === undefined) return v === true || (typeof v === 'number' && v !== 0);
      return v === c.value;
    }

    case 'noFlag':
      return state.flags[c.key] === undefined;

    case 'deaths':
      return compare(state.deaths, c.op, c.value);

    case 'san':
      return compare(state.player.san, c.op, c.value);

    case 'hp':
      return compare(state.player.hp, c.op, c.value);

    case 'tag':
      return state.player.tags.includes(c.value);

    case 'hasItem':
      return state.player.inventory.some((i) => i.defId === c.defId);

    case 'depth':
      return compare(state.depth, c.op, c.value);

    case 'all':
      return c.of.every((sub) => evalCondition(sub, state));

    case 'any':
      return c.of.some((sub) => evalCondition(sub, state));

    case 'not':
      return !evalCondition(c.of, state);
  }
}

/**
 * 求值一组条件。
 * undefined 或空数组视为「无条件满足」—— 这是绝大多数内容的情况，
 * 所以这个默认值很重要，否则每个内容都要写 requires: []。
 */
export function evalAll(
  conditions: readonly Condition[] | undefined,
  state: GameState,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evalCondition(c, state));
}

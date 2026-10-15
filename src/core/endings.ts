/**
 * ════════════════════════════════════════════════════════════════
 *  core/endings.ts —— 结局判定
 * ════════════════════════════════════════════════════════════════
 *
 *  ⚠️ 核心设计：结局【不是一棵选择树，是一个条件集合】。
 *
 *  如果每个选择都真分支，12~18 幕的内容量会指数爆炸。
 *  所以：
 *    · 选择只写 flag（Effect.setFlag / addFlag）
 *    · 结局按 priority 从高到低逐个试，第一个满足的胜出
 *    · 必须有一个 requires: [] 的兜底结局（priority 最低）
 *      —— 否则玩家会走到"没有结局"，那是 bug
 *
 *  这个做法来自 Telltale / 底特律变人，是唯一能做完的方案。
 * ════════════════════════════════════════════════════════════════
 */

import { allEndings } from './content.js';
import { evalAll } from './conditions.js';
import type { Condition, EndingDef, GameState } from './types.js';

/**
 * 判定本幕结局。
 *
 * 返回的一定是一个 EndingDef —— 内容包必须提供兜底结局。
 * 万一内容包忘了写兜底（社区 mod 常见错误），这里现造一个，
 * 保证游戏永远不会卡在"没有结局"的状态。
 */
export function judgeEnding(state: GameState): EndingDef {
  const candidates = [...allEndings()].sort((a, b) => b.priority - a.priority);

  for (const e of candidates) {
    if (evalAll(e.requires, state)) return e;
  }

  // 内容包没有兜底结局时的最后防线
  return {
    id: '__fallback__',
    name: '无声的结束',
    priority: -1,
    requires: [],
    text: '你在梦里停了下来。没有发生什么，也没有留下什么。',
    victory: false,
  };
}

/**
 * 一个结局还有【几个】顶层条件没满足。
 *
 * 这是"离达成有多近"的粗略度量。不做条件树的深度展开：
 * 顶层条件大多是 all/any 的组合，数顶层就足以把
 * 「只差一个 flag」和「差着十万八千里」区分开。
 */
export function unmetCount(state: GameState, ending: EndingDef): number {
  let n = 0;
  for (const c of ending.requires) {
    if (!evalAll([c], state)) n++;
  }
  return n;
}

/** 一个结局里还没满足的顶层条件 */
export function unmetConditions(state: GameState, ending: EndingDef): Condition[] {
  return ending.requires.filter((c) => !evalAll([c], state));
}

/**
 * 列出「差一点就能达成」的结局。
 *
 * ⚠️ 只用于结算界面 —— 告诉玩家"你还差哪一步"。
 *    这是驱动重开的核心动力：肉鸽的命门是重开率，
 *    而「我差一步就拿到了」是最强的重开动机。
 *
 * 排序：先按「还差几个条件」从少到多（最接近的排最前），
 *       条件数相同时按 priority 从高到低（更重要的结局排前面）。
 */
export function nearMissEndings(state: GameState, limit = 2): EndingDef[] {
  return [...allEndings()]
    .filter((e) => e.requires.length > 0 && !evalAll(e.requires, state))
    .sort((a, b) => {
      const byCloseness = unmetCount(state, a) - unmetCount(state, b);
      return byCloseness !== 0 ? byCloseness : b.priority - a.priority;
    })
    .slice(0, limit);
}

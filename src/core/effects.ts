/**
 * ════════════════════════════════════════════════════════════════
 *  core/effects.ts —— 效果结算
 * ════════════════════════════════════════════════════════════════
 *
 *  Effect 是内容的唯一「写入口」。
 *
 *  为什么不让内容直接改数值：
 *    · 平衡性审计时，只要看 Effect 的种类就知道内容能做什么
 *    · 社区 mod 无法越权（比如没法直接把 san 设成 9999）
 *    · 每个 effect 都能产出一条事件，UI 能给出反馈
 *
 *  本文件【原地修改】传入的 state，并往 events 里追加事件。
 *  调用方（engine.reduce）负责先克隆 state。
 * ════════════════════════════════════════════════════════════════
 */

import { findItem } from './content.js';
import type { Effect, GameEvent, GameState, ItemInstance, MessageTone } from './types.js';

/** 往日志追加一行（保留最近 60 条） */
export function pushLog(state: GameState, text: string, tone: MessageTone = 'info'): void {
  state.logLine.push({ text, tone });
  if (state.logLine.length > 60) {
    state.logLine.splice(0, state.logLine.length - 60);
  }
}

/** 生成一个确定性的唯一 id */
function makeUid(state: GameState, prefix: string): string {
  state.nextUid += 1;
  return `${prefix}_${state.nextUid}`;
}

/** 按 defId 造一个物品实例；定义不存在时返回 undefined（内容错配的兜底） */
export function makeItem(state: GameState, defId: string): ItemInstance | undefined {
  const def = findItem(defId);
  if (!def) return undefined;
  return {
    uid: makeUid(state, 'itm'),
    defId: def.id,
    kind: def.kind,
  };
}

/**
 * 结算一个效果。
 *
 * 数值都做钳制，不允许出现 hp > hpMax 或者 san < 0 这种脏状态 ——
 * 否则结局判定的 `san < 20` 会以奇怪的方式命中。
 */
export function applyEffect(
  effect: Effect,
  state: GameState,
  events: GameEvent[],
): void {
  switch (effect.kind) {
    case 'setFlag': {
      state.flags[effect.key] = effect.value;
      break;
    }

    case 'addFlag': {
      const cur = state.flags[effect.key];
      const base = typeof cur === 'number' ? cur : 0;
      state.flags[effect.key] = base + effect.delta;
      break;
    }

    case 'sanity': {
      const before = state.player.san;
      const after = clamp(before + effect.delta, 0, state.player.sanMax);
      state.player.san = after;
      if (after !== before) {
        events.push({ type: 'sanity', delta: after - before, sanLeft: after });
      }
      break;
    }

    case 'heal': {
      state.player.hp = clamp(state.player.hp + effect.amount, 0, state.player.hpMax);
      break;
    }

    case 'damage': {
      const before = state.player.hp;
      const after = clamp(before - effect.amount, 0, state.player.hpMax);
      state.player.hp = after;
      if (after < before) {
        events.push({ type: 'hurt', amount: before - after, hpLeft: after });
      }
      break;
    }

    case 'buff': {
      const p = state.player;
      switch (effect.stat) {
        case 'atk':
          p.atk = Math.max(0, p.atk + effect.amount);
          break;
        case 'def':
          p.def = Math.max(0, p.def + effect.amount);
          break;
        case 'hpMax':
          // 上限变化时当前值也要跟着收，否则会出现 hp > hpMax 的脏状态
          p.hpMax = Math.max(1, p.hpMax + effect.amount);
          p.hp = Math.min(p.hp, p.hpMax);
          break;
        case 'sanMax':
          p.sanMax = Math.max(1, p.sanMax + effect.amount);
          p.san = Math.min(p.san, p.sanMax);
          break;
      }
      const label = { atk: '攻击', def: '防御', hpMax: '生命上限', sanMax: '理智上限' }[
        effect.stat
      ];
      const sign = effect.amount > 0 ? '+' : '';
      events.push({
        type: 'message',
        text: `${label} ${sign}${effect.amount}`,
        tone: effect.amount > 0 ? 'gain' : 'danger',
      });
      break;
    }

    case 'giveItem': {
      const item = makeItem(state, effect.defId);
      if (item) {
        state.player.inventory.push(item);
        const def = findItem(effect.defId);
        events.push({
          type: 'pickup',
          defId: effect.defId,
          name: def?.name ?? effect.defId,
        });
      } else {
        // 内容错配：不崩，但留个痕迹方便排查
        pushLog(state, `（内容缺失：物品 "${effect.defId}" 不存在）`, 'ambient');
      }
      break;
    }

    case 'message': {
      pushLog(state, effect.text, effect.tone ?? 'info');
      events.push({ type: 'message', text: effect.text, tone: effect.tone ?? 'info' });
      break;
    }

    case 'goto': {
      // 链式跳转：把剧情层切到下一个节点，但保持 phase='story'
      state.pendingStory = effect.nodeId;
      events.push({ type: 'story', nodeId: effect.nodeId });
      break;
    }
  }
}

/** 批量结算 */
export function applyEffects(
  effects: readonly Effect[] | undefined,
  state: GameState,
  events: GameEvent[],
): void {
  if (!effects) return;
  for (const e of effects) applyEffect(e, state, events);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

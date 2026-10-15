/**
 * ════════════════════════════════════════════════════════════════
 *  core/combat.ts —— 战斗结算
 * ════════════════════════════════════════════════════════════════
 *
 *  伤害公式刻意做得【简单且可预测】：
 *
 *      最终伤害 = max(1, atk - def + rng.int(-1, +1))
 *
 *  波动必须加在【钳制之前】。曾经写成
 *      max(1, max(1, atk-def) + 波动)，结果是攻击力远低于防御时
 *      仍能打出 2 点 —— 防御堆到 999 也挡不住杂兵的 1~2 点，
 *      防御成长就失去意义了。现在 atk 远低于 def 时稳定只掉 1 点。
 *
 *  为什么不上乘法、暴击、抗性表：
 *    · 内容是社区写的，公式越复杂，社区越难调平衡
 *    · 文字游戏的反馈靠描述而非数字，伤害曲线平缓一点更好写
 *    · 波动上限固定为 ±1，测试可以精确断言，不用做统计
 *
 *  所有随机都走 rng，所以同一 seed 的战斗过程完全可复现。
 * ════════════════════════════════════════════════════════════════
 */

import { actorAt, isWalkable, roomAt } from './map.js';
import type { Rng } from './rng.js';
import type { Actor, GameEvent, GameState, Pos } from './types.js';
import { DIR_VECTORS, type Direction } from './types.js';

/** 玩家的视野半径（曼哈顿距离）。超出这个范围的怪不会主动靠近 */
const SIGHT_RADIUS = 7;

export function rollDamage(rng: Rng, atk: number, def: number): number {
  // 先算原始差值 + 波动，最后才钳到 1 —— 顺序不能反
  return Math.max(1, atk - def + rng.int(-1, 1));
}

/**
 * 玩家攻击一个目标。
 * 返回目标是否死亡。
 */
export function playerAttack(
  state: GameState,
  target: Actor,
  rng: Rng,
  events: GameEvent[],
): boolean {
  const dmg = rollDamage(rng, state.player.atk, target.def);
  target.hp -= dmg;
  const killed = target.hp <= 0;

  events.push({
    type: 'attack',
    attacker: '你',
    target: target.name,
    damage: dmg,
    killed,
  });

  if (killed) {
    state.floor.actors = state.floor.actors.filter((a) => a.uid !== target.uid);
  }
  return killed;
}

/**
 * 怪物回合。
 *
 * 顺序：先结算所有「已相邻」的攻击，再让其余的移动一步。
 * 这样玩家能看清"谁打了我"，而不是一堆事混在一起。
 */
export function enemyTurn(state: GameState, rng: Rng, events: GameEvent[]): void {
  let acted = 0;

  for (const actor of [...state.floor.actors]) {
    if (actor.ai !== 'aggressive') continue;

    const dx = state.player.pos.x - actor.pos.x;
    const dy = state.player.pos.y - actor.pos.y;
    const manhattan = Math.abs(dx) + Math.abs(dy);

    // ── 相邻：打 ──
    if (manhattan === 1) {
      const dmg = rollDamage(rng, actor.atk, state.player.def);
      state.player.hp = Math.max(0, state.player.hp - dmg);
      events.push({ type: 'hurt', amount: dmg, hpLeft: state.player.hp });
      acted++;
      continue;
    }

    // ── 视野内：追 ──
    if (manhattan <= SIGHT_RADIUS) {
      const step = bestStepToward(state, actor.pos);
      if (step) {
        actor.pos = step;
        acted++;
      }
    }
  }

  if (acted > 0) events.push({ type: 'enemyTurn', count: acted });
}

/**
 * 朝玩家走一步。
 *
 * 先试主轴方向，走不通再试副轴 —— 这样怪会绕开拐角，
 * 而不是傻站在墙前面。两个方向都不通就原地不动。
 */
function bestStepToward(state: GameState, from: Pos): Pos | undefined {
  const dx = state.player.pos.x - from.x;
  const dy = state.player.pos.y - from.y;

  const horizontal: Direction = dx > 0 ? 'right' : 'left';
  const vertical: Direction = dy > 0 ? 'down' : 'up';

  const primary = Math.abs(dx) >= Math.abs(dy)
    ? [horizontal, vertical]
    : [vertical, horizontal];

  for (const dir of primary) {
    const v = DIR_VECTORS[dir];
    const next: Pos = { x: from.x + v.x, y: from.y + v.y };
    if (!isWalkable(state.floor, next)) continue;
    if (next.x === state.player.pos.x && next.y === state.player.pos.y) continue;
    if (actorAt(state.floor, next)) continue;
    return next;
  }
  return undefined;
}

/**
 * 检查玩家所在房间是否刚刚被清空。
 *
 * 这是叙事物品的掉落时机 —— 你说的「关卡怪物清空之后产生交互剧情的内容物品」。
 * 返回刚被清空的房间 id 列表（通常 0 或 1 个）。
 */
export function checkRoomCleared(state: GameState, events: GameEvent[]): number[] {
  const room = roomAt(state.floor, state.player.pos);
  if (!room || room.cleared) return [];

  // 房间里还有活着的怪 → 没清空
  const stillHasEnemy = state.floor.actors.some(
    (a) =>
      a.pos.x >= room.x &&
      a.pos.x < room.x + room.w &&
      a.pos.y >= room.y &&
      a.pos.y < room.y + room.h,
  );
  if (stillHasEnemy) return [];

  room.cleared = true;
  events.push({ type: 'roomCleared', roomId: room.id });
  return [room.id];
}

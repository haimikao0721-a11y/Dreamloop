/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/ai.ts —— 敌人状态机
 * ════════════════════════════════════════════════════════════════
 *
 *      idle ──看见玩家──→ chase ──进入攻击距离──→ 出招
 *        ↑                  ↑                      │
 *        └──玩家太远─────────┴──────冷却结束─────────┘
 *
 *  【两条决定生死的规则】
 *
 *  1. 出招期间【完全不动】。
 *     起手帧之所以能被"读"，前提是它停下来了。边冲边挥的怪物
 *     没有起手可言 —— 玩家看到的时候已经挨打了。
 *
 *  2. 朝向在【出招瞬间锁定】，出招期间不再改。
 *     出招中还扭头追玩家的话，攻击会变成跟踪弹，
 *     "绕到背后躲开"这个操作就不存在了。
 *
 *  这两条合起来才是完整的博弈：看见抬手 → 绕后 / 后退 → 打空 → 反击。
 * ════════════════════════════════════════════════════════════════
 */

import { beginAction, canAct } from './action.js';
import type { Entity } from './types.js';

/**
 * 推进一个敌人的 AI。只改速度相关的字段和朝向，不改位置 ——
 * 位置统一由 loop 里的碰撞代码推。
 *
 * 参数全从 enemy.ai 读，所以这个函数没有配置参数：
 * "这个敌人多近视"是它自己的属性，不是调用现场决定的。
 */
export function updateAi(enemy: Entity, player: Entity): void {
  const ai = enemy.ai;
  if (ai === undefined) return;

  const dx = player.body.x - enemy.body.x;
  const dy = player.body.y - enemy.body.y;
  const dist = Math.hypot(dx, dy) || 1;

  // ── 出招中：站住不动，朝向也不改 ──
  if (!canAct(enemy.action)) {
    enemy.body.vx = 0;
    enemy.body.vy = 0;
    return;
  }

  if (ai.cooldown > 0) ai.cooldown--;

  // 玩家死了就脱战
  if (!player.alive || dist > ai.detectRange) {
    ai.phase = 'idle';
    enemy.body.vx = 0;
    enemy.body.vy = 0;
    return;
  }

  ai.phase = 'chase';

  // ── 进入攻击距离：锁定朝向，出招 ──
  if (dist <= ai.attackRange && ai.cooldown === 0 && enemy.attack !== undefined) {
    // 朝向在这里【锁死】。之后不管玩家怎么跑，这一招都打向这个方向
    enemy.facing.x = dx;
    enemy.facing.y = dy;
    if (beginAction(enemy.action, enemy.attack)) {
      ai.cooldown = ai.cooldownMax;
      enemy.body.vx = 0;
      enemy.body.vy = 0;
      return;
    }
  }

  // ── 追击 ──
  enemy.facing.x = dx;
  enemy.facing.y = dy;

  if (dist <= ai.stopDistance) {
    // 够近了，停住等冷却。站着不动的怪物才有"抬手"可言
    enemy.body.vx = 0;
    enemy.body.vy = 0;
    return;
  }

  enemy.body.vx = (dx / dist) * enemy.speed;
  enemy.body.vy = (dy / dist) * enemy.speed;
}

/** 玩家死了之后，所有敌人回 idle —— 免得尸体还在被追 */
export function calmAll(enemies: readonly Entity[]): void {
  for (const e of enemies) {
    if (e.ai !== undefined) e.ai.phase = 'idle';
    e.body.vx = 0;
    e.body.vy = 0;
  }
}

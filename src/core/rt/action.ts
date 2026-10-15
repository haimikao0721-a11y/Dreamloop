/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/action.ts —— 帧数据推进与命中判定
 * ════════════════════════════════════════════════════════════════
 *
 *  这套东西存在的全部理由是【起手帧】和【收招帧】：
 *
 *    怪物抬手 ──→ 玩家看见并躲开 ──→ 怪物打空进入收招 ──→ 玩家反击
 *
 *  这一整条链是动作游戏的全部乐趣。只有判定帧的话，
 *  游戏就退化成"谁按得快谁赢"，帧数据也就成了摆设。
 * ════════════════════════════════════════════════════════════════
 */

import type { ActionDef, ActionState, Body, Entity, Vec2 } from './types.js';

export type ActionPhase = 'idle' | 'startup' | 'active' | 'recovery';

/** 当前处在哪一段。idle = 没在出招 */
export function actionPhase(as: ActionState): ActionPhase {
  const def = as.def;
  if (def === null) return 'idle';
  if (as.frame < def.startup) return 'startup';
  if (as.frame < def.startup + def.active) return 'active';
  if (as.frame < def.startup + def.active + def.recovery) return 'recovery';
  return 'idle';
}

/** 能不能出招。出招中不能打断自己 */
export function canAct(as: ActionState): boolean {
  return actionPhase(as) === 'idle';
}

/** 开始一个动作。正在出招时返回 false，不打断 */
export function beginAction(as: ActionState, def: ActionDef): boolean {
  if (!canAct(as)) return false;
  as.def = def;
  as.frame = 0;
  as.hasHit.clear();
  return true;
}

/**
 * 推进一帧。返回这个动作是否【刚刚结束】。
 *
 * 结束的那一帧要把 hasHit 清掉 —— 不清的话下次出招会带着上次的命中记录，
 * 同一个敌人会被"新的一招"直接跳过。
 */
export function advanceAction(as: ActionState): boolean {
  if (as.def === null) return false;
  as.frame++;
  const def = as.def;
  if (as.frame >= def.startup + def.active + def.recovery) {
    as.def = null;
    as.frame = 0;
    as.hasHit.clear();
    return true;
  }
  return false;
}

/** 总帧数。用来算"这一招要多久" */
export function totalFrames(def: ActionDef): number {
  return def.startup + def.active + def.recovery;
}

/* ══════════════════════════════════════════════════════════════
   命中判定
   ══════════════════════════════════════════════════════════════ */

/**
 * 目标是否落在攻击范围内。
 *
 * 【用扇形而不是矩形】：矩形判定在斜向会露出四个角，
 * 玩家会觉得"明明没碰到却被打了"。扇形天然对称。
 */
export function inHitbox(
  attacker: Body,
  dir: Vec2,
  def: ActionDef,
  target: Body,
): boolean {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const dist = Math.hypot(dx, dy);

  // 目标自身也有体积，所以把它的半宽算进去 ——
  // 不算的话"贴着大怪站着"反而打不到
  const reach = def.range + Math.max(target.hw, target.hh);
  if (dist > reach) return false;
  if (dist < 1e-6) return true; // 完全重叠，任何方向都算命中
  if (def.arc >= 360) return true;

  const angleToTarget = Math.atan2(dy, dx);
  const angleOfAttack = Math.atan2(dir.y, dir.x);
  let diff = Math.abs(angleToTarget - angleOfAttack);
  // 夹角要取短的那一边：350° 和 10° 只差 20°，不是 340°
  if (diff > Math.PI) diff = Math.PI * 2 - diff;

  return diff <= (def.arc / 2) * (Math.PI / 180);
}

/** 出招时朝哪个方向。朝向是【最后按的方向】，不是移动方向 */
export function attackDirection(actor: Entity): Vec2 {
  const len = Math.hypot(actor.facing.x, actor.facing.y);
  if (len < 1e-6) return { x: 1, y: 0 };
  return { x: actor.facing.x / len, y: actor.facing.y / len };
}

export interface HitResult {
  readonly target: Entity;
  readonly damage: number;
  readonly knockback: Vec2;
}

/**
 * 算出这一帧打到了谁。
 *
 * 【不改任何状态】—— 只算。应用伤害由调用方做，
 * 这样这个函数可以单独测，而且不会在遍历中改数组。
 */
export function collectHits(
  actor: Entity,
  candidates: readonly Entity[],
): HitResult[] {
  const as = actor.action;
  const def = as.def;
  if (def === null) return [];
  if (actionPhase(as) !== 'active') return [];

  const dir = attackDirection(actor);
  const out: HitResult[] = [];

  for (const target of candidates) {
    if (target === actor) continue;
    if (!target.alive) continue;
    if (target.kind === actor.kind) continue; // 同阵营不打（怪物不会误伤怪物）
    if (as.hasHit.has(target.id)) continue;
    if (!inHitbox(actor.body, dir, def, target.body)) continue;

    // 击退方向：从攻击者指向目标
    const kx = target.body.x - actor.body.x;
    const ky = target.body.y - actor.body.y;
    const klen = Math.hypot(kx, ky) || 1;

    out.push({
      target,
      damage: def.damage,
      knockback: {
        x: (kx / klen) * def.knockback,
        y: (ky / klen) * def.knockback,
      },
    });
  }

  return out;
}

/**
 * 把命中结果写进状态。
 *
 * hasHit 在这里标记 —— 分两步是为了让 collectHits 保持纯净，
 * 且能在测试里单独断言"算出来的命中有哪些"。
 */
export function applyHits(actor: Entity, hits: readonly HitResult[]): void {
  for (const hit of hits) {
    actor.action.hasHit.add(hit.target.id);
    hit.target.hp = Math.max(0, hit.target.hp - hit.damage);
    if (hit.target.hp <= 0) hit.target.alive = false;
  }
}

/**
 * 出招时的位移（冲刺攻击）。
 *
 * 只在前 startup 帧生效 —— 判定帧还在滑的话，
 * 玩家躲开了起手也会被追上，起手帧就白设计了。
 */
export function actionDash(actor: Entity): Vec2 {
  const def = actor.action.def;
  if (def === null) return { x: 0, y: 0 };
  if (def.moveX === 0 && def.moveY === 0) return { x: 0, y: 0 };
  if (actionPhase(actor.action) !== 'startup') return { x: 0, y: 0 };
  return { x: def.moveX, y: def.moveY };
}

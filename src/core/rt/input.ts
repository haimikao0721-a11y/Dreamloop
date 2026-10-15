/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/input.ts —— 输入向量的归一化
 * ════════════════════════════════════════════════════════════════
 *
 *  设备无关：虚拟轮盘 / 键盘 / 手柄 / 鼠标各自产出原始值，
 *  到这里统一成"长度 ≤ 1 的向量"。core 不知道玩家用什么设备。
 * ════════════════════════════════════════════════════════════════
 */

import type { InputState, Vec2 } from './types.js';

/**
 * 把任意输入向量裁剪成"长度 ≤ 1"。
 *
 * 【斜向不加速】—— 不归一化的话，同时按右和下会走 √2 ≈ 1.41 倍距离，
 * 玩家会一直斜着走。这是 2D 游戏最经典的坑之一。
 *
 * 但【也不能无条件归一化】：摇杆推一半应该是走一半。
 * 所以规则是"超过 1 才缩，不超过就原样"。
 */
export function clampMove(x: number, y: number): Vec2 {
  const len = Math.hypot(x, y);
  if (len <= 1 || len === 0) return { x, y };
  return { x: x / len, y: y / len };
}

/** 键盘的 8 方向 → 归一化向量。键盘没有力度，所以只有 0 或 1 */
export function keysToVector(up: boolean, down: boolean, left: boolean, right: boolean): Vec2 {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (down ? 1 : 0) - (up ? 1 : 0);
  return clampMove(x, y);
}

/**
 * 虚拟轮盘：触点相对轮盘中心的偏移 → 向量。
 *
 * 有死区 —— 手指落在轮盘中心附近时会有几像素抖动，
 * 不去掉的话角色会一直微微地飘。
 * 还有上限 —— 手指可能拖到轮盘外面很远，不裁剪就等于开了加速挂。
 */
export function wheelToVector(
  dx: number,
  dy: number,
  radius: number,
  deadZone = 0.15,
): Vec2 {
  if (radius <= 0) return { x: 0, y: 0 };
  const len = Math.hypot(dx, dy);
  const norm = len / radius;
  if (norm < deadZone) return { x: 0, y: 0 };
  const clamped = Math.min(norm, 1);
  return { x: (dx / len) * clamped, y: (dy / len) * clamped };
}

/** 造一个输入快照。省得每处调用都写全四个字段 */
export function makeInput(
  move: Vec2,
  attack = false,
  use = false,
  heavy = false,
): InputState {
  const m = clampMove(move.x, move.y);
  return { moveX: m.x, moveY: m.y, attack, heavy, use };
}

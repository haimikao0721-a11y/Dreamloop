/**
 * ════════════════════════════════════════════════════════════════
 *  core/rng.ts —— 确定性随机数
 * ════════════════════════════════════════════════════════════════
 *
 *  为什么全程禁用 Math.random()：
 *
 *   1. 同一个 seed 必须复现同一局。否则玩家报「我遇到一个 bug」，
 *      你根本没法重建现场。
 *
 *   2. 肉鸽社区很吃「神种」分享 —— "用 seed 12345 第一层必出XX"。
 *      这是免费的社区传播素材，前提是随机可复现。
 *
 *   3. 单元测试可以断言「seed=42 时第三层有 5 个怪」这种具体事实。
 *
 *  实现选 mulberry32：32 位状态、周期足够长、分布质量好、
 *  代码只有 5 行 —— 对文字游戏完全够用，而且便于移植到 Rust。
 * ════════════════════════════════════════════════════════════════
 */

export class Rng {
  private s: number;

  constructor(seed: number) {
    // 保证状态是 32 位无符号，避免 seed=0 和 seed=2^32 撞车
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** 当前状态 —— 必须写回 state.rngState，否则随机性会丢失 */
  get state(): number {
    return this.s;
  }

  /** 取一个 [0, 1) 的浮点数 */
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 取整数，闭区间 [min, max] */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 以概率 p 返回 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 等概率取一个元素；空数组返回 undefined */
  pick<T>(arr: readonly T[]): T | undefined {
    if (arr.length === 0) return undefined;
    return arr[this.int(0, arr.length - 1)];
  }

  /**
   * 取 n 个不重复的元素（Fisher-Yates 部分洗牌，不改动原数组）。
   * n 超过数组长度时返回全部（打乱顺序）。
   */
  sample<T>(arr: readonly T[], n: number): T[] {
    const copy = [...arr];
    const count = Math.min(n, copy.length);
    for (let i = 0; i < count; i++) {
      const j = this.int(i, copy.length - 1);
      const a = copy[i];
      const b = copy[j];
      // noUncheckedIndexedAccess 下需要显式判断
      if (a !== undefined && b !== undefined) {
        copy[i] = b;
        copy[j] = a;
      }
    }
    return copy.slice(0, count);
  }

  /** 原地洗牌 */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = arr[i];
      const b = arr[j];
      if (a !== undefined && b !== undefined) {
        arr[i] = b;
        arr[j] = a;
      }
    }
    return arr;
  }

  /**
   * 按权重取一个。
   * 权重必须为正；全为 0 或空数组时返回 undefined。
   */
  weighted<T>(entries: readonly { weight: number; value: T }[]): T | undefined {
    let total = 0;
    for (const e of entries) {
      if (e.weight > 0) total += e.weight;
    }
    if (total <= 0) return undefined;

    let roll = this.next() * total;
    for (const e of entries) {
      if (e.weight <= 0) continue;
      roll -= e.weight;
      if (roll <= 0) return e.value;
    }
    // 浮点误差兜底
    const last = entries[entries.length - 1];
    return last?.value;
  }
}

/**
 * 从字符串生成种子。
 * 方便玩家分享 "dreamloop?seed=我的名字" 这种可读种子。
 * 用 FNV-1a：短、分布均匀、和 Rng 的实现无关。
 */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 生成一个人类可读的随机种子（用于「随机开局」按钮） */
export function randomSeed(): number {
  // 这里可以用 Math.random：它只用来产生种子本身，
  // 一旦种子定下来，后续整局都是确定性的。
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

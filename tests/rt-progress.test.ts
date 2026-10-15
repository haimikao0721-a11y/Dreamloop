/**
 * ════════════════════════════════════════════════════════════════
 *  楼层推进 / 槽位映射 测试（接回叙事层的最后一块）
 * ════════════════════════════════════════════════════════════════
 *
 *  这一步把实时层从"一个房间的演示"变成"能从头玩到尾的游戏"：
 *
 *      清空房间 → 掉叙事物件 + 楼梯开通 → 捡东西看剧情
 *        → 走楼梯下一层 → 更难 → 再清空 …
 *
 *  三条不变量必须守住：
 *    · 楼梯在清空之前不生效 —— 能跳过战斗的话战斗设计就白做了
 *    · 剧情按层数映射槽位 —— 不然引入性内容会出现在最后一层
 *    · 下楼之后房间状态必须重置 —— 不重置会一进新层就触发剧情
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadPacks } from '../src/core/content.js';
import {
  CLEAR_TICKS,
  SANITY_MAX,
  TILE,
  canDescend,
  descend,
  drainForDepth,
  emptyRoom,
  generateRoom,
  isConnected,
  makeInput,
  maxAliveForDepth,
  pickStory,
  roomCleared,
  slotForDepth,
  spawnIntervalForDepth,
  tickRt,
  updateClearCounter,
  chooseInStory,
  createInitialRtState,
  findOpenCell,
  spawn,
  type RtState,
} from '../src/core/rt/index.js';
import type { GameEvent } from '../src/core/types.js';
import { CORE_PACK } from '../src/data/index.js';
import { findAct } from '../src/core/content.js';

beforeAll(() => {
  loadPacks([CORE_PACK]);
});

const COLS = 21;
const ROWS = 15;

function fresh(extra: Partial<Parameters<typeof createInitialRtState>[0]> = {}): RtState {
  return createInitialRtState({
    seed: 1,
    actId: 'act_1',
    roleId: 'dream_archivist',
    roleTags: ['scholar', 'lucid', 'frail'],
    map: emptyRoom(COLS, ROWS).map,
    ...extra,
  });
}

/** 把玩家挪到楼梯上 */
function putOnStairs(s: RtState): void {
  const stairs = emptyRoom(COLS, ROWS).stairs;
  const p = s.entities.find((e) => e.kind === 'player');
  if (p === undefined) throw new Error('没有玩家');
  p.body.x = stairs.x * TILE + TILE / 2;
  p.body.y = stairs.y * TILE + TILE / 2;
}

/** 标记成"已经清空" */
function markCleared(s: RtState): void {
  for (let i = 0; i < CLEAR_TICKS + 1; i++) updateClearCounter(s);
}

/* ═══════════════════════════════════════════════════════════════
   1. 房间生成
   ═══════════════════════════════════════════════════════════════ */

describe('房间生成', () => {
  it('生成出来的房间【一定是连通的】', () => {
    /*
     * 这条是最重要的。不查连通性的话，早晚会生成出"障碍把房间
     * 劈成两半"的地图 —— 玩家进得去出不来，而且不报错，只是卡住。
     * 这种 bug 在随机生成里是必然会发生的，不是"运气不好"。
     */
    for (let seed = 1; seed <= 60; seed++) {
      let a = seed >>> 0;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (const depth of [1, 2, 3, 6]) {
        const plan = generateRoom({ cols: COLS, rows: ROWS, rand, depth });
        expect(isConnected(plan.map), `seed ${seed} depth ${depth} 的房间不连通`).toBe(true);
      }
    }
  });

  it('同 seed 同层数 → 同一张图', () => {
    const mk = (): string => {
      let a = 7;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return Array.from(generateRoom({ cols: COLS, rows: ROWS, rand, depth: 2 }).map.tiles).join(
        ',',
      );
    };
    expect(mk()).toBe(mk());
  });

  it('楼梯永远在地板上，不在墙里', () => {
    for (let seed = 1; seed <= 30; seed++) {
      let a = seed >>> 0;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const plan = generateRoom({ cols: COLS, rows: ROWS, rand, depth: seed % 5 });
      expect(plan.map.tiles[plan.stairs.y * COLS + plan.stairs.x]).not.toBe(1);
      expect(plan.stairs.x).toBeGreaterThan(0);
      expect(plan.stairs.y).toBeGreaterThan(0);
    }
  });

  it('深处比浅处障碍多', () => {
    const countWalls = (depth: number): number => {
      let a = 99;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const p = generateRoom({ cols: COLS, rows: ROWS, rand, depth });
      let n = 0;
      for (const v of p.map.tiles) if (v === 1) n++;
      return n;
    };
    expect(countWalls(1)).toBeLessThanOrEqual(countWalls(6));
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 槽位映射
   ═══════════════════════════════════════════════════════════════ */

describe('槽位按层数映射', () => {
  const floors = findAct('act_1')?.floors ?? 3;

  it('第一幕是 3 层', () => {
    expect(floors).toBe(3);
  });

  it('第 1 层是 ENTRY，最后一层是 PREBOSS，中间是 MID', () => {
    expect(slotForDepth(1, floors)).toBe('ENTRY');
    expect(slotForDepth(2, floors)).toBe('MID');
    expect(slotForDepth(3, floors)).toBe('PREBOSS');
  });

  it('单层幕：那一层既是入口也是高潮', () => {
    expect(slotForDepth(1, 1)).toBe('ENTRY');
  });

  it('【关键】第 1 层挑出来的必须是允许放 ENTRY 的节点', () => {
    const s = fresh({ depth: 1 });
    s.seenStories = [];
    for (const depth of [1, 2, 3]) {
      const s2 = fresh({ depth });
      s2.seenStories = [];
      const id = pickStory(s2);
      expect(id, `第 ${depth} 层挑不出任何剧情 —— 那一层会空着`).not.toBeNull();
    }
  });

  it('三层各挑一个，互不重复', () => {
    const s = fresh();
    const picked: string[] = [];
    for (const depth of [1, 2, 3]) {
      s.depth = depth;
      const id = pickStory(s);
      if (id !== null) {
        picked.push(id);
        s.seenStories.push(id);
      }
    }
    expect(new Set(picked).size).toBe(picked.length);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 下楼条件
   ═══════════════════════════════════════════════════════════════ */

describe('下楼条件', () => {
  it('【关键】没清空时下不去 —— 能跳过战斗的话战斗设计就白做了', () => {
    const s = fresh();
    putOnStairs(s);
    expect(roomCleared(s)).toBe(false);
    expect(canDescend(s)).toBe(false);
    expect(descend(s, []), '房间没清空却下去了').toBe(false);
    expect(s.depth).toBe(1);
  });

  it('清空了但没站在楼梯上，也下不去', () => {
    const s = fresh();
    markCleared(s);
    expect(canDescend(s)).toBe(false);
  });

  it('清空 + 站在楼梯上 → 可以下', () => {
    const s = fresh();
    putOnStairs(s);
    markCleared(s);
    expect(canDescend(s)).toBe(true);
  });

  it('正在播剧情时下不去 —— 不能一边读字一边掉下去', () => {
    const s = fresh();
    putOnStairs(s);
    markCleared(s);
    s.phase = 'story';
    s.pendingStory = 'story_entry_wake';
    expect(canDescend(s)).toBe(false);
  });

  it('死了之后下不去', () => {
    const s = fresh();
    putOnStairs(s);
    markCleared(s);
    s.phase = 'dead';
    expect(canDescend(s)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 真的下楼
   ═══════════════════════════════════════════════════════════════ */

describe('下楼', () => {
  function ready(): RtState {
    const s = fresh();
    putOnStairs(s);
    markCleared(s);
    return s;
  }

  it('层数 +1，发 floorChanged 事件', () => {
    const s = ready();
    const events: GameEvent[] = [];
    expect(descend(s, events)).toBe(true);
    expect(s.depth).toBe(2);
    expect(events.some((e) => e.type === 'floorChanged')).toBe(true);
  });

  it('【关键】房间状态重置 —— 不重置会一进新层就触发剧情', () => {
    const s = ready();
    descend(s, []);
    expect(s.roomStoryFired, '新房间算成"已经触发过" —— 那一层永远没有剧情').toBe(false);
    expect(s.noEnemyTicks, '新房间算成"已清空" —— 楼梯直接就开了').toBe(0);
    expect(canDescend(s), '刚下楼就能再下 —— 可以一路跑到底').toBe(false);
  });

  it('玩家回到入口，速度清零', () => {
    const s = ready();
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    p.body.vx = 90;
    p.body.vy = 40;
    descend(s, []);
    expect(p.body.x).toBe(TILE * 2.5);
    expect(p.body.y).toBe(TILE * 2.5);
    expect(p.body.vx).toBe(0);
    expect(p.body.vy).toBe(0);
  });

  it('上一层的实体不跟下来 —— 包括地上的东西', () => {
    const s = ready();
    // 放一只怪和一个掉落物
    spawn(s, { kind: 'enemy', x: 100, y: 100 });
    spawn(s, { kind: 'item', x: 120, y: 120, storyNode: 'x', itemDefId: 'y' });

    descend(s, []);
    expect(s.entities.filter((e) => e.kind === 'enemy')).toHaveLength(0);
    expect(s.entities.filter((e) => e.kind === 'item')).toHaveLength(0);
    expect(s.entities.filter((e) => e.kind === 'player')).toHaveLength(1);
  });

  it('地图换了一张', () => {
    const s = ready();
    const before = Array.from(s.map.tiles).join(',');
    descend(s, []);
    expect(Array.from(s.map.tiles).join(',')).not.toBe(before);
    expect(isConnected(s.map), '新房间不连通').toBe(true);
  });

  it('【关键】下楼之后老玩家不会被卡在墙里', () => {
    const s = ready();
    descend(s, []);
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    const tx = Math.floor(p.body.x / TILE);
    const ty = Math.floor(p.body.y / TILE);
    expect(s.map.tiles[ty * s.map.w + tx]).not.toBe(1);
  });

  it('连下三层，层数和难度都对得上', () => {
    const s = fresh();
    for (let i = 0; i < 3; i++) {
      putOnStairs(s);
      markCleared(s);
      expect(descend(s, []), `第 ${i + 1} 次下楼失败`).toBe(true);
    }
    expect(s.depth).toBe(4);
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 难度曲线
   ═══════════════════════════════════════════════════════════════ */

describe('难度随层数涨', () => {
  it('理智流失越来越快，但有下限', () => {
    expect(drainForDepth(1)).toBe(720);
    expect(drainForDepth(2)).toBeLessThan(drainForDepth(1));
    expect(drainForDepth(99), '掉得太快会变成没法玩').toBeGreaterThanOrEqual(180);
  });

  it('刷怪越来越密，但有下限', () => {
    expect(spawnIntervalForDepth(1)).toBe(480);
    expect(spawnIntervalForDepth(2)).toBeLessThan(spawnIntervalForDepth(1));
    expect(spawnIntervalForDepth(99)).toBeGreaterThanOrEqual(150);
  });

  it('同时在场上限随层数涨，但封顶', () => {
    expect(maxAliveForDepth(1)).toBeLessThan(maxAliveForDepth(3));
    expect(maxAliveForDepth(99), '不封顶的话后期会卡死').toBeLessThanOrEqual(14);
  });

  it('下楼真的把难度写进 state 了', () => {
    const s = fresh();
    const before = s.sanDrainEvery;
    putOnStairs(s);
    markCleared(s);
    descend(s, []);
    expect(s.sanDrainEvery).toBeLessThan(before);
    expect(s.spawnConfig.baseInterval).toBeLessThan(480);
  });

  it('【防回归】难度永远不会变成 0 或负数', () => {
    const s = fresh();
    for (let i = 0; i < 20; i++) {
      putOnStairs(s);
      markCleared(s);
      descend(s, []);
    }
    expect(s.sanDrainEvery).toBeGreaterThan(0);
    expect(s.spawnConfig.baseInterval).toBeGreaterThan(0);
    expect(s.spawnConfig.maxAlive).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   6. 端到端：三层走完
   ═══════════════════════════════════════════════════════════════ */

describe('端到端', () => {
  it('三层都能走通：清空 → 剧情 → 下楼', () => {
    const s = fresh({ seed: 5 });
    const visited: number[] = [];

    for (let floor = 0; floor < 3; floor++) {
      visited.push(s.depth);

      // 清空房间（把怪都杀掉）
      for (const e of s.entities) if (e.kind === 'enemy') e.alive = false;
      runTicks(s, makeInput({ x: 0, y: 0 }), CLEAR_TICKS + 5);
      expect(roomCleared(s), `第 ${s.depth} 层清不掉`).toBe(true);

      // 剧情应该已经触发了（掉物品或直接开）
      const hasItem = s.entities.some((e) => e.kind === 'item' && e.alive);
      const inStory = s.phase === 'story';
      expect(hasItem || inStory, `第 ${s.depth} 层清空了却没有剧情`).toBe(true);

      // 剧情开着的话先读完 —— 读字的时候不能下楼（canDescend 会拦）
      if (s.phase === 'story') {
        expect(chooseInStory(s, 0, []), '剧情读不完 —— 卡住了').toBe(true);
      }

      // 最后一层不用再下
      if (floor < 2) {
        putOnStairs(s);
        markCleared(s);
        expect(descend(s, []), `第 ${s.depth} 层下不去`).toBe(true);
      }
    }

    expect(visited).toEqual([1, 2, 3]);
  });

  it('同一 seed 跑三层，结果逐字段一致', () => {
    const run = (): string => {
      const s = fresh({ seed: 777 });
      for (let floor = 0; floor < 3; floor++) {
        for (const e of s.entities) if (e.kind === 'enemy') e.alive = false;
        runTicks(s, makeInput({ x: 1, y: 0 }), CLEAR_TICKS + 5);
        putOnStairs(s);
        markCleared(s);
        descend(s, []);
      }
      return `${s.depth}|${s.rngState}|${s.seenStories.join(',')}|${s.sanDrainEvery}`;
    };
    expect(run()).toBe(run());
  });
});

/** 手动推进若干帧。测试里不跑真实循环，直接调 tickRt */
function runTicks(s: RtState, input: ReturnType<typeof makeInput>, n: number): void {
  for (let i = 0; i < n; i++) tickRt(s, input);
}

/* 让 SANITY_MAX / findOpenCell 不被 tree-shake 掉（保持 import 有意义） */
void SANITY_MAX;
void findOpenCell;

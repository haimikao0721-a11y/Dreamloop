/**
 * ════════════════════════════════════════════════════════════════
 *  实时层测试 —— 固定时间步、输入归一化、碰撞、确定性
 * ════════════════════════════════════════════════════════════════
 *
 *  这一层是实时化的地基，所以测得比别处细。
 *  尤其是【反例测试】：只证明"两次跑出同样结果"是不够的，
 *  一个什么都不做的 tick 也能通过那种测试。
 */

import { describe, expect, it } from 'vitest';

import {
  DT,
  MAX_CATCHUP_TICKS,
  TICK_RATE,
  TILE,
  TILE_WALL,
  clampMove,
  cloneRtState,
  countKind,
  createAccumulator,
  createInitialRtState,
  findPlayer,
  keysToVector,
  makeInput,
  makeTestRoom,
  moveAndCollide,
  overlapsSolid,
  runTicks,
  setTile,
  spawn,
  sweep,
  tickRt,
  wheelToVector,
  type Body,
  type RtState,
} from '../src/core/rt/index.js';

/* ═══════════════════════════════════════════════════════════════
   1. 固定时间步
   ═══════════════════════════════════════════════════════════════ */

describe('固定时间步', () => {
  it('dt 是固定的 1/60，不随调用变化', () => {
    expect(TICK_RATE).toBe(60);
    expect(DT).toBeCloseTo(1 / 60, 12);
  });

  it('喂一个 dt 就跑一次 tick', () => {
    const acc = createAccumulator();
    expect(acc.advance(DT)).toBe(1);
  });

  it('喂 2.5 个 dt 跑两次，剩下的留着', () => {
    const acc = createAccumulator();
    expect(acc.advance(DT * 2.5)).toBe(2);
    expect(acc.pending).toBeCloseTo(DT * 0.5, 9);
  });

  it('攒够 0.5 个 dt 还不够跑一次', () => {
    const acc = createAccumulator();
    expect(acc.advance(DT * 0.5)).toBe(0);
    expect(acc.advance(DT * 0.5)).toBe(1);
  });

  it('卡顿后最多补 MAX_CATCHUP_TICKS 次，不会追帧雪崩', () => {
    const acc = createAccumulator();
    // 模拟标签页被切走 10 秒
    expect(acc.advance(10)).toBe(MAX_CATCHUP_TICKS);
    // 欠账必须被丢掉，否则下一帧继续跑满
    expect(acc.pending).toBe(0);
    expect(acc.advance(DT)).toBe(1);
  });

  it('reset 清空累积', () => {
    const acc = createAccumulator();
    acc.advance(DT * 0.9);
    acc.reset();
    expect(acc.pending).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 输入归一化
   ═══════════════════════════════════════════════════════════════ */

describe('输入归一化', () => {
  it('斜向不会被归一化成加速', () => {
    const v = clampMove(1, 1);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 9);
  });

  it('但不无条件归一化 —— 摇杆推一半就是走一半', () => {
    const v = clampMove(0.5, 0);
    expect(v.x).toBe(0.5);
    expect(v.y).toBe(0);
  });

  it('零向量不炸（不能除以 0）', () => {
    expect(clampMove(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('键盘八方向都归一化', () => {
    expect(keysToVector(false, false, false, true)).toEqual({ x: 1, y: 0 });
    const diag = keysToVector(false, true, false, true);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1, 9);
    expect(diag.x).toBeGreaterThan(0);
    expect(diag.y).toBeGreaterThan(0);
  });

  it('键盘相反方向同时按 = 不走', () => {
    expect(keysToVector(true, true, false, false)).toEqual({ x: 0, y: 0 });
  });

  it('轮盘有死区 —— 手指落在中心附近不飘', () => {
    expect(wheelToVector(0, 0, 60)).toEqual({ x: 0, y: 0 });
    expect(wheelToVector(3, 3, 60)).toEqual({ x: 0, y: 0 });
  });

  it('轮盘拖到半径外会被裁剪（否则等于加速挂）', () => {
    const v = wheelToVector(500, 0, 60);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 9);
  });

  it('轮盘推一半走一半', () => {
    const v = wheelToVector(30, 0, 60);
    expect(v.x).toBeCloseTo(0.5, 6);
  });

  it('makeInput 也会归一化', () => {
    const i = makeInput({ x: 1, y: 1 });
    expect(Math.hypot(i.moveX, i.moveY)).toBeCloseTo(1, 9);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 碰撞
   ═══════════════════════════════════════════════════════════════ */

describe('碰撞', () => {
  const map = makeTestRoom(21, 15);

  function bodyAt(x: number, y: number): Body {
    return { x, y, hw: 5, hh: 6, vx: 0, vy: 0 };
  }

  it('地图内部不重叠', () => {
    expect(overlapsSolid(bodyAt(TILE * 2.5, TILE * 2.5), map)).toBe(false);
  });

  it('陷进墙里能被查出来', () => {
    expect(overlapsSolid(bodyAt(TILE * 0.5, TILE * 2.5), map)).toBe(true);
  });

  it('越界一律当墙', () => {
    const far = makeTestRoom(5, 5);
    expect(overlapsSolid(bodyAt(-100, -100), far)).toBe(true);
    expect(overlapsSolid(bodyAt(9999, 9999), far)).toBe(true);
  });

  it('右边缘【正好】落在格子边界上不算重叠', () => {
    // 中间那道墙在第 10 列（像素 160~175）。把身体右边缘【正好】顶在 160：
    //   x = 160 - hw = 155，右边缘 = 160
    // 判定时右边界要减 EPS，否则 floor(160/16) = 10 会把墙那一列算进来，
    // 结果就是"贴着墙站着被判成穿墙"。
    const b = bodyAt(TILE * 10 - 5, TILE * 4.5);
    expect(b.x + b.hw).toBe(TILE * 10);
    expect(overlapsSolid(b, map)).toBe(false);

    // 再往右一丁点就该算重叠了 —— 证明上一条不是因为判定太松才通过的
    const nudged = bodyAt(TILE * 10 - 5 + 0.5, TILE * 4.5);
    expect(overlapsSolid(nudged, map)).toBe(true);
  });

  it('往右走会被墙挡住，不会穿过去', () => {
    const b = bodyAt(TILE * 2.5, TILE * 2.5);
    const startedLeftOfWall = b.x < TILE * 10;
    expect(startedLeftOfWall).toBe(true);

    // 一直往右推，够走到墙那边几十次了
    for (let i = 0; i < 600; i++) {
      moveAndCollide(b, map, 2, 0);
    }
    expect(b.x).toBeLessThan(TILE * 10);
    expect(b.x).toBeGreaterThan(TILE * 9);
    // 撞上之后速度被清零
    expect(b.vx).toBe(0);
  });

  it('贴着墙斜着走会【滑动】，不是卡死', () => {
    // 从第 2 行出发，往下走 25 步（50px）停在墙区里。
    // 【不能走太远】—— 再往下就是门洞那一行，身体落进去就会从门口穿出去，
    // 那是正确行为，但会让这条测试测不到"贴墙滑动"。
    const b = bodyAt(TILE * 2.5, TILE * 2.5);
    for (let i = 0; i < 200; i++) moveAndCollide(b, map, 2, 0);
    const xAtWall = b.x;
    const yBefore = b.y;

    // 往右下推：X 被墙挡住，Y 应该照样往下走
    for (let i = 0; i < 25; i++) moveAndCollide(b, map, 2, 2);

    expect(b.x).toBeCloseTo(xAtWall, 6);
    expect(b.y).toBeGreaterThan(yBefore + 20);
  });

  it('卡在墙角时两轴都被挡住，但不会瞬移', () => {
    const b = bodyAt(TILE * 1.5, TILE * 1.5);
    for (let i = 0; i < 100; i++) moveAndCollide(b, map, -3, -3);
    expect(b.x).toBeGreaterThanOrEqual(TILE);
    expect(b.y).toBeGreaterThanOrEqual(TILE);
  });

  it('撞墙后位置贴住格子边缘，不悬空', () => {
    const b = bodyAt(TILE * 2.5, TILE * 2.5);
    for (let i = 0; i < 200; i++) moveAndCollide(b, map, 2, 0);
    // 墙面在 x = 10*TILE，玩家半宽 5
    expect(b.x).toBeCloseTo(TILE * 10 - b.hw, 3);
  });

  it('门洞能过去', () => {
    const midY = Math.floor(15 / 2) * TILE + TILE / 2;
    const b = bodyAt(TILE * 2.5, midY);
    for (let i = 0; i < 400; i++) moveAndCollide(b, map, 2, 0);
    // 从门洞穿过去了，到右半边
    expect(b.x).toBeGreaterThan(TILE * 11);
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 实体
   ═══════════════════════════════════════════════════════════════ */

describe('实体', () => {
  function fresh(): RtState {
    return createInitialRtState({ seed: 1 });
  }

  it('开局有一个玩家', () => {
    const s = fresh();
    expect(countKind(s, 'player')).toBe(1);
    expect(findPlayer(s)).toBeDefined();
  });

  it('id 不重复，且从 state 里发号', () => {
    const s = fresh();
    spawn(s, { kind: 'enemy', x: 50, y: 50 });
    spawn(s, { kind: 'enemy', x: 60, y: 50 });
    const ids = s.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('kill 只打标记，sweep 才真删', () => {
    const s = fresh();
    const e = spawn(s, { kind: 'enemy', x: 50, y: 50 });
    e.alive = false;
    expect(s.entities.length).toBe(2); // 还在数组里
    expect(sweep(s)).toBe(1);
    expect(s.entities.length).toBe(1);
    expect(countKind(s, 'enemy')).toBe(0);
  });

  it('遍历中打标记不会漏掉后面的实体', () => {
    const s = fresh();
    spawn(s, { kind: 'enemy', x: 50, y: 50 });
    spawn(s, { kind: 'enemy', x: 60, y: 50 });
    spawn(s, { kind: 'enemy', x: 70, y: 50 });
    // 全都打标记，再统一清 —— 这是规定的做法
    for (const e of s.entities) e.alive = false;
    expect(sweep(s)).toBe(4);
    expect(s.entities.length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. tick 与世界推进
   ═══════════════════════════════════════════════════════════════ */

describe('tick', () => {
  it('tick 计数会往前走', () => {
    const s = createInitialRtState({ seed: 1 });
    runTicks(s, makeInput({ x: 0, y: 0 }), 10);
    expect(s.tick).toBe(10);
  });

  it('有输入就会移动，没输入就不动', () => {
    const s = createInitialRtState({ seed: 1 });
    const player = findPlayer(s);
    expect(player).toBeDefined();
    const x0 = player?.body.x ?? 0;

    runTicks(s, makeInput({ x: 0, y: 0 }), 30);
    expect(player?.body.x).toBeCloseTo(x0, 6);

    runTicks(s, makeInput({ x: 1, y: 0 }), 30);
    expect(player?.body.x).toBeGreaterThan(x0);
  });

  it('速度是"像素/秒"，走一秒刚好走 speed 那么远', () => {
    const s = createInitialRtState({ seed: 1 });
    const player = findPlayer(s);
    const x0 = player?.body.x ?? 0;
    const speed = player?.speed ?? 0;
    runTicks(s, makeInput({ x: 1, y: 0 }), TICK_RATE);
    // 中途不撞墙的话，一秒走的距离 == speed
    expect((player?.body.x ?? 0) - x0).toBeCloseTo(speed, 3);
  });

  it('松手后朝向保持不变（否则站着不动攻击方向会乱跳）', () => {
    const s = createInitialRtState({ seed: 1 });
    const player = findPlayer(s);
    runTicks(s, makeInput({ x: 0, y: 1 }), 5);
    expect(player?.facing.y).toBeGreaterThan(0);
    runTicks(s, makeInput({ x: 0, y: 0 }), 5);
    expect(player?.facing.y).toBeGreaterThan(0);
  });

  it('phase 不是 playing 时世界整个冻结', () => {
    const s = createInitialRtState({ seed: 1 });
    s.phase = 'story';
    const before = cloneRtState(s);
    runTicks(s, makeInput({ x: 1, y: 0 }), 60);
    // tick 计数、位置、全都没动
    expect(s.tick).toBe(before.tick);
    expect(findPlayer(s)?.body.x).toBe(before.entities[0]?.body.x);
  });
});

/* ═══════════════════════════════════════════════════════════════
   6. 确定性 —— 这是整个架构最重要的一条
   ═══════════════════════════════════════════════════════════════ */

describe('确定性', () => {
  /** 造一串有变化的输入，别用单一方向 —— 那样测不出分歧 */
  function inputAt(i: number) {
    const phase = i % 120;
    const x = Math.sin(phase / 17) > 0 ? 1 : -1;
    const y = Math.cos(phase / 23) > 0.3 ? 1 : 0;
    return makeInput({ x, y }, i % 30 === 0);
  }

  it('同一 seed + 同一输入序列 → 逐字段完全一致', () => {
    const a = createInitialRtState({ seed: 12345 });
    const b = createInitialRtState({ seed: 12345 });

    for (let i = 0; i < 1000; i++) {
      tickRt(a, inputAt(i));
      tickRt(b, inputAt(i));
    }

    expect(a.tick).toBe(b.tick);
    expect(a.rngState).toBe(b.rngState);
    expect(a.entities.length).toBe(b.entities.length);
    for (let i = 0; i < a.entities.length; i++) {
      const ea = a.entities[i];
      const eb = b.entities[i];
      expect(ea?.id).toBe(eb?.id);
      // 浮点也要【精确】相等 —— 差一个 ulp 就说明有不确定性漏进来了
      expect(ea?.body.x).toBe(eb?.body.x);
      expect(ea?.body.y).toBe(eb?.body.y);
      expect(ea?.facing.x).toBe(eb?.facing.x);
    }
  });

  it('【反例】多跑一个 tick，状态必须不同', () => {
    // 只测"两次相同跑出相同结果"是不够的 ——
    // 一个什么都不做的 tick 也能通过上面那条测试。
    // 这一条证明 tick 真的在推进世界。
    const a = createInitialRtState({ seed: 7 });
    const b = createInitialRtState({ seed: 7 });
    for (let i = 0; i < 50; i++) {
      tickRt(a, inputAt(i));
      tickRt(b, inputAt(i));
    }
    tickRt(b, inputAt(50)); // b 多跑一次

    expect(a.tick).not.toBe(b.tick);
    expect(a.entities[0]?.body.x).not.toBe(b.entities[0]?.body.x);
  });

  it('【反例】换一个输入，状态必须不同', () => {
    const a = createInitialRtState({ seed: 7 });
    const b = createInitialRtState({ seed: 7 });
    runTicks(a, makeInput({ x: 1, y: 0 }), 60);
    runTicks(b, makeInput({ x: -1, y: 0 }), 60);
    expect(a.entities[0]?.body.x).not.toBe(b.entities[0]?.body.x);
  });

  it('cloneRtState 是深拷贝，改副本不影响原件', () => {
    const s = createInitialRtState({ seed: 3 });
    const copy = cloneRtState(s);
    const p = findPlayer(copy);
    if (p) p.body.x = 999;
    expect(findPlayer(s)?.body.x).not.toBe(999);

    // 地图也要深拷贝
    setTile(copy.map, 1, 1, TILE_WALL);
    expect(s.map.tiles[1 * s.map.w + 1]).not.toBe(TILE_WALL);
  });

  it('从同一状态分叉：拷一份跑 N 帧，和原件跑 N 帧结果相同', () => {
    const s = createInitialRtState({ seed: 99 });
    runTicks(s, makeInput({ x: 1, y: 0 }), 40);

    const fork = cloneRtState(s);
    runTicks(s, makeInput({ x: 0, y: 1 }), 40);
    runTicks(fork, makeInput({ x: 0, y: 1 }), 40);

    expect(fork.entities[0]?.body.x).toBe(s.entities[0]?.body.x);
    expect(fork.entities[0]?.body.y).toBe(s.entities[0]?.body.y);
  });
});

/* ═══════════════════════════════════════════════════════════════
   7. 不变量 —— 任何时刻都必须成立
   ═══════════════════════════════════════════════════════════════ */

describe('不变量', () => {
  it('玩家永远在地图内，且永远不和墙重叠', () => {
    const s = createInitialRtState({ seed: 5 });
    const player = findPlayer(s);
    expect(player).toBeDefined();

    // 往各个方向乱撞，每一帧都检查
    for (let i = 0; i < 2000; i++) {
      const a = (i / 37) % (Math.PI * 2);
      tickRt(s, makeInput({ x: Math.cos(a), y: Math.sin(a) }, i % 20 === 0));

      if (player === undefined) break;
      expect(overlapsSolid(player.body, s.map), `第 ${i} 帧穿进墙里了`).toBe(false);
      expect(player.body.x).toBeGreaterThan(0);
      expect(player.body.x).toBeLessThan(s.map.w * TILE);
      expect(player.body.y).toBeGreaterThan(0);
      expect(player.body.y).toBeLessThan(s.map.h * TILE);
    }
  });

  it('实体 id 始终不重复', () => {
    const s = createInitialRtState({ seed: 5 });
    for (let i = 0; i < 50; i++) {
      spawn(s, { kind: 'enemy', x: 40 + i, y: 60 });
    }
    const ids = s.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

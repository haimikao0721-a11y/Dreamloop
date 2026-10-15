/**
 * ════════════════════════════════════════════════════════════════
 *  理智 / 光 / 刷怪 测试（迁移计划第 3 步）
 * ════════════════════════════════════════════════════════════════
 *
 *  这一层测的是【压力曲线】：理智掉得多快、低理智时怪多多少、
 *  归零能不能爬回来。
 *
 *  数值本身要真人试玩才调得动，但结构性的东西必须是死的：
 *  恢复只认光、归零可逆、刷怪不刷在脸上、一堆蜡烛不能叠加回血。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPAWN,
  DT,
  SANITY_MAX,
  TICK_RATE,
  TILE,
  actionPhase,
  createInitialRtState,
  findSpawnSpot,
  isSolid,
  makeAiState,
  makeInput,
  makeLight,
  makeTestRoom,
  nextFloat,
  nextInt,
  plantCandle,
  restoreRateAt,
  runTicks,
  spawn,
  spawnMultiplier,
  tickRt,
  tickSanity,
  inLight,
  burnFuel,
  isLit,
  isZeroState,
  rollSpawn,
  type RtState,
  type SpawnTemplate,
} from '../src/core/rt/index.js';
import { CRAWLER_BITE } from '../src/data/rt/actions.js';

/* ── 造一份刷怪模板 ── */
const TEMPLATE: SpawnTemplate = {
  hp: 6,
  speed: 60,
  hw: 5,
  hh: 5,
  attack: CRAWLER_BITE,
  sanDrain: 0.5,
  ai: {
    cooldownMax: 30,
    detectRange: 150,
    attackRange: 20,
    stopDistance: 14,
  },
};

function fresh(extra: Partial<Parameters<typeof createInitialRtState>[0]> = {}): RtState {
  return createInitialRtState({
    seed: 1,
    map: makeTestRoom(21, 15),
    ...extra,
  });
}

/* ═══════════════════════════════════════════════════════════════
   1. 刷怪系数
   ═══════════════════════════════════════════════════════════════ */

describe('刷怪系数', () => {
  /*
   * 【按比例分档，不按绝对值】
   *
   * 回合制那边 sanMax 是【角色自己的 san】（记梦者 30、护士 18）。
   * 用绝对值分档的话理智永远到不了 70，全程卡最低档 ——
   * "理智越低怪越多"等于没做。
   */
  const MAX = 30;

  it('理智越低系数越高，且单调不降', () => {
    // 【不变量】san 增大时系数【不能增大】—— 理智越高刷得越少。
    // 所以按 san 升序遍历，系数必须单调不增。
    //
    // 这个方向我写反过两次。想清楚再写：
    //   san=0 → 3.0（刷最多）    san=max → 1.0（刷最少）
    // 升序遍历看到的序列是 3.0, 2.5, 2.0, 1.5, 1.0 —— 一路下降。
    let prev = Infinity;
    for (let san = 0; san <= MAX; san += 1) {
      const m = spawnMultiplier(san, MAX);
      expect(m, `理智 ${san} 的系数比更低理智时还大 —— 关系反了`).toBeLessThanOrEqual(prev);
      prev = m;
    }
    expect(spawnMultiplier(0, MAX)).toBeGreaterThan(spawnMultiplier(MAX, MAX));
  });

  it('满理智是 1.0，归零是 3.0', () => {
    expect(spawnMultiplier(MAX, MAX)).toBe(1.0);
    expect(spawnMultiplier(0, MAX)).toBe(3.0);
  });

  it('档位边界按比例走', () => {
    expect(spawnMultiplier(MAX, MAX)).toBe(1.0);
    expect(spawnMultiplier(MAX * 0.5, MAX)).toBe(1.5);
    expect(spawnMultiplier(MAX * 0.2, MAX)).toBe(2.0);
    expect(spawnMultiplier(MAX * 0.05, MAX)).toBe(2.5);
    expect(spawnMultiplier(0, MAX)).toBe(3.0);
  });

  it('【关键】同一个比例、不同的上限，档位一样', () => {
    // 这就是改成比例的意义：18 和 30 两个角色用同一套阈值
    for (const frac of [0.9, 0.5, 0.2, 0.05]) {
      expect(spawnMultiplier(frac * 30, 30)).toBe(spawnMultiplier(frac * 18, 18));
    }
  });

  it('上限为 0 时不炸，退回最松的档', () => {
    expect(spawnMultiplier(0, 0)).toBe(1.0);
  });

  it('归零判定用 <= 0，负数是防御性的', () => {
    expect(isZeroState(0)).toBe(true);
    expect(isZeroState(-1)).toBe(true);
    expect(isZeroState(1)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 光与恢复
   ═══════════════════════════════════════════════════════════════ */

describe('光', () => {
  it('半径内算照到，半径外不算', () => {
    const light = makeLight(40, 2);
    const src = { x: 0, y: 0, hw: 5, hh: 5, vx: 0, vy: 0 };
    expect(inLight({ x: 20, y: 0, hw: 5, hh: 5, vx: 0, vy: 0 }, light, src)).toBe(true);
    expect(inLight({ x: 200, y: 0, hw: 5, hh: 5, vx: 0, vy: 0 }, light, src)).toBe(false);
  });

  it('【一堆蜡烛不能叠加】—— 取最大值不是求和', () => {
    const s = fresh();
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    // 在玩家脚下插三根蜡烛，每根 +1
    for (let i = 0; i < 3; i++) {
      spawn(s, { kind: 'light', x: p.body.x, y: p.body.y, light: makeLight(60, 1, 600) });
    }
    // 求和的话会是 3。求和就等于"插一排蜡烛无限回理智"，
    // "蜡烛会烧完"这个代价就形同虚设了
    expect(restoreRateAt(s, p.body)).toBe(1);
  });

  it('烧完的蜡烛不再提供恢复', () => {
    const s = fresh();
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    const candle = spawn(s, {
      kind: 'light',
      x: p.body.x,
      y: p.body.y,
      light: makeLight(60, 3, 2),
    });
    expect(restoreRateAt(s, p.body)).toBe(3);
    burnFuel(s);
    burnFuel(s);
    expect(candle.light?.fuel).toBe(0);
    expect(isLit(candle)).toBe(false);
    expect(restoreRateAt(s, p.body), '烧完了还在回理智').toBe(0);
  });

  it('壁灯燃料 -1，永远不烧完', () => {
    const s = fresh();
    const lamp = spawn(s, { kind: 'light', x: 100, y: 100, light: makeLight(80, 2, -1) });
    for (let i = 0; i < 5000; i++) burnFuel(s);
    expect(lamp.light?.fuel).toBe(-1);
    expect(isLit(lamp)).toBe(true);
  });

  it('burnFuel 会报出刚烧完的那些', () => {
    const s = fresh();
    spawn(s, { kind: 'light', x: 40, y: 40, light: makeLight(60, 2, 3) });
    expect(burnFuel(s)).toHaveLength(0);
    expect(burnFuel(s)).toHaveLength(0);
    const out = burnFuel(s);
    expect(out, '烧完的那一 tick 没报出来').toHaveLength(1);
  });

  it('手上没蜡烛就插不了', () => {
    const s = fresh();
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    expect(plantCandle(s, p)).toBeNull();
  });

  it('插地：手上没灯了，地上多一根', () => {
    const s = fresh();
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    p.light = makeLight(4 * TILE, 1, 600);

    const candle = plantCandle(s, p);
    expect(candle, '插不下去').not.toBeNull();
    expect(p.light, '手上的灯没清掉').toBeUndefined();
    expect(candle?.light?.planted).toBe(true);
    expect(candle?.light?.rate, '插地应该回得更快').toBe(3);
  });

  it('插地的代价是【剩余燃料减半】', () => {
    const s = fresh();
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    p.light = makeLight(4 * TILE, 1, 601);
    const candle = plantCandle(s, p);
    // 601 / 2 向下取整 = 300。这就是"回得快但留不住"的那个代价
    expect(candle?.light?.fuel).toBe(300);
  });

  it('已经插地的不能再插一次', () => {
    const s = fresh();
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    p.light = makeLight(4 * TILE, 1, 600);
    expect(plantCandle(s, p)).not.toBeNull();
    expect(plantCandle(s, p)).toBeNull();
  });

  it('插在地上的蜡烛真的能回理智', () => {
    const s = fresh({ sanDrainEvery: 0, san: 10 });
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    p.light = makeLight(4 * TILE, 1, 600);
    plantCandle(s, p);
    // 站在熄了的手持蜡烛位置，但地上那根还在照
    expect(restoreRateAt(s, p.body)).toBe(3);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 理智流失与恢复
   ═══════════════════════════════════════════════════════════════ */

describe('理智', () => {
  it('没光、没怪时只按自然速率掉', () => {
    const s = fresh({ seed: 1, sanDrainEvery: 60, san: 50 });
    runTicks(s, makeInput({ x: 0, y: 0 }), 120);
    // 120 tick 掉 2 点
    expect(s.san).toBeCloseTo(48, 3);
  });

  it('sanDrainEvery = 0 就不自然流失', () => {
    const s = fresh({ seed: 1, sanDrainEvery: 0, san: 50 });
    runTicks(s, makeInput({ x: 0, y: 0 }), 300);
    expect(s.san).toBe(50);
  });

  it('站在光里会回理智，而且能回满但不会超上限', () => {
    const s = fresh({ seed: 1, sanDrainEvery: 0, san: 10 });
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    spawn(s, { kind: 'light', x: p.body.x, y: p.body.y, light: makeLight(60, 10, -1) });
    runTicks(s, makeInput({ x: 0, y: 0 }), TICK_RATE * 30);
    expect(s.san).toBe(SANITY_MAX);
    expect(s.san, '超过上限了').toBeLessThanOrEqual(s.sanMax);
  });

  it('【关键】归零可逆 —— 回到光里能爬回来', () => {
    const s = fresh({ seed: 1, sanDrainEvery: 0, san: 0 });
    expect(isZeroState(s.san)).toBe(true);

    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    spawn(s, { kind: 'light', x: p.body.x, y: p.body.y, light: makeLight(60, 5, -1) });
    runTicks(s, makeInput({ x: 0, y: 0 }), TICK_RATE * 3);

    expect(s.san, '归零之后爬不回来 —— 那就等于这局完了').toBeGreaterThan(0);
    expect(isZeroState(s.san)).toBe(false);
  });

  it('归零和复原各发一次事件，不会每帧都发', () => {
    // 【必须有下降的来源】—— sanDrainEvery=0 表示不自然流失，
    // 场上又没怪，理智根本不会动，归零事件永远等不到
    const s = fresh({ seed: 1, sanDrainEvery: 1, san: 0.02 });
    const events: string[] = [];
    for (let i = 0; i < 20; i++) {
      for (const e of tickRt(s, makeInput({ x: 0, y: 0 }))) events.push(e.type);
    }
    expect(s.san).toBe(0);
    // 理智事件只在【状态切换】时发（归零 / 复原），不是每帧都发
    expect(events.filter((e) => e === 'sanity'), '归零事件该发且只发一次').toHaveLength(1);
  });

  it('怪物靠近会额外掉理智', () => {
    const a = fresh({ seed: 1, sanDrainEvery: 0, san: 80 });
    const b = fresh({ seed: 1, sanDrainEvery: 0, san: 80 });
    const pa = a.entities[0];
    if (pa === undefined) throw new Error('没有玩家');

    // 只在 b 里放一只贴着玩家的怪
    spawn(b, {
      kind: 'enemy',
      x: pa.body.x + 20,
      y: pa.body.y,
      sanDrain: 5,
      ai: makeAiState(TEMPLATE.ai),
    });

    runTicks(a, makeInput({ x: 0, y: 0 }), 60);
    runTicks(b, makeInput({ x: 0, y: 0 }), 60);
    expect(b.san, '怪贴在旁边却不掉理智').toBeLessThan(a.san);
  });

  it('怪在侦测范围外就不掉理智', () => {
    const a = fresh({ seed: 1, sanDrainEvery: 0, san: 80 });
    const b = fresh({ seed: 1, sanDrainEvery: 0, san: 80 });
    const pa = a.entities[0];
    if (pa === undefined) throw new Error('没有玩家');
    spawn(b, {
      kind: 'enemy',
      x: pa.body.x + 900,
      y: pa.body.y,
      sanDrain: 5,
      ai: makeAiState(TEMPLATE.ai),
    });
    runTicks(a, makeInput({ x: 0, y: 0 }), 60);
    runTicks(b, makeInput({ x: 0, y: 0 }), 60);
    expect(b.san).toBeCloseTo(a.san, 6);
  });

  it('理智永远落在 [0, sanMax]', () => {
    const s = fresh({ seed: 1, sanDrainEvery: 1, san: 5 });
    runTicks(s, makeInput({ x: 0, y: 0 }), 600);
    expect(s.san).toBeGreaterThanOrEqual(0);
    expect(s.san).toBeLessThanOrEqual(s.sanMax);
  });

  it('没有玩家时 tickSanity 返回 null，不炸', () => {
    const s = fresh();
    s.entities = [];
    expect(tickSanity(s)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 刷怪位置
   ═══════════════════════════════════════════════════════════════ */

describe('刷怪位置', () => {
  it('不会刷在墙上', () => {
    const s = fresh({ seed: 7 });
    for (let i = 0; i < 200; i++) {
      const spot = findSpawnSpot(s);
      if (spot === null) continue;
      const tx = Math.floor(spot.x / TILE);
      const ty = Math.floor(spot.y / TILE);
      expect(isSolid(s.map, tx, ty), `刷到墙里了 (${tx},${ty})`).toBe(false);
    }
  });

  it('【关键】不会刷在玩家脸上', () => {
    const s = fresh({ seed: 11 });
    const p = s.entities[0];
    if (p === undefined) throw new Error('没有玩家');
    for (let i = 0; i < 200; i++) {
      const spot = findSpawnSpot(s);
      if (spot === null) continue;
      const d = Math.hypot(spot.x - p.body.x, spot.y - p.body.y);
      expect(d, '凭空出现在脸上不是难，是耍赖').toBeGreaterThanOrEqual(
        DEFAULT_SPAWN.minDistance,
      );
    }
  });
});

describe('刷怪节奏', () => {
  it('上一只都没死、场上满员时不再刷', () => {
    const s = fresh({ seed: 3 });
    const d = rollSpawn(s, DEFAULT_SPAWN.maxAlive);
    expect(d.spawn).toBe(false);
  });

  it('理智越低，平均间隔越短', () => {
    function averageInterval(san: number): number {
      let total = 0;
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const s = fresh({ seed, san, sanDrainEvery: 0 });
        s.spawnTimer = 1;
        const d = rollSpawn(s, 0);
        if (d.spawn) {
          total += d.nextTimer;
          n++;
        }
      }
      return n === 0 ? Infinity : total / n;
    }
    const high = averageInterval(100);
    const zero = averageInterval(0);
    expect(zero, '归零之后刷得反而更慢 —— 系数接反了').toBeLessThan(high);
  });

  it('端到端：跑够时间会真的刷出怪来，且只刷在合法位置', () => {
    const s = fresh({ seed: 42, san: 0, sanDrainEvery: 0 });
    s.spawnTable = [TEMPLATE];
    s.spawnTimer = 1;
    runTicks(s, makeInput({ x: 0, y: 0 }), TICK_RATE * 20);

    expect(s.spawnedTotal, '二十分钟 tick 一只都没刷').toBeGreaterThan(0);
    const foes = s.entities.filter((e) => e.kind === 'enemy');
    expect(foes.length).toBeGreaterThan(0);
    for (const f of foes) {
      const tx = Math.floor(f.body.x / TILE);
      const ty = Math.floor(f.body.y / TILE);
      expect(isSolid(s.map, tx, ty)).toBe(false);
    }
  });

  it('低理智刷得比满理智多（同样时间）', () => {
    function countAfter(san: number): number {
      const s = fresh({ seed: 99, san, sanDrainEvery: 0 });
      s.spawnTable = [TEMPLATE];
      s.spawnTimer = 1;
      runTicks(s, makeInput({ x: 0, y: 0 }), TICK_RATE * 60);
      return s.spawnedTotal;
    }
    expect(countAfter(0), '理智归零了却没刷更多').toBeGreaterThan(countAfter(100));
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 随机源是确定的
   ═══════════════════════════════════════════════════════════════ */

describe('随机源', () => {
  it('同一 seed 给同一串数', () => {
    const a = fresh({ seed: 123 });
    const b = fresh({ seed: 123 });
    for (let i = 0; i < 100; i++) {
      expect(nextFloat(a)).toBe(nextFloat(b));
    }
  });

  it('不同 seed 给不同的数', () => {
    const a = fresh({ seed: 1 });
    const b = fresh({ seed: 2 });
    expect(nextFloat(a)).not.toBe(nextFloat(b));
  });

  it('nextFloat 落在 [0, 1)', () => {
    const s = fresh({ seed: 5 });
    for (let i = 0; i < 2000; i++) {
      const v = nextFloat(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt 落在闭区间里，两端都取得到', () => {
    const s = fresh({ seed: 6 });
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = nextInt(s, 1, 3);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect(seen.size, '只有一端被取到 —— 分布不对').toBe(3);
  });

  it('【确定性】带理智和刷怪跑一遍，两次逐字段一致', () => {
    const mk = () => {
      const s = fresh({ seed: 2024, san: 60, sanDrainEvery: 90 });
      s.spawnTable = [TEMPLATE];
      s.spawnTimer = 1;
      return s;
    };
    const a = mk();
    const b = mk();
    for (let i = 0; i < 1500; i++) {
      const inp = makeInput({ x: i % 7 === 0 ? 1 : -1, y: 0 }, i % 23 === 0);
      tickRt(a, inp);
      tickRt(b, inp);
    }
    expect(a.san).toBe(b.san);
    expect(a.rngState).toBe(b.rngState);
    expect(a.spawnedTotal).toBe(b.spawnedTotal);
    expect(a.entities.length).toBe(b.entities.length);
    for (let i = 0; i < a.entities.length; i++) {
      expect(a.entities[i]?.body.x).toBe(b.entities[i]?.body.x);
      expect(a.entities[i]?.hp).toBe(b.entities[i]?.hp);
    }
  });
});

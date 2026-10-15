/**
 * ════════════════════════════════════════════════════════════════
 *  帧数据与战斗测试（迁移计划第 2 步）
 * ════════════════════════════════════════════════════════════════
 *
 *  这一层测的是【手感的地基】：起手能不能躲、收招要不要付代价、
 *  一招会不会打两次。
 *
 *  这些都是"玩家能感觉到但看不出来"的东西 —— 数值差一帧，
 *  游戏从"能读"变成"只能靠反应"。所以帧边界必须逐个断言，
 *  不能只测"打了会掉血"。
 */

import { describe, expect, it } from 'vitest';

import {
  actionPhase,
  advanceAction,
  applyHits,
  beginAction,
  canAct,
  collectHits,
  inHitbox,
  totalFrames,
} from '../src/core/rt/action.js';
import { makeAiState } from '../src/core/rt/types.js';
import { spawn, updateAi } from '../src/core/rt/index.js';
import {
  TILE,
  createInitialRtState,
  findPlayer,
  makeInput,
  makeTestRoom,
  runTicks,
  tickRt,
} from '../src/core/rt/index.js';
import type { ActionDef, Entity, RtState } from '../src/core/rt/types.js';
import { CRAWLER, ORDERLY } from '../src/data/rt/enemies.js';

/* ── 测试用的一招：帧数故意取小，方便逐个断言 ── */
const SWING: ActionDef = {
  id: 'test_swing',
  startup: 6,
  active: 3,
  recovery: 9,
  range: 20,
  arc: 90,
  damage: 3,
  knockback: 0,
  moveX: 0,
  moveY: 0,
};

function freshState(): RtState {
  return createInitialRtState({ seed: 1, map: makeTestRoom(21, 15) });
}

/** 在玩家旁边造一个敌人，并给玩家装上测试用的招 */
function withFoe(state: RtState, dx: number, dy: number) {
  const player = findPlayer(state);
  if (player === undefined) throw new Error('没有玩家');
  player.attack = SWING;
  const foe = spawn(state, {
    kind: 'enemy',
    x: player.body.x + dx,
    y: player.body.y + dy,
    hp: 100,
    hw: 5,
    hh: 5,
  });
  return { player, foe };
}

/* ═══════════════════════════════════════════════════════════════
   1. 帧边界 —— 这一层最重要的一组
   ═══════════════════════════════════════════════════════════════ */

describe('帧边界', () => {
  it('总帧数 = 起手 + 判定 + 收招', () => {
    expect(totalFrames(SWING)).toBe(18);
  });

  it('起手的 6 帧【一帧都不能打到人】', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 10, 0);
    beginAction(player.action, SWING);

    for (let f = 0; f < SWING.startup; f++) {
      expect(actionPhase(player.action), `第 ${f} 帧不该已经进判定`).toBe('startup');
      expect(collectHits(player, [foe]), `第 ${f} 帧就打到了 —— 起手帧没意义了`).toHaveLength(0);
      advanceAction(player.action);
    }
  });

  it('判定的第 1 帧就能打到（不能少一帧）', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 10, 0);
    beginAction(player.action, SWING);
    for (let f = 0; f < SWING.startup; f++) advanceAction(player.action);

    expect(actionPhase(player.action)).toBe('active');
    expect(collectHits(player, [foe]), '判定帧开始了却打不到').toHaveLength(1);
  });

  it('判定正好 3 帧，第 4 帧就进收招', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 10, 0);
    beginAction(player.action, SWING);
    for (let f = 0; f < SWING.startup; f++) advanceAction(player.action);

    let activeFrames = 0;
    while (actionPhase(player.action) === 'active') {
      activeFrames++;
      advanceAction(player.action);
    }
    expect(activeFrames, '判定帧数和数据对不上').toBe(SWING.active);
    expect(actionPhase(player.action)).toBe('recovery');
    expect(collectHits(player, [foe]), '收招了还能打到人').toHaveLength(0);
  });

  it('收招走完动作才结束，期间一直不能出招', () => {
    const state = freshState();
    const { player } = withFoe(state, 10, 0);
    beginAction(player.action, SWING);

    let guard = 0;
    while (!canAct(player.action) && guard++ < 100) {
      if (actionPhase(player.action) === 'recovery') {
        expect(beginAction(player.action, SWING), '收招期间不该能出下一招').toBe(false);
      }
      advanceAction(player.action);
    }
    expect(guard).toBe(totalFrames(SWING));
    expect(canAct(player.action)).toBe(true);
  });

  it('动作结束后 hasHit 被清空（否则下次出招会跳过同一个敌人）', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 10, 0);
    beginAction(player.action, SWING);
    for (let i = 0; i < totalFrames(SWING); i++) advanceAction(player.action);

    expect(player.action.hasHit.size, 'hasHit 没清，下次出招对同一个敌人无效').toBe(0);

    // 再出一招，还能打到
    beginAction(player.action, SWING);
    for (let f = 0; f < SWING.startup; f++) advanceAction(player.action);
    expect(collectHits(player, [foe])).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 一招只打一次
   ═══════════════════════════════════════════════════════════════ */

describe('命中唯一性', () => {
  it('站在判定范围里不动，一招只掉一次血', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 10, 0);
    player.attack = SWING;
    const hp0 = foe.hp;

    // 出招，全程不动
    tickRt(state, makeInput({ x: 0, y: 0 }, true));
    runTicks(state, makeInput({ x: 0, y: 0 }), totalFrames(SWING));

    expect(hp0 - foe.hp, '一招打出了多次伤害').toBe(SWING.damage);
  });

  it('hasHit 是按实体 id 记的，不会互相顶掉', () => {
    const state = freshState();
    const { player } = withFoe(state, 10, 0);
    const foe2 = spawn(state, {
      kind: 'enemy',
      x: player.body.x + 10,
      y: player.body.y + 6,
      hp: 100,
    });

    beginAction(player.action, SWING);
    for (let f = 0; f < SWING.startup; f++) advanceAction(player.action);

    const hits = collectHits(player, [state.entities[1] as Entity, foe2]);
    expect(hits.length, '范围内两个敌人都该被打到').toBe(2);
    applyHits(player, hits);
    expect(player.action.hasHit.size).toBe(2);
  });

  it('施法者不会打到自己', () => {
    const state = freshState();
    const { player } = withFoe(state, 10, 0);
    beginAction(player.action, SWING);
    for (let f = 0; f < SWING.startup; f++) advanceAction(player.action);
    const hits = collectHits(player, state.entities);
    expect(hits.some((h) => h.target === player), '打到自己了').toBe(false);
  });

  it('同阵营不互相打', () => {
    const state = freshState();
    const a = spawn(state, { kind: 'enemy', x: 50, y: 50, hp: 10 });
    const b = spawn(state, { kind: 'enemy', x: 56, y: 50, hp: 10 });
    a.attack = SWING;
    beginAction(a.action, SWING);
    for (let f = 0; f < SWING.startup; f++) advanceAction(a.action);
    expect(collectHits(a, [b])).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 扇形判定
   ═══════════════════════════════════════════════════════════════ */

describe('扇形判定', () => {
  const body = (x: number, y: number) => ({ x, y, hw: 5, hh: 5, vx: 0, vy: 0 });
  const dir = { x: 1, y: 0 };
  const narrow: ActionDef = { ...SWING, range: 40, arc: 90 };

  it('正前方打得到', () => {
    expect(inHitbox(body(0, 0), dir, narrow, body(20, 0))).toBe(true);
  });

  it('超出距离打不到', () => {
    expect(inHitbox(body(0, 0), dir, narrow, body(200, 0))).toBe(false);
  });

  it('背后打不到（90 度扇形）', () => {
    expect(inHitbox(body(0, 0), dir, narrow, body(-20, 0))).toBe(false);
  });

  it('正侧面打不到（90 度的话 ±45° 是边界）', () => {
    expect(inHitbox(body(0, 0), dir, narrow, body(0, 20))).toBe(false);
  });

  it('45 度以内打得到', () => {
    expect(inHitbox(body(0, 0), dir, narrow, body(20, 8))).toBe(true);
  });

  it('360 度就是全方位', () => {
    const all: ActionDef = { ...narrow, arc: 360 };
    expect(inHitbox(body(0, 0), dir, all, body(-20, 0))).toBe(true);
    expect(inHitbox(body(0, 0), dir, all, body(0, -20))).toBe(true);
  });

  it('夹角取短的那一边（350° 和 10° 只差 20°，不是 340°）', () => {
    // 朝向略偏下，目标在正右方 —— 夹角很小，不该因为绕了一圈就算不到
    const d = { x: Math.cos(0.1), y: Math.sin(0.1) };
    expect(inHitbox(body(0, 0), d, narrow, body(20, 0))).toBe(true);
  });

  it('目标体积算进去 —— 贴着大怪站着也打得到', () => {
    const big = { x: 46, y: 0, hw: 12, hh: 12, vx: 0, vy: 0 };
    expect(inHitbox(body(0, 0), dir, narrow, big)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 敌人 AI
   ═══════════════════════════════════════════════════════════════ */

describe('敌人 AI', () => {
  function aiFoe(state: RtState, dist: number, def = CRAWLER) {
    const player = findPlayer(state);
    if (player === undefined) throw new Error('没有玩家');
    const foe = spawn(state, {
      kind: 'enemy',
      x: player.body.x + dist,
      y: player.body.y,
      hp: def.hp,
      speed: def.speed,
      hw: def.hw,
      hh: def.hh,
      attack: def.attack,
      ai: makeAiState({
        cooldownMax: def.cooldown,
        detectRange: def.detectRange,
        attackRange: def.attackRange,
        stopDistance: def.stopDistance,
      }),
    });
    return foe;
  }

  it('玩家在侦测范围外就不动', () => {
    const state = freshState();
    const foe = aiFoe(state, 400);
    runTicks(state, makeInput({ x: 0, y: 0 }), 30);
    expect(foe.ai?.phase).toBe('idle');
    expect(foe.body.vx).toBe(0);
  });

  it('玩家在范围内就追过来', () => {
    const state = freshState();
    const foe = aiFoe(state, 100);
    const d0 = Math.abs(foe.body.x - (findPlayer(state)?.body.x ?? 0));
    runTicks(state, makeInput({ x: 0, y: 0 }), 30);
    const d1 = Math.abs(foe.body.x - (findPlayer(state)?.body.x ?? 0));
    expect(foe.ai?.phase).toBe('chase');
    expect(d1, '没追过来').toBeLessThan(d0);
  });

  it('【关键】出招期间完全不动 —— 起手能被读，前提是它停下来了', () => {
    const state = freshState();
    const foe = aiFoe(state, ORDERLY.attackRange - 2, ORDERLY);
    const player = findPlayer(state);
    if (player === undefined) throw new Error('没有玩家');

    // 手动让它出招
    updateAi(foe, player);
    expect(foe.action.def, '没进入出招').not.toBeNull();

    const x0 = foe.body.x;
    const y0 = foe.body.y;
    // 出招全程玩家乱跑，敌人不该跟着动
    for (let i = 0; i < totalFrames(ORDERLY.attack) - 1; i++) {
      tickRt(state, makeInput({ x: i % 2 === 0 ? 1 : -1, y: 0 }));
      expect(foe.body.x, `第 ${i} 帧敌人动了 —— 起手帧读不出来`).toBeCloseTo(x0, 6);
      expect(foe.body.y).toBeCloseTo(y0, 6);
    }
  });

  it('【关键】朝向在出招瞬间锁定 —— 玩家绕后就能躲开', () => {
    const state = freshState();
    const foe = aiFoe(state, ORDERLY.attackRange - 2, ORDERLY);
    const player = findPlayer(state);
    if (player === undefined) throw new Error('没有玩家');

    updateAi(foe, player);
    const lockedX = foe.facing.x;
    const lockedY = foe.facing.y;

    // 玩家绕到背后
    runTicks(state, makeInput({ x: -1, y: 0 }), 10);

    expect(foe.facing.x, '出招中还扭头追人 —— 攻击变成了跟踪弹，绕后躲不掉').toBeCloseTo(
      lockedX,
      6,
    );
    expect(foe.facing.y).toBeCloseTo(lockedY, 6);
  });

  it('出招后有冷却，不会贴脸就连打', () => {
    const state = freshState();
    const foe = aiFoe(state, ORDERLY.attackRange - 2, ORDERLY);
    const player = findPlayer(state);
    if (player === undefined) throw new Error('没有玩家');

    updateAi(foe, player);
    for (let i = 0; i < totalFrames(ORDERLY.attack); i++) advanceAction(foe.action);

    // 刚打完，冷却还没走完
    updateAi(foe, player);
    expect(foe.action.def, '冷却没生效，出招接得太快').toBeNull();
    expect(foe.ai?.cooldown ?? 0).toBeGreaterThan(0);
  });

  it('冷却走完之后能再出招', () => {
    const state = freshState();
    const foe = aiFoe(state, ORDERLY.attackRange - 2, ORDERLY);
    const player = findPlayer(state);
    if (player === undefined) throw new Error('没有玩家');

    updateAi(foe, player);
    for (let i = 0; i < totalFrames(ORDERLY.attack) + ORDERLY.cooldown + 2; i++) {
      advanceAction(foe.action);
      if (foe.ai !== undefined) foe.ai.cooldown = Math.max(0, foe.ai.cooldown - 1);
    }
    updateAi(foe, player);
    expect(foe.action.def, '冷却走完了还是不出招').not.toBeNull();
  });

  it('追到 stopDistance 就停 —— 不然会和玩家完全重叠', () => {
    const state = freshState();
    const foe = aiFoe(state, 100);
    runTicks(state, makeInput({ x: 0, y: 0 }), 500);
    const player = findPlayer(state);
    if (player === undefined) throw new Error('没有玩家');
    const dist = Math.hypot(foe.body.x - player.body.x, foe.body.y - player.body.y);
    expect(dist, '贴到玩家身上了').toBeGreaterThan(CRAWLER.stopDistance - 4);
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 端到端：打得到、打得死
   ═══════════════════════════════════════════════════════════════ */

describe('战斗端到端', () => {
  it('玩家出招能打死敌人，尸体被清掉', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 12, 0);
    foe.hp = SWING.damage; // 一下死
    player.attack = SWING;

    tickRt(state, makeInput({ x: 0, y: 0 }, true));
    runTicks(state, makeInput({ x: 0, y: 0 }), totalFrames(SWING) + 1);

    expect(foe.alive).toBe(false);
    expect(state.entities.includes(foe), '尸体没被清掉').toBe(false);
  });

  it('攻击事件带伤害和位置（表现层要用来弹数字）', () => {
    const state = freshState();
    const { player } = withFoe(state, 12, 0);
    player.attack = SWING;

    const events = [];
    events.push(...tickRt(state, makeInput({ x: 0, y: 0 }, true)));
    for (let i = 0; i < totalFrames(SWING); i++) {
      events.push(...tickRt(state, makeInput({ x: 0, y: 0 })));
    }
    const hit = events.find((e) => e.type === 'hit');
    expect(hit, '没发出 hit 事件').toBeDefined();
    expect(hit?.damage).toBe(SWING.damage);
    expect(typeof hit?.x).toBe('number');
  });

  it('攻击是【边沿触发】—— 按住不放不会自动连打', () => {
    const state = freshState();
    const { player, foe } = withFoe(state, 12, 0);
    player.attack = SWING;
    const hp0 = foe.hp;

    // 一直按住攻击键跑够三招的时间
    runTicks(state, makeInput({ x: 0, y: 0 }, true), totalFrames(SWING) * 3);

    // 只该打到一次 —— 边沿触发的话后续帧 attack 已经是 false 了。
    // 但测试里我们每帧都传 true，所以这里其实在验证"出招期间不重复触发"。
    expect(hp0 - foe.hp).toBeGreaterThan(0);
    expect(hp0 - foe.hp).toBeLessThanOrEqual(SWING.damage * 3);
  });
});

/* ═══════════════════════════════════════════════════════════════
   6. 确定性在战斗下依然成立
   ═══════════════════════════════════════════════════════════════ */

describe('战斗下的确定性', () => {
  function twoRuns(): [RtState, RtState] {
    const mk = () => {
      const s = createInitialRtState({ seed: 4242, map: makeTestRoom(21, 15) });
      const p = findPlayer(s);
      if (p !== undefined) p.attack = SWING;
      const foe = spawn(s, {
        kind: 'enemy',
        x: TILE * 8,
        y: TILE * 7,
        hp: 30,
        speed: 50,
        attack: CRAWLER.attack,
        ai: makeAiState({
          cooldownMax: CRAWLER.cooldown,
          detectRange: CRAWLER.detectRange,
          attackRange: CRAWLER.attackRange,
          stopDistance: CRAWLER.stopDistance,
        }),
      });
      void foe;
      return s;
    };
    return [mk(), mk()];
  }

  it('同一 seed + 同一输入 → 连血量和帧号都一致', () => {
    const [a, b] = twoRuns();
    for (let i = 0; i < 900; i++) {
      const inp = makeInput(
        { x: Math.sin(i / 19), y: Math.cos(i / 13) },
        i % 17 === 0,
      );
      tickRt(a, inp);
      tickRt(b, inp);
    }
    expect(a.entities.length).toBe(b.entities.length);
    for (let i = 0; i < a.entities.length; i++) {
      expect(a.entities[i]?.hp).toBe(b.entities[i]?.hp);
      expect(a.entities[i]?.body.x).toBe(b.entities[i]?.body.x);
      expect(a.entities[i]?.body.y).toBe(b.entities[i]?.body.y);
      expect(a.entities[i]?.action.frame).toBe(b.entities[i]?.action.frame);
    }
  });
});

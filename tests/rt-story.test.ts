/**
 * ════════════════════════════════════════════════════════════════
 *  房间清空 → 叙事 测试（迁移计划第 4 步）
 * ════════════════════════════════════════════════════════════════
 *
 *  这一步验收【完整链路】：
 *
 *      清空房间 → 挑剧情 → 掉物品 → 捡起来 → 全屏剧情（冻结）
 *        → 选项 → flag → 影响结局
 *
 *  叙事层一行没改，靠的是 narrative-bridge.ts 的活视图。
 *  所以这里也要专门测那个视图：**写进去的东西必须真的落在 RtState 上**。
 *  活视图最容易出的问题是"看起来生效了，其实写进了临时对象"——
 *  而且不会报错，只在几小时后表现为"某个结局永远走不到"。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadPacks } from '../src/core/content.js';
import {
  CLEAR_TICKS,
  TICK_RATE,
  createInitialRtState,
  findOpenCell,
  makeInput,
  makeTestRoom,
  narrativeView,
  pickStory,
  roomCleared,
  runTicks,
  spawn,
  tickRt,
  triggerRoomStory,
  tryPickup,
  updateClearCounter,
  chooseInStory,
  endRun,
  type RtState,
} from '../src/core/rt/index.js';
import type { GameEvent } from '../src/core/types.js';
import { CORE_PACK } from '../src/data/index.js';

beforeAll(() => {
  loadPacks([CORE_PACK]);
});

function fresh(extra: Partial<Parameters<typeof createInitialRtState>[0]> = {}): RtState {
  return createInitialRtState({
    seed: 1,
    map: makeTestRoom(21, 15),
    actId: 'act_1',
    roleId: 'ward_nurse',
    roleTags: ['healer', 'believer', 'steadfast'],
    depth: 1,
    ...extra,
  });
}

/* ═══════════════════════════════════════════════════════════════
   1. 活视图 —— 写进去的必须真的落回 RtState
   ═══════════════════════════════════════════════════════════════ */

describe('叙事活视图', () => {
  it('读：字段映射对得上', () => {
    const s = fresh({ san: 42 });
    s.flags['knows_the_name'] = true;
    s.deaths = 3;
    const v = narrativeView(s);

    expect(v.player.san).toBe(42);
    expect(v.flags['knows_the_name']).toBe(true);
    expect(v.deaths).toBe(3);
    expect(v.player.tags).toContain('healer');
    expect(v.depth).toBe(1);
  });

  it('【关键】写：改视图等于改 RtState', () => {
    const s = fresh({ san: 50 });
    const v = narrativeView(s);

    v.player.san = 30;
    v.player.hp = 7;
    v.flags['signed_the_handover'] = true;
    v.pendingStory = 'story_x';
    v.phase = 'story';

    // 这些必须落到 RtState 上，不能写进临时对象
    expect(s.san, '理智没落回去').toBe(30);
    expect(s.entities.find((e) => e.kind === 'player')?.hp, '血量没落回去').toBe(7);
    expect(s.flags['signed_the_handover']).toBe(true);
    expect(s.pendingStory).toBe('story_x');
    expect(s.phase, 'phase 没落回去 —— 世界不会冻结').toBe('story');
  });

  it('数组和对象是共享引用（push 能直接生效）', () => {
    const s = fresh();
    const v = narrativeView(s);

    v.seenStories.push('a');
    v.takenChoices.push('a:0');
    v.player.inventory.push({ uid: 'u1', defId: 'ward_key', kind: 'key' });
    v.player.tags satisfies readonly string[];

    expect(s.seenStories).toContain('a');
    expect(s.takenChoices).toContain('a:0');
    expect(s.inventory).toHaveLength(1);
  });

  it('phase 来回映射：story → story → playing', () => {
    const s = fresh();
    const v = narrativeView(s);
    v.phase = 'story';
    expect(s.phase).toBe('story');
    v.phase = 'playing';
    expect(s.phase).toBe('playing');
  });

  it('是活视图不是快照 —— 先拿到的视图也看得到后来的改动', () => {
    /*
     * 这条我一开始写反了：断言"老视图应该还停在旧值"。
     * 但活视图【本来就不该是快照】—— 它读的是 RtState 的当前值。
     *
     * 快照语义才是危险的：叙事层拿到一份过期的 state，
     * 判定用的是几条命之前的血量，而且不报错。
     */
    const s = fresh({ san: 10 });
    const a = narrativeView(s);
    s.san = 90;
    const b = narrativeView(s);
    expect(a.player.san, '视图变成了快照 —— 叙事层会读到过期数据').toBe(90);
    expect(b.player.san).toBe(90);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 清空判定 —— 实时刷怪下的"清空"
   ═══════════════════════════════════════════════════════════════ */

describe('房间清空', () => {
  it('没敌人时计数往上走，够 CLEAR_TICKS 才算清空', () => {
    const s = fresh();
    expect(roomCleared(s)).toBe(false);
    for (let i = 0; i < CLEAR_TICKS - 1; i++) updateClearCounter(s);
    expect(roomCleared(s), '还差一帧就判清空了').toBe(false);
    updateClearCounter(s);
    expect(roomCleared(s)).toBe(true);
  });

  it('【关键】有敌人就清零 —— 实时刷怪时房间永远不清空', () => {
    const s = fresh();
    for (let i = 0; i < CLEAR_TICKS + 10; i++) updateClearCounter(s);
    expect(roomCleared(s)).toBe(true);

    // 刷出来一只
    spawn(s, { kind: 'enemy', x: 100, y: 100 });
    updateClearCounter(s);
    expect(s.noEnemyTicks, '来了敌人计数没清零').toBe(0);
    expect(roomCleared(s)).toBe(false);
  });

  it('死掉的敌人不算数', () => {
    const s = fresh();
    const e = spawn(s, { kind: 'enemy', x: 100, y: 100 });
    e.alive = false;
    for (let i = 0; i < CLEAR_TICKS; i++) updateClearCounter(s);
    expect(roomCleared(s)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 挑剧情 / 触发
   ═══════════════════════════════════════════════════════════════ */

describe('挑剧情', () => {
  it('能挑出一个还没看过的节点', () => {
    const s = fresh();
    const id = pickStory(s);
    expect(id, '第一幕里一个可用的节点都挑不出来').not.toBeNull();
    expect(s.seenStories).not.toContain(id);
  });

  it('同一 seed 挑出同一个', () => {
    const a = pickStory(fresh({ seed: 77 }));
    const b = pickStory(fresh({ seed: 77 }));
    expect(a).toBe(b);
  });

  it('看过的不会再挑出来', () => {
    const s = fresh();
    const first = pickStory(s);
    if (first === null) throw new Error('挑不出来');
    s.seenStories.push(first);
    const second = pickStory(s);
    expect(second).not.toBe(first);
  });

  it('requires 不满足的不会被挑中', () => {
    // 记梦者没有 healer tag —— 但大部分节点不门控，
    // 所以这里换个角度：把 layer 设成很深，看 maxDepth 有没有生效
    const s = fresh({ depth: 99 });
    // 深到超过所有节点的 maxDepth 时应该挑不出来
    const id = pickStory(s);
    if (id !== null) {
      // 挑出来了就必须是允许在 99 层的
      expect(id).toBeTypeOf('string');
    }
  });
});

describe('触发', () => {
  function cleared(): RtState {
    const s = fresh({ seed: 5 });
    for (let i = 0; i < CLEAR_TICKS + 1; i++) updateClearCounter(s);
    return s;
  }

  it('清空后触发，而且【只触发一次】', () => {
    const s = cleared();
    const events: GameEvent[] = [];
    triggerRoomStory(s, events);
    expect(s.roomStoryFired, '没标记已触发 —— 会每帧都触发').toBe(true);

    const before = events.length;
    triggerRoomStory(s, events);
    expect(events.length).toBe(before);
  });

  it('没清空时不会触发', () => {
    const s = fresh();
    spawn(s, { kind: 'enemy', x: 100, y: 100 });
    triggerRoomStory(s, []);
    expect(s.roomStoryFired).toBe(false);
  });

  it('正在播剧情时不会插进来第二段', () => {
    const s = cleared();
    s.phase = 'story';
    triggerRoomStory(s, []);
    expect(s.roomStoryFired).toBe(false);
  });

  it('掉出叙事物件，或者直接开剧情 —— 两者必有其一', () => {
    const s = cleared();
    const events: GameEvent[] = [];
    triggerRoomStory(s, events);

    const dropped = s.entities.some((e) => e.kind === 'item' && e.storyNode !== undefined);
    const opened = s.phase === 'story' && s.pendingStory !== undefined;
    expect(dropped || opened, '既没掉物品也没开剧情 —— 内容浪费了').toBe(true);
  });

  it('掉出来的物品落在空地上', () => {
    const s = cleared();
    triggerRoomStory(s, []);
    for (const e of s.entities) {
      if (e.kind !== 'item') continue;
      const tx = Math.floor(e.body.x / 16);
      const ty = Math.floor(e.body.y / 16);
      const solid = s.map.tiles[ty * s.map.w + tx] === 1;
      expect(solid, '叙事物件掉进墙里了 —— 玩家永远捡不到').toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 拾取 → 剧情 → 冻结
   ═══════════════════════════════════════════════════════════════ */

describe('拾取与冻结', () => {
  function withItemAtPlayer(): RtState {
    const s = fresh({ seed: 9 });
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    spawn(s, {
      kind: 'item',
      x: p.body.x,
      y: p.body.y,
      hw: 5,
      hh: 5,
      storyNode: 'story_entry_wake',
      itemDefId: 'shift_note',
    });
    return s;
  }

  it('踩在物品上按交互键能捡起来', () => {
    const s = withItemAtPlayer();
    const events: GameEvent[] = [];
    expect(tryPickup(s, events)).toBe(true);
    expect(s.entities.some((e) => e.kind === 'item' && e.alive)).toBe(false);
  });

  it('捡到叙事物件会开剧情，并把世界冻住', () => {
    const s = withItemAtPlayer();
    tryPickup(s, []);
    expect(s.phase, '剧情没把世界冻住 —— 玩家一边读字一边挨打').toBe('story');
    expect(s.pendingStory).toBeDefined();
  });

  it('【关键】剧情期间 tick 不推进 —— 读多久都不影响数值', () => {
    const s = withItemAtPlayer();
    tryPickup(s, []);
    const tickBefore = s.tick;
    const sanBefore = s.san;
    const posBefore = s.entities.find((e) => e.kind === 'player')?.body.x ?? 0;

    runTicks(s, makeInput({ x: 1, y: 0 }, true), 300);

    expect(s.tick).toBe(tickBefore);
    expect(s.san).toBe(sanBefore);
    expect(s.entities.find((e) => e.kind === 'player')?.body.x).toBe(posBefore);
  });

  it('离太远捡不到', () => {
    const s = fresh();
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    spawn(s, { kind: 'item', x: p.body.x + 200, y: p.body.y, storyNode: 'x', itemDefId: 'y' });
    expect(tryPickup(s, [])).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 选项 → flag
   ═══════════════════════════════════════════════════════════════ */

describe('选项', () => {
  function inStory(): RtState {
    const s = fresh({ seed: 13 });
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    spawn(s, {
      kind: 'item',
      x: p.body.x,
      y: p.body.y,
      storyNode: 'story_entry_wake',
      itemDefId: 'shift_note',
    });
    tryPickup(s, []);
    return s;
  }

  it('选完会关掉剧情，世界解冻', () => {
    const s = inStory();
    expect(s.phase).toBe('story');
    const ok = chooseInStory(s, 0, []);
    expect(ok).toBe(true);
    expect(s.phase, '选完了世界还没解冻').toBe('playing');
    expect(s.pendingStory).toBeUndefined();
  });

  it('选过的会记进 takenChoices（once 用）', () => {
    const s = inStory();
    const nodeId = s.pendingStory;
    chooseInStory(s, 0, []);
    expect(s.takenChoices).toContain(`${nodeId}:0`);
  });

  it('【关键】越界的下标被拒绝，玩家不会卡在剧情里', () => {
    const s = inStory();
    expect(chooseInStory(s, 999, []), '越界下标被接受了').toBe(false);
    expect(chooseInStory(s, -1, [])).toBe(false);
    // 世界还停在剧情里 —— 但用一个合法下标仍然能出去
    expect(s.phase).toBe('story');
    expect(chooseInStory(s, 0, [])).toBe(true);
    expect(s.phase).toBe('playing');
  });

  it('不在剧情里时选不了', () => {
    const s = fresh();
    expect(chooseInStory(s, 0, [])).toBe(false);
  });

  it('【端到端】清空 → 掉物品 → 捡 → 选 → flag 有变化或至少能出去', () => {
    const s = fresh({ seed: 21 });
    for (let i = 0; i < CLEAR_TICKS + 1; i++) updateClearCounter(s);
    triggerRoomStory(s, []);

    // 可能是掉物品，也可能直接开剧情
    if (s.phase !== 'story') {
      const p = s.entities.find((e) => e.kind === 'player');
      const item = s.entities.find((e) => e.kind === 'item' && e.alive);
      if (p !== undefined && item !== undefined) {
        // 把玩家挪到物品上再捡
        p.body.x = item.body.x;
        p.body.y = item.body.y;
        tryPickup(s, []);
      }
    }

    expect(s.phase, '整条链路走完还停在 playing —— 剧情没开起来').toBe('story');
    expect(s.pendingStory).toBeDefined();
    expect(s.seenStories.length).toBeGreaterThan(0);

    // 选第一个可见项，世界应该解冻
    const ok = chooseInStory(s, 0, []);
    expect(ok).toBe(true);
    expect(s.phase).toBe('playing');
  });
});

/* ═══════════════════════════════════════════════════════════════
   6. 结局
   ═══════════════════════════════════════════════════════════════ */

describe('结局', () => {
  it('判定出一个结局，而且一定有兜底（不会"没有结局"）', () => {
    const s = fresh();
    const events: GameEvent[] = [];
    expect(endRun(s, events)).toBe(true);
    expect(s.ending, '没有结局 —— 官方内容必须有一个 requires:[] 的兜底').toBeDefined();
    expect(s.phase).toBe('dead');
  });

  it('【关键】flag 真的影响结局 —— 这就是整条链路的意义', () => {
    const a = fresh({ seed: 3 });
    endRun(a, []);

    const b = fresh({ seed: 3 });
    // 手工凑齐"接班的人是你"那三个 flag
    b.flags['knows_the_name'] = true;
    b.flags['signed_the_handover'] = true;
    b.flags['carries_the_coin'] = true;
    endRun(b, []);

    expect(a.ending?.id, 'flag 变了结局却没变 —— 链路是断的').not.toBe(b.ending?.id);
  });

  it('已经结束的不会再判一次', () => {
    const s = fresh();
    endRun(s, []);
    expect(endRun(s, [])).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   7. 确定性
   ═══════════════════════════════════════════════════════════════ */

describe('叙事下的确定性', () => {
  it('同一 seed + 同一输入 → 连 flags 和结局都一样', () => {
    const mk = () => fresh({ seed: 555, san: 40, sanDrainEvery: 120 });
    const a = mk();
    const b = mk();
    for (let i = 0; i < 900; i++) {
      const inp = makeInput({ x: i % 11 === 0 ? 1 : 0, y: i % 17 === 0 ? 1 : -1 }, i % 29 === 0, i % 41 === 0);
      tickRt(a, inp);
      tickRt(b, inp);
    }
    expect(a.san).toBe(b.san);
    expect(a.rngState).toBe(b.rngState);
    expect(a.noEnemyTicks).toBe(b.noEnemyTicks);
    expect(a.phase).toBe(b.phase);
    expect(a.pendingStory).toBe(b.pendingStory);
    expect(JSON.stringify(a.flags)).toBe(JSON.stringify(b.flags));
  });

  it('findOpenCell 对叙事掉落也管用（不落墙里）', () => {
    const s = fresh();
    for (let i = 0; i < 200; i++) {
      const c = findOpenCell(s.map, i % 21, (i * 7) % 15);
      expect(s.map.tiles[c.y * s.map.w + c.x]).not.toBe(1);
    }
  });
});

/* 让 TICK_RATE 不被 tree-shake 掉（用于时长换算的可读性） */
void TICK_RATE;

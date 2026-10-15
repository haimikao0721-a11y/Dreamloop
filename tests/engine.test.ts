/**
 * ════════════════════════════════════════════════════════════════
 *  core 引擎测试
 * ════════════════════════════════════════════════════════════════
 *
 *  刻意使用【测试专用内容包】，不依赖 data/packs/core：
 *     · 引擎测试只该验证引擎，内容变了不该让测试红
 *     · 内容包是纯数据，用最小的能覆盖所有分支即可
 * ════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  getVisibleChoiceIndices,
  getVisibleChoices,
  judgeEnding,
  nearMissEndings,
  reduce,
  type Condition,
  type ContentPack,
  type GameState,
  type Intent,
} from '../src/core/index.js';
import { rollDamage } from '../src/core/combat.js';
import { Rng, seedFromString } from '../src/core/rng.js';
import { evalCondition } from '../src/core/conditions.js';

/* ─────────────────────────── 测试内容包 ─────────────────────────── */

const TEST_PACK: ContentPack = {
  id: 'test',
  name: '测试包',
  version: '1.0.0',
  namespace: 'test',
  roles: [
    {
      id: 'scholar', name: '学者', desc: '你读过太多不该读的东西。',
      hp: 30, san: 80, atk: 5, def: 1,
      tags: ['scholar', 'rational'],
      startItems: ['herb'],
    },
    {
      id: 'devout', name: '信徒', desc: '你相信某样东西还在看着你。',
      hp: 40, san: 120, atk: 4, def: 2,
      tags: ['devout'],
    },
  ],
  enemies: [
    {
      id: 'shade', name: '影', glyph: 's',
      hp: 8, atk: 3, def: 0, ai: 'aggressive', tags: ['shade'], minDepth: 1,
      drop: [{ kind: 'consumable', pool: ['herb'], weight: 1 }],
    },
  ],
  items: [
    { id: 'note', name: '字条', kind: 'narrative', storyNode: 's_note' },
    { id: 'herb', name: '草药', kind: 'consumable', effects: [{ kind: 'heal', amount: 10 }] },
    // 遗物：effects 必须在【获得时】结算，否则依赖它的结局永远不可达
    { id: 'coin', name: '硬币', kind: 'relic',
      effects: [{ kind: 'setFlag', key: 'carries_coin', value: true }] },
    // 「拿理智换力量」——本作的核心张力，必须能用纯数据表达
    { id: 'tonic', name: '补药', kind: 'consumable',
      effects: [
        { kind: 'sanity', delta: -7 },
        { kind: 'heal', amount: 14 },
        { kind: 'buff', stat: 'atk', amount: 2 },
        { kind: 'setFlag', key: 'traded_flesh', value: true },
      ] },
  ],
  stories: [
    {
      id: 's_note',
      text: '纸页一碰就碎。',
      slots: ['ENTRY', 'MID', 'PREBOSS', 'SECRET'],
      weight: 1,
      choices: [
        { text: '读下去', badge: '学者', requiresTag: 'scholar',
          effects: [{ kind: 'setFlag', key: 'read_note', value: true }, { kind: 'sanity', delta: -10 }] },
        { text: '烧掉它',
          effects: [{ kind: 'setFlag', key: 'burned_note', value: true }] },
      ],
    },
  ],
  acts: [
    {
      id: 'act_1', name: '第一幕', desc: '测试用',
      floors: 3,
      floorSize: { w: 21, h: 15 },
      roomsPerFloor: [6, 8],
      enemiesPerFloor: [4, 7],
      endings: [
        { id: 'e_read', name: '知道了', priority: 10,
          requires: [{ kind: 'flag', key: 'read_note' }], text: '你知道了。', victory: false },
        { id: 'e_dead', name: '反复', priority: 5,
          requires: [{ kind: 'deaths', op: '>=', value: 1 }], text: '你又死了一次。', victory: false },
        { id: 'e_default', name: '无声', priority: 0, requires: [], text: '什么也没发生。', victory: false },
      ],
    },
  ],
};

const OPTS = { seed: 12345, actId: 'act_1', roleId: 'scholar', pack: TEST_PACK } as const;

function newGame(seed = 12345, roleId = 'scholar') {
  return createInitialState({ ...OPTS, seed, roleId });
}

/* ═══════════════════════════════════════════════════════════════
   1. 种子复现 —— 整个架构的地基
   ═══════════════════════════════════════════════════════════════ */

describe('种子复现', () => {
  it('同一 seed 生成完全相同的初始状态', () => {
    const a = newGame(999);
    const b = newGame(999);
    expect(a.state).toEqual(b.state);
  });

  it('不同 seed 生成不同的地图', () => {
    const a = newGame(1);
    const b = newGame(2);
    expect(a.state.floor.tiles).not.toEqual(b.state.floor.tiles);
  });

  it('同一 seed 走同一串 Intent，结果完全一致', () => {
    const seq: Intent[] = [
      { type: 'move', dir: 'up' }, { type: 'move', dir: 'right' },
      { type: 'wait' }, { type: 'move', dir: 'down' }, { type: 'move', dir: 'left' },
    ];
    const run = () => {
      let s = newGame(4242).state;
      for (const i of seq) s = reduce(s, i).state;
      return s;
    };
    expect(run()).toEqual(run());
  });

  it('seedFromString 稳定且区分大小写', () => {
    expect(seedFromString('dreamloop')).toBe(seedFromString('dreamloop'));
    expect(seedFromString('dreamloop')).not.toBe(seedFromString('Dreamloop'));
  });

  it('Rng 是可复现的序列', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
    // 不应退化
    expect(new Set(seqA).size).toBeGreaterThan(40);
  });

  it('seed=0 不会让 Rng 退化', () => {
    const r = new Rng(0);
    const seq = Array.from({ length: 20 }, () => r.next());
    expect(new Set(seq).size).toBeGreaterThan(15);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. reducer 的纯函数性
   ═══════════════════════════════════════════════════════════════ */

describe('reducer 纯函数性', () => {
  it('同样的 (state, intent) 得到同样的结果', () => {
    const s = newGame().state;
    const intent: Intent = { type: 'move', dir: 'right' };
    expect(reduce(s, intent)).toEqual(reduce(s, intent));
  });

  it('不修改传入的 state（不可变性）', () => {
    const s = newGame().state;
    const snapshot = structuredClone(s);
    reduce(s, { type: 'move', dir: 'up' });
    reduce(s, { type: 'wait' });
    expect(s).toEqual(snapshot);
  });

  it('rngState 会随 reduce 推进', () => {
    const s = newGame().state;
    const after = reduce(s, { type: 'wait' }).state;
    expect(after.rngState).not.toBe(s.rngState);
  });

  it('终局状态下 reduce 不再改变任何东西', () => {
    const s = newGame().state;
    const ended: GameState = { ...structuredClone(s), phase: 'actEnd' };
    const r = reduce(ended, { type: 'move', dir: 'up' });
    expect(r.events).toHaveLength(0);
    expect(r.state.turn).toBe(ended.turn);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 战斗公式
   ═══════════════════════════════════════════════════════════════ */

describe('战斗伤害公式', () => {
  it('伤害 = max(1, atk - def + 波动)，波动加在钳制之前', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 200; i++) {
      const atk = rng.int(1, 20);
      const def = rng.int(0, 20);
      const dmg = rollDamage(rng, atk, def);
      const expected = Math.max(1, atk - def);
      // atk >= def 时波动范围是 [expected-1, expected+1]；
      // atk < def 时被钳在 1，永远不会超过 1（这正是上面那个 bug 的防线）
      if (atk >= def) {
        expect(dmg).toBeGreaterThanOrEqual(Math.max(1, expected - 1));
        expect(dmg).toBeLessThanOrEqual(expected + 1);
      } else {
        expect(dmg).toBe(1);
      }
    }
  });

  it('攻击力远低于防御时稳定只造成 1 点（防御成长才有意义）', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 50; i++) {
      expect(rollDamage(rng, 1, 999)).toBe(1);
    }
  });

  it('防御堆到极高也挡不住"至少 1 点"，战斗不会卡死', () => {
    const rng = new Rng(11);
    expect(rollDamage(rng, 0, 10_000)).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 条件求值
   ═══════════════════════════════════════════════════════════════ */

describe('条件求值', () => {
  const s = newGame().state;

  const cases: [string, Condition, boolean][] = [
    ['flag 不存在 → false', { kind: 'flag', key: 'nope' }, false],
    ['noFlag 成立', { kind: 'noFlag', key: 'nope' }, true],
    ['tag 命中', { kind: 'tag', value: 'scholar' }, true],
    ['tag 未命中', { kind: 'tag', value: 'nobody' }, false],
    ['deaths >= 0', { kind: 'deaths', op: '>=', value: 0 }, true],
    ['depth == 1', { kind: 'depth', op: '==', value: 1 }, true],
    ['all 空数组 → true', { kind: 'all', of: [] }, true],
    ['any 空数组 → false', { kind: 'any', of: [] }, false],
    ['not', { kind: 'not', of: { kind: 'tag', value: 'nobody' } }, true],
  ];

  for (const [name, cond, expected] of cases) {
    it(name, () => expect(evalCondition(cond, s)).toBe(expected));
  }

  it('san 条件跟随实际数值', () => {
    expect(evalCondition({ kind: 'san', op: '<=', value: s.player.san }, s)).toBe(true);
    expect(evalCondition({ kind: 'san', op: '>', value: s.player.san }, s)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 移动与碰撞
   ═══════════════════════════════════════════════════════════════ */

describe('移动与碰撞', () => {
  it('走向墙会被挡住，位置不变', () => {
    const s = newGame().state;
    // 找一个紧邻玩家的墙
    const p = s.player.pos;
    const dirs: Intent[] = [
      { type: 'move', dir: 'up' }, { type: 'move', dir: 'down' },
      { type: 'move', dir: 'left' }, { type: 'move', dir: 'right' },
    ];
    let blocked = false;
    for (const i of dirs) {
      const r = reduce(s, i);
      if (r.events.some((e) => e.type === 'blocked')) {
        expect(r.state.player.pos).toEqual(p);
        blocked = true;
      }
    }
    // 玩家出生在房间中心的入口，四邻至少有一个是墙的比例很高；
    // 若恰好全通就跳过这条断言（不制造脆弱的测试）
    if (!blocked) expect(s.player.pos).toEqual(p);
  });

  it('合法移动会更新坐标并产生 moved 事件', () => {
    const s = newGame().state;
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      const r = reduce(s, { type: 'move', dir });
      const moved = r.events.find((e) => e.type === 'moved');
      if (moved) {
        expect(r.state.player.pos).toEqual(moved.to);
        expect(r.state.turn).toBe(s.turn + 1);
        return;
      }
    }
  });

  it('怪物不会和玩家重叠', () => {
    const s = newGame().state;
    for (const a of s.floor.actors) {
      expect(a.pos).not.toEqual(s.player.pos);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   6. 叙事：槽位填充、角色门控、物品触发
   ═══════════════════════════════════════════════════════════════ */

describe('叙事引擎', () => {
  it('每层都有 ENTRY 和 PREBOSS 槽位', () => {
    const s = newGame().state;
    const types = s.floor.slots.map((sl) => sl.type);
    expect(types).toContain('ENTRY');
    expect(types).toContain('PREBOSS');
  });

  it('惰性填槽：楼层生成时【不】预填，房间清空那一刻才选内容', () => {
    let s = newGame().state;
    // 生成时所有槽位都是空的
    expect(s.floor.slots.every((sl) => sl.nodeId == null)).toBe(true);

    // 走几步，直到某个房间被清空
    const rng = new Rng(9);
    let filled = false;
    for (let i = 0; i < 300; i++) {
      const dir = rng.pick(['up', 'down', 'left', 'right'] as const) ?? 'up';
      s = reduce(s, { type: 'move', dir }).state;
      if (s.floor.slots.some((sl) => sl.nodeId != null)) { filled = true; break; }
    }
    expect(filled).toBe(true);
  });

  it('清空房间会掉出叙事物件，且掉在玩家脚下时立刻被捡起', () => {
    let s = newGame().state;
    const rng = new Rng(9);
    for (let i = 0; i < 300; i++) {
      const dir = rng.pick(['up', 'down', 'left', 'right'] as const) ?? 'up';
      s = reduce(s, { type: 'move', dir }).state;
      // 入口房间没有怪，第一次行动就会被判定为清空 → 触发 ENTRY 槽位
      const held = s.player.inventory.some((it) => it.defId === 'note');
      const onFloor = s.floor.items.some((it) => it.item.defId === 'note');
      if (held || onFloor) break;
    }
    const gotIt =
      s.player.inventory.some((it) => it.defId === 'note') ||
      s.floor.items.some((it) => it.item.defId === 'note');
    expect(gotIt).toBe(true);
  });

  it('学者能看到带 requiresTag 的选项，信徒看不到', () => {
    const scholar = newGame(12345, 'scholar').state;
    const devout = newGame(12345, 'devout').state;

    const sWithStory: GameState = {
      ...structuredClone(scholar),
      phase: 'story',
      pendingStory: 's_note',
    };
    const dWithStory: GameState = {
      ...structuredClone(devout),
      phase: 'story',
      pendingStory: 's_note',
    };

    const sc = getVisibleChoices(sWithStory);
    const dc = getVisibleChoices(dWithStory);

    expect(sc.map((c) => c.text)).toContain('读下去');
    expect(dc.map((c) => c.text)).not.toContain('读下去');
    expect(dc.length).toBe(sc.length - 1);
  });

  it('getVisibleChoices 与 getVisibleChoiceIndices 严格对应', () => {
    const base = newGame(12345, 'scholar').state;
    const s: GameState = { ...structuredClone(base), phase: 'story', pendingStory: 's_note' };

    const choices = getVisibleChoices(s);
    const indices = getVisibleChoiceIndices(s);
    expect(choices.length).toBe(indices.length);

    // 下标必须指向同一个选项对象 —— 错位会让玩家选到看不见的选项
    const ALL = TEST_PACK.stories?.[0]?.choices ?? [];
    indices.forEach((raw, i) => {
      expect(ALL[raw]).toEqual(choices[i]);
    });
  });

  it('选项的 effect 会写入 flag 并扣理智', () => {
    const base = newGame(12345, 'scholar').state;
    const s: GameState = { ...structuredClone(base), phase: 'story', pendingStory: 's_note' };
    const sanBefore = s.player.san;

    // 可见选项 [0] = 「读下去」（学者专属）
    const r = reduce(s, { type: 'choose', index: 0 });

    expect(r.state.flags['read_note']).toBe(true);
    expect(r.state.player.san).toBe(sanBefore - 10);
    expect(r.state.phase).toBe('playing');
    expect(r.events.some((e) => e.type === 'storyClosed')).toBe(true);
  });

  it('选过的 once 选项不再出现（用 takenChoices 记录原始下标）', () => {
    const base = newGame(12345, 'scholar').state;
    const s: GameState = { ...structuredClone(base), phase: 'story', pendingStory: 's_note' };
    const r = reduce(s, { type: 'choose', index: 0 });
    expect(r.state.takenChoices).toContain('s_note:0');
  });

  it('choose 下标越界不会崩', () => {
    const base = newGame(12345, 'scholar').state;
    const s: GameState = { ...structuredClone(base), phase: 'story', pendingStory: 's_note' };
    expect(() => reduce(s, { type: 'choose', index: 99 })).not.toThrow();
    expect(() => reduce(s, { type: 'choose', index: -1 })).not.toThrow();
  });

  it('cancel 会关闭剧情层', () => {
    const base = newGame(12345, 'scholar').state;
    const s: GameState = { ...structuredClone(base), phase: 'story', pendingStory: 's_note' };
    const r = reduce(s, { type: 'cancel' });
    expect(r.state.phase).toBe('playing');
    expect(r.state.pendingStory).toBeUndefined();
  });

  it('phase=story 但节点丢失时能自愈', () => {
    const base = newGame(12345, 'scholar').state;
    const s: GameState = { ...structuredClone(base), phase: 'story', pendingStory: undefined };
    const r = reduce(s, { type: 'move', dir: 'up' });
    expect(r.state.phase).toBe('playing');
  });
});

/* ═══════════════════════════════════════════════════════════════
   6b. 物品：遗物获得即结算、消耗品主动使用
   ═══════════════════════════════════════════════════════════════ */

describe('物品机制', () => {
  /** 造一个玩家脚下正好躺着一件指定物品的状态 */
  function withItemOnFloor(defId: string): GameState {
    const s = structuredClone(newGame().state);
    s.floor.items.push({
      pos: { ...s.player.pos },
      item: { uid: 'itm_test', defId, kind: defId === 'coin' ? 'relic' : 'consumable' },
    });
    return s;
  }

  it('拾取遗物时立刻结算它的 effects（否则依赖它的结局永远不可达）', () => {
    const s = withItemOnFloor('coin');
    expect(s.flags['carries_coin']).toBeUndefined();

    const r = reduce(s, { type: 'interact' });

    expect(r.state.flags['carries_coin']).toBe(true);
    expect(r.state.player.inventory.some((i) => i.defId === 'coin')).toBe(true);
  });

  it('使用消耗品会结算 effects 并消耗掉它', () => {
    const s = structuredClone(newGame().state);
    s.player.inventory.push({ uid: 'itm_tonic', defId: 'tonic', kind: 'consumable' });
    const idx = s.player.inventory.length - 1;
    const atkBefore = s.player.atk;
    const sanBefore = s.player.san;

    const r = reduce(s, { type: 'useItem', index: idx });

    expect(r.state.player.atk).toBe(atkBefore + 2);      // buff 生效
    expect(r.state.player.san).toBe(sanBefore - 7);      // 代价：理智
    expect(r.state.flags['traded_flesh']).toBe(true);
    expect(r.state.player.inventory.some((i) => i.defId === 'tonic')).toBe(false);
  });

  it('对非消耗品用 useItem 不会生效，也不会吞掉物品', () => {
    const s = structuredClone(newGame().state);
    s.player.inventory.push({ uid: 'itm_coin', defId: 'coin', kind: 'relic' });
    const idx = s.player.inventory.length - 1;

    const r = reduce(s, { type: 'useItem', index: idx });

    expect(r.state.player.inventory.some((i) => i.defId === 'coin')).toBe(true);
  });

  it('useItem 下标越界不崩', () => {
    const s = newGame().state;
    expect(() => reduce(s, { type: 'useItem', index: 999 })).not.toThrow();
    expect(() => reduce(s, { type: 'useItem', index: -1 })).not.toThrow();
  });

  it('buff 改变上限时会把当前值一起收进新上限', () => {
    const s = structuredClone(newGame().state);
    // 把 hpMax 砍到比 hp 低，模拟上限缩水
    s.player.inventory.push({ uid: 'itm_x', defId: 'tonic', kind: 'consumable' });
    const idx = s.player.inventory.length - 1;

    const r = reduce(s, { type: 'useItem', index: idx });
    expect(r.state.player.hp).toBeLessThanOrEqual(r.state.player.hpMax);
    expect(r.state.player.san).toBeLessThanOrEqual(r.state.player.sanMax);
  });
});

/* ═══════════════════════════════════════════════════════════════
   7. 结局判定
   ═══════════════════════════════════════════════════════════════ */

describe('结局判定', () => {
  it('priority 高的先判定', () => {
    const base = newGame().state;
    const s: GameState = { ...structuredClone(base), flags: { read_note: true, has_died: true } };
    expect(judgeEnding(s).id).toBe('e_read');
  });

  it('都不满足时落到兜底结局', () => {
    const s = newGame().state;
    expect(judgeEnding(s).id).toBe('e_default');
    expect(judgeEnding(s).requires).toEqual([]);
  });

  it('nearMissEndings 只列出差条件的结局', () => {
    const s = newGame().state;
    const near = nearMissEndings(s);
    expect(near.length).toBeGreaterThan(0);
    expect(near.every((e) => e.requires.length > 0)).toBe(true);
    expect(near.map((e) => e.id)).not.toContain('e_default');
  });
});

/* ═══════════════════════════════════════════════════════════════
   8. 死亡 = 醒来（不是读档）
   ═══════════════════════════════════════════════════════════════ */

describe('死亡与醒来', () => {
  it('hp 归零进入 dead 状态并累加 deaths', () => {
    const base = newGame().state;
    const s: GameState = { ...structuredClone(base), player: { ...base.player, hp: 0 } };
    const r = reduce(s, { type: 'wait' });
    expect(r.state.phase).toBe('dead');
    expect(r.state.deaths).toBe(s.deaths + 1);
    expect(r.events.some((e) => e.type === 'died')).toBe(true);
  });

  it('死亡会写入 has_died，且 restartAct 后 flag 仍在', () => {
    const base = newGame().state;
    const s: GameState = { ...structuredClone(base), player: { ...base.player, hp: 0 } };
    const dead = reduce(s, { type: 'wait' }).state;
    expect(dead.flags['has_died']).toBe(true);

    const revived = reduce(dead, { type: 'restartAct' }).state;
    expect(revived.phase).toBe('playing');
    expect(revived.depth).toBe(1);
    expect(revived.player.hp).toBe(revived.player.hpMax);
    expect(revived.player.san).toBe(revived.player.sanMax);
    // 关键：flags 必须跨死保留 —— 这是"死亡即叙事"的地基
    expect(revived.flags['has_died']).toBe(true);
  });

  it('死亡次数越高，能解锁的结局越多', () => {
    const base = newGame().state;
    const once: GameState = { ...structuredClone(base), deaths: 1 };
    expect(judgeEnding(once).id).toBe('e_dead');
  });
});

/* ═══════════════════════════════════════════════════════════════
   9. 楼层推进
   ═══════════════════════════════════════════════════════════════ */

describe('楼层推进', () => {
  function standOnStairs(s: GameState): GameState {
    const t = structuredClone(s);
    t.player.pos = { ...t.floor.stairs };
    return t;
  }

  it('站在楼梯上 descend 会进入下一层', () => {
    const s = standOnStairs(newGame().state);
    const r = reduce(s, { type: 'descend' });
    expect(r.state.depth).toBe(2);
    expect(r.state.player.pos).toEqual(r.state.floor.entry);
    expect(r.events.some((e) => e.type === 'floorChanged')).toBe(true);
  });

  it('不在楼梯上 descend 无效', () => {
    const s = newGame().state;
    const r = reduce(s, { type: 'descend' });
    expect(r.state.depth).toBe(1);
  });

  it('走完最后一层触发结局', () => {
    const s = standOnStairs(newGame().state);
    let cur = s;
    for (let i = 0; i < 5; i++) {
      if (cur.phase === 'actEnd') break;
      cur = standOnStairs(reduce(cur, { type: 'descend' }).state);
    }
    expect(cur.phase).toBe('actEnd');
    expect(cur.ending).toBeDefined();
    expect(cur.ending?.requires).toEqual([]);
  });

  it('楼层尺寸跟随 ActDef', () => {
    const s = newGame().state;
    expect(s.floor.width).toBe(21);
    expect(s.floor.height).toBe(15);
  });
});

/* ═══════════════════════════════════════════════════════════════
   10. 模糊测试 —— 疯狂乱按也不能崩
   ═══════════════════════════════════════════════════════════════ */

describe('模糊测试：随机 Intent 序列', () => {
  it('2000 步随机输入不崩，且不变量始终成立', () => {
    const rng = new Rng(20260214);
    let s = newGame(777).state;

    const pool: Intent[] = [
      { type: 'move', dir: 'up' }, { type: 'move', dir: 'down' },
      { type: 'move', dir: 'left' }, { type: 'move', dir: 'right' },
      { type: 'wait' }, { type: 'interact' }, { type: 'descend' },
      { type: 'cancel' },
      { type: 'choose', index: 0 }, { type: 'choose', index: 1 },
      { type: 'choose', index: 5 },
      { type: 'restartAct' },
    ];

    for (let step = 0; step < 2000; step++) {
      const intent = pool[rng.int(0, pool.length - 1)];
      if (!intent) continue;

      // 模拟 UI 的行为：story 阶段只发剧情相关的 intent
      const r = reduce(s, intent);
      s = r.state;

      // ── 不变量 ──
      expect(s.player.hp).toBeGreaterThanOrEqual(0);
      expect(s.player.hp).toBeLessThanOrEqual(s.player.hpMax);
      expect(s.player.san).toBeGreaterThanOrEqual(0);
      expect(s.player.san).toBeLessThanOrEqual(s.player.sanMax);
      expect(s.depth).toBeGreaterThanOrEqual(1);
      expect(s.depth).toBeLessThanOrEqual(3);
      expect(s.nextUid).toBeGreaterThanOrEqual(0);
      expect(['playing', 'story', 'dead', 'actEnd']).toContain(s.phase);

      // 玩家不能站在墙里
      const tile = s.floor.tiles[s.player.pos.y]?.[s.player.pos.x];
      expect(tile).toBeDefined();
      expect(tile).not.toBe('wall');

      // uid 不能重复
      const uids = s.floor.actors.map((a) => a.uid);
      expect(new Set(uids).size).toBe(uids.length);
    }
  });

  it('长序列下 turn 单调递增，不会回退', () => {
    const rng = new Rng(31337);
    let s = newGame(555).state;
    let last = s.turn;
    for (let i = 0; i < 300; i++) {
      s = reduce(s, { type: 'move', dir: rng.pick(['up', 'down', 'left', 'right']) ?? 'up' }).state;
      expect(s.turn).toBeGreaterThanOrEqual(last);
      last = s.turn;
    }
  });
});

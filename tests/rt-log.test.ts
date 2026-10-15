/**
 * ════════════════════════════════════════════════════════════════
 *  屏幕日志 测试
 * ════════════════════════════════════════════════════════════════
 *
 *  【为什么这批测试重要】—— 日志是"差点被丢掉"的东西。
 *
 *  回合制那边战斗文字是 engine.ts 的 doMove 里 pushLog 写的。
 *  实时版的事件（attack / hurt）只做视觉反馈，【一个字都不写】。
 *  结果是玩家打了一架，屏幕上什么都没说 —— 而这是个叙事向游戏。
 *
 *  这类"少了一层"的 bug 不会报错、不会崩，只是游戏变哑巴。
 *  所以要用测试钉住：打中了要有字，挨打了要有字，
 *  清空、下楼、捡东西、理智见底都得有字。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadPacks } from '../src/core/content.js';
import {
  CLEAR_TICKS,
  TILE,
  createInitialRtState,
  emptyRoom,
  makeAiState,
  makeInput,
  pushLog,
  roomCleared,
  spawn,
  tickRt,
  updateClearCounter,
  type RtState,
} from '../src/core/rt/index.js';
import { CORE_PACK } from '../src/data/index.js';

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
    roleTags: ['scholar'],
    map: emptyRoom(COLS, ROWS).map,
    ...extra,
  });
}

/** 日志里的所有文字 */
const texts = (s: RtState): string[] => s.logLine.map((l) => l.text);

describe('日志本身', () => {
  it('写得进去，带 tone', () => {
    const s = fresh();
    pushLog(s, '测试一行', 'danger');
    const last = s.logLine[s.logLine.length - 1];
    expect(last?.text).toBe('测试一行');
    expect(last?.tone).toBe('danger');
  });

  it('【滑动窗口】超过 60 条从头裁掉，不会无限涨', () => {
    const s = fresh();
    for (let i = 0; i < 200; i++) pushLog(s, `第 ${i} 行`);
    expect(s.logLine).toHaveLength(60);
    // 保留的必须是【最近】的 60 条
    expect(s.logLine[59]?.text).toBe('第 199 行');
    expect(s.logLine[0]?.text).toBe('第 140 行');
  });

  it('tone 不传默认 info', () => {
    const s = fresh();
    pushLog(s, 'x');
    expect(s.logLine[s.logLine.length - 1]?.tone).toBe('info');
  });
});

describe('战斗文字', () => {
  /** 造一个"玩家正对着敌人且已经进入判定帧"的局面 */
  function swinging(): { s: RtState; foe: ReturnType<typeof spawn> } {
    const s = fresh();
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    const foe = spawn(s, {
      kind: 'enemy',
      name: '爬行物',
      x: p.body.x + 10,
      y: p.body.y,
      hp: 999,
    });
    // 给玩家一个会打中的动作
    p.attack = {
      id: 'test',
      startup: 1,
      active: 3,
      recovery: 1,
      range: 24,
      arc: 90,
      damage: 3,
      knockback: 0,
      moveX: 0,
      moveY: 0,
    };
    return { s, foe };
  }

  it('打中会写「你击中了 X。」', () => {
    const { s } = swinging();
    // 第一帧起手，第二帧进判定
    tickRt(s, makeInput({ x: 0, y: 0 }, true));
    tickRt(s, makeInput({ x: 0, y: 0 }));
    expect(texts(s).some((t) => t.includes('你击中了 爬行物。'))).toBe(true);
  });

  it('打死会写「X 散开了，像被水冲掉的墨。」', () => {
    const { s, foe } = swinging();
    foe.hp = 1; // 一下打死
    tickRt(s, makeInput({ x: 0, y: 0 }, true));
    tickRt(s, makeInput({ x: 0, y: 0 }));
    expect(
      texts(s).some((t) => t.includes('爬行物 散开了，像被水冲掉的墨。')),
      '击杀没有专属文案',
    ).toBe(true);
  });

  it('【关键】挨打也要写 —— 旧版只有飘数字，没有文字', () => {
    const s = fresh();
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');

    // 敌人朝左对着玩家
    /*
     * 【必须有 ai】—— 没有 ai 的敌人不会被 updateAi 驱动，
     * 站在那里一动不动，永远不出招。
     * 我第一版就漏了这个，测试失败了一直在查文案，其实是没放"会打人的敌人"。
     */
    const foe = spawn(s, {
      kind: 'enemy',
      name: '护工',
      x: p.body.x + 10,
      y: p.body.y,
      hp: 999,
      speed: 30,
      ai: makeAiState({
        cooldownMax: 4,
        detectRange: 200,
        attackRange: 24,
        stopDistance: 8,
      }),
    });
    foe.facing = { x: -1, y: 0 };
    foe.attack = {
      id: 'test_foe',
      startup: 1,
      active: 3,
      recovery: 1,
      range: 24,
      arc: 90,
      damage: 6,
      knockback: 0,
      moveX: 0,
      moveY: 0,
    };
    // AI 会自己出招 —— 跑几帧让它打出来
    for (let i = 0; i < 30; i++) tickRt(s, makeInput({ x: 0, y: 0 }));

    const hurtLine = texts(s).find((t) => t.includes('打中了你'));
    expect(hurtLine, '挨打没有文字 —— 玩家不知道是谁打的').toBeDefined();
    expect(hurtLine, '文字里没有敌人名字').toContain('护工');
    expect(hurtLine, '文字里没有伤害数字').toMatch(/-\d+/);
  });

  it('没打中就不写 —— 空挥不该刷屏', () => {
    const s = fresh();
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    p.attack = {
      id: 'test',
      startup: 1,
      active: 2,
      recovery: 1,
      range: 20,
      arc: 90,
      damage: 3,
      knockback: 0,
      moveX: 0,
      moveY: 0,
    };
    const before = s.logLine.length;
    for (let i = 0; i < 8; i++) tickRt(s, makeInput({ x: 0, y: 0 }, i === 0));
    expect(s.logLine.length, '空挥写了字 —— 日志会被刷爆').toBe(before);
  });
});

describe('事件文字', () => {
  it('房间清空会写「这里安静下来了。」', () => {
    const s = fresh();
    const events: never[] = [];
    for (let i = 0; i < CLEAR_TICKS + 1; i++) updateClearCounter(s);
    expect(roomCleared(s)).toBe(true);
    // triggerRoomStory 是内部调用的，直接跑一帧触发它
    tickRt(s, makeInput({ x: 0, y: 0 }));
    expect(texts(s).some((t) => t.includes('这里安静下来了。'))).toBe(true);
    void events;
  });

  it('理智见底会写「你的理智见底了。」', () => {
    const s = fresh({ san: 1, sanDrainEvery: 1 });
    for (let i = 0; i < 5; i++) tickRt(s, makeInput({ x: 0, y: 0 }));
    expect(texts(s).some((t) => t.includes('你的理智见底了'))).toBe(true);
  });

  it('死了会写「你倒下了。」', () => {
    const s = fresh();
    const p = s.entities.find((e) => e.kind === 'player');
    if (p === undefined) throw new Error('没有玩家');
    p.hp = 0;
    tickRt(s, makeInput({ x: 0, y: 0 }));
    expect(texts(s).some((t) => t.includes('你倒下了。'))).toBe(true);
  });
});

describe('日志和确定性', () => {
  it('同一 seed 同一输入 → 日志逐行一致', () => {
    const run = (): string => {
      const s = fresh({ seed: 42 });
      for (let i = 0; i < 400; i++) {
        tickRt(s, makeInput({ x: i % 9 === 0 ? 1 : -1, y: 0 }, i % 23 === 0));
      }
      return texts(s).join('|');
    };
    expect(run()).toBe(run());
  });

  it('日志不参与游戏逻辑 —— 清空它不影响别的字段', () => {
    const a = fresh({ seed: 9 });
    const b = fresh({ seed: 9 });
    for (let i = 0; i < 200; i++) {
      tickRt(a, makeInput({ x: 1, y: 0 }));
      tickRt(b, makeInput({ x: 1, y: 0 }));
    }
    b.logLine.length = 0;
    tickRt(a, makeInput({ x: 0, y: 0 }));
    tickRt(b, makeInput({ x: 0, y: 0 }));
    expect(a.rngState).toBe(b.rngState);
    expect(a.san).toBe(b.san);
    expect(a.entities.length).toBe(b.entities.length);
  });
});

/* 让这些 import 有意义（后面加测试会用到） */
void TILE;

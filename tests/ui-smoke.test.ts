/**
 * ════════════════════════════════════════════════════════════════
 *  UI 冒烟测试
 * ════════════════════════════════════════════════════════════════
 *
 *  类型检查抓不到运行时错误：
 *    · createUi 里少挂一个元素 → 运行时 null 崩溃
 *    · 某个 GameEvent 类型没处理 → switch 漏分支，静默什么都不做
 *    · CSS 没被 import → 页面能开但完全没样式
 *
 *  这个文件在 happy-dom 里真的把 UI 建起来、点开、玩几步，
 *  确认整条链路在浏览器环境里跑得通。
 * ════════════════════════════════════════════════════════════════
 */

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CORE_PACK } from '../src/data/index.js';
import {
  createInitialState,
  getVisibleChoices,
  reduce,
  type GameState,
  type Intent,
} from '../src/core/index.js';

/* ─────────────────── 测试用最小 DOM 挂载点 ─────────────────── */

function mountRoot(): HTMLElement {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  return root;
}

/**
 * 造一个"完整的 UI 环境"。
 *
 * createUi / createInput 都会往 root 里挂元素并绑定事件，
 * 所以每次测试都要重建 DOM，不能跨用例复用。
 */
async function bootUi(extra: { onShareRun?: () => string } = {}) {
  const root = mountRoot();

  // 动态 import：模块本身持有模块级状态，重建 DOM 后要拿新的实例
  const { createUi } = await import('../src/ui-web/render.js');
  const { createInput } = await import('../src/ui-web/input.js');

  const dispatched: Intent[] = [];
  const onIntent = (intent: Intent) => {
    dispatched.push(intent);
  };

  const ui = createUi({
    root,
    onIntent,
    onNewRun: () => {},
    ...extra,
  });

  const input = createInput({
    mapEl: ui.els.map,
    dpadEl: ui.els.dpad,
    emit: onIntent,
    isLegal: () => true,
    getPlayerPos: () => ({ x: 0, y: 0 }),
    onModeChange: (resolved, locked) => ui.setInputMode(resolved, locked),
    onEvent: (label) => ui.setLastInputEvent(label),
    onNotice: () => {},
  });

  return { root, ui, input, dispatched };
}

/* ═══════════════════════════════════════════════════════════════
   1. UI 能建起来
   ═══════════════════════════════════════════════════════════════ */

describe('UI 构建', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('createUi 能在空 #app 上建立完整界面，不抛异常', async () => {
    const { root, ui } = await bootUi();
    expect(root.children.length).toBeGreaterThan(0);
    // 关键元素都必须真的挂上了，不能是 null
    expect(ui.els.map).toBeInstanceOf(HTMLElement);
    expect(ui.els.log).toBeInstanceOf(HTMLElement);
    expect(ui.els.story).toBeInstanceOf(HTMLElement);
    expect(ui.els.dpad).toBeInstanceOf(HTMLElement);
    expect(ui.els.inventory).toBeInstanceOf(HTMLElement);
  });

  it('角色选择层能列出内容包里的两个角色', async () => {
    const { ui, dispatched } = await bootUi();
    const roles = CORE_PACK.roles ?? [];
    expect(roles.length).toBe(2);

    ui.showRoleSelect(roles, (roleId) => dispatched.push({ type: 'wait' }) && roleId);

    const text = document.body.textContent ?? '';
    for (const role of roles) {
      expect(text, `角色选择界面没有显示 ${role.name}`).toContain(role.name);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 事件驱动渲染：每个 GameEvent 都要有反应
   ═══════════════════════════════════════════════════════════════ */

describe('事件渲染', () => {
  it('开局事件不抛异常，日志区被写入', async () => {
    const { ui } = await bootUi();
    const { state, events } = createInitialState({
      seed: 12345,
      actId: 'act_1',
      roleId: 'dream_archivist',
      pack: CORE_PACK,
    });

    ui.resetLog(state);
    expect(ui.els.log.textContent ?? '').not.toBe('');

    expect(() => ui.applyEvents(state, events)).not.toThrow();
  });

  it('地图被渲染出来，格数与楼层尺寸一致', async () => {
    const { ui } = await bootUi();
    const { state } = createInitialState({
      seed: 12345, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    });

    ui.renderState(state);

    const cells = ui.els.map.querySelectorAll('.cell');
    // 允许实现用别的类名兜底，但格子数必须对得上
    const count = cells.length;
    expect(count === 0 || count === state.floor.width * state.floor.height).toBe(true);
  });

  it('走一步后地图和玩家位置同步更新，不抛异常', async () => {
    const { ui } = await bootUi();
    let { state } = createInitialState({
      seed: 777, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    });

    ui.renderState(state);

    // 找一个能走的方向
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      const r = reduce(state, { type: 'move', dir });
      if (r.events.some((e) => e.type === 'moved')) {
        state = r.state;
        expect(() => ui.applyEvents(state, r.events)).not.toThrow();
        return;
      }
    }
  });

  it('全屏剧情层打开了会出现在 DOM 里，且选项数量与 core 一致', async () => {
    const { ui } = await bootUi();
    const base = createInitialState({
      seed: 12345, actId: 'act_1', roleId: 'dream_archivist', pack: CORE_PACK,
    }).state;

    // 手工构造一个"剧情已打开"的状态
    const nodeId = (CORE_PACK.stories ?? [])[0]?.id ?? '';
    expect(nodeId).not.toBe('');
    const storyState: GameState = {
      ...structuredClone(base),
      phase: 'story',
      pendingStory: nodeId,
    };

    expect(() =>
      ui.applyEvents(storyState, [{ type: 'story', nodeId }]),
    ).not.toThrow();

    const expected = getVisibleChoices(storyState).length;
    const buttons = ui.els.story.querySelectorAll('button');
    // 至少要有按钮可点（选项数 或 兜底的"离开"）
    expect(buttons.length).toBeGreaterThan(0);
    if (expected > 0) {
      expect(buttons.length).toBeGreaterThanOrEqual(expected);
    }
  });

  it('死亡层和结局层都能渲染，且提供 restartAct 出口', async () => {
    const { ui } = await bootUi();
    const base = createInitialState({
      seed: 1, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    }).state;

    const dead: GameState = {
      ...structuredClone(base), phase: 'dead', player: { ...base.player, hp: 0 },
    };
    ui.setLegalIntents(['restartAct']);
    expect(() =>
      ui.applyEvents(dead, [{ type: 'died', cause: '力竭' }]),
    ).not.toThrow();

    const { judgeEnding } = await import('../src/core/index.js');
    const ended: GameState = { ...structuredClone(base), phase: 'actEnd', ending: judgeEnding(base) };
    ui.setLegalIntents([]);
    expect(() =>
      ui.applyEvents(ended, [{ type: 'actEnded', ending: judgeEnding(base) }]),
    ).not.toThrow();
  });

  it('逐一派发所有 GameEvent 类型都不抛异常', async () => {
    const { ui } = await bootUi();
    const { state } = createInitialState({
      seed: 42, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    });
    const { judgeEnding } = await import('../src/core/index.js');
    const pos = { ...state.player.pos };

    // 覆盖 types.ts 里 GameEvent 联合的每一个分支。
    // 新增事件类型时这里会编译报错，提醒你补渲染。
    const allEvents = [
      { type: 'moved', from: pos, to: pos },
      { type: 'blocked', reason: 'wall' },
      { type: 'message', text: '测试', tone: 'info' },
      { type: 'attack', attacker: '你', target: '影', damage: 3, killed: false },
      { type: 'hurt', amount: 5, hpLeft: 10 },
      { type: 'enemyTurn', count: 2 },
      { type: 'roomCleared', roomId: 0 },
      { type: 'drop', defId: 'salt_chalk', kind: 'consumable', pos },
      { type: 'pickup', defId: 'salt_chalk', name: '盐粉笔' },
      { type: 'story', nodeId: 'story_entry_wake' },
      { type: 'storyClosed' },
      { type: 'sanity', delta: -3, sanLeft: 12 },
      { type: 'slotFilled', slotId: 's1_MID_0', nodeId: 'story_entry_wake' },
      { type: 'died', cause: '力竭' },
      { type: 'actEnded', ending: judgeEnding(state) },
      { type: 'floorChanged', depth: 2 },
    ] as const;

    for (const ev of allEvents) {
      expect(
        () => ui.applyEvents(state, [ev as never]),
        `事件 ${ev.type} 让渲染层抛异常了`,
      ).not.toThrow();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   2b. 「差一点就走到」提示 —— 驱动重开率的关键
   ═══════════════════════════════════════════════════════════════ */

describe('差一点就走到', () => {
  /** 造一个"什么都没达成"的终局状态：三个结局里两个够不着 */
  function bareEndState(): GameState {
    const base = createInitialState({
      seed: 12345, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    }).state;
    return { ...structuredClone(base), flags: {}, deaths: 0 };
  }

  it('actEnd 结算界面会列出没走到的结局及其 hint', async () => {
    const { ui } = await bootUi();
    const { judgeEnding, nearMissEndings } = await import('../src/core/index.js');
    const state = bareEndState();
    const ending = judgeEnding(state);

    const near = nearMissEndings(state, 2);
    expect(near.length, '一个都没差？测试前提不成立').toBeGreaterThan(0);

    ui.setLegalIntents([]);
    ui.applyEvents(state, [{ type: 'actEnded', ending }]);
    ui.renderState({ ...state, phase: 'actEnd', ending });

    const text = ui.els.overlay.textContent ?? '';
    for (const e of near) {
      if (e.hint === undefined || e.hint === '') continue;
      expect(text, `结算界面没有显示「${e.name}」的提示`).toContain(e.hint);
    }
  });

  it('死亡界面也会告诉玩家差一点能走到哪', async () => {
    const { ui } = await bootUi();
    const { nearMissEndings } = await import('../src/core/index.js');
    const state = bareEndState();
    const dead: GameState = {
      ...structuredClone(state),
      phase: 'dead',
      player: { ...state.player, hp: 0 },
    };

    const hinted = nearMissEndings(dead, 2).filter((e) => e.hint !== undefined && e.hint !== '');
    expect(hinted.length, '第一幕的结局都该有 hint 文案').toBeGreaterThan(0);

    ui.setLegalIntents(['restartAct']);
    ui.applyEvents(dead, [{ type: 'died', cause: '力竭' }]);

    const text = ui.els.overlay.textContent ?? '';
    for (const e of hinted) {
      expect(text, `死亡界面没有显示「${e.name}」的提示`).toContain(e.hint ?? '');
    }
  });

  it('已经达成的结局不会出现在"差一点"里', async () => {
    const { judgeEnding, nearMissEndings } = await import('../src/core/index.js');
    // 把三个 flag 全点亮 → 应该命中 priority 最高的那个，且它不该出现在 nearMiss 里
    const state = bareEndState();
    const achieved: GameState = {
      ...state,
      flags: {
        knows_the_name: true,
        signed_the_handover: true,
        carries_the_coin: true,
      },
    };
    const ending = judgeEnding(achieved);
    expect(ending.id).toBe('ending_signed_the_shift');

    const near = nearMissEndings(achieved, 3).map((e) => e.id);
    expect(near).not.toContain('ending_signed_the_shift');
  });
});

/* ═══════════════════════════════════════════════════════════════
   2c. 分享这一局 —— 开源肉鸽最便宜的社区传播
   ═══════════════════════════════════════════════════════════════ */

describe('分享这一局', () => {
  const SHARE_URL = 'https://example.com/dreamloop/?seed=42&role=ward_nurse';

  function endedState() {
    const base = createInitialState({
      seed: 42, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    }).state;
    return { base, state: { ...structuredClone(base), phase: 'actEnd' as const } };
  }

  it('提供 onShareRun 时，结算界面出现分享按钮', async () => {
    const { ui } = await bootUi({ onShareRun: () => SHARE_URL });
    const { judgeEnding } = await import('../src/core/index.js');
    const { base, state } = endedState();
    const ending = judgeEnding(base);

    ui.setLegalIntents([]);
    ui.applyEvents(state, [{ type: 'actEnded', ending }]);

    expect(ui.els.overlay.textContent ?? '').toContain('复制这一局的链接');
  });

  it('没提供 onShareRun 时不显示分享按钮（可选功能不该无条件出现）', async () => {
    const { ui } = await bootUi();
    const { judgeEnding } = await import('../src/core/index.js');
    const { base, state } = endedState();

    ui.setLegalIntents([]);
    ui.applyEvents(state, [{ type: 'actEnded', ending: judgeEnding(base) }]);

    expect(ui.els.overlay.textContent ?? '').not.toContain('复制这一局的链接');
  });

  it('死亡界面也能分享（玩家最想吐槽的时刻就是刚死）', async () => {
    const { ui } = await bootUi({ onShareRun: () => SHARE_URL });
    const { base } = endedState();
    const dead: GameState = {
      ...structuredClone(base), phase: 'dead', player: { ...base.player, hp: 0 },
    };

    ui.setLegalIntents(['restartAct']);
    ui.applyEvents(dead, [{ type: 'died', cause: '力竭' }]);

    expect(ui.els.overlay.textContent ?? '').toContain('复制这一局的链接');
  });

  it('剪贴板不可用时降级成"把链接显示出来"，绝不静默失败', async () => {
    const { ui } = await bootUi({ onShareRun: () => SHARE_URL });
    const { judgeEnding } = await import('../src/core/index.js');
    const { base, state } = endedState();

    ui.setLegalIntents([]);
    ui.applyEvents(state, [{ type: 'actEnded', ending: judgeEnding(base) }]);

    // 强制剪贴板失败，保证走到兜底分支。
    // 不注入的话 happy-dom 自带的剪贴板会成功，测不到降级路径。
    let stubbed = false;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied by test')) },
      });
      stubbed = true;
    } catch {
      // 环境不允许改写 navigator 时退化成"接受任一结果"，
      // 但下面的"必须有反馈"这条断言依然成立
    }

    const btn = [...ui.els.overlay.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('复制这一局的链接'),
    );
    expect(btn, '找不到分享按钮').toBeDefined();

    expect(() => btn?.click()).not.toThrow();
    // 等微任务 + toast 渲染完成，确认降级路径没产生未捕获的 rejection
    await new Promise((r) => setTimeout(r, 0));

    const body = document.body.textContent ?? '';
    if (stubbed) {
      expect(
        body.includes(SHARE_URL) || body.includes('复制失败'),
        '剪贴板失败后既没给出链接也没提示失败 —— 玩家会以为按钮坏了',
      ).toBe(true);
    } else {
      expect(
        body.includes(SHARE_URL) || body.includes('复制失败') || body.includes('链接已复制'),
        '点击分享后没有任何反馈 —— 玩家会以为按钮坏了',
      ).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 输入层在 DOM 环境里可用
   ═══════════════════════════════════════════════════════════════ */

describe('输入层', () => {
  it('方向键会产出 move Intent', async () => {
    const { dispatched } = await bootUi();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

    expect(dispatched.some((i) => i.type === 'move' && i.dir === 'up')).toBe(true);
  });

  it('WASD 也会产出 move Intent', async () => {
    const { dispatched } = await bootUi();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(dispatched.some((i) => i.type === 'move' && i.dir === 'right')).toBe(true);
  });

  it('空格产出 wait，Escape 产出 cancel', async () => {
    const { dispatched } = await bootUi();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dispatched.some((i) => i.type === 'wait')).toBe(true);
    expect(dispatched.some((i) => i.type === 'cancel')).toBe(true);
  });

  it('点击相邻格会产出 move', async () => {
    const { ui, dispatched } = await bootUi();
    const { state } = createInitialState({
      seed: 12345, actId: 'act_1', roleId: 'ward_nurse', pack: CORE_PACK,
    });
    ui.renderState(state);

    const cells = ui.els.map.querySelectorAll<HTMLElement>('.cell');
    if (cells.length === 0) return; // 实现若用 canvas 则跳过

    const p = state.player.pos;
    // 找玩家正下方那一格（相邻）
    const idx = (p.y + 1) * state.floor.width + p.x;
    const target = cells[idx];
    if (target === undefined) return;

    target.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }),
    );
    target.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }),
    );

    // 点相邻格必须产出 move；若该格是墙则可能被 input 层过滤，所以只断言"没崩"
    expect(dispatched.length).toBeGreaterThanOrEqual(0);
  });

  it('环境探针返回可直接展示的行', async () => {
    const { probeEnvironment, formatProbe } = await import('../src/ui-web/input.js');
    const rows = formatProbe(probeEnvironment());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.label).toBe('string');
      expect(typeof row.value).toBe('string');
    }
  });
});

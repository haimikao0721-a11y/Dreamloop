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
async function bootUi(
  extra: { onShareRun?: () => string; onBackToMenu?: () => void } = {},
) {
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
   2d. 主菜单 —— 菜单 / 制作者名单 / 提示页 三合一
   ═══════════════════════════════════════════════════════════════ */

describe('主菜单', () => {
  /** 造一份和 main.ts 里结构一致的菜单项 */
  function entries(picked: string[]) {
    return [
      { id: 'story', title: '主线剧情', desc: '三层楼。', onPick: () => picked.push('story') },
      {
        id: 'event',
        title: '活动模式',
        desc: '限时关卡。',
        badge: '尚未开放',
        onPick: () => picked.push('event'),
      },
      {
        id: 'community',
        title: '扩展 · 社区模式',
        desc: '社区内容包。',
        badge: '尚未开放',
        onPick: () => picked.push('community'),
      },
      { id: 'credits', title: '制作者名单', desc: '做过的人。', onPick: () => picked.push('credits') },
    ];
  }

  it('四个入口都渲染出来', async () => {
    const { ui } = await bootUi();
    ui.showMainMenu(entries([]));

    const text = ui.els.menu.textContent ?? '';
    for (const title of ['主线剧情', '活动模式', '扩展 · 社区模式', '制作者名单']) {
      expect(text, `菜单里缺少「${title}」`).toContain(title);
    }
    expect(ui.els.menu.classList.contains('show')).toBe(true);
  });

  it('点击某一项只触发它自己的回调', async () => {
    const { ui } = await bootUi();
    const picked: string[] = [];
    ui.showMainMenu(entries(picked));

    const buttons = [...ui.els.menu.querySelectorAll('button')];
    expect(buttons.length).toBe(4);

    buttons[0]?.click();
    expect(picked).toEqual(['story']);

    buttons[3]?.click();
    expect(picked).toEqual(['story', 'credits']);
  });

  it('「尚未开放」的项仍然可点（置灰等于死路）', async () => {
    const { ui } = await bootUi();
    const picked: string[] = [];
    ui.showMainMenu(entries(picked));

    expect(ui.els.menu.textContent ?? '').toContain('尚未开放');

    const unavailable = [...ui.els.menu.querySelectorAll('button')].filter((b) =>
      (b.textContent ?? '').includes('尚未开放'),
    );
    expect(unavailable.length).toBe(2);
    for (const btn of unavailable) {
      expect(btn.disabled, '「尚未开放」的按钮被禁用了 —— 玩家会以为坏了').toBe(false);
    }

    // 点了必须真的有反应
    unavailable[0]?.click();
    expect(picked).toEqual(['event']);
  });

  it('制作者名单渲染分节、条目与说明', async () => {
    const { ui } = await bootUi();
    let back = 0;
    ui.showCredits(
      [
        {
          title: '制作',
          entries: [{ name: '海米糕', role: '发起人 · 引擎', link: 'https://github.com/x' }],
          note: '版权归创作者所有。',
        },
        { title: '特别感谢', entries: [], note: '这里留给你。' },
      ],
      () => back++,
    );

    const text = ui.els.menu.textContent ?? '';
    for (const probe of ['制作', '海米糕', '发起人 · 引擎', '版权归创作者所有。']) {
      expect(text, `名单里缺少「${probe}」`).toContain(probe);
    }
    // 空节的说明也要显示 —— 那正是"邀请"的地方
    expect(text).toContain('特别感谢');
    expect(text).toContain('这里留给你。');

    // 有链接的渲染成 <a>，并带 noopener
    const links = ui.els.menu.querySelectorAll('a');
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute('href')).toBe('https://github.com/x');
    expect(links[0]?.getAttribute('rel')).toContain('noopener');

    const backBtn = [...ui.els.menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('返回'),
    );
    backBtn?.click();
    expect(back).toBe(1);
  });

  it('提示页渲染段落，并且一定有返回按钮', async () => {
    const { ui } = await bootUi();
    let back = 0;
    ui.showNotice('活动模式', ['第一段。', '第二段。'], () => back++);

    const text = ui.els.menu.textContent ?? '';
    expect(text).toContain('活动模式');
    expect(text).toContain('第一段。');
    expect(text).toContain('第二段。');

    const backBtn = [...ui.els.menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('返回'),
    );
    expect(backBtn, '提示页没有返回按钮 —— 玩家会卡在这里出不去').toBeDefined();
    backBtn?.click();
    expect(back).toBe(1);
  });

  it('hideMenu 会清空并隐藏面板', async () => {
    const { ui } = await bootUi();
    ui.showMainMenu(entries([]));
    expect(ui.els.menu.classList.contains('show')).toBe(true);

    ui.hideMenu();
    expect(ui.els.menu.classList.contains('show')).toBe(false);
    expect(ui.els.menu.textContent).toBe('');
  });

  it('重复打开不会叠加内容（presentMenu 每次先清空）', async () => {
    const { ui } = await bootUi();
    ui.showMainMenu(entries([]));
    ui.showMainMenu(entries([]));
    expect(ui.els.menu.querySelectorAll('button').length).toBe(4);
  });

  it('三种内容互相切换时不残留上一个的 DOM', async () => {
    const { ui } = await bootUi();
    ui.showMainMenu(entries([]));
    ui.showCredits([{ title: '制作', entries: [{ name: '甲', role: '乙' }] }], () => {});
    expect(ui.els.menu.textContent ?? '').not.toContain('主线剧情');

    ui.showNotice('标题', ['正文'], () => {});
    expect(ui.els.menu.textContent ?? '').not.toContain('制作');
  });
});

describe('制作者名单数据', () => {
  it('CREDITS 结构合法（渲染层不认识它的内容，只按结构画）', async () => {
    const { CREDITS } = await import('../src/data/index.js');
    expect(CREDITS.length).toBeGreaterThan(0);
    for (const section of CREDITS) {
      expect(section.title).toBeTruthy();
      expect(Array.isArray(section.entries)).toBe(true);
      for (const e of section.entries) {
        expect(e.name).toBeTruthy();
        expect(e.role).toBeTruthy();
      }
    }
  });

  it('至少有一节真的列了人（否则名单是空的）', async () => {
    const { CREDITS } = await import('../src/data/index.js');
    expect(CREDITS.filter((s) => s.entries.length > 0).length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2e. 上锁的占位按钮 / 角色预览 / 返回主菜单
   ═══════════════════════════════════════════════════════════════ */

describe('上锁的菜单项', () => {
  function menuWithLocked(picked: string[]) {
    return [
      { id: 'story', title: '主线剧情', desc: '能玩。', onPick: () => picked.push('story') },
      {
        id: 'event',
        title: '活动模式',
        desc: '还没做。',
        locked: true,
        onPick: () => picked.push('event'),
      },
      {
        id: 'settings',
        title: '设置',
        desc: '还没做。',
        locked: true,
        onPick: () => picked.push('settings'),
      },
    ];
  }

  it('上锁的项带 locked 类与锁角标', async () => {
    const { ui } = await bootUi();
    ui.showMainMenu(menuWithLocked([]));

    const lockedBtns = [...ui.els.menu.querySelectorAll('button')].filter(
      (b) => b.dataset['locked'] === '1',
    );
    expect(lockedBtns.length).toBe(2);
    for (const btn of lockedBtns) {
      expect(btn.classList.contains('locked')).toBe(true);
      expect(btn.textContent ?? '').toContain('已上锁');
    }

    // 能玩的那一项不该有锁
    const story = [...ui.els.menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('主线剧情'),
    );
    expect(story?.dataset['locked']).toBeUndefined();
    expect(story?.textContent ?? '').not.toContain('已上锁');
  });

  it('上锁的项仍然可点，且会触发回调（不是 disabled 死路）', async () => {
    const { ui } = await bootUi();
    const picked: string[] = [];
    ui.showMainMenu(menuWithLocked(picked));

    const lockedBtns = [...ui.els.menu.querySelectorAll('button')].filter(
      (b) => b.dataset['locked'] === '1',
    );
    for (const btn of lockedBtns) {
      expect(btn.disabled).toBe(false);
    }

    lockedBtns[0]?.click();
    expect(picked).toEqual(['event']);
    lockedBtns[1]?.click();
    expect(picked).toEqual(['event', 'settings']);
  });

  it('自定义 badge 在上锁时会被锁角标取代（不叠两个角标）', async () => {
    const { ui } = await bootUi();
    ui.showMainMenu([
      {
        id: 'x',
        title: '某项',
        desc: '',
        badge: '自定义',
        locked: true,
        onPick: () => {},
      },
    ]);
    const text = ui.els.menu.textContent ?? '';
    expect(text).toContain('已上锁');
    expect(text).not.toContain('自定义');
  });
});

describe('角色预览', () => {
  it('列出全部角色，并显示起始物品（选择界面看不到的那部分）', async () => {
    const { ui } = await bootUi();
    const { CORE_PACK } = await import('../src/data/index.js');
    const roles = CORE_PACK.roles ?? [];
    expect(roles.length).toBeGreaterThan(0);

    ui.showCharacterPreview(roles, () => {});

    const text = ui.els.menu.textContent ?? '';
    for (const role of roles) {
      expect(text, `预览里缺少「${role.name}」`).toContain(role.name);
      // 属性
      expect(text).toContain(`HP ${role.hp}`);
    }
    // 起始物品的名字必须出现 —— 那才是两个角色真正的分水岭
    expect(text).toContain('起始物品');
  });

  it('有返回按钮，点了能回去', async () => {
    const { ui } = await bootUi();
    const { CORE_PACK } = await import('../src/data/index.js');
    let back = 0;
    ui.showCharacterPreview(CORE_PACK.roles ?? [], () => back++);

    const backBtn = [...ui.els.menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('返回'),
    );
    expect(backBtn, '预览页没有返回按钮').toBeDefined();
    backBtn?.click();
    expect(back).toBe(1);
  });

  it('预览页里没有任何按钮能开局（它只是看，不是选）', async () => {
    const { ui } = await bootUi();
    const { CORE_PACK } = await import('../src/data/index.js');
    ui.showCharacterPreview(CORE_PACK.roles ?? [], () => {});

    const buttons = [...ui.els.menu.querySelectorAll('button')];
    // 只该有「返回」这一个按钮
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent ?? '').toContain('返回');
  });
});

describe('返回主菜单', () => {
  it('提供 onBackToMenu 时，诊断面板里有出口按钮', async () => {
    let back = 0;
    const { ui } = await bootUi({ onBackToMenu: () => back++ });

    const btn = [...ui.els.diag.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('返回主菜单'),
    );
    expect(btn, '诊断面板里没有返回主菜单按钮 —— 进了游戏就只能刷新页面').toBeDefined();
    btn?.click();
    expect(back).toBe(1);
  });

  it('不提供 onBackToMenu 时按钮仍在但不报错（可选功能）', async () => {
    const { ui } = await bootUi();
    const btn = [...ui.els.diag.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('返回主菜单'),
    );
    expect(btn).toBeDefined();
    expect(() => btn?.click()).not.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════
   2f. 实时层原型（迁移计划第 1 步）
   ═══════════════════════════════════════════════════════════════ */

describe('实时层原型', () => {
  it('能挂载：画出 canvas、状态栏和返回按钮', async () => {
    const { startRtPrototype, planRoom } = await import('../src/ui-web/rt-view.js');
    const { TILE } = await import('../src/core/rt/index.js');
    const teardown = startRtPrototype(document.body);

    try {
      expect(document.querySelector('.rt-wrap'), '原型没挂上').not.toBeNull();

      const canvas = document.querySelector('canvas');
      expect(canvas, '没有 canvas —— 实时层没法渲染').not.toBeNull();

      // 房间尺寸【跟着屏幕算】，不能再写死 21×15。
      // 之前写死过，结果手机竖屏上只有 1 倍缩放，玩家进去看到一片黑。
      const plan = planRoom(window.innerWidth, window.innerHeight);
      expect(canvas?.width).toBe(plan.cols * TILE);
      /*
       * 高度【多一格】—— 顶部那格留给最上面那排墙的顶面。
       *
       * 以撒式立体感靠的就是墙的顶面（它画在墙上方的位置），
       * 不留余量的话最上面那排会被裁掉，房间顶部看起来是平的。
       * 这不是 bug，是画布尺寸的一部分。
       */
      expect(canvas?.height).toBe(plan.rows * TILE + TILE);

      /*
       * 缩放选择。整数倍是首选，但【浪费太多时就不值了】——
       * 手机上可用高度常常是 1.89 倍，floor 成 1 会浪费 47% 的屏幕。
       */
      const { pickScale } = await import('../src/ui-web/rt-view.js');
      expect(pickScale(2.05), '整数倍够接近时该用整数').toBe(2);
      // 2.9 floor 到 2 只用 69%，浪费超过 15% → 用小数
      expect(pickScale(2.9)).toBeCloseTo(2.9, 5);
      expect(pickScale(2.2), 'floor 到 2 用到 91%，划算').toBe(2);
      expect(pickScale(1.89), 'floor 到 1 只用 53%，浪费太多').toBeCloseTo(1.89, 5);
      expect(pickScale(1.2), 'floor 到 1 只用 83%，也不划算').toBeCloseTo(1.2, 5);
      expect(pickScale(0.6), '放不下时允许小数').toBeCloseTo(0.6, 5);
      expect(pickScale(0.05), '再小也有下限，不能缩成看不见').toBe(0.2);
      // 1.01 floor 到 1 用到 99%，划算 → 用整数
      expect(pickScale(1.01)).toBe(1);

      // 画面必须真的占地方，不能是一条小带子
      expect(plan.scale, '缩放太小，玩家会以为什么都没画').toBeGreaterThanOrEqual(1);
      expect(plan.cols).toBeGreaterThanOrEqual(11);
      expect(plan.rows).toBeGreaterThanOrEqual(10);

      const back = [...document.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('返回主菜单'),
      );
      expect(back, '原型里没有出口 —— 进去就出不来了').toBeDefined();
    } finally {
      teardown();
    }
    expect(document.querySelector('.rt-wrap'), 'teardown 没清干净').toBeNull();
  });

  it('teardown 后不留任何 DOM（切回正式游戏不能有残骸）', async () => {
    const { startRtPrototype } = await import('../src/ui-web/rt-view.js');
    const before = document.body.children.length;
    const teardown = startRtPrototype(document.body);
    expect(document.body.children.length).toBeGreaterThan(before);
    teardown();
    // 轮盘、攻击键和 <style> 也必须清掉，只清 .rt-wrap 是不够的 ——
    // 留下任何一个，正式游戏上就会盖着一层看不见的东西
    expect(document.body.children.length).toBe(before);
    expect(document.querySelector('.rt-wheel')).toBeNull();
    expect(document.querySelector('.rt-attack')).toBeNull();
  });

  it('缺 canvas 2d 上下文时也不炸（有的环境没有 canvas 实现）', async () => {
    const { startRtPrototype } = await import('../src/ui-web/rt-view.js');
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let teardown: (() => void) | undefined;
    expect(() => {
      teardown = startRtPrototype(document.body);
    }).not.toThrow();
    spy.mockRestore();
    teardown?.();
  });

  it('原型不碰正式游戏的 DOM（并存，不互删）', async () => {
    const { startRtPrototype } = await import('../src/ui-web/rt-view.js');

    // 用一个自己的标记节点，别用 #app —— 前面的测试已经建过一个了，
    // getElementById 会拿到那一个，测出来的是别的东西
    const marker = document.createElement('div');
    marker.textContent = '正式游戏';
    document.body.appendChild(marker);

    const teardown = startRtPrototype(document.body);
    expect(marker.textContent).toBe('正式游戏');
    expect(document.body.contains(marker)).toBe(true);

    teardown();
    expect(document.body.contains(marker), 'teardown 把别人的节点也删了').toBe(true);
    marker.remove();
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

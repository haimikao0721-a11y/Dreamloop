/**
 * ════════════════════════════════════════════════════════════════
 *  ui-web/render.ts —— 渲染层
 * ════════════════════════════════════════════════════════════════
 *
 *  职责边界（很重要，别越界）：
 *
 *   · 它只做两件事：
 *       ① 把 GameState 同步成 DOM（状态栏 / 地图 / 回合数）
 *       ② 把 GameEvent[] 翻译成 DOM 变化（提示、动画、全屏层开关）
 *
 *   · 它【不算规则】：伤害、掉落、结局、合法性全部以 core 给的
 *     state 和 events 为准。UI 里出现的文字只有两类：
 *       一种是按钮/提示之类的界面文案（都收在 UI_TEXT 里，方便统一改），
 *       另一种是直接来自事件的数字/名字（伤害值、物品名、结局正文）。
 *
 *   · 它【不改状态】：要改变状态只能通过 opts.onIntent() 发 Intent。
 *
 *  两条工程上的取舍，值得记一笔：
 *
 *   1. 全屏层（剧情/死亡/结局）的开关同时由"事件"和"phase"驱动。
 *      事件负责瞬时反应，phase 负责兜底纠偏 —— 万一 core 少发一个事件，
 *      界面不会卡在错误的层上。
 *
 *   2. 动画元素不挂在格子上，而是挂到独立的 .fx-layer。
 *      因为地图每次同步都会重写 cell.className，挂在格子上的动画类会被冲掉。
 *
 *  3. 所有正文一律用 textContent 写入，不用 innerHTML。
 *      内容包将来是社区可改的数据，把它当不可信输入处理，顺手免疫 XSS。
 * ════════════════════════════════════════════════════════════════
 */

import type {
  Actor,
  Direction,
  GameEvent,
  GameState,
  Intent,
  ItemInstance,
  MessageTone,
  Pos,
  RoleDef,
  Room,
  StoryChoice,
} from '@core/types';
// 渲染层要向 core 借三样东西：剧情节点、可见选项、物品定义。
// 这三件事都是"规则"，UI 一律不自己算 —— 自己算的版本迟早和 core 漂移。
import { findItem, findStory, getVisibleChoices, nearMissEndings } from '@core/index';
import type { ResolvedInputMode } from './input';
import { vibrate } from './input';

/* ─────────────────────────── 界面文案 ─────────────────────────── */

/** 界面上所有"不是来自内容包"的文字都收在这里，改文案不用翻代码。 */
export const UI_TEXT = {
  roleTitle: '梦境循环',
  roleHint: '选一个角色开始。同一层楼，不同的眼睛会看见不同的东西。',
  rolePick: '开始',

  menuBadgeSoon: '尚未开放',
  menuBack: '返回',
  menuHint: '三点十七分。钟没有走过去。',
  creditsTitle: '制作者名单',
  creditsBack: '返回主菜单',

  blockedWall: '那边是墙。',
  blockedActor: '有人挡着路。',
  tooFar: '太远了，只能走到相邻的格子。',
  ignored: '现在不能这么做。',
  roomCleared: '房间里安静下来了。',
  dropAppeared: (name: string): string => `地上多了一件东西：${name}`,
  pickup: (name: string): string => `你拾起了「${name}」。`,
  floorReached: (depth: number): string => `第 ${depth} 层 ▾`,

  deathBadge: '死亡',
  deathTitle: '你死了',
  deathUnknownCause: '你没撑住。',
  deathCount: (deaths: number): string => `这已经是第 ${deaths} 次。`,
  restartAct: '重开本幕',
  newRun: '重开一局',
  newRunConfirm: '重开一局会放弃当前进度，确定吗？',

  endBadge: '结局',
  winBadge: '通关',
  endFallbackTitle: '本幕结束',
  endFallbackText: '梦到这里就断了。',
  nearMissTitle: (n: number): string => `你还有 ${n} 条路没有走到：`,
  nearMissItem: (name: string, hint: string): string => `「${name}」—— ${hint}`,

  shareRun: '复制这一局的链接',
  shareCopied: '链接已复制 —— 发给别人，他点开会进同一局',
  shareManual: (url: string): string => `复制失败，手动复制：${url}`,

  fatalTitle: '启动失败',
  storyMissing: (nodeId: string): string => `（内容包里找不到剧情节点「${nodeId}」）`,
  leaveStory: '离开',

  interact: '互动',
  descend: '下楼',
  diag: '诊断',
  restart: '重开',
  choicesHint: '↑ ↓ 选择 · Enter 确认 · 数字键直选',
} as const;

/* ─────────────────────────── 对外类型 ─────────────────────────── */

/** 诊断面板的一行。与 input.ts 的 ProbeRow 结构相同 —— 故意不互相 import。 */
export interface DiagnosticsRow {
  readonly label: string;
  readonly value: string;
  readonly ok?: boolean;
}

/** 剧情节点与可见选项都由 core 提供，UI 只负责排版 */
export interface UiElements {
  readonly root: HTMLElement;
  readonly status: HTMLElement;
  readonly stage: HTMLElement;
  readonly map: HTMLElement;
  readonly fx: HTMLElement;
  readonly toasts: HTMLElement;
  readonly inventory: HTMLElement;
  readonly log: HTMLElement;
  readonly controls: HTMLElement;
  readonly dpad: HTMLElement;
  readonly actions: HTMLElement;
  readonly story: HTMLElement;
  readonly overlay: HTMLElement;
  readonly roleSelect: HTMLElement;
  readonly menu: HTMLElement;
  readonly diag: HTMLElement;
}

/**
 * 主菜单的一项。
 *
 * 菜单结构由调用方（main.ts）给，渲染层不认识"主线""活动"这些概念 ——
 * 加一个模式只需要多一项数据，不用改 UI。
 */
export interface MenuEntry {
  readonly id: string;
  readonly title: string;
  readonly desc: string;
  /** 有值时在标题旁显示角标（例如「尚未开放」） */
  readonly badge?: string;
  /** 灰掉但仍可点 —— 点了由调用方决定怎么解释 */
  readonly dimmed?: boolean;
  readonly onPick: () => void;
}

/** 制作者名单的条目，与 data/credits.ts 的结构一致 */
export interface CreditEntryView {
  readonly name: string;
  readonly role: string;
  readonly link?: string;
}
export interface CreditSectionView {
  readonly title: string;
  readonly entries: readonly CreditEntryView[];
  readonly note?: string;
}

export interface RenderOptions {
  /** index.html 里的 #app */
  readonly root: HTMLElement;
  /** 渲染层产出 Intent 的唯一出口 */
  readonly onIntent: (intent: Intent) => void;
  /** 「重开一局」（放弃当前局，用新种子重新 createInitialState），不提供时不显示该按钮 */
  readonly onNewRun?: () => void;
  /**
   * 「复制这一局的链接」，返回一个带 seed 和 role 的 URL。
   * 不提供时不显示该按钮。
   *
   * 这是最便宜的一种社区传播：肉鸽玩家本来就爱分享种子，
   * 而"点开就进同一局"把分享成本降到了零 —— 不用先选角色。
   */
  readonly onShareRun?: () => string;
  /** 诊断面板里的模式下拉框 */
  readonly onInputModeChange?: (mode: string) => void;
  /**
   * 视野半径（切比雪夫距离）：只有这个范围内的敌人/物品才画出来。
   * 这是【表现】不是规则 —— 改它不影响任何判定，只是让地图别一览无余。
   */
  readonly entityVisionRadius?: number;
}

export interface UiHandle {
  readonly els: UiElements;
  /** 角色选择全屏层 */
  showRoleSelect(roles: readonly RoleDef[], onPick: (roleId: string) => void): void;
  hideRoleSelect(): void;
  /** 主菜单层 */
  showMainMenu(entries: readonly MenuEntry[]): void;
  showCredits(sections: readonly CreditSectionView[], onBack: () => void): void;
  /** 通用提示页（「尚未开放」这类解释用），带一个返回按钮 */
  showNotice(title: string, paragraphs: readonly string[], onBack: () => void): void;
  hideMenu(): void;
  /** 清空日志并按 state.logLine 重建（启动 / 重开一局时用） */
  resetLog(state: GameState): void;
  /** 事件驱动的渲染：动画 + 全屏层 + 全量状态同步 */
  applyEvents(state: GameState, events: readonly GameEvent[]): void;
  /** 只做状态同步（不含事件动效） */
  renderState(state: GameState): void;
  /** core 的 legalIntents() 结果：用于置灰按钮、压暗方向区 */
  setLegalIntents(types: readonly Intent['type'][]): void;
  setInputMode(resolved: ResolvedInputMode, locked: boolean): void;
  setProbeRows(rows: readonly DiagnosticsRow[]): void;
  setLastInputEvent(label: string): void;
  /** 顶部气泡提示（被忽略的操作 / 想给玩家看一眼的短句） */
  notify(text: string, tone?: MessageTone): void;
  noteDebug(text: string): void;
  /** 启动阶段的致命错误（内容包缺 act / 缺角色 / core 抛异常） */
  showFatal(message: string): void;
  toggleDiagnostics(): void;
  destroy(): void;
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== undefined && className !== '') el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 正文按 \n 分段。空行只当段间距，不再单独生成节点 */
function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line !== '') out.push(line);
  }
  return out;
}

const TONE_CLASS: Readonly<Record<MessageTone, string>> = {
  info: 'tone-info',
  danger: 'tone-danger',
  lore: 'tone-lore',
  gain: 'tone-gain',
  ambient: 'tone-ambient',
};

const MAX_LOG_LINES = 60;
/** core 只发事件、没写进 logLine 的补充行，UI 这边也要有个上限 */
const MAX_EXTRA_LOG_LINES = 24;
const MAX_TOASTS = 4;
/** 格子上限：再大就不是"地图"而是"需要缩放的地图"了 */
const MAX_CELL_PX = 44;
const MIN_CELL_PX = 6;
const GRID_GAP_PX = 2;
const STAGE_PADDING_PX = 8;

const DPAD_BUTTONS: readonly { readonly dir: Direction; readonly glyph: string; readonly label: string }[] =
  [
    { dir: 'up', glyph: '↑', label: '上' },
    { dir: 'left', glyph: '←', label: '左' },
    { dir: 'right', glyph: '→', label: '右' },
    { dir: 'down', glyph: '↓', label: '下' },
  ];

/* ─────────────────────────── 主体 ─────────────────────────── */

export function createUi(opts: RenderOptions): UiHandle {
  const visionRadius = opts.entityVisionRadius ?? 1;

  // 物品名/字形一律问 core 的 findItem（它会跨所有已加载的内容包找，mod 物品也认得）
  const itemGlyph = (defId: string): string => findItem(defId)?.glyph ?? '?';
  const itemName = (defId: string): string => findItem(defId)?.name ?? defId;

  /* ══════════════ DOM 骨架：一套组件，靠 CSS 媒体查询换布局 ══════════════ */

  const root = opts.root;
  root.textContent = '';

  /* ── 状态栏 ── */
  const hpFill = h('div', 'bar-fill hp');
  const hpText = h('span', 'bar-text', '—');
  const sanFill = h('div', 'bar-fill san');
  const sanText = h('span', 'bar-text', '—');
  const metaRole = h('span', 'meta-value', '—');
  const metaDepth = h('span', 'meta-value', '—');
  const metaTurn = h('span', 'meta-value', '—');
  const modeLabel = h('strong', 'mode-label', '—');

  const bar = (label: string, fill: HTMLElement, text: HTMLElement): HTMLElement => {
    const wrap = h('div', 'bar');
    wrap.appendChild(h('span', 'bar-label', label));
    const track = h('div', 'bar-track');
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.appendChild(text);
    return wrap;
  };
  const meta = (label: string, value: HTMLElement, pushEnd = false): HTMLElement => {
    const wrap = h('div', `bar${pushEnd ? ' push-end' : ''}`);
    wrap.appendChild(h('span', 'bar-label', label));
    wrap.appendChild(value);
    return wrap;
  };

  const status = h('header', 'status');
  status.id = 'status';
  status.append(
    bar('HP', hpFill, hpText),
    bar('理智', sanFill, sanText),
    meta('角色', metaRole),
    meta('层', metaDepth),
    meta('回合', metaTurn),
    meta('输入', modeLabel, true),
  );

  /* ── 地图 + 特效层 + 提示气泡 ── */
  const map = h('div', 'map');
  map.id = 'map';
  const fxLayer = h('div', 'fx-layer');
  const toasts = h('div', 'toast-layer');
  const stage = h('main', 'stage');
  stage.id = 'stage';
  stage.append(map, fxLayer, toasts);

  /* ── 背包 ── */
  // 空的时候靠 CSS 的 :empty 直接隐藏，不占一行高度
  const inventory = h('div', 'inventory');
  inventory.id = 'inventory';

  /* ── 日志 ── */
  const logEl = h('section', 'log');
  logEl.id = 'log';
  logEl.setAttribute('role', 'log');
  logEl.setAttribute('aria-live', 'polite');

  /* ── 控制区 ── */
  const dpad = h('div', 'dpad');
  dpad.id = 'dpad';
  for (const def of DPAD_BUTTONS) {
    const btn = h('button', 'dpad-btn', def.glyph);
    btn.type = 'button';
    btn.dataset.dir = def.dir;
    btn.setAttribute('aria-label', def.label);
    dpad.appendChild(btn);
  }
  const waitBtn = h('button', 'dpad-btn wait', '等待');
  waitBtn.type = 'button';
  waitBtn.dataset.intent = 'wait';
  waitBtn.setAttribute('aria-label', '原地等待一回合');
  // 中间的"等待"要插在左右键之间，靠 CSS 的 grid-area 定位，顺序无所谓
  dpad.appendChild(waitBtn);

  const actions = h('div', 'actions');
  const makeAction = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const btn = h('button', 'act-btn', text);
    btn.type = 'button';
    btn.title = title;
    btn.addEventListener('click', onClick);
    actions.appendChild(btn);
    return btn;
  };
  const btnInteract = makeAction(UI_TEXT.interact, 'interact 键 E', () =>
    opts.onIntent({ type: 'interact' }),
  );
  const btnDescend = makeAction(UI_TEXT.descend, 'descend 键 >', () =>
    opts.onIntent({ type: 'descend' }),
  );
  const btnDiag = makeAction(UI_TEXT.diag, '输入诊断面板', () => {
    toggleDiagnostics();
  });
  const btnRestart = makeAction(UI_TEXT.restart, '用新种子重开一局', () => {
    const onNewRun = opts.onNewRun;
    if (onNewRun === undefined) return;
    if (window.confirm(UI_TEXT.newRunConfirm)) onNewRun();
  });
  btnRestart.disabled = opts.onNewRun === undefined;
  if (opts.onNewRun === undefined) btnRestart.style.display = 'none';

  const controls = h('footer', 'controls');
  controls.id = 'controls';
  controls.append(dpad, actions);

  /* ── 全屏剧情层 ── */
  const story = h('section', 'story');
  story.id = 'story';
  story.setAttribute('role', 'dialog');
  story.setAttribute('aria-modal', 'true');
  const storyText = h('div', 'story-text');
  storyText.id = 'story-text';
  const storyChoices = h('div', 'story-choices');
  storyChoices.id = 'story-choices';
  const storyInner = h('div', 'story-inner');
  storyInner.append(storyText, storyChoices);
  story.appendChild(storyInner);

  /* ── 死亡 / 结局层 ── */
  const overlay = h('section', 'overlay');
  overlay.id = 'overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  /* ── 角色选择层 ── */
  const roleSelect = h('section', 'role-select');
  roleSelect.id = 'role-select';
  roleSelect.setAttribute('role', 'dialog');
  roleSelect.setAttribute('aria-modal', 'true');

  /**
   * 主菜单层。
   *
   * 一个面板承载三种内容（主菜单 / 制作者名单 / 提示页），
   * 而不是做三个独立的全屏层 —— 它们互斥、样式一致、
   * 拆开只会多三份 show/hide 逻辑和三份 CSS。
   */
  const menu = h('section', 'menu');
  menu.id = 'menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'true');

  /* ── 诊断面板 ── */
  const diag = h('aside', 'diag');
  diag.id = 'diag';
  const diagProbe = h('div', 'probe');
  const diagSelect = h('select');
  for (const [value, label] of [
    ['auto', '自动检测'],
    ['touch', '强制触摸'],
    ['keyboard', '强制键盘'],
    ['gamepad', '强制手柄'],
  ] as const) {
    const option = h('option', undefined, label);
    option.value = value;
    diagSelect.appendChild(option);
  }
  diagSelect.addEventListener('change', () => opts.onInputModeChange?.(diagSelect.value));
  const diagLast = h('span', 'v', '—');
  const diagState = h('div', 'state');
  const diagDebug = h('div', 'debug');
  const diagSection = (title: string): HTMLElement => {
    const wrap = h('div');
    wrap.appendChild(h('h3', undefined, title));
    return wrap;
  };
  const probeSection = diagSection('环境探针');
  probeSection.appendChild(diagProbe);
  const modeSection = diagSection('输入模式（手动覆盖）');
  modeSection.appendChild(diagSelect);
  const stateSection = diagSection('运行状态');
  stateSection.appendChild(diagState);
  const lastSection = h('div', 'row');
  lastSection.append(h('span', 'k', '最后事件'), diagLast);
  const debugSection = diagSection('调试');
  debugSection.appendChild(diagDebug);
  diag.append(probeSection, h('hr'), modeSection, h('hr'), stateSection, lastSection, h('hr'), debugSection);

  /* ── 受伤泛光 ── */
  const vignette = h('div', 'vignette');

  root.append(status, stage, inventory, logEl, controls, story, overlay, roleSelect, menu, diag, vignette);

  const els: UiElements = {
    root,
    status,
    stage,
    map,
    fx: fxLayer,
    toasts,
    inventory,
    log: logEl,
    controls,
    dpad,
    actions,
    story,
    overlay,
    roleSelect,
    menu,
    diag,
  };

  /* ══════════════ 内部状态 ══════════════ */

  const timers = new Set<number>();
  let cols = -1;
  let rows = -1;
  let cells: HTMLElement[] = [];
  /**
   * core 只发了 message 事件、却没写进 state.logLine 的那几行（例如 buff 的"攻击 +2"）。
   * 它必须自己存着：日志每次都是按 logLine 重建的，只算当帧的话下一帧就没了。
   */
  const extraLog: { text: string; tone: MessageTone }[] = [];
  let openStoryNode: string | null = null;
  let overlaySig = '';
  let legalTypes: ReadonlySet<Intent['type']> = new Set<Intent['type']>();
  let probeRows: readonly DiagnosticsRow[] = [];
  let lastState: GameState | null = null;
  let lastDeathCause: string | null = null;
  let lastEnding: GameState['ending'] = undefined;
  let rolePickHandler: ((roleId: string) => void) | null = null;

  function later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }

  /* ══════════════ ① 特效 ══════════════ */

  function scheduleRemoval(el: HTMLElement, ttl: number): void {
    // 动画结束就移除；prefers-reduced-motion 下动画不跑，靠这个兜底超时
    const id = window.setTimeout(() => {
      timers.delete(id);
      el.remove();
    }, ttl);
    timers.add(id);
    el.addEventListener('animationend', () => {
      window.clearTimeout(id);
      timers.delete(id);
      el.remove();
    });
  }

  function cellAt(x: number, y: number): HTMLElement | undefined {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return undefined;
    return cells[y * cols + x];
  }

  function spawnFxAt(x: number, y: number, className: string, text?: string): void {
    const cell = cellAt(x, y);
    if (cell === undefined) return;
    const rect = cell.getBoundingClientRect();
    const base = fxLayer.getBoundingClientRect();
    const el = h('div', `fx ${className}`);
    el.style.left = `${rect.left - base.left}px`;
    el.style.top = `${rect.top - base.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    if (text !== undefined) el.textContent = text;
    fxLayer.appendChild(el);
    scheduleRemoval(el, 1100);
  }

  function spawnFxRect(room: Room, className: string): void {
    const topLeft = cellAt(room.x, room.y);
    const bottomRight = cellAt(room.x + room.w - 1, room.y + room.h - 1);
    if (topLeft === undefined || bottomRight === undefined) return;
    const a = topLeft.getBoundingClientRect();
    const b = bottomRight.getBoundingClientRect();
    const base = fxLayer.getBoundingClientRect();
    const el = h('div', `fx ${className}`);
    el.style.left = `${a.left - base.left}px`;
    el.style.top = `${a.top - base.top}px`;
    el.style.width = `${b.right - a.left}px`;
    el.style.height = `${b.bottom - a.top}px`;
    fxLayer.appendChild(el);
    scheduleRemoval(el, 1100);
  }

  function flashVignette(kind: 'flash-hurt' | 'flash-sanity' | 'flash-enemy'): void {
    vignette.classList.remove('flash-hurt', 'flash-sanity', 'flash-enemy');
    void vignette.offsetWidth; // 强制回流：同名 CSS 动画不回流不会重播
    vignette.classList.add(kind);
  }

  function shakeStage(): void {
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
    later(() => stage.classList.remove('shake'), 320);
  }

  function toast(text: string, tone: MessageTone): void {
    const el = h('div', `toast ${TONE_CLASS[tone]}`, text);
    toasts.appendChild(el);
    while (toasts.children.length > MAX_TOASTS) toasts.firstElementChild?.remove();
    later(() => el.remove(), 2400);
  }

  /* ══════════════ ② 日志 ══════════════ */

  function appendLog(text: string, tone: MessageTone): void {
    // textContent：内容包对 UI 来说是不可信输入
    const line = h('div', `log-line ${TONE_CLASS[tone]}`, `› ${text}`);
    logEl.appendChild(line);
    while (logEl.children.length > MAX_LOG_LINES) logEl.firstElementChild?.remove();
  }

  /**
   * 日志的唯一真相是 state.logLine，每次都整体重建。
   *
   * 为什么不用"事件追加"：
   *   core 的 pushLog() 只往 state.logLine 里写，【不发】message 事件 ——
   *   战斗、撞墙、拾取、下楼这些最主要的文字全靠 logLine 传出来。
   *   只监听 message 事件的话，玩家会看到一片空白。
   *
   * 为什么整体重建而不是自己维护游标：
   *   logLine 是个滑动窗口（超过 60 条从头裁掉），游标会在裁剪时错位，
   *   而重建是幂等的 —— 少写一个游标就少一处会漂移的状态。
   *   60 个节点的重建成本可以忽略。
   *
   * extra 用来补 core 只发事件、没写进 logLine 的那几类文本
   * （比如 buff 效果的"攻击 +2"）。
   */
  function renderLog(state: GameState, extra: readonly { text: string; tone: MessageTone }[]): void {
    logEl.textContent = '';
    for (const line of state.logLine) appendLog(line.text, line.tone);
    for (const line of extra) appendLog(line.text, line.tone);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /**
   * 本帧的 message 事件里，core 【没有】写进 state.logLine 的那几行。
   *
   * 按"事件里出现的次数 − logLine 里已有的次数"来补：两个方向都不会重复也不会漏。
   * （core 的 message 效果是 pushLog + 事件成对出现的，所以通常差值为 0；
   *   只有 buff 效果和大段文本之外的少数路径只发事件。）
   */
  function extraLogLines(
    state: GameState,
    events: readonly GameEvent[],
  ): { text: string; tone: MessageTone }[] {
    const wanted = new Map<string, { text: string; tone: MessageTone; count: number }>();
    for (const event of events) {
      if (event.type !== 'message') continue;
      const key = `${event.tone}\u0000${event.text}`;
      const hit = wanted.get(key);
      if (hit === undefined) wanted.set(key, { text: event.text, tone: event.tone, count: 1 });
      else hit.count += 1;
    }

    const out: { text: string; tone: MessageTone }[] = [];
    for (const entry of wanted.values()) {
      let inLog = 0;
      for (const line of state.logLine) {
        if (line.text === entry.text && line.tone === entry.tone) inLog += 1;
      }
      for (let i = inLog; i < entry.count; i++) out.push({ text: entry.text, tone: entry.tone });
    }
    return out;
  }

  function resetLog(state: GameState): void {
    extraLog.length = 0;
    renderLog(state, []);
  }

  /* ══════════════ ③ 状态栏 / 地图 ══════════════ */

  function setBar(fill: HTMLElement, text: HTMLElement, value: number, max: number): void {
    const safeMax = max > 0 ? max : 1; // 只为防除零，数值本身完全以 core 为准
    const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
    fill.style.width = `${pct}%`;
    text.textContent = `${value}/${max}`;
  }

  function flashBar(fill: HTMLElement): void {
    fill.classList.add('flash');
    later(() => fill.classList.remove('flash'), 240);
  }

  function syncStatus(state: GameState): void {
    const p = state.player;
    setBar(hpFill, hpText, p.hp, p.hpMax);
    setBar(sanFill, sanText, p.san, p.sanMax);
    metaRole.textContent = p.name;
    metaDepth.textContent = `${state.act} 幕 · ${state.depth} 层`;
    metaTurn.textContent = String(state.turn);
  }

  /** 按舞台可用空间算格子边长 —— 地图不铺满就点不准；尺寸是布局，不是规则 */
  function fitCell(colsN: number, rowsN: number): void {
    const rect = stage.getBoundingClientRect();
    const availW = Math.max(0, rect.width - STAGE_PADDING_PX * 2 - (colsN - 1) * GRID_GAP_PX);
    const availH = Math.max(0, rect.height - STAGE_PADDING_PX * 2 - (rowsN - 1) * GRID_GAP_PX);
    const size = Math.floor(Math.min(availW / colsN, availH / rowsN, MAX_CELL_PX));
    stage.style.setProperty('--cell', `${Math.max(MIN_CELL_PX, size)}px`);
  }

  function rebuildGrid(colsNew: number, rowsNew: number): void {
    map.textContent = '';
    map.style.gridTemplateColumns = `repeat(${colsNew}, var(--cell))`;
    const fragment = document.createDocumentFragment();
    const built: HTMLElement[] = [];
    for (let y = 0; y < rowsNew; y++) {
      for (let x = 0; x < colsNew; x++) {
        const cell = h('div', 'cell');
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        fragment.appendChild(cell);
        built.push(cell);
      }
    }
    map.appendChild(fragment);
    cells = built;
    cols = colsNew;
    rows = rowsNew;
    fitCell(colsNew, rowsNew);
  }

  /** 缓存键：`x,y` → 实体。每帧重建一次，比每格线性搜索便宜得多 */
  function indexByCell<T extends { readonly pos: Pos }>(list: readonly T[]): Map<number, T> {
    const out = new Map<number, T>();
    for (const entry of list) {
      const { x, y } = entry.pos;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const key = y * cols + x;
      if (!out.has(key)) out.set(key, entry);
    }
    return out;
  }

  function syncMap(state: GameState): void {
    const floor = state.floor;
    if (floor.width !== cols || floor.height !== rows) rebuildGrid(floor.width, floor.height);

    const actors = indexByCell<Actor>(floor.actors);
    const items = indexByCell<{ pos: Pos; item: ItemInstance }>(floor.items);
    const { x: px, y: py } = state.player.pos;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = cellAt(x, y);
        if (cell === undefined) continue;

        const index = y * cols + x;
        const inSight = Math.max(Math.abs(x - px), Math.abs(y - py)) <= visionRadius;
        let className = 'cell';
        let text = '';
        let actorName = '';

        if (x === px && y === py) {
          className += ' player';
          text = '@';
        } else {
          const actor = actors.get(index);
          const item = items.get(index);
          // 敌人 / 物品只在视野内画；墙体、门、楼梯是"地形"，永远可见 ——
          // 否则玩家在小地图上转两圈就彻底迷路了
          if (inSight && actor !== undefined) {
            className += ' actor';
            text = actor.glyph;
            actorName = actor.name;
          } else if (inSight && item !== undefined) {
            className += ' item';
            text = itemGlyph(item.item.defId);
          } else {
            const tile = floor.tiles[y]?.[x] ?? 'wall';
            if (tile === 'wall') {
              className += ' wall';
              text = '▓';
            } else if (tile === 'door') {
              className += ' door';
              text = '+';
            } else if (tile === 'stairs') {
              className += ' stairs';
              text = '>';
            } else {
              className += ' floor';
              if (inSight) {
                className += ' adjacent';
                text = '·';
              }
            }
          }
        }

        cell.className = className;
        cell.textContent = text;
        cell.dataset.actorName = actorName;
      }
    }
  }

  /* ══════════════ ④ 全屏层 ══════════════ */

  function addChoiceButton(
    parent: HTMLElement,
    text: string,
    badge: string | undefined,
    hint: string | null,
    onClick: () => void,
  ): void {
    const btn = h('button', 'choice');
    btn.type = 'button';
    btn.appendChild(h('span', 'choice-text', text));
    if (badge !== undefined && badge !== '') btn.appendChild(h('span', 'tag', badge));
    if (hint !== null) btn.appendChild(h('span', 'key-hint', hint));
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
  }

  function openStory(state: GameState, nodeId: string): void {
    if (openStoryNode === nodeId && story.classList.contains('show')) return;

    // 剧情节点和「此刻可见的选项」都是【规则】，一律向 core 要，UI 不自己算。
    // 可见选项尤其关键：choose.index 是"可见选项序号"，
    // 所以渲染顺序必须和 getVisibleChoices 的返回顺序严格一致，
    // 否则玩家会选到自己没看见的那个选项。
    const node = findStory(nodeId);
    const choices = node === undefined ? [] : getVisibleChoices(state);

    storyText.textContent = '';
    storyChoices.textContent = '';

    if (node === undefined) {
      // core 发了事件但内容包里没有这个节点：不白屏，给一个能出去的按钮
      storyText.appendChild(h('p', 'para', UI_TEXT.storyMissing(nodeId)));
      addChoiceButton(storyChoices, UI_TEXT.leaveStory, undefined, null, () =>
        opts.onIntent({ type: 'cancel' }),
      );
    } else {
      for (const para of splitParagraphs(node.text)) {
        storyText.appendChild(h('p', 'para', para));
      }
      if (node.quote !== undefined && node.quote !== '') {
        storyText.appendChild(h('blockquote', 'quote', node.quote));
      }

      choices.forEach((choice: StoryChoice, index: number) => {
        addChoiceButton(
          storyChoices,
          choice.text,
          choice.badge,
          index < 9 ? String(index + 1) : null,
          () => opts.onIntent({ type: 'choose', index }),
        );
      });
      if (choices.length === 0) {
        addChoiceButton(storyChoices, UI_TEXT.leaveStory, undefined, null, () =>
          opts.onIntent({ type: 'cancel' }),
        );
      }
    }

    story.classList.add('show');
    story.scrollTop = 0;
    openStoryNode = nodeId;
    vibrate(15);
    const first = storyChoices.querySelector<HTMLButtonElement>('button.choice');
    first?.focus();
  }

  function closeStory(): void {
    if (openStoryNode === null && !story.classList.contains('show')) return;
    openStoryNode = null;
    story.classList.remove('show');
    storyText.textContent = '';
    storyChoices.textContent = '';
  }

  interface OverlayAction {
    readonly text: string;
    readonly primary?: boolean;
    readonly onClick: () => void;
  }

  function showOverlay(
    sig: string,
    badge: { readonly text: string; readonly className: string },
    title: string,
    paragraphs: readonly string[],
    overlayActions: readonly OverlayAction[],
  ): void {
    // sig 没变就不重建：否则每次 dispatch 都会重播动画、丢掉按钮焦点
    if (overlaySig === sig) return;
    overlaySig = sig;
    overlay.textContent = '';

    const inner = h('div', 'overlay-inner');
    inner.appendChild(h('div', `overlay-kind ${badge.className}`, badge.text));
    inner.appendChild(h('h2', 'overlay-title', title));

    const body = h('div', 'overlay-text');
    for (const paragraph of paragraphs) {
      for (const line of splitParagraphs(paragraph)) body.appendChild(h('p', 'para', line));
    }
    inner.appendChild(body);

    const barEl = h('div', 'overlay-actions');
    for (const action of overlayActions) {
      const btn = h('button', `overlay-btn${action.primary === true ? ' primary' : ''}`, action.text);
      btn.type = 'button';
      btn.addEventListener('click', action.onClick);
      barEl.appendChild(btn);
    }
    inner.appendChild(barEl);

    overlay.appendChild(inner);
    overlay.classList.add('show');
    overlay.scrollTop = 0;
  }

  function hideOverlay(): void {
    if (overlaySig === '') return;
    overlaySig = '';
    overlay.classList.remove('show');
    overlay.textContent = '';
  }

  /**
   * 「差一点就走到」的提示段落。
   *
   * 这是驱动重开率最直接的一招 —— 肉鸽的命门就是重开率，
   * 而「我差一步就拿到了」是最强的重开动机。
   *
   * 只列【内容作者写了 hint】的结局：没写 hint 的就把内部 flag 名
   * 摊给玩家看，那是纯困惑，不如不显示。
   */
  function nearMissParagraphs(state: GameState): string[] {
    const near = nearMissEndings(state, 2).filter(
      (e) => e.hint !== undefined && e.hint !== '',
    );
    if (near.length === 0) return [];
    return [
      UI_TEXT.nearMissTitle(near.length),
      ...near.map((e) => UI_TEXT.nearMissItem(e.name, e.hint ?? '')),
    ];
  }

  /** 参与 overlay 签名，保证"差一点"的列表变了会重建面板 */
  function nearMissSig(state: GameState): string {
    return nearMissEndings(state, 2).map((e) => e.id).join(',');
  }

  /**
   * 「复制这一局的链接」按钮。
   *
   * 剪贴板 API 在非 HTTPS 上下文、或没有用户手势时会失败。
   *    失败时把 URL 直接显示在气泡里让玩家手动复制 ——
   *    只报一句"复制失败"等于这个功能没做。
   */
  function shareAction(): OverlayAction | undefined {
    const onShare = opts.onShareRun;
    if (onShare === undefined) return undefined;
    return {
      text: UI_TEXT.shareRun,
      onClick: () => {
        const url = onShare();
        void writeClipboard(url).then((ok) => {
          toast(ok ? UI_TEXT.shareCopied : UI_TEXT.shareManual(url), ok ? 'gain' : 'info');
        });
      },
    };
  }

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      const clip = navigator.clipboard;
      if (clip !== undefined && typeof clip.writeText === 'function') {
        await clip.writeText(text);
        return true;
      }
    } catch {
      // 权限被拒 / 非安全上下文 —— 走兜底，不往上抛
    }
    return false;
  }

  /**
   * 全屏层以 phase 为准兜底。
   * 事件是主触发器（瞬时反应），这里是保险：core 少发/多发一个事件时，
   * 界面不会卡在错误的层上。
   */
  function syncOverlays(state: GameState): void {
    if (state.phase === 'story') {
      const nodeId = state.pendingStory ?? openStoryNode;
      if (nodeId !== null) openStory(state, nodeId);
    } else {
      closeStory();
    }

    if (state.phase === 'dead') {
      const cause = lastDeathCause ?? UI_TEXT.deathUnknownCause;
      const overlayActions: OverlayAction[] = [
        {
          text: UI_TEXT.restartAct,
          primary: true,
          onClick: () => opts.onIntent({ type: 'restartAct' }),
        },
      ];
      if (opts.onNewRun !== undefined) {
        overlayActions.push({ text: UI_TEXT.newRun, onClick: () => opts.onNewRun?.() });
      }
      const share = shareAction();
      if (share !== undefined) overlayActions.push(share);
      showOverlay(
        `dead|${cause}|${state.deaths}|${nearMissSig(state)}`,
        { text: UI_TEXT.deathBadge, className: 'danger' },
        UI_TEXT.deathTitle,
        // 死了也告诉玩家"你差一点能走到哪" —— 死亡是最常见的重开触发点
        [cause, UI_TEXT.deathCount(state.deaths), ...nearMissParagraphs(state)],
        overlayActions,
      );
      return;
    }

    if (state.phase === 'actEnd') {
      const ending = state.ending ?? lastEnding;
      const overlayActions: OverlayAction[] = [];
      // 先取到局部常量再进闭包 —— 在箭头函数里 opts.onNewRun 的
      // undefined 收窄会失效，TS 会报「可能是 undefined」
      const onNewRun = opts.onNewRun;
      if (onNewRun !== undefined) {
        overlayActions.push({ text: UI_TEXT.newRun, primary: true, onClick: () => onNewRun() });
      }
      if (legalTypes.has('restartAct')) {
        overlayActions.push({
          text: UI_TEXT.restartAct,
          onClick: () => opts.onIntent({ type: 'restartAct' }),
        });
      }
      const share = shareAction();
      if (share !== undefined) overlayActions.push(share);
      showOverlay(
        `actEnd|${ending?.id ?? 'none'}|${overlayActions.length}|${nearMissSig(state)}`,
        {
          text: ending?.victory === true ? UI_TEXT.winBadge : UI_TEXT.endBadge,
          className: ending?.victory === true ? 'win' : '',
        },
        ending?.name ?? UI_TEXT.endFallbackTitle,
        [
          ending?.text ?? UI_TEXT.endFallbackText,
          ...nearMissParagraphs(state),
        ],
        overlayActions,
      );
      return;
    }

    hideOverlay();
  }

  /* ══════════════ ⑤ 角色选择 ══════════════ */

  function showRoleSelect(roles: readonly RoleDef[], onPick: (roleId: string) => void): void {
    rolePickHandler = onPick;
    roleSelect.textContent = '';

    const inner = h('div', 'role-inner');
    inner.appendChild(h('h1', 'role-title', UI_TEXT.roleTitle));
    inner.appendChild(h('p', 'role-hint', UI_TEXT.roleHint));

    const list = h('div', 'role-list');
    for (const role of roles) {
      const card = h('button', 'role-card');
      card.type = 'button';
      card.appendChild(h('div', 'role-name', role.name));
      card.appendChild(h('div', 'role-desc', role.desc));

      const stats = h('div', 'role-stats');
      for (const line of [
        `HP ${role.hp}`,
        `理智 ${role.san}`,
        `攻 ${role.atk}`,
        `防 ${role.def}`,
      ]) {
        stats.appendChild(h('span', 'chip', line));
      }
      for (const tag of role.tags) stats.appendChild(h('span', 'chip tag', tag));
      card.appendChild(stats);

      card.addEventListener('click', () => {
        rolePickHandler?.(role.id);
      });
      list.appendChild(card);
    }
    inner.appendChild(list);
    roleSelect.appendChild(inner);
    roleSelect.classList.add('show');
    roleSelect.scrollTop = 0;
  }

  function hideRoleSelect(): void {
    roleSelect.classList.remove('show');
    roleSelect.textContent = '';
  }

  /* ══════════════ ⑤b 主菜单（菜单 / 名单 / 提示 三合一） ══════════════ */

  /** 返回按钮条 */
  function backBar(onBack: () => void): HTMLElement {
    const bar = h('div', 'menu-actions');
    const btn = h('button', 'menu-back', UI_TEXT.menuBack);
    btn.type = 'button';
    btn.addEventListener('click', onBack);
    bar.appendChild(btn);
    return bar;
  }

  /** 把面板内容装好并显示 —— 三个 show* 的公共尾巴 */
  function presentMenu(inner: HTMLElement): void {
    menu.textContent = '';
    menu.appendChild(inner);
    menu.classList.add('show');
    menu.scrollTop = 0;
  }

  function showMainMenu(entries: readonly MenuEntry[]): void {
    const inner = h('div', 'menu-inner');
    inner.appendChild(h('h1', 'menu-title', UI_TEXT.roleTitle));
    inner.appendChild(h('p', 'menu-hint', UI_TEXT.menuHint));

    const list = h('div', 'menu-list');
    for (const entry of entries) {
      // 「尚未开放」的项【不置灰】—— 置灰等于死路。
      // 点了给一段解释，比一个点不动的按钮有用得多。
      const btn = h('button', `menu-item${entry.dimmed === true ? ' dimmed' : ''}`);
      btn.type = 'button';
      btn.dataset['entry'] = entry.id;

      const head = h('div', 'menu-item-head');
      head.appendChild(h('span', 'menu-item-title', entry.title));
      if (entry.badge !== undefined && entry.badge !== '') {
        head.appendChild(h('span', 'menu-badge', entry.badge));
      }
      btn.appendChild(head);
      btn.appendChild(h('div', 'menu-item-desc', entry.desc));

      btn.addEventListener('click', entry.onPick);
      list.appendChild(btn);
    }
    inner.appendChild(list);
    presentMenu(inner);
  }

  function showCredits(sections: readonly CreditSectionView[], onBack: () => void): void {
    const inner = h('div', 'menu-inner');
    inner.appendChild(h('h1', 'menu-title', UI_TEXT.creditsTitle));

    for (const section of sections) {
      const block = h('div', 'credits-section');
      block.appendChild(h('h2', 'credits-section-title', section.title));

      if (section.entries.length > 0) {
        const list = h('div', 'credits-list');
        for (const entry of section.entries) {
          const row = h('div', 'credits-row');
          // 有链接就渲染成可点的，没有就纯文本
          if (entry.link !== undefined && entry.link !== '') {
            const a = h('a', 'credits-name', entry.name);
            a.href = entry.link;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            row.appendChild(a);
          } else {
            row.appendChild(h('span', 'credits-name', entry.name));
          }
          row.appendChild(h('span', 'credits-role', entry.role));
          list.appendChild(row);
        }
        block.appendChild(list);
      }

      if (section.note !== undefined && section.note !== '') {
        block.appendChild(h('p', 'credits-note', section.note));
      }
      inner.appendChild(block);
    }

    inner.appendChild(backBar(onBack));
    presentMenu(inner);
  }

  function showNotice(title: string, paragraphs: readonly string[], onBack: () => void): void {
    const inner = h('div', 'menu-inner');
    inner.appendChild(h('h1', 'menu-title', title));
    for (const para of paragraphs) {
      for (const line of splitParagraphs(para)) {
        inner.appendChild(h('p', 'menu-para', line));
      }
    }
    inner.appendChild(backBar(onBack));
    presentMenu(inner);
  }

  function hideMenu(): void {
    menu.classList.remove('show');
    menu.textContent = '';
  }

  /* ══════════════ ⑥ 诊断面板 ══════════════ */

  function syncDiag(): void {
    diagProbe.textContent = '';
    for (const row of probeRows) {
      const line = h('div', 'row');
      line.appendChild(h('span', 'k', row.label));
      const value = h('span', `v${row.ok === undefined ? '' : row.ok ? ' ok' : ' no'}`, row.value);
      line.appendChild(value);
      diagProbe.appendChild(line);
    }

    diagState.textContent = '';
    const state = lastState;
    const stateRows: readonly (readonly [string, string])[] =
      state === null
        ? [['状态', '未开局']]
        : [
            ['phase', state.phase],
            ['种子', String(state.seed)],
            ['层/回合', `${state.depth} / ${state.turn}`],
            ['死亡次数', String(state.deaths)],
            ['日志条数', String(state.logLine.length)],
            ['合法 Intent', [...legalTypes].join(' ') || '（无）'],
            ['模式', `${modeLabel.textContent ?? '—'}（${diagSelect.value}）`],
          ];
    for (const [key, value] of stateRows) {
      const line = h('div', 'row');
      line.appendChild(h('span', 'k', key));
      line.appendChild(h('span', 'v', value));
      diagState.appendChild(line);
    }
  }

  function toggleDiagnostics(): void {
    diag.classList.toggle('show');
    syncDiag();
  }

  function noteDebug(text: string): void {
    const line = h('div', undefined, text);
    diagDebug.prepend(line);
    while (diagDebug.children.length > 12) diagDebug.lastElementChild?.remove();
  }

  /* ══════════════ ⑦ 事件 → DOM ══════════════ */

  function findActorCells(name: string): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (const cell of cells) {
      if (cell.dataset.actorName === name) found.push(cell);
    }
    return found;
  }

  function syncFromState(state: GameState): void {
    lastState = state;
    syncStatus(state);
    syncMap(state);
    syncOverlays(state);
    if (diag.classList.contains('show')) syncDiag();
  }

  function applyEvents(state: GameState, events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'moved': {
          spawnFxAt(event.to.x, event.to.y, 'fx-step');
          vibrate(5);
          break;
        }

        case 'blocked': {
          toast(
            event.reason === 'wall' ? UI_TEXT.blockedWall : UI_TEXT.blockedActor,
            'danger',
          );
          shakeStage();
          vibrate(8);
          break;
        }

        case 'message': {
          // 日志正文在 applyEvents 的收尾处按 state.logLine 统一重建，
          // 这里不用追加（否则和 logLine 里的同一行重复）
          break;
        }

        case 'attack': {
          // 只显示事件里带来的数字，不自己编文案 —— 文案该由 core 的 message 事件给。
          // 用 DOM 里上一次同步留下的 dataset.actorName 找目标格（此时地图还没重绘），
          // 所以刚被打死的敌人也能闪一下。
          const targets = findActorCells(event.target);
          for (const cell of targets) {
            spawnFxAt(
              Number.parseInt(cell.dataset.x ?? '-1', 10),
              Number.parseInt(cell.dataset.y ?? '-1', 10),
              event.killed ? 'fx-kill' : 'fx-hit',
            );
          }
          if (event.killed) vibrate([12, 40, 18]);
          break;
        }

        case 'hurt': {
          flashVignette('flash-hurt');
          flashBar(hpFill);
          shakeStage();
          vibrate(24);
          const pos = state.player.pos;
          spawnFxAt(pos.x, pos.y, 'fx-number', `-${event.amount}`);
          break;
        }

        case 'enemyTurn': {
          if (event.count > 0) flashVignette('flash-enemy');
          noteDebug(`enemyTurn: ${event.count} 个敌人行动`);
          break;
        }

        case 'roomCleared': {
          toast(UI_TEXT.roomCleared, 'gain');
          const room = state.floor.rooms.find((r) => r.id === event.roomId);
          if (room !== undefined) spawnFxRect(room, 'fx-room');
          noteDebug(`roomCleared: room ${event.roomId}`);
          break;
        }

        case 'drop': {
          toast(UI_TEXT.dropAppeared(itemName(event.defId)), 'gain');
          spawnFxAt(event.pos.x, event.pos.y, 'fx-drop');
          noteDebug(`drop: ${event.defId}(${event.kind}) @${event.pos.x},${event.pos.y}`);
          break;
        }

        case 'pickup': {
          // core 自己会往 logLine 写"你拾起了「X」。"，所以这里只做瞬时提示，
          // 不再往日志里塞第二句几乎一样的话
          toast(UI_TEXT.pickup(event.name), 'gain');
          vibrate(10);
          break;
        }

        case 'story': {
          openStory(state, event.nodeId);
          break;
        }

        case 'storyClosed': {
          closeStory();
          break;
        }

        case 'sanity': {
          flashVignette('flash-sanity');
          flashBar(sanFill);
          const pos = state.player.pos;
          spawnFxAt(pos.x, pos.y, 'fx-number gain', event.delta >= 0 ? `+${event.delta}` : String(event.delta));
          break;
        }

        case 'slotFilled': {
          // 开发用：只在诊断面板里露出来，玩家界面不显示
          noteDebug(`slotFilled: ${event.slotId} ← ${event.nodeId}`);
          break;
        }

        case 'died': {
          lastDeathCause = event.cause;
          vibrate([30, 60, 140]);
          break;
        }

        case 'actEnded': {
          lastEnding = event.ending;
          vibrate([18, 60, 18, 60, 30]);
          break;
        }

        case 'floorChanged': {
          toast(UI_TEXT.floorReached(event.depth), 'info');
          noteDebug(`floorChanged: depth ${event.depth}`);
          break;
        }

        default: {
          // 穷尽检查：core 新增事件类型时这里会编译不过，
          // 逼着人回来决定"新事件要不要表现得不一样"
          const unknown: never = event;
          const label = (unknown as { readonly type?: unknown }).type;
          noteDebug(`render: 未处理的事件 ${String(label)}`);
          break;
        }
      }
    }

    // 日志：以 state.logLine 为准整体重建 —— core 的 pushLog() 不发 message 事件，
    // 战斗/撞墙/拾取/下楼这些文字只存在于 logLine 里。
    // 不用"游标 + 追加"是因为 logLine 是 60 条的滑动窗口：一旦触顶开始从头裁剪，
    // 长度就不再增长，游标会永远追不上，日志从此定格。重建是幂等的，没有这个失效模式。
    for (const line of extraLogLines(state, events)) extraLog.push(line);
    while (extraLog.length > MAX_EXTRA_LOG_LINES) extraLog.shift();
    renderLog(state, extraLog);

    syncFromState(state);
  }

  /* ══════════════ ⑧ 其它接线 ══════════════ */

  function setLegalIntents(types: readonly Intent['type'][]): void {
    legalTypes = new Set(types);
    btnInteract.disabled = !legalTypes.has('interact');
    btnDescend.disabled = !legalTypes.has('descend');
    root.dataset.legalMove = String(legalTypes.has('move') || legalTypes.has('wait'));
    // 死亡/结局层上的按钮也要跟着合法性走（比如 actEnd 之后还能不能 restartAct）
    if (lastState !== null && (lastState.phase === 'dead' || lastState.phase === 'actEnd')) {
      syncOverlays(lastState);
    }
  }

  function onStoryKeyDown(e: KeyboardEvent): void {
    if (!story.classList.contains('show')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(storyChoices.querySelectorAll<HTMLButtonElement>('button.choice'));
    if (buttons.length === 0) return;
    const current = document.activeElement;
    const index = current instanceof HTMLButtonElement ? buttons.indexOf(current) : -1;
    const next =
      index < 0
        ? e.key === 'ArrowDown'
          ? 0
          : buttons.length - 1
        : e.key === 'ArrowDown'
          ? (index + 1) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
    e.preventDefault();
  }

  function onResize(): void {
    if (cols > 0 && rows > 0) fitCell(cols, rows);
  }

  window.addEventListener('keydown', onStoryKeyDown);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => onResize()) : null;
  observer?.observe(stage);

  return {
    els,

    showRoleSelect,
    hideRoleSelect,
    showMainMenu,
    showCredits,
    showNotice,
    hideMenu,
    resetLog,
    applyEvents,
    renderState: syncFromState,
    setLegalIntents,

    setInputMode(resolved: ResolvedInputMode, locked: boolean): void {
      const label = resolved === 'touch' ? '触摸' : resolved === 'gamepad' ? '手柄' : '键盘';
      modeLabel.textContent = locked ? `${label}·锁` : label;
      root.dataset.inputMode = resolved;
      if (diag.classList.contains('show')) syncDiag();
    },

    setProbeRows(rows: readonly DiagnosticsRow[]): void {
      probeRows = rows;
      if (diag.classList.contains('show')) syncDiag();
    },

    setLastInputEvent(label: string): void {
      diagLast.textContent = label;
    },

    notify(text: string, tone: MessageTone = 'info'): void {
      toast(text, tone);
    },

    noteDebug,

    showFatal(message: string): void {
      overlaySig = `fatal|${message}`;
      overlay.textContent = '';
      const inner = h('div', 'overlay-inner');
      inner.appendChild(h('div', 'overlay-kind danger', UI_TEXT.fatalTitle));
      const body = h('div', 'overlay-text');
      for (const line of splitParagraphs(message)) body.appendChild(h('p', 'para', line));
      inner.appendChild(body);
      overlay.appendChild(inner);
      overlay.classList.add('show');
      noteDebug(`fatal: ${message}`);
    },

    toggleDiagnostics,

    destroy(): void {
      window.removeEventListener('keydown', onStoryKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      observer?.disconnect();
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      cells = [];
      root.textContent = '';
    },
  };
}

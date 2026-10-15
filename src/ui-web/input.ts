/**
 * ════════════════════════════════════════════════════════════════
 *  ui-web/input.ts —— 输入层
 * ════════════════════════════════════════════════════════════════
 *
 *  这一层只做一件事：把【原生输入事件】翻译成 Intent。
 *
 *  从输入层原型重构时保留的几条结论，都是踩过坑的：
 *
 *   1. Intent 是唯一出口。这一层不知道玩家用的是手机还是键盘；core 收到
 *      Intent 时同样不知道。所以再加一种输入方式（语音、脚踏板……），
 *      core 一行都不用改。
 *
 *   2. 用 Pointer Events + setPointerCapture，【不用】Touch Events。
 *      手指移出元素后 touchmove 就丢了，长按拖动会"卡住"。
 *      【坑】setPointerCapture 之后，后续 pointer 事件会被重定向到捕获元素，
 *      pointerup 的 e.target 变成 #map 而不是被点的那个格子。所以落点格子必须
 *      在 pointerdown 时就记下来 —— 原型在 pointerup 里用 e.target.closest('.cell')，
 *      在严格实现捕获的浏览器上"点相邻格移动"是失效的。
 *
 *   3. 自动探测只写【默认值】，玩家随时能手动锁定（诊断面板里的下拉框）。
 *      锁定之后，任何自动探测都不许再改模式。
 *
 *   4. 这一层【不判断游戏规则】。某个 Intent 此刻是否合法，由 app 层注入的
 *      isLegal() 回答（它内部调用 core 的 legalIntents()）。这样"剧情层只接受
 *      choose / cancel"这类规则只存在于 core 一处，UI 不会长出第二份。
 * ════════════════════════════════════════════════════════════════
 */

import type { Direction, Intent, Pos } from '@core/types';

/* ─────────────────────────── 常量 ─────────────────────────── */

/** 长按连发：先等 320ms 再开始，之后每 110ms 一步（原型验证过的手感） */
export const HOLD_REPEAT_DELAY_MS = 320;
export const HOLD_REPEAT_INTERVAL_MS = 110;
/** 超过这个位移才算滑动 */
export const SWIPE_THRESHOLD_PX = 28;
/** 小于这个位移才算"点击"（手指天然会抖，给 12px 容差） */
export const TAP_SLOP_PX = 12;
/** 摇杆死区 */
const AXIS_THRESHOLD = 0.5;

/* ─────────────────────────── 输入模式 ─────────────────────────── */

/** auto = 自动探测（只设默认值）；其余三个是玩家手动锁定的模式 */
export type InputMode = 'auto' | 'touch' | 'keyboard' | 'gamepad';
/** 去掉 auto 之后剩下的就是"实际使用哪一种" */
export type ResolvedInputMode = Exclude<InputMode, 'auto'>;

export const INPUT_MODES: readonly InputMode[] = ['auto', 'touch', 'keyboard', 'gamepad'];

export function isInputMode(value: string): value is InputMode {
  return (INPUT_MODES as readonly string[]).includes(value);
}

export const INPUT_MODE_LABEL: Readonly<Record<ResolvedInputMode, string>> = {
  touch: '触摸',
  keyboard: '键盘',
  gamepad: '手柄',
};

/* ─────────────────────────── ① 环境探针 ─────────────────────────── */

/**
 * 探测的是"能力"和"输入方式"，不是"设备型号"。
 * UA 字符串会撒谎（iPad 默认是 Macintosh UA），能力查询不会。
 */
export interface EnvironmentProbe {
  readonly coarsePointer: boolean;
  readonly finePointer: boolean;
  readonly anyCoarsePointer: boolean;
  readonly hover: boolean;
  readonly maxTouchPoints: number;
  readonly pointerEvents: boolean;
  readonly gamepadApi: boolean;
  readonly vibrateApi: boolean;
  readonly dvh: boolean;
  readonly viewport: string;
  readonly dpr: number;
}

/** 诊断面板里的一行。render.ts 里有一个结构相同的类型 —— 故意不互相 import，保持两层解耦。 */
export interface ProbeRow {
  readonly label: string;
  readonly value: string;
  /** 布尔型探测结果的着色依据；数值型行留空 */
  readonly ok?: boolean;
}

function mq(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

export function probeEnvironment(): EnvironmentProbe {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    coarsePointer: mq('(pointer: coarse)'),
    finePointer: mq('(pointer: fine)'),
    anyCoarsePointer: mq('(any-pointer: coarse)'),
    hover: mq('(hover: hover)'),
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    pointerEvents: typeof window !== 'undefined' && 'PointerEvent' in window,
    gamepadApi: typeof nav?.getGamepads === 'function',
    vibrateApi: typeof nav?.vibrate === 'function',
    dvh:
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('height', '100dvh'),
    viewport: typeof window === 'undefined' ? '—' : `${window.innerWidth}×${window.innerHeight}`,
    dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  };
}

const yesNo = (v: boolean, label: string): ProbeRow => ({ label, value: v ? '是' : '否', ok: v });

export function formatProbe(env: EnvironmentProbe): readonly ProbeRow[] {
  return [
    yesNo(env.coarsePointer, '(pointer: coarse)'),
    yesNo(env.finePointer, '(pointer: fine)'),
    yesNo(env.anyCoarsePointer, '(any-pointer: coarse)'),
    yesNo(env.hover, '(hover: hover)'),
    { label: 'maxTouchPoints', value: String(env.maxTouchPoints) },
    { label: '视口', value: env.viewport },
    { label: 'DPR', value: String(env.dpr) },
    yesNo(env.dvh, '100dvh 支持'),
    yesNo(env.pointerEvents, 'Pointer Events'),
    yesNo(env.vibrateApi, '震动 API'),
    yesNo(env.gamepadApi, '手柄 API'),
  ];
}

/**
 * 自动判定默认模式：主指针是"粗的"且真有触摸点 → 触摸，否则键盘。
 * 只是默认值 —— 玩家可以在诊断面板里锁死。
 */
export function detectDefaultMode(env: EnvironmentProbe): ResolvedInputMode {
  if (env.coarsePointer && env.maxTouchPoints > 0) return 'touch';
  if (env.gamepadApi && env.finePointer) return 'keyboard';
  return 'keyboard';
}

/* ─────────────────────────── 触觉反馈 ─────────────────────────── */

/**
 * 震动反馈。iOS Safari 不支持 navigator.vibrate，调用前必须判存在；
 * 某些 WebView 会直接抛异常，所以还要包 try。
 * 放在输入层是因为它属于"设备能力"，渲染层只是借用。
 */
export function vibrate(pattern: number | readonly number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
  } catch {
    /* 不支持就算了，震动不是玩法的一部分 */
  }
}

/* ─────────────────────────── ② 控制器 ─────────────────────────── */

/** 输入层要告诉 app 层"这个操作被忽略了"，但文案由渲染层决定 */
export type InputNotice = 'tooFar' | 'illegal';

export interface InputOptions {
  /** 地图手势宿主（#map） */
  readonly mapEl: HTMLElement;
  /** 虚拟方向键宿主（#dpad） */
  readonly dpadEl: HTMLElement;
  /** Intent 的唯一出口 */
  readonly emit: (intent: Intent) => void;
  /** 这个 Intent 类型此刻是否合法 —— 由 app 层用 core 的 legalIntents() 提供 */
  readonly isLegal: (type: Intent['type']) => boolean;
  /** 地图点击要判断"是否相邻"，需要知道玩家在哪 */
  readonly getPlayerPos: () => Pos;
  /** 模式变化（状态栏标签 / CSS 都用它） */
  readonly onModeChange?: (resolved: ResolvedInputMode, locked: boolean) => void;
  /** 原始事件名，用于诊断面板 */
  readonly onEvent?: (label: string) => void;
  /** 被忽略的操作（太远 / 不合法） */
  readonly onNotice?: (notice: InputNotice) => void;
}

export interface InputController {
  /** 'auto' 表示交回自动探测 */
  setMode(mode: InputMode): void;
  getMode(): InputMode;
  getResolvedMode(): ResolvedInputMode;
  dispose(): void;
}

const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

/** data-dir 来自 DOM，是 string，必须显式收窄 */
function isDirection(value: string | undefined): value is Direction {
  return value !== undefined && (DIRECTIONS as readonly string[]).includes(value);
}

/** 键盘 → 方向。统一用小写 key，省掉大小写两套映射。 */
const KEY_DIRS: Readonly<Record<string, Direction>> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

interface DragState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** 落点格子 —— pointerup 时 e.target 已经不可信了（见文件头【坑】） */
  readonly cell: Pos | null;
  moved: boolean;
}

interface PadState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
}

const EMPTY_PAD: PadState = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
  x: false,
  y: false,
};

/** 从事件目标往上找带 data-x / data-y 的格子 */
function cellFromTarget(target: EventTarget | null): Pos | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest('[data-x][data-y]');
  if (!(cell instanceof HTMLElement)) return null;
  const xs = cell.dataset.x;
  const ys = cell.dataset.y;
  if (xs === undefined || ys === undefined) return null;
  const x = Number.parseInt(xs, 10);
  const y = Number.parseInt(ys, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** 焦点在输入控件里时，方向键应该归控件，不能拿去走地图 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function createInput(opts: InputOptions): InputController {
  /* ── 模式：手动锁定优先，自动探测只填默认值 ── */
  let manual: InputMode = 'auto';
  let detected: ResolvedInputMode = detectDefaultMode(probeEnvironment());

  const resolved = (): ResolvedInputMode => (manual === 'auto' ? detected : manual);

  function publish(): void {
    opts.onModeChange?.(resolved(), manual !== 'auto');
  }

  /** 自动探测到某种输入方式时调用 —— 手动锁定后一律不生效 */
  function noteAuto(mode: ResolvedInputMode): void {
    if (manual !== 'auto' || detected === mode) return;
    detected = mode;
    publish();
  }

  /**
   * 唯一派发口。返回是否真的发出去了。
   * 诊断回调先记一笔再判合法性 —— 排查"按了没反应"时要能看到按键本身。
   */
  function emit(intent: Intent, label: string): boolean {
    opts.onEvent?.(label);
    if (!opts.isLegal(intent.type)) {
      opts.onNotice?.('illegal');
      return false;
    }
    opts.emit(intent);
    return true;
  }

  /* ══════════════ 适配器 A：键盘 ══════════════ */

  function onKeyDown(e: KeyboardEvent): void {
    if (isTextEntryTarget(e.target)) return;

    const key = e.key;
    const lower = key.toLowerCase();
    const dir = KEY_DIRS[lower];
    // 系统连发对"走一步"是好事（等于桌面端的长按连发），
    // 但对等待/互动/取消是灾难（按住空格刷一屏），所以只给移动放行。
    if (e.repeat && dir === undefined) return;

    noteAuto('keyboard');

    if (dir !== undefined) {
      if (emit({ type: 'move', dir }, `keydown ${key} → move:${dir}`)) e.preventDefault();
      return;
    }
    if (key === ' ' || key === '.') {
      if (emit({ type: 'wait' }, `keydown ${key} → wait`)) e.preventDefault();
      return;
    }
    if (key === 'Escape') {
      if (emit({ type: 'cancel' }, 'keydown Esc → cancel')) e.preventDefault();
      return;
    }
    if (lower === 'e' || key === 'Enter') {
      if (emit({ type: 'interact' }, `keydown ${key} → interact`)) e.preventDefault();
      return;
    }
    // '>' 就是 Shift+. ；PageDown 兼顾没有 > 的键盘布局
    if (key === '>' || key === 'PageDown') {
      if (emit({ type: 'descend' }, `keydown ${key} → descend`)) e.preventDefault();
      return;
    }
    // 剧情选项：数字键 1-9 直接选（index 从 0 开始）
    if (key.length === 1 && key >= '1' && key <= '9') {
      const index = Number.parseInt(key, 10) - 1;
      if (emit({ type: 'choose', index }, `keydown ${key} → choose:${index}`)) e.preventDefault();
    }
  }

  /* ══════════════ 适配器 B：地图（点相邻格 + 滑动） ══════════════ */

  let drag: DragState | null = null;

  const canUseMap = (): boolean => opts.isLegal('move') || opts.isLegal('wait');

  function onMapPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 右键交给 contextmenu
    if (!canUseMap()) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') noteAuto('touch');
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cell: cellFromTarget(e.target), moved: false };
    try {
      // 手指滑出格子也照样收到 move/up —— 不加这句，滑动会"卡住"
      opts.mapEl.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已经释放时会抛，忽略即可 */
    }
  }

  function onMapPointerMove(e: PointerEvent): void {
    if (drag === null || e.pointerId !== drag.id) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > TAP_SLOP_PX) drag.moved = true;
  }

  function onMapPointerUp(e: PointerEvent): void {
    const state = drag;
    if (state === null || e.pointerId !== state.id) return;
    drag = null;

    const dx = e.clientX - state.x;
    const dy = e.clientY - state.y;
    const dist = Math.hypot(dx, dy);

    // —— 滑动手势：取主轴方向
    if (dist > SWIPE_THRESHOLD_PX) {
      const dir: Direction =
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      emit({ type: 'move', dir }, `swipe(${Math.round(dist)}px) → move:${dir}`);
      return;
    }

    // —— 点击：只有相邻格能走（拖动过就不算点击）
    if (state.moved) return;
    if (!canUseMap()) return;
    const cell = state.cell;
    if (cell === null) return;

    const p = opts.getPlayerPos();
    const ddx = cell.x - p.x;
    const ddy = cell.y - p.y;
    if (ddx === 0 && ddy === 0) {
      emit({ type: 'wait' }, 'tap self → wait');
      return;
    }
    if (Math.abs(ddx) + Math.abs(ddy) === 1) {
      const dir: Direction = ddx === 1 ? 'right' : ddx === -1 ? 'left' : ddy === 1 ? 'down' : 'up';
      emit({ type: 'move', dir }, `tap cell(${cell.x},${cell.y}) → move:${dir}`);
      return;
    }
    // 太远了。不发 Intent —— 移动合法性属于 core，UI 只负责告诉玩家"点不到"
    opts.onEvent?.(`tap cell(${cell.x},${cell.y}) → 太远，忽略`);
    if (opts.isLegal('move')) opts.onNotice?.('tooFar');
  }

  function onMapPointerCancel(e: PointerEvent): void {
    if (drag !== null && e.pointerId === drag.id) drag = null;
  }

  function onMapContextMenu(e: MouseEvent): void {
    // 桌面端右键 = 取消（触屏没有右键，所以不能只靠它）
    e.preventDefault();
    emit({ type: 'cancel' }, 'contextmenu → cancel');
  }

  /* ══════════════ 适配器 C：虚拟 D-Pad ══════════════ */

  const dpadCleanups: (() => void)[] = [];

  function bindHold(el: HTMLElement, makeIntent: () => Intent, label: string): void {
    let held = false;
    let delayId: ReturnType<typeof setTimeout> | undefined;
    let timerId: ReturnType<typeof setInterval> | undefined;

    const stop = (): void => {
      if (!held) return;
      held = false;
      el.classList.remove('held');
      if (delayId !== undefined) clearTimeout(delayId);
      if (timerId !== undefined) clearInterval(timerId);
      delayId = undefined;
      timerId = undefined;
    };

    const onDown = (e: PointerEvent): void => {
      e.preventDefault(); // 防止按钮抢焦点、防止合成 click
      if (e.pointerType === 'touch' || e.pointerType === 'pen') noteAuto('touch');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 同上 */
      }
      el.classList.add('held');
      held = true;
      emit(makeIntent(), label);

      delayId = setTimeout(() => {
        timerId = setInterval(() => {
          if (held) emit(makeIntent(), `${label}(连发)`);
        }, HOLD_REPEAT_INTERVAL_MS);
      }, HOLD_REPEAT_DELAY_MS);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('lostpointercapture', stop);
    // 兜底：捕获失败时按钮可能永远停在"按住"状态，任何地方松手都停
    document.addEventListener('pointerup', stop);

    dpadCleanups.push(() => {
      stop();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      el.removeEventListener('pointerleave', stop);
      el.removeEventListener('lostpointercapture', stop);
      document.removeEventListener('pointerup', stop);
    });
  }

  function bindDpad(): void {
    const dirButtons = opts.dpadEl.querySelectorAll<HTMLElement>('[data-dir]');
    for (const btn of Array.from(dirButtons)) {
      const dir = btn.dataset.dir;
      if (!isDirection(dir)) continue;
      bindHold(btn, () => ({ type: 'move', dir }), `dpad ${dir} → move:${dir}`);
    }
    const waitBtn = opts.dpadEl.querySelector<HTMLElement>('[data-intent="wait"]');
    if (waitBtn !== null) bindHold(waitBtn, () => ({ type: 'wait' }), 'dpad 等待 → wait');
  }

  /* ══════════════ 适配器 D：手柄（rAF 轮询） ══════════════ */

  const padStates = new Map<number, PadState>();
  let rafId = 0;

  function readPad(pad: Gamepad): PadState {
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const pressed = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
    return {
      up: ay < -AXIS_THRESHOLD || pressed(12),
      down: ay > AXIS_THRESHOLD || pressed(13),
      left: ax < -AXIS_THRESHOLD || pressed(14),
      right: ax > AXIS_THRESHOLD || pressed(15),
      a: pressed(0),
      b: pressed(1),
      x: pressed(2),
      y: pressed(3),
    };
  }

  function pollGamepad(): void {
    rafId = requestAnimationFrame(pollGamepad);
    if (typeof navigator.getGamepads !== 'function') return;

    const pads = navigator.getGamepads();
    pads.forEach((pad, index) => {
      if (pad === null) {
        padStates.delete(index);
        return;
      }
      const now = readPad(pad);
      const prev = padStates.get(index) ?? EMPTY_PAD;

      // 只在"按下沿"发 Intent，否则一帧能走 60 步
      const edges: readonly (readonly [keyof PadState, Intent])[] = [
        ['up', { type: 'move', dir: 'up' }],
        ['down', { type: 'move', dir: 'down' }],
        ['left', { type: 'move', dir: 'left' }],
        ['right', { type: 'move', dir: 'right' }],
        ['a', { type: 'interact' }],
        ['b', { type: 'cancel' }],
        ['x', { type: 'wait' }],
        ['y', { type: 'descend' }],
      ];
      for (const [key, intent] of edges) {
        if (now[key] && !prev[key]) {
          noteAuto('gamepad');
          emit(intent, `gamepad ${pad.index} ${key} → ${intent.type}`);
        }
      }
      padStates.set(index, now);
    });
  }

  function onGamepadConnected(e: GamepadEvent): void {
    opts.onEvent?.(`gamepadconnected: ${e.gamepad.id}`);
    noteAuto('gamepad');
  }

  function onGamepadDisconnected(e: GamepadEvent): void {
    opts.onEvent?.(`gamepaddisconnected: ${e.gamepad.id}`);
    padStates.clear();
    // 手柄拔了要退回探测出来的默认模式，否则方向键区会一直显示"手柄"
    if (manual === 'auto') {
      detected = detectDefaultMode(probeEnvironment());
      publish();
    }
  }

  /* ══════════════ 装配 ══════════════ */

  window.addEventListener('keydown', onKeyDown);
  opts.mapEl.addEventListener('pointerdown', onMapPointerDown);
  opts.mapEl.addEventListener('pointermove', onMapPointerMove);
  opts.mapEl.addEventListener('pointerup', onMapPointerUp);
  opts.mapEl.addEventListener('pointercancel', onMapPointerCancel);
  opts.mapEl.addEventListener('contextmenu', onMapContextMenu);
  window.addEventListener('gamepadconnected', onGamepadConnected);
  window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
  bindDpad();
  rafId = requestAnimationFrame(pollGamepad);
  publish();
  opts.onEvent?.(`自动判定输入模式：${INPUT_MODE_LABEL[resolved()]}`);

  return {
    setMode(mode: InputMode): void {
      manual = mode;
      publish();
      opts.onEvent?.(`手动切换输入模式：${mode}`);
    },
    getMode: (): InputMode => manual,
    getResolvedMode: resolved,
    dispose(): void {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown);
      opts.mapEl.removeEventListener('pointerdown', onMapPointerDown);
      opts.mapEl.removeEventListener('pointermove', onMapPointerMove);
      opts.mapEl.removeEventListener('pointerup', onMapPointerUp);
      opts.mapEl.removeEventListener('pointercancel', onMapPointerCancel);
      opts.mapEl.removeEventListener('contextmenu', onMapContextMenu);
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      for (const cleanup of dpadCleanups) cleanup();
      drag = null;
      padStates.clear();
    },
  };
}

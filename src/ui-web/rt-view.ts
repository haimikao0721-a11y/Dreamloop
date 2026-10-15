/**
 * ════════════════════════════════════════════════════════════════
 *  ui-web/rt-view.ts —— 实时层原型（第 2 步：帧数据战斗）
 * ════════════════════════════════════════════════════════════════
 *
 *  第 1 步验收了移动和碰撞。这一步验收【帧数据能不能被玩出来】：
 *
 *      怪物抬手（起手）→ 你看见并躲开 → 它打空进入收招 → 你反击
 *
 *  如果这条链在画面上读不出来，帧数据就只是数值表里的数字。
 *
 *  和正式游戏完全并存：?proto=rt 才进这里。
 * ════════════════════════════════════════════════════════════════
 */

import {
  TILE,
  TILE_FLOOR,
  actionPhase,
  createAccumulator,
  createInitialRtState,
  findPlayer,
  makeAiState,
  findOpenCell,
  isZeroState,
  makeLight,
  makeTestRoom,
  runTicks,
  spawn,
  tickRt,
  totalFrames,
} from '@core/rt/index.js';
import type { ActionState, Entity, InputState, RtState } from '@core/rt/index.js';
import { getCurrentStory, getVisibleChoiceIndices } from '@core/narrative';
import { chooseInStory, narrativeView, plantCandle, tryPickup } from '@core/rt/index.js';
import { ARCHIVIST_HEAVY, ARCHIVIST_LIGHT } from '@data/rt/actions.js';
import { CRAWLER, ORDERLY } from '@data/rt/enemies.js';
import { toSpawnTemplate } from '@data/rt/enemies.js';
import type { RtEnemyDef } from '@data/rt/enemies.js';

const ROOM_W = 21;
const ROOM_H = 15;
/** 精灵尺寸，和 tools/gen-assets.mjs 里的一致 */
const SPR_W = 16;
const SPR_H = 24;
/**
 * 墙的顶面高度 = 一格。
 *
 * 【画布顶部要多留这么高】—— 最上面那排墙的顶面画在它上方一格，
 * 不留余量的话会被裁掉，房间顶部看起来是平的。
 */
const WALL_TOP_H = TILE;
/** 移动动画每几帧换一次图。8 tick ≈ 7.5fps 的走路节奏 */
const WALK_FRAME_TICKS = 8;

/* ── 房间尺寸按屏幕算 ── */

export interface RoomPlan {
  cols: number;
  rows: number;
  /** 整数倍缩放 */
  scale: number;
}

/** 房间再小也得有这么多格，否则一眼看全就没有探索感，怪物也没地方摆 */
const MIN_COLS = 11;
const MIN_ROWS = 10;
/** 也不能太大 —— 一屏装不下就违背了"一屏一房间" */
const MAX_COLS = 29;
const MAX_ROWS = 21;

/**
 * 按可用空间决定：房间几格、放大几倍。
 *
 * 【为什么不能让屏幕迁就房间】
 * 固定 21×15 的横屏房间放到手机竖屏上，宽度先卡住缩放，
 * 结果只能是 1 倍 —— 336×240 的一个小方块挂在 800 多像素高的屏幕上，
 * 上下全是黑的，看起来就像"什么都没画出来"。
 *
 * 【为什么用视口尺寸而不是量 DOM】
 * 启动瞬间量 stage.clientWidth，布局可能还没算完，量出来是错的
 * （实测量到 240，视口其实是 390）。用视口尺寸加一个固定估值，
 * 结果是可预测的；真正的适配交给 fitCanvas 按实测尺寸兜底。
 */
export function planRoom(viewportW: number, viewportH: number): RoomPlan {
  // 留一点余量：视口尺寸和实际可用空间不一定完全一致
  // （安全区、滚动条、状态栏估错），宁可房间小一号也不要溢出
  const availW = Math.max(120, viewportW - 8);
  // 减掉上下两条：状态栏 ≈ 34px，底部提示 ≈ 22px，再加余量
  const availH = Math.max(120, viewportH - 100);

  // 从大缩放往小试：缩放越大，同样空间里能放的格子越少。
  // 手机上 6 倍缩放只剩 4 格宽，没法玩，所以一路降到装得下为止。
  for (let scale = 6; scale >= 1; scale--) {
    const cols = Math.floor(availW / (TILE * scale));
    const rows = Math.floor(availH / (TILE * scale));
    if (cols >= MIN_COLS && rows >= MIN_ROWS) {
      return { cols: Math.min(cols, MAX_COLS), rows: Math.min(rows, MAX_ROWS), scale };
    }
  }
  // 空间实在太小（很小的横屏窗口），退回最小可用配置
  return { cols: MIN_COLS, rows: MIN_ROWS, scale: 1 };
}

/* ── 样式：只作用于原型 ── */

const CSS = `
.rt-wrap {
  position: fixed; inset: 0; z-index: 200;
  background: #07070b; color: #b9b9c4;
  display: flex; flex-direction: column;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  touch-action: none; overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
}
.rt-bar {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: calc(env(safe-area-inset-top) + 8px) 12px 8px;
  font-size: 12px; color: #6b6b7a;
  line-height: 1.4;
}
.rt-bar .keys { display: none; }
@media (min-width: 560px) { .rt-bar .keys { display: inline; } }
.rt-bar b { color: #d8a848; font-weight: normal; }
.rt-bar .hp { color: #c46a5a; }
.rt-bar button {
  margin-left: auto; padding: 6px 14px;
  background: #16161d; border: 1px solid #2c2c38; border-radius: 6px;
  color: #b9b9c4; font-family: inherit; font-size: 12px; cursor: pointer;
}
.rt-bar button:hover { border-color: #d8a848; }
.rt-stage { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
.rt-stage canvas {
  image-rendering: pixelated; image-rendering: crisp-edges; display: block;
}
.rt-wheel {
  position: fixed; left: calc(env(safe-area-inset-left) + 18px);
  bottom: calc(env(safe-area-inset-bottom) + 18px);
  width: 132px; height: 132px; border-radius: 50%;
  border: 2px solid #2c2c38; background: rgba(22,22,29,0.45);
  display: none; touch-action: none;
}
.rt-wheel.on { display: block; }
.rt-wheel::after {
  content: ''; position: absolute; left: 50%; top: 50%;
  width: 46px; height: 46px; margin: -23px 0 0 -23px;
  border-radius: 50%; border: 2px solid #4a4a58;
}
.rt-knob {
  position: absolute; left: 50%; top: 50%;
  width: 34px; height: 34px; margin: -17px 0 0 -17px;
  border-radius: 50%; background: rgba(216,168,72,0.65); pointer-events: none;
}
/* 攻击键：轮盘在左下，攻击键放右下 —— 手机上的标准布局 */
.rt-attack {
  position: fixed; right: calc(env(safe-area-inset-right) + 26px);
  bottom: calc(env(safe-area-inset-bottom) + 34px);
  width: 84px; height: 84px; border-radius: 50%;
  border: 2px solid #4a3a2c; background: rgba(216,168,72,0.22);
  color: #d8a848; font-family: inherit; font-size: 15px;
  display: none; touch-action: none; cursor: pointer;
}
.rt-attack.on { display: block; }
  /* 重击：小一圈、放在轻击左上方 —— 拇指够得着，又不会误触 */
  .rt-heavy {
    position: fixed; right: calc(env(safe-area-inset-right) + 118px);
    bottom: calc(env(safe-area-inset-bottom) + 62px);
    width: 62px; height: 62px; border-radius: 50%;
    border: 2px solid #4a3a2c; background: rgba(224,120,72,0.2);
    color: #e07848; font-family: inherit; font-size: 13px;
    display: none; touch-action: none; cursor: pointer;
  }
  .rt-heavy.on { display: block; }
.rt-attack:active { background: rgba(216,168,72,0.5); }
.rt-hint { padding: 0 12px calc(env(safe-area-inset-bottom) + 10px); font-size: 11px; color: #52525f; }

/* 全屏剧情层。世界在这期间是冻住的 —— 见 story.ts 的 phase 处理 */
.rt-story {
  position: fixed; inset: 0; z-index: 300; display: none;
  background: rgba(6,6,9,0.97); backdrop-filter: blur(4px);
  overflow-y: auto;
  padding: calc(env(safe-area-inset-top) + 32px) 26px calc(env(safe-area-inset-bottom) + 32px);
}
.rt-story.show { display: flex; }
.rt-story-inner {
  width: 100%; max-width: 640px; margin: auto;
  display: flex; flex-direction: column; gap: 22px;
}
.rt-story-text {
  font-size: clamp(15px, 3.4vw, 18px); line-height: 2.05;
  color: #d5d2ca; letter-spacing: 0.02em; white-space: pre-wrap;
}
.rt-story-quote {
  border-left: 2px solid #d8a848; padding-left: 14px;
  color: #d8a848; font-style: italic; line-height: 1.95;
}
.rt-story-choices { display: flex; flex-direction: column; gap: 10px; }
.rt-story-choice {
  padding: 15px 17px; background: #16161d; border: 1px solid #2c2c38;
  border-radius: 8px; color: #d5d2ca; font-family: inherit; font-size: 14px;
  line-height: 1.85; text-align: left; cursor: pointer;
}
.rt-story-choice:hover, .rt-story-choice:focus-visible { outline: none; border-color: #d8a848; }
`;

/* ── 素材 ── */

type Sheet = 'idle' | 'move' | 'attack';

interface SpriteSet {
  idle?: HTMLImageElement;
  move?: HTMLImageElement;
  attack?: HTMLImageElement;
  /** 理智归零的配色。和地图一样，同一套字符画换调色板 */
  idleZero?: HTMLImageElement;
  moveZero?: HTMLImageElement;
  attackZero?: HTMLImageElement;
}

const SHEET_FRAMES: Record<Sheet, number> = { idle: 1, move: 2, attack: 3 };

function assetUrl(path: string): string {
  return new URL(`./${path}`, document.baseURI).href;
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    // 加载失败也要让原型跑起来 —— 退回色块，而不是白屏
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = assetUrl(path);
  });
}

async function loadSprites(sprite: string): Promise<SpriteSet> {
  // 两套配色一起加载 —— 都是几 KB 的小图，切换时才不会有白帧
  const [idle, move, attack, idleZero, moveZero, attackZero] = await Promise.all([
    loadImage(`characters/${sprite}/actions/idle.png`),
    loadImage(`characters/${sprite}/actions/move.png`),
    loadImage(`characters/${sprite}/actions/attack.png`),
    loadImage(`characters/${sprite}/actions/idle_zero.png`),
    loadImage(`characters/${sprite}/actions/move_zero.png`),
    loadImage(`characters/${sprite}/actions/attack_zero.png`),
  ]);
  return { idle, move, attack, idleZero, moveZero, attackZero };
}

function usable(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return img !== undefined && img.complete && img.naturalWidth > 0;
}

/**
 * 这一帧该画哪张图、第几格。
 *
 * 出招的三段【直接映射到素材的三帧】——
 * 这就是帧数据在画面上"被看见"的地方。如果起手帧画不出区别，
 * 玩家就没有任何依据可以躲。
 */
function pickFrame(
  e: Entity,
  tick: number,
  zero: boolean,
): { sheet?: HTMLImageElement; frame: number } {
  const set = sprites.get(e.id);
  if (set === undefined) return { frame: 0 };

  /*
   * 【归零时换一套配色】—— 和地图一样，同一套字符画换调色板。
   * 角色也要换：只有地图变红、人还是原色的话，看起来像两个世界拼在一起。
   * 缺图就退回原色，不硬闪。
   */
  const pickSheet = (normal?: HTMLImageElement, zeroed?: HTMLImageElement) =>
    zero && usable(zeroed) ? zeroed : normal;

  const phase = actionPhase(e.action);
  if (phase === 'startup') return { sheet: pickSheet(set.attack, set.attackZero), frame: 0 };
  if (phase === 'active') return { sheet: pickSheet(set.attack, set.attackZero), frame: 1 };
  if (phase === 'recovery') return { sheet: pickSheet(set.attack, set.attackZero), frame: 2 };

  // 在动就走走路动画。用 tick 而不是真实时间 —— 保持确定性
  const moving = Math.abs(e.body.vx) > 1 || Math.abs(e.body.vy) > 1;
  if (moving) {
    return {
      sheet: pickSheet(set.move, set.moveZero),
      frame: Math.floor(tick / WALK_FRAME_TICKS) % SHEET_FRAMES.move,
    };
  }
  return { sheet: pickSheet(set.idle, set.idleZero), frame: 0 };
}


/* ── 输入 ── */

interface InputRig {
  consume(): InputState;
  attach(): void;
  destroy(): void;
  /** 按住攻击键时不给连发：攻击是边沿触发的 */
  pressAttack(): void;
}

function createInputRig(
  wheelEl: HTMLElement,
  knobEl: HTMLElement,
  attackEl: HTMLElement,
  heavyEl: HTMLElement,
  onInteract?: () => void,
): InputRig {
  let moveX = 0;
  let moveY = 0;
  let attackPending = false;
  let heavyPending = false;
  let wheelPointer: number | null = null;
  const keys = new Set<string>();

  function refreshKeys(): void {
    if (wheelPointer !== null) return; // 轮盘在用时不读键盘，否则两边打架
    const up = keys.has('w') || keys.has('arrowup');
    const down = keys.has('s') || keys.has('arrowdown');
    const left = keys.has('a') || keys.has('arrowleft');
    const right = keys.has('d') || keys.has('arrowright');
    const x = (right ? 1 : 0) - (left ? 1 : 0);
    const y = (down ? 1 : 0) - (up ? 1 : 0);
    const len = Math.hypot(x, y);
    moveX = len === 0 ? 0 : x / len;
    moveY = len === 0 ? 0 : y / len;
  }

  function onKeyDown(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'j') {
      attackPending = true;
      e.preventDefault();
      return;
    }
    if (k === 'k') {
      // 重击。只有一种攻击的话，帧数据里"轻/重"的差别就白设计了
      heavyPending = true;
      e.preventDefault();
      return;
    }
    if (k === 'e') {
      // 【一个键，上下文决定】—— 脚下有东西就捡，没有才插蜡烛。
      // 分成两个键的话，手机端要多一个按钮，而这两件事永远不会同时想做
      onInteract?.();
      e.preventDefault();
      return;
    }
    if (k.startsWith('arrow') || 'wasd'.includes(k)) {
      keys.add(k);
      refreshKeys();
      e.preventDefault();
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    keys.delete(e.key.toLowerCase());
    refreshKeys();
  }

  function wheelMove(e: PointerEvent): void {
    if (e.pointerId !== wheelPointer) return;
    const r = wheelEl.getBoundingClientRect();
    const radius = r.width / 2;
    const dx = e.clientX - (r.left + radius);
    const dy = e.clientY - (r.top + radius);
    const len = Math.hypot(dx, dy);

    if (len < radius * 0.15) {
      moveX = 0;
      moveY = 0;
      knobEl.style.transform = 'translate(0,0)';
      return;
    }
    const clamped = Math.min(len, radius);
    const nx = (dx / len) * clamped;
    const ny = (dy / len) * clamped;
    moveX = nx / radius;
    moveY = ny / radius;
    knobEl.style.transform = `translate(${nx}px, ${ny}px)`;
  }

  function onWheelDown(e: PointerEvent): void {
    wheelPointer = e.pointerId;
    wheelEl.setPointerCapture(e.pointerId);
    wheelMove(e);
    e.preventDefault();
  }

  function onWheelUp(e: PointerEvent): void {
    if (e.pointerId !== wheelPointer) return;
    wheelPointer = null;
    moveX = 0;
    moveY = 0;
    knobEl.style.transform = 'translate(0,0)';
  }

  function onAttackDown(e: Event): void {
    attackPending = true;
    e.preventDefault();
  }

  /**
   * 重击按钮。触屏没有 K 键 —— 不给按钮的话，
   * 重击在手机上等于不存在，而那正是"轻/重"设计的全部意义。
   */
  function onHeavyDown(e: Event): void {
    heavyPending = true;
    e.preventDefault();
  }

  return {
    consume(): InputState {
      const snap: InputState = {
        moveX,
        moveY,
        attack: attackPending,
        heavy: heavyPending,
        use: false,
      };
      // 边沿触发：这一 tick 用掉就清掉
      attackPending = false;
      heavyPending = false;
      return snap;
    },
    pressAttack(): void {
      attackPending = true;
    },
    attach(): void {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      wheelEl.addEventListener('pointerdown', onWheelDown);
      wheelEl.addEventListener('pointermove', wheelMove);
      wheelEl.addEventListener('pointerup', onWheelUp);
      wheelEl.addEventListener('pointercancel', onWheelUp);
      attackEl.addEventListener('pointerdown', onAttackDown);

  // 重击按钮。触屏没有 K 键，不给按钮的话重击在手机上等于不存在
  heavyEl.addEventListener('pointerdown', onHeavyDown);
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      wheelEl.removeEventListener('pointerdown', onWheelDown);
      wheelEl.removeEventListener('pointermove', wheelMove);
      wheelEl.removeEventListener('pointerup', onWheelUp);
      wheelEl.removeEventListener('pointercancel', onWheelUp);
      attackEl.removeEventListener('pointerdown', onAttackDown);
      heavyEl.removeEventListener('pointerdown', onHeavyDown);
    },
  };
}

/* ── 主入口 ── */

/** 实体 id → 精灵集。放在模块级是为了让 pickFrame 不用透传参数 */
const sprites = new Map<string, SpriteSet>();
/** 实体 id → 敌人定义 id，调试输出用 */
const names = new Map<string, string>();

export function startRtPrototype(root: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'rt-wrap';

  const bar = document.createElement('div');
  bar.className = 'rt-bar';
  const stat = document.createElement('span');
  // 先填上 —— fps 要半秒后才算得出来，空着的话屏幕上就是一片空白，
  // 看起来像坏了
  stat.innerHTML = '<b>--</b> fps &nbsp; tick <b>0</b>';
  const hint = document.createElement('span');
  hint.className = 'keys';
  hint.innerHTML = 'WASD 移动 &nbsp;·&nbsp; <b>空格 / J</b> 轻击 &nbsp;·&nbsp; <b>K</b> 重击 &nbsp;·&nbsp; <b>E</b> 交互';
  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.textContent = '返回主菜单';
  bar.append(stat, hint, exitBtn);

  const stage = document.createElement('div');
  stage.className = 'rt-stage';
  // canvas 先不建 —— 要等量完 stage 的真实尺寸才能决定画多大（见 planRoom）

  const hintBar = document.createElement('div');
  hintBar.className = 'rt-hint';
  hintBar.textContent =
    '第 4 步：打完等 1.5 秒会掉金色光点，走过去按 E 捡。调参：?drain= ?candle= ?spawn= ?san= ?seed=';

  const wheel = document.createElement('div');
  wheel.className = 'rt-wheel';
  const knob = document.createElement('div');
  knob.className = 'rt-knob';
  wheel.appendChild(knob);

  const attackBtn = document.createElement('button');
  attackBtn.type = 'button';
  attackBtn.className = 'rt-attack';
  attackBtn.textContent = '攻击';

  const heavyBtn = document.createElement('button');
  heavyBtn.type = 'button';
  heavyBtn.className = 'rt-heavy';
  heavyBtn.textContent = '重击';

  /* 全屏剧情层。内容由 renderStory() 填 —— 它跑在每一帧里 */
  const storyEl = document.createElement('section');
  storyEl.className = 'rt-story';
  const storyInner = document.createElement('div');
  storyInner.className = 'rt-story-inner';
  storyEl.appendChild(storyInner);

  wrap.append(bar, stage, hintBar);
  root.append(style, wrap, wheel, attackBtn, heavyBtn, storyEl);

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse) {
    wheel.classList.add('on');
    attackBtn.classList.add('on');
  heavyBtn.classList.add('on');
  }

  /* ── 量出可用空间，再决定房间多大、放大几倍 ── */

  const plan = planRoom(window.innerWidth, window.innerHeight);
  const canvas = document.createElement('canvas');
  canvas.width = plan.cols * TILE;
  canvas.height = plan.rows * TILE + WALL_TOP_H;
  canvas.style.width = `${plan.cols * TILE * plan.scale}px`;
  canvas.style.height = `${plan.rows * TILE * plan.scale}px`;
  stage.appendChild(canvas);

  /** 把格子坐标夹进房间内 —— 房间尺寸是算出来的，写死坐标会摆到墙里或墙外 */
  const clampCell = (v: number, max: number): number => Math.max(1, Math.min(v, max - 2));

  /* ── 开局 ── */

  /*
   * ?san=N 直接从某个理智值开局。
   *
   * 【为什么需要这个口子】自然流失是 12 秒 1 点，从 100 掉到 0 要二十分钟 ——
   * 也就是说"归零换肤"这个功能根本没法手动验证。
   * 调试口子就是为这种情况存在的：不是偷懒，是让功能可被看见。
   *
   * 顺带 ?seed= 也能换。
   */
  const qs = new URLSearchParams(location.search);
  const sanParam = Number(qs.get('san'));
  const seedParam = Number(qs.get('seed'));

  /**
   * 理智平衡的几个数做成可调的。
   *
   * 【为什么】这几个值是"必须真人试玩才调得动"的那一类 ——
   * 机器人测不出"压力够不够"。写成常量的话，每试一组都要改代码、
   * 等构建、等部署；做成参数就能连着试十组。
   *
   *   ?drain=720    自然流失：每多少 tick 掉 1 点（默认 720 = 12 秒）
   *   ?candle=1     手持蜡烛：每秒回多少理智（默认 1）
   *   ?spawn=480    刷怪基准间隔：多少 tick 一只（默认 480 = 8 秒）
   */
  const num = (key: string, fallback: number): number => {
    const v = Number(qs.get(key));
    return qs.has(key) && Number.isFinite(v) ? v : fallback;
  };

  const drainEvery = num('drain', 720);
  const candleRate = num('candle', 1);
  const spawnInterval = num('spawn', 480);

  const state: RtState = createInitialRtState({
    seed: Number.isFinite(seedParam) && seedParam !== 0 ? seedParam : 20261015,
    map: makeTestRoom(plan.cols, plan.rows),
    sanDrainEvery: drainEvery,
    ...(Number.isFinite(sanParam) && qs.has('san') ? { san: sanParam } : {}),
  });
  state.spawnConfig = { ...state.spawnConfig, baseInterval: spawnInterval };
  /*
   * 【实时刷怪的表必须传进去】—— createInitialRtState 的 spawnTable
   * 默认是空数组，不传的话"理智越低刷得越多"这条机制在原型里
   * 完全不生效，而且不报错，看起来一切正常。
   */
  state.spawnTable = [toSpawnTemplate(CRAWLER), toSpawnTemplate(ORDERLY)];
  // 玩家出生时理智回满，否则 ?san= 之外的参数都看不出效果
  state.san = Number.isFinite(sanParam) && qs.has('san') ? sanParam : state.sanMax;

  const player = findPlayer(state);
  if (player !== undefined) {
    player.attack = ARCHIVIST_LIGHT;
    player.heavyAttack = ARCHIVIST_HEAVY;
    player.hp = 22;
    player.hpMax = 22;
  }

  /** 按定义造一个敌人并挂上 AI。坐标会被安全化，保证不落在墙里 */
  function placeFoe(def: RtEnemyDef, tx: number, ty: number): Entity {
    const cell = findOpenCell(state.map, tx, ty);
    // 【用数据层的转换函数】—— 手写的话容易漏字段，
    // 之前就漏过 sanDrain，"怪靠近掉理智"在原型里根本不生效，还不报错
    const tpl = toSpawnTemplate(def);
    const e = spawn(state, {
      kind: 'enemy',
      x: cell.x * TILE + TILE / 2,
      y: cell.y * TILE + TILE / 2,
      hp: tpl.hp,
      speed: tpl.speed,
      hw: tpl.hw,
      hh: tpl.hh,
      attack: tpl.attack,
      sanDrain: tpl.sanDrain,
      ai: makeAiState(tpl.ai),
    });
    void loadSprites(def.sprite).then((s) => sprites.set(e.id, s));
    names.set(e.id, def.id);
    return e;
  }

  // 门洞两侧各一个爬行物（快、逼走位），右半边一个护工（慢、教读抬手）。
  // 【坐标必须按实际房间尺寸夹一遍】—— 房间大小是算出来的，
  // 写死的列号在窄屏上会落到墙外面，敌人就"消失"了
  const midC = Math.floor(plan.cols / 2);
  const midR = Math.floor(plan.rows / 2);
  placeFoe(CRAWLER, clampCell(midC + 3, plan.cols), clampCell(3, plan.rows));
  placeFoe(CRAWLER, clampCell(midC + 4, plan.cols), clampCell(plan.rows - 4, plan.rows));
  placeFoe(ORDERLY, clampCell(midC + 6, plan.cols), clampCell(midR, plan.rows));

  if (player !== undefined) {
    void loadSprites('dream_archivist').then((s) => sprites.set(player.id, s));

    /*
     * 玩家手里那根蜡烛。
     * 半径 4 格、每秒 +1 理智、燃料 90 秒 —— 见 docs/06 第九节。
     *
     * 恢复理智【只能】靠光。没有"吃药回理智"这个东西。
     */
    player.light = makeLight(4 * TILE, candleRate, 60 * 90);
  }

  /*
   * 墙上的固定光源。拿不走，所以它们定义了"安全区"在哪。
   * 玩家要记住哪里有灯 —— 那是他理智掉下去之后唯一能去的地方。
   */
  for (const [lx, ly] of [
    [clampCell(midC - 5, plan.cols), clampCell(midR, plan.rows)],
    [clampCell(plan.cols - 3, plan.cols), clampCell(2, plan.rows)],
  ] as const) {
    const cell = findOpenCell(state.map, lx, ly);
    spawn(state, {
      kind: 'light',
      x: cell.x * TILE + TILE / 2,
      y: cell.y * TILE + TILE / 2,
      // 半径 5 格、每秒 +2。比蜡烛强，但站在这儿就哪也去不了
      light: makeLight(5 * TILE, 2, -1),
    });
  }

  /**
   * 把手上的蜡烛插到地上。
   * 逻辑在 core（light.ts 的 plantCandle）—— UI 只负责触发，
   * 这样插地规则能被测试覆盖，而不是只有玩到才验证得了。
   */
  function plantCarriedCandle(): boolean {
    if (player === undefined) return false;
    return plantCandle(state, player) !== null;
  }

  const rig = createInputRig(wheel, knob, attackBtn, heavyBtn, () => {
    // 先看脚下有没有东西
    if (!tryPickup(state, [])) plantCarriedCandle();
  });
  rig.attach();

  const acc = createAccumulator();
  const ctx = canvas.getContext('2d');
  if (ctx !== null) ctx.imageSmoothingEnabled = false;

  /** 受击闪白：命中那一帧记下位置，之后画一小段 */
  const flashes: { x: number; y: number; ttl: number }[] = [];

  /**
   * 全屏剧情层。phase==='story' 时显示，选完消失。
   *
   * 【每帧重建 DOM】—— 剧情节点只在状态变化时变，
   * 但用一个 sig 挡住重复重建，避免每帧都重排。
   */
  let storySig = '';

  function renderStory(): void {
    const view = narrativeView(state);
    const node = getCurrentStory(view);

    if (node === undefined) {
      if (storySig !== '') {
        storySig = '';
        storyEl.classList.remove('show');
        storyInner.textContent = '';
      }
      return;
    }

    const idx = getVisibleChoiceIndices(view);
    const sig = `${node.id}:${idx.join(",")}`;
    if (sig === storySig) return;
    storySig = sig;

    storyInner.textContent = '';
    const text = document.createElement('div');
    text.className = 'rt-story-text';
    text.textContent = node.text;
    storyInner.appendChild(text);

    if (node.quote !== undefined && node.quote !== '') {
      const q = document.createElement('div');
      q.className = 'rt-story-quote';
      q.textContent = node.quote;
      storyInner.appendChild(q);
    }

    const list = document.createElement('div');
    list.className = 'rt-story-choices';
    for (const raw of idx) {
      const choice = node.choices[raw];
      if (choice === undefined) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rt-story-choice';
      btn.textContent = choice.text;
      // 【传的是原始下标】—— chooseInStory 要按它记 once
      btn.addEventListener('click', () => {
        chooseInStory(state, raw, []);
        storySig = '';
        renderStory();
      });
      list.appendChild(btn);
    }
    storyInner.appendChild(list);
    storyEl.classList.add('show');
  }

  let raf = 0;
  let last = performance.now();
  let frames = 0;
  let fpsTimer = 0;
  let fps = 0;

  function drawEntity(e: Entity): void {
    const { sheet, frame } = pickFrame(e, state.tick, isZeroState(state.san));
    // 精灵比格子高，脚底对齐碰撞体下沿
    const px = Math.round(e.body.x - SPR_W / 2);
    const py = Math.round(e.body.y + e.body.hh - SPR_H);

    if (ctx !== null) {
      /*
       * 脚下的影子。
       *
       * 【有影子和没影子，是"站着"和"浮着"的区别】—— 以撒式视角
       * 里角色比格子高，没有影子的话会显得贴在画面上而不是站在地上。
       * 椭圆用 arc + 缩放画，兼容性比 ellipse() 好（测试环境里的
       * 假 canvas 不一定有 ellipse）。
       */
      ctx.save();
      ctx.translate(e.body.x, e.body.y + e.body.hh - 1);
      ctx.scale(1, 0.32);
      ctx.beginPath();
      ctx.arc(0, 0, e.body.hw + 3, 0, Math.PI * 2);
      ctx.restore();
      ctx.fillStyle = 'rgba(4,4,8,0.5)';
      ctx.fill();
    }

    if (usable(sheet)) {
      ctx?.drawImage(sheet, frame * SPR_W, 0, SPR_W, SPR_H, px, py, SPR_W, SPR_H);
      return;
    }
    // 素材没好时的兜底：色块，但至少颜色能区分敌我。
    // 【光源不在此列】—— 它在上面就被 continue 挡掉了，
    // 一个青色方块在地上会被当成怪物
    if (ctx === null || e.kind === 'light') return;
    ctx.fillStyle = e.kind === 'player' ? '#d8a848' : '#4a6a68';
    ctx.fillRect(
      Math.round(e.body.x - e.body.hw),
      Math.round(e.body.y - e.body.hh),
      e.body.hw * 2,
      e.body.hh * 2,
    );
  }

  /** 敌人的"抬手预警"：起手期间在头顶画一条进度条 */
  function drawTelegraph(e: Entity): void {
    if (ctx === null) return;
    const def = e.action.def;
    if (def === null || actionPhase(e.action) !== 'startup') return;

    const total = def.startup;
    const p = total === 0 ? 1 : e.action.frame / total;
    const w = 16;
    const x = Math.round(e.body.x - w / 2);
    const y = Math.round(e.body.y + e.body.hh - SPR_H) - 5;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, w, 2);
    // 越接近打出来越红 —— 玩家不用数帧，看颜色就知道该躲了
    ctx.fillStyle = p > 0.6 ? '#e05a3a' : '#d8a848';
    ctx.fillRect(x, y, Math.max(1, Math.round(w * p)), 2);
  }

  /** 判定帧把扇形画出来 —— 调帧数据时肉眼能看出打向哪 */
  function drawSwing(e: Entity): void {
    if (ctx === null) return;
    const def = e.action.def;
    if (def === null || actionPhase(e.action) !== 'active') return;

    const len = Math.hypot(e.facing.x, e.facing.y) || 1;
    const dir = Math.atan2(e.facing.y / len, e.facing.x / len);
    const half = (def.arc / 2) * (Math.PI / 180);

    ctx.beginPath();
    ctx.moveTo(e.body.x, e.body.y);
    ctx.arc(e.body.x, e.body.y, def.range, dir - half, dir + half);
    ctx.closePath();
    ctx.fillStyle =
      e.kind === 'player' ? 'rgba(216,168,72,0.18)' : 'rgba(224,90,58,0.20)';
    ctx.fill();
  }

  function render(): void {
    if (ctx === null) return;
    const { map } = state;

    // 理智归零 → 整张地图换配色。玩家不用看数字就知道自己掉进去了
    const zero = isZeroState(state.san);
    const skin = zero ? tilesZero : tiles;

    /*
     * 先铺底，再把整个坐标系下移 WALL_TOP_H。
     *
     * 这样下面的绘制代码全部用【世界坐标】，不用到处 +16。
     * 顶部那一格留给最上面那排墙的顶面。
     */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = zero ? '#0b0505' : '#07070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, WALL_TOP_H);

    /*
     * 【两个判断不能混成一个】
     *
     * 越界在【碰撞】里算实心（玩家不能走出房间），但在【可见性】
     * 判断里必须算"不是墙"。
     *
     * 混用过的后果：上墙在 ty=0，检查"上方是不是墙"时问的是 ty=-1，
     * 越界返回 true → 顶面永远不画。表现是【上墙看起来还是平的】，
     * 而下墙正常 —— 因为下墙的上方是地板，不是越界。
     *
     * 这种 bug 很阴：一半对一半错，看起来像"风格不统一"而不是 bug。
     */
    const inBounds = (tx: number, ty: number): boolean =>
      tx >= 0 && ty >= 0 && tx < map.w && ty < map.h;

    /** 这一格是不是墙。越界算实心 —— 给碰撞语义用 */
    const isSolidAt = (tx: number, ty: number): boolean => {
      if (!inBounds(tx, ty)) return true;
      return map.tiles[ty * map.w + tx] !== TILE_FLOOR;
    };

    /** 这一格是不是墙。越界【不算】—— 给"要不要画顶面"用 */
    const isWallAt = (tx: number, ty: number): boolean => {
      if (!inBounds(tx, ty)) return false;
      return map.tiles[ty * map.w + tx] !== TILE_FLOOR;
    };

    /* 地面。只画不是墙的格子 —— 墙走下面的立体通道 */
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (isSolidAt(tx, ty)) continue;
        if (usable(skin.floor)) {
          ctx.drawImage(skin.floor, tx * TILE, ty * TILE, TILE, TILE);
        } else {
          ctx.fillStyle = zero ? '#1a0e0e' : '#12121a';
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
        }
      }
    }

    /* 光晕。在地面之上、立体物之下 —— 照亮地面，但不盖住人 */
    for (const e of state.entities) {
      const light = e.light;
      if (!e.alive || light === undefined || light.fuel === 0) continue;
      const g = ctx.createRadialGradient(
        e.body.x, e.body.y, 2,
        e.body.x, e.body.y, light.radius,
      );
      const warm = zero ? '224,112,58' : '216,168,72';
      g.addColorStop(0, `rgba(${warm},0.16)`);
      g.addColorStop(1, `rgba(${warm},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(
        e.body.x - light.radius, e.body.y - light.radius,
        light.radius * 2, light.radius * 2,
      );
    }

    /* 地面上的扇形判定。也是地贴，在立体物之下 */
    for (const e of state.entities) if (e.alive) drawSwing(e);

    /*
     * 【关键：逐行绘制】—— 这一行的墙，然后这一行的实体。
     *
     * 顺序就是深度：y 越大越靠近镜头。必须一行一行来，
     * 不能"先画所有墙、再画所有人"—— 那样站在墙上方的角色会盖住墙，
     * 而正确的结果是墙的顶面挡住他的脚。
     *
     * 墙的顶面上移一格画在正面之上，这是以撒式立体感的全部来源。
     * 只在【上方不是墙】时才画，否则一排竖着的墙会出现阶梯。
     */
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (!isSolidAt(tx, ty)) continue;
        const px = tx * TILE;
        const py = ty * TILE;

        if (usable(skin.wall)) {
          ctx.drawImage(skin.wall, px, py, TILE, TILE);
        } else {
          ctx.fillStyle = zero ? '#331818' : '#272733';
          ctx.fillRect(px, py, TILE, TILE);
        }

        /*
         * 墙根落在下方地板上的投影。
         *
         * 【这是立体感最有效的那条线索】—— 没有影子的墙只是
         * "颜色深一点的地板"。有了影子，墙才"压"在地面上。
         *
         * 用三段实心矩形拼出渐变，不用 createLinearGradient：
         * 每格建一个渐变的话，60fps 下一屏几百个墙就是每秒几万个对象，
         * GC 会抖。三段在像素尺度上看起来是一样的。
         */
        if (!isSolidAt(tx, ty + 1)) {
          ctx.fillStyle = 'rgba(0,0,0,0.50)';
          ctx.fillRect(px, py + TILE, TILE, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.26)';
          ctx.fillRect(px, py + TILE + 2, TILE, 2);
          ctx.fillStyle = 'rgba(0,0,0,0.11)';
          ctx.fillRect(px, py + TILE + 4, TILE, 2);
        }

        if (!isWallAt(tx, ty - 1)) {
          if (usable(skin.wallTop)) {
            ctx.drawImage(skin.wallTop, px, py - TILE, TILE, TILE);
          } else {
            ctx.fillStyle = zero ? '#42201f' : '#343442';
            ctx.fillRect(px, py - TILE, TILE, TILE);
          }
        }
      }

      // 这一行的实体。用【身体中心】所在的行排序 —— 遮挡看的就是脚在哪
      for (const e of state.entities) {
        if (!e.alive) continue;
        if (Math.floor(e.body.y / TILE) !== ty) continue;

        if (e.kind === 'light') {
          // 光源用素材画。没有素材就【不画】—— 绝不退回色块：
          // 一个青色的方块在地上会被当成怪物，比不画还糟
          const fuel = e.light?.fuel ?? -1;
          const art = fuel < 0 ? lightArt.lamp : lightArt.candle;
          if (usable(art)) {
            ctx.drawImage(
              art,
              Math.round(e.body.x - TILE / 2),
              Math.round(e.body.y - TILE / 2),
              TILE,
              TILE,
            );
          }
          continue;
        }

        if (e.kind === 'item') {
          // 掉落物：跳动的光点。关键是玩家要能看见"这里有东西"
          const t = (state.tick % 60) / 60;
          const r = 3 + Math.sin(t * Math.PI * 2) * 1.2;
          ctx.beginPath();
          ctx.arc(e.body.x, e.body.y, r, 0, Math.PI * 2);
          ctx.fillStyle = '#d8a848';
          ctx.fill();
          ctx.strokeStyle = 'rgba(216,168,72,0.4)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(e.body.x, e.body.y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }

        drawEntity(e);
        drawTelegraph(e);
      }
    }

    // 受击闪
    for (const f of flashes) {
      const a = Math.max(0, f.ttl / 6);
      ctx.fillStyle = `rgba(255,220,180,${a * 0.8})`;
      ctx.fillRect(Math.round(f.x) - 8, Math.round(f.y) - 10, 16, 20);
    }

    // 玩家脚下的碰撞框：调手感时有用，正式版会去掉
    const p = findPlayer(state);
    if (p !== undefined) {
      ctx.strokeStyle = 'rgba(216,168,72,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(p.body.x - p.body.hw) + 0.5,
        Math.round(p.body.y - p.body.hh) + 0.5,
        p.body.hw * 2,
        p.body.hh * 2,
      );
    }
  }

  const tiles: { floor?: HTMLImageElement; wall?: HTMLImageElement; wallTop?: HTMLImageElement } = {};
  /** 光源的素材：壁灯（拿不走）和蜡烛（地上的）。实体没精灵，单独管 */
  const lightArt: { lamp?: HTMLImageElement; candle?: HTMLImageElement } = {};
  /**
   * 理智归零后的地图配色。
   *
   * 【同一批瓦片，另一套调色板】—— 见 tools/gen-assets.mjs。
   * 所以"归零换风格"不用画两套图，多加载两份 PNG 就够了。
   */
  const tilesZero: { floor?: HTMLImageElement; wall?: HTMLImageElement; wallTop?: HTMLImageElement } = {};

  function fitCanvas(): void {
    // 尺寸变化（转屏 / 地址栏收放）时重新算缩放。
    // 【不重新规划房间】—— 那等于把这一局重置了。
    const s = Math.min(
      (stage.clientWidth - 4) / canvas.width,
      (stage.clientHeight - 4) / canvas.height,
    );

    /*
     * 能用整数倍就用整数倍 —— 非整数倍会让像素大小不均匀，
     * 一个像素忽大忽小是像素风最难看的失败方式。
     *
     * 【但放不下时必须允许小数】。
     * 曾经写成 Math.max(1, Math.floor(s))：当画布比可用空间还大时
     * floor 得到 0，max(1, 0) 又把它拉回 1 —— 于是怎么也缩不下去，
     * 房间右侧连人带怪被挤到屏幕外面，表现就是"这个敌人不见了"。
     * 宁可像素稍微不齐，也不能有东西看不见。
     */
    const scale = s >= 1 ? Math.floor(s) : Math.max(0.2, s);
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }

  function frame(now: number): void {
    const realDt = (now - last) / 1000;
    last = now;

    const ticks = acc.advance(Math.min(realDt, 0.25));
    for (let i = 0; i < ticks; i++) {
      const events = tickRt(state, rig.consume());
      for (const ev of events) {
        // attack 事件只带 id，位置要自己查 —— 事件不背实体坐标，
        // 因为那一帧之后目标可能已经被清掉了
        if (ev.type === 'attack') {
          const t = state.entities.find((x) => x.id === ev.target);
          if (t !== undefined) flashes.push({ x: t.body.x, y: t.body.y, ttl: 6 });
        }
      }
      for (const f of flashes) f.ttl--;
      for (let k = flashes.length - 1; k >= 0; k--) {
        if ((flashes[k]?.ttl ?? 0) <= 0) flashes.splice(k, 1);
      }
    }

    render();
    renderStory();

    frames++;
    fpsTimer += realDt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(frames / fpsTimer);
      const sanPct = Math.round((state.san / state.sanMax) * 100);
      const sanColor = isZeroState(state.san)
        ? '#e05a3a'
        : state.san < 40
          ? '#c98a3a'
          : '#5a8ac4';
      frames = 0;
      fpsTimer = 0;
      const p = findPlayer(state);
      const foes = state.entities.filter((e) => e.kind === 'enemy' && e.alive);
      // 把每个敌人的格子坐标打出来 —— 只看画面的话，
      // "没生成"和"生成了但落在墙里/画不出来"分辨不出来
      const foeDump = foes
        .map(
          (e) =>
            `${names.get(e.id) ?? '?'}@${Math.round(e.body.x / TILE)},${Math.round(e.body.y / TILE)}`,
        )
        .join(' ');
      stat.innerHTML =
        `<b>${fps}</b> fps &nbsp; tick <b>${state.tick}</b>` +
        ` &nbsp; 理智 <b style="color:${sanColor}">${Math.round(state.san)}</b>/${state.sanMax}` +
        `<span style="display:inline-block;width:64px;height:5px;background:#22222b;vertical-align:middle;margin-left:4px">` +
        `<span style="display:block;height:5px;width:${sanPct}%;background:${sanColor}"></span></span>` +
        (p !== undefined && p.light !== undefined
          ? ` &nbsp; 烛 <b>${Math.ceil(p.light.fuel / 60)}</b>s`
          : ` &nbsp; 烛 <b>—</b>`) +
        ` &nbsp; 房 <b>${plan.cols}×${plan.rows}@${plan.scale}</b>` +
        ` &nbsp; 视口 <b>${window.innerWidth}×${window.innerHeight}</b>` +
        (p !== undefined
          ? ` &nbsp; HP <b class="hp">${p.hp}</b>/${p.hpMax}` +
            ` &nbsp; 我@${Math.round(p.body.x / TILE)},${Math.round(p.body.y / TILE)}`
          : '') +
        ` &nbsp; 敌 <b>${foes.length}</b> ${foeDump}`;
    }

    raf = requestAnimationFrame(frame);
  }

  const onResize = (): void => fitCanvas();
  window.addEventListener('resize', onResize);

  void Promise.all([
    loadImage('map/floor.png'),
    loadImage('map/wall.png'),
    loadImage('map/wall_top.png'),
    loadImage('map/zero/floor.png'),
    loadImage('map/zero/wall.png'),
    loadImage('map/zero/wall_top.png'),
  ]).then(([f, w, wt, zf, zw, zwt]) => {
    tiles.floor = f;
    tiles.wall = w;
    tiles.wallTop = wt;
    tilesZero.floor = zf;
    tilesZero.wall = zw;
    tilesZero.wallTop = zwt;
  });
  void Promise.all([loadImage('map/wall_lamp.png'), loadImage('map/candle.png')]).then(
    ([lamp, candle]) => {
      lightArt.lamp = lamp;
      lightArt.candle = candle;
    },
  );

  fitCanvas();
  raf = requestAnimationFrame(frame);

  exitBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('rt-exit'));
  });

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    rig.destroy();
    sprites.clear();
    wrap.remove();
    wheel.remove();
    attackBtn.remove();
    heavyBtn.remove();
    storyEl.remove();
    style.remove();
  };
}

/* 让"跑一段固定输入"在调试时可用（控制台里调参用） */
export function simulate(state: RtState, input: InputState, ticks: number): void {
  runTicks(state, input, ticks);
}

/* 供测试断言用 */
export function frameCountOf(as: ActionState): number {
  return as.def === null ? 0 : totalFrames(as.def);
}

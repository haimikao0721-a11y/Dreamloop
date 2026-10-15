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
  makeTestRoom,
  runTicks,
  spawn,
  tickRt,
  totalFrames,
} from '@core/rt/index.js';
import type { ActionState, Entity, InputState, RtState } from '@core/rt/index.js';
import { ARCHIVIST_LIGHT } from '@data/rt/actions.js';
import { CRAWLER, ORDERLY } from '@data/rt/enemies.js';
import type { RtEnemyDef } from '@data/rt/enemies.js';

const ROOM_W = 21;
const ROOM_H = 15;
/** 精灵尺寸，和 tools/gen-assets.mjs 里的一致 */
const SPR_W = 16;
const SPR_H = 24;
/** 移动动画每几帧换一次图。4 tick ≈ 15fps 的走路节奏 */
const WALK_FRAME_TICKS = 8;

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
  display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
  padding: calc(env(safe-area-inset-top) + 8px) 12px 8px;
  font-size: 12px; color: #6b6b7a;
}
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
.rt-attack:active { background: rgba(216,168,72,0.5); }
.rt-hint { padding: 0 12px calc(env(safe-area-inset-bottom) + 10px); font-size: 11px; color: #52525f; }
`;

/* ── 素材 ── */

type Sheet = 'idle' | 'move' | 'attack';

interface SpriteSet {
  idle?: HTMLImageElement;
  move?: HTMLImageElement;
  attack?: HTMLImageElement;
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
  const [idle, move, attack] = await Promise.all([
    loadImage(`characters/${sprite}/actions/idle.png`),
    loadImage(`characters/${sprite}/actions/move.png`),
    loadImage(`characters/${sprite}/actions/attack.png`),
  ]);
  return { idle, move, attack };
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
function pickFrame(e: Entity, tick: number): { sheet?: HTMLImageElement; frame: number } {
  const set = sprites.get(e.id);
  if (set === undefined) return { frame: 0 };

  const phase = actionPhase(e.action);
  if (phase === 'startup') return { sheet: set.attack, frame: 0 };
  if (phase === 'active') return { sheet: set.attack, frame: 1 };
  if (phase === 'recovery') return { sheet: set.attack, frame: 2 };

  // 在动就走走路动画。用 tick 而不是真实时间 —— 保持确定性
  const moving = Math.abs(e.body.vx) > 1 || Math.abs(e.body.vy) > 1;
  if (moving) {
    return { sheet: set.move, frame: Math.floor(tick / WALK_FRAME_TICKS) % SHEET_FRAMES.move };
  }
  return { sheet: set.idle, frame: 0 };
}

/* ── 输入 ── */

interface InputRig {
  consume(): InputState;
  attach(): void;
  destroy(): void;
  /** 按住攻击键时不给连发：攻击是边沿触发的 */
  pressAttack(): void;
}

function createInputRig(wheelEl: HTMLElement, knobEl: HTMLElement, attackEl: HTMLElement): InputRig {
  let moveX = 0;
  let moveY = 0;
  let attackPending = false;
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

  return {
    consume(): InputState {
      const snap: InputState = { moveX, moveY, attack: attackPending, use: false };
      // 边沿触发：这一 tick 用掉就清掉
      attackPending = false;
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
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      wheelEl.removeEventListener('pointerdown', onWheelDown);
      wheelEl.removeEventListener('pointermove', wheelMove);
      wheelEl.removeEventListener('pointerup', onWheelUp);
      wheelEl.removeEventListener('pointercancel', onWheelUp);
      attackEl.removeEventListener('pointerdown', onAttackDown);
    },
  };
}

/* ── 主入口 ── */

/** 实体 id → 精灵集。放在模块级是为了让 pickFrame 不用透传参数 */
const sprites = new Map<string, SpriteSet>();

export function startRtPrototype(root: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'rt-wrap';

  const bar = document.createElement('div');
  bar.className = 'rt-bar';
  const stat = document.createElement('span');
  const hint = document.createElement('span');
  hint.innerHTML = 'WASD 移动 &nbsp;·&nbsp; <b>空格 / J</b> 攻击';
  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.textContent = '返回主菜单';
  bar.append(stat, hint, exitBtn);

  const stage = document.createElement('div');
  stage.className = 'rt-stage';
  const canvas = document.createElement('canvas');
  canvas.width = ROOM_W * TILE;
  canvas.height = ROOM_H * TILE;
  stage.appendChild(canvas);

  const hintBar = document.createElement('div');
  hintBar.className = 'rt-hint';
  hintBar.textContent =
    '第 2 步原型：看怪物抬手 → 绕后或后退 → 它打空收招 → 你反击。';

  const wheel = document.createElement('div');
  wheel.className = 'rt-wheel';
  const knob = document.createElement('div');
  knob.className = 'rt-knob';
  wheel.appendChild(knob);

  const attackBtn = document.createElement('button');
  attackBtn.type = 'button';
  attackBtn.className = 'rt-attack';
  attackBtn.textContent = '攻击';

  wrap.append(bar, stage, hintBar);
  root.append(style, wrap, wheel, attackBtn);

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse) {
    wheel.classList.add('on');
    attackBtn.classList.add('on');
  }

  /* ── 开局 ── */

  const state: RtState = createInitialRtState({
    seed: 20261015,
    map: makeTestRoom(ROOM_W, ROOM_H),
  });

  const player = findPlayer(state);
  if (player !== undefined) {
    player.attack = ARCHIVIST_LIGHT;
    player.hp = 22;
    player.hpMax = 22;
  }

  /** 按定义造一个敌人并挂上 AI */
  function placeFoe(def: RtEnemyDef, tx: number, ty: number): Entity {
    const e = spawn(state, {
      kind: 'enemy',
      x: tx * TILE,
      y: ty * TILE,
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
    void loadSprites(def.sprite).then((s) => sprites.set(e.id, s));
    return e;
  }

  // 门洞两侧各一个爬行物（快、逼走位），右半边一个护工（慢、教读抬手）
  placeFoe(CRAWLER, 14, 4);
  placeFoe(CRAWLER, 16, 11);
  placeFoe(ORDERLY, 17, 7);

  if (player !== undefined) {
    void loadSprites('dream_archivist').then((s) => sprites.set(player.id, s));
  }

  const rig = createInputRig(wheel, knob, attackBtn);
  rig.attach();

  const acc = createAccumulator();
  const ctx = canvas.getContext('2d');
  if (ctx !== null) ctx.imageSmoothingEnabled = false;

  /** 受击闪白：命中那一帧记下位置，之后画一小段 */
  const flashes: { x: number; y: number; ttl: number }[] = [];

  let raf = 0;
  let last = performance.now();
  let frames = 0;
  let fpsTimer = 0;
  let fps = 0;

  function drawEntity(e: Entity): void {
    const { sheet, frame } = pickFrame(e, state.tick);
    // 精灵比格子高，脚底对齐碰撞体下沿
    const px = Math.round(e.body.x - SPR_W / 2);
    const py = Math.round(e.body.y + e.body.hh - SPR_H);

    if (usable(sheet)) {
      ctx?.drawImage(sheet, frame * SPR_W, 0, SPR_W, SPR_H, px, py, SPR_W, SPR_H);
      return;
    }
    // 素材没好时的兜底：色块，但至少颜色能区分敌我
    if (ctx === null) return;
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

    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        const solid = map.tiles[ty * map.w + tx] !== TILE_FLOOR;
        const img = solid ? tiles.wall : tiles.floor;
        if (usable(img)) {
          ctx.drawImage(img, tx * TILE, ty * TILE, TILE, TILE);
        } else {
          ctx.fillStyle = solid ? '#272733' : '#12121a';
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
        }
      }
    }

    // 先画地面上的扇形，再画实体 —— 判定框不该盖住人
    for (const e of state.entities) if (e.alive) drawSwing(e);

    for (const e of state.entities) {
      if (!e.alive) continue;
      drawEntity(e);
      drawTelegraph(e);
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

  const tiles: { floor?: HTMLImageElement; wall?: HTMLImageElement } = {};

  function fitCanvas(): void {
    // 整数倍缩放 —— 非整数倍会让像素大小不均匀
    const s = Math.min(
      (stage.clientWidth - 16) / canvas.width,
      (stage.clientHeight - 16) / canvas.height,
    );
    const scale = Math.max(1, Math.floor(s));
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
        if (ev.type === 'hit' && typeof ev.x === 'number' && typeof ev.y === 'number') {
          flashes.push({ x: ev.x, y: ev.y, ttl: 6 });
        }
      }
      for (const f of flashes) f.ttl--;
      for (let k = flashes.length - 1; k >= 0; k--) {
        if ((flashes[k]?.ttl ?? 0) <= 0) flashes.splice(k, 1);
      }
    }

    render();

    frames++;
    fpsTimer += realDt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(frames / fpsTimer);
      frames = 0;
      fpsTimer = 0;
      const p = findPlayer(state);
      const foes = state.entities.filter((e) => e.kind === 'enemy' && e.alive).length;
      stat.innerHTML =
        `<b>${fps}</b> fps &nbsp; tick <b>${state.tick}</b>` +
        (p !== undefined ? ` &nbsp; HP <b class="hp">${p.hp}</b>/${p.hpMax}` : '') +
        ` &nbsp; 敌人 <b>${foes}</b>`;
    }

    raf = requestAnimationFrame(frame);
  }

  const onResize = (): void => fitCanvas();
  window.addEventListener('resize', onResize);

  void Promise.all([loadImage('map/floor.png'), loadImage('map/wall.png')]).then(([f, w]) => {
    tiles.floor = f;
    tiles.wall = w;
  });

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

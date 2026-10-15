/**
 * ════════════════════════════════════════════════════════════════
 *  ui-web/rt-view.ts —— 实时层原型（第 1 步验收用）
 * ════════════════════════════════════════════════════════════════
 *
 *  这一步只验收一件事：【玩家能在屏幕上推着走，且穿不过墙】。
 *
 *  没有战斗、没有敌人、没有理智 —— 那些是第 2、3 步。
 *  故意做得这么薄，是为了在第 1 步就能确认地基（固定时间步 + 碰撞）
 *  是对的。地基歪了，上面盖什么都白搭。
 *
 *  和现有的回合制界面【完全并存】：走 ?proto=rt 才进这里，
 *  不带参数还是原来的游戏。
 * ════════════════════════════════════════════════════════════════
 */

import {
  TILE,
  TILE_FLOOR,
  createAccumulator,
  createInitialRtState,
  findPlayer,
  makeTestRoom,
  tickRt,
} from '@core/rt/index.js';
import type { InputState, RtState } from '@core/rt/index.js';

const ROOM_W = 21;
const ROOM_H = 15;

/* ── 样式：只作用于原型，不污染主界面 ── */

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
  display: flex; gap: 14px; align-items: center;
  padding: calc(env(safe-area-inset-top) + 8px) 12px 8px;
  font-size: 12px; color: #6b6b7a; flex-wrap: wrap;
}
.rt-bar b { color: #d8a848; font-weight: normal; }
.rt-bar button {
  margin-left: auto; padding: 6px 14px;
  background: #16161d; border: 1px solid #2c2c38; border-radius: 6px;
  color: #b9b9c4; font-family: inherit; font-size: 12px; cursor: pointer;
}
.rt-bar button:hover { border-color: #d8a848; }
.rt-stage { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
.rt-stage canvas {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
}
/* 轮盘：不透明度做低，不挡视线；只在触摸设备上出现 */
.rt-wheel {
  position: fixed; left: calc(env(safe-area-inset-left) + 18px);
  bottom: calc(env(safe-area-inset-bottom) + 18px);
  width: 128px; height: 128px; border-radius: 50%;
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
  border-radius: 50%; background: rgba(216,168,72,0.65);
  pointer-events: none;
}
.rt-hint { padding: 0 12px calc(env(safe-area-inset-bottom) + 10px); font-size: 11px; color: #52525f; }
`;

/* ── 素材 ── */

interface Assets {
  floor: HTMLImageElement;
  wall: HTMLImageElement;
  player: HTMLImageElement;
}

/** 相对 URL —— 子目录部署（/Dreamloop/）下也能解析对 */
function assetUrl(path: string): string {
  return new URL(`./${path}`, document.baseURI).href;
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    // 素材加载失败也要让原型跑起来 —— 退回色块，而不是白屏
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = assetUrl(path);
  });
}

async function loadAssets(): Promise<Assets> {
  const [floor, wall, player] = await Promise.all([
    loadImage('map/floor.png'),
    loadImage('map/wall.png'),
    loadImage('characters/dream_archivist/actions/idle.png'),
  ]);
  return { floor, wall, player };
}

/* ── 输入 ── */

interface InputRig {
  input: InputState;
  /** 每 tick 取一次输入；attack 是边沿触发的，取完就清 */
  consume(): InputState;
  attach(): void;
  destroy(): void;
  readonly usesTouch: boolean;
}

function createInputRig(wheelEl: HTMLElement, knobEl: HTMLElement): InputRig {
  let moveX = 0;
  let moveY = 0;
  let attackPending = false;
  let wheelPointer: number | null = null;
  const keys = new Set<string>();

  function refreshKeys(): void {
    // 轮盘在用的时候不读键盘，否则手指和键盘会互相打架
    if (wheelPointer !== null) return;
    const up = keys.has('w') || keys.has('arrowup');
    const down = keys.has('s') || keys.has('arrowdown');
    const left = keys.has('a') || keys.has('arrowleft');
    const right = keys.has('d') || keys.has('arrowright');
    const x = (right ? 1 : 0) - (left ? 1 : 0);
    const y = (down ? 1 : 0) - (up ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len === 0) {
      moveX = 0;
      moveY = 0;
    } else {
      moveX = x / len;
      moveY = y / len;
    }
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
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = r.width / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const len = Math.hypot(dx, dy);

    // 死区：手指落在中心附近会抖，不去掉角色会一直微微飘
    if (len < radius * 0.15) {
      moveX = 0;
      moveY = 0;
      knobEl.style.transform = 'translate(0,0)';
      return;
    }
    // 上限：手指拖到轮盘外很远，不裁剪就等于开了加速挂
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

  return {
    get input(): InputState {
      return { moveX, moveY, attack: attackPending, use: false };
    },
    consume(): InputState {
      const snap: InputState = { moveX, moveY, attack: attackPending, use: false };
      // 边沿触发：这一 tick 用掉就清掉，
      // 否则按住不放会变成"自动连打"，起手帧的意义就没了
      attackPending = false;
      return snap;
    },
    attach(): void {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      wheelEl.addEventListener('pointerdown', onWheelDown);
      wheelEl.addEventListener('pointermove', wheelMove);
      wheelEl.addEventListener('pointerup', onWheelUp);
      wheelEl.addEventListener('pointercancel', onWheelUp);
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      wheelEl.removeEventListener('pointerdown', onWheelDown);
      wheelEl.removeEventListener('pointermove', wheelMove);
      wheelEl.removeEventListener('pointerup', onWheelUp);
      wheelEl.removeEventListener('pointercancel', onWheelUp);
    },
    get usesTouch(): boolean {
      return wheelPointer !== null;
    },
  };
}

/* ── 主入口 ── */

export function startRtPrototype(root: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'rt-wrap';

  const bar = document.createElement('div');
  bar.className = 'rt-bar';
  const stat = document.createElement('span');
  const hint = document.createElement('span');
  hint.innerHTML = 'WASD / 方向键移动 &nbsp;·&nbsp; <b>?</b> 参数：<b>?proto=rt</b>';
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
  hintBar.textContent = '第 1 步原型：只有移动和碰撞。战斗 / 敌人 / 理智在第 2、3 步。';

  const wheel = document.createElement('div');
  wheel.className = 'rt-wheel';
  const knob = document.createElement('div');
  knob.className = 'rt-knob';
  wheel.appendChild(knob);

  wrap.append(bar, stage, hintBar);
  root.append(style, wrap, wheel);

  // 触摸设备才显示轮盘
  if (window.matchMedia('(pointer: coarse)').matches) wheel.classList.add('on');

  const state: RtState = createInitialRtState({
    seed: 20261015,
    map: makeTestRoom(ROOM_W, ROOM_H),
  });
  const rig = createInputRig(wheel, knob);
  rig.attach();

  const acc = createAccumulator();
  let assets: Assets | null = null;
  void loadAssets().then((a) => {
    assets = a;
  });

  const ctx = canvas.getContext('2d');
  if (ctx !== null) ctx.imageSmoothingEnabled = false;

  let raf = 0;
  let last = performance.now();
  let frames = 0;
  let fpsTimer = 0;
  let fps = 0;

  function render(): void {
    if (ctx === null) return;
    const { map } = state;

    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        const solid = map.tiles[ty * map.w + tx] !== TILE_FLOOR;
        const img = solid ? assets?.wall : assets?.floor;
        if (img !== null && img !== undefined && img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, tx * TILE, ty * TILE, TILE, TILE);
        } else {
          // 素材没加载好时的兜底：色块也要能看出墙和地板
          ctx.fillStyle = solid ? '#272733' : '#12121a';
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
        }
      }
    }

    const player = findPlayer(state);
    if (player !== undefined) {
      const w = 16;
      const h = 24;
      // 精灵比格子高，脚底对齐碰撞体下沿
      const px = Math.round(player.body.x - w / 2);
      const py = Math.round(player.body.y + player.body.hh - h);
      const img = assets?.player;
      if (img !== null && img !== undefined && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, px, py, w, h);
      } else {
        ctx.fillStyle = '#d8a848';
        ctx.fillRect(
          Math.round(player.body.x - player.body.hw),
          Math.round(player.body.y - player.body.hh),
          player.body.hw * 2,
          player.body.hh * 2,
        );
      }
    }

    // 画一次碰撞体轮廓：调碰撞时肉眼能看出判定框在哪，省一半调试时间
    if (player !== undefined) {
      ctx.strokeStyle = 'rgba(216,168,72,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(player.body.x - player.body.hw) + 0.5,
        Math.round(player.body.y - player.body.hh) + 0.5,
        player.body.hw * 2,
        player.body.hh * 2,
      );
    }
  }

  function fitCanvas(): void {
    // 整数倍缩放 —— 非整数倍会让像素大小不均匀，
    // 一个像素忽大忽小是像素风最难看的失败方式
    const availW = stage.clientWidth - 16;
    const availH = stage.clientHeight - 16;
    const s = Math.min(availW / canvas.width, availH / canvas.height);
    const scale = Math.max(1, Math.floor(s));
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }

  function frame(now: number): void {
    const realDt = (now - last) / 1000;
    last = now;

    // 真实 dt 也要封顶：切标签页回来时 realDt 可能是几十秒
    const ticks = acc.advance(Math.min(realDt, 0.25));
    for (let i = 0; i < ticks; i++) {
      tickRt(state, rig.consume());
    }

    render();

    frames++;
    fpsTimer += realDt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(frames / fpsTimer);
      frames = 0;
      fpsTimer = 0;
      const p = findPlayer(state);
      stat.innerHTML =
        `<b>${fps}</b> fps &nbsp; tick <b>${state.tick}</b>` +
        (p !== undefined
          ? ` &nbsp; x <b>${p.body.x.toFixed(1)}</b> y <b>${p.body.y.toFixed(1)}</b>`
          : '');
    }

    raf = requestAnimationFrame(frame);
  }

  const onResize = (): void => fitCanvas();
  window.addEventListener('resize', onResize);
  fitCanvas();
  raf = requestAnimationFrame(frame);

  exitBtn.addEventListener('click', () => {
    // 只通知外壳退出，不自己改 location —— 跳转是外壳的事
    window.dispatchEvent(new CustomEvent('rt-exit'));
  });

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    rig.destroy();
    wrap.remove();
    wheel.remove();
    style.remove();
  };
}

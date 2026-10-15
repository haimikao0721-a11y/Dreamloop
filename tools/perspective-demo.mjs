/**
 * ════════════════════════════════════════════════════════════════
 *  tools/perspective-demo.mjs —— 三种视角画法对比
 * ════════════════════════════════════════════════════════════════
 *
 *  【为什么要有这个脚本】
 *
 *  用户说"要《以撒》和《元气骑士》那种倾斜 45 度、有 3D 立体感的" ——
 *  但那两个游戏【都不是等距视角】，它们是俯视：
 *
 *      地面   = 平的方格，正上方看下去，完全没倾斜
 *      立体感 = 来自【墙有顶面】和【角色画成 3/4 侧身】
 *
 *  也就是说，"像以撒那样"和"真等距"是两条完全不同的路，
 *  而后者要重写整个渲染层。用文字争这个没意义 —— 画出来让他指。
 *
 *  这个脚本只做对比，不产出游戏素材，跑完可以删。
 *
 *    node tools/perspective-demo.mjs
 * ════════════════════════════════════════════════════════════════
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', '_perspective');

/* ── PNG 编码（和 gen-assets.mjs 同一套，那边没导出所以抄一份） ── */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 画布 ── */

const W = 460;
const H = 320;

/** 统一的调色板，和游戏里那套对上 */
const C = {
  bg: [10, 10, 14, 255],
  floor: [18, 18, 26, 255],
  floorLine: [28, 28, 38, 255],
  wallTop: [58, 58, 74, 255],
  wallFront: [36, 36, 48, 255],
  wallSide: [26, 26, 36, 255],
  wallLine: [72, 72, 92, 255],
  body: [96, 104, 128, 255],
  head: [176, 168, 152, 255],
  shadow: [6, 6, 10, 140],
  accent: [216, 168, 72, 255],
};

function makeCanvas() {
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = C.bg[0];
    buf[i * 4 + 1] = C.bg[1];
    buf[i * 4 + 2] = C.bg[2];
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function px(buf, x, y, col) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = col[3] / 255;
  buf[i] = Math.round(buf[i] * (1 - a) + col[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + col[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + col[2] * a);
  buf[i + 3] = 255;
}

function rect(buf, x, y, w, h, col) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(buf, x + i, y + j, col);
}

/** 菱形（等距的地面格）。用 |dx|/rx + |dy|/ry <= 1 判定 */
function diamond(buf, cx, cy, rx, ry, col) {
  for (let j = -ry; j <= ry; j++) {
    for (let i = -rx; i <= rx; i++) {
      if (Math.abs(i) / rx + Math.abs(j) / ry <= 1) px(buf, cx + i, cy + j, col);
    }
  }
}

/** 椭圆阴影 */
function ellipse(buf, cx, cy, rx, ry, col) {
  for (let j = -ry; j <= ry; j++) {
    for (let i = -rx; i <= rx; i++) {
      if ((i * i) / (rx * rx) + (j * j) / (ry * ry) <= 1) px(buf, cx + i, cy + j, col);
    }
  }
}

/* ── 同一间房 ── */

const COLS = 9;
const ROWS = 7;
/** 内部障碍 */
const BLOCKS = [
  [2, 2],
  [3, 2],
  [6, 4],
];

const isWall = (x, y) =>
  x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1 || BLOCKS.some(([bx, by]) => bx === x && by === y);

/** 玩家的格子位置 */
const PX = 4;
const PY = 5;

/* ══════════════════════════════════════════════════════════════
   ① 现在这样：纯俯视，墙是平的
   ══════════════════════════════════════════════════════════════ */

function drawTopDown() {
  const buf = makeCanvas();
  const T = 34;
  const ox = Math.round((W - COLS * T) / 2);
  const oy = Math.round((H - ROWS * T) / 2);

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const sx = ox + x * T;
      const sy = oy + y * T;
      if (isWall(x, y)) {
        rect(buf, sx, sy, T, T, C.wallFront);
        // 砖缝，和现在的素材一个意思
        rect(buf, sx, sy, T, 1, C.wallLine);
        rect(buf, sx, sy + Math.floor(T / 2), T, 1, C.wallLine);
        rect(buf, sx, sy, 1, T, C.wallLine);
        rect(buf, sx + Math.floor(T / 2), sy, 1, T, C.wallLine);
      } else {
        rect(buf, sx, sy, T, T, C.floor);
        rect(buf, sx, sy, T, 1, C.floorLine);
        rect(buf, sx, sy, 1, T, C.floorLine);
      }
    }
  }

  // 角色：小方块，居中
  const px0 = ox + PX * T + T / 2;
  const py0 = oy + PY * T + T / 2;
  ellipse(buf, px0, py0 + 8, 9, 4, C.shadow);
  rect(buf, px0 - 6, py0 - 10, 12, 16, C.body);
  rect(buf, px0 - 5, py0 - 18, 10, 9, C.head);

  return encodePng(W, H, buf);
}

/* ══════════════════════════════════════════════════════════════
   ② 以撒 / 元气骑士：地面还是平的，立体感全在【墙有顶面】
   ══════════════════════════════════════════════════════════════ */

function drawIsaac() {
  const buf = makeCanvas();
  const T = 34;
  /** 墙的"高度"。就是这一项制造了立体感 */
  const WALL_H = 22;
  const ox = Math.round((W - COLS * T) / 2);
  const oy = Math.round((H - ROWS * T) / 2) + WALL_H;

  // 地面：和纯俯视一模一样
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (isWall(x, y)) continue;
      const sx = ox + x * T;
      const sy = oy + y * T;
      rect(buf, sx, sy, T, T, C.floor);
      rect(buf, sx, sy, T, 1, C.floorLine);
      rect(buf, sx, sy, 1, T, C.floorLine);
    }
  }

  /*
   * 墙：先画正面（矮），再在【上移 WALL_H】的位置画顶面。
   * 这是以撒的核心手法 —— 玩家看到墙的顶，就自动读出"这是立体的"。
   */
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!isWall(x, y)) continue;
      const sx = ox + x * T;
      const sy = oy + y * T;
      rect(buf, sx, sy - WALL_H, T, WALL_H + T, C.wallFront);
      rect(buf, sx, sy - WALL_H, T, WALL_H, C.wallTop);
      rect(buf, sx, sy - WALL_H, T, 1, C.wallLine);
      rect(buf, sx, sy - 1, T, 1, [20, 20, 28, 255]);
      rect(buf, sx, sy - WALL_H, 1, WALL_H, C.wallLine);
      rect(buf, sx + T - 1, sy - WALL_H, 1, WALL_H, C.wallSide);
    }
  }

  // 角色：脚踩在格子上，身体往上长 —— 这就是"3/4 视角"
  const px0 = ox + PX * T + T / 2;
  const py0 = oy + PY * T + T / 2;
  ellipse(buf, px0, py0 + 11, 10, 4, C.shadow);
  rect(buf, px0 - 7, py0 - 14, 14, 22, C.body);
  rect(buf, px0 - 6, py0 - 24, 12, 11, C.head);
  // 朝向：一条亮边，让人读出"他面向这边"
  rect(buf, px0 + 5, py0 - 22, 2, 8, C.accent);

  return encodePng(W, H, buf);
}

/* ══════════════════════════════════════════════════════════════
   ③ 真等距：菱形地面，坐标整个换掉
   ══════════════════════════════════════════════════════════════ */

function drawIsometric() {
  const buf = makeCanvas();
  const TW = 24; // 菱形半宽
  const TH = 12; // 菱形半高（2:1）
  const WALL_H = 26;

  /** 世界格 → 屏幕。等距投影的全部数学就这两行 */
  const toScreen = (x, y) => ({
    sx: Math.round((x - y) * TW) + Math.round(W / 2),
    sy: Math.round((x + y) * TH) + 40,
  });

  /*
   * 【关键：绘制顺序】等距必须【从远到近】画，否则近处的墙
   * 会被远处的盖住。按 (x+y) 从小到大就是由远及近。
   */
  for (let sum = 0; sum <= COLS + ROWS - 2; sum++) {
    for (let y = 0; y < ROWS; y++) {
      const x = sum - y;
      if (x < 0 || x >= COLS) continue;
      const { sx, sy } = toScreen(x, y);

      if (!isWall(x, y)) {
        diamond(buf, sx, sy, TW, TH, C.floor);
        // 格子边线：只画下半两条，看起来才像"平铺的地砖"
        for (let i = -TW; i <= TW; i++) {
          const j = TH - Math.abs(i) * (TH / TW);
          px(buf, sx + i, sy + Math.round(j) - 1, C.floorLine);
        }
        continue;
      }

      // 墙：顶面菱形 + 左右两个侧面
      for (let h = 0; h < WALL_H; h++) {
        diamond(buf, sx, sy - h, TW, TH, h < WALL_H - 2 ? C.wallFront : C.wallTop);
      }
      diamond(buf, sx, sy - WALL_H, TW, TH, C.wallTop);
      // 左暗右亮的侧光，是等距读得出体积的关键
      for (let h = 0; h < WALL_H; h++) {
        for (let i = 0; i <= TW; i++) {
          const j = Math.round((1 - i / TW) * TH);
          px(buf, sx - i, sy - h + j, C.wallSide);
          px(buf, sx + i, sy - h + j, C.wallFront);
        }
      }
    }
  }

  // 角色：站在自己的菱形中心
  const { sx, sy } = toScreen(PX, PY);
  ellipse(buf, sx, sy + 4, 11, 5, C.shadow);
  rect(buf, sx - 7, sy - 20, 14, 24, C.body);
  rect(buf, sx - 6, sy - 31, 12, 11, C.head);
  rect(buf, sx + 5, sy - 29, 2, 8, C.accent);

  return encodePng(W, H, buf);
}

/* ── 出图 ── */

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, '1-现在这样-纯俯视.png'), drawTopDown());
writeFileSync(join(OUT, '2-以撒元气骑士-俯视加立体墙.png'), drawIsaac());
writeFileSync(join(OUT, '3-真等距-菱形地面.png'), drawIsometric());

console.log('三种画法对比已生成：');
console.log('  assets/_perspective/1-现在这样-纯俯视.png');
console.log('  assets/_perspective/2-以撒元气骑士-俯视加立体墙.png');
console.log('  assets/_perspective/3-真等距-菱形地面.png');

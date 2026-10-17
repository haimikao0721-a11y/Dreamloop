/**
 * ════════════════════════════════════════════════════════════════
 *  tools/gen-assets.mjs —— 程序化生成像素素材
 * ════════════════════════════════════════════════════════════════
 *
 *  为什么用代码生成，而不是直接放 PNG：
 *
 *    1. 【可改】图是字符画，改一个字符就改一个像素 —— 社区贡献者
 *       不需要装 Aseprite 就能改，Git 也能看懂 diff
 *    2. 【换皮】同一套字符画配不同调色板 = 不同地图风格。
 *       「理智归零切换风格」因此不需要画两套图
 *    3. 【可复现】改了随时重跑，不依赖谁手里的 psd
 *
 *  零依赖：PNG 编码器自己写（Node 自带 zlib 就够了）。
 *
 *  用法：node tools/gen-assets.mjs
 * ════════════════════════════════════════════════════════════════
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ══════════════════════════════════════════════════════════════
   PNG 编码器（自己写，零依赖）
   ══════════════════════════════════════════════════════════════ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA8 像素缓冲 → PNG 字节流 */
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ══════════════════════════════════════════════════════════════
   调色板
   ══════════════════════════════════════════════════════════════

   两套主题共用同一组【字符键】。所以同一张字符画能出两种风格 ——
   这就是「理智归零切换地图风格」的实现方式：换调色板，不换图。

   字符键设计成有语义的：
     .  透明      k  最深（背景）
     v  void      d  dark      s  stone     l  light
     e  edge      f  fog       u  dust      p  pale
     b  bone      w  高光
     c  烛光      C  烛芯高光
     r  锈        R  血       g  苔
     F  血肉      H  血肉亮   m  病态青
   ══════════════════════════════════════════════════════════════ */

/** 常态：凌晨三点十七分的旧医院。冷、灰、只有烛光是暖的 */
const THEME_NORMAL = {
  k: '#07070b',
  v: '#12121a',
  d: '#1c1c26',
  s: '#272733',
  l: '#343442',
  e: '#42424f',
  f: '#52525f',
  u: '#6b6b7a',
  p: '#8f8f9c',
  b: '#b9b9c4',
  w: '#e6e2d6',
  c: '#d8a848',
  C: '#f7d27a',
  r: '#8a4a3a',
  R: '#5a2a2a',
  g: '#3a5a4a',
  m: '#4a6a68',
  F: '#6a3a3a',
  H: '#8a4a4a',
};

/** 理智归零：同一张图，血肉化。地形不变，材质全换 */
const THEME_ZERO = {
  k: '#0b0505',
  v: '#1a0e0e',
  d: '#261212',
  s: '#331818',
  l: '#42201f',
  e: '#522a28',
  f: '#663630',
  u: '#8a4a42',
  p: '#a86258',
  b: '#c47a6c',
  w: '#e8b0a0',
  c: '#e0703a',
  C: '#ffa860',
  r: '#7a2a20',
  R: '#4a1414',
  g: '#4a3a2a',
  m: '#5a4a52',
  F: '#7a3028',
  H: '#a84838',
};

/* ══════════════════════════════════════════════════════════════
   瓦片字符画（16×16）
   ══════════════════════════════════════════════════════════════ */

const TILE = 16;
/**
 * 输出 PNG 的像素倍数。
 *
 * 字符画仍按 16×16 / 16×24 来画（一格一个字符，diff 还看得懂）。
 * 写进文件时每个字符拆成 ART×ART 个像素，边上加高光和阴影 ——
 * 游戏把这些像素缩回原来的页面大小，多出来的才是能看见的细节。
 * 必须和 src/ui-web/rt-view.ts 的 ART 相同。
 */
const ART = 2;

/**
 * 医院地砖。
 *
 * 【第一版是 8px 一格，铺满一屏之后是纯粹的视觉噪音】——
 * 每 8 像素一条亮缝（e #42424f 对 v #12121a，对比极大），
 * 21×15 的房间就是几百个方格。玩久了眼睛累，而且【人看不清】——
 * 玩家该一眼看到的是角色和怪物，不是地板。
 *
 * 现在：缝只用一档（d #1c1c26，几乎看不见），而且只在【上边和左边】。
 * 铺开之后是 16px 一条极暗的线，地板退到后面去了。
 */
const FLOOR = [
  'lsssssssssssssss',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvsvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvvvsvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvsvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svsvvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvsvvvvv',
  'svvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
];

/**
 * 地砖变体：多一处旧污，用来打散重复感。
 * 但污渍也要压暗 —— 第一版用锈色 r(#8a4a3a) 太跳，铺满一屏全是橙斑。
 */
const FLOOR_STAINED = [
  'lsssssssssssssss',
  'svvvvvvvvvvvvvvv',
  'svvvddvvvvvvvvvv',
  'svddddvvvvvvvvvv',
  'svvddvvvvvvvsvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvddddvvvv',
  'svvvvvvvRdddvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvsvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvvvvvvvv',
  'svvvvvvvvdvvvvvv',
  'svvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
];

/**
 * 墙：俯视砖墙。顶沿吃光，砖缝错开排列。
 * 这是屏幕上占比最大的素材，必须一眼读出"这是墙"。
 */
const WALL = [
  'llllllllllllllll',
  'eeeeeeeeeeeeeeee',
  'ssssssssssssssss',
  'dvvvvvvvvvvvvvvd',
  'dvvvvvvvvvvvvvvd',
  'dvvvvvvsvvvvvvvd',
  'dvvvvvvvvvvvvvvd',
  'ssssssssssssssss',
  'dddddddddddddddd',
  'dkvvvvvvvvvvvvsd',
  'dkvvvvvvvvvvvvsd',
  'dkvvvvvsvvvvvvsd',
  'dkvvvvvvvvvvvvsd',
  'dddddddddddddddd',
  'kkkkkkkkkkkkkkkk',
  'dddddddddddddddd',
];

/**
 * 墙的【顶面】。
 *
 * 【为什么要单独一张】—— 这是"以撒式立体感"的全部来源。
 *
 * 纯俯视的墙和地板都是平的，看起来像一张纸上的格子。
 * 以撒 / 元气骑士的做法是：**地面完全不倾斜**，立体感来自
 * 你能看到墙的【上方】—— 大脑一看到顶面就自动读出"这是个立体的箱子"。
 *
 * 渲染时把这张图往【上】偏移一格画在墙的正面之上，
 * 但只在"这格墙的上方不是墙"时才画 —— 否则一排竖着的墙会出现阶梯。
 *
 * 光从上方来：前缘（贴着玩家的那一侧）最亮，后缘最暗。
 *
 * ── 亮度是【算过】的，不是随手挑的 ──
 *
 * 第一版顶面用 l(#343442)，用户反馈"感觉区别不大"。查了才发现：
 *
 *     地板    v  #12121a   (18)
 *     墙正面  d  #1c1c26   (28)   ← 和地板只差 10
 *     顶面    l  #343442   (52)   ← 和正面只差 24
 *
 * 全挤在亮度范围的底部 20% 里。差 10 和差 24，在这么暗的范围里
 * 人眼根本分不出来 —— 顶面等于白画。
 *
 * 现在顶面用 f(#52525f, 82)，是墙正面(d)的【三倍】。
 * 明暗差才是立体感的来源，不是"有没有顶面"这件事本身。
 */
const WALL_TOP = [
  'kkkkkkkkkkkkkkkk',
  'eufeeeeeeeeeeufe',
  'uffffffffffffffu',
  'ffffffffffffffff',
  'ffffufffffffffff',
  'ffffffffffffffff',
  'ffffffffufffffff',
  'ffffffffffffffff',
  'fuffffffffffffff',
  'ffffffffffffffff',
  'ffffffffffffffff',
  'ffffffffffffufff',
  'ffffffffffffffff',
  'eeeeeeeeeeeeeeee',
  'pppppppppppppppp',
  'dddddddddddddddd',
];

/** 门：门框 + 竖板门身 + 门把手。要能一眼和墙区分 */
const DOOR = [
  'ssssssssssssssss',
  'slvvvvvvvvvvvlss',
  'slvdddddddddvlss',
  'slvdddddddddvlss',
  'slvdddddddddvlss',
  'slvvvvvvvvvvvlss',
  'slvdddddddddvlss',
  'slvdddddddddvlss',
  'slvdddddddddvlss',
  'slvdddddddccvlss',
  'slvdddddddccvlss',
  'slvdddddddddvlss',
  'slvvvvvvvvvvvlss',
  'ssssssssssssssss',
  'skkkkkkkkkkkkkss',
  'dddddddddddddddd',
];

/** 楼梯：一级级收窄、变暗。每一级都有亮边（踏面）和暗面（立面） */
const STAIRS = [
  'eeeeeeeeeeeeeeee',
  'elllllllllllllle',
  'edddddddddddddde',
  'evllllllllllllve',
  'evddddddddddddve',
  'evvvvvvvvvvvvvve',
  'evvllllllllllvve',
  'evvddddddddddvve',
  'evvvvvvvvvvvvvve',
  'evvvllllllllvvve',
  'evvvddddddddvvve',
  'evvvvvvvvvvvvvve',
  'evvvvlllllvvvvve',
  'evvvvdddddvvvvve',
  'evkkkkkkkkkkkkve',
  'eeeeeeeeeeeeeeee',
];

/** 蜡烛：可拾取、会耗尽的光源 —— 必须一眼认出来 */
const CANDLE = [
  '................',
  '.......C........',
  '......CcC.......',
  '.....CcccC......',
  '......ccc.......',
  '.......w........',
  '......bwb.......',
  '......bwb.......',
  '......bRb.......',
  '......bwb.......',
  '......bwb.......',
  '.....bbwbb......',
  '.....bbbbb......',
  '....sssssss.....',
  '...sssssssss....',
  '................',
];

/** 固定光源：墙上的烛台。拿不走，所以做成"长在墙上"的样子 */
const WALL_LAMP = [
  '................',
  '.......CC.......',
  '......CcCC......',
  '......cCCc......',
  '.......cc.......',
  '........w.......',
  '.......bbb......',
  '......bbbbb.....',
  '.....bbbbbbb....',
  '....ssssssss....',
  '....ssssssss....',
  '................',
  '................',
  '................',
  '................',
  '................',
];

/* ══════════════════════════════════════════════════════════════
   生成
   ══════════════════════════════════════════════════════════════ */

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * 字符画 → RGBA 缓冲。
 * 任何一行宽度不对就直接抛 —— 像素画最容易错的就是漏一个字符，
 * 而这种错在图上只表现为"右边少一列"，肉眼很难发现。
 */
function tileRgba(name, art, palette) {
  if (art.length !== TILE) {
    throw new Error(`${name}: 需要 ${TILE} 行，实际 ${art.length} 行`);
  }
  const rgba = Buffer.alloc(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    const row = art[y];
    if (row.length !== TILE) {
      throw new Error(`${name}: 第 ${y} 行宽度是 ${row.length}，应为 ${TILE} —— "${row}"`);
    }
    for (let x = 0; x < TILE; x++) {
      const ch = row[x];
      const i = (y * TILE + x) * 4;
      if (ch === '.') continue; // 透明
      const hex = palette[ch];
      if (hex === undefined) {
        throw new Error(`${name}: 第 ${y} 行第 ${x} 列的字符 "${ch}" 不在调色板里`);
      }
      const [r, g, b] = hexToRgb(hex);
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * 把一张角色/瓦片放大 ART 倍，并在每个原像素的 2×2 里分出明暗。
 *
 * 纯复制会在缩回页面之后和原来一模一样，多出来的像素等于没画。
 * 上沿、左沿偏亮，下沿、右沿偏暗 —— 光仍从上方来，和墙顶面同一套。
 */
function present(rgba, w, h) {
  const W = w * ART;
  const H = h * ART;
  const out = Buffer.alloc(W * H * 4);
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const i = (y * w + x) * 4;
    if (rgba[i + 3] === 0) return null;
    return [rgba[i], rgba[i + 1], rgba[i + 2]];
  };
  const mix = (rgb, gain, bias) =>
    rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * gain + bias))));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = sample(x, y);
      if (p === null) continue;
      const edgeT = sample(x, y - 1) === null;
      const edgeL = sample(x - 1, y) === null;
      const edgeB = sample(x, y + 1) === null;
      const edgeR = sample(x + 1, y) === null;
      const hi = mix(p, 1.28, 10);
      const sh = mix(p, 0.68, 0);
      const cells = [
        [0, 0, edgeT || edgeL ? hi : p],
        [1, 0, edgeT ? hi : p],
        [0, 1, edgeL ? p : edgeB ? sh : p],
        [1, 1, edgeB || edgeR ? sh : p],
      ];
      for (const [dx, dy, col] of cells) {
        const i = ((y * ART + dy) * W + (x * ART + dx)) * 4;
        out[i] = col[0];
        out[i + 1] = col[1];
        out[i + 2] = col[2];
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

function renderTile(name, art, palette) {
  const src = tileRgba(name, art, palette);
  return encodePng(TILE * ART, TILE * ART, present(src, TILE, TILE));
}

/** 一帧字符画 → 放大并分出明暗之后的 PNG */
function encodePresented(frame, palette, name) {
  const src = spriteRgba(name, frame, palette);
  return encodePng(SPRITE_W * ART, SPRITE_H * ART, present(src, SPRITE_W, SPRITE_H));
}

/** 多帧横排。宽度必须是 (帧数 × 角色宽 × ART)，渲染端按这个切 */
function buildPresentedSheet(frames, palette) {
  const fw = SPRITE_W * ART;
  const fh = SPRITE_H * ART;
  const rgba = Buffer.alloc(frames.length * fw * fh * 4);
  frames.forEach((frame, idx) => {
    const src = present(spriteRgba(`sheet#${idx}`, frame, palette), SPRITE_W, SPRITE_H);
    for (let y = 0; y < fh; y++) {
      src.copy(rgba, (y * frames.length * fw + idx * fw) * 4, y * fw * 4, (y + 1) * fw * 4);
    }
  });
  return encodePng(frames.length * fw, fh, rgba);
}

/**
 * 铺满预览：把瓦片按真实房间的样子铺开。
 *
 * 【为什么单张瓦片预览不够】
 * 地板的问题不在单张瓦片上，而在【铺满一屏之后】——
 * 8px 一格的地砖单看没问题，21×15 铺开就是几百个方格，纯粹是噪音。
 * 判断"噪不噪"必须看铺开的样子，所以要有这一张。
 *
 * 布局照搬 makeTestRoom：四周墙、中间一道竖墙留个门洞。
 */
function buildRoomPreview(palette, scale = 3) {
  const COLS = 21;
  const ROWS = 15;
  const midX = Math.floor(COLS / 2);
  const midY = Math.floor(ROWS / 2);

  const floorA = tileRgba('room/floor', TILES.floor, palette);
  const floorB = tileRgba('room/floor_stained', TILES.floor_stained, palette);
  const wallArt = tileRgba('room/wall', TILES.wall, palette);

  const w = COLS * TILE * scale;
  const h = ROWS * TILE * scale;
  const buf = Buffer.alloc(w * h * 4);

  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      const border = tx === 0 || ty === 0 || tx === COLS - 1 || ty === ROWS - 1;
      const isWall = border || (tx === midX && ty >= 2 && ty <= ROWS - 3 && ty !== midY);

      // 地砖随机用两种变体打散重复感。用固定的伪随机，
      // 保证每次生成的预览一样 —— 否则没法比较改动前后
      const pick = (tx * 73856093) ^ (ty * 19349663);
      const useStained = !isWall && pick % 7 === 0;
      const src = isWall ? wallArt : useStained ? floorB : floorA;

      const ox = tx * TILE * scale;
      const oy = ty * TILE * scale;
      for (let y = 0; y < TILE * scale; y++) {
        for (let x = 0; x < TILE * scale; x++) {
          const si = (Math.floor(y / scale) * TILE + Math.floor(x / scale)) * 4;
          if (src[si + 3] === 0) continue;
          const di = ((oy + y) * w + (ox + x)) * 4;
          buf[di] = src[si];
          buf[di + 1] = src[si + 1];
          buf[di + 2] = src[si + 2];
          buf[di + 3] = 255;
        }
      }
    }
  }
  return encodePng(w, h, buf);
}

/**
 * 拼一张放大预览图：两个主题各一行。
 *
 * 为什么要有它：PNG 在 GitHub 上要一个个点开才看得见，
 * 而且 16×16 原尺寸小到看不清。有了这张，改完素材一眼能看出对不对。
 */
function buildPreview() {
  const SCALE = 6;
  const GAP = 4;
  const names = Object.keys(TILES);
  const cols = names.length;
  const rows = Object.keys(THEMES).length;
  const cell = TILE * SCALE;
  const w = cols * cell + (cols + 1) * GAP;
  const h = rows * cell + (rows + 1) * GAP;
  const buf = Buffer.alloc(w * h * 4);

  // 棋盘底：透明像素才看得出来
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const c = dark ? 26 : 38;
      buf[i] = c;
      buf[i + 1] = c;
      buf[i + 2] = c + 4;
      buf[i + 3] = 255;
    }
  }

  Object.entries(THEMES).forEach(([themeName, palette], row) => {
    names.forEach((tileName, col) => {
      const src = tileRgba(`${themeName}/${tileName}`, TILES[tileName], palette);
      const ox = GAP + col * (cell + GAP);
      const oy = GAP + row * (cell + GAP);
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const sx = Math.floor(x / SCALE);
          const sy = Math.floor(y / SCALE);
          const si = (sy * TILE + sx) * 4;
          if (src[si + 3] === 0) continue;
          const di = ((oy + y) * w + (ox + x)) * 4;
          buf[di] = src[si];
          buf[di + 1] = src[si + 1];
          buf[di + 2] = src[si + 2];
          buf[di + 3] = 255;
        }
      }
    });
  });

  return encodePng(w, h, buf);
}

const TILES = {
  floor: FLOOR,
  floor_stained: FLOOR_STAINED,
  wall: WALL,
  // 墙的顶面。渲染时上移一格画在正面之上 —— 立体感就是它给的
  wall_top: WALL_TOP,
  door: DOOR,
  stairs: STAIRS,
  candle: CANDLE,
  wall_lamp: WALL_LAMP,
};

const THEMES = {
  normal: THEME_NORMAL,
  zero: THEME_ZERO,
};

/* ══════════════════════════════════════════════════════════════
   角色精灵（16×24 —— 比瓦片高，因为人要"站"在格子上）
   ══════════════════════════════════════════════════════════════

   每个动作是一整帧，不是在待机图上贴几个武器像素。
   走路两帧换脚，攻击三帧是起手 → 判定 → 收招。
   理智归零仍是同一批像素、另一套调色板。
   ══════════════════════════════════════════════════════════════ */

const SPRITE_W = 16;
const SPRITE_H = 24;

/**
 * 记梦者：瘦、深色外套、怀里抱着本子。
 *
 * ── 重画过一次 ──
 *
 * 第一版是"方块加两个点"：头是个矩形、身体是个矩形、没有轮廓、
 * 没有明暗。远看就是几个灰色块，读不出"这是个人"。
 *
 * 现在按三条规则重画：
 *
 *   1. 【有轮廓】—— 深色边(k)包一圈，让人从背景里"抠"出来
 *   2. 【光从上方来】—— 肩部最亮(e)，往下逐级压暗(l → s)，
 *      和墙顶面的打光是同一个方向，整个画面才是一套光
 *   3. 【肩膀比头宽】—— 这是人形最基本的识别特征。
 *      头宽身窄的话看起来是钉子
 *
 * ── 亮度是【为了可读性】定的，不是为了好看 ──
 *
 * 第一版外套用 l/s(#343442/#272733)，而 s 和墙的砖缝【是同一个颜色】。
 * 在游戏里看就是一团糊在地板上 —— 玩家找不到自己。
 *
 * 现在外套提到 f/e(#52525f/#42424f)，肩部 u(#6b6b7a)。
 * 主题上"他是个穿深色外套的人"没错，但【可读性优先】——
 * 动作游戏里玩家 0.2 秒找不到自己，帧数设计得再好也没用。
 */
const ARCHIVIST = [
  '................',
  '................',
  '.....kkkkkk.....',
  '....kddddddk....',
  '...kdppppppdk...',
  '...kdpkkkkpdk...',
  '...kdppppppdk...',
  '....kppppppk....',
  '.....kppppk.....',
  '......kkkk......',
  '....kkkkkkkk....',
  '...kuuuuuuuuk...',
  '..kuffffffuffk..',
  '..kufeeeeeeufk..',
  '..kufebbbbeufk..',
  '..kufebwwbCufk..',
  '..kufeeeeeeufk..',
  '..kufeeeeeeufk..',
  '...kuffffffuk...',
  '....kkkkkkkk....',
  '....kss..ssk....',
  '....kss..ssk....',
  '....kss..ssk....',
  '....kk....kk....',
];

/** 迈左脚：左脚伸到画框底，右脚抬起 */
const ARCHIVIST_WALK_A = [
  '................',
  '................',
  '.....kkkkkk.....',
  '....kddddddk....',
  '...kdppppppdk...',
  '...kdpkkkkpdk...',
  '...kdppppppdk...',
  '....kppppppk....',
  '.....kppppk.....',
  '......kkkk......',
  '....kkkkkkkk....',
  '...kuuuuuuuuk...',
  '..kuffffffuffk..',
  '..kufeeeeeeufk..',
  '..kufebbbbeufk..',
  '..kufebwwbCufk..',
  '..kufeeeeeeufk..',
  '..kufeeeeeeufk..',
  '...kuffffffuk...',
  '....kkkkkkkk....',
  '....kss..ssk....',
  '....ks....sk....',
  '...kk......k....',
  '....k......kk...',
];

/** 迈右脚 */
const ARCHIVIST_WALK_B = [
  '................',
  '................',
  '.....kkkkkk.....',
  '....kddddddk....',
  '...kdppppppdk...',
  '...kdpkkkkpdk...',
  '...kdppppppdk...',
  '....kppppppk....',
  '.....kppppk.....',
  '......kkkk......',
  '....kkkkkkkk....',
  '...kuuuuuuuuk...',
  '..kuffffffuffk..',
  '..kufeeeeeeufk..',
  '..kufebbbbeufk..',
  '..kufebwwbCufk..',
  '..kufeeeeeeufk..',
  '..kufeeeeeeufk..',
  '...kuffffffuk...',
  '....kkkkkkkk....',
  '....kss..ssk....',
  '....sk....ks....',
  '....k......kk...',
  '...kk......k....',
];

/** 起手：笔收到脑后，还没扫出来 */
const ARCHIVIST_ATK_1 = [
  '..C.............',
  '.cCk............',
  '.cc.kkkkkk......',
  '.c.kddddddk.....',
  '...kdppppppdk...',
  '...kdpkkkkpdk...',
  '...kdppppppdk...',
  '....kppppppk....',
  '.....kppppk.....',
  '......kkkk......',
  '....kkkkkkkk....',
  '...kuuuuuuuuk...',
  '..kuffffffuffk..',
  '..kufeeeeeeufk..',
  '..kufebbbbeufk..',
  '..kufebwwbeufk..',
  '..kufeeeeeeufk..',
  '..kufeeeeeeufk..',
  '...kuffffffuk...',
  '....kkkkkkkk....',
  '....kss..ssk....',
  '....kss..ssk....',
  '....kss..ssk....',
  '....kk....kk....',
];

/** 判定：笔扫到身前，只有这一帧能打到人 */
const ARCHIVIST_ATK_2 = [
  '................',
  '................',
  '.....kkkkkk.....',
  '....kddddddk....',
  '...kdppppppdk...',
  '...kdpkkkkpdk...',
  '...kdppppppdk..C',
  '....kppppppkc.C.',
  '.....kppppk..cc.',
  '......kkkk......',
  '....kkkkkkkk....',
  '...kuuuuuuuuk...',
  '..kuffffffuffk..',
  '..kufeeeeeeufkkc',
  '..kufebbbbeufkC.',
  '..kufebwwbeufk..',
  '..kufeeeeeeufk..',
  '..kufeeeeeeufk..',
  '...kuffffffuk...',
  '....kkkkkkkk....',
  '....kss..ssk....',
  '....kss..ssk....',
  '....kss..ssk....',
  '....kk....kk....',
];

/** 收招：笔垂到身侧 */
const ARCHIVIST_ATK_3 = [
  '................',
  '................',
  '.....kkkkkk.....',
  '....kddddddk....',
  '...kdppppppdk...',
  '...kdpkkkkpdk...',
  '...kdppppppdk...',
  '....kppppppk....',
  '.....kppppk.....',
  '......kkkk......',
  '....kkkkkkkk....',
  '...kuuuuuuuuk...',
  '..kuffffffuffk..',
  '..kufeeeeeeufk..',
  '..kufebbbbeufk..',
  '..kufebwwbeufk..',
  '..kufeeeeeeufk..',
  '..kufeeeeeeufkc.',
  '...kuffffffukcC.',
  '....kkkkkkkk.cc.',
  '....kss..ssk....',
  '....kss..sskc...',
  '....kss..ssk....',
  '....kk....kk....',
];

/**
 * 值夜护士：结实、白制服、帽上一点红。
 * 比记梦者宽一圈，灯是她的武器，走路时两脚交替迈出。
 */
const NURSE = [
  '................',
  '....wwwrwwww....',
  '...wwwwwwwwww...',
  '....kkkkkkkk....',
  '...kppppppppk...',
  '...kpkkppkkpk...',
  '...kppppppppk...',
  '....kppppppk....',
  '.....kppppk.....',
  '...kkkkkkkkkk...',
  '..kbbbbbbbbbbk..',
  '..kbwwwwwwwwbk..',
  '..kwwwwwwwwwwk..',
  '..kwwrrrrrrwwk..',
  '..kwwwwwwwwwwk..',
  '..kwwwwwwwwwwk..',
  '..kbwwwwwwwwbk..',
  '...kkkkkkkkkk...',
  '....kbbkkbbk....',
  '....kbbkkbbk....',
  '....kbbkkbbk....',
  '....kk...kkk....',
  '.....k....k.....',
  '................',
];

const NURSE_WALK_A = [
  '................',
  '....wwwrwwww....',
  '...wwwwwwwwww...',
  '....kkkkkkkk....',
  '...kppppppppk...',
  '...kpkkppkkpk...',
  '...kppppppppk...',
  '....kppppppk....',
  '.....kppppk.....',
  '...kkkkkkkkkk...',
  '..kbbbbbbbbbbk..',
  '..kbwwwwwwwwbk..',
  '..kwwwwwwwwwwk..',
  '..kwwrrrrrrwwk..',
  '..kwwwwwwwwwwk..',
  '..kwwwwwwwwwwk..',
  '..kbwwwwwwwwbk..',
  '...kkkkkkkkkk...',
  '....kbbkkbbk....',
  '...kbb...kbb....',
  '...kb.....kb....',
  '....k......k....',
  '................',
  '................',
];

const NURSE_WALK_B = [
  '................',
  '....wwwrwwww....',
  '...wwwwwwwwww...',
  '....kkkkkkkk....',
  '...kppppppppk...',
  '...kpkkppkkpk...',
  '...kppppppppk...',
  '....kppppppk....',
  '.....kppppk.....',
  '...kkkkkkkkkk...',
  '..kbbbbbbbbbbk..',
  '..kbwwwwwwwwbk..',
  '..kwwwwwwwwwwk..',
  '..kwwrrrrrrwwk..',
  '..kwwwwwwwwwwk..',
  '..kwwwwwwwwwwk..',
  '..kbwwwwwwwwbk..',
  '...kkkkkkkkkk...',
  '....kbbkkbbk....',
  '....bbk...kbb...',
  '....bk.....kb...',
  '....k......k....',
  '................',
  '................',
];

const NURSE_ATK_1 = [
  '.C..............',
  'cCc.wwwrwwww....',
  '.ccwwwwwwwwww...',
  '....kkkkkkkk....',
  '...kppppppppk...',
  '...kpkkppkkpk...',
  '...kppppppppk...',
  '....kppppppk....',
  '.....kppppk.....',
  '...kkkkkkkkkk...',
  '..kbbbbbbbbbbk..',
  '..kbwwwwwwwwbk..',
  '..kwwwwwwwwwwk..',
  '..kwwrrrrrrwwk..',
  '..kwwwwwwwwwwk..',
  '..kwwwwwwwwwwk..',
  '..kbwwwwwwwwbk..',
  '...kkkkkkkkkk...',
  '....kbbkkbbk....',
  '....kbbkkbbk....',
  '....kbbkkbbk....',
  '....kk...kkk....',
  '.....k....k.....',
  '................',
];

const NURSE_ATK_2 = [
  '................',
  '....wwwrwwww....',
  '...wwwwwwwwww...',
  '....kkkkkkkk....',
  '...kppppppppk...',
  '...kpkkppkkpk..C',
  '...kppppppppkcC.',
  '....kppppppk.ccc',
  '.....kppppk.....',
  '...kkkkkkkkkk...',
  '..kbbbbbbbbbbk..',
  '..kbwwwwwwwwbkk.',
  '..kwwwwwwwwwwkC.',
  '..kwwrrrrrrwwk..',
  '..kwwwwwwwwwwk..',
  '..kwwwwwwwwwwk..',
  '..kbwwwwwwwwbk..',
  '...kkkkkkkkkk...',
  '....kbbkkbbk....',
  '....kbbkkbbk....',
  '....kbbkkbbk....',
  '....kk...kkk....',
  '.....k....k.....',
  '................',
];

const NURSE_ATK_3 = [
  '................',
  '....wwwrwwww....',
  '...wwwwwwwwww...',
  '....kkkkkkkk....',
  '...kppppppppk...',
  '...kpkkppkkpk...',
  '...kppppppppk...',
  '....kppppppk....',
  '.....kppppk.....',
  '...kkkkkkkkkk...',
  '..kbbbbbbbbbbk..',
  '..kbwwwwwwwwbk..',
  '..kwwwwwwwwwwk..',
  '..kwwrrrrrrwwk..',
  '..kwwwwwwwwwwk..',
  '..kwwwwwwwwwwkc.',
  '..kbwwwwwwwwbkC.',
  '...kkkkkkkkkkcc.',
  '....kbbkkbbk....',
  '....kbbkkbbc....',
  '....kbbkkbbk....',
  '....kk...kkk....',
  '.....k....k.....',
  '................',
];

/* ── 敌人 ── */

/**
 * 爬行物：矮、多足、看不清脸。
 * 故意画得【不像人】—— 它逼玩家走位，所以视觉上要让人想躲开。
 *
 * 【为什么压在画框下半部分】它贴地爬，重心低。画在框中间的话
 * 看起来是"站着的一坨"。脚在最下面，身体堆在脚上，才读得出"矮"。
 */
const CRAWLER = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....kkkkkk.....',
  '...kkmmmmmmkk...',
  '..kmFFFFFFFFFmk.',
  '.kmFFHHHHHHFFFmk',
  '.kmFkHHHHHHkFFmk',
  '.kmkkkkkkkkkkmk.',
  '.kmHHHHHHHHHHmk.',
  '..kmFFFFFFFFFmk.',
  '...kkmmmmmmkk...',
  '..k..k....k..k..',
  '.k...k....k...k.',
  'k....k....k....k',
  '.k...k....k...k.',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const CRAWLER_WALK_A = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....kkkkkk.....',
  '...kkmmmmmmkk...',
  '..kmFFFFFFFFFmk.',
  '.kmFFHHHHHHFFFmk',
  '.kmFkHHHHHHkFFmk',
  '.kmkkkkkkkkkkmk.',
  '.kmHHHHHHHHHHmk.',
  '..kmFFFFFFFFFmk.',
  '...kkmmmmmmkk...',
  '.k..k......k..k.',
  'k...k......k...k',
  '.k...k....k...k.',
  '..k..k....k..k..',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const CRAWLER_WALK_B = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....kkkkkk.....',
  '...kkmmmmmmkk...',
  '..kmFFFFFFFFFmk.',
  '.kmFFHHHHHHFFFmk',
  '.kmFkHHHHHHkFFmk',
  '.kmkkkkkkkkkkmk.',
  '.kmHHHHHHHHHHmk.',
  '..kmFFFFFFFFFmk.',
  '...kkmmmmmmkk...',
  '..k..k....k..k..',
  'k...k......k...k',
  '.k...k....k...k.',
  '..k..k....k..k..',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const CRAWLER_ATK_1 = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '....kkkkkk......',
  '..kkmmmmmmkk....',
  '.kmFFFFFFFFFmk..',
  'kmFFHHHHHHFFFmk.',
  'kmFkHHHHHHkFFmk.',
  'kmkkkkkkkkkkmk..',
  'kmHHHHHHHHHHmk..',
  '.kmFFFFFFFFFmk..',
  '..kkmmmmmmkk....',
  '.k.k......k.k...',
  'k..k......k..k..',
  '.k.k......k.k...',
  '..k........k....',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const CRAWLER_ATK_2 = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '......kkkkk.....',
  '....kkmmmmmkk...',
  '...kmFFFFFFFmkk.',
  '..kmFHHHHHHFmkkC',
  '..kmFkHHHHkFmkCc',
  '..kmkkkkkkkkmkc.',
  '...kmHHHHHHmCCC.',
  '...kmFFFFFFFFmk.',
  '....kkmmmmmmkk..',
  '...k.k....k.k...',
  '..k..k....k..k..',
  '.k...k....k...k.',
  'k....k....k....k',
  '................',
  '................',
  '................',
  '................',
  '................',
];

const CRAWLER_ATK_3 = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....kkkkkk.....',
  '...kkmmmmmmkk...',
  '..kmFFFFFFFFFmk.',
  '.kmFFHHHHHHFFFmk',
  '.kmFkHHHHHHkFFmk',
  '.kmkkkkkkkkkkmk.',
  '.kmHHHHHHHHHHmk.',
  '..kmFFFFFFFFFmk.',
  '...kkmmmmmmkk...',
  'k..k........k..k',
  '.k..k......k..k.',
  '..k..k....k..k..',
  '...k......k.....',
  '................',
  '................',
  '................',
  '................',
  '................',
];

/**
 * 护工：高、宽、厚。
 *
 * 【用中灰 f(#52525f)，明显比墙亮】—— 第一版用的 d 和墙同色，
 * 结果在房间中间站着完全看不见，表现成"这个敌人没生成"。
 * 它是场上最大的威胁，必须一眼就找到。
 *
 * 体型比两个玩家角色都宽一圈。同一个画法（轮廓 + 上亮下暗），
 * 但【横向拉满】—— 玩家不用看细节就知道"这个更大更能打"。
 */
const ORDERLY = [
  '................',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '..kfppppppppfk..',
  '..kfpkkppkkpfk..',
  '..kfppppppppfk..',
  '...kfppppppfk...',
  '....kffffffk....',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '.kffeeeeeeeeffk.',
  'kffeeeeeeeeeeffk',
  'kffeuuuuuuuueffk',
  'kffeuuuuuuuueffk',
  'kffeeeeeeeeeeffk',
  'kffeeeeeeeeeeffk',
  '.kffeeeeeeeeffk.',
  '..kkkkkkkkkkkk..',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kkk....kkk...',
  '....k......k....',
  '................',
];

const ORDERLY_WALK_A = [
  '................',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '..kfppppppppfk..',
  '..kfpkkppkkpfk..',
  '..kfppppppppfk..',
  '...kfppppppfk...',
  '....kffffffk....',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '.kffeeeeeeeeffk.',
  'kffeeeeeeeeeeffk',
  'kffeuuuuuuuueffk',
  'kffeuuuuuuuueffk',
  'kffeeeeeeeeeeffk',
  'kffeeeeeeeeeeffk',
  '.kffeeeeeeeeffk.',
  '..kkkkkkkkkkkk..',
  '...kffk..kffk...',
  '..kffk....kff...',
  '..kff......kf...',
  '...k........k...',
  '....k...........',
  '................',
];

const ORDERLY_WALK_B = [
  '................',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '..kfppppppppfk..',
  '..kfpkkppkkpfk..',
  '..kfppppppppfk..',
  '...kfppppppfk...',
  '....kffffffk....',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '.kffeeeeeeeeffk.',
  'kffeeeeeeeeeeffk',
  'kffeuuuuuuuueffk',
  'kffeuuuuuuuueffk',
  'kffeeeeeeeeeeffk',
  'kffeeeeeeeeeeffk',
  '.kffeeeeeeeeffk.',
  '..kkkkkkkkkkkk..',
  '...kffk..kffk...',
  '...kff....kffk..',
  '...fk......kff..',
  '...k........k...',
  '...........k....',
  '................',
];

const ORDERLY_ATK_1 = [
  'C...............',
  'cCkkkkkkkkkk....',
  'ccffffffffffk...',
  '..kfppppppppfk..',
  '..kfpkkppkkpfk..',
  '..kfppppppppfk..',
  '...kfppppppfk...',
  '....kffffffk....',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '.kffeeeeeeeeffk.',
  'kffeeeeeeeeeeffk',
  'kffeuuuuuuuueffk',
  'kffeuuuuuuuueffk',
  'kffeeeeeeeeeeffk',
  'kffeeeeeeeeeeffk',
  '.kffeeeeeeeeffk.',
  '..kkkkkkkkkkkk..',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kkk....kkk...',
  '....k......k....',
  '................',
];

const ORDERLY_ATK_2 = [
  '................',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '..kfppppppppfk..',
  '..kfpkkppkkpfk.C',
  '..kfppppppppfkcC',
  '...kfppppppfkccc',
  '....kffffffk....',
  '...kkkkkkkkkk...',
  '..kffffffffffkk.',
  '.kffeeeeeeeeffkC',
  'kffeeeeeeeeeeffk',
  'kffeuuuuuuuueffk',
  'kffeuuuuuuuueffk',
  'kffeeeeeeeeeeffk',
  'kffeeeeeeeeeeffk',
  '.kffeeeeeeeeffk.',
  '..kkkkkkkkkkkk..',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kkk....kkk...',
  '....k......k....',
  '................',
];

const ORDERLY_ATK_3 = [
  '................',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '..kfppppppppfk..',
  '..kfpkkppkkpfk..',
  '..kfppppppppfk..',
  '...kfppppppfk...',
  '....kffffffk....',
  '...kkkkkkkkkk...',
  '..kffffffffffk..',
  '.kffeeeeeeeeffk.',
  'kffeeeeeeeeeeffk',
  'kffeuuuuuuuueffk',
  'kffeuuuuuuuueffc',
  'kffeeeeeeeeeeffC',
  'kffeeeeeeeeeeffc',
  '.kffeeeeeeeeffk.',
  '..kkkkkkkkkkkcc.',
  '...kffk..kffkc..',
  '...kffk..kffk...',
  '...kffk..kffk...',
  '...kkk....kkk...',
  '....k......k....',
  '................',
];

/** 角色 → 一组命名的帧 */
const CHARACTERS = {
  dream_archivist: {
    idle: ARCHIVIST,
    walk_a: ARCHIVIST_WALK_A,
    walk_b: ARCHIVIST_WALK_B,
    attack_startup: ARCHIVIST_ATK_1,
    attack_active: ARCHIVIST_ATK_2,
    attack_recovery: ARCHIVIST_ATK_3,
  },
  ward_nurse: {
    idle: NURSE,
    walk_a: NURSE_WALK_A,
    walk_b: NURSE_WALK_B,
    attack_startup: NURSE_ATK_1,
    attack_active: NURSE_ATK_2,
    attack_recovery: NURSE_ATK_3,
  },
  crawler: {
    idle: CRAWLER,
    walk_a: CRAWLER_WALK_A,
    walk_b: CRAWLER_WALK_B,
    attack_startup: CRAWLER_ATK_1,
    attack_active: CRAWLER_ATK_2,
    attack_recovery: CRAWLER_ATK_3,
  },
  orderly: {
    idle: ORDERLY,
    walk_a: ORDERLY_WALK_A,
    walk_b: ORDERLY_WALK_B,
    attack_startup: ORDERLY_ATK_1,
    attack_active: ORDERLY_ATK_2,
    attack_recovery: ORDERLY_ATK_3,
  },
};

/** 任意尺寸的字符画 → RGBA（角色比瓦片高，所以不能复用 16×16 那套） */
function spriteRgba(name, art, palette) {
  const h = art.length;
  const w = art[0].length;
  if (w !== SPRITE_W || h !== SPRITE_H) {
    throw new Error(`${name}: 尺寸 ${w}×${h}，应为 ${SPRITE_W}×${SPRITE_H}`);
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = art[y];
    if (row.length !== w) {
      throw new Error(`${name}: 第 ${y} 行宽度是 ${row.length}，应为 ${w}`);
    }
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const hex = palette[ch];
      if (hex === undefined) throw new Error(`${name}: 字符 "${ch}" 不在调色板里`);
      const [r, g, b] = hexToRgb(hex);
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * 精灵图（sprite sheet）：所有帧横着排一张。
 * 游戏里一次加载、按帧号切片 —— 比一百个小文件好管得多。
 */
/**
 * 把多帧拼成一张横向精灵表。
 *
 * 【帧之间不能有内边距】—— 渲染端是按 `frame * SPRITE_W` 切图的：
 *
 *     ctx.drawImage(sheet, frame * SPR_W, 0, SPR_W, SPR_H, ...)
 *
 * 原来这里有 gap = 2，于是每一帧都比上一帧多歪 2 像素：
 *     帧 0 切 x=0  （实际在 2）  歪 2
 *     帧 1 切 x=16 （实际在 20） 歪 4
 *     帧 2 切 x=32 （实际在 38） 歪 6
 * 表现是攻击动画"在滑"—— 而且因为幅度小，看起来像美术没对齐，
 * 不像 bug。
 *
 * 内边距本来是防纹理渗色的，但这里每次只画一帧、源矩形是精确的，
 * 根本不会渗。所以直接去掉，让尺寸严格等于 n*SPRITE_W × SPRITE_H。
 */
function buildSheet(art, palette, scale = 1) {
  const gap = 0;
  const cw = SPRITE_W * scale;
  const chh = SPRITE_H * scale;
  const w = art.length * (cw + gap) + gap;
  const h = chh + gap * 2;
  const buf = Buffer.alloc(w * h * 4);
  art.forEach((frame, idx) => {
    const src = spriteRgba(`sheet#${idx}`, frame, palette);
    const ox = gap + idx * (cw + gap);
    const oy = gap;
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = Math.floor(x / scale);
        const sy = Math.floor(y / scale);
        const si = (sy * SPRITE_W + sx) * 4;
        if (src[si + 3] === 0) continue;
        const di = ((oy + y) * w + (ox + x)) * 4;
        buf[di] = src[si];
        buf[di + 1] = src[si + 1];
        buf[di + 2] = src[si + 2];
        buf[di + 3] = 255;
      }
    }
  });
  /*
   * 【尺寸契约】渲染端按 frame * SPRITE_W 切片，所以这里必须严格是
   * n*SPRITE_W × SPRITE_H。断言一下 —— 这个契约一旦破了，
   * 症状是"动画在滑"，很难查到生成器头上。
   */
  if (w !== art.length * cw || h !== chh) {
    throw new Error(
      `精灵表尺寸不对: ${w}×${h}，应该是 ${art.length * cw}×${chh}。` +
        '渲染端按 frame * SPRITE_W 切片，有内边距的话每一帧都会切歪。',
    );
  }

  return encodePng(w, h, buf);
}

/** 两个角色的全部帧摞成一张，放大 5 倍 —— 用来肉眼看清楚画成什么样 */
function buildCharacterPreview() {
  const scale = 5;
  const frames = FRAME_ORDER.map((n) => n);
  const cols = frames.length;
  const cw = SPRITE_W * scale;
  const chh = SPRITE_H * scale;
  const gap = 6;
  const names = Object.keys(CHARACTERS);
  const w = cols * cw + (cols + 1) * gap;
  const h = names.length * chh + (names.length + 1) * gap;
  const buf = Buffer.alloc(w * h * 4);
  // 棋盘底
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 26 : 38;
      buf[i] = c;
      buf[i + 1] = c;
      buf[i + 2] = c + 4;
      buf[i + 3] = 255;
    }
  }
  names.forEach((charName, row) => {
    frames.forEach((frameName, col) => {
      const art = CHARACTERS[charName][frameName];
      if (!art) return;
      const src = spriteRgba(`${charName}/${frameName}`, art, THEME_NORMAL);
      const ox = gap + col * (cw + gap);
      const oy = gap + row * (chh + gap);
      for (let y = 0; y < chh; y++) {
        for (let x = 0; x < cw; x++) {
          const si = (Math.floor(y / scale) * SPRITE_W + Math.floor(x / scale)) * 4;
          if (src[si + 3] === 0) continue;
          const di = ((oy + y) * w + (ox + x)) * 4;
          buf[di] = src[si];
          buf[di + 1] = src[si + 1];
          buf[di + 2] = src[si + 2];
          buf[di + 3] = 255;
        }
      }
    });
  });
  return encodePng(w, h, buf);
}

let count = 0;
for (const [themeName, palette] of Object.entries(THEMES)) {
  // 常态直接放 map/，理智归零放 map/zero/ ——
  // 这不是"按楼层再拆一套"，而是同一个地图的两种全局状态，
  // 和 assets/README.md 里"不按角色、不按楼层拆"并不冲突
  const dir =
    themeName === 'normal'
      ? join(ROOT, 'assets', 'map')
      : join(ROOT, 'assets', 'map', themeName);
  mkdirSync(dir, { recursive: true });
  for (const [tileName, art] of Object.entries(TILES)) {
    writeFileSync(join(dir, `${tileName}.png`), renderTile(`${themeName}/${tileName}`, art, palette));
    count++;
  }
}

writeFileSync(join(ROOT, 'assets', 'map', '_preview.png'), buildPreview());
// 铺满预览：判断"噪不噪"必须看铺开的样子
writeFileSync(
  join(ROOT, 'assets', 'map', '_preview_room.png'),
  buildRoomPreview(THEME_NORMAL),
);
writeFileSync(
  join(ROOT, 'assets', 'map', '_preview_room_zero.png'),
  buildRoomPreview(THEME_ZERO),
);

/* ══════════════════════════════════════════════════════════════
   角色：一个动作一个文件，帧横排在里面
   ══════════════════════════════════════════════════════════════

   对齐 assets/README.md 的约定：actions/ 下按动作名给文件，
   而不是把每一帧拆成散图 —— 加载一次，按帧号切。
   ══════════════════════════════════════════════════════════════ */

const ACTIONS = {
  idle: ['idle'],
  move: ['walk_a', 'walk_b'],
  attack: ['attack_startup', 'attack_active', 'attack_recovery'],
};

const FRAME_ORDER = Object.values(ACTIONS).flat();

let spriteCount = 0;
for (const [charName, frames] of Object.entries(CHARACTERS)) {
  const dir = join(ROOT, 'assets', 'characters', charName, 'actions');
  mkdirSync(dir, { recursive: true });

  for (const [actionName, frameNames] of Object.entries(ACTIONS)) {
    const art = frameNames.map((n) => frames[n]).filter(Boolean);
    if (art.length === 0) continue;
    // 单帧动作出单图，多帧动作出精灵图
    const png =
      art.length === 1
        ? encodePresented(art[0], THEME_NORMAL, `${charName}/${actionName}`)
        : buildPresentedSheet(art, THEME_NORMAL);
    writeFileSync(join(dir, `${actionName}.png`), png);

    const zero =
      art.length === 1
        ? encodePresented(art[0], THEME_ZERO, `${charName}/${actionName}`)
        : buildPresentedSheet(art, THEME_ZERO);
    writeFileSync(join(dir, `${actionName}_zero.png`), zero);
    spriteCount += art.length;
  }
}

writeFileSync(join(ROOT, 'assets', 'characters', '_preview.png'), buildCharacterPreview());

console.log(`瓦片 ${count} 张 → assets/map/（理智归零变体在 assets/map/zero/）`);
console.log(`  瓦片名: ${Object.keys(TILES).join(', ')}`);
console.log(`角色帧 ${spriteCount} 张 → assets/characters/<id>/actions/`);
for (const [action, names] of Object.entries(ACTIONS)) {
  console.log(`  ${action}.png = ${names.join(' → ')}（${names.length} 帧）`);
}
console.log('预览: assets/map/_preview.png, assets/characters/_preview.png');

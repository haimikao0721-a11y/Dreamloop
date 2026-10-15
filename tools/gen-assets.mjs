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
  'dddddddddddddddd',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvsvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvsvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvsvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvsvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvsvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
];

/**
 * 地砖变体：多一处旧污，用来打散重复感。
 * 但污渍也要压暗 —— 第一版用锈色 r(#8a4a3a) 太跳，铺满一屏全是橙斑。
 */
const FLOOR_STAINED = [
  'dddddddddddddddd',
  'dvvvvvvvvvvvvvvv',
  'dvvvddvvvvvvvvvv',
  'dvddddvvvvvvvvvv',
  'dvvddvvvvvvvsvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvddddvvvv',
  'dvvvvvvvddddvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvsvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvdvvvvvv',
  'dvvvvvvvvvvvvvvv',
  'dvvvvvvvvvvvvvvv',
];

/**
 * 墙：俯视砖墙。顶沿吃光，砖缝错开排列。
 * 这是屏幕上占比最大的素材，必须一眼读出"这是墙"。
 */
const WALL = [
  'llllllllllllllll',
  'ssssssssssssssss',
  'dddsdddsdddsddds',
  'dddsdddsdddsddds',
  'dddsdddsdddsddds',
  'dddsdddsdddsddds',
  'dddsdddsdddsddds',
  'dddsdddsdddsddds',
  'ssssssssssssssss',
  'dsdddsdddsdddsdd',
  'dsdddsdddsdddsdd',
  'dsdddsdddsdddsdd',
  'dsdddsdddsdddsdd',
  'dsdddsdddsdddsdd',
  'dsdddsdddsdddsdd',
  'kkkkkkkkkkkkkkkk',
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
 */
const WALL_TOP = [
  'dddddddddddddddd',
  'dlllllllllllllld',
  'dlllslllllllllld',
  'dllllllllllsllld',
  'dlllllllllllllld',
  'dlslllllllllllld',
  'dlllllllllllllld',
  'dllllllllsllllld',
  'dlllllllllllllld',
  'dllllsllllllllld',
  'dlllllllllllllld',
  'dllllllllllsllld',
  'dlllllllllllllld',
  'dlllllllllllllld',
  'eeeeeeeeeeeeeeee',
  'dddddddddddddddd',
];

/** 门：门框 + 竖板门身 + 门把手。要能一眼和墙区分 */
const DOOR = [
  'ssssssssssssssss',
  'ssssssssssssssss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssdddsdddsccddss',
  'ssdddsdddsccddss',
  'ssdddsdddsddddss',
  'ssdddsdddsddddss',
  'ssssssssssssssss',
  'ssssssssssssssss',
];

/** 楼梯：一级级收窄、变暗。每一级都有亮边（踏面）和暗面（立面） */
const STAIRS = [
  'eeeeeeeeeeeeeeee',
  'elllllllllllllle',
  'edddddddddddddde',
  'evvvvvvvvvvvvvve',
  'evllllllllllllve',
  'evddddddddddddve',
  'evvvvvvvvvvvvvve',
  'evvllllllllllvve',
  'evvddddddddddvve',
  'evvvvvvvvvvvvvve',
  'evvvllllllllvvve',
  'evvvddddddddvvve',
  'evvvvvvvvvvvvvve',
  'evvvvvvvvvvvvvve',
  'evkkkkkkkkkkkkve',
  'eeeeeeeeeeeeeeee',
];

/** 蜡烛：可拾取、会耗尽的光源 —— 必须一眼认出来 */
const CANDLE = [
  '................',
  '.......C........',
  '......CcC.......',
  '......ccc.......',
  '......ccc.......',
  '.......w........',
  '......bbb.......',
  '......bwb.......',
  '......bwb.......',
  '......bwb.......',
  '......bwb.......',
  '......bwb.......',
  '.....bbwbb......',
  '.....bbbbb......',
  '....sssssss.....',
  '................',
];

/** 固定光源：墙上的烛台。拿不走，所以做成"长在墙上"的样子 */
const WALL_LAMP = [
  '................',
  '................',
  '.......CC.......',
  '......CcCC......',
  '......cCCc......',
  '.......ccc......',
  '........w.......',
  '.......bbb......',
  '.......bbb......',
  '......bbbbb.....',
  '.....sssssss....',
  '.....sssssss....',
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

function renderTile(name, art, palette) {
  return encodePng(TILE, TILE, tileRgba(name, art, palette));
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

   身体只画一次，武器按帧叠加。

   为什么要这样拆：帧数据的本质是"同一个身体，动作在不同时间点"。
   把身体复制三份手改，改一处体型就要改三处 —— 那样帧数一多必然失控。
   叠加的好处是加一帧只需要写几个武器像素。
   ══════════════════════════════════════════════════════════════ */

const SPRITE_W = 16;
const SPRITE_H = 24;

/**
 * 记梦者：瘦、驼背、深色外套，怀里抱着本子。
 *
 * 【外套比墙亮一档】—— 墙用的是 d(#1c1c26)，外套用 s(#272733)。
 * 实时动作游戏里，玩家必须 0.2 秒内分清"哪个是我、哪里是墙"。
 * 全用同一个深色的话，人和墙糊成一片，帧数设计得再好也读不出来。
 */
const ARCHIVIST = [
  '................',
  '.....kkkkkk.....',
  '....kkkkkkkk....',
  '....kppppppk....',
  '....kppppppk....',
  '....kpkppkpk....',
  '....kppppppk....',
  '.....kppppk.....',
  '......kppk......',
  '.....ssssss.....',
  '....ssssssss....',
  '...sssddddsss...',
  '...sssddddsss...',
  '...sssddddsss...',
  '...ssssssssss...',
  '...ssssssssss...',
  '....ssssssss....',
  '....ssssssss....',
  '.....ssssss.....',
  '.....ss..ss.....',
  '.....ss..ss.....',
  '.....ss..ss.....',
  '....sss..sss....',
  '....kkk..kkk....',
];

/** 值夜护士：结实、白制服、护士帽 */
const NURSE = [
  '................',
  '.....wwwwww.....',
  '....wwwwwwww....',
  '....kppppppk....',
  '....kppppppk....',
  '....kpkppkpk....',
  '....kppppppk....',
  '.....kppppk.....',
  '......kppk......',
  '.....bbbbbb.....',
  '....bbbbbbbb....',
  '...bbbddddbbb...',
  '...bbbddddbbb...',
  '...bbbddddbbb...',
  '...bbbbbbbbbb...',
  '...bbbbbbbbbb...',
  '....bbbbbbbb....',
  '....bbbbbbbb....',
  '.....bbbbbb.....',
  '.....bb..bb.....',
  '.....bb..bb.....',
  '.....bb..bb.....',
  '....bbb..bbb....',
  '....kkk..kkk....',
];

/**
 * 攻击帧：把武器叠到身体上。
 *
 * 每个帧就是一组 [x, y, 字符]。三帧对应帧数据的三段：
 *
 *   startup  起手 —— 武器收到身后，还没出来（对手能看见并躲）
 *   active   判定 —— 武器扫到身前，这就是能打到人的窗口
 *   recovery 收招 —— 武器垂下去，此时挨打最疼
 *
 * 武器必须贴着身体走。离远了看起来像"飘着一块光"，
 * 玩家读不出"这一下打向哪里"，帧数也就白设计了。
 */
const SWINGS = {
  startup: [
    [2, 8, 'c'], [1, 9, 'c'], [2, 10, 'C'], [3, 11, 'c'],
  ],
  active: [
    [13, 10, 'c'], [14, 11, 'C'], [13, 12, 'C'], [12, 13, 'c'],
  ],
  recovery: [
    [11, 18, 'c'], [12, 19, 'C'], [12, 20, 'c'], [11, 21, 'c'],
  ],
};

/** 把叠加层画到身体上，返回新的字符画（不改原数组） */
function overlay(body, cells) {
  const out = body.map((row) => row.split(''));
  for (const [x, y, ch] of cells) {
    if (y < 0 || y >= out.length) continue;
    if (x < 0 || x >= out[y].length) continue;
    out[y][x] = ch;
  }
  return out.map((row) => row.join(''));
}

/* ── 敌人 ── */

/**
 * 爬行物：矮、多足、看不清脸。
 * 故意画得【不像人】—— 它逼玩家走位，所以视觉上要让人想躲开。
 * 身体压在画框下半部分，看起来才"贴地"。
 */
const CRAWLER = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....kkkkkk.....',
  '....kmmmmmmk....',
  '...kmmkkkkmmk...',
  '...kmkmmmmkmk...',
  '...kmmkkkkmmk...',
  '...kmmmmmmmmk...',
  '....kmmmmmmk....',
  '.....kkkkkk.....',
  '...k..k..k..k...',
  '..k...k..k...k..',
  '..k...k..k...k..',
  '.k....k..k....k.',
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
 */
const ORDERLY = [
  '................',
  '.....kkkkkk.....',
  '....kkkkkkkk....',
  '....kppppppk....',
  '....kpkppkpk....',
  '....kppppppk....',
  '.....kppppk.....',
  '......kppk......',
  '....ffffffff....',
  '...ffffffffff...',
  '..ffffffffffff..',
  '..ffufffffufff..',
  '..ffufffffufff..',
  '..ffffffffffff..',
  '..ffffffffffff..',
  '...ffffffffff...',
  '...ffffffffff...',
  '....ffffffff....',
  '....ffffffff....',
  '....ff....ff....',
  '....ff....ff....',
  '....ff....ff....',
  '...fff....fff...',
  '...kkk....kkk...',
];

/** 爬行物的扑击：整个身体前倾，武器就是它的嘴 */
const CRAWLER_LUNGE = {
  startup: [
    [8, 12, 'm'], [9, 13, 'm'], [8, 14, 'm'], [7, 13, 'm'],
  ],
  active: [
    [12, 11, 'm'], [13, 12, 'C'], [13, 13, 'C'], [12, 14, 'm'], [11, 13, 'm'],
  ],
  recovery: [
    [4, 17, 'm'], [3, 18, 'm'],
  ],
};

/** 护工的下砸：抬手很高、砸下来很重 —— 起手最长，最该被读出来 */
const ORDERLY_SLAM_SWING = {
  startup: [
    [2, 4, 'c'], [1, 5, 'c'], [2, 6, 'C'], [3, 7, 'c'], [2, 8, 'c'],
  ],
  active: [
    [12, 12, 'c'], [13, 13, 'C'], [14, 14, 'C'], [13, 15, 'c'], [12, 16, 'c'],
  ],
  recovery: [
    [11, 19, 'c'], [12, 20, 'C'], [12, 21, 'c'],
  ],
};

/** 角色 → 一组命名的帧 */
const CHARACTERS = {
  dream_archivist: {
    idle: ARCHIVIST,
    walk_a: overlay(ARCHIVIST, [[5, 22, 'd'], [10, 22, '.']]),
    walk_b: overlay(ARCHIVIST, [[5, 22, '.'], [10, 22, 'd']]),
    attack_startup: overlay(ARCHIVIST, SWINGS.startup),
    attack_active: overlay(ARCHIVIST, SWINGS.active),
    attack_recovery: overlay(ARCHIVIST, SWINGS.recovery),
  },
  ward_nurse: {
    idle: NURSE,
    walk_a: overlay(NURSE, [[5, 22, 'b'], [10, 22, '.']]),
    walk_b: overlay(NURSE, [[5, 22, '.'], [10, 22, 'b']]),
    attack_startup: overlay(NURSE, SWINGS.startup),
    attack_active: overlay(NURSE, SWINGS.active),
    attack_recovery: overlay(NURSE, SWINGS.recovery),
  },
  crawler: {
    idle: CRAWLER,
    walk_a: overlay(CRAWLER, [[4, 18, 'm'], [11, 18, '.']]),
    walk_b: overlay(CRAWLER, [[4, 18, '.'], [11, 18, 'm']]),
    attack_startup: overlay(CRAWLER, CRAWLER_LUNGE.startup),
    attack_active: overlay(CRAWLER, CRAWLER_LUNGE.active),
    attack_recovery: overlay(CRAWLER, CRAWLER_LUNGE.recovery),
  },
  orderly: {
    idle: ORDERLY,
    walk_a: overlay(ORDERLY, [[4, 22, 'f'], [11, 22, '.']]),
    walk_b: overlay(ORDERLY, [[4, 22, '.'], [11, 22, 'f']]),
    attack_startup: overlay(ORDERLY, ORDERLY_SLAM_SWING.startup),
    attack_active: overlay(ORDERLY, ORDERLY_SLAM_SWING.active),
    attack_recovery: overlay(ORDERLY, ORDERLY_SLAM_SWING.recovery),
  },
};

/** 任意尺寸的字符画 → RGBA（角色比瓦片高，所以不能复用 16×16 那套） */
function spriteRgba(name, art, palette) {
  const h = art.length;
  const w = art[0].length;
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
function buildSheet(art, palette, scale = 1) {
  const gap = 2;
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
        ? encodePng(SPRITE_W, SPRITE_H, spriteRgba(`${charName}/${actionName}`, art[0], THEME_NORMAL))
        : buildSheet(art, THEME_NORMAL);
    writeFileSync(join(dir, `${actionName}.png`), png);

    const zero =
      art.length === 1
        ? encodePng(SPRITE_W, SPRITE_H, spriteRgba(`${charName}/${actionName}`, art[0], THEME_ZERO))
        : buildSheet(art, THEME_ZERO);
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

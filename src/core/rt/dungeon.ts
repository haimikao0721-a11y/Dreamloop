/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/dungeon.ts —— 房间生成
 * ════════════════════════════════════════════════════════════════
 *
 *  【一屏一房间】—— 和回合制那边的 generateFloor 不是一个尺度：
 *  那个生成整层（多房间 + 走廊 + 槽位），这个只生成一屏。
 *
 *  实时动作游戏没法让玩家看着一张大地图规划路线，
 *  他的注意力全在躲招上。所以一屏就是一局，清完就走。
 *
 *  ── 生成规则 ──
 *
 *  1. 四周是墙，边界外也算实心（见 physics.ts）
 *  2. 内部撒几块障碍，但【必须留出绕行的路】
 *  3. 生成完做一次连通性检查，不通就重来
 *
 *  第 3 条是关键：没有它的话，早晚会生成出"障碍把房间劈成两半"
 *  的地图，玩家进得去出不来，而且【不会报错】—— 只是卡住。
 * ════════════════════════════════════════════════════════════════
 */

import { TILE_FLOOR, TILE_STAIRS, TILE_WALL } from './types.js';
import type { TileMap } from './types.js';

/** 一个格子的坐标 */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

export interface RoomPlan {
  readonly map: TileMap;
  /** 楼梯位置。玩家走上去就下一层 */
  readonly stairs: Cell;
}

/** 生成时最多重试几次连通性 */
const MAX_TRIES = 40;

/**
 * 从边界开始把能走到的格子全标出来。用来验连通性。
 *
 * 四邻域而不是八邻域 —— 八邻域会让"斜着挤过去"被算成通路，
 * 但玩家在碰撞体下其实挤不过去（身体是有体积的）。
 */
function floodFrom(map: TileMap, sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(map.w * map.h);
  const stack: number[] = [sy * map.w + sx];
  seen[sy * map.w + sx] = 1;

  while (stack.length > 0) {
    const i = stack.pop();
    if (i === undefined) break;
    const x = i % map.w;
    const y = Math.floor(i / map.w);

    // 四邻域
    const nbrs = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const;
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni] === 1) continue;
      /*
       * 【楼梯也要能走】—— 只认 TILE_FLOOR 的话，楼梯格会被当成障碍，
       * 于是"有楼梯的那张图永远判不连通"。
       *
       * 表现很隐蔽：generateRoom 会重试 40 次全部失败，
       * 然后静悄悄退回空房间。看起来像"生成器太保守"，
       * 而不是"连通性检查本身是错的"。
       *
       * 判据统一成"不是墙"，和碰撞那边的 isSolid 对齐。
       */
      if (map.tiles[ni] === TILE_WALL) continue;
      seen[ni] = 1;
      stack.push(ni);
    }
  }
  return seen;
}

/**
 * 这张图的地板是不是全连通的。
 *
 * 【为什么必须查】不查的话，"障碍把房间劈成两半"的地图会出现，
 * 玩家进得去出不来 —— 而且不报错，只是卡住。
 * 这种 bug 在随机生成里是必然会发生的，不是"运气不好"。
 */
export function isConnected(map: TileMap): boolean {
  let firstFloor = -1;
  let floors = 0;
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i] === TILE_FLOOR || map.tiles[i] === TILE_STAIRS) {
      floors++;
      if (firstFloor < 0) firstFloor = i;
    }
  }
  if (firstFloor < 0) return false;

  const seen = floodFrom(map, firstFloor % map.w, Math.floor(firstFloor / map.w));
  let reached = 0;
  for (let i = 0; i < seen.length; i++) if (seen[i] === 1) reached++;
  return reached === floors;
}

export interface GenerateRoomOptions {
  readonly cols: number;
  readonly rows: number;
  /** 取 [0,1) 的随机数。传进来而不是用 Math.random —— 保持确定性 */
  readonly rand: () => number;
  /** 层数越深，障碍越多。0 = 空房间（第 1 层） */
  readonly depth?: number;
}

/**
 * 生成一个房间。
 *
 * 障碍用【矩形块】而不是散点：散点看起来像噪点，方块才像房间里的
 * 柱子 / 病床 / 柜子。而且方块之间的缝隙天然形成走位空间。
 */
export function generateRoom(opts: GenerateRoomOptions): RoomPlan {
  const { cols, rows, rand } = opts;
  const depth = opts.depth ?? 1;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const map: TileMap = {
      w: cols,
      h: rows,
      tiles: new Uint8Array(cols * rows),
    };

    // ① 四周墙
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
        map.tiles[y * cols + x] = border ? TILE_WALL : TILE_FLOOR;
      }
    }

    // ② 内部障碍。块数随层数增长，但【上限卡死】——
    //    障碍太多的话房间会退化成迷宫，而实时动作游戏里
    //    玩家没空在迷宫里绕
    const blocks = Math.min(6, 1 + Math.floor(depth / 2));
    for (let b = 0; b < blocks; b++) {
      const bw = 1 + Math.floor(rand() * 3);
      const bh = 1 + Math.floor(rand() * 3);
      // 留出边界，不贴墙 —— 贴墙的障碍会把靠墙的路堵死
      const bx = 2 + Math.floor(rand() * Math.max(1, cols - bw - 4));
      const by = 2 + Math.floor(rand() * Math.max(1, rows - bh - 4));

      // 单格障碍太碎，看起来像噪点。至少 2 格才像"东西"
      if (bw * bh < 2) continue;

      for (let y = by; y < by + bh && y < rows - 1; y++) {
        for (let x = bx; x < bx + bw && x < cols - 1; x++) {
          map.tiles[y * cols + x] = TILE_WALL;
        }
      }
    }

    // ③ 楼梯：放在离左上角最远的那一片，逼玩家穿过房间
    const stairs: Cell = findStairsSpot(map);
    map.tiles[stairs.y * cols + stairs.x] = TILE_STAIRS;

    // ④ 连通性检查。不通就重来 —— 这是这个函数里最重要的一行
    if (isConnected(map)) return { map, stairs };
  }

  // 重试都失败（房间太小 / 运气太差）→ 退回空房间。
  // 【宁可给一个无聊的房间，也不能给一个走不通的房间】
  return emptyRoom(cols, rows);
}

/** 空房间。生成失败时的兜底，也是测试用的基准 */
export function emptyRoom(cols: number, rows: number): RoomPlan {
  const map: TileMap = { w: cols, h: rows, tiles: new Uint8Array(cols * rows) };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      map.tiles[y * cols + x] = border ? TILE_WALL : TILE_FLOOR;
    }
  }
  const stairs: Cell = { x: cols - 2, y: rows - 2 };
  map.tiles[stairs.y * cols + stairs.x] = TILE_STAIRS;
  return { map, stairs };
}

/**
 * 挑一个放楼梯的格子：离左上角尽量远。
 *
 * 【为什么不用随机】出口离入口越远，玩家越要走完整张图，
 * 也就越可能撞上刷出来的怪。随机的话有可能楼梯就在出生点旁边，
 * 那一层等于白给。
 */
function findStairsSpot(map: TileMap): Cell {
  let best: Cell = { x: map.w - 2, y: map.h - 2 };
  let bestD = -1;
  for (let y = 1; y < map.h - 1; y++) {
    for (let x = 1; x < map.w - 1; x++) {
      if (map.tiles[y * map.w + x] !== TILE_FLOOR) continue;
      // 用曼哈顿距离，不是欧氏 —— 走得远和走得绕是两回事，
      // 而曼哈顿更贴近"实际要走多少步"
      const d = x + y;
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** 玩家踩到楼梯了吗 */
export function onStairs(map: TileMap, x: number, y: number): boolean {
  const tx = Math.floor(x / 16);
  const ty = Math.floor(y / 16);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return false;
  return map.tiles[ty * map.w + tx] === TILE_STAIRS;
}

/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/physics.ts —— AABB 碰撞与地形查询
 * ════════════════════════════════════════════════════════════════
 *
 *  移动用【分轴处理】：先走 X，撞了就把 X 修回去；再走 Y，同理。
 *
 *  为什么分轴：合在一起算的话，贴着墙斜着走会被整个挡住 ——
 *  玩家感觉"卡在墙角动不了"。分轴之后 X 被挡、Y 照走，
 *  自然就沿着墙滑出去了，不需要额外写"滑动"逻辑。
 *
 *  为什么撞了就【吸附到格子边缘】而不是"退回到移动前"：
 *  退回去会永远停在离墙 1~2 px 的地方，看起来像浮在空中；
 *  而且每帧都在"前进一点再退回"，贴墙时会有肉眼可见的抖动。
 * ════════════════════════════════════════════════════════════════
 */

import { TILE, TILE_WALL } from './types.js';
import type { Body, TileMap } from './types.js';

/**
 * 浮点比较的容差。
 * 1e-6 像素远小于一个像素，不会让东西看起来陷进墙里，
 * 但足以避免"贴着墙时每帧反复判定为重叠"。
 */
const EPS = 1e-6;

/** 越界一律当墙 —— 实体永远出不了地图，不需要额外的边界检查 */
export function isSolid(map: TileMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
  return map.tiles[ty * map.w + tx] === TILE_WALL;
}

/**
 * 这个碰撞体是否和任何实心格重叠。
 *
 * 右边和下边减 EPS：AABB 的右边缘【正好】落在格子边界上时，
 * 不该把右边那一格也算进来 —— 否则贴着墙站着会被判定为穿墙。
 */
export function overlapsSolid(body: Body, map: TileMap): boolean {
  const left = Math.floor((body.x - body.hw) / TILE);
  const right = Math.floor((body.x + body.hw - EPS) / TILE);
  const top = Math.floor((body.y - body.hh) / TILE);
  const bottom = Math.floor((body.y + body.hh - EPS) / TILE);

  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (isSolid(map, tx, ty)) return true;
    }
  }
  return false;
}

/**
 * 位移并在撞墙时吸附。
 *
 * 返回是否在某一轴上撞到了东西 —— 调用方可以据此清零速度、
 * 或者播一个"撞墙"的表现。
 */
export function moveAndCollide(body: Body, map: TileMap, dx: number, dy: number): boolean {
  /*
   * 【大位移必须拆成小步走】—— 不拆就会【隧穿】。
   *
   * 撞墙吸附用的是【移动之后】的位置：
   *     x = floor((x - hw) / TILE) * TILE + hw
   * 一次走 60 像素的话，这个位置可能已经在墙【后面好几格】，
   * 吸出来的结果是错的，人就到了墙的另一边。
   *
   * 正常移动每帧才 1~2 像素，撞不出来。但击退一次就是几十像素，
   * 首次出现就是被击退的敌人穿墙跑掉。
   *
   * 每步不超过半格，保证一次只可能跨进相邻的一格。
   */
  const MAX_STEP = TILE / 2;
  const dist = Math.max(Math.abs(dx), Math.abs(dy));
  if (dist > MAX_STEP) {
    const steps = Math.ceil(dist / MAX_STEP);
    let blocked = false;
    for (let i = 0; i < steps; i++) {
      if (moveOnce(body, map, dx / steps, dy / steps)) blocked = true;
    }
    return blocked;
  }
  return moveOnce(body, map, dx, dy);
}

/** 走一小步（不超过半格）并在撞墙时吸附 */
function moveOnce(body: Body, map: TileMap, dx: number, dy: number): boolean {
  let blocked = false;

  if (dx !== 0) {
    body.x += dx;
    if (overlapsSolid(body, map)) {
      // 往右撞：贴到那一格的左边缘外
      // 往左撞：贴到那一格的右边缘外
      body.x =
        dx > 0
          ? Math.floor((body.x + body.hw) / TILE) * TILE - body.hw - EPS
          : (Math.floor((body.x - body.hw) / TILE) + 1) * TILE + body.hw + EPS;
      body.vx = 0;
      blocked = true;
    }
  }

  if (dy !== 0) {
    body.y += dy;
    if (overlapsSolid(body, map)) {
      body.y =
        dy > 0
          ? Math.floor((body.y + body.hh) / TILE) * TILE - body.hh - EPS
          : (Math.floor((body.y - body.hh) / TILE) + 1) * TILE + body.hh + EPS;
      body.vy = 0;
      blocked = true;
    }
  }

  return blocked;
}

/** 两个碰撞体是否相交。中心点表示法让判定只有一行 */
export function aabbOverlap(a: Body, b: Body): boolean {
  return (
    Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh
  );
}

/* ── 地图构造 ── */

export function makeMap(w: number, h: number): TileMap {
  return { w, h, tiles: new Uint8Array(w * h) };
}

export function setTile(map: TileMap, tx: number, ty: number, value: number): void {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return;
  map.tiles[ty * map.w + tx] = value;
}

/** 房间四周加一圈墙。地图本身就是边界，不需要额外的边界判定 */
export function wallBorder(map: TileMap): void {
  for (let x = 0; x < map.w; x++) {
    setTile(map, x, 0, TILE_WALL);
    setTile(map, x, map.h - 1, TILE_WALL);
  }
  for (let y = 0; y < map.h; y++) {
    setTile(map, 0, y, TILE_WALL);
    setTile(map, map.w - 1, y, TILE_WALL);
  }
}

/**
 * 找一个附近不是墙的格子。
 *
 * 【为什么这是 core 的事而不是界面的事】
 * 房间尺寸和隔墙位置都是算出来的（见 docs/06 第十一节：房间尺寸跟着屏幕走），
 * 所以"把东西放在第 10 行第 10 列"这种写法在窄屏上会正好落在墙里 ——
 * 表现就是"这个敌人不见了"，而且不报任何错。
 *
 * 放进 core 才能被测试覆盖。放在界面里就只能靠眼睛看，而眼睛看不出来。
 */
export function findOpenCell(
  map: TileMap,
  tx: number,
  ty: number,
  maxRadius = 10,
): { x: number; y: number } {
  const cx = Math.max(1, Math.min(tx, map.w - 2));
  const cy = Math.max(1, Math.min(ty, map.h - 2));
  if (!isSolid(map, cx, cy)) return { x: cx, y: cy };

  // 一圈圈往外找最近的空地。同圈里按扫描顺序，结果确定 —— 回放不会分叉
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 1 || ny < 1 || nx >= map.w - 1 || ny >= map.h - 1) continue;
        if (!isSolid(map, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  // 整个房间都是墙（不该发生）。返回夹过的坐标，至少不是 NaN
  return { x: cx, y: cy };
}

/**
 * 造一间测试房间：四周是墙，中间一道隔墙，留一个门洞。
 *
 * 【隔墙的方向跟着房间形状走】—— 竖着的房间放竖墙会切出两条很窄的
 * 走廊，横着的房间放横墙同理。让墙垂直于长边，两半才都够宽。
 *
 * 有隔墙才能测出"贴墙滑动"—— 空房间里所有移动都不撞墙，
 * 碰撞代码写错了也测不出来。
 */
export function makeTestRoom(w = 21, h = 15): TileMap {
  const map = makeMap(w, h);
  wallBorder(map);

  if (h > w) {
    // 竖屏房间：横墙，门洞开在中间一列
    const midY = Math.floor(h / 2);
    for (let x = 2; x < w - 2; x++) {
      if (x === Math.floor(w / 2)) continue;
      setTile(map, x, midY, TILE_WALL);
    }
  } else {
    // 横屏房间：竖墙，门洞开在中间一行
    const midX = Math.floor(w / 2);
    for (let y = 2; y < h - 2; y++) {
      if (y === Math.floor(h / 2)) continue;
      setTile(map, midX, y, TILE_WALL);
    }
  }
  return map;
}

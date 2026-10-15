/**
 * ════════════════════════════════════════════════════════════════
 *  core/map.ts —— 地牢生成
 * ════════════════════════════════════════════════════════════════
 *
 *  这里只负责「随机的容器」，【完全不知道剧情的存在】。
 *
 *  它做的事：
 *    1. 随机摆放不重叠的房间
 *    2. 用 L 形走廊连起来
 *    3. 决定入口和楼梯
 *    4. 预留【叙事槽位】—— 这是随机与编排之间的唯一接口
 *    5. 撒怪物
 *
 *  叙事引擎拿到 Floor 后，只往 slots 里填内容，不碰地图结构。
 *  两边互不知情，所以都能独立替换。
 * ════════════════════════════════════════════════════════════════
 */

import { findEnemy } from './content.js';
import type { Rng } from './rng.js';
import type {
  Actor,
  Floor,
  NarrativeSlot,
  Pos,
  Room,
  SlotType,
  TileKind,
} from './types.js';

export interface GenerateFloorOptions {
  readonly depth: number;
  readonly width: number;
  readonly height: number;
  readonly roomCount: readonly [number, number];
  readonly enemyCount: readonly [number, number];
  /** 候选怪物 defId（已按 minDepth 过滤过） */
  readonly enemyIds: readonly string[];
  readonly rng: Rng;
  /** 生成 uid 用（会被就地递增） */
  readonly uidRef: { n: number };
}

/** 房间的最小/最大尺寸 */
const MIN_W = 4, MAX_W = 8;
const MIN_H = 3, MAX_H = 5;
/** 房间之间留的间隔，保证走廊能走通 */
const MARGIN = 1;

export function generateFloor(opts: GenerateFloorOptions): Floor {
  const { rng, width, height } = opts;

  const tiles: TileKind[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (): TileKind => 'wall'),
  );

  const rooms = placeRooms(rng, width, height, opts.roomCount);
  carveRooms(tiles, rooms);
  connectRooms(tiles, rooms, rng);

  // ── 入口 = 第一个房间中心；楼梯 = 最后一个房间中心 ──
  // placeRooms 保证至少返回一个房间，但 noUncheckedIndexedAccess
  // 下还是要显式收窄，否则这里过不了类型检查。
  const firstRoom = rooms[0];
  const lastRoom = rooms[rooms.length - 1];
  if (!firstRoom || !lastRoom) {
    throw new Error('地图生成失败：一个房间都没放下（房间尺寸配置有误？）');
  }
  const entry = centerOf(firstRoom);
  const stairs = centerOf(lastRoom);
  setTile(tiles, stairs, 'stairs');
  setTile(tiles, entry, 'floor');

  // ── 叙事槽位：把剧情锚点绑到具体房间上 ──
  const slots = planSlots(rng, rooms, entry, stairs, opts.depth);

  // ── 撒怪物：入口房间里不放，免得一进来就被打 ──
  const actors = spawnEnemies(rng, rooms, entry, opts.enemyIds, opts.enemyCount, opts.uidRef);

  return {
    depth: opts.depth,
    width,
    height,
    tiles,
    actors,
    items: [],
    rooms,
    slots,
    entry,
    stairs,
  };
}

/* ─────────────────────────── 房间摆放 ─────────────────────────── */

function placeRooms(
  rng: Rng,
  width: number,
  height: number,
  range: readonly [number, number],
): Room[] {
  const target = rng.int(range[0], range[1]);
  const rooms: Room[] = [];

  // 限制尝试次数，避免在拥挤的地图里死循环
  for (let attempt = 0; attempt < 300 && rooms.length < target; attempt++) {
    const w = rng.int(MIN_W, MAX_W);
    const h = rng.int(MIN_H, MAX_H);
    // +2 是给边界留墙
    const x = rng.int(1, width - w - 1);
    const y = rng.int(1, height - h - 1);
    if (x < 1 || y < 1) continue;

    const candidate: Room = { id: rooms.length, x, y, w, h, cleared: false };
    if (rooms.some((r) => overlaps(r, candidate))) continue;
    rooms.push(candidate);
  }

  // 极端情况下一个房间都放不下 —— 兜一个大的，保证游戏不崩
  if (rooms.length === 0) {
    const w = Math.min(width - 2, 8);
    const h = Math.min(height - 2, 5);
    rooms.push({ id: 0, x: 1, y: 1, w, h, cleared: false });
  }
  return rooms;
}

function overlaps(a: Room, b: Room): boolean {
  return (
    a.x - MARGIN < b.x + b.w &&
    a.x + a.w + MARGIN > b.x &&
    a.y - MARGIN < b.y + b.h &&
    a.y + a.h + MARGIN > b.y
  );
}

function carveRooms(tiles: TileKind[][], rooms: readonly Room[]): void {
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        setTile(tiles, { x, y }, 'floor');
      }
    }
  }
}

/* ─────────────────────────── 走廊 ─────────────────────────── */

/**
 * 顺序连接：把房间按 x 排序，每个连到前一个。
 * 这比 Kruskal/Prim 简单得多，但生成的图是连通的，
 * 对"每层 6~8 个房间"的规模完全够用。
 */
function connectRooms(tiles: TileKind[][], rooms: readonly Room[], rng: Rng): void {
  const sorted = [...rooms].sort((a, b) => centerOf(a).x - centerOf(b).x);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const a = centerOf(prev);
    const b = centerOf(cur);
    // 先横后竖 / 先竖后横，随机选一种，让走廊看起来不那么呆板
    if (rng.chance(0.5)) {
      carveH(tiles, a.x, b.x, a.y);
      carveV(tiles, a.y, b.y, b.x);
    } else {
      carveV(tiles, a.y, b.y, a.x);
      carveH(tiles, a.x, b.x, b.y);
    }
  }
}

function carveH(tiles: TileKind[][], x1: number, x2: number, y: number): void {
  const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
  for (let x = lo; x <= hi; x++) setTile(tiles, { x, y }, 'floor');
}

function carveV(tiles: TileKind[][], y1: number, y2: number, x: number): void {
  const [lo, hi] = y1 < y2 ? [y1, y2] : [y2, y1];
  for (let y = lo; y <= hi; y++) setTile(tiles, { x, y }, 'floor');
}

/* ─────────────────────────── 叙事槽位 ─────────────────────────── */

/**
 * 决定本层有哪些叙事槽位，各自绑到哪个房间。
 *
 * 槽位类型决定了剧情的【节奏位置】：
 *   ENTRY   → 入口房，放引入（每层必有）
 *   MID     → 中层房，放支线/lore（1~2 个）
 *   PREBOSS → 楼梯房，放高潮/重大抉择（每层必有）
 *   SECRET  → 最偏僻的房间，放奖励（概率出现）
 *
 * 关键：地图生成器只标注"这里可以放剧情"，具体放什么由叙事引擎决定。
 */
function planSlots(
  rng: Rng,
  rooms: readonly Room[],
  entry: Pos,
  stairs: Pos,
  depth: number,
): NarrativeSlot[] {
  const slots: NarrativeSlot[] = [];
  const taken = new Set<number>();

  const roomAt = (p: Pos): Room | undefined =>
    rooms.find(
      (r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h,
    );

  const add = (type: SlotType, room: Room | undefined, pos: Pos): void => {
    if (!room || taken.has(room.id)) return;
    taken.add(room.id);
    slots.push({
      id: `s${depth}_${type}_${room.id}`,
      type,
      roomId: room.id,
      pos,
      filled: false,
    });
  };

  // 入口和楼梯所在房间必占槽位
  add('ENTRY', roomAt(entry), entry);
  add('PREBOSS', roomAt(stairs), stairs);

  // 中层：从剩下的房间里随机挑 1~2 个
  const rest = rooms.filter((r) => !taken.has(r.id));
  const midCount = Math.min(rng.int(1, 2), rest.length);
  const mids = rng.sample(rest, midCount);
  for (const r of mids) {
    taken.add(r.id);
    slots.push({
      id: `s${depth}_MID_${r.id}`,
      type: 'MID',
      roomId: r.id,
      pos: centerOf(r),
      filled: false,
    });
  }

  // 隐藏房：30% 概率，从最偏远的房间挑一个
  if (rng.chance(0.3)) {
    const left = rooms.filter((r) => !taken.has(r.id));
    const far = left.sort(
      (a, b) => dist(centerOf(b), entry) - dist(centerOf(a), entry),
    )[0];
    if (far) {
      taken.add(far.id);
      slots.push({
        id: `s${depth}_SECRET_${far.id}`,
        type: 'SECRET',
        roomId: far.id,
        pos: centerOf(far),
        filled: false,
      });
    }
  }

  return slots;
}

/* ─────────────────────────── 怪物 ─────────────────────────── */

function spawnEnemies(
  rng: Rng,
  rooms: readonly Room[],
  entry: Pos,
  enemyIds: readonly string[],
  countRange: readonly [number, number],
  uidRef: { n: number },
): Actor[] {
  const actors: Actor[] = [];
  if (enemyIds.length === 0) return actors;

  const entryRoom = rooms.find(
    (r) => entry.x >= r.x && entry.x < r.x + r.w && entry.y >= r.y && entry.y < r.y + r.h,
  );
  // 入口房间整个留空，给玩家一个喘息的开局
  const spawnRooms = rooms.filter((r) => r.id !== entryRoom?.id);
  if (spawnRooms.length === 0) return actors;

  const total = rng.int(countRange[0], countRange[1]);
  for (let i = 0; i < total; i++) {
    const room = spawnRooms[i % spawnRooms.length];
    if (!room) continue;
    const defId = rng.pick(enemyIds);
    if (!defId) continue;
    const def = findEnemy(defId);
    if (!def) continue;

    // 房间内随机落点；和已有怪重合就重试几次
    let pos: Pos | undefined;
    for (let t = 0; t < 12; t++) {
      const cand: Pos = {
        x: rng.int(room.x, room.x + room.w - 1),
        y: rng.int(room.y, room.y + room.h - 1),
      };
      if (cand.x === entry.x && cand.y === entry.y) continue;
      if (actors.some((a) => a.pos.x === cand.x && a.pos.y === cand.y)) continue;
      pos = cand;
      break;
    }
    if (!pos) continue;

    uidRef.n += 1;
    actors.push({
      uid: `act_${uidRef.n}`,
      defId: def.id,
      name: def.name,
      glyph: def.glyph,
      pos,
      hp: def.hp,
      hpMax: def.hp,
      atk: def.atk,
      def: def.def,
      ai: def.ai,
      tags: def.tags,
      acted: false,
    });
  }
  return actors;
}

/* ─────────────────────────── 工具 ─────────────────────────── */

export function centerOf(r: Room): Pos {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

function dist(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function setTile(tiles: TileKind[][], p: Pos, kind: TileKind): void {
  const row = tiles[p.y];
  if (row && p.x >= 0 && p.x < row.length) row[p.x] = kind;
}

export function tileAt(floor: Floor, p: Pos): TileKind {
  return floor.tiles[p.y]?.[p.x] ?? 'wall';
}

export function inBounds(floor: Floor, p: Pos): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < floor.width && p.y < floor.height;
}

export function isWalkable(floor: Floor, p: Pos): boolean {
  if (!inBounds(floor, p)) return false;
  const t = tileAt(floor, p);
  return t === 'floor' || t === 'door' || t === 'stairs';
}

export function actorAt(floor: Floor, p: Pos): Actor | undefined {
  return floor.actors.find((a) => a.pos.x === p.x && a.pos.y === p.y);
}

/** 某个坐标属于哪个房间 */
export function roomAt(floor: Floor, p: Pos): Room | undefined {
  return floor.rooms.find(
    (r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h,
  );
}

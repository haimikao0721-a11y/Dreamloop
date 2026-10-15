/**
 * ════════════════════════════════════════════════════════════════
 *  core/engine.ts —— 状态机（reducer）
 * ════════════════════════════════════════════════════════════════
 *
 *  整个游戏只有两个入口：
 *
 *      createInitialState(opts)   →  开局
 *      reduce(state, intent)      →  推进一帧
 *
 *  reduce 是【纯函数】：
 *    · 同样的 (state, intent) 必然得到同样的结果
 *    · 不读全局变量，不碰 DOM，不调 Math.random()
 *    · 唯一的随机源是 state.rngState
 *
 *  三个实际收益：
 *    · 单元测试可以直接喂 Intent 序列，不用模拟触摸事件
 *    · 存档 = 序列化 state；读档 = 反序列化，没有隐藏状态
 *    · 回放/录像 = 录 Intent 流（肉鸽社区很吃这个，能分享种子局）
 * ════════════════════════════════════════════════════════════════
 */

import { checkRoomCleared, enemyTurn, playerAttack } from './combat.js';
import { allEnemies, findAct, findItem, findRole, loadPacks } from './content.js';
import { applyEffects, makeItem, pushLog } from './effects.js';
import { judgeEnding } from './endings.js';
import { actorAt, generateFloor, isWalkable, tileAt } from './map.js';
import {
  closeStory,
  getCurrentStory,
  getVisibleChoiceIndices,
  getVisibleChoices,
  openStory,
  triggerSlotForRoom,
} from './narrative.js';
import { Rng } from './rng.js';
import {
  DIR_VECTORS,
  type ActDef,
  type Direction,
  type Floor,
  type GameEvent,
  type GameState,
  type InitOptions,
  type Intent,
  type Player,
  type Pos,
} from './types.js';

/* ══════════════════════════════════════════════════════════════
   开局
   ══════════════════════════════════════════════════════════════ */

export function createInitialState(opts: InitOptions): {
  state: GameState;
  events: GameEvent[];
} {
  // 内容包是不可变的全局常量，没必要每次 reduce 都当参数传。
  // 开局时装载一次，之后 core 内部按 id 查表。
  loadPacks([opts.pack]);

  const events: GameEvent[] = [];
  const rng = new Rng(opts.seed);

  const act = findAct(opts.actId);
  if (!act) throw new Error(`内容包里找不到幕 "${opts.actId}"`);

  const role = findRole(opts.roleId);
  if (!role) throw new Error(`内容包里找不到角色 "${opts.roleId}"`);

  const uidRef = { n: 0 };
  const floor = makeFloor(act, 1, rng, uidRef);

  const player: Player = {
    roleId: role.id,
    name: role.name,
    pos: { ...floor.entry },
    hp: role.hp,
    hpMax: role.hp,
    san: role.san,
    sanMax: role.san,
    atk: role.atk,
    def: role.def,
    tags: role.tags,
    inventory: [],
    relics: [],
  };

  const state: GameState = {
    seed: opts.seed,
    rngState: rng.state,
    phase: 'playing',
    actId: act.id,
    act: 1,
    depth: 1,
    turn: 0,
    player,
    floor,
    flags: { ...(opts.inheritedFlags ?? {}) },
    deaths: opts.deaths ?? 0,
    nextUid: uidRef.n,
    seenStories: [],
    takenChoices: [],
    logLine: [],
  };

  // 起始物品
  for (const defId of role.startItems ?? []) {
    const inst = makeItem(state, defId);
    if (inst) player.inventory.push(inst);
  }

  pushLog(state, `${role.name}。${role.desc}`, 'lore');
  pushLog(state, `你在一处不认识的石室里醒来。这是第 ${state.depth} 层。`, 'ambient');
  if (state.deaths > 0) {
    pushLog(state, `（这是你第 ${state.deaths + 1} 次醒来。）`, 'lore');
  }

  // 这里【不】预填叙事槽位。
  //    内容在"房间被清空"的那一刻才选（见 triggerSlotForRoom），
  //    这样 hasItem / san / flag 这类会变化的出现条件反映的是当下真实状态。
  //    生成时就填的话，条件尚未成立的内容永远填不上。

  state.rngState = rng.state;

  return { state, events };
}

/* ══════════════════════════════════════════════════════════════
   推进一帧
   ══════════════════════════════════════════════════════════════ */

export function reduce(state: GameState, intent: Intent): {
  state: GameState;
  events: GameEvent[];
} {
  const events: GameEvent[] = [];
  const s = cloneState(state);
  const rng = new Rng(s.rngState);

  switch (s.phase) {
    case 'story':   handleStory(s, intent, events); break;
    case 'playing': handlePlaying(s, intent, events, rng); break;
    case 'dead':    handleDead(s, intent, events, rng); break;
    case 'actEnd':  break; // 终局，忽略一切输入
  }

  // 随机状态必须写回，否则下一帧的随机序列会从头重来
  s.rngState = rng.state;
  return { state: s, events };
}

/* ─────────────────── 剧情层 ─────────────────── */

function handleStory(s: GameState, intent: Intent, events: GameEvent[]): void {
  if (!s.pendingStory) {
    // 状态自愈：phase 是 story 却没有节点，退回地牢
    closeStory(s, events);
    return;
  }

  if (intent.type === 'cancel') {
    closeStory(s, events);
    return;
  }

  if (intent.type !== 'choose') return;

  // 用 getVisibleChoiceIndices 拿【原始下标】。
  //    因为 requiresTag 过滤会让可见下标和原始下标错位，
  //    而 once 判定必须基于原始下标，否则会记错选项。
  const rawIndices = getVisibleChoiceIndices(s);
  const rawIdx = rawIndices[intent.index];
  if (rawIdx === undefined) return;

  const node = getCurrentStory(s);
  const choice = node?.choices[rawIdx];
  if (!choice) return;

  const nodeId = s.pendingStory;
  s.takenChoices.push(`${nodeId}:${rawIdx}`);

  applyEffects(choice.effects, s, events);

  // effects 里的 goto 已经把 pendingStory 改掉了 → 让位给它
  if (s.pendingStory !== nodeId) return;

  if (choice.next) {
    openStory(s, choice.next, events);
  } else {
    closeStory(s, events);
  }
}

/* ─────────────────── 地牢层 ─────────────────── */

function handlePlaying(
  s: GameState,
  intent: Intent,
  events: GameEvent[],
  rng: Rng,
): void {
  switch (intent.type) {
    case 'move':     doMove(s, intent.dir, events, rng); break;
    case 'wait':
      pushLog(s, '你屏住呼吸，听了一会儿。', 'ambient');
      afterPlayerAction(s, events, rng);
      break;
    case 'interact': doInteract(s, events, rng); break;
    case 'useItem':  doUseItem(s, intent.index, events, rng); break;
    case 'descend':  doDescend(s, events, rng); break;
    default: break;
  }
}

/**
 * 使用背包里的消耗品。
 *
 * 这是「拿理智换力量」的落点：内容的消耗品可以写
 * 扣理智 + 加攻击/回血，玩家得自己权衡。
 * 用一次消耗一个回合，防止无限刷。
 */
function doUseItem(s: GameState, index: number, events: GameEvent[], rng: Rng): void {
  const item = s.player.inventory[index];
  if (!item) return;

  const def = findItem(item.defId);
  if (!def) return;

  if (def.kind !== 'consumable') {
    pushLog(s, `「${def.name}」不能这样用。`, 'ambient');
    return;
  }

  applyEffects(def.effects, s, events);
  pushLog(s, `你用了「${def.name}」。`, 'gain');

  // 消耗掉
  s.player.inventory.splice(index, 1);

  afterPlayerAction(s, events, rng);
}

function doMove(s: GameState, dir: Direction, events: GameEvent[], rng: Rng): void {
  const v = DIR_VECTORS[dir];
  const from: Pos = { ...s.player.pos };
  const to: Pos = { x: from.x + v.x, y: from.y + v.y };

  // ── 撞怪 → 攻击（撞上去就是打，不用单独的"攻击"指令）──
  const target = actorAt(s.floor, to);
  if (target) {
    const killed = playerAttack(s, target, rng, events);
    pushLog(
      s,
      killed ? `${target.name} 散开了，像被水冲掉的墨。` : `你击中了 ${target.name}。`,
      'danger',
    );
    if (killed) dropOnKill(s, target.defId, rng, events);
    afterPlayerAction(s, events, rng);
    return;
  }

  // ── 撞墙 ──
  if (!isWalkable(s.floor, to)) {
    events.push({ type: 'blocked', reason: 'wall' });
    pushLog(s, '那边是墙。', 'ambient');
    return;
  }

  // ── 走 ──
  s.player.pos = to;
  events.push({ type: 'moved', from, to });

  pickUpAt(s, to, events);
  if (s.phase === 'story') return; // 捡到叙事物件，剧情层接管

  if (tileAt(s.floor, to) === 'stairs') {
    pushLog(s, '向下的阶梯。', 'gain');
  }

  afterPlayerAction(s, events, rng);
}

/** 玩家行动后的统一结算：怪物回合 → 死亡 → 理智流失 → 清房间 */
function afterPlayerAction(s: GameState, events: GameEvent[], rng: Rng): void {
  s.turn += 1;

  enemyTurn(s, rng, events);
  if (checkDeath(s, events)) return;

  // 低理智时缓慢流失 —— 制造"必须尽快结束"的压力，
  // 让"变强"和"保命"抢同一个资源这件事真正有代价
  if (s.player.san > 0 && s.player.san <= 30) {
    s.player.san = Math.max(0, s.player.san - 1);
    events.push({ type: 'sanity', delta: -1, sanLeft: s.player.san });
    if (s.player.san === 0) pushLog(s, '你的理智见底了。墙开始呼吸。', 'danger');
  }

  // ── 清空房间 → 触发叙事槽位（叙事物件的掉落时机）──
  for (const roomId of checkRoomCleared(s, events)) {
    pushLog(s, '这里安静下来了。', 'ambient');
    triggerSlotForRoom(s, roomId, rng, events);

    // 掉落的叙事物件可能正好落在玩家脚下。立刻捡起 ——
    // 否则玩家得走开再走回来才能拿到，手感很怪。
    if (s.phase === 'playing') pickUpAt(s, s.player.pos, events);
  }
}

function pickUpAt(s: GameState, pos: Pos, events: GameEvent[]): void {
  const idx = s.floor.items.findIndex((i) => i.pos.x === pos.x && i.pos.y === pos.y);
  if (idx < 0) return;

  const entry = s.floor.items[idx];
  if (!entry) return;
  s.floor.items.splice(idx, 1);

  const def = findItem(entry.item.defId);
  const name = def?.name ?? entry.item.defId;

  s.player.inventory.push(entry.item);
  events.push({ type: 'pickup', defId: entry.item.defId, name });
  pushLog(s, `你拾起了「${name}」。`, 'gain');

  // 叙事物件：拾起即触发全屏剧情
  if (def?.kind === 'narrative' && def.storyNode) {
    openStory(s, def.storyNode, events);
    return;
  }

  // 遗物的 effects 必须在【获得时】结算，不能当纯被动数据晾着。
  //    内容的结局判定会依赖只有遗物才写入的 flag（比如 carries_the_coin），
  //    不结算的话那条结局线永远不可达 —— 作者写了却没人能走到。
  if (def?.kind === 'relic') {
    applyEffects(def.effects, s, events);
  }
}

function doInteract(s: GameState, events: GameEvent[], rng: Rng): void {
  pickUpAt(s, s.player.pos, events);
  if (s.phase === 'story') return;

  if (tileAt(s.floor, s.player.pos) === 'stairs') {
    doDescend(s, events, rng);
    return;
  }
  pushLog(s, '这里没有可以交互的东西。', 'ambient');
}

function doDescend(s: GameState, events: GameEvent[], rng: Rng): void {
  if (tileAt(s.floor, s.player.pos) !== 'stairs') {
    pushLog(s, '你得先找到向下的阶梯。', 'ambient');
    return;
  }

  const act = findAct(s.actId);
  if (!act) return;

  // 本幕最后一层走完 → 判定结局
  if (s.depth >= act.floors) {
    endAct(s, events);
    return;
  }

  s.depth += 1;
  s.floor = nextFloor(s, act, s.depth, rng);
  s.player.pos = { ...s.floor.entry };

  events.push({ type: 'floorChanged', depth: s.depth });
  pushLog(s, `你向下走了一层。第 ${s.depth} 层。`, 'ambient');
}

function endAct(s: GameState, events: GameEvent[]): void {
  const ending = judgeEnding(s);
  s.ending = ending;
  s.phase = 'actEnd';
  events.push({ type: 'actEnded', ending });
  pushLog(s, ending.text, 'lore');
}

/* ─────────────────── 死亡 ─────────────────── */

function checkDeath(s: GameState, events: GameEvent[]): boolean {
  if (s.player.hp > 0) return false;

  s.phase = 'dead';
  s.deaths += 1;

  // 核心设计：死亡不是"读档"，是"又在梦里醒了一次"。
  //    flags 全部保留 —— 死得越多，你知道得越多。
  //    这让肉鸽的重复游玩从叙事障碍变成了叙事资产：
  //    线性剧情游戏永远做不出"用死亡次数解锁内容"这件事。
  s.flags['has_died'] = true;

  events.push({ type: 'died', cause: '力竭' });
  pushLog(s, '你倒下了。', 'danger');
  pushLog(s, '（但梦没有结束。你只是……又醒了一次。）', 'lore');
  return true;
}

function handleDead(s: GameState, intent: Intent, events: GameEvent[], rng: Rng): void {
  if (intent.type !== 'restartAct') return;

  const act = findAct(s.actId);
  if (!act) return;

  // 回到本幕开头。hp/san 回满，flags 保留 —— 这是"醒来"，不是"重来"。
  s.depth = 1;
  s.floor = nextFloor(s, act, 1, rng);
  s.player.hp = s.player.hpMax;
  s.player.san = s.player.sanMax;
  s.player.pos = { ...s.floor.entry };
  s.phase = 'playing';
  s.ending = undefined;
  s.pendingStory = undefined;

  events.push({ type: 'floorChanged', depth: 1 });
  pushLog(s, `第 ${s.deaths + 1} 次醒来。石室还是那个石室。`, 'lore');
}

/* ─────────────────── 工具 ─────────────────── */

/**
 * 生成一层，并把 uid 计数器正确接续上。
 *
 * uid 必须由 state 承载 —— 用模块级计数器的话，
 * 同一个 seed 在不同会话里会给出不同的 uid，种子复现就废了。
 */
function nextFloor(s: GameState, act: ActDef, depth: number, rng: Rng): Floor {
  const uidRef = { n: s.nextUid };
  const floor = makeFloor(act, depth, rng, uidRef);
  s.nextUid = uidRef.n;
  return floor;
}

function makeFloor(
  act: ActDef,
  depth: number,
  rng: Rng,
  uidRef: { n: number },
): Floor {
  const enemyIds = allEnemies()
    .filter((e) => (e.minDepth ?? 1) <= depth)
    .map((e) => e.id);

  return generateFloor({
    depth,
    width: act.floorSize.w,
    height: act.floorSize.h,
    roomCount: act.roomsPerFloor,
    enemyCount: act.enemiesPerFloor,
    enemyIds,
    rng,
    uidRef,
  });
}

/** 击杀后按掉落表给东西 */
function dropOnKill(
  s: GameState,
  enemyDefId: string,
  rng: Rng,
  events: GameEvent[],
): void {
  const def = allEnemies().find((e) => e.id === enemyDefId);
  if (!def?.drop?.length) return;

  const candidates = def.drop.filter(
    (d) => d.kind !== 'nothing' && (d.pool?.length ?? 0) > 0,
  );
  const picked = rng.weighted(candidates.map((c) => ({ weight: c.weight, value: c })));
  const defId = picked?.pool ? rng.pick(picked.pool) : undefined;
  if (!defId) return;

  const inst = makeItem(s, defId);
  if (!inst) return;

  const pos: Pos = { ...s.player.pos };
  s.floor.items.push({ pos, item: inst });
  events.push({ type: 'drop', defId: inst.defId, kind: inst.kind, pos });
  pushLog(s, `${def.name} 留下了什么。`, 'gain');
}

/**
 * 深拷贝状态。
 *
 * 用 structuredClone 而不是手写展开：手写展开每加一个字段就要
 * 同步改一次 clone，漏一个就是"改了但没生效"的诡异 bug。
 * 这个规模（几百个对象）的克隆开销可以忽略。
 */
function cloneState(s: GameState): GameState {
  return structuredClone(s) as GameState;
}

/* ══════════════════════════════════════════════════════════════
   对外查询（UI 用）
   ══════════════════════════════════════════════════════════════ */

/** 当前状态下合法的 Intent 类型 —— UI 可据此禁用按钮 */
export function legalIntents(state: GameState): Intent['type'][] {
  switch (state.phase) {
    case 'playing': return ['move', 'wait', 'interact', 'descend', 'useItem'];
    case 'story':   return ['choose', 'cancel'];
    case 'dead':    return ['restartAct'];
    case 'actEnd':  return [];
  }
}

export { getVisibleChoices, openStory, closeStory };

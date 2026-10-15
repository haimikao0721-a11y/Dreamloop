/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/loop.ts —— 固定时间步与 tick
 * ════════════════════════════════════════════════════════════════
 *
 *  【为什么必须固定 dt】
 *
 *  浮点运算不满足结合律：(a + b) + c !== a + (b + c)。
 *  如果 dt 随渲染帧率浮动，同一个 seed 在 60Hz 手机和 120Hz 手机上
 *  会走出【不同的结果】—— 神种分享、bug 复现、回放录像全部失效。
 *
 *  固定 DT 之后：同一份 seed + 同一条输入时间轴 = 完全相同的一局。
 *
 *  【关于"纯函数"】
 *
 *  docs/06 写的是"tick 除 state 和 input 外不读任何东西"。
 *  tick 【在原地修改 state】，不返回新对象 —— 这一点和回合制的
 *  reduce 不同，是有意的：
 *
 *    一秒要跑 60 次，每次都 structuredClone 整个 state（几十个实体 +
 *    一张地图）会产生大量垃圾。而实时循环对 GC 停顿极其敏感，
 *    一次 major GC 就是一帧明显的卡顿。
 *
 *  确定性【没有损失】：tick 仍然是 (state, input) 的函数，
 *  同样的输入必然得到同样的结果。需要"前后对比"时用 cloneRtState()
 *  先拷一份即可（测试和回放都走这条路）。
 * ════════════════════════════════════════════════════════════════
 */

import { actionDash, advanceAction, applyHits, beginAction, canAct, collectHits } from './action.js';
import { updateAi } from './ai.js';
import { spawn, sweep } from './entities.js';
import { burnFuel } from './light.js';
import { moveAndCollide, makeTestRoom } from './physics.js';
import { pick } from './rng.js';
import { SANITY_MAX, findSpawnSpot, rollSpawn, tickSanity } from './sanity.js';
import { triggerRoomStory, tryPickup, updateClearCounter } from './story.js';
import { DEFAULT_SPAWN, NEUTRAL_INPUT, TILE, makeAiState } from './types.js';
import type { GameEvent } from '../types.js';
import type { Entity, Flags, InputState, RtState, SpawnTemplate } from './types.js';

/** 模拟频率。所有帧数、计时都以它为单位（见 docs/06 第六节） */
export const TICK_RATE = 60;

/** 每次 tick 的固定时间步，永远是这个值 */
export const DT = 1 / TICK_RATE;

/**
 * 一帧最多补几次 tick。
 *
 * 标签页被切到后台再切回来时，累积的时间可能是几十秒。
 * 不设上限就会一次性跑几千次 tick —— 页面直接卡死，
 * 而且玩家回来发现自己已经死了。宁可丢掉这段时间。
 */
export const MAX_CATCHUP_TICKS = 5;

/* ══════════════════════════════════════════════════════════════
   累加器：真实时间 → 模拟次数
   ══════════════════════════════════════════════════════════════ */

export interface Accumulator {
  /** 喂入这一帧真实经过的秒数，返回应该跑几次 tick */
  advance(realDt: number): number;
  /** 还剩多少没消费的时间。只用于调试显示 */
  readonly pending: number;
  reset(): void;
}

export function createAccumulator(): Accumulator {
  let acc = 0;
  return {
    advance(realDt: number): number {
      acc += realDt;
      let n = 0;
      while (acc >= DT && n < MAX_CATCHUP_TICKS) {
        acc -= DT;
        n++;
      }
      // 追不上就整段丢弃，避免下一帧继续欠账（雪崩）
      if (acc > DT * MAX_CATCHUP_TICKS) acc = 0;
      return n;
    },
    get pending(): number {
      return acc;
    },
    reset(): void {
      acc = 0;
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   状态
   ══════════════════════════════════════════════════════════════ */

export interface RtInitOptions {
  seed: number;
  map?: RtState['map'];
  /** 玩家出生点（像素） */
  spawnX?: number;
  spawnY?: number;
  san?: number;
  sanMax?: number;
  /** 每多少 tick 自然掉 1 点理智。0 = 不掉 */
  sanDrainEvery?: number;
  /** 能刷哪些怪。空 = 不刷 */
  spawnTable?: SpawnTemplate[];

  /* 叙事层要的（见 narrative-bridge.ts） */
  actId?: string;
  roleId?: string;
  roleTags?: readonly string[];
  depth?: number;
  flags?: Flags;
  deaths?: number;
  atk?: number;
  def?: number;
}

export function createInitialRtState(opts: RtInitOptions): RtState {
  const map = opts.map ?? makeTestRoom();
  const sanMax = opts.sanMax ?? SANITY_MAX;
  const state: RtState = {
    tick: 0,
    rngState: opts.seed >>> 0,
    phase: 'playing',
    entities: [],
    map,
    nextUid: 0,

    san: opts.san ?? sanMax,
    sanMax,
    // 默认 12 秒掉 1 点 —— 慢到平时感觉不到，但拖久了会有代价
    sanDrainEvery: opts.sanDrainEvery ?? 720,
    sanDrainAcc: 0,

    spawnTimer: 180,
    spawnedTotal: 0,
    spawnTable: opts.spawnTable ?? [],
    spawnConfig: DEFAULT_SPAWN,

    actId: opts.actId ?? 'act_1',
    roleId: opts.roleId ?? 'dream_archivist',
    roleTags: opts.roleTags ?? [],
    depth: opts.depth ?? 1,
    flags: opts.flags ?? {},
    deaths: opts.deaths ?? 0,
    atk: opts.atk ?? 5,
    def: opts.def ?? 1,
    inventory: [],
    nextItemUid: 0,
    seenStories: [],
    takenChoices: [],
    logLine: [],
    roomStoryFired: false,
    noEnemyTicks: 0,
  };

  // 玩家出生在 2.5 格处 —— 贴着墙角出生的话第一帧就会被判定为穿墙
  spawn(state, {
    kind: 'player',
    x: opts.spawnX ?? TILE * 2.5,
    y: opts.spawnY ?? TILE * 2.5,
    hw: 5,
    hh: 6,
    hp: 22,
    speed: 90,
  });

  return state;
}

/** 深拷贝。测试要"前后对比"、回放要从某点分叉时用 */
export function cloneRtState(state: RtState): RtState {
  return {
    tick: state.tick,
    rngState: state.rngState,
    phase: state.phase,
    map: {
      w: state.map.w,
      h: state.map.h,
      tiles: new Uint8Array(state.map.tiles),
    },
    entities: state.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      body: { ...e.body },
      facing: { ...e.facing },
      alive: e.alive,
      hp: e.hp,
      hpMax: e.hpMax,
      speed: e.speed,
      action: {
        def: e.action.def,
        frame: e.action.frame,
        // ⚠️ Set 必须【新建】。直接传引用的话，副本上打一下，
        //    原件也会记成"这一招已经打到过了"。
        hasHit: new Set(e.action.hasHit),
      },
      // ai 是纯数据，浅拷够用；attack / light 是不可变或小而独立的结构
      ai: e.ai === undefined ? undefined : { ...e.ai },
      attack: e.attack,
      light: e.light === undefined ? undefined : { ...e.light },
      sanDrain: e.sanDrain,
    })),
    nextUid: state.nextUid,

    san: state.san,
    sanMax: state.sanMax,
    sanDrainEvery: state.sanDrainEvery,
    sanDrainAcc: state.sanDrainAcc,
    spawnTimer: state.spawnTimer,
    spawnedTotal: state.spawnedTotal,
    // 刷怪表是只读配置，直接共享；写它等于改配置，不该发生
    spawnTable: state.spawnTable,
    spawnConfig: state.spawnConfig,

    actId: state.actId,
    roleId: state.roleId,
    roleTags: state.roleTags,
    depth: state.depth,
    // flags 必须深拷 —— 共享的话副本上改一个标记，原件也跟着变
    flags: { ...state.flags },
    deaths: state.deaths,
    atk: state.atk,
    def: state.def,
    inventory: state.inventory.map((i) => ({ ...i })),
    nextItemUid: state.nextItemUid,
    pendingStory: state.pendingStory,
    seenStories: [...state.seenStories],
    takenChoices: [...state.takenChoices],
    ending: state.ending,
    logLine: state.logLine.map((l) => ({ ...l })),
    roomStoryFired: state.roomStoryFired,
    noEnemyTicks: state.noEnemyTicks,
  };
}

/* ══════════════════════════════════════════════════════════════
   tick
   ══════════════════════════════════════════════════════════════ */

/**
 * 事件类型统一用回合制那套 GameEvent。
 *
 * 【为什么不自立一套】—— 表现层（ui-web/render.ts）已经认识了
 * GameEvent 的每一个分支。实时层再定义一套的话，UI 要写两份渲染逻辑，
 * 而且叙事层拿不到事件（openStory / applyEffects 都收 GameEvent）。
 */
export type TickEvent = GameEvent;

/**
 * 推进一个 tick。【原地修改 state】，事件从返回值拿。
 *
 * phase 不是 'playing' 时直接返回，世界整个冻结 ——
 * 这正是"停住操作是规则"（见 docs/05-表现与文字.md）。
 * 顺带保证了"玩家读了多久剧情"不影响任何数值。
 *
 * ── 五个阶段的顺序是有讲究的，不能随便调 ──
 *
 *   ① 推进帧    所有动作 frame++，先走时间
 *   ② 决策      玩家输入 / 敌人 AI。这一步才决定"这一帧想干什么"
 *   ③ 位移      速度 + 冲刺位移，统一走碰撞
 *   ④ 命中      判定期才结算，hasHit 保证一招只打一次
 *   ⑤ 清理      统一清掉死掉的
 *
 * ①在②之前，是为了让"这一帧刚开始的动作"从 frame 0 算起 ——
 * 反过来的话，起手帧会凭空少一帧，而且边界测试会变得难以解释。
 *
 * ④在③之后，是为了让判定用【这一帧移动完之后】的位置。
 * 反过来的话，冲进攻击范围的那一帧打不到人，手感会很怪。
 */
export function tickRt(state: RtState, input: InputState = NEUTRAL_INPUT): TickEvent[] {
  if (state.phase !== 'playing') return [];

  const events: TickEvent[] = [];
  const dt = DT;

  const player = state.entities.find((e) => e.kind === 'player' && e.alive);

  // ① 时间先走
  for (const entity of state.entities) {
    if (!entity.alive) continue;
    advanceAction(entity.action);
  }

  // ② 决策
  for (const entity of state.entities) {
    if (!entity.alive) continue;

    if (!canAct(entity.action)) {
      // 出招期间【完全不动】。起手能被读、收招要付代价，全靠这一条
      entity.body.vx = 0;
      entity.body.vy = 0;
      continue;
    }

    if (entity.kind === 'player') {
      applyPlayerInput(entity, input);
      if (input.attack && entity.attack !== undefined) {
        beginAction(entity.action, entity.attack);
      }
      // 交互键：捡脚下的东西。捡到叙事物件会直接开剧情，
      // 而 openStory 会把 phase 改成 'story' —— 下一帧世界就冻住了
      if (input.use) {
        tryPickup(state, events);
      }
    } else if (entity.ai !== undefined && player !== undefined) {
      updateAi(entity, player);
    }
  }

  // ③ 位移
  for (const entity of state.entities) {
    if (!entity.alive) continue;
    const dash = actionDash(entity);
    const dx = entity.body.vx * dt + dash.x;
    const dy = entity.body.vy * dt + dash.y;
    if (dx !== 0 || dy !== 0) {
      moveAndCollide(entity.body, state.map, dx, dy);
    }
  }

  // ④ 命中
  for (const entity of state.entities) {
    if (!entity.alive) continue;
    const hits = collectHits(entity, state.entities);
    if (hits.length === 0) continue;
    applyHits(entity, hits);
    for (const hit of hits) {
      events.push({
        type: 'attack',
        attacker: entity.id,
        target: hit.target.id,
        damage: hit.damage,
        killed: !hit.target.alive,
      });
    }
  }

  // ⑤ 光：烧燃料。烧完的蜡烛要发事件，表现层好放个"熄了"的反馈
  for (const burnt of burnFuel(state)) {
    void burnt;
    events.push({ type: 'message', text: '蜡烛烧完了。', tone: 'info' });
  }

  // ⑥ 理智。归零 / 复原都要发事件 —— 地图配色切换挂在这上面
  const san = tickSanity(state);
  if (san !== null) {
    if (san.justZeroed || san.justRecovered) {
      events.push({ type: 'sanity', delta: san.after - san.before, sanLeft: san.after });
    }
  }

  // ⑦ 实时刷怪。理智越低刷得越多（见 sanity.ts 的 spawnMultiplier）
  if (state.spawnTable.length > 0) {
    const aliveFoes = state.entities.filter((e) => e.kind === 'enemy' && e.alive).length;
    const decision = rollSpawn(state, aliveFoes);
    state.spawnTimer = decision.nextTimer;
    if (decision.spawn) {
      const spot = findSpawnSpot(state);
      const tpl = pick(state, state.spawnTable);
      if (spot !== null && tpl !== undefined) {
        spawn(state, {
          kind: 'enemy',
          x: spot.x,
          y: spot.y,
          hp: tpl.hp,
          speed: tpl.speed,
          hw: tpl.hw,
          hh: tpl.hh,
          attack: tpl.attack,
          ai: makeAiState(tpl.ai),
          sanDrain: tpl.sanDrain,
        });
        state.spawnedTotal++;
        void spot;
      }
    }
  }

  // ⑧ 房间清空 → 叙事（第 4 步）。
  // 【放在清理之后】—— 这一帧刚被打死的敌人要算进"没了"，
  // 放在前面的话，最后一只怪死的那一帧计数还是旧的
  updateClearCounter(state);
  if (state.phase === 'playing') {
    triggerRoomStory(state, events);
  }

  // ⑨ 清理（拾取和剧情可能又标记了新的死亡）
  sweep(state);

  state.tick++;
  return events;
}

/**
 * 玩家：输入直接决定速度（不是加速度驱动）。
 *
 * 为什么不做加速/惯性：这是俯视动作游戏，玩家要的是"松手就停"的
 * 精确控制。加了惯性之后走位会滑，躲避帧数的操作就变成了猜。
 */
function applyPlayerInput(entity: Entity, input: InputState): void {
  entity.body.vx = input.moveX * entity.speed;
  entity.body.vy = input.moveY * entity.speed;

  // 朝向只在【有输入时】更新 —— 松手后保持最后的方向，
  // 否则停下来就变成面朝右，攻击方向会莫名其妙地跳
  const len = Math.hypot(input.moveX, input.moveY);
  if (len > 0.01) {
    entity.facing.x = input.moveX;
    entity.facing.y = input.moveY;
  }
}

/**
 * 连跑 n 个 tick。
 * 测试的主力工具：喂同一串输入，逐帧结果必然一致。
 */
export function runTicks(
  state: RtState,
  input: InputState,
  count: number,
): TickEvent[] {
  const all: TickEvent[] = [];
  for (let i = 0; i < count; i++) {
    all.push(...tickRt(state, input));
  }
  return all;
}

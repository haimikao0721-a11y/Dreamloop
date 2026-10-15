/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/types.ts —— 实时层的契约
 * ════════════════════════════════════════════════════════════════
 *
 *  这一层和回合制的 core/types.ts【并存】。见 docs/06-实时架构.md。
 *
 *  为什么另起一份而不是改 GameState：
 *    · 回合制的 state 里有一堆实时制下没意义的东西（turn、acted、格子坐标）
 *    · 实时制的 state 里有回合制没有的东西（速度、朝向向量、命中集）
 *    · 硬合成一个类型，两边都会充满 "这个字段在那边用不到" 的注释
 *
 *  叙事层继续用原来那份 GameState，它一行都不用改。
 * ════════════════════════════════════════════════════════════════
 */

/** 一格多少像素。渲染、碰撞、帧数据里的"范围"都以此为单位换算 */
export const TILE = 16;

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 碰撞体：中心点 + 半宽半高。
 *
 * 用中心点而不是左上角，是因为判定只有一行（见 physics.ts）。
 * 用左上角的话每个方向的比较都要单独写，四个角总有一个写错。
 */
export interface Body {
  x: number;
  y: number;
  /** 半宽 */
  hw: number;
  /** 半高 */
  hh: number;
  /** 像素/秒。实际位移每 tick 按 v * DT 算 */
  vx: number;
  vy: number;
}

export type EntityKind = 'player' | 'enemy' | 'item' | 'prop' | 'light';

/* ── 帧数据 ── */

/**
 * 一个动作的帧定义。全部以 tick 为单位（60 tick = 1 秒）。
 *
 * 三段帧的含义【不是数值，是给玩家的信息】：
 *   startup  起手 —— 这是"能躲"的窗口。没有起手，玩家只能靠反应，不是靠读
 *   active   判定 —— 只有这一段能打到人
 *   recovery 收招 —— 这是"打空要付代价"的窗口。没有收招，无脑连按最优
 *
 * 起手和收招是这套系统存在的全部理由。
 */
export interface ActionDef {
  readonly id: string;
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  /** 攻击距离，像素 */
  readonly range: number;
  /** 扇形角度（度）。360 = 全方位 */
  readonly arc: number;
  readonly damage: number;
  /** 击退距离，像素 */
  readonly knockback: number;
  /** 出招时的位移（冲刺攻击用），像素 */
  readonly moveX: number;
  readonly moveY: number;
}

export interface ActionState {
  def: ActionDef | null;
  /** 已经推进到第几 tick */
  frame: number;
  /**
   * 这次攻击已经打到过谁。
   * 没有它的话，站在判定范围里不动会被同一招打出多次伤害。
   */
  hasHit: Set<string>;
}

export type AiPhase = 'idle' | 'chase';

/**
 * 敌人的 AI 状态。
 *
 * 参数直接挂在 state 上而不是单独传进来 —— 这样"这个敌人多近视、
 * 出招后歇多久"是可存档、可回放、可被内容包改的，
 * 而不是散在调用处的常量。
 */
export interface AiState {
  phase: AiPhase;
  /** 还要等多少 tick 才能再出招 */
  cooldown: number;
  /** 出招后要等多少 tick */
  readonly cooldownMax: number;
  /** 多近开始追 */
  readonly detectRange: number;
  /** 多近开始出招 */
  readonly attackRange: number;
  /**
   * 追到这个距离就停。
   * 没有它的话怪物会一直贴到玩家身上 —— 实体之间不碰撞（docs/06 第四节），
   * 所以它会和玩家完全重叠，看起来像穿模，而且完全挡住视线。
   */
  readonly stopDistance: number;
}

export function makeAiState(cfg: {
  cooldownMax: number;
  detectRange: number;
  attackRange: number;
  stopDistance: number;
}): AiState {
  return {
    phase: 'idle',
    cooldown: 0,
    cooldownMax: cfg.cooldownMax,
    detectRange: cfg.detectRange,
    attackRange: cfg.attackRange,
    stopDistance: cfg.stopDistance,
  };
}

export interface Entity {
  readonly id: string;
  readonly kind: EntityKind;
  body: Body;
  /** 朝向：【最后按的方向】，不是移动方向 —— 站定后能回头打 */
  facing: Vec2;
  /**
   * 死亡标记。销毁走"打标记 + 帧末统一清理"，
   * 不在遍历中改数组 —— 那是实时循环里最容易出的 bug。
   */
  alive: boolean;
  hp: number;
  hpMax: number;
  /** 像素/秒的最大移动速度 */
  speed: number;
  /** 出招状态。所有能动的东西都有一个，包括玩家 */
  action: ActionState;
  /** 敌人 AI。玩家没有 */
  ai?: AiState;
  /** 这个实体能出什么招 */
  attack?: ActionDef;
  /** 起手/判定/收招期间不能移动 —— 这就是"能躲"和"打空要付代价"的实现 */
  readonly immobileWhileActing?: boolean;
}

export function emptyAction(): ActionState {
  return { def: null, frame: 0, hasHit: new Set<string>() };
}

/**
 * 一帧的输入快照。
 *
 * 连续量（moveX/moveY）和离散量（attack/use）放一起，
 * 因为它们【同一帧到达】。拆成两个参数只会让每处调用都写两遍。
 */
export interface InputState {
  /** -1 ~ 1。已归一化，长度 ≤ 1（摇杆推一半 = 走一半） */
  readonly moveX: number;
  /** -1 ~ 1 */
  readonly moveY: number;
  /**
   * 【边沿触发】—— 只在按下的那一 tick 为 true。
   * 按住不放每帧都是 true 的话，收招一结束就自动接下一招，
   * 变成"按住就自动打"，起手帧的意义就没了。
   */
  readonly attack: boolean;
  /** 拾取 / 交互，同样边沿触发 */
  readonly use: boolean;
}

export const NEUTRAL_INPUT: InputState = {
  moveX: 0,
  moveY: 0,
  attack: false,
  use: false,
};

/* ── 地形 ── */

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;

export interface TileMap {
  readonly w: number;
  readonly h: number;
  /** 长度 = w * h，行优先 */
  readonly tiles: Uint8Array;
}

/* ── 状态 ── */

export type RtPhase = 'playing' | 'story' | 'dead';

export interface RtState {
  /** 已经推进了多少 tick。所有计时的唯一时间源 */
  tick: number;
  rngState: number;
  phase: RtPhase;
  entities: Entity[];
  map: TileMap;
  /** 实体 id 发号器。存进 state 而不是全局计数器 —— 否则回放会串号 */
  nextUid: number;
}

/* ── 工具 ── */

/** 当前朝向的单位向量，没有朝向时给 (1, 0) */
export function facingOf(entity: Entity): Vec2 {
  const len = Math.hypot(entity.facing.x, entity.facing.y);
  if (len < 1e-6) return { x: 1, y: 0 };
  return { x: entity.facing.x / len, y: entity.facing.y / len };
}

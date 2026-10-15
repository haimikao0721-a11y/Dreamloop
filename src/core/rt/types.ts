import type { EndingDef, Flags, ItemInstance, MessageTone } from '../types.js';

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

/**
 * 角色表里 atk / def 的基准值。
 *
 * 动作伤害表是按【基准角色】调的，而角色表写的是绝对值
 * （记梦者 atk 5 / def 1）。伤害公式里减掉基准，只取偏移量 ——
 * 否则记梦者打一下凭空多 5 点，整张动作表废掉。
 */
export const BASE_ATK = 5;
export const BASE_DEF = 1;

/* 从回合制那边借几个类型 —— 叙事层两边共用同一套词汇表 */
export type { EndingDef, Flags, ItemInstance, MessageTone } from '../types.js';

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
  /** 这个实体能出什么招（轻击） */
  attack?: ActionDef;
  /** 重击。没有就是不会重击（敌人暂时都不会） */
  heavyAttack?: ActionDef;
  /** 这个实体发光。壁灯、蜡烛都是 */
  light?: LightSource;
  /** 待在它旁边每秒扣多少理智。只有敌人有 */
  sanDrain?: number;
  /**
   * 这个物品对应哪段剧情。拾起来就播它。
   * 只有 kind==='item' 且是叙事物件时才有值。
   */
  storyNode?: string;
  /** 物品定义 id（渲染和拾取用） */
  itemDefId?: string;
}

/* ── 光 ── */

/**
 * 一个光源。
 *
 * 【为什么恢复速率是"每秒"而燃料是 tick】
 * 速率是给策划看的（+2/秒），燃料是给模拟用的（精确到帧）。
 * 混用单位是数值表最容易出错的地方，所以刻意分开写清楚。
 */
export interface LightSource {
  /** 照亮半径，像素 */
  radius: number;
  /** 站在里面每秒恢复多少理智 */
  rate: number;
  /** 剩余燃料，单位 tick。-1 = 无限（壁灯这类固定光源） */
  fuel: number;
  /** 插在地上会烧得更快 —— 回得多，但留不住 */
  readonly planted?: boolean;
}

export function makeLight(radius: number, rate: number, fuel = -1): LightSource {
  return { radius, rate, fuel };
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
  /**
   * 重击。【和 attack 同一个道理，边沿触发】。
   *
   * 重击起手长、收招长、伤害高 —— 面对慢而厚的敌人该用它，
   * 面对快的用轻击。只有一种攻击的话，帧数据里那套
   * "轻/重"的差别就白设计了。
   */
  readonly heavy: boolean;
  /** 拾取 / 交互，同样边沿触发 */
  readonly use: boolean;
}

export const NEUTRAL_INPUT: InputState = {
  moveX: 0,
  moveY: 0,
  attack: false,
  heavy: false,
  use: false,
};

/* ── 地形 ── */

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;
/**
 * 楼梯。走上去下一层。
 *
 * 【建筑在房间清空之后才"开"】—— 地形一直在，但要清空才生效。
 * 这样"打不完就走"不是一个选项，玩家不会跳过战斗。
 */
export const TILE_STAIRS = 3;

export interface TileMap {
  readonly w: number;
  readonly h: number;
  /** 长度 = w * h，行优先 */
  readonly tiles: Uint8Array;
}

/* ── 状态 ── */

export type RtPhase = 'playing' | 'story' | 'dead';

/* ── 刷怪 ── */

/**
 * 一个可刷的敌人模板。
 *
 * 【core 不认识"爬行物"是什么】—— 它只知道"有这么个东西，长这样、
 * 这么难打"。具体是谁、画成什么样，是数据层的事。
 * 这条边界守住了，加 100 个怪不用改一行引擎代码。
 */
export interface SpawnTemplate {
  readonly hp: number;
  readonly speed: number;
  readonly hw: number;
  readonly hh: number;
  readonly attack: ActionDef;
  readonly sanDrain: number;
  readonly ai: {
    readonly cooldownMax: number;
    readonly detectRange: number;
    readonly attackRange: number;
    readonly stopDistance: number;
  };
}

export interface SpawnConfig {
  /** 基准：理智满时平均多少 tick 刷一只 */
  readonly baseInterval: number;
  /** 场上同时最多几只 */
  readonly maxAlive: number;
  /** 离玩家多近之内不许刷 —— 不能凭空出现在脸上 */
  readonly minDistance: number;
}

export const DEFAULT_SPAWN: SpawnConfig = {
  baseInterval: 480, // 满理智时约 8 秒一只
  maxAlive: 12,
  minDistance: 80, // 至少 5 格
};

export interface RtState {
  /** 已经推进了多少 tick。所有计时的唯一时间源 */
  tick: number;
  rngState: number;
  phase: RtPhase;
  entities: Entity[];
  map: TileMap;
  /** 实体 id 发号器。存进 state 而不是全局计数器 —— 否则回放会串号 */
  nextUid: number;

  /* ── 理智（见 docs/06 第九节） ── */

  /**
   * 核心资源。既是"命"也是"货币"。
   *
   * 【归零不是死亡】—— 世界换一层皮：怪物刷到最多、地图换配色。
   * 而且【可逆】：回到光里把理智拉回 1 以上，世界就切回来。
   * 不可逆的话归零就等于"这局完了"，玩家会直接重开。
   */
  san: number;
  sanMax: number;
  /** 自然流失：每多少 tick 掉 1 点 */
  sanDrainEvery: number;
  /** 离上一次自然流失过了多少 tick */
  sanDrainAcc: number;

  /* ── 刷怪 ── */

  /** 距离下一次尝试刷怪还有多少 tick */
  spawnTimer: number;
  /** 这一局已经刷了多少（调试 / 平衡用） */
  spawnedTotal: number;
  /** 从这里面挑着刷。空数组 = 不刷怪 */
  spawnTable: SpawnTemplate[];
  spawnConfig: SpawnConfig;

  /* ── 叙事（接回叙事层用，见 core/rt/narrative-bridge.ts） ── */

  actId: string;
  roleId: string;
  /** 角色 tag —— 剧情选项门控用（学者 / 信徒 / 医者 …） */
  roleTags: readonly string[];
  /** 当前层（从 1 开始） */
  depth: number;
  /** 跨层持久的标记。结局判定全靠它 */
  flags: Flags;
  /** 累计死亡次数（跨局，元叙事层） */
  deaths: number;
  /** 玩家属性。和实体上的 hp 分开：atk/def 是叙事层要读写的 */
  atk: number;
  def: number;
  /** 已持有物品 */
  inventory: ItemInstance[];
  nextItemUid: number;
  /** 剧情层打开时，当前节点 id */
  pendingStory?: string;
  seenStories: string[];
  takenChoices: string[];
  ending?: EndingDef;
  /** 屏幕日志。pushLog 会写它 */
  logLine: { text: string; tone: MessageTone }[];

  /* ── 房间清空 → 叙事槽位 ── */

  /** 这个房间的叙事是否已经触发过。防止清空后每帧都触发 */
  roomStoryFired: boolean;
  /**
   * 已经连续多少 tick 没有敌人。
   *
   * 【为什么不能简单地判断"场上没怪了"】
   * 实时刷怪会让房间【永远不清空】—— 刚打完一只，下一只又冒出来。
   * 所以"清空"必须定义成"持续一段时间没有敌人"。
   * 1.5 秒（90 tick）够玩家喘口气，也不至于等到不耐烦。
   */
  noEnemyTicks: number;
}

/* ── 工具 ── */

/** 当前朝向的单位向量，没有朝向时给 (1, 0) */
export function facingOf(entity: Entity): Vec2 {
  const len = Math.hypot(entity.facing.x, entity.facing.y);
  if (len < 1e-6) return { x: 1, y: 0 };
  return { x: entity.facing.x / len, y: entity.facing.y / len };
}

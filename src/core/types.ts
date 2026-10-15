/**
 * ════════════════════════════════════════════════════════════════
 *  core/types.ts —— 契约层
 * ════════════════════════════════════════════════════════════════
 *
 *  这个文件是整个项目的宪法。规则：
 *
 *   1. core 里【禁止】出现任何 DOM / window / document / CSS 引用。
 *      所有和表现有关的东西都通过 GameEvent 往外交。
 *
 *   2. 所有内容（怪物、物品、剧情、结局）都是【数据】，不是代码。
 *      代码里只允许引用 defId，不允许出现具体内容。
 *
 *   3. 游戏状态流转是纯函数：reduce(state, intent) => { state, events }
 *      同样的 (state, intent) 必然得到同样的结果 —— 没有 hidden state。
 *
 *   4. 随机性只来自 state.rngState，绝不调用 Math.random()。
 *      这样同一个 seed 必然复现同一局。
 * ════════════════════════════════════════════════════════════════
 */

/* ─────────────────────────── 基础 ─────────────────────────── */

export interface Pos {
  readonly x: number;
  readonly y: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export const DIR_VECTORS: Readonly<Record<Direction, Pos>> = {
  up:    { x: 0,  y: -1 },
  down:  { x: 0,  y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1,  y: 0 },
};

/** 比较运算，条件和效果共用 */
export type CompareOp = '>=' | '>' | '<=' | '<' | '==' | '!=';

/* ─────────────────────────── 输入（Intent）─────────────────────────── */

/**
 * Intent 是输入层的唯一出口。
 *
 * 虚拟方向键 / 点格子 / 滑动手势 / 键盘 / 手柄 —— 全都翻译成 Intent。
 * core 收到 Intent 时，【不知道】玩家用的是手机还是键盘。
 * 这样加一种新输入方式，core 一行都不用改。
 */
export type Intent =
  | { readonly type: 'move'; dir: Direction }
  | { readonly type: 'wait' }
  | { readonly type: 'interact' }
  | { readonly type: 'cancel' }
  /** 剧情选项。index 是从 0 开始的可见选项序号 */
  | { readonly type: 'choose'; index: number }
  /** 使用背包里第 index 件物品（消耗品） */
  | { readonly type: 'useItem'; index: number }
  /** 下楼 */
  | { readonly type: 'descend' }
  /** 重开本幕（游戏性死亡后） */
  | { readonly type: 'restartAct' };

/* ─────────────────────────── 地块与地图 ─────────────────────────── */

export type TileKind =
  | 'wall'
  | 'floor'
  /** 门：视觉上区分于普通地面，暂不影响通行 */
  | 'door'
  /** 向下一层的楼梯 */
  | 'stairs';

export interface Room {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 房间内敌人清空后置 true —— 叙事物品的掉落条件 */
  cleared: boolean;
}

/**
 * 叙事槽位的类型。这是"随机地牢"和"编排剧情"之间的接口。
 *
 * 地图生成器只负责预留槽位，【不知道】会填进什么剧情。
 * 叙事引擎只负责往槽位里填，【不知道】地图长什么样。
 */
export type SlotType =
  /** 入口附近，放引入性内容。每层必有 1 个 */
  | 'ENTRY'
  /** 中层，放支线 / lore。每层 1~2 个 */
  | 'MID'
  /** Boss 前，放高潮 / 重大抉择。每层必有 1 个 */
  | 'PREBOSS'
  /** 隐藏房间，放奖励。可有可无 */
  | 'SECRET';

export interface NarrativeSlot {
  readonly id: string;
  readonly type: SlotType;
  readonly roomId: number;
  readonly pos: Pos;
  /** 已填入剧情并已触发过 */
  filled: boolean;
  /** 填入的剧情节点 id */
  nodeId?: string;
}

/* ─────────────────────────── 实体 ─────────────────────────── */

export type AiKind = 'idle' | 'aggressive';

export interface Actor {
  /** 运行时唯一 id */
  readonly uid: string;
  /** 指向内容库中的定义 */
  readonly defId: string;
  name: string;
  glyph: string;
  pos: Pos;
  hp: number;
  hpMax: number;
  atk: number;
  def: number;
  ai: AiKind;
  tags: readonly string[];
  /** 本回合已行动过，防止同一回合多次出手 */
  acted: boolean;
}

export interface Player {
  readonly roleId: string;
  name: string;
  pos: Pos;
  hp: number;
  hpMax: number;
  san: number;
  sanMax: number;
  atk: number;
  def: number;
  /** 角色 tag —— 剧情选项门控用（学者 / 信徒 / 医者 …） */
  tags: readonly string[];
  /** 已持有物品（实例） */
  inventory: ItemInstance[];
  /** 已装备的遗物 defId 列表 */
  relics: string[];
}

/* ─────────────────────────── 物品 ─────────────────────────── */

export type ItemKind =
  | 'consumable'
  /** 遗物：被动效果，局内永久 */
  | 'relic'
  /** 叙事物件：拾起即触发全屏剧情。这就是"清房间掉叙事物品"的载体 */
  | 'narrative'
  /** 钥匙：开门用 */
  | 'key';

export interface ItemInstance {
  readonly uid: string;
  readonly defId: string;
  readonly kind: ItemKind;
}

/** 掉落表的一条 */
export interface DropEntry {
  readonly kind: ItemKind | 'nothing';
  /** 候选 defId；为空表示 kind='nothing' */
  readonly pool?: readonly string[];
  readonly weight: number;
  /** 只有满足这些条件才可能掉落 */
  readonly requires?: readonly Condition[];
  /** 是否必定掉落（绕过权重，用于"清房间必掉剧情"） */
  readonly guaranteed?: boolean;
}

/* ─────────────────────────── 楼层 ─────────────────────────── */

export interface Floor {
  readonly depth: number;
  readonly width: number;
  readonly height: number;
  /** tiles[y][x] */
  tiles: TileKind[][];
  actors: Actor[];
  items: { pos: Pos; item: ItemInstance }[];
  rooms: Room[];
  slots: NarrativeSlot[];
  entry: Pos;
  stairs: Pos;
}

/* ─────────────────────────── 条件与效果 ─────────────────────────── */

/**
 * 条件（Condition）—— 声明式，用于：
 *   · 剧情节点/选项的出现条件
 *   · 结局判定
 *   · 掉落表的过滤
 */
export type Condition =
  /** flag 存在 / 等于某值 */
  | { readonly kind: 'flag'; readonly key: string; readonly value?: boolean | number }
  /** flag 不存在 */
  | { readonly kind: 'noFlag'; readonly key: string }
  /** 累计死亡次数 */
  | { readonly kind: 'deaths'; readonly op: CompareOp; readonly value: number }
  /** 当前理智 */
  | { readonly kind: 'san'; readonly op: CompareOp; readonly value: number }
  /** 当前生命 */
  | { readonly kind: 'hp'; readonly op: CompareOp; readonly value: number }
  /** 角色 tag */
  | { readonly kind: 'tag'; readonly value: string }
  /** 持有某物品 */
  | { readonly kind: 'hasItem'; readonly defId: string }
  /** 当前层数 */
  | { readonly kind: 'depth'; readonly op: CompareOp; readonly value: number }
  /** 逻辑组合 */
  | { readonly kind: 'all'; readonly of: readonly Condition[] }
  | { readonly kind: 'any'; readonly of: readonly Condition[] }
  | { readonly kind: 'not'; readonly of: Condition };

/**
 * 效果（Effect）—— 声明式，剧情选项 / 物品使用 会产出这些。
 *
 * 注意这里【没有】任何"直接改数值"的越权入口：
 * 所有数值变化都必须走这些明确的 kind，方便审计和平衡。
 */
export type Effect =
  | { readonly kind: 'setFlag'; readonly key: string; readonly value: boolean | number }
  | { readonly kind: 'addFlag'; readonly key: string; readonly delta: number }
  | { readonly kind: 'sanity'; readonly delta: number }
  | { readonly kind: 'heal'; readonly amount: number }
  | { readonly kind: 'damage'; readonly amount: number }
  /**
   * 永久修改一项属性上限/数值。
   *
   * 这一条是「变强要拿理智去换」能被纯数据表达的关键 ——
   * 没有它，内容作者只能写「扣理智 + 回血」，
   * 而真正的力量成长无法落在属性上。
   */
  | {
      readonly kind: 'buff';
      readonly stat: 'atk' | 'def' | 'hpMax' | 'sanMax';
      readonly amount: number;
    }
  | { readonly kind: 'giveItem'; readonly defId: string }
  /** 往日志里写一行（叙事用） */
  | { readonly kind: 'message'; readonly text: string; readonly tone?: MessageTone }
  /** 触发另一个剧情节点（链式） */
  | { readonly kind: 'goto'; readonly nodeId: string };

export type MessageTone = 'info' | 'danger' | 'lore' | 'gain' | 'ambient';

/* ─────────────────────────── 剧情 ─────────────────────────── */

export interface StoryChoice {
  readonly text: string;
  /** 需要角色拥有这个 tag 才显示（角色差异化剧情的核心机制） */
  readonly requiresTag?: string;
  /** 其他出现条件 */
  readonly requires?: readonly Condition[];
  /** 已选过就不再显示 */
  readonly once?: boolean;
  readonly effects: readonly Effect[];
  /** 选完跳到另一个节点；不填则关闭剧情层 */
  readonly next?: string;
  /** 选项角标，比如"学者" */
  readonly badge?: string;
}

export interface StoryNode {
  readonly id: string;
  /** 正文。用 \n 分段，UI 负责排版 */
  readonly text: string;
  /** 引用块（那种"书上写着……"的效果） */
  readonly quote?: string;
  /** 出现条件；不满足则该节点不会被填入槽位 */
  readonly requires?: readonly Condition[];
  /** 同一个槽位有多个候选时的选取权重 */
  readonly weight?: number;
  /** 只在指定类型的槽位出现 */
  readonly slots?: readonly SlotType[];
  /** 限定出现的最小/最大层数 */
  readonly minDepth?: number;
  readonly maxDepth?: number;
  readonly choices: readonly StoryChoice[];
}

/* ─────────────────────────── 结局 ─────────────────────────── */

export interface EndingDef {
  readonly id: string;
  readonly name: string;
  /** 数值大的优先判定；都不满足则走 priority 最低的兜底结局 */
  readonly priority: number;
  readonly requires: readonly Condition[];
  readonly text: string;
  /** 是否算作"通关" */
  readonly victory?: boolean;
  /**
   * 「差一点就能走到」时给玩家看的一句话提示。
   *
   * 只在这一局【没有】达成这个结局时显示。作用是驱动重开 ——
   * 肉鸽的命门是重开率，而"我差一步就拿到了"是最强的重开动机。
   *
   * 写法建议：说【玩家该做什么】，不要说内部 flag 名。
   *   ✅ '在还清醒的时候念出那个名字'
   *   ❌ '需要 knows_the_name = true'
   */
  readonly hint?: string;
}

/* ─────────────────────────── 内容库 ─────────────────────────── */

export interface EnemyDef {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly hp: number;
  readonly atk: number;
  readonly def: number;
  readonly ai: AiKind;
  readonly tags: readonly string[];
  readonly minDepth?: number;
  readonly drop?: readonly DropEntry[];
}

export interface ItemDef {
  readonly id: string;
  readonly name: string;
  readonly kind: ItemKind;
  readonly glyph?: string;
  readonly desc?: string;
  /** 使用/拾取时的效果 */
  readonly effects?: readonly Effect[];
  /** 拾取时触发的剧情节点（叙事物件用） */
  readonly storyNode?: string;
}

export interface RoleDef {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly hp: number;
  readonly san: number;
  readonly atk: number;
  readonly def: number;
  readonly tags: readonly string[];
  readonly startItems?: readonly string[];
}

export interface ActDef {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  /** 本幕包含几层 */
  readonly floors: number;
  /** 每层的尺寸 */
  readonly floorSize: { readonly w: number; readonly h: number };
  /** 每层房间数区间 */
  readonly roomsPerFloor: readonly [number, number];
  /** 每层的怪物数量区间 */
  readonly enemiesPerFloor: readonly [number, number];
  /** 本幕的结局判定表 */
  readonly endings: readonly EndingDef[];
}

/** 一个内容包（原版是 core 包；社区扩展是独立包） */
export interface ContentPack {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** 命名空间，防止 mod 撞 id */
  readonly namespace: string;
  readonly roles?: readonly RoleDef[];
  readonly enemies?: readonly EnemyDef[];
  readonly items?: readonly ItemDef[];
  readonly stories?: readonly StoryNode[];
  readonly acts?: readonly ActDef[];
}

/* ─────────────────────────── 事件（core → UI）─────────────────────────── */

/**
 * GameEvent 是 core 对外的唯一出口。
 *
 * UI 收到事件后【决定怎么表现】（要不要震动、要不要播动画、要不要全屏）。
 * core 完全不关心这些。
 */
export type GameEvent =
  | { readonly type: 'moved'; readonly from: Pos; readonly to: Pos }
  | { readonly type: 'blocked'; readonly reason: 'wall' | 'actor' }
  | { readonly type: 'message'; readonly text: string; readonly tone: MessageTone }
  /** 战斗结算 */
  | {
      readonly type: 'attack';
      readonly attacker: string;
      readonly target: string;
      readonly damage: number;
      readonly killed: boolean;
    }
  /** 玩家受伤 */
  | { readonly type: 'hurt'; readonly amount: number; readonly hpLeft: number }
  /** 怪物行动 */
  | { readonly type: 'enemyTurn'; readonly count: number }
  /** 房间清空 —— 叙事物品的掉落时机 */
  | { readonly type: 'roomCleared'; readonly roomId: number }
  /** 掉落 */
  | { readonly type: 'drop'; readonly defId: string; readonly kind: ItemKind; readonly pos: Pos }
  | { readonly type: 'pickup'; readonly defId: string; readonly name: string }
  /** 打开全屏剧情层 */
  | { readonly type: 'story'; readonly nodeId: string }
  | { readonly type: 'storyClosed' }
  /** 理智变化（UI 可以据此做画面效果） */
  | { readonly type: 'sanity'; readonly delta: number; readonly sanLeft: number }
  /** 有叙事槽位被填入（调试/开发用） */
  | { readonly type: 'slotFilled'; readonly slotId: string; readonly nodeId: string }
  /** 玩家死亡 */
  | { readonly type: 'died'; readonly cause: string }
  /** 本幕结束，判定出结局 */
  | { readonly type: 'actEnded'; readonly ending: EndingDef }
  /** 楼层切换 */
  | { readonly type: 'floorChanged'; readonly depth: number };

/* ─────────────────────────── 游戏状态 ─────────────────────────── */

export type Phase =
  | 'playing'
  /** 全屏剧情层打开中，只接受 choose / cancel */
  | 'story'
  /** 游戏性死亡，等玩家 restartAct */
  | 'dead'
  /** 本幕结束，已出结局 */
  | 'actEnd';

export type Flags = Record<string, boolean | number>;

export interface GameState {
  /** 整局的种子。同一个 seed 必然复现同一局 */
  readonly seed: number;
  /** 随机数发生器的当前状态 —— 它就是全部的"随机性来源" */
  rngState: number;
  phase: Phase;
  /** 当前幕的 id（对应 ContentPack.acts[].id） */
  actId: string;
  /** 当前幕的序号（第一幕 = 1） */
  act: number;
  /** 当前层（从 1 开始） */
  depth: number;
  /** 回合数 */
  turn: number;

  player: Player;
  floor: Floor;

  /** 跨层持久的标记。结局判定全靠它 */
  flags: Flags;
  /** 累计死亡次数（跨局，元叙事层） */
  deaths: number;

  /**
   * 运行时唯一 id 的自增计数器。
   *
   * 必须存在 state 里而不是模块级变量 —— 否则同一个 seed 在
   * 不同会话里会生成不同的 uid，种子复现就废了。
   */
  nextUid: number;

  /** 剧情层打开时，当前节点 id */
  pendingStory?: string;
  /** 已经触发过的一次性剧情节点 */
  seenStories: string[];
  /** 已经选过的选项（配合 once 使用），key = `${nodeId}:${choiceIdx}` */
  takenChoices: string[];

  /** 本幕结束时的结局（phase==='actEnd' 时有值） */
  ending?: EndingDef;

  /** 屏幕日志（保留最近 N 条） */
  logLine: { text: string; tone: MessageTone }[];
}

export interface ReduceResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** 初始化一局所需的外部依赖 */
export interface InitOptions {
  readonly seed: number;
  readonly actId: string;
  readonly roleId: string;
  readonly pack: ContentPack;
  /** 继承自上一局的 flag（元叙事层） */
  readonly inheritedFlags?: Flags;
  readonly deaths?: number;
}

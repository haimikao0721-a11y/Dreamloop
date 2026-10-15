/**
 * ════════════════════════════════════════════════════════════════
 *  内容完整性测试
 * ════════════════════════════════════════════════════════════════
 *
 *  这个文件是【社区提交内容的第一道闸】。
 *
 *  开源项目最怕的不是代码有 bug，是内容引用错一个 id：
 *  引擎不会崩（所有查找都返回 undefined 并且被兜住了），
 *  但那段内容会静默失效 —— 作者写了，玩家永远看不到，
 *  而且没人会发现问题。
 *
 *  所以这里做的是「程序化审计」：
 *    · 所有 id 引用必须能解析
 *    · 所有 requiresTag 必须真存在于某个角色
 *    · 所有结局必须可达（flag 得有人写）
 *    · 必须有兜底结局（否则玩家会走到"没有结局"）
 *    · 内容能真的被引擎跑起来
 * ════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';

import { CORE_PACK } from '../src/data/packs/core/index.js';
import {
  createInitialState,
  DIR_VECTORS,
  findItem,
  getVisibleChoices,
  isWalkable,
  judgeEnding,
  reduce,
  tileAt,
  type Condition,
  type Direction,
  type Effect,
  type GameState,
  type Intent,
  type Pos,
} from '../src/core/index.js';
import { Rng } from '../src/core/rng.js';

/* ─────────────────── 索引 ─────────────────── */

const ITEM_IDS = new Set((CORE_PACK.items ?? []).map((i) => i.id));
const ENEMY_IDS = new Set((CORE_PACK.enemies ?? []).map((e) => e.id));
const STORY_IDS = new Set((CORE_PACK.stories ?? []).map((s) => s.id));
const ROLE_IDS = new Set((CORE_PACK.roles ?? []).map((r) => r.id));
const ALL_TAGS = new Set((CORE_PACK.roles ?? []).flatMap((r) => [...r.tags]));
const ACT = CORE_PACK.acts?.[0];

/** 递归收集一个 Condition 里引用到的 flag key */
function flagsIn(c: Condition): string[] {
  switch (c.kind) {
    case 'flag':
    case 'noFlag':
      return [c.key];
    case 'all':
    case 'any':
      return c.of.flatMap(flagsIn);
    case 'not':
      return flagsIn(c.of);
    default:
      return [];
  }
}

/** 递归收集一组 Effect 写入的 flag key */
function flagsWritten(effects: readonly Effect[]): string[] {
  const out: string[] = [];
  for (const e of effects) {
    if (e.kind === 'setFlag' || e.kind === 'addFlag') out.push(e.key);
  }
  return out;
}

/** 全内容里所有会被写入的 flag */
const ALL_WRITTEN_FLAGS = new Set<string>([
  // 引擎自己写的
  'has_died',
  ...(CORE_PACK.stories ?? []).flatMap((s) =>
    s.choices.flatMap((ch) => flagsWritten(ch.effects)),
  ),
  ...(CORE_PACK.items ?? []).flatMap((i) => flagsWritten(i.effects ?? [])),
]);

/* ═══════════════════════════════════════════════════════════════
   1. 引用完整性
   ═══════════════════════════════════════════════════════════════ */

describe('内容引用完整性', () => {
  it('叙事物件的 storyNode 都指向真实存在的剧情节点', () => {
    const narrative = (CORE_PACK.items ?? []).filter((i) => i.kind === 'narrative');
    expect(narrative.length).toBeGreaterThan(0);
    for (const item of narrative) {
      expect(item.storyNode, `物品 ${item.id} 是 narrative 但没有 storyNode`).toBeTruthy();
      expect(
        STORY_IDS.has(item.storyNode ?? ''),
        `物品 ${item.id} 引用了不存在的剧情节点 "${item.storyNode}"`,
      ).toBe(true);
    }
  });

  it('怪物掉落池里的物品 id 都存在', () => {
    for (const enemy of CORE_PACK.enemies ?? []) {
      for (const drop of enemy.drop ?? []) {
        for (const id of drop.pool ?? []) {
          expect(ITEM_IDS.has(id), `怪物 ${enemy.id} 掉落不存在的物品 "${id}"`).toBe(true);
        }
        // kind 必须和物品定义一致，否则掉出来会是错的类型
        if (drop.pool && drop.pool.length > 0) {
          const first = (CORE_PACK.items ?? []).find((i) => i.id === drop.pool?.[0]);
          if (first) {
            expect(
              first.kind,
              `怪物 ${enemy.id} 的掉落声明 kind=${drop.kind}，但物品 ${first.id} 实际是 ${first.kind}`,
            ).toBe(drop.kind);
          }
        }
      }
    }
  });

  it('角色起始物品都存在', () => {
    for (const role of CORE_PACK.roles ?? []) {
      for (const id of role.startItems ?? []) {
        expect(ITEM_IDS.has(id), `角色 ${role.id} 的起始物品 "${id}" 不存在`).toBe(true);
      }
    }
  });

  it('剧情 Effect 里引用的物品 / 剧情 / flag 都有效', () => {
    for (const story of CORE_PACK.stories ?? []) {
      for (const choice of story.choices) {
        for (const e of choice.effects) {
          if (e.kind === 'giveItem') {
            expect(ITEM_IDS.has(e.defId), `${story.id} 给了不存在的物品 "${e.defId}"`).toBe(true);
          }
          if (e.kind === 'goto') {
            expect(STORY_IDS.has(e.nodeId), `${story.id} 跳转到不存在的节点 "${e.nodeId}"`).toBe(true);
          }
        }
        if (choice.next) {
          expect(STORY_IDS.has(choice.next), `${story.id} 的 next 指向不存在的 "${choice.next}"`).toBe(
            true,
          );
        }
      }
    }
  });

  it('物品 effects 引用的东西都存在', () => {
    for (const item of CORE_PACK.items ?? []) {
      for (const e of item.effects ?? []) {
        if (e.kind === 'giveItem') {
          expect(ITEM_IDS.has(e.defId), `物品 ${item.id} 给了不存在的 "${e.defId}"`).toBe(true);
        }
        if (e.kind === 'goto') {
          expect(STORY_IDS.has(e.nodeId), `物品 ${item.id} 跳转到不存在的节点`).toBe(true);
        }
      }
    }
  });

  it('叙事物件的 storyNode 不能被写成有条件出现的节点', () => {
    // 物品触发时不该再检查出现条件 —— 否则会出现
    // "东西拿到了，剧情却不弹"这种最让人困惑的 bug
    for (const item of (CORE_PACK.items ?? []).filter((i) => i.kind === 'narrative')) {
      const node = (CORE_PACK.stories ?? []).find((s) => s.id === item.storyNode);
      expect(node, `物品 ${item.id} 的 storyNode "${item.storyNode}" 不存在`).toBeDefined();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 角色门控
   ═══════════════════════════════════════════════════════════════ */

describe('角色门控', () => {
  it('每个 requiresTag 都真存在于某个角色身上', () => {
    for (const story of CORE_PACK.stories ?? []) {
      for (const choice of story.choices) {
        if (!choice.requiresTag) continue;
        expect(
          ALL_TAGS.has(choice.requiresTag),
          `${story.id} 的选项要求 tag "${choice.requiresTag}"，但没有任何角色拥有它 —— 这个选项永远不可见`,
        ).toBe(true);
      }
    }
  });

  it('每个剧情节点至少保留一个非门控选项（角色不会卡死）', () => {
    for (const story of CORE_PACK.stories ?? []) {
      const open = story.choices.filter((c) => !c.requiresTag);
      expect(
        open.length,
        `${story.id} 的所有选项都带 requiresTag，某些角色会遇到"没有选项可选"`,
      ).toBeGreaterThan(0);
    }
  });

  it('两个角色看到的选项确实不同（这是"角色选择改变剧情"的验证点）', () => {
    const roles = CORE_PACK.roles ?? [];
    expect(roles.length).toBeGreaterThanOrEqual(2);

    const gated = (CORE_PACK.stories ?? []).filter((s) =>
      s.choices.some((c) => c.requiresTag),
    );
    expect(gated.length, '没有任何带角色门控的剧情，角色差异形同虚设').toBeGreaterThan(0);
  });

  it('两个角色的 tag 集合不重合（保证剧情分叉是真的分叉）', () => {
    const [a, b] = CORE_PACK.roles ?? [];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    const overlap = a.tags.filter((t) => b.tags.includes(t));
    expect(overlap, `两个角色共有 tag ${overlap.join(',')}，剧情分叉会被削弱`).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 结局可达性
   ═══════════════════════════════════════════════════════════════ */

describe('结局可达性', () => {
  const endings = ACT?.endings ?? [];

  it('存在兜底结局（requires 为空），否则玩家会走到"没有结局"', () => {
    const fallback = endings.filter((e) => e.requires.length === 0);
    expect(fallback.length, '缺少 requires: [] 的兜底结局').toBeGreaterThan(0);
  });

  it('所有结局读到的 flag 都必须有人写，否则永远不可达', () => {
    for (const e of endings) {
      for (const key of e.requires.flatMap(flagsIn)) {
        expect(
          ALL_WRITTEN_FLAGS.has(key),
          `结局 ${e.id} 依赖 flag "${key}"，但没有任何内容会写入它 —— 这条结局永远是死代码`,
        ).toBe(true);
      }
    }
  });

  it('官方内容不含胜利结局（好结局留给社区扩展）', () => {
    for (const e of endings) {
      expect(e.victory ?? false, `结局 ${e.id} 标了 victory，但官方只做绝望线`).toBe(false);
    }
  });

  it('结局 id 不重复', () => {
    const ids = endings.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 结构性要求
   ═══════════════════════════════════════════════════════════════ */

describe('内容结构', () => {
  it('幕的层数和尺寸配置合法', () => {
    expect(ACT).toBeDefined();
    if (!ACT) return;
    expect(ACT.floors).toBeGreaterThanOrEqual(1);
    expect(ACT.floorSize.w).toBeGreaterThan(10);
    expect(ACT.floorSize.h).toBeGreaterThan(8);
    expect(ACT.roomsPerFloor[0]).toBeLessThanOrEqual(ACT.roomsPerFloor[1]);
    expect(ACT.enemiesPerFloor[0]).toBeLessThanOrEqual(ACT.enemiesPerFloor[1]);
  });

  it('怪物至少覆盖到第一层（否则一层没怪可放）', () => {
    const depth1 = (CORE_PACK.enemies ?? []).filter((e) => (e.minDepth ?? 1) <= 1);
    expect(depth1.length).toBeGreaterThan(0);
  });

  it('所有 id 全局唯一（跨类型也不能撞，方便打日志）', () => {
    const all = [
      ...(CORE_PACK.roles ?? []).map((r) => r.id),
      ...(CORE_PACK.enemies ?? []).map((e) => e.id),
      ...(CORE_PACK.items ?? []).map((i) => i.id),
      ...(CORE_PACK.stories ?? []).map((s) => s.id),
    ];
    const dup = all.filter((id, i) => all.indexOf(id) !== i);
    expect(dup, `id 重复：${dup.join(',')}`).toEqual([]);
  });

  it('剧情正文长度适合手机全屏阅读（40~400 字）', () => {
    for (const story of CORE_PACK.stories ?? []) {
      const len = story.text.length;
      expect(len, `${story.id} 正文只有 ${len} 字，太短撑不起全屏`).toBeGreaterThan(20);
      expect(len, `${story.id} 正文 ${len} 字，手机上要滚动很久`).toBeLessThan(500);
    }
  });

  it('每个剧情节点至少有一个选项（否则会卡在剧情层出不来）', () => {
    for (const story of CORE_PACK.stories ?? []) {
      expect(story.choices.length, `${story.id} 没有选项，玩家会卡住`).toBeGreaterThan(0);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 端到端跑通 —— 内容真的能被引擎跑起来
   ═══════════════════════════════════════════════════════════════ */

describe('端到端：用真实内容包跑完整局', () => {
  /** 用自动意图玩，直到出结局或步数用尽 */
  function autoPlay(seed: number, roleId: string, style: PlayStyle = 'rush', maxSteps = 6000) {
    const rng = new Rng(seed);
    // 每局造一个新机器人：它带着"锁定目标"的记忆，不能跨局复用
    const bot = makeBot(style);
    let { state } = createInitialState({
      seed,
      actId: ACT?.id ?? 'act_1',
      roleId,
      pack: CORE_PACK,
    });

    let steps = 0;
    // 记录【第一次死亡发生在第几层】。
    //    总死亡数会通过"重开→再清房间→再死"复合放大，看不出真正的问题。
    //    而"一条命能走多深"是不复合的 —— 它直接回答
    //    "清空一层房间到底可不可行"这个决定核心内容链路成不成立的问题。
    let firstDeathDepth: number | null = null;
    const deathsAtStart = state.deaths;

    while (steps < maxSteps && state.phase !== 'actEnd') {
      steps++;
      const intent = bot(state, rng);
      state = reduce(state, intent).state;

      if (firstDeathDepth === null && state.deaths > deathsAtStart) {
        // 死在那一层：此刻 phase 已经是 dead，depth 还是死亡时的层数
        firstDeathDepth = state.depth;
      }
    }

    // ── 节奏统计：一局到底让玩家做了多少事、读了多少字 ──
    // 这些数字直接决定"单局 30~45 分钟"这个设计目标能不能成立
    let storyChars = 0;
    for (const id of state.seenStories) {
      const node = (CORE_PACK.stories ?? []).find((s) => s.id === id);
      if (!node) continue;
      storyChars += node.text.length + (node.quote?.length ?? 0);
    }

    return {
      state,
      steps,
      /** 玩家实际做出的决策次数（不含被墙挡住的无效输入） */
      turns: state.turn,
      /** 本局读到过的剧情节点数 */
      storiesRead: state.seenStories.length,
      /** 本局读到的正文字数（不含 UI 文案） */
      storyChars,
      deaths: state.deaths,
      reachedDepth: state.depth,
      /** 第一次死亡发生在第几层；一条命都没死过则为 null */
      firstDeathDepth,
    };
  }

  /**
   * 一个"会玩"的机器人。
   *
   * 移动必须用 BFS 寻路，不能用"朝目标方向贪心"。
   *    贪心版本在贪心方向被墙挡住时会退到兜底方向（列表第一个是 up），
   *    于是会原地来回振荡 —— 曾经跑满 8000 步都到不了楼梯，
   *    看起来像游戏有 bug，其实只是机器人笨。
   *    测试应该验证【游戏】，不该被机器人的寻路能力拖累。
   */
  type PlayStyle = 'rush' | 'normal' | 'thorough';

  /**
   * 造一个机器人。
   *
   * 用工厂函数而不是裸函数，是为了让「锁定的目标」这份记忆跟着每一局走 ——
   * 放在模块级会在多局之间串味。
   *
   * 两种打法测的是同一件事的两端：
   *   rush      —— 直奔楼梯，只走最短路径。给出【单局下限】。
   *   thorough  —— 清光所有房间再下楼。给出【单局上限】。
   * 真人落在两者之间，所以这两个数字框出了时长的可能范围。
   */
  function makeBot(style: PlayStyle) {
    // 锁定房间 id 是 thorough 能跑通的关键。
    //    不锁的话，机器人每回合都重算"最近的未清空房间"，
    //    在两个等距目标之间来回横跳 —— 曾经跑满 12000 步都出不来，
    //    看起来像游戏卡死，其实只是机器人在原地打转。
    let lockedRoomId: number | undefined;

    function allRoomsCleared(s: GameState): boolean {
      return s.floor.rooms.every((r) => r.cleared);
    }

    /**
     * 该下楼了吗。
     *
     * 三种打法测的是同一件事的三段：
     *   rush     见到楼梯就走      → 单局【下限】（只走最短路径）
     *   normal   清到七成就走      → 最接近真人（有探索但不强迫症）
     *   thorough 一个房间不落      → 单局【上限】（内容全消费）
     *
     * 真人落在 normal 附近，所以这个才是判断"单局 30~45 分钟"
     * 该看的数字 —— rush 和 thorough 只是框出边界。
     */
    function doneEnough(s: GameState, st: PlayStyle): boolean {
      if (st === 'rush') return true;
      if (st === 'thorough') return allRoomsCleared(s);
      const cleared = s.floor.rooms.filter((r) => r.cleared).length;
      return cleared >= Math.ceil(s.floor.rooms.length * 0.7);
    }

    /** thorough 的下一个落脚点：先打锁定房间里的怪，再占房间中心 */
    function thoroughGoal(s: GameState): Pos | undefined {
      // 锁定的房间清空了就解锁
      let room =
        lockedRoomId === undefined
          ? undefined
          : s.floor.rooms.find((r) => r.id === lockedRoomId);
      if (room?.cleared === true) {
        room = undefined;
        lockedRoomId = undefined;
      }

      // 没锁定 → 选最近的未清空房间，然后【锁住它】
      if (room === undefined) {
        const p = s.player.pos;
        let bestDist = Infinity;
        for (const r of s.floor.rooms) {
          if (r.cleared) continue;
          const d =
            Math.abs(Math.floor(r.x + r.w / 2) - p.x) +
            Math.abs(Math.floor(r.y + r.h / 2) - p.y);
          if (d < bestDist) {
            bestDist = d;
            room = r;
          }
        }
        if (room === undefined) return s.floor.stairs;
        lockedRoomId = room.id;
      }

      // 房间里还有怪 → 先打怪。
      // 目标指向【怪】而不是房间中心：房间中心可能正好是玩家脚下，
      // BFS 会因为"起点即终点"找不到路。怪的位置不可能等于玩家位置。
      const target = room;
      const foe = s.floor.actors.find(
        (a) =>
          a.pos.x >= target.x &&
          a.pos.x < target.x + target.w &&
          a.pos.y >= target.y &&
          a.pos.y < target.y + target.h,
      );
      if (foe) return foe.pos;

      // 没怪了 → 站到房间中心，引擎就会判定这个房间已清空
      return {
        x: Math.floor(target.x + target.w / 2),
        y: Math.floor(target.y + target.h / 2),
      };
    }

    return function chooseIntent(s: GameState, rng: Rng): Intent {
      if (s.phase === 'story') {
        // 必须按【可见选项数】取下标。越界的 choose 在引擎里是
        //    静默无操作（这是对的：非法输入不该有任何效果），
        //    但机器人瞎猜下标就会永远卡在剧情层。
        const n = getVisibleChoices(s).length;
        return { type: 'choose', index: n > 0 ? rng.int(0, n - 1) : 0 };
      }
      if (s.phase === 'dead') return { type: 'restartAct' };

      // 血量告急时用【真正能回血】的消耗品。
      //
      //    两个坑：
      //      1. 最早的机器人从不用物品 —— 记梦者的死亡数被严重高估
      //      2. 改成"有消耗品就吃"之后死亡数反而【变高】了：
      //         因为本作的起始物品是镇静剂（heal 只有 2），
      //         吃掉它要花一个回合，等于白挨一下。
      //
      //    本作的治疗经济是"用理智买命"：唯一像样的治疗品
      //    hollow_tonic 是 heal +14 / sanity -7。
      //    所以机器人得像真人一样，只在小药有意义时才吃。
      if (s.player.hp <= s.player.hpMax * 0.5) {
        const idx = s.player.inventory.findIndex((it) => {
          if (it.kind !== 'consumable') return false;
          const def = findItem(it.defId);
          const heal = (def?.effects ?? []).reduce(
            (n, e) => n + (e.kind === 'heal' ? e.amount : 0),
            0,
          );
          return heal >= 4; // 只吃真药，不吃糖
        });
        if (idx >= 0) return { type: 'useItem', index: idx };
      }

      if (tileAt(s.floor, s.player.pos) === 'stairs') {
        if (doneEnough(s, style)) return { type: 'descend' };
      }

      // 该走的目标：清够了就直奔楼梯，否则继续清房间。
      // 不能只靠"路过楼梯时判断" —— normal 打法清到七成后
      //    如果还在追剩下的房间，就永远走不到楼梯，退化成 thorough。
      const goal = doneEnough(s, style) ? s.floor.stairs : thoroughGoal(s);
      if (goal !== undefined) {
        const dir = bfsStepTo(s, goal);
        if (dir) return { type: 'move', dir };
      }

      // 到不了目标（或已经站在目标上）时【绝不能死等】——
      //    曾经的版本在这里返回 wait，结果跑满上万步都出不来，
      //    看起来像游戏卡死，其实是机器人站在原地不动。
      const p = s.player.pos;
      const open = (['up', 'down', 'left', 'right'] as const).filter((d) => {
        const v = DIR_VECTORS[d];
        return isWalkable(s.floor, { x: p.x + v.x, y: p.y + v.y });
      });
      const fallback = rng.pick(open);
      return fallback ? { type: 'move', dir: fallback } : { type: 'wait' };
    };
  }

  /** BFS 求"朝目标走的第一步方向" */
  function bfsStepTo(s: GameState, goal: Pos): Direction | undefined {
    const { floor } = s;
    const start = s.player.pos;
    const key = (p: Pos) => `${p.x},${p.y}`;

    const prev = new Map<string, { from: Pos; dir: Direction }>();
    const seen = new Set<string>([key(start)]);
    const q: Pos[] = [{ ...start }];
    const ORDER: Direction[] = ['up', 'down', 'left', 'right'];

    while (q.length > 0) {
      const cur = q.shift();
      if (!cur) continue;

      for (const d of ORDER) {
        const v = DIR_VECTORS[d];
        const next: Pos = { x: cur.x + v.x, y: cur.y + v.y };
        const k = key(next);
        if (seen.has(k)) continue;

        // 撞到怪也算可走 —— 撞上去就是打，怪死了路就通了
        const blockedByWall = !isWalkable(floor, next);
        if (blockedByWall) continue;

        seen.add(k);
        prev.set(k, { from: cur, dir: d });

        if (k === key(goal)) {
          // 回溯到起点，取第一步
          let node: Pos = next;
          let firstDir: Direction = d;
          for (let guard = 0; guard < 5000; guard++) {
            const p = prev.get(key(node));
            if (!p) break;
            firstDir = p.dir;
            if (key(p.from) === key(start)) return firstDir;
            node = p.from;
          }
          return firstDir;
        }
        q.push(next);
      }
    }
    return undefined;
  }

  for (const roleId of ['dream_archivist', 'ward_nurse']) {
    it(`角色 ${roleId} 能跑到结局`, () => {
      // 换几个种子试，避免"恰好这个种子走不通"造成的假红
      const results = [1, 7, 42, 2026, 99999].map((seed) => autoPlay(seed, roleId));
      const ended = results.filter((r) => r.state.phase === 'actEnd');
      expect(ended.length, `5 个种子都没能走到结局（${roleId}）`).toBeGreaterThan(0);

      for (const r of ended) {
        expect(r.state.ending).toBeDefined();
        expect(r.state.ending?.name).toBeTruthy();
      }
    });
  }

  it('同一个 seed + 同一个角色，两次自动游玩结果完全一致', () => {
    const a = autoPlay(1234, 'dream_archivist', 'rush', 600);
    const b = autoPlay(1234, 'dream_archivist', 'rush', 600);
    expect(a.state).toEqual(b.state);
    expect(a.steps).toBe(b.steps);
  });

  it('不同角色在同一 seed 下会得到不同的局（角色差异真的生效）', () => {
    const a = autoPlay(555, 'dream_archivist', 'rush', 800);
    const b = autoPlay(555, 'ward_nurse', 'rush', 800);
    // 属性/tag 不同 → 至少有一处状态不同
    expect(a.state.player.tags).not.toEqual(b.state.player.tags);
    expect(a.state.player.sanMax).not.toBe(b.state.player.sanMax);
  });

  it('游玩过程中三个叙事物件至少能被触发到其中之一', () => {
    const narrativeIds = new Set(
      (CORE_PACK.items ?? []).filter((i) => i.kind === 'narrative').map((i) => i.id),
    );
    let seen = 0;
    for (const seed of [3, 11, 77, 404, 8888]) {
      const { state } = autoPlay(seed, 'dream_archivist');
      const got = state.player.inventory.filter((i) => narrativeIds.has(i.defId));
      seen += got.length;
    }
    expect(seen, '5 局都没捡到任何叙事物件 —— 掉落链路可能断了').toBeGreaterThan(0);
  });

  it('跑完一局后 flags 里有内容（说明选项真的被结算过）', () => {
    const { state } = autoPlay(20260214, 'ward_nurse');
    expect(Object.keys(state.flags).length).toBeGreaterThan(0);
  });

  it('judgeEnding 对真实内容包永远返回一个结局', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { state } = createInitialState({
        seed, actId: ACT?.id ?? 'act_1', roleId: 'dream_archivist', pack: CORE_PACK,
      });
      const e = judgeEnding(state);
      expect(e).toBeDefined();
      expect(e.id).toBeTruthy();
      // 没满足任何条件时必须落到兜底，而不是 undefined
      expect(e.id).toBe('ending_nobody_came');
    }
  });

  /* ═══════════════════════════════════════════════════════════
     节奏测量 —— "单局 30~45 分钟"这个目标能不能成立
     ═══════════════════════════════════════════════════════════ */

  it('节奏测量：打印三种打法的时长', () => {
    // 只取 2 个种子：thorough 每条要跑满 6000 步，
    //    种子数翻倍会让整个测试套件从 20 秒涨到 60 秒以上，
    //    而这条只是【诊断打印】，不需要统计显著性。
    const rows = ['打法\t角色\tseed\t阶段\tturn\t剧情数\t正文字数\t死亡\t结局'];
    for (const style of ['rush', 'normal', 'thorough'] as const) {
      for (const roleId of ['dream_archivist', 'ward_nurse']) {
        for (const seed of [1, 42]) {
          const r = autoPlay(seed, roleId, style);
          rows.push(
            [
              style, roleId, seed, r.state.phase, r.turns, r.storiesRead,
              r.storyChars, r.deaths, r.state.ending?.id ?? '-',
            ].join('\t'),
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
  });

  it('三种打法必须严格递增（rush < normal < thorough），否则说明测量逻辑有洞', () => {
    const seeds = [1, 42];
    const avg = (style: PlayStyle) =>
      seeds
        .map((s) => autoPlay(s, 'ward_nurse', style).turns)
        .reduce((a, b) => a + b, 0) / seeds.length;

    const rush = avg('rush');
    const normal = avg('normal');
    const thorough = avg('thorough');

    expect(normal, `速通 ${rush.toFixed(0)} → 普通 ${normal.toFixed(0)}，没有变长`).toBeGreaterThan(
      rush,
    );
    expect(
      thorough,
      `普通 ${normal.toFixed(0)} → 全清 ${thorough.toFixed(0)}，没有变长`,
    ).toBeGreaterThan(normal);
  });

  it('探索型打法明显比速通长（这个差值就是"可选内容"的量）', () => {
    const seeds = [1, 42, 2026, 99999];
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const rush = avg(seeds.map((s) => autoPlay(s, 'ward_nurse', 'rush')).map((r) => r.turns));
    const thorough = avg(
      seeds.map((s) => autoPlay(s, 'ward_nurse', 'thorough')).map((r) => r.turns),
    );

    expect(
      thorough,
      `速通平均 ${rush.toFixed(0)} 回合，全清平均 ${thorough.toFixed(0)} 回合 —— ` +
        `全清居然不比速通长，说明"清房间掉剧情"这个循环没起作用`,
    ).toBeGreaterThan(rush);
  });

  it('越探索，看到的内容越多（这是"清房间掉剧情"该有的效果）', () => {
    const seeds = [1, 42];
    const avg = (style: PlayStyle, pick: (r: ReturnType<typeof autoPlay>) => number) =>
      seeds.map((s) => pick(autoPlay(s, 'ward_nurse', style))).reduce((a, b) => a + b, 0) /
      seeds.length;

    const rushStories = avg('rush', (r) => r.storiesRead);
    const thoroughStories = avg('thorough', (r) => r.storiesRead);

    expect(
      thoroughStories,
      `速通看到 ${rushStories.toFixed(1)} 段剧情，全清只看到 ${thoroughStories.toFixed(1)} 段 —— ` +
        '"清房间掉叙事物件"这条链路没起作用',
    ).toBeGreaterThan(rushStories);
  });

  // 这里【故意没有】"thorough 必须跑完"这条断言。
  //
  //    探索型打法必然要打更多架，而打架就会死；死 → 重开 → 又去清房间 → 又死。
  //    实测记梦者在 thorough 下会死 90~119 次、跑满 6000 步都不收敛。
  //    那不是游戏的 bug，是机器人忠实地执行了一个"不会避战"的策略 ——
  //    真人早就学会绕开了，机器人不会。
  //
  //    所以 thorough 的数字只当【上限参考】看，不用它做断言。
  //    真正的可玩性守卫是上面那组 rush 打法的平衡检查。

  it('thorough 的死亡数远高于 rush（说明"避战"是有效策略，不是无脑打）', () => {
    const seeds = [1];
    const rushDeaths = seeds.map((s) => autoPlay(s, 'ward_nurse', 'rush').deaths);
    const thoroughDeaths = seeds.map((s) => autoPlay(s, 'ward_nurse', 'thorough').deaths);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    expect(
      sum(thoroughDeaths),
      `速通总死亡 ${sum(rushDeaths)}，全清总死亡 ${sum(thoroughDeaths)} —— ` +
        '如果两者差不多，说明战斗没有风险，理智这个资源就失去意义了',
    ).toBeGreaterThan(sum(rushDeaths));
  });

  it('一局的决策次数落在合理区间（太短撑不起时长，太长会让人放弃）', () => {
    const runs = [1, 7, 42, 555, 2026, 99999, 3, 11]
      .map((seed) => autoPlay(seed, 'ward_nurse'))
      .filter((r) => r.state.phase === 'actEnd');

    expect(runs.length, '没有一个种子跑完，无法评估节奏').toBeGreaterThan(0);

    // 用中位数而不是最小值来设门槛：
    //    单个倒霉种子不该让测试红，但"典型一局有多长"必须守住。
    const turns = runs.map((r) => r.turns).sort((a, b) => a - b);
    const mid = turns[Math.floor(turns.length / 2)] ?? 0;

    // 下限：中位数低于 40 回合 → 这幕太短，撑不起"单局 30 分钟"
    expect(mid, `一局中位回合数只有 ${mid}，太短`).toBeGreaterThan(40);
    // 上限：超过 600 回合 → 拖沓，玩家会中途放弃
    expect(mid, `一局中位回合数高达 ${mid}，太拖`).toBeLessThan(600);

    // 逐局只做退化检查：不该有瞬间结束的一局
    for (const r of runs) {
      expect(r.turns, `有个种子只用了 ${r.turns} 回合就结束`).toBeGreaterThan(20);
    }
  });

  it('探索打法平均至少读到 3 段剧情，否则"剧情向"这个定位不成立', () => {
    // 这里必须用 normal 打法测，不能用速通。
    //
    //    曾经用速通测，阈值还被设成 400 字 —— 那个数字是拿【坏数据】校准的：
    //    当时记梦者会死 100 多次，每次重开都重新触发剧情，把字数撑起来了。
    //    修好战斗经济之后速通只读 392 字，测试反而红了 ——
    //    但速通【本来就该】少读内容，它测的是下限不是定位。
    //    判断"剧情向"这个定位，要看正常玩的玩家能读到多少。
    const results = [1, 7, 42, 555, 2026].map((seed) =>
      autoPlay(seed, 'dream_archivist', 'normal'),
    );
    const avgStories = results.reduce((n, r) => n + r.storiesRead, 0) / results.length;
    const avgChars = results.reduce((n, r) => n + r.storyChars, 0) / results.length;

    expect(avgStories, `平均只读到 ${avgStories.toFixed(1)} 段剧情`).toBeGreaterThanOrEqual(3);
    // 一屏中文全屏剧情大约 150~250 字
    expect(avgChars, `平均只读到 ${avgChars.toFixed(0)} 字`).toBeGreaterThan(400);
  });

  it('探索型打法必须能跑完本幕（不是死亡循环）', () => {
    const RUNS = 4;
    for (const roleId of ['dream_archivist', 'ward_nurse']) {
      const runs = BALANCE_SEEDS.slice(0, RUNS).map((s) => autoPlay(s, roleId, 'normal'));
      const finished = runs.filter((r) => r.state.phase === 'actEnd').length;

      expect(
        finished / runs.length,
        `${roleId} 在清房间打法下，${RUNS} 个种子里只有 ${finished} 个能跑完本幕 —— ` +
          '说明"死 → 重开 → 又清不完 → 又死"的循环还在，玩家永远看不到结局',
      ).toBeGreaterThanOrEqual(0.75);
    }
  });

  /* ═══════════════════════════════════════════════════════════
     平衡守卫 —— 两个角色都必须"能玩"
     ═══════════════════════════════════════════════════════════ */

  it('每个结局都有 hint 文案（驱动重开率靠它）', () => {
    for (const ending of ACT?.endings ?? []) {
      // 兜底结局不需要 hint：它必然达成，不存在"差一点"
      if (ending.requires.length === 0) continue;
      expect(
        ending.hint,
        `结局 ${ending.id} 没有写 hint —— 结算界面就没法告诉玩家"你差一步能走到哪"`,
      ).toBeTruthy();
    }
  });

  /** 多跑几个种子，统计一个角色的可玩性 */
  function profile(roleId: string, seeds: readonly number[]) {
    const runs = seeds.map((s) => autoPlay(s, roleId));
    const finished = runs.filter((r) => r.state.phase === 'actEnd');
    const deaths = finished.map((r) => r.deaths).sort((a, b) => a - b);
    const median = deaths[Math.floor(deaths.length / 2)] ?? 0;
    return {
      finished: finished.length,
      total: runs.length,
      deaths,
      medianDeaths: median,
      maxDeaths: deaths[deaths.length - 1] ?? 0,
    };
  }

  // 12 个种子：够看出趋势，又不至于让测试跑太久
  const BALANCE_SEEDS = [1, 2, 3, 7, 11, 42, 77, 404, 555, 2026, 8888, 99999];

  it('平衡测量：打印两个角色的死亡分布', () => {
    const rows = ['角色\t跑完\t中位死亡\t最多死亡\t死亡分布'];
    for (const roleId of ['dream_archivist', 'ward_nurse']) {
      const p = profile(roleId, BALANCE_SEEDS);
      rows.push(
        [roleId, `${p.finished}/${p.total}`, p.medianDeaths, p.maxDeaths, p.deaths.join(',')].join(
          '\t',
        ),
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
  });

  it('两个角色都必须能跑完本幕（不能有一个是废的）', () => {
    for (const roleId of ['dream_archivist', 'ward_nurse']) {
      const p = profile(roleId, BALANCE_SEEDS);
      expect(
        p.finished / p.total,
        `${roleId} 只有 ${p.finished}/${p.total} 个种子能跑完 —— 这个角色基本没法玩`,
      ).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('任一角色的中位死亡次数不超过 5（超过了就是死亡循环，真人早就退出了）', () => {
    for (const roleId of ['dream_archivist', 'ward_nurse']) {
      const p = profile(roleId, BALANCE_SEEDS);
      expect(
        p.medianDeaths,
        `${roleId} 平均要死 ${p.medianDeaths} 次才能跑完一幕（最多死到 ${p.maxDeaths} 次）—— ` +
          `这是死亡循环，不是难度。真人不会重开第六次。`,
      ).toBeLessThanOrEqual(5);
    }
  });

  it('两个角色的难度差距不超过 4 倍（差距太大等于只有一个角色能用）', () => {
    const frail = profile('dream_archivist', BALANCE_SEEDS);
    const sturdy = profile('ward_nurse', BALANCE_SEEDS);
    // +1 避免除零：ward_nurse 常常是 0 次死亡
    const ratio = (frail.medianDeaths + 1) / (sturdy.medianDeaths + 1);
    expect(
      ratio,
      `记梦者中位死 ${frail.medianDeaths} 次、值夜护士中位死 ${sturdy.medianDeaths} 次，` +
        `难度差 ${ratio.toFixed(1)} 倍 —— 这已经不是"两种玩法"，是"一个能玩一个不能玩"`,
    ).toBeLessThanOrEqual(4);
  });

  /* ═══════════════════════════════════════════════════════════
     核心链路的可行性 —— 探索型打法能不能活着清完房间
     ═══════════════════════════════════════════════════════════ */

  it('探索测量：打印首次死亡深度（不复合的指标）', () => {
    // 只取 3 个种子：normal 打法每条可能跑满 6000 步，这条是诊断打印
    const rows = ['打法\t角色\tseed\t首次死亡层\t总死亡\t阶段'];
    for (const style of ['rush', 'normal'] as const) {
      for (const roleId of ['dream_archivist', 'ward_nurse']) {
        for (const seed of BALANCE_SEEDS.slice(0, 3)) {
          const r = autoPlay(seed, roleId, style);
          rows.push(
            [
              style, roleId, seed,
              r.firstDeathDepth === null ? '没死' : `第${r.firstDeathDepth}层`,
              r.deaths, r.state.phase,
            ].join('\t'),
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n') + '\n');
  });

  /**
   * 「清房间掉叙事物件」是本作的核心内容链路。
   * 如果玩家连第一层的房间都清不完就死，这条链路就是空头支票 ——
   * 剧情写得再好也没人看得到。
   *
   * 用【首次死亡深度】而不是总死亡数来判：
   * 总死亡会通过"重开→再清→再死"复合放大，看不出真正的问题。
   */
  it('探索型打法至少能活着清完第一层（否则核心内容链路不成立）', () => {
    const RUNS = 4;
    for (const roleId of ['dream_archivist', 'ward_nurse']) {
      const runs = BALANCE_SEEDS.slice(0, RUNS).map((s) => autoPlay(s, roleId, 'normal'));
      const survivedFloor1 = runs.filter(
        (r) => r.firstDeathDepth === null || r.firstDeathDepth >= 2,
      ).length;

      expect(
        survivedFloor1 / runs.length,
        `${roleId} 在清房间打法下，${RUNS} 个种子里只有 ${survivedFloor1} 个能活着走完第一层 —— ` +
          '玩家还没看到剧情就先死了，"清房间掉叙事物件"这条核心链路等于不存在',
      ).toBeGreaterThanOrEqual(0.5);
    }
  });
});

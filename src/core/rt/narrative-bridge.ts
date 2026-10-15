/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/narrative-bridge.ts —— 让叙事层看得懂实时层的 state
 * ════════════════════════════════════════════════════════════════
 *
 *  叙事层（conditions / effects / endings / narrative）操作的是
 *  GameState，而实时层是 RtState。两边字段不一样：
 *
 *      GameState   state.player.san          —— 嵌套的 player 对象
 *      RtState     state.san                 —— 直接挂在 state 上
 *
 *  【做法：活视图】—— 造一个对象，用 getter / setter 把读写
 *  直接映射回 RtState。于是：
 *
 *      · 叙事层一行都不用改
 *      · 读到的永远是当前值，不是快照
 *      · 叙事层写进去的东西（扣理智、加 flag）真的落在 RtState 上
 *
 *  【为什么不用"拷贝出去、跑完再拷回来"】
 *  那样每次调用都要同步十几个字段，漏一个就是"效果生效了但没保存"——
 *  而且不会报错，只在几个小时后表现为"某个结局永远走不到"。
 *  活视图没有这个窗口期。
 *
 *  【代价】需要一次 `as unknown as GameState` 强转，因为实时层没有
 *  floor / turn 这些回合制专有的东西。这些字段填的是无害的桩：
 *  叙事层不读它们（读的那些函数本来就不该在实时层调用）。
 * ════════════════════════════════════════════════════════════════
 */

import type { Flags, GameState, ItemInstance, Phase } from '../types.js';
import type { RtState } from './types.js';

/** 实时层的三态 → 回合制的 Phase */
function toPhase(p: RtState['phase']): Phase {
  return p;
}

function fromPhase(p: Phase): RtState['phase'] {
  // 'actEnd' 在实时层没有对应物，归到 'dead'（都是"这一局结束了"）
  return p === 'playing' || p === 'story' ? p : 'dead';
}

/**
 * 造一个活的 GameState 视图。
 *
 * 【每次调用都造一个新的】—— 视图本身几乎不占内存（一堆 getter），
 * 缓存它反而会让"玩家实体换了"这类情况出错。
 */
export function narrativeView(rt: RtState): GameState {
  const pe = rt.entities.find((e) => e.kind === 'player');

  const player = {
    get roleId(): string {
      return rt.roleId;
    },
    get name(): string {
      return rt.roleId;
    },
    // 实时层没有格子坐标。叙事层不读它，给个零
    get pos(): { x: number; y: number } {
      return { x: 0, y: 0 };
    },
    get hp(): number {
      return pe?.hp ?? 0;
    },
    set hp(v: number) {
      if (pe !== undefined) pe.hp = v;
    },
    get hpMax(): number {
      return pe?.hpMax ?? 0;
    },
    set hpMax(v: number) {
      if (pe !== undefined) pe.hpMax = v;
    },
    get san(): number {
      return rt.san;
    },
    set san(v: number) {
      rt.san = v;
    },
    get sanMax(): number {
      return rt.sanMax;
    },
    set sanMax(v: number) {
      rt.sanMax = v;
    },
    get atk(): number {
      return rt.atk;
    },
    set atk(v: number) {
      rt.atk = v;
    },
    get def(): number {
      return rt.def;
    },
    set def(v: number) {
      rt.def = v;
    },
    get tags(): readonly string[] {
      return rt.roleTags;
    },
    get inventory(): ItemInstance[] {
      return rt.inventory;
    },
    get relics(): string[] {
      return [];
    },
  };

  const view = {
    get seed(): number {
      return rt.rngState;
    },
    get rngState(): number {
      return rt.rngState;
    },
    set rngState(v: number) {
      rt.rngState = v;
    },
    get phase(): Phase {
      return toPhase(rt.phase);
    },
    set phase(v: Phase) {
      rt.phase = fromPhase(v);
    },
    get actId(): string {
      return rt.actId;
    },
    get act(): number {
      return 1;
    },
    get depth(): number {
      return rt.depth;
    },
    set depth(v: number) {
      rt.depth = v;
    },
    get turn(): number {
      return rt.tick;
    },
    get player() {
      return player;
    },
    // 实时层没有"楼层"这个东西（一屏一房间）。给个空壳，
    // 免得叙事层里某个不走运的分支读到 undefined 就炸
    get floor() {
      return {
        depth: rt.depth,
        width: rt.map.w,
        height: rt.map.h,
        tiles: [],
        actors: [],
        items: [],
        rooms: [],
        slots: [],
        entry: { x: 0, y: 0 },
        stairs: { x: 0, y: 0 },
      };
    },
    get flags(): Flags {
      return rt.flags;
    },
    set flags(v: Flags) {
      rt.flags = v;
    },
    get deaths(): number {
      return rt.deaths;
    },
    set deaths(v: number) {
      rt.deaths = v;
    },
    get nextUid(): number {
      return rt.nextUid;
    },
    set nextUid(v: number) {
      rt.nextUid = v;
    },
    get pendingStory(): string | undefined {
      return rt.pendingStory;
    },
    set pendingStory(v: string | undefined) {
      rt.pendingStory = v;
    },
    get seenStories(): string[] {
      return rt.seenStories;
    },
    get takenChoices(): string[] {
      return rt.takenChoices;
    },
    get ending() {
      return rt.ending;
    },
    set ending(v) {
      rt.ending = v;
    },
    get logLine() {
      return rt.logLine;
    },
  };

  return view as unknown as GameState;
}

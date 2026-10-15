/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/log.ts —— 屏幕日志
 * ════════════════════════════════════════════════════════════════
 *
 *  【为什么要单独一个文件】—— 这是从回合制那边继承过来的东西，
 *  但实时版【差一点就把它丢了】：
 *
 *  回合制那边战斗文字是 engine.ts 的 doMove 里 pushLog 写的。
 *  实时版的事件（attack / hurt）只做视觉反馈 —— 闪白、震屏、飘数字，
 *  【一个字都不写】。所以玩家打了一架，屏幕上什么都没说。
 *
 *  文字在动作游戏里比数字重要：飘个 "-3" 只是反馈，
 *  "你击中了爬行物。" 才是【叙事】。这个游戏是叙事向的。
 *
 *  文案语气照抄回合制那版（"散开了，像被水冲掉的墨"这类），
 *  两个版本读起来得是同一个人写的。
 * ════════════════════════════════════════════════════════════════
 */

import type { MessageTone } from '../types.js';
import type { RtState } from './types.js';

/** 日志保留多少条。和回合制那边一致 */
const LOG_LIMIT = 60;

/**
 * 往屏幕日志里写一行。
 *
 * 【滑动窗口】超过上限从最老的裁掉。日志是给人看最近发生了什么的，
 * 不是存档 —— 无限增长的话内存和 DOM 都会慢慢涨上去。
 */
export function pushLog(state: RtState, text: string, tone: MessageTone = 'info'): void {
  state.logLine.push({ text, tone });
  if (state.logLine.length > LOG_LIMIT) {
    state.logLine.splice(0, state.logLine.length - LOG_LIMIT);
  }
}

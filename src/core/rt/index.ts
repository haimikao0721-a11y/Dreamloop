/**
 * ════════════════════════════════════════════════════════════════
 *  core/rt/index.ts —— 实时层的对外出口
 * ════════════════════════════════════════════════════════════════
 *
 *  UI 只从这里拿实时层的东西。rt/ 内部的文件之间互相知道，
 *  外面不需要知道谁在哪。
 * ════════════════════════════════════════════════════════════════
 */

export * from './types.js';
export * from './input.js';
export * from './physics.js';
export * from './entities.js';
export * from './rng.js';
export * from './light.js';
export * from './sanity.js';
export * from './action.js';
export * from './ai.js';
export * from './loop.js';

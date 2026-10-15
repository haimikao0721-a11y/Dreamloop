/**
 * ════════════════════════════════════════════════════════════════
 *  ui-web/main.ts —— 入口 / 唯一的调度中心
 * ════════════════════════════════════════════════════════════════
 *
 *  这里是整个 UI 层唯一持有 GameState 的地方，也是唯一能改它的地方：
 *
 *      dispatch(intent) → reduce(state, intent) → 把新 state 和 events 交给渲染层
 *
 *  两条铁律：
 *
 *   1. 【所有】状态变化都必须走 dispatch。渲染层想改状态只能发 Intent
 *      （render.ts 里没有任何一处直接写 state 字段）。所以"这个改动是谁做的"
 *      永远能在 core 的 reduce 里找到答案，UI 不会偷偷改规则。
 *
 *   2. UI 不算规则。伤害、掉落、结局、合法性全部来自 core：
 *      - 显示什么 → state（core 的权威快照）
 *      - 发生了什么 → events（core 的权威叙述）
 *      - 能做什么   → legalIntents(state)（core 的权威判定）
 *
 *  集成提示（对接 core 时最容易踩的两点）：
 *
 *    · `@data/index` 里的 CORE_PACK 是内容包入口。如果数据层放在别的路径，
 *      只改下面那一行 import 即可，UI 其它文件都不认识内容包。
 *
 *    · `@core/index` 的四个函数签名必须和约定一致；这里全部按约定调用，
 *      没有做任何适配层的猜测。
 * ════════════════════════════════════════════════════════════════
 */

import './styles.css';

import { createInitialState, getVisibleChoices, legalIntents, reduce } from '@core/index';
import type {
  ContentPack,
  GameEvent,
  GameState,
  InitOptions,
  Intent,
  ReduceResult,
} from '@core/types';
// 内容包入口：全项目只有这一行认识数据层的路径
import { CORE_PACK, CREDITS } from '@data/index';

import { createInput, formatProbe, isInputMode, probeEnvironment } from './input';
import type { InputNotice } from './input';
import { UI_TEXT, createUi } from './render';
import type { MenuEntry } from './render';

/* ─────────────────────────── 常量 ─────────────────────────── */

const pack: ContentPack = CORE_PACK;
const actId = (pack.acts ?? [])[0]?.id ?? '';

/**
 * core 抛异常时的兜底合法集。
 * 宁可短暂放开让玩家还能操作，也不要因为一个异常把 UI 冻成砖头。
 */
const ALL_INTENT_TYPES: readonly Intent['type'][] = [
  'move',
  'wait',
  'interact',
  'cancel',
  'choose',
  'useItem',
  'descend',
  'restartAct',
];

/* ─────────────────────────── 状态 ─────────────────────────── */

let state: GameState | undefined;
let currentLegal: readonly Intent['type'][] = [];
let currentRoleId: string | null = null;

/* ─────────────────────────── 挂载点 ─────────────────────────── */

function resolveMountPoint(): HTMLElement {
  const existing = document.getElementById('app');
  if (existing !== null) return existing;
  // index.html 里没有 #app 时自己造一个，至少别白屏
  const created = document.createElement('div');
  created.id = 'app';
  document.body.appendChild(created);
  return created;
}

/* ─────────────────────────── 渲染层 / 输入层 ─────────────────────────── */

const ui = createUi({
  root: resolveMountPoint(),
  onIntent: (intent) => dispatch(intent),
  onNewRun: () => restartRun(),
  onShareRun: () => shareUrl(),
  onInputModeChange: (mode) => {
    if (isInputMode(mode)) input.setMode(mode);
  },
});

const input = createInput({
  mapEl: ui.els.map,
  dpadEl: ui.els.dpad,
  emit: (intent) => dispatch(intent),
  // 合法性只问 core。UI 不自己判断"现在能不能走"。
  isLegal: (type) => currentLegal.includes(type),
  getPlayerPos: () => state?.player.pos ?? { x: 0, y: 0 },
  onModeChange: (resolved, locked) => ui.setInputMode(resolved, locked),
  onEvent: (label) => ui.setLastInputEvent(label),
  onNotice: (notice) => handleNotice(notice),
});

/* ─────────────────────────── 调度：唯一改变状态的入口 ─────────────────────────── */

function dispatch(intent: Intent): void {
  const current = state;
  if (current === undefined) return;

  let result: ReduceResult;
  try {
    result = reduce(current, intent);
  } catch (error) {
    // reduce 是纯函数：抛异常时旧 state 没被改坏，跳过这一帧继续玩
    console.error('[dreamloop] reduce 抛出异常', intent, error);
    ui.noteDebug(`reduce 异常: ${String(error)}`);
    ui.notify(UI_TEXT.ignored, 'danger');
    return;
  }

  applyState(result.state);
  ui.applyEvents(result.state, result.events);
}

function applyState(next: GameState): void {
  state = next;
  currentLegal = safeLegalIntents(next);
  // 先更新合法性再渲染：死亡/结局层的按钮要不要显示，取决于 core 说 restartAct 合不合法
  ui.setLegalIntents(currentLegal);
}

function safeLegalIntents(current: GameState): readonly Intent['type'][] {
  try {
    return legalIntents(current);
  } catch (error) {
    console.error('[dreamloop] legalIntents 抛出异常', error);
    return ALL_INTENT_TYPES;
  }
}

/* ─────────────────────────── 开局 ─────────────────────────── */

/**
 * URL 参数：?seed=123&role=ward_nurse
 *
 * 种子只在这里生成。局内的随机性完全来自 core 的 state.rngState，
 * UI 不碰 Math.random()（这里用它是为了"新的一局"有不确定性，不属于游戏逻辑）。
 *
 * role 参数是"分享一局"用的：带上角色，对方点开就直接进同一局，
 * 不用先选人。这是开源肉鸽最便宜的一种社区传播 ——
 * "我这个 seed 第一层就出裂镜残片，你试试"。
 */
const urlSeed = readSeedFromUrl();
const urlRole = readRoleFromUrl();

function readSeedFromUrl(): number | null {
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('seed');
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

function readRoleFromUrl(): string | null {
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('role');
  if (raw === null || raw === '') return null;
  // 只接受内容包里真实存在的角色 —— URL 是外部输入，不信任
  const known = (CORE_PACK.roles ?? []).some((r) => r.id === raw);
  return known ? raw : null;
}

function pickSeed(): number {
  if (urlSeed !== null) return urlSeed;
  return (Math.random() * 0x7fffffff) >>> 0;
}

/**
 * 生成"分享这一局"的链接。
 *
 * 指向当前页面的 origin + pathname，只挂 seed 和 role 两个参数 ——
 * 这样不管将来部署到哪个域名、哪个子路径，链接都自动是对的。
 */
function shareUrl(): string {
  if (typeof location === 'undefined') return '';
  const params = new URLSearchParams();
  params.set('seed', String(state?.seed ?? pickSeed()));
  params.set('role', currentRoleId ?? '');
  return `${location.origin}${location.pathname}?${params.toString()}`;
}

function boot(): void {
  if (actId === '') {
    ui.showFatal('内容包里没有 acts：CORE_PACK.acts 至少要有一幕。');
    return;
  }
  const roles = pack.roles ?? [];
  if (roles.length === 0) {
    ui.showFatal('内容包里没有 roles：CORE_PACK.roles 至少要有一个角色。');
    return;
  }

  ui.setProbeRows(formatProbe(probeEnvironment()));
  ui.noteDebug(`内容包 ${pack.id}@${pack.version}（${pack.namespace}）`);

  // ?role=xxx 时【跳过主菜单和选人】，直接进同一局 ——
  // 别人分享"试试我这个 seed"的链接，点开就该立刻开始。
  // 多一层菜单就多一次流失，分享链接的价值就没了。
  if (urlRole !== null) {
    ui.hideMenu();
    ui.hideRoleSelect();
    ui.noteDebug(`URL 指定角色 ${urlRole}，跳过菜单与角色选择`);
    startRun(urlRole);
    return;
  }

  // 输入模式标签由 createInput 的 onModeChange 首帧推送，这里不用再设一遍
  showMainMenu();
}

/* ─────────────────────────── 主菜单 ─────────────────────────── */

/**
 * 主菜单。四个入口。
 *
 * 菜单结构是【数据】，渲染层不认识"主线""活动"这些概念 ——
 * 加一个模式只需要在这里多一项，不用改 UI 代码。
 *
 * 「尚未开放」的两项【不置灰】：置灰等于死路，点了什么都不发生，
 * 玩家只会以为坏了或者没做。改成点开一段解释 —— 至少能知道那是什么、
 * 现在的进度在哪、想参与该去哪。这对一个还没做完的开源项目尤其重要。
 */
function showMainMenu(): void {
  const roles = pack.roles ?? [];

  const entries: MenuEntry[] = [
    {
      id: 'story',
      title: '主线剧情',
      desc: '三点十七分的夜班。三层楼，十段记录，三种死法。',
      onPick: () => {
        ui.hideMenu();
        ui.showRoleSelect(roles, (roleId) => startRun(roleId));
      },
    },
    {
      id: 'event',
      title: '活动模式',
      desc: '限时事件、特殊规则的独立关卡。不加载叙事引擎，节奏更快。',
      badge: UI_TEXT.menuBadgeSoon,
      onPick: () =>
        ui.showNotice(
          '活动模式',
          [
            '和主线分开的独立关卡：清房间、攒 build、打 Boss，可以反复打。',
            '它不加载叙事引擎，所以节奏比主线快得多 —— 适合只想打一会儿的时候。',
            '还没做。想参与设计的话，欢迎到仓库开 issue。',
          ],
          () => showMainMenu(),
        ),
    },
    {
      id: 'community',
      title: '扩展 · 社区模式',
      desc: '加载社区写的内容包 —— 别人写的幕、角色、剧情线。',
      badge: UI_TEXT.menuBadgeSoon,
      onPick: () =>
        ui.showNotice(
          '扩展 · 社区模式',
          [
            '这个模式用来加载社区写的内容包：别人写的幕、角色、剧情线，装进来就能玩。',
            '内容包是纯数据，不用改引擎代码。命名空间、覆盖规则和「世界律」写在 docs/04-社区扩展规范.md。',
            '加载器还没做。但内容的写法已经定下来了（docs/02-数据字典.md），现在就能开始写。',
          ],
          () => showMainMenu(),
        ),
    },
    {
      id: 'credits',
      title: '制作者名单',
      desc: '做过这个梦的人，以及用到的技术。',
      onPick: () => ui.showCredits(CREDITS, () => showMainMenu()),
    },
  ];

  ui.showMainMenu(entries);
}

function startRun(roleId: string): void {
  currentRoleId = roleId;
  const options: InitOptions = { seed: pickSeed(), actId, roleId, pack };

  let created: { state: GameState; events: GameEvent[] };
  try {
    created = createInitialState(options);
  } catch (error) {
    console.error('[dreamloop] createInitialState 抛出异常', error);
    ui.showFatal(`createInitialState 失败：${String(error)}`);
    return;
  }

  ui.hideRoleSelect();
  // 先按 core 的 logLine 重建日志，再放初始事件 —— 顺序反了会把开场白顶掉
  ui.resetLog(created.state);
  applyState(created.state);
  ui.applyEvents(created.state, created.events);
  ui.noteDebug(`开局 seed=${options.seed} role=${roleId} act=${actId}`);
}

function restartRun(): void {
  if (currentRoleId === null) {
    boot();
    return;
  }
  startRun(currentRoleId);
}

/* ─────────────────────────── 杂项接线 ─────────────────────────── */

function handleNotice(notice: InputNotice): void {
  if (notice === 'tooFar') ui.notify(UI_TEXT.tooFar, 'info');
  // 'illegal' 不弹提示：方向区已经压暗了，每次按都弹会刷屏
}

// 视口尺寸会变（横竖屏 / 地址栏收放），探针面板要跟着刷
window.addEventListener('resize', () => {
  ui.setProbeRows(formatProbe(probeEnvironment()));
});

boot();

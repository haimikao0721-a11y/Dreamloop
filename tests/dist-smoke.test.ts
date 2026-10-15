/**
 * ════════════════════════════════════════════════════════════════
 *  构建产物冒烟测试
 * ════════════════════════════════════════════════════════════════
 *
 *  为什么需要这个文件：
 *
 *    单元测试跑的是【源码】，但玩家拿到的是【打包后的 dist/】。
 *    两者之间隔着压缩、tree-shaking、代码分割、路径重写 ——
 *    这些都可能让"测试全绿的代码"发布出去跑不起来。
 *
 *    这个文件直接把 dist/app.js import 进来，在 DOM 环境里
 *    真的把游戏启动一遍。跑的是玩家实际会下载的那份字节。
 *
 *  ⚠️ 前置条件：先构建。
 *
 *      pnpm verify        # 构建 + 跑这个测试（推荐）
 *      pnpm build && npx vitest run tests/dist-smoke.test.ts
 *
 *    没构建过时这个文件会整体 skip，不会假装通过。
 * ════════════════════════════════════════════════════════════════
 */

// @vitest-environment happy-dom

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

// ⚠️ 不能用 import.meta.url 定位 dist：
//    happy-dom 环境下它不是 file:// 协议，fileURLToPath 会抛
//    "The URL must be of scheme file"。
//    vitest 的 cwd 就是项目根，用 cwd 拼更稳。
const DIST = resolve(process.cwd(), 'dist');
const ENTRY = resolve(DIST, 'app.js');
const HTML = resolve(DIST, 'index.html');
/** import() 需要 URL 形式的说明符，Windows 上尤其不能用裸盘符路径 */
const ENTRY_URL = pathToFileURL(ENTRY).href;

const built = existsSync(ENTRY) && existsSync(HTML);

/* ═══════════════════════════════════════════════════════════════
   1. 产物结构
   ═══════════════════════════════════════════════════════════════ */

describe.skipIf(!built)('构建产物结构', () => {
  it('index.html 用的是【相对路径】，能丢进任何子目录', () => {
    const html = readFileSync(HTML, 'utf8');

    // base: './' 的验证。绝对路径 /app.js 会让 GitHub Pages
    // 这种子路径部署直接 404 —— 这是最常见的部署翻车点。
    expect(html, 'index.html 里出现了绝对路径，子目录部署会 404').not.toMatch(
      /(src|href)="\/(?!\/)/,
    );
    // app.js 后面会跟一个内容哈希查询串（见 vite.config.ts 的 cacheBustHtml）——
    // 固定文件名 + max-age=600 会让浏览器缓存旧版本，加了哈希才会失效
    expect(html).toMatch(/src="\.\/app\.js(\?v=[0-9a-f]+)?"/);
    expect(html).toContain('id="app"');
  });

  it('样式被打包出来且被 html 引用', () => {
    const html = readFileSync(HTML, 'utf8');
    expect(html, 'html 里没有引用任何 css').toMatch(/href="\.\/[^"]+\.css(\?v=[0-9a-f]+)?"/);

    const cssMatch = /href="\.\/([^"]+\.css)(?:\?v=[0-9a-f]+)?"/.exec(html);
    const cssFile = cssMatch?.[1];
    expect(cssFile).toBeDefined();
    if (cssFile === undefined) return;

    const css = readFileSync(resolve(DIST, cssFile), 'utf8');
    expect(css.length).toBeGreaterThan(1000);

    // 手机上不处理就没法玩的那几条，必须在产物里
    expect(css, 'CSS 里丢了 touch-action: none —— 手机上滑动会被浏览器抢去滚动').toContain(
      'touch-action:none',
    );
    expect(css, 'CSS 里丢了 100dvh —— 手机地址栏收放时布局会算错').toContain('100dvh');
    expect(css, 'CSS 里丢了安全区适配 —— 刘海屏会遮住界面').toContain('safe-area-inset');
  });

  it('体积没有意外膨胀（超过 200KB 说明误打包了大依赖）', () => {
    const size = statSync(ENTRY).size;
    expect(size).toBeLessThan(200 * 1024);
    // 也不该是空的
    expect(size).toBeGreaterThan(5 * 1024);
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 真的把产物启动一遍
   ═══════════════════════════════════════════════════════════════ */

describe.skipIf(!built)('构建产物能跑起来', () => {
  beforeAll(() => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);
  });

  it('import dist/app.js 不会抛异常，且界面真的挂载了', async () => {
    // 这一行就是全部意义：跑的是玩家下载的那份压缩产物
    await expect(import(/* @vite-ignore */ ENTRY_URL)).resolves.toBeDefined();

    const app = document.getElementById('app');
    expect(app, '#app 不见了').not.toBeNull();
    expect(
      (app?.children.length ?? 0) > 0,
      'dist/app.js 执行完了但 #app 里什么都没有 —— 界面没挂上',
    ).toBe(true);
  });

  it('启动后停在主菜单（四个入口都在）', async () => {
    const text = document.body.textContent ?? '';
    // 主菜单是 boot() 之后的第一屏。这条断言跟着流程走过一次 ——
    // 加主菜单之前它检查的是"直接进角色选择"，改流程后它立刻红了，
    // 这正是产物冒烟测试的价值：跑的是真实构建产物，流程变更跑不掉。
    for (const title of ['主线剧情', '活动模式', '扩展 · 社区模式', '制作者名单']) {
      expect(text, `启动后主菜单缺少「${title}」`).toContain(title);
    }
    // 角色选择不该在启动时就出现 —— 它得先点「主线剧情」
    expect(text, '主菜单阶段就把角色列出来了，说明流程串了').not.toContain('值夜护士');
  });

  it('产物里没有残留的开发期调试代码', () => {
    const js = readFileSync(ENTRY, 'utf8');
    // console.log 在开发期到处都是，发布产物里只该留 console.error/warn
    const logs = js.match(/console\.log\(/g) ?? [];
    expect(
      logs.length,
      `产物里有 ${logs.length} 处 console.log —— 发布前该清掉`,
    ).toBeLessThanOrEqual(2);
  });
});

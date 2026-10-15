import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 给 index.html 里的 app.js / index.css 加一个内容哈希查询串。
 *
 * 【为什么需要】产物文件名是固定的（见下面 entryFileNames 的注释：
 * dist-smoke 要 import 它，带 hash 的名字没法稳定引用）。
 * 但"固定文件名 + GitHub Pages 的 max-age=600"意味着：
 * 部署了新版本，浏览器十分钟内还会拿旧的 —— 表现就是
 * "我明明推上去了，打开还是老样子"，而且刷新也没用。
 *
 * 加一个跟着内容变的查询串，路径没变、缓存却会失效。
 */
function cacheBustHtml(): Plugin {
  return {
    name: 'dreamloop:cache-bust-html',
    // closeBundle 在产物写盘之后跑，这时才读得到 app.js 的内容
    closeBundle() {
      const distDir = r('./dist');
      const htmlPath = join(distDir, 'index.html');
      if (!existsSync(htmlPath)) return;

      let html = readFileSync(htmlPath, 'utf8');
      for (const asset of ['app.js', 'index.css']) {
        const assetPath = join(distDir, asset);
        if (!existsSync(assetPath)) continue;
        const hash = createHash('sha256')
          .update(readFileSync(assetPath))
          .digest('hex')
          .slice(0, 8);
        // 只替换相对路径那种引用，别碰别的
        html = html.split(`"./${asset}"`).join(`"./${asset}?v=${hash}"`);
      }
      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  // 相对路径 base：构建产物可以直接丢到任何静态托管的子目录
  base: './',

  /**
   * 把 assets/ 当作 public 目录。
   *
   * 这样素材在开发服务器和构建产物里都【按 URL 取】：
   *     ./map/wall.png
   *     ./characters/dream_archivist/actions/idle.png
   *
   * 这正是 assets/README.md 定的约定 —— "界面按 id 取图，用 URL 引用，
   * 不把图片 import 进 TypeScript"。import 图片会让打包器重命名文件、
   * 生成 hash，路径就不再可控了。
   *
   * 用相对路径（./ 而不是 /）是为了子目录部署：
   * 站点在 /Dreamloop/ 下时，./map/wall.png 会正确解析成 /Dreamloop/map/wall.png。
   */
  publicDir: 'assets',

  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@data': r('./src/data'),
    },
  },

  server: {
    // 5173 被别的项目占了，换一个
    port: 5174,
    // --host 已在 npm script 里，允许手机通过局域网 IP 访问
    host: true,
  },

  build: {
    outDir: 'dist',
    target: 'es2022',
    // 单文件风格：文字游戏体积本来就小，没必要切太多 chunk
    assetsInlineLimit: 8192,

    rollupOptions: {
      output: {
        // 用固定文件名，不用内容 hash。
        //
        // 原因：tests/dist-smoke.test.ts 要 import 构建产物，
        // 验证"真正发布出去的那份代码"能跑起来。带 hash 的文件名
        // 每构建一次就变，测试没法稳定引用。
        //
        // 代价是牺牲了 CDN 缓存失效能力 —— 对一个 25KB 的静态站点
        // 来说这个代价可以忽略，而"能验证发布产物"值这个价。
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },

  // core 是纯 TS，不需要任何 polyfill；显式声明避免误引入
  esbuild: {
    target: 'es2022',
  },

  plugins: [cacheBustHtml()],
});

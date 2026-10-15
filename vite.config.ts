import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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
});

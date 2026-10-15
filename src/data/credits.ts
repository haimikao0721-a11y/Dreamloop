/**
 * ════════════════════════════════════════════════════════════════
 *  data/credits.ts —— 制作者名单
 * ════════════════════════════════════════════════════════════════
 *
 *  做成【数据】而不是写死在渲染层里，原因有两个：
 *
 *    1. 社区贡献者要能自己加进来 —— 加一行就行，不用改 UI 代码
 *    2. 分节展示（制作 / 技术 / 协议 / 致谢）天然是结构化数据
 *
 *  更新时同步 CONTRIBUTORS.md（那份是给 GitHub 看的，这份是给玩家看的）。
 * ════════════════════════════════════════════════════════════════
 */

export interface CreditEntry {
  readonly name: string;
  /** 做了什么 */
  readonly role: string;
  /** 可选链接 */
  readonly link?: string;
}

export interface CreditSection {
  readonly title: string;
  readonly entries: readonly CreditEntry[];
  /** 这一节的补充说明，可选 */
  readonly note?: string;
}

export const CREDITS: readonly CreditSection[] = [
  {
    title: '制作',
    entries: [
      {
        name: '海米糕',
        role: '发起人 · 设计 · 引擎 · 第一幕内容 · 界面 · 文档',
        link: 'https://github.com/haimikao0721-a11y',
      },
    ],
    note: '贡献者名单见仓库的 CONTRIBUTORS.md。你写的东西版权归你。',
  },
  {
    title: '技术',
    entries: [
      { name: 'TypeScript', role: '语言', link: 'https://www.typescriptlang.org/' },
      { name: 'Vite', role: '构建与开发服务器', link: 'https://vite.dev/' },
      { name: 'Vitest', role: '测试框架', link: 'https://vitest.dev/' },
      { name: 'happy-dom', role: '测试用的 DOM 环境', link: 'https://github.com/capricorn86/happy-dom' },
      { name: 'pnpm', role: '包管理', link: 'https://pnpm.io/' },
    ],
  },
  {
    title: '授权',
    entries: [
      { name: 'MIT', role: '代码 —— 可自由使用，包括商业使用' },
      {
        name: 'CC BY-NC-SA 4.0',
        role: '内容与素材 —— 欢迎非商业二创，商用需另行授权',
        link: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      },
    ],
    note: '商业使用请联系维护者，收益分配见 REVENUE.md。',
  },
  {
    title: '特别感谢',
    entries: [],
    note: '这里留给你 —— 玩过并给了具体反馈的人。一个游戏能不能做下去，往往就取决于有没有人真的玩过并说点什么。',
  },
];

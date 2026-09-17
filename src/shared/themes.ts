// 内建配色方案与主题键白名单单源：深/浅两套 Catppuccin 官方配色（Mocha /
// Latte，kitty 映射）。此前调色板数据硬编码在渲染层 theme.ts，主进程主题
// 加载器也需要内建定义做列表兜底与合并基线，提到 shared 单源（内建的 UI
// 变量面不在此处——就是 index.css 的 :root / :root[data-theme='light']
// 两组，CSS 本身即数据源）

import type { ThemeColorKey, ThemeDef, ThemeUiVar } from './types'

export type { ThemeColorKey, ThemeDef, ThemeUiVar } from './types'

// UI 变量白名单：index.css 的 :root 变量去掉 --shadow-lg（完整 box-shadow 串
// 无法安全校验，维持按深浅内建）。主进程校验（themes 目录/插件主题包）与
// 渲染层内联变量清理共用这一份
export const THEME_UI_VARS: readonly ThemeUiVar[] = [
  'bg', 'bg-deep', 'bg-inset', 'surface', 'surface-hover', 'text', 'text-bright',
  'accent', 'warn', 'hairline', 'hover-wash', 'menu-bg', 'kbd', 'kbd-strong',
  'thumb', 'thumb-hover', 'thumb-active'
]

// 终端颜色键白名单：xterm ITheme 的颜色字段（前景/光标/选区 + ANSI 16 色）
export const THEME_COLOR_KEYS: readonly ThemeColorKey[] = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
]

export const BUILTIN_MOCHA: ThemeDef = {
  id: 'mocha',
  name: 'Catppuccin Mocha',
  type: 'dark',
  builtin: true,
  terminal: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8'
  }
}

export const BUILTIN_LATTE: ThemeDef = {
  id: 'latte',
  name: 'Catppuccin Latte',
  type: 'light',
  builtin: true,
  terminal: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be',
    selectionForeground: '#4c4f69',
    black: '#5c6f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#6c6f85',
    brightBlack: '#9ca0b0',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb',
    brightCyan: '#179299',
    brightWhite: '#8c8fa1'
  }
}

export const BUILTIN_THEMES: ThemeDef[] = [BUILTIN_MOCHA, BUILTIN_LATTE]

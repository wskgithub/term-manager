// 主题中枢：三态设置（深/浅/跟随系统）→ 实际深浅 → CSS 变量组与 xterm 调色板。
// 深浅两套都是 Catppuccin 官方配色（Mocha / Latte），与应用既有观感同族。

import type { ITheme } from '@xterm/xterm'

export type ThemeOption = 'dark' | 'light' | 'system'

export const THEME_LABELS: Record<ThemeOption, string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

// 渲染层的 prefers-color-scheme 跟随主进程 nativeTheme：
// themeSource 为 system 时随系统深浅，显式 dark/light 时被强制覆盖，
// 所以「跟随系统」只需订阅同一个 matchMedia，三种设置一条通路
const schemeMQ = window.matchMedia('(prefers-color-scheme: dark)')

export function subscribeScheme(onChange: () => void): () => void {
  schemeMQ.addEventListener('change', onChange)
  return () => schemeMQ.removeEventListener('change', onChange)
}

/** 三态设置 → 当前是否深色（App 用 useSyncExternalStore 消费） */
export function resolveDark(theme: ThemeOption): boolean {
  return theme === 'system' ? schemeMQ.matches : theme === 'dark'
}

// ── xterm 调色板：ANSI 16 色 + 前后景/光标/选区，按 Catppuccin 官方 kitty 映射 ──
// 此前只设了 background/foreground（ANSI 走 xterm 内置 Tango），现在两套各自成套，
// 深浅切换时终端 16 色与界面一起换

const MOCHA: ITheme = {
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

const LATTE: ITheme = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#dc8a78',
  cursorAccent: '#eff1f5',
  selectionBackground: '#acb0be',
  selectionForeground: '#4c4f69',
  black: '#5c5f77',
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

export function xtermTheme(dark: boolean): ITheme {
  return dark ? MOCHA : LATTE
}

/**
 * 抗首帧闪色：设置是异步加载的，浅色用户启动时会先按默认深色画一帧再翻面。
 * 这里把上次的主题设置同步解析进 <html data-theme>（CSS 变量挂它上面），
 * main.tsx 在 React 渲染前调用一次：system 用 matchMedia 实时解析，重启即命中正确主题
 */
export function preapplyTheme(): void {
  const stored = localStorage.getItem('tm.theme')
  const theme: ThemeOption = stored === 'light' || stored === 'system' ? stored : 'dark'
  document.documentElement.dataset.theme = resolveDark(theme) ? 'dark' : 'light'
}

export function rememberTheme(theme: ThemeOption): void {
  try {
    localStorage.setItem('tm.theme', theme)
  } catch {
    // 隐私模式等 localStorage 不可用时静默放弃，只损失下次启动的首帧精度
  }
}

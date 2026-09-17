// 内建配色方案与主题键白名单单源：深/浅两套 Catppuccin 官方配色（Mocha /
// Latte，kitty 映射）。此前调色板数据硬编码在渲染层 theme.ts，主进程主题
// 加载器也需要内建定义做列表兜底与合并基线，提到 shared 单源（内建的 UI
// 变量面不在此处——就是 index.css 的 :root / :root[data-theme='light']
// 两组，CSS 本身即数据源）

import type { ThemeColorKey, ThemeDef, ThemeFile, ThemeUiVar } from './types'

export type { ThemeColorKey, ThemeDef, ThemeFile, ThemeUiVar } from './types'

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

// ── 主题数据校验（主进程 themes 目录/插件主题包、渲染层动态注册主题共用单源）──
// 只接受 #hex（3/4/6/8 位）与 rgba()（分量 0-255、α 0-1）。index.css 的变量
// 取值全在这两种形态内，收紧格式即收紧注入面（值最终进 CSS 内联样式）。
// 逐段解析而非一条大正则：可读且每段含义独立

const HEX_DIGITS = '0123456789abcdefABCDEF'

function validHex(v: string): boolean {
  if (v.length !== 4 && v.length !== 5 && v.length !== 7 && v.length !== 9) return false
  for (let i = 1; i < v.length; i++) {
    if (!HEX_DIGITS.includes(v[i])) return false
  }
  return true
}

function intIn(part: string, max: number): boolean {
  if (!/^\d{1,3}$/.test(part)) return false
  return Number(part) <= max
}

function validRgba(v: string): boolean {
  if (!v.startsWith('rgba(') || !v.endsWith(')')) return false
  const parts = v.slice('rgba('.length, -1).split(',').map((s) => s.trim())
  if (parts.length !== 4) return false
  if (!intIn(parts[0], 255) || !intIn(parts[1], 255) || !intIn(parts[2], 255)) return false
  const alpha = parts[3]
  return alpha === '0' || alpha === '1' || /^0?\.\d+$/.test(alpha)
}

export function validColor(v: unknown): v is string {
  if (typeof v !== 'string') return false
  return v.startsWith('#') ? validHex(v) : validRgba(v)
}

// ui/terminal 内部坏键逐个丢弃（照 validProfile 的 drop+告警文化）：
// 一个拼错的颜色不应废掉整份方案
function pickColors(
  raw: unknown,
  allowed: readonly string[],
  source: string
): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error(`[themes] ${source}: ui/terminal 必须是对象，整段忽略`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.includes(k) || !validColor(v)) {
      console.error(`[themes] ${source}: dropped bad color field '${k}'`)
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * 清洗一份主题数据对象（themes 目录 JSON、插件主题包、渲染层动态注册共用）。
 * name/type 非法整份丢弃返回 null；ui/terminal 内非法字段逐个丢弃。
 * 返回清洗后的副本，不含 id。
 */
export function sanitizeTheme(raw: unknown, source: string): ThemeFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.name.trim()) {
    console.error(`[themes] ${source}: name 必填，skipped`)
    return null
  }
  if (r.type !== 'dark' && r.type !== 'light') {
    console.error(`[themes] ${source}: type 必须是 'dark' | 'light'，skipped`)
    return null
  }
  const out: ThemeFile = { name: r.name.trim().slice(0, 80), type: r.type }
  const ui = pickColors(r.ui, THEME_UI_VARS, source)
  if (ui && Object.keys(ui).length) out.ui = ui as ThemeFile['ui']
  const terminal = pickColors(r.terminal, THEME_COLOR_KEYS, source)
  if (terminal && Object.keys(terminal).length) out.terminal = terminal as ThemeFile['terminal']
  return out
}

/** 解析一份主题 JSON 文本（文件态入口；对象态走 sanitizeTheme） */
export function parseThemeFile(raw: string, source: string): ThemeFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[themes] ${source}: bad JSON, skipped:`, e)
    return null
  }
  return sanitizeTheme(parsed, source)
}

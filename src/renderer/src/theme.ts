// 主题中枢：三态设置（深/浅/跟随系统）→ 实际深浅 → 当前生效的配色方案。
// 方案数据（内建 Mocha/Latte + themes 目录自定义）经 themes:list 从主进程拉取，
// 内建定义与键白名单单源在 shared/themes.ts；本文件负责解析生效方案、把 UI
// 变量落到 <html> 内联样式（覆盖 index.css 的 :root 基线，清除即回退级联），
// xterm 调色板由 App 的全局 effect 下发给所有终端实例。

import type { ThemeDef, ThemeOption, ThemeUiVar } from '../../shared/types'
import { BUILTIN_LATTE, BUILTIN_MOCHA, THEME_UI_VARS } from '../../shared/themes'

export type { ThemeOption } from '../../shared/types'

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

export interface SchemeSettings {
  darkTheme: string
  lightTheme: string
}

/**
 * 生效方案解析：深/浅两端各取设置里存的 id，列表里找不到（文件被删/坏 id）
 * 回退该侧内建。terminal 与该侧内建显式合并——方案只声明部分颜色时，未声明
 * 项继承内建而非 xterm 默认（直接赋 partial 调色板会把缺省色打回白底）；ui
 * 无需合并：内联样式只覆盖已声明项，其余走 CSS 级联天然继承 :root 基线。
 */
export function pickScheme(defs: ThemeDef[], dark: boolean, settings: SchemeSettings): ThemeDef {
  const base = dark ? BUILTIN_MOCHA : BUILTIN_LATTE
  const id = dark ? settings.darkTheme : settings.lightTheme
  const found = defs.find((t) => t.id === id) ?? base
  return { ...found, terminal: { ...base.terminal, ...found.terminal } }
}

/** UI 内联变量应用：先清空白名单内全部变量再设已声明项——内联优先于 :root
    规则，上个方案的残留变量不清掉会继续压住级联 */
export function applyUiVars(ui?: Partial<Record<ThemeUiVar, string>>): void {
  const style = document.documentElement.style
  for (const v of THEME_UI_VARS) style.removeProperty(`--${v}`)
  if (!ui) return
  for (const [k, v] of Object.entries(ui)) style.setProperty(`--${k}`, v)
}

// 最近一次生效的 UI 变量表（深/浅两侧各存一份）：启动时设置与主题列表都是
// 异步的，preapplyTheme 用它同步预应用自定义配色，防首帧闪内建色。只存方案
// 声明的变量（内建/未声明 = null，即无内联），数据到位后由 App 的 effect 纠正
const SCHEME_VARS_KEY = 'tm.schemeVars'

interface CachedSchemeVars {
  dark: Record<string, string> | null
  light: Record<string, string> | null
}

export function rememberSchemeVars(dark: boolean, scheme: ThemeDef): void {
  try {
    const stored = JSON.parse(localStorage.getItem(SCHEME_VARS_KEY) ?? '{}') as Partial<CachedSchemeVars>
    const ui = scheme.ui && Object.keys(scheme.ui).length ? scheme.ui : null
    const next: CachedSchemeVars = {
      dark: dark ? ui : stored.dark ?? null,
      light: dark ? stored.light ?? null : ui
    }
    localStorage.setItem(SCHEME_VARS_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式等 localStorage 不可用时静默放弃，只损失下次启动的首帧精度
  }
}

/**
 * 抗首帧闪色：设置是异步加载的，浅色用户启动时会先按默认深色画一帧再翻面。
 * 这里把上次的主题设置同步解析进 <html data-theme>（CSS 变量挂它上面），
 * main.tsx 在 React 渲染前调用一次：system 用 matchMedia 实时解析，重启即
 * 命中正确主题；自定义配色再按缓存预应用内联变量（坏缓存直接忽略，异步
 * 加载后正确值会覆盖）
 */
export function preapplyTheme(): void {
  const stored = localStorage.getItem('tm.theme')
  const theme: ThemeOption = stored === 'light' || stored === 'system' ? stored : 'dark'
  const dark = resolveDark(theme)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  try {
    const vars = JSON.parse(localStorage.getItem(SCHEME_VARS_KEY) ?? 'null') as CachedSchemeVars | null
    const ui = dark ? vars?.dark : vars?.light
    if (ui) applyUiVars(ui as Partial<Record<ThemeUiVar, string>>)
  } catch {
    // 见上：坏缓存忽略
  }
}

export function rememberTheme(theme: ThemeOption): void {
  try {
    localStorage.setItem('tm.theme', theme)
  } catch {
    // 隐私模式等 localStorage 不可用时静默放弃，只损失下次启动的首帧精度
  }
}

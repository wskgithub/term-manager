import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ThemeDef, ThemeFile } from '../shared/types'
import { BUILTIN_THEMES, THEME_COLOR_KEYS, THEME_UI_VARS } from '../shared/themes'

export type { ThemeDef } from '../shared/types'

// 配色方案目录加载器：themes/*.json 是纯用户内容（区别于 profiles.json 的
// 探测回写），只读不落盘。无 fs.watch——设置页/面板打开时经 themes:list 重扫
// （profiles:list 每次重探同款触发式刷新）。键白名单（THEME_UI_VARS /
// THEME_COLOR_KEYS）与内建定义在 shared/themes.ts 单源。

// ── 颜色值校验：只接受 #hex（3/4/6/8 位）与 rgba()（分量 0-255、α 0-1）。
// index.css 的变量取值全在这两种形态内，收紧格式即收紧注入面（值最终进 CSS
// 内联样式）。逐段解析而非一条大正则：可读且每段含义独立 ──

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
 * 解析一份主题 JSON（themes 目录与插件主题包共用）。name/type 非法整份丢弃
 * 返回 null；ui/terminal 内非法字段逐个丢弃。返回的是清洗后的副本，不含 id。
 */
export function parseThemeFile(raw: string, source: string): ThemeFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[themes] ${source}: bad JSON, skipped:`, e)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
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

// 内建 id 保留字：自定义文件不得占用（占用会让「换回内建」失去退路）
const RESERVED_IDS = new Set(BUILTIN_THEMES.map((t) => t.id))
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export class ThemeRegistry {
  private dir = ''
  private customs: ThemeDef[] = []

  load(): void {
    this.dir = join(app.getPath('userData'), 'themes')
    // 建目录只为可发现性：用户能直接看到该往哪放文件
    mkdirSync(this.dir, { recursive: true })
    this.refresh()
  }

  /** 重扫目录（themes:list 每次调用触发，无 fs.watch 的代价由打开时机摊销） */
  refresh(): void {
    const found: ThemeDef[] = []
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort()
    } catch {
      this.customs = []
      return
    }
    for (const f of files) {
      const id = f.slice(0, -'.json'.length)
      if (!ID_RE.test(id) || RESERVED_IDS.has(id)) {
        console.error(`[themes] skipped '${f}': 文件名必须是保留字之外的 [A-Za-z0-9_-] id`)
        continue
      }
      let raw: string
      try {
        raw = readFileSync(join(this.dir, f), 'utf-8')
      } catch (e) {
        console.error(`[themes] ${f}: 读取失败, skipped:`, e)
        continue
      }
      const parsed = parseThemeFile(raw, f)
      if (!parsed) continue
      found.push({ id, builtin: false, ...parsed })
    }
    this.customs = found
  }

  list(): ThemeDef[] {
    return [...BUILTIN_THEMES, ...this.customs]
  }

  get(id: string): ThemeDef | undefined {
    return this.list().find((t) => t.id === id)
  }
}

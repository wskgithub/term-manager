import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type AppSettings, type CustomAgent } from '../shared/types'

export type { AppSettings, ThemeOption } from '../shared/types'
export { DEFAULT_SETTINGS }

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 48
const FONT_FAMILY_MAX = 200
const DEFAULT_PROFILE_MAX = 100
// 配色方案 id：字符集不含空格与控制字符（/ 为插件命名空间 id 预留）；
// 不校验存在性——方案列表归 ThemeRegistry 管，渲染层解析不到时回退内建
const SCHEME_ID_MAX = 80
const SCHEME_ID_RE = /^[A-Za-z0-9/_-]+$/
// agent id（内置注册表/自定义/hiddenAgents 键）：小写字母数字与连字符
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const AGENT_NAME_MAX = 40
const AGENT_ARGV_MAX = 8
const AGENT_ARG_MAX = 200
const CUSTOM_AGENTS_MAX = 20
// argv 白名单：命令名/绝对路径/常见参数形态，禁空格与全部 shell 元字符——
// 自定义 agent 最终经 tmux sh -c 执行，从输入侧根绝注入面（主进程侧另有
// shQuote/tmuxToken 双层转义，这里是最外一道）
const AGENT_ARG_RE = /^[A-Za-z0-9_./=,:@%+-]+$/
const CONFIG_VERSION = 1

interface ConfigFile extends AppSettings {
  version: number
}

// fc-list 不可用时的兜底候选（本机探测失效也不至于无字体可选）
const FALLBACK_FONTS = [
  'JetBrainsMono Nerd Font',
  'FiraCode Nerd Font',
  'JetBrains Mono',
  'DejaVu Sans Mono',
  'Noto Mono',
  'Ubuntu Mono',
  'Liberation Mono'
]

function sanitize(input: unknown, base: AppSettings): AppSettings {
  if (typeof input !== 'object' || input === null) return { ...base }
  const raw = input as Record<string, unknown>
  const out: AppSettings = { ...base }

  if (typeof raw.fontFamily === 'string') {
    out.fontFamily = raw.fontFamily
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, FONT_FAMILY_MAX)
  }
  if (typeof raw.defaultProfileId === 'string') {
    out.defaultProfileId = raw.defaultProfileId
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, DEFAULT_PROFILE_MAX)
  }
  if (raw.theme === 'dark' || raw.theme === 'light' || raw.theme === 'system') {
    out.theme = raw.theme
  }
  for (const key of ['darkTheme', 'lightTheme'] as const) {
    if (typeof raw[key] === 'string') {
      const id = (raw[key] as string)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, SCHEME_ID_MAX)
      if (SCHEME_ID_RE.test(id)) out[key] = id
    }
  }
  if (typeof raw.keepSessionOnExit === 'boolean') {
    out.keepSessionOnExit = raw.keepSessionOnExit
  }
  if (typeof raw.groupBroadcast === 'boolean') {
    out.groupBroadcast = raw.groupBroadcast
  }
  if (typeof raw.sidebarVisible === 'boolean') {
    out.sidebarVisible = raw.sidebarVisible
  }
  if (typeof raw.gpuRendering === 'boolean') {
    out.gpuRendering = raw.gpuRendering
  }
  if (typeof raw.osc52Copy === 'boolean') {
    out.osc52Copy = raw.osc52Copy
  }
  if (Array.isArray(raw.customAgents)) {
    const list: CustomAgent[] = []
    for (const c of raw.customAgents) {
      if (typeof c !== 'object' || c === null) continue
      const r = c as Record<string, unknown>
      if (typeof r.id !== 'string' || !AGENT_ID_RE.test(r.id)) continue
      if (typeof r.name !== 'string') continue
      const name = r.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, AGENT_NAME_MAX)
      if (!name) continue
      if (!Array.isArray(r.argv) || r.argv.length === 0 || r.argv.length > AGENT_ARGV_MAX) continue
      const argv: string[] = []
      let bad = false
      for (const a of r.argv) {
        if (typeof a !== 'string' || !a || a.length > AGENT_ARG_MAX || !AGENT_ARG_RE.test(a)) {
          bad = true
          break
        }
        argv.push(a)
      }
      if (bad) continue
      if (list.some((x) => x.id === r.id)) continue
      list.push({ id: r.id, name, argv })
    }
    out.customAgents = list.slice(0, CUSTOM_AGENTS_MAX)
  }
  if (Array.isArray(raw.hiddenAgents)) {
    const seen = new Set<string>()
    for (const h of raw.hiddenAgents) {
      if (typeof h === 'string' && AGENT_ID_RE.test(h)) seen.add(h)
    }
    out.hiddenAgents = [...seen].slice(0, 64)
  }
  if (raw.fontSize !== undefined) {
    const n = Math.round(Number(raw.fontSize))
    if (Number.isFinite(n)) out.fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n))
  }
  return out
}

export class SettingsStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private file = ''

  load(): void {
    this.file = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('unexpected settings.json structure')
      }
      this.settings = sanitize(raw, DEFAULT_SETTINGS)
    } catch (e) {
      console.error('[settings] bad settings.json, falling back to defaults:', e)
      this.settings = { ...DEFAULT_SETTINGS }
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  set(patch: unknown): AppSettings {
    this.settings = sanitize(patch, this.settings)
    this.save()
    return this.get()
  }

  private save(): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const cfg: ConfigFile = { version: CONFIG_VERSION, ...this.settings }
    writeFileSync(this.file, JSON.stringify(cfg, null, 2))
  }
}

let fontsCache: string[] | null = null

/**
 * 枚举本机等宽字体族（供设置页字体下拉）：
 * :mono 限定等宽，charset=0041（含大写 A）剔除 Noto Color Emoji / PowerlineSymbols 等
 * 只有符号的假阳性。结果进程内缓存；fc-list 缺失或失败时回落内置列表。
 */
export function listMonospaceFonts(): Promise<string[]> {
  if (fontsCache) return Promise.resolve(fontsCache)
  return new Promise((resolve) => {
    execFile(
      'fc-list',
      [':mono:charset=0041', '-f', '%{family[0]}\\n'],
      { timeout: 3000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) console.error('[settings] fc-list failed, using fallback font list:', err.message)
        const families = err
          ? []
          : [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort((a, b) =>
              a.localeCompare(b)
            )
        fontsCache = families.length ? families : [...FALLBACK_FONTS]
        resolve(fontsCache)
      }
    )
  })
}

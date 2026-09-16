import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types'

export type { AppSettings, ThemeOption } from '../shared/types'
export { DEFAULT_SETTINGS }

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 48
const FONT_FAMILY_MAX = 200
const DEFAULT_PROFILE_MAX = 100
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

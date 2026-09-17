import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ThemeDef } from '../shared/types'
import { BUILTIN_THEMES, parseThemeFile } from '../shared/themes'

export type { ThemeDef } from '../shared/types'

// 配色方案目录加载器：themes/*.json 是纯用户内容（区别于 profiles.json 的
// 探测回写），只读不落盘。无 fs.watch——设置页/面板打开时经 themes:list 重扫
//（profiles:list 每次重探同款触发式刷新）。键白名单、内建定义与校验/清洗
// 函数（validColor/sanitizeTheme/parseThemeFile）在 shared/themes.ts 单源，
// 渲染层代码级插件的动态主题注册复用同一份。

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

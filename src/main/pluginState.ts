import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// 插件管理 UI 的禁用态存储：userData/plugin-state.json。
// 形态 {version:1, disabled:['<插件id>', ...]}：
// - 禁用是纯管理语义，与插件文件无关（文件夹还在，随时可再启用）；
// - 禁用的效果在主进程 list() 收口：声明式贡献（profiles/commands/themes）
//   清空下发，渲染层据此不挂代码帧（等价卸载）；
// - 只在变化时回写（沿用 plugin-permissions.json 的口径）。

interface StateFile {
  version: 1
  disabled: string[]
}

export class PluginStateStore {
  private file = ''
  private raw = ''
  private disabled = new Set<string>()

  load(): void {
    this.file = join(app.getPath('userData'), 'plugin-state.json')
    this.raw = existsSync(this.file) ? readFileSync(this.file, 'utf-8') : ''
    this.disabled.clear()
    if (this.raw) {
      try {
        const parsed = JSON.parse(this.raw) as StateFile
        // 文件可被手工编辑：非字符串条目与重复项一律丢弃
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.disabled)) {
          for (const id of parsed.disabled) {
            if (typeof id === 'string' && id) this.disabled.add(id)
          }
        }
      } catch (e) {
        console.error('[plugin-state] bad plugin-state.json, starting empty:', e)
      }
    }
  }

  isDisabled(id: string): boolean {
    return this.disabled.has(id)
  }

  setDisabled(id: string, on: boolean): void {
    const had = this.disabled.has(id)
    if (on === had) return
    if (on) this.disabled.add(id)
    else this.disabled.delete(id)
    this.save()
  }

  private save(): void {
    const out: StateFile = { version: 1, disabled: [...this.disabled].sort() }
    const next = JSON.stringify(out, null, 2)
    if (next === this.raw) return
    this.raw = next
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(this.file, next)
  }
}

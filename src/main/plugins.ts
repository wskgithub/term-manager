import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { PluginAction, PluginCommandDef, PluginInfo, Profile, ThemeDef } from '../shared/types'
import { findOnPath, validProfile } from './profiles'
import { parseThemeFile } from './themes'

export type { PluginInfo } from '../shared/types'

// 声明式插件注册表：plugins/<目录>/manifest.json，一个文件夹一个插件。
// 能力封闭为三类数据贡献——注入 profile（新标签菜单/面板可选）、命令面板条目
// （动作词汇封闭，见 PluginAction）、主题包（themes/ 子目录，与全局主题同格式、
// id 命名空间化）。零代码执行、零网络：manifest 是纯数据，安装即信任其声明的
// 内容（launch 动作 = 用户亲手在面板触发）。文件夹在即生效、删除即停用，
// 无启用状态持久化（管理界面属后续阶段）。
//
// 只读不落盘（同 ThemeRegistry）：plugins:list 每次调用重扫。

const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// 插件 id 更严：全小写（它要进 palette 的 data-key 与主题 id 命名空间）
const PLUGIN_ID_RE = /^[a-z0-9-]{1,64}$/
// set-scheme 引用的方案 id：与 settings.ts 的 SCHEME_ID_RE 同集（/ 为插件主题）
const SCHEME_REF_RE = /^[A-Za-z0-9/_-]{1,80}$/
// 防病态 manifest：单插件贡献条目上限
const MAX_PROFILES = 50
const MAX_COMMANDS = 100
const MAX_THEMES = 50

interface LoadedPlugin extends PluginInfo {
  // 本地 profile id 集：launch 动作引用合法性的校验依据
  localProfileIds: Set<string>
}

function validCommand(
  raw: unknown,
  plugin: { id: string; localProfileIds: Set<string> },
  source: string
): PluginCommandDef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !LOCAL_ID_RE.test(r.id)) {
    console.error(`[plugins] ${source}: 命令 id 非法，丢弃`)
    return null
  }
  if (typeof r.label !== 'string' || !r.label.trim()) {
    console.error(`[plugins] ${source}: 命令 label 必填，丢弃`)
    return null
  }
  const action = validAction(r.action, plugin, `${source}#${r.id}`)
  if (!action) return null
  const cmd: PluginCommandDef = { id: r.id, label: r.label.trim().slice(0, 120), action }
  if (typeof r.keywords === 'string' && r.keywords.trim()) cmd.keywords = r.keywords.slice(0, 200)
  if (typeof r.hint === 'string' && r.hint.trim()) cmd.hint = r.hint.slice(0, 80)
  return cmd
}

// 动作词汇校验：类型之外的引用字段也要合法（launch 必须指向自家 profile，
// set-scheme 的 id 只查字符集——存在性由渲染层置灰处理，主进程不感知主题表）
function validAction(
  raw: unknown,
  plugin: { id: string; localProfileIds: Set<string> },
  source: string
): PluginAction | null {
  if (typeof raw !== 'object' || raw === null) {
    console.error(`[plugins] ${source}: 缺少 action，丢弃`)
    return null
  }
  const a = raw as Record<string, unknown>
  switch (a.type) {
    case 'launch':
      if (typeof a.profile !== 'string' || !plugin.localProfileIds.has(a.profile)) {
        console.error(`[plugins] ${source}: launch 引用了不存在的自家 profile，丢弃`)
        return null
      }
      return { type: 'launch', profile: a.profile }
    case 'open-settings':
      return { type: 'open-settings' }
    case 'toggle-sidebar':
      return { type: 'toggle-sidebar' }
    case 'set-theme':
      if (a.mode !== 'dark' && a.mode !== 'light' && a.mode !== 'system') {
        console.error(`[plugins] ${source}: set-theme 的 mode 非法，丢弃`)
        return null
      }
      return { type: 'set-theme', mode: a.mode }
    case 'set-scheme':
      if (typeof a.id !== 'string' || !SCHEME_REF_RE.test(a.id)) {
        console.error(`[plugins] ${source}: set-scheme 的 id 非法，丢弃`)
        return null
      }
      return { type: 'set-scheme', id: a.id }
    default:
      console.error(`[plugins] ${source}: 未知 action 类型 '${String(a.type)}'，丢弃`)
      return null
  }
}

function loadPlugin(dir: string, dirName: string): LoadedPlugin | null {
  const source = `plugins/${dirName}`
  let raw: string
  try {
    raw = readFileSync(join(dir, 'manifest.json'), 'utf-8')
  } catch (e) {
    console.error(`[plugins] ${source}: manifest.json 读取失败, skipped:`, e)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[plugins] ${source}: bad JSON, skipped:`, e)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (typeof r.id !== 'string' || !PLUGIN_ID_RE.test(r.id)) {
    console.error(`[plugins] ${source}: id 必须是 [a-z0-9-]{1,64}，skipped`)
    return null
  }
  if (typeof r.name !== 'string' || !r.name.trim()) {
    console.error(`[plugins] ${source}: name 必填，skipped`)
    return null
  }

  // profiles：validProfile 复用 + 本地 id 字符集收紧（id 会被重写成「插件:局部」
  // 进 palette key），availability 与 ProfileRegistry.detectAvailability 同口径
  const localProfileIds = new Set<string>()
  const profiles: Profile[] = []
  if (r.profiles !== undefined) {
    if (!Array.isArray(r.profiles)) {
      console.error(`[plugins] ${source}: profiles 必须是数组，整段忽略`)
    } else {
      for (const p of r.profiles.slice(0, MAX_PROFILES)) {
        const localId = (p as { id?: unknown })?.id
        if (!validProfile(p) || typeof localId !== 'string' || !LOCAL_ID_RE.test(localId)) {
          console.error(`[plugins] ${source}: dropped malformed plugin profile:`, JSON.stringify(p)?.slice(0, 200))
          continue
        }
        const merged: Profile = { ...p, id: `${r.id}:${localId}` }
        merged.available = merged.command ? findOnPath(merged.command) : true
        localProfileIds.add(localId)
        profiles.push(merged)
      }
    }
  }

  // commands：动作词汇封闭；launch 引用自家 profile，坏引用整条丢弃
  const commands: PluginCommandDef[] = []
  if (r.commands !== undefined) {
    if (!Array.isArray(r.commands)) {
      console.error(`[plugins] ${source}: commands 必须是数组，整段忽略`)
    } else {
      const plugin = { id: r.id, localProfileIds }
      for (const c of r.commands.slice(0, MAX_COMMANDS)) {
        const cmd = validCommand(c, plugin, source)
        if (cmd) commands.push(cmd)
      }
    }
  }

  // themes：插件目录 themes/*.json，与全局主题同格式，id 命名空间化「插件/stem」
  const themes: ThemeDef[] = []
  try {
    const files = readdirSync(join(dir, 'themes')).filter((f) => f.endsWith('.json')).sort()
    for (const f of files.slice(0, MAX_THEMES)) {
      const stem = f.slice(0, -'.json'.length)
      if (!LOCAL_ID_RE.test(stem)) {
        console.error(`[plugins] ${source}/themes: skipped '${f}': 文件名必须是 [A-Za-z0-9_-] id`)
        continue
      }
      const parsedTheme = parseThemeFile(readFileSync(join(dir, 'themes', f), 'utf-8'), `${source}/themes/${f}`)
      if (parsedTheme) themes.push({ id: `${r.id}/${stem}`, builtin: false, ...parsedTheme })
    }
  } catch {
    // themes 子目录不存在是常态，静默
  }

  const info: LoadedPlugin = {
    id: r.id,
    name: r.name.trim().slice(0, 80),
    profiles,
    commands,
    themes,
    localProfileIds
  }
  if (typeof r.version === 'string' && r.version.trim()) info.version = r.version.slice(0, 32)
  return info
}

export class PluginRegistry {
  private dir = ''
  private plugins: LoadedPlugin[] = []

  load(): void {
    this.dir = join(app.getPath('userData'), 'plugins')
    // 建目录只为可发现性
    mkdirSync(this.dir, { recursive: true })
    this.refresh()
  }

  /** 重扫目录（plugins:list 每次调用触发）；重复 id 后者弃（按目录名排序取先） */
  refresh(): void {
    const found: LoadedPlugin[] = []
    const seen = new Set<string>()
    let entries: Array<{ name: string; isDirectory: boolean }> = []
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, isDirectory: true }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    } catch {
      this.plugins = []
      return
    }
    for (const e of entries) {
      const plugin = loadPlugin(join(this.dir, e.name), e.name)
      if (!plugin) continue
      if (seen.has(plugin.id)) {
        console.error(`[plugins] plugins/${e.name}: 重复插件 id '${plugin.id}'，skipped`)
        continue
      }
      seen.add(plugin.id)
      found.push(plugin)
    }
    this.plugins = found
  }

  list(): PluginInfo[] {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      profiles: p.profiles,
      commands: p.commands,
      themes: p.themes
    }))
  }

  /** term:create 解析：渲染层只传「插件:局部」形式的全局 id，命令体永远不收 */
  getProfile(id: string): Profile | undefined {
    for (const p of this.plugins) {
      const hit = p.profiles.find((x) => x.id === id)
      if (hit) return hit
    }
    return undefined
  }
}

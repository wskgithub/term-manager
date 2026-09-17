// 代码级插件宿主（L3 Tier 1）：manifest 带 entry 的插件经 tmplug:// 协议以
// module 脚本注入渲染层，与应用同 realm 运行；脚本样板
//   const tm = termManager.init('my-plugin')
// 取得命名空间化 API（TmScopedApi）。本模块持有全部注册表（命令/主题/状态栏/
// 事件与数据订阅），App 消费快照渲染。
//
// 安全模型（与 README「代码级插件」节一致）：同 realm 意味着插件 JS 能力上
// 与应用等价（window.api 本就可达）——真正的边界是 CSP 零网络（生产构建
// connect-src 'none'）+ 安装即信任，本 API 是文档化的收编入口而非安全门。
//
// 卸载语义：插件目录被删（plugins:list 不再出现）→ 其注册物（命令/动态主题/
// 状态栏项/事件与数据订阅）即时摘除；驻留 JS 代码无法卸载，惰性闭包留待重启。
// 版本号变更后重新放回会按 `${id}@${version}` 重新注入执行。

import type {
  AppSettings,
  PluginInfo,
  TermInfo,
  ThemeDef,
  ThemeOption,
  TmPluginEventName,
  TmRuntimeCommandDef,
  TmScopedApi,
  TmStatusItem,
  TmStatusbarEntry,
  TermManagerGlobal,
} from '../../shared/types'
import { sanitizeTheme, validColor } from '../../shared/themes'
import type { PaletteCommand } from './palette'

export interface PluginHostDeps {
  newTab(profileId?: string, cwd?: string): Promise<TermInfo | undefined>
  activateTab(id: string): void
  getTabs(): TermInfo[]
  getActiveId(): string
  getThemeDefs(): ThemeDef[]
  getSettings(): AppSettings
  applySettings(patch: Partial<AppSettings>): void
  openSettings(): void
  /** 终端写入（直达 tmux，不经广播扇出） */
  writeInput(id: string, data: string): void
}

// 注册表变化的渲染快照（App 持 state，onHostChange 单订阅者）
export interface HostSnapshot {
  commands: PaletteCommand[]
  themes: ThemeDef[]
  statusbar: TmStatusbarEntry[]
}

// 防病态插件：单插件注册物上限（与主进程 manifest caps 同文化）
const MAX_CMDS_PER_PLUGIN = 50
const MAX_THEMES_PER_PLUGIN = 20
const MAX_STATUS_PER_PLUGIN = 8
const MAX_EVENT_LISTENERS_PER_PLUGIN = 64
const MAX_DATA_SUBS_PER_PLUGIN = 32
const MAX_WRITE_CHUNK = 16_384

const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PLUGIN_ID_RE = /^[a-z0-9-]{1,64}$/
const EVENT_NAMES = new Set<string>([
  'tab-created',
  'tab-closed',
  'tab-activated',
  'tab-renamed',
  'theme-changed',
  'scheme-changed',
])

let deps: PluginHostDeps | null = null
let changeCb: ((s: HostSnapshot) => void) | null = null
// 最近一次 plugins:list 里带 entry 的插件 id（init 的合法性依据）
const knownIds = new Set<string>()
const pluginMeta = new Map<string, { name: string; version?: string }>()
// 已注入脚本的 `${id}@${version}`：同 key 不重注入（重跑需版本号变更）
const loaded = new Set<string>()
const scopedApis = new Map<string, TmScopedApi>()

interface CmdEntry {
  pluginId: string
  def: TmRuntimeCommandDef
}
const cmdReg = new Map<string, CmdEntry>() // key = `code:${pid}:${cid}`

interface ThemeEntry {
  pluginId: string
  def: ThemeDef
}
const themeReg = new Map<string, ThemeEntry>() // key = 命名空间化主题 id

interface StatusEntry {
  pluginId: string
  itemId: string
  item: TmStatusItem
}
const statusReg = new Map<string, StatusEntry>() // key = `${pid}:${itemId}`

interface EventSub {
  pluginId: string
  cb: (payload: unknown) => void
}
const eventReg = new Map<TmPluginEventName, EventSub[]>()

interface DataSub {
  pluginId: string
  cb: (data: string) => void
}
const dataReg = new Map<string, DataSub[]>() // key = 标签 id

function countOwned<T extends { pluginId: string }>(m: Iterable<T>, pid: string): number {
  let n = 0
  for (const e of m) if (e.pluginId === pid) n++
  return n
}

function buildCommandSnapshot(): PaletteCommand[] {
  const out: PaletteCommand[] = []
  for (const { pluginId, def } of cmdReg.values()) {
    out.push({
      key: `code:${pluginId}:${def.id}`,
      label: def.label,
      keywords: def.keywords,
      hint: def.hint,
      action: () => {
        try {
          void Promise.resolve(def.run()).catch((e) =>
            console.error(`[plugin-host] 插件 ${pluginId} 命令 ${def.id} 执行失败:`, e)
          )
        } catch (e) {
          console.error(`[plugin-host] 插件 ${pluginId} 命令 ${def.id} 执行抛错:`, e)
        }
      }
    })
  }
  return out
}

function buildStatusEntries(): TmStatusbarEntry[] {
  const out: TmStatusbarEntry[] = []
  for (const { pluginId, itemId, item } of statusReg.values()) {
    const name = pluginMeta.get(pluginId)?.name ?? pluginId
    out.push({
      key: `${pluginId}:${itemId}`,
      pluginId,
      pluginName: name,
      text: item.text,
      color: item.color,
      tooltip: item.tooltip ? `${name} · ${item.tooltip}` : name,
      clickable: typeof item.onClick === 'function'
    })
  }
  return out
}

function notify(): void {
  if (!changeCb) return
  changeCb({
    commands: buildCommandSnapshot(),
    themes: themeReg.size ? [...themeReg.values()].map((e) => e.def) : [],
    statusbar: buildStatusEntries()
  })
}

/** App 挂载时安装全局对象与依赖（单次） */
export function initPluginHost(d: PluginHostDeps): void {
  if (deps) return
  deps = d
  const g: TermManagerGlobal = { version: '1', init: initPlugin }
  ;(window as unknown as { termManager?: TermManagerGlobal }).termManager = g
}

/** App 注册快照消费者（命令/主题/状态栏变化时重渲染） */
export function onHostChange(cb: (s: HostSnapshot) => void): void {
  changeCb = cb
}

/**
 * 消费一次 plugins:list：新出现的 entry 插件注入脚本（幂等），消失的插件
 * 摘除全部注册物。注入是 module 脚本，onerror 只记录——脚本失败不影响该插件
 * 的声明式贡献（profiles/manifest 命令/主题包）与兄弟插件
 */
export function loadCodePlugins(infos: PluginInfo[]): void {
  const present = new Set<string>()
  for (const info of infos) {
    present.add(info.id)
    if (!info.entry) continue
    knownIds.add(info.id)
    pluginMeta.set(info.id, { name: info.name, version: info.version })
    const key = `${info.id}@${info.version ?? ''}`
    if (loaded.has(key)) continue
    loaded.add(key)
    const s = document.createElement('script')
    s.type = 'module'
    s.src = `tmplug://${info.id}/${info.entry}`
    s.onerror = () => console.error(`[plugin-host] 插件 ${info.id} 脚本加载失败: ${s.src}`)
    document.head.appendChild(s)
  }
  for (const pid of [...scopedApis.keys()]) {
    if (!present.has(pid)) teardown(pid)
  }
}

function teardown(pid: string): void {
  scopedApis.delete(pid)
  pluginMeta.delete(pid)
  for (const [k, v] of [...cmdReg]) if (v.pluginId === pid) cmdReg.delete(k)
  for (const [k, v] of [...themeReg]) if (v.pluginId === pid) themeReg.delete(k)
  for (const [k, v] of [...statusReg]) if (v.pluginId === pid) statusReg.delete(k)
  for (const [ev, list] of [...eventReg]) {
    const next = list.filter((e) => e.pluginId !== pid)
    if (next.length !== list.length) eventReg.set(ev, next)
  }
  for (const [id, subs] of [...dataReg]) {
    const next = subs.filter((s) => s.pluginId !== pid)
    if (next.length === subs.length) continue
    if (next.length) dataReg.set(id, next)
    else dataReg.delete(id)
  }
  notify()
}

function initPlugin(id: unknown): TmScopedApi {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new Error('termManager.init: 插件 id 必须是 [a-z0-9-]{1,64}')
  }
  const existing = scopedApis.get(id)
  if (existing) return existing // 幂等：脚本不会重跑，重复 init 返回同一对象
  if (!knownIds.has(id)) {
    throw new Error(`termManager.init: 未知插件 id '${id}'（不在 plugins 目录或无 entry）`)
  }
  const meta = pluginMeta.get(id) ?? { name: id }
  const scoped: TmScopedApi = {
    version: '1',
    info: { id, name: meta.name, version: meta.version },
    registerCommand: (def) => {
      if (!deps || !def || typeof def !== 'object') return false
      if (typeof def.id !== 'string' || !LOCAL_ID_RE.test(def.id)) return false
      if (typeof def.label !== 'string' || !def.label.trim()) return false
      if (typeof def.run !== 'function') return false
      const key = `code:${id}:${def.id}`
      if (!cmdReg.has(key) && countOwned(cmdReg.values(), id) >= MAX_CMDS_PER_PLUGIN) return false
      const clean: TmRuntimeCommandDef = {
        id: def.id,
        label: def.label.trim().slice(0, 120),
        run: def.run
      }
      if (typeof def.keywords === 'string' && def.keywords.trim()) clean.keywords = def.keywords.slice(0, 200)
      if (typeof def.hint === 'string' && def.hint.trim()) clean.hint = def.hint.slice(0, 80)
      cmdReg.set(key, { pluginId: id, def: clean })
      notify()
      return true
    },
    unregisterCommand: (cid) => {
      if (typeof cid !== 'string') return
      if (cmdReg.delete(`code:${id}:${cid}`)) notify()
    },
    registerTheme: (theme) => {
      if (!deps || !theme || typeof theme !== 'object') return false
      if (typeof theme.id !== 'string' || !LOCAL_ID_RE.test(theme.id)) return false
      const cleaned = sanitizeTheme(theme, `plugin:${id}:${theme.id}`)
      if (!cleaned) return false
      const tid = `${id}/${theme.id}`
      if (!themeReg.has(tid) && countOwned(themeReg.values(), id) >= MAX_THEMES_PER_PLUGIN) return false
      themeReg.set(tid, { pluginId: id, def: { ...cleaned, id: tid, builtin: false } })
      notify()
      return true
    },
    unregisterTheme: (localId) => {
      if (typeof localId !== 'string') return
      if (themeReg.delete(`${id}/${localId}`)) notify()
    },
    on: (event, cb) => {
      if (!EVENT_NAMES.has(event) || typeof cb !== 'function') return () => undefined
      let total = 0
      for (const list of eventReg.values()) total += countOwned(list, id)
      if (total >= MAX_EVENT_LISTENERS_PER_PLUGIN) return () => undefined
      const entry: EventSub = { pluginId: id, cb: cb as unknown as (payload: unknown) => void }
      const list = eventReg.get(event) ?? []
      list.push(entry)
      eventReg.set(event, list)
      return () => {
        const cur = eventReg.get(event)
        if (!cur) return
        const i = cur.indexOf(entry)
        if (i >= 0) cur.splice(i, 1)
      }
    },
    tabs: {
      list: () => (deps ? deps.getTabs().map((t) => ({ ...t })) : []),
      active: () => deps?.getActiveId() || undefined,
      activate: (tabId) => {
        if (typeof tabId === 'string' && deps?.getTabs().some((t) => t.id === tabId)) {
          deps.activateTab(tabId)
        }
      },
      create: (profileId, cwd) => {
        if (!deps) return Promise.resolve(undefined)
        if (profileId !== undefined && typeof profileId !== 'string') {
          return Promise.resolve(undefined)
        }
        if (cwd !== undefined && typeof cwd !== 'string') return Promise.resolve(undefined)
        return deps.newTab(profileId, cwd)
      }
    },
    ui: {
      setTheme: (mode) => {
        if (!deps) return
        if (mode === 'dark' || mode === 'light' || mode === 'system') {
          deps.applySettings({ theme: mode as ThemeOption })
        }
      },
      setScheme: (sid) => {
        if (!deps || typeof sid !== 'string') return
        const def = deps.getThemeDefs().find((t) => t.id === sid)
        if (!def) return
        deps.applySettings(def.type === 'dark' ? { darkTheme: def.id } : { lightTheme: def.id })
      },
      toggleSidebar: () => {
        if (deps) deps.applySettings({ sidebarVisible: !deps.getSettings().sidebarVisible })
      },
      openSettings: () => deps?.openSettings()
    },
    terminals: {
      subscribe: (termId, cb) => {
        if (typeof termId !== 'string' || typeof cb !== 'function') return () => undefined
        let total = 0
        for (const subs of dataReg.values()) total += countOwned(subs, id)
        if (total >= MAX_DATA_SUBS_PER_PLUGIN) return () => undefined
        const entry: DataSub = { pluginId: id, cb }
        const subs = dataReg.get(termId) ?? []
        subs.push(entry)
        dataReg.set(termId, subs)
        return () => {
          const cur = dataReg.get(termId)
          if (!cur) return
          const i = cur.indexOf(entry)
          if (i >= 0) cur.splice(i, 1)
          if (!cur.length) dataReg.delete(termId)
        }
      },
      write: (termId, data) => {
        if (!deps || typeof termId !== 'string' || typeof data !== 'string' || !data) return
        if (data.length > MAX_WRITE_CHUNK) return
        // 只允许向当前存在的标签写入，防注册物残留期向幽灵 id 灌数据
        if (!deps.getTabs().some((t) => t.id === termId)) return
        deps.writeInput(termId, data)
      }
    },
    statusbar: {
      setItem: (itemId, item) => {
        if (typeof itemId !== 'string' || !LOCAL_ID_RE.test(itemId)) return
        const key = `${id}:${itemId}`
        if (item === null || item === undefined) {
          if (statusReg.delete(key)) notify()
          return
        }
        if (typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) return
        const clean: TmStatusItem = { text: item.text.slice(0, 200) }
        if (typeof item.color === 'string' && validColor(item.color)) clean.color = item.color
        if (typeof item.tooltip === 'string' && item.tooltip.trim()) clean.tooltip = item.tooltip.slice(0, 200)
        if (typeof item.onClick === 'function') clean.onClick = item.onClick
        if (!statusReg.has(key) && countOwned(statusReg.values(), id) >= MAX_STATUS_PER_PLUGIN) return
        statusReg.set(key, { pluginId: id, itemId, item: clean })
        notify()
      }
    }
  }
  scopedApis.set(id, scoped)
  return scoped
}

/** App 在标签生命周期/设置变化处调用：向插件扇出事件（每监听器隔离异常） */
export function emitTmEvent(event: TmPluginEventName, payload: unknown): void {
  const list = eventReg.get(event)
  if (!list?.length) return
  for (const { pluginId, cb } of [...list]) {
    try {
      cb(payload)
    } catch (e) {
      console.error(`[plugin-host] 插件 ${pluginId} 的 ${event} 监听器抛错:`, e)
    }
  }
}

/** App 的 term:data 通路挂一层 tap：无订阅时零开销 */
export function dispatchTermData(id: string, data: string): void {
  const subs = dataReg.get(id)
  if (!subs?.length) return
  for (const { pluginId, cb } of [...subs]) {
    try {
      cb(data)
    } catch (e) {
      console.error(`[plugin-host] 插件 ${pluginId} 的数据订阅抛错:`, e)
    }
  }
}

/** 状态栏项点击：执行插件回调（App 在点击后自行归还终端焦点） */
export function clickStatusItem(key: string): void {
  const e = statusReg.get(key)
  if (e?.item.onClick) {
    try {
      e.item.onClick()
    } catch (err) {
      console.error(`[plugin-host] 状态栏项 ${key} 点击回调抛错:`, err)
    }
  }
}

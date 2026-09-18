// 代码级插件宿主（L3 Tier 2）：manifest 带 entry 的插件各自跑在一个
// sandbox iframe 里（tmplug://<id>/__tmplug_host__ 合成页，每插件独立 origin），
// 与应用页面跨源隔离——插件碰不到宿主 DOM 与 window.api，唯一通道是本模块
// 挂的 postMessage RPC 桥（方法表封闭，见 buildImpls）。帧内桥实现
// （主进程合成下发）暴露 window.termManager，API 形状与 Tier 1 相同，
// 带返回值的方法异步化。本模块持有全部注册表（命令/主题/状态栏/事件与
// 数据订阅），App 消费快照渲染；跨桥的永远只有数据与 token，回调函数
// 留在插件帧内。
//
// 安全模型（与 README「代码级插件」节一致）：浏览器沙箱 + 逐插件 CSP
//（默认零网络，manifest 声明且用户批准的 origin 才进 connect-src）+
// 声明式权限。卸载语义：插件目录被删（plugins:list 不再出现）→ 注册物
// 即时摘除且 iframe 移除（realm 一并销毁，Tier 2 起插件真正可卸载）；
// 版本号变更 → 重建 iframe 换新 realm 重新执行。

import type {
  AppSettings,
  PluginInfo,
  TermInfo,
  ThemeDef,
  ThemeOption,
  TmPluginEventName,
  TmRuntimeCommandDef,
  TmStatusItem,
  TmStatusbarEntry,
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

// 权限批准请求（App 渲染弹窗队列）
export interface PluginPermPrompt {
  id: string
  name: string
  hosts: string[]
}

// 防病态插件：单插件注册物上限（与主进程 manifest caps 同文化）
const MAX_CMDS_PER_PLUGIN = 50
const MAX_THEMES_PER_PLUGIN = 20
const MAX_STATUS_PER_PLUGIN = 8
const MAX_EVENT_LISTENERS_PER_PLUGIN = 64
const MAX_DATA_SUBS_PER_PLUGIN = 32
const MAX_WRITE_CHUNK = 16_384

const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const EVENT_NAMES = new Set<string>([
  'tab-created',
  'tab-closed',
  'tab-activated',
  'tab-renamed',
  'theme-changed',
  'scheme-changed',
])

// ── 帧桥消息形态（帧 → 宿主）──
interface TmFrameCall {
  __tmplug: 1
  kind: 'call'
  id: number
  method: string
  args: unknown[]
}
interface TmFrameLog {
  __tmplug: 1
  kind: 'log'
  level: string
  message: string
}
type TmFrameMsg = TmFrameCall | TmFrameLog

// 宿主 → 帧的消息（reply/event/data/invoke）在 post 处内联构造，不单独建模

interface FrameEntry {
  id: string
  version: string
  frame: HTMLIFrameElement
  /** 帧的 origin（`tmplug://<id>`），回执与推送的 targetOrigin */
  origin: string
  impls: Record<string, (...args: unknown[]) => unknown>
}

let deps: PluginHostDeps | null = null
let changeCb: ((s: HostSnapshot) => void) | null = null
let msgListenerInstalled = false
let container: HTMLDivElement | null = null
const pluginMeta = new Map<string, { name: string; version?: string }>()
// 已挂载的插件 iframe（id → 帧）；版本号记在 entry 里，变更即重建换 realm
const frames = new Map<string, FrameEntry>()
// 等待权限决策的插件（id → 建 frame 所需信息）：决策落盘后由
// permissionDecided() 补挂；插件消失则一并清掉
const pendingFrames = new Map<string, { entry: string; version: string }>()

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
  /** 帧内回调的 token 引用（跨桥标识，回调本体留在插件帧里） */
  token: number
  cb: (payload: unknown) => void
}
const eventReg = new Map<TmPluginEventName, EventSub[]>()

interface DataSub {
  pluginId: string
  token: number
  cb: (data: string) => void
}
const dataReg = new Map<string, DataSub[]>() // key = 标签 id

function countOwned<T extends { pluginId: string }>(m: Iterable<T>, pid: string): number {
  let n = 0
  for (const e of m) if (e.pluginId === pid) n++
  return n
}

/** 向插件帧推消息（帧可能已被重建/移除，届时静默丢弃） */
function postTo(id: string, msg: unknown): void {
  const f = frames.get(id)
  f?.frame.contentWindow?.postMessage(msg, f.origin)
}

function replyTo(src: MessageEventSource | null, origin: string, rid: number, ok: boolean, payload: unknown): void {
  if (!src) return
  const msg = { __tmplug: 1, kind: 'reply', id: rid, ok } as Record<string, unknown>
  if (ok) msg.result = payload === undefined ? null : payload
  else msg.error = String(payload)
  // MessageEventSource 是联合类型，这里只可能是 Window（帧的 contentWindow）
  ;(src as Window).postMessage(msg, origin)
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

function validToken(t: unknown): t is number {
  return typeof t === 'number' && Number.isInteger(t) && t > 0 && t <= 0x7fffffff
}

/**
 * 某插件帧的方法表（RPC 服务端）：帧桥发来的 method 名在此封闭集合内分发，
 * 不经任何 eval。args 已是跨桥数据（函数字段被帧桥剥掉，回调改为 token 引用，
 * 这里重建为向帧推送 invoke/event/data 的桩）
 */
function buildImpls(id: string): Record<string, (...args: unknown[]) => unknown> {
  return {
    registerCommand: (w) => {
      if (!deps || typeof w !== 'object' || w === null) return false
      const r = w as Record<string, unknown>
      if (typeof r.id !== 'string' || !LOCAL_ID_RE.test(r.id)) return false
      if (typeof r.label !== 'string' || !r.label.trim()) return false
      if (r.hasRun !== true) return false // 回调留在帧内，这里只认 hasRun 标记
      const cmdId = r.id
      const key = `code:${id}:${cmdId}`
      if (!cmdReg.has(key) && countOwned(cmdReg.values(), id) >= MAX_CMDS_PER_PLUGIN) return false
      const clean: TmRuntimeCommandDef = {
        id: cmdId,
        label: r.label.trim().slice(0, 120),
        run: () => postTo(id, { __tmplug: 1, kind: 'invoke', what: 'command', cmdId })
      }
      if (typeof r.keywords === 'string' && r.keywords.trim()) clean.keywords = r.keywords.slice(0, 200)
      if (typeof r.hint === 'string' && r.hint.trim()) clean.hint = r.hint.slice(0, 80)
      cmdReg.set(key, { pluginId: id, def: clean })
      notify()
      return true
    },
    unregisterCommand: (cid) => {
      if (typeof cid !== 'string') return
      if (cmdReg.delete(`code:${id}:${cid}`)) notify()
    },
    registerTheme: (t) => {
      if (!deps || typeof t !== 'object' || t === null) return false
      const cleaned = sanitizeTheme(t, `plugin:${id}:dyn`)
      if (!cleaned || typeof (t as { id?: unknown }).id !== 'string' || !LOCAL_ID_RE.test((t as { id: string }).id)) {
        return false
      }
      const localId = (t as { id: string }).id
      const tid = `${id}/${localId}`
      if (!themeReg.has(tid) && countOwned(themeReg.values(), id) >= MAX_THEMES_PER_PLUGIN) return false
      themeReg.set(tid, { pluginId: id, def: { ...cleaned, id: tid, builtin: false } })
      notify()
      return true
    },
    unregisterTheme: (localId) => {
      if (typeof localId !== 'string') return
      if (themeReg.delete(`${id}/${localId}`)) notify()
    },
    on: (ev, token) => {
      if (!EVENT_NAMES.has(String(ev)) || !validToken(token)) return
      if (countOwnedEventSubs(id) >= MAX_EVENT_LISTENERS_PER_PLUGIN) return
      const event = ev as TmPluginEventName
      const entry: EventSub = {
        pluginId: id,
        token,
        cb: (payload) => postTo(id, { __tmplug: 1, kind: 'event', event, payload })
      }
      const list = eventReg.get(event) ?? []
      list.push(entry)
      eventReg.set(event, list)
    },
    off: (token) => {
      if (!validToken(token)) return
      for (const [ev, list] of [...eventReg]) {
        const next = list.filter((e) => !(e.pluginId === id && e.token === token))
        if (next.length !== list.length) eventReg.set(ev, next)
      }
    },
    sub: (termId, token) => {
      if (typeof termId !== 'string' || !validToken(token)) return
      if (countOwnedDataSubs(id) >= MAX_DATA_SUBS_PER_PLUGIN) return
      const entry: DataSub = {
        pluginId: id,
        token,
        cb: (data) => postTo(id, { __tmplug: 1, kind: 'data', termId, data })
      }
      const subs = dataReg.get(termId) ?? []
      subs.push(entry)
      dataReg.set(termId, subs)
    },
    unsub: (token) => {
      if (!validToken(token)) return
      for (const [tid, subs] of [...dataReg]) {
        const next = subs.filter((s) => !(s.pluginId === id && s.token === token))
        if (next.length === subs.length) continue
        if (next.length) dataReg.set(tid, next)
        else dataReg.delete(tid)
      }
    },
    'tabs.list': () => (deps ? deps.getTabs().map((t) => ({ ...t })) : []),
    'tabs.active': () => deps?.getActiveId() || undefined,
    'tabs.activate': (tabId) => {
      if (typeof tabId === 'string' && deps?.getTabs().some((t) => t.id === tabId)) {
        deps.activateTab(tabId)
      }
    },
    'tabs.create': (profileId, cwd) => {
      if (!deps) return Promise.resolve(undefined)
      if (profileId !== undefined && typeof profileId !== 'string') {
        return Promise.resolve(undefined)
      }
      if (cwd !== undefined && typeof cwd !== 'string') return Promise.resolve(undefined)
      return deps.newTab(profileId, cwd)
    },
    'ui.setTheme': (mode) => {
      if (!deps) return
      if (mode === 'dark' || mode === 'light' || mode === 'system') {
        deps.applySettings({ theme: mode as ThemeOption })
      }
    },
    'ui.setScheme': (sid) => {
      if (!deps || typeof sid !== 'string') return
      const def = deps.getThemeDefs().find((t) => t.id === sid)
      if (!def) return
      deps.applySettings(def.type === 'dark' ? { darkTheme: def.id } : { lightTheme: def.id })
    },
    'ui.toggleSidebar': () => {
      if (deps) deps.applySettings({ sidebarVisible: !deps.getSettings().sidebarVisible })
    },
    'ui.openSettings': () => deps?.openSettings(),
    'terminals.write': (termId, data) => {
      if (!deps || typeof termId !== 'string' || typeof data !== 'string' || !data) return
      if (data.length > MAX_WRITE_CHUNK) return
      // 只允许向当前存在的标签写入，防注册物残留期向幽灵 id 灌数据
      if (!deps.getTabs().some((t) => t.id === termId)) return
      deps.writeInput(termId, data)
    },
    'statusbar.setItem': (itemId, wire) => {
      if (typeof itemId !== 'string' || !LOCAL_ID_RE.test(itemId)) return
      const key = `${id}:${itemId}`
      if (wire === null || wire === undefined) {
        if (statusReg.delete(key)) notify()
        return
      }
      if (typeof wire !== 'object' || wire === null) return
      const r = wire as Record<string, unknown>
      if (typeof r.text !== 'string' || !r.text.trim()) return
      const clean: TmStatusItem = { text: r.text.slice(0, 200) }
      if (typeof r.color === 'string' && validColor(r.color)) clean.color = r.color
      if (typeof r.tooltip === 'string' && r.tooltip.trim()) clean.tooltip = r.tooltip.slice(0, 200)
      if (r.hasClick === true) {
        clean.onClick = () => postTo(id, { __tmplug: 1, kind: 'invoke', what: 'status', itemId })
      }
      if (!statusReg.has(key) && countOwned(statusReg.values(), id) >= MAX_STATUS_PER_PLUGIN) return
      statusReg.set(key, { pluginId: id, itemId, item: clean })
      notify()
    }
  }
}

function countOwnedEventSubs(pid: string): number {
  let n = 0
  for (const list of eventReg.values()) n += countOwned(list, pid)
  return n
}

function countOwnedDataSubs(pid: string): number {
  let n = 0
  for (const subs of dataReg.values()) n += countOwned(subs, pid)
  return n
}

/** App 挂载时安装依赖与帧桥消息监听（单次；不再向宿主 window 注入任何全局对象） */
export function initPluginHost(d: PluginHostDeps): void {
  if (deps) return
  deps = d
  if (!msgListenerInstalled) {
    msgListenerInstalled = true
    window.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data as TmFrameMsg | null
      if (!d || typeof d !== 'object' || (d as { __tmplug?: number }).__tmplug !== 1) return
      // 来源甄别：只认自家管理的 iframe（event.source 比对），origin 再核一遍
      let entry: FrameEntry | undefined
      for (const f of frames.values()) {
        if (f.frame.contentWindow === ev.source) {
          entry = f
          break
        }
      }
      if (!entry || ev.origin !== entry.origin) return
      if (d.kind === 'log') {
        // 插件帧的异常回传（帧 console 渲染层默认看不到）
        console.error(`[plugin-host] 插件 ${entry.id} 帧内错误:`, d.message)
        return
      }
      if (d.kind !== 'call' || typeof d.method !== 'string') return
      const impl = entry.impls[d.method]
      const src = ev.source
      if (typeof impl !== 'function') {
        replyTo(src, entry.origin, d.id, false, `unknown method: ${d.method}`)
        return
      }
      let result: unknown
      try {
        result = impl(...(Array.isArray(d.args) ? d.args : []))
      } catch (e) {
        replyTo(src, entry.origin, d.id, false, e)
        return
      }
      // impl 可能返回 Promise（tabs.create）：统一落定后回执；帧已重建时回执
      // 发往旧 contentWindow 会被浏览器丢弃，插件侧有 15s 超时兜底
      Promise.resolve(result).then(
        (r) => replyTo(src, entry.origin, d.id, true, r),
        (e) => replyTo(src, entry.origin, d.id, false, e)
      )
    })
  }
}

/** App 注册快照消费者（命令/主题/状态栏变化时重渲染） */
export function onHostChange(cb: (s: HostSnapshot) => void): void {
  changeCb = cb
}

/** 隐藏容器：0 尺寸零视觉足迹，脚本正常执行（不用 display:none，避开定时器
    节流的边缘行为差异） */
function ensureContainer(): void {
  if (container) return
  container = document.createElement('div')
  container.className = 'plugin-frames'
  container.setAttribute('aria-hidden', 'true')
  document.body.appendChild(container)
}

function createFrame(id: string, entry: string, version: string): void {
  if (frames.has(id)) return
  ensureContainer()
  const frame = document.createElement('iframe')
  // allow-same-origin：tmplug://<id> 是每插件独立 origin（与应用页面跨源），
  // 放行只为让插件拿到自己 origin 的存储与规范的 event.origin；沙箱逃逸
  // 风险面在"帧与嵌入者同源"场景，这里构造上就不成立
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('title', `plugin:${id}`)
  frame.src = `tmplug://${id}/__tmplug_host__?entry=${encodeURIComponent(entry)}`
  container!.appendChild(frame)
  frames.set(id, { id, version, frame, origin: `tmplug://${id}`, impls: buildImpls(id) })
}

function removeFrame(id: string): void {
  const f = frames.get(id)
  if (!f) return
  frames.delete(id)
  f.frame.remove()
}

/**
 * 消费一次 plugins:list：新出现的 entry 插件挂 iframe，消失的摘除注册物
 * 并销毁 realm；版本号变更 → 重建 iframe 重新执行。声明了网络权限但还没
 * 决策的插件先入挂起队列，返回待批准列表（App 弹窗，决策后调
 * permissionDecided 补挂）。帧加载失败（entry 语法错误等）只影响该插件
 * 自己的声明式贡献不受波及
 */
export function loadCodePlugins(infos: PluginInfo[]): PluginPermPrompt[] {
  const prompts: PluginPermPrompt[] = []
  const present = new Set<string>()
  for (const info of infos) {
    present.add(info.id)
    // 禁用（管理 UI）：已有帧/挂起一律拆除（语义等价卸载），也不产生权限
    // 弹窗——重新启用后按正常流程走（未决策会再弹）
    if (info.disabled) {
      if (frames.has(info.id)) {
        removeFrame(info.id)
        teardown(info.id)
      }
      pendingFrames.delete(info.id)
      continue
    }
    if (!info.entry) continue
    const version = info.version ?? ''
    // 未决策（首次加载，或管理 UI「重新询问」清除了决策）：不允许存在运行中的
    // 帧——已挂的先拆（旧帧 CSP 基于已被清除的授权，语义失效），决策落盘后由
    // permissionDecided 以新 CSP 重建
    if (info.permDecision && !info.permDecision.decided) {
      if (frames.has(info.id)) {
        removeFrame(info.id)
        teardown(info.id)
      }
      pluginMeta.set(info.id, { name: info.name, version: info.version })
      if (!pendingFrames.has(info.id)) {
        pendingFrames.set(info.id, { entry: info.entry, version })
        prompts.push({ id: info.id, name: info.name, hosts: info.permDecision.hosts })
      }
      continue
    }
    pluginMeta.set(info.id, { name: info.name, version: info.version })
    // 挂起期间决策被补挂过（或残留）：先清挂起态
    if (frames.has(info.id) && pendingFrames.has(info.id)) pendingFrames.delete(info.id)
    const existing = frames.get(info.id)
    if (existing && existing.version === version) continue
    if (existing) {
      removeFrame(info.id)
      teardown(info.id)
    }
    createFrame(info.id, info.entry, version)
  }
  for (const id of [...frames.keys(), ...pendingFrames.keys()]) {
    if (present.has(id)) continue
    if (frames.has(id)) {
      removeFrame(id)
      teardown(id)
    }
    pendingFrames.delete(id)
  }
  return prompts
}

/** 权限批准/拒绝落盘后由 App 调用：补挂等待中的插件帧 */
export function permissionDecided(id: string): void {
  const p = pendingFrames.get(id)
  pendingFrames.delete(id)
  if (!p || !pluginMeta.has(id)) return
  createFrame(id, p.entry, p.version)
}

function teardown(pid: string): void {
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

/** App 在标签生命周期/设置变化处调用：向插件帧扇出事件（桩内推消息，天然
    隔离异常——帧侧桥再向插件回调 try/catch） */
export function emitTmEvent(event: TmPluginEventName, payload: unknown): void {
  const list = eventReg.get(event)
  if (!list?.length) return
  for (const e of [...list]) {
    try {
      e.cb(payload)
    } catch (err) {
      console.error(`[plugin-host] 插件 ${e.pluginId} 的 ${event} 推送失败:`, err)
    }
  }
}

/** App 的 term:data 通路挂一层 tap：无订阅时零开销 */
export function dispatchTermData(id: string, data: string): void {
  const subs = dataReg.get(id)
  if (!subs?.length) return
  for (const s of [...subs]) {
    try {
      s.cb(data)
    } catch (err) {
      console.error(`[plugin-host] 插件 ${s.pluginId} 的数据推送失败:`, err)
    }
  }
}

/** 状态栏项点击：向插件帧推 invoke（App 在点击后自行归还终端焦点） */
export function clickStatusItem(key: string): void {
  const e = statusReg.get(key)
  if (e?.item.onClick) {
    try {
      e.item.onClick()
    } catch (err) {
      console.error(`[plugin-host] 状态栏项 ${key} 点击推送失败:`, err)
    }
  }
}

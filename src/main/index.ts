import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { execFile } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { createServer, type Server } from 'http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { ProfileRegistry } from './profiles'
import { SettingsStore, listMonospaceFonts } from './settings'
import { SessionStore } from './session'
import { ThemeRegistry } from './themes'
import { PluginRegistry, validEntryPath } from './plugins'
import { PluginPermStore } from './pluginPerms'
import { PluginStateStore } from './pluginState'
import { BRIDGE_BODY } from './tmplugBridge'
import { TmuxBackend, sweepStaleServers, type TermInfo } from './tmux'
import type { SessionTab, TabGroup } from '../shared/types'

const registry = new ProfileRegistry()
const settingsStore = new SettingsStore()
const sessionStore = new SessionStore()
const themes = new ThemeRegistry()
// 权限决策存储先建（list() 要附决策状态），whenReady 里 load
const pluginPerms = new PluginPermStore()
// 管理 UI 的禁用态存储（list() 的贡献过滤收口在这里）
const pluginState = new PluginStateStore()
const plugins = new PluginRegistry(pluginPerms, pluginState)
// hub：主进程内分发终端事件（基准测试监听），同时转发给渲染进程
const hub = new EventEmitter()
hub.setMaxListeners(200)
const backend = new TmuxBackend((channel, ...args) => {
  hub.emit(channel, ...args)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
})

let mainWindow: BrowserWindow | null = null

// 外部目录请求（CLI --open-dir= / 第二次启动）的排队区：
// 渲染层 cli:ready 之前先入队，之后就绪后直接推送，避免事件丢失
const pendingOpenDirs: string[] = []
let rendererReady = false

// ── tmplug://：代码级插件（L3）的资源协议 ──
// tmplug://<pluginId>/<相对路径> → 插件目录内白名单类型文件。standard 使 URL
// 规范解析、每插件独立 origin（Tier 2 沙箱 iframe 的隔离地基）；corsEnabled
// 使 scheme 可作 CORS 请求目标——module 脚本（<script type="module">）的取数
// 一律按 CORS 模式走，file:// 页面加载 tmplug:// 即跨源，没有该特权时浏览器
// 直接判模块加载失败（响应头 ACAO 也无济于事）。scheme 注册必须早于 app
// ready（故在模块顶层），handle 在 whenReady 挂
protocol.registerSchemesAsPrivileged([
  { scheme: 'tmplug', privileges: { standard: true, corsEnabled: true } }
])

const TMPLUG_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

// Tier 2 合成资源（不走磁盘）：保留路径名以 __ 开头且（宿主页）无扩展名，
// 永远不与插件文件白名单（按扩展名放行 .js/.mjs/…）冲突——插件目录里同名
// 文件被这两个保留名遮蔽，属可接受的行为面
const TMPLUG_HOST_PATH = '__tmplug_host__'
const TMPLUG_BRIDGE_PATH = '__tmplug_bridge__.js'

/** 插件帧的逐插件 CSP：默认零网络，connect-src 仅含已授权 ∩ 已声明 */
function pluginFrameCsp(id: string): string {
  const granted = pluginPerms.effectiveConnect(id, plugins.declaredConnect(id))
  return [
    "default-src 'none'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${granted.length ? granted.join(' ') : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * 合成宿主页 tmplug://<id>/__tmplug_host__?entry=<相对路径>：沙箱 iframe 的
 * 文档本体。CSP 逐插件合成（见 pluginFrameCsp），帧桥与插件 entry 以同源
 * 资源引用加载（script-src 'self' 即覆盖，无需 unsafe-inline）。entry 经
 * validEntryPath 复核——渲染层只传来字符串，协议侧与 manifest 侧同口径
 */
function servePluginHostPage(u: URL, dir: string, id: string): Response {
  const entry = u.searchParams.get('entry') ?? ''
  if (!entry || !validEntryPath(dir, entry)) {
    return new Response('bad entry', { status: 400 })
  }
  const html =
    '<!doctype html>\n' +
    '<html><head><meta charset="utf-8"><title>plugin:' + id + '</title>\n' +
    '<meta http-equiv="Content-Security-Policy" content="' + pluginFrameCsp(id) + '">\n' +
    '</head><body>\n' +
    '<script src="/' + TMPLUG_BRIDGE_PATH + '"></script>\n' +
    '<script type="module" src="/' + entry + '"></script>\n' +
    '</body></html>'
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
  })
}

/** 帧桥 tmplug://<id>/__tmplug_bridge__.js：插件元信息内嵌 + 桥实现（见 tmplugBridge.ts） */
function servePluginBridge(id: string): Response {
  const meta = plugins.getMeta(id)
  if (!meta) return new Response('unknown plugin', { status: 404 })
  const js = 'window.__TMPLUG_META__ = ' + JSON.stringify({ id, name: meta.name, version: meta.version }) + ';\n' + BRIDGE_BODY
  return new Response(js, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }
  })
}

/**
 * tmplug:// 处理器。id → 目录的解析以 PluginRegistry 为唯一权威（重复 id 先到
 * 先得，同 id 的影子目录无从越权）；相对路径解码后拒 .. 段，resolve 后必须
 * 仍在插件目录内（双保险）；扩展名白名单外一律 403。渲染层只拿得到 id 与
 * entry 相对路径，绝对路径不出主进程
 */
function registerTmplugProtocol(): void {
  protocol.handle('tmplug', (request) => {
    try {
      const u = new URL(request.url)
      if (!/^[a-z0-9-]{1,64}$/.test(u.hostname)) {
        return new Response('bad plugin id', { status: 400 })
      }
      const dir = plugins.getDir(u.hostname)
      if (!dir) return new Response('unknown plugin', { status: 404 })
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
      // Tier 2 合成资源优先（保留名，永远到不了磁盘查询）
      if (rel === TMPLUG_HOST_PATH) return servePluginHostPage(u, dir, u.hostname)
      if (rel === TMPLUG_BRIDGE_PATH) return servePluginBridge(u.hostname)
      if (!rel || rel.split('/').includes('..')) {
        return new Response('bad path', { status: 400 })
      }
      const abs = resolve(dir, rel)
      if (!abs.startsWith(dir + sep)) return new Response('forbidden', { status: 403 })
      const mime = TMPLUG_MIME[extname(abs).toLowerCase()]
      if (!mime) return new Response('unsupported type', { status: 403 })
      // module 脚本（<script type="module">）一律按 CORS 模式取数：tmplug:// 是
      // 每插件独立 origin，file:// 页面加载即跨源，无 ACAO 头会被浏览器拒掉
      return readFile(abs).then(
        (data) =>
          new Response(new Uint8Array(data), {
            headers: {
              'content-type': mime,
              'cache-control': 'no-cache',
              'access-control-allow-origin': '*'
            }
          }),
        () => new Response('not found', { status: 404 })
      )
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
}

/** 校验外部传入的目录：必须是已存在的本地目录，否则无效（回退 profile.cwd/homedir） */
function existingDir(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p || /[\r\n]/.test(p)) return undefined
  const abs = resolve(p)
  try {
    return statSync(abs).isDirectory() ? abs : undefined
  } catch {
    return undefined
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const win = mainWindow
  if (win.isMinimized()) win.restore()
  if (win.webContents.isLoading()) {
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
  } else {
    win.show()
    win.focus()
  }
}

// Linux(X11) 原生标题栏的深浅由 mutter 按客户窗口的 _GTK_THEME_VARIANT 属性绘制，
// Electron 只在创建窗口时（darkTheme）写它，运行中切主题装饰不会跟随；
// 实测 mutter 对该属性热生效，这里在主题变化时用 xprop 补写。
// xprop 缺失 / Wayland 等场景静默跳过，标题栏退化为随下次启动生效
function syncTitleBarVariant(win: BrowserWindow, dark: boolean): void {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return
  try {
    const xid = win.getNativeWindowHandle().readUInt32LE(0)
    execFile(
      'xprop',
      ['-id', String(xid), '-f', '_GTK_THEME_VARIANT', '8u', '-set', '_GTK_THEME_VARIANT', dark ? 'dark' : 'light'],
      () => undefined
    )
  } catch {
    // 句柄不可用时放弃，装饰随下次启动
  }
}

function enqueueOpenDir(raw: string | undefined): void {
  const dir = existingDir(raw)
  if (!dir) return
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cli:open-dir', dir)
  } else {
    pendingOpenDirs.push(dir)
  }
}

// 外链统一出口：只放行网页协议交给系统浏览器；file:// 等其他 scheme 交给
// 外部处理器没有收益只有面（终端里的 URL 点击与 window.open 走同一白名单）
function openExternalHttp(raw: string): void {
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.href)
  } catch {
    // 非法 URL：静默拒绝
  }
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: dark ? '#1e1e2e' : '#eff1f5',
    darkTheme: dark, // Linux 原生标题栏随深浅主题，避免亮暗错配（创建时定死，随 themeSource 走）
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 沙箱可用：preload 只用 contextBridge/ipcRenderer（沙箱化 preload 均支持），
      // 没有理由放着 OS 级隔离不用
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))
  // 有效深浅变化（设置切换或系统深浅切换）时同步标题栏装饰
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      syncTitleBarVariant(mainWindow, nativeTheme.shouldUseDarkColors)
    }
  })
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (process.env.E2E_DEBUG) console.log('[renderer]', message)
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalHttp(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let inputEventsAtMain = 0

// ── 会话保持：渲染层最后上报的 UI 态（标签顺序/固定/分组/改名/活跃），主进程
// 与后端 windowId 对账后落盘 sessions.json。isolatedRun（smoke/e2e）不读写，
// 避免测试进程污染真实会话 ──
interface SyncedUiState {
  tabs: Array<{
    id: string
    profileId: string
    title: string
    color?: string
    pinned?: boolean
    groupId?: string
    renamed?: boolean
  }>
  groups: TabGroup[]
  activeId: string
}
let lastSync: SyncedUiState | null = null
// 附着恢复的标签（backend.start 的返回值），渲染层启动时经 session:restore 拉取
let restoredTabs: TermInfo[] | null = null
// 后端就绪 promise：session:restore 必须等它（渲染层 load 与后端附着并行，
// 抢跑会拿到 null 误走裸启动）
let backendStarted: Promise<TermInfo[]> | null = null

/** 组装并落盘当前会话：标签顺序/UI 态取 lastSync（渲染层权威），窗口映射取后端
    实况；新建未及上报的标签以主进程侧 TermInfo 兜底追加，已死窗口剔除 */
function persistSession(): void {
  if (isolatedRun && !sessionE2E) return
  const desc = backend.describe()
  if (!desc) {
    sessionStore.clear()
    return
  }
  const winIds = backend.windowIds()
  const tabs: SessionTab[] = []
  const seen = new Set<string>()
  for (const t of lastSync?.tabs ?? []) {
    const w = winIds.get(t.id)
    if (!w) continue
    seen.add(t.id)
    tabs.push({ ...t, windowId: w })
  }
  for (const [id, w] of winIds) {
    if (seen.has(id)) continue
    const info = backend.tabInfo(id)
    if (info) tabs.push({ ...info, windowId: w })
  }
  if (tabs.length === 0) {
    sessionStore.clear()
    return
  }
  const groups = (lastSync?.groups ?? []).filter((g) => tabs.some((t) => t.groupId === g.id))
  const sync = lastSync
  const activeId = sync && tabs.some((t) => t.id === sync.activeId) ? sync.activeId : tabs[0]!.id
  sessionStore.update({ ...desc, tabs, groups, activeId })
}

/** 终结退出（Ctrl+Shift+Q / 退出不保留）：杀会话、清记录、退出应用 */
function quitTerminating(): void {
  sessionStore.clear()
  void backend
    .dispose()
    .then(() => app.quit())
    .catch(() => app.quit())
}

function registerIpc(): void {
  // 每次列表都重探 PATH：渲染层在 ＋ 菜单/命令面板打开时拉取，
  // 运行中安装的 shell 无需重启立即可选（补齐/翻灰都由 registry.refresh 做）
  ipcMain.handle('profiles:list', () => {
    registry.refresh()
    return registry.list()
  })

  ipcMain.handle('settings:get', () => settingsStore.get())
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const prev = settingsStore.get().theme
    const next = settingsStore.set(patch)
    // 主题变化同步到 nativeTheme：渲染层 prefers-color-scheme（matchMedia）随之联动
    if (next.theme !== prev) nativeTheme.themeSource = next.theme
    return next
  })
  ipcMain.handle('settings:fonts', () => listMonospaceFonts())

  // 配色方案列表：每次调用重扫 themes 目录（设置页/面板打开时拉取，
  // 运行中新增的主题文件无需重启即可选）
  ipcMain.handle('themes:list', () => {
    themes.refresh()
    return themes.list()
  })

  // 声明式插件列表：每次调用重扫 plugins 目录（面板/菜单/设置页打开时拉取），
  // 附带 Tier 2 权限决策状态（entry 插件声明了 connect 才有）
  ipcMain.handle('plugins:list', () => {
    plugins.refresh()
    return plugins.list()
  })

  // Tier 2 权限批准落盘：origins=null 表示拒绝。授权列表夹在当前声明范围内
  //（渲染层只回传弹窗里展示的声明项，但 IPC 是信任边界，这里再夹一次）
  ipcMain.handle('plugins:grant-perm', (_e, id: unknown, origins: unknown) => {
    if (typeof id !== 'string') return
    const declared = plugins.declaredConnect(id)
    if (!declared.length) return
    if (origins === null) {
      pluginPerms.decide(id, declared, null)
      return
    }
    if (!Array.isArray(origins)) return
    const list = origins.filter((o): o is string => typeof o === 'string' && declared.includes(o))
    if (!list.length) return
    pluginPerms.decide(id, declared, list)
  })

  // 管理 UI：禁用开关（plugin-state.json 持久化，禁用即贡献清空+代码帧拆除）
  ipcMain.handle('plugins:set-enabled', (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return
    // 只对已扫描到的插件生效（不存在的 id 静默忽略，不落垃圾条目）
    if (!plugins.getDir(id)) return
    pluginState.setDisabled(id, !enabled)
  })

  // 管理 UI：清除权限决策（「重新询问」），下次扫描重新弹批准框
  ipcMain.handle('plugins:reset-perm', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    pluginPerms.clear(id)
  })

  // 管理 UI：在文件管理器里打开插件根目录（本地动作，零网络）
  ipcMain.handle('plugins:open-dir', async () => {
    const path = plugins.rootDir()
    const error = await shell.openPath(path)
    return { path, error: error || undefined }
  })

  // 管理 UI：插件根目录路径（纯查询，无副作用——设置页只展示不打开）
  ipcMain.handle('plugins:dir-path', () => plugins.rootDir())

  ipcMain.handle('term:create', async (_e, profileId: string, cwd?: unknown) => {
    // 插件注入的 profile 同走此口：渲染层永远只传 id 引用（「插件:局部」），
    // 命令体一律由主进程侧注册表解析——不给渲染层开「任意命令直传」的面
    const profile = registry.get(profileId) ?? plugins.getProfile(profileId)
    if (!profile) throw new Error(`profile not found: ${profileId}`)
    const info = await backend.create(profile, existingDir(cwd))
    persistSession() // 新窗口立即可恢复（不等渲染层 debounce 上报）
    return info
  })

  // 渲染层完成 onOpenDir 订阅后调用：取走排队中的目录并放开后续推送
  ipcMain.handle('cli:ready', (): string[] => {
    rendererReady = true
    return pendingOpenDirs.splice(0)
  })

  // 会话恢复：附着成功时返回恢复的标签与分组/活跃/改名态（一次性，取后即清）。
  // 先等后端就绪再读结果（见 backendStarted 注释）
  ipcMain.handle('session:restore', async () => {
    if (backendStarted) await backendStarted.catch(() => undefined)
    const tabs = restoredTabs
    restoredTabs = null
    if (!tabs || tabs.length === 0) return null
    const saved = sessionStore.get()
    const ids = new Set(tabs.map((t) => t.id))
    return {
      tabs,
      groups: (saved?.groups ?? []).filter((g) => tabs.some((t) => t.groupId === g.id)),
      activeId: saved && ids.has(saved.activeId) ? saved.activeId : tabs[0]!.id,
      renamed: (saved?.tabs ?? []).filter((t) => t.renamed && ids.has(t.id)).map((t) => t.id)
    }
  })

  // 恢复标签的屏幕回放：TermView 挂载后按需拉取（主进程 capture-pane 快照+光标定位）
  ipcMain.handle('session:replay', (_e, id: unknown) =>
    typeof id === 'string' ? backend.takeReplay(id) : ''
  )

  // 渲染层 UI 态上报（debounce 合并）：与后端窗口映射对账后落盘
  ipcMain.on('session:sync', (_e, payload: unknown) => {
    if (isolatedRun && !sessionE2E) return
    const p = payload as SyncedUiState | null
    if (
      !p ||
      !Array.isArray(p.tabs) ||
      p.tabs.length > 200 ||
      !Array.isArray(p.groups) ||
      typeof p.activeId !== 'string'
    ) {
      return
    }
    lastSync = p
    persistSession()
  })

  // Ctrl+Shift+Q：显式"退出并终结会话"
  ipcMain.on('session:quit-all', () => {
    console.log('[session] quit-terminating requested')
    quitTerminating()
  })

  ipcMain.on('term:input', (_e, id: string, data: string) => {
    inputEventsAtMain++
    backend.write(id, data)
  })

  // 终端复制/粘贴的剪贴板通道：渲染层 navigator.clipboard 在 X11 下不可靠，统一走主进程
  ipcMain.on('clipboard:write', (_e, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  // 终端里点击链接（URL 检测 / OSC 8 超链接）交给系统浏览器：与 window.open
  // 同一个 http/https 白名单出口（openExternalHttp），渲染层 CSP 不放行任何
  // 网络连接，链接打开是唯一经主进程的外跳路径
  ipcMain.on('shell:openExternal', (_e, url: unknown) => {
    if (typeof url === 'string') openExternalHttp(url)
  })

  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) =>
    backend.resize(id, cols, rows)
  )
  ipcMain.on('term:kill', (_e, id: string) => {
    backend.kill(id)
    persistSession() // 窗口集合变化即时落盘，崩溃后恢复面最小
  })

  // 分屏：在 fromId pane 的右侧（h）/下方（v）分出新 pane。profile 沿 tab 的
  // 记录由主进程侧注册表解析（渲染层只传 id 引用，命令面与 term:create 一致）
  ipcMain.handle('pane:split', (_e, tabId: string, fromId: string, dir: string) => {
    const info = backend.tabInfo(tabId)
    if (!info) throw new Error(`tab not found: ${tabId}`)
    const profile = registry.get(info.profileId) ?? plugins.getProfile(info.profileId)
    if (!profile) throw new Error(`profile not found: ${info.profileId}`)
    return backend
      .splitPane(tabId, fromId, dir === 'h' ? 'h' : 'v', profile)
      .then((id) => {
        persistSession() // 与 term:create 同节拍（pane 挂在既有 window 上，对账幂等）
        return id
      })
  })
  // 把手拖拽落点（pane 级尺寸）与 tmux 侧 active 同步（点击/键盘导航后）
  ipcMain.on('pane:resize', (_e, id: string, cols: number, rows: number) =>
    backend.resizePane(id, cols, rows)
  )
  ipcMain.on('pane:select', (_e, id: string) => backend.selectPane(id))
  // 窗格放大/还原（resize-pane -Z 的 toggle）：zoom 态在 tmux 侧，无需动会话存档
  ipcMain.on('pane:zoom', (_e, id: string) => backend.zoomPane(id))
  ipcMain.on('pane:kill', (_e, id: string) => {
    backend.killPane(id)
    persistSession() // 唯一 pane 时降级为关标签（window 集合变化）
  })
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function snapshotMetrics(): { cpuPercent: number; memMb: number; processes: number } {
  const ms = app.getAppMetrics()
  let cpu = 0
  let memKb = 0
  for (const m of ms) {
    cpu += m.cpu?.percentCPUUsage ?? 0
    memKb += m.memory?.workingSetSize ?? 0
  }
  return { cpuPercent: Math.round(cpu * 10) / 10, memMb: Math.round(memKb / 102.4) / 10, processes: ms.length }
}

function argvFlag(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(name + '='))
  return a ? a.split('=').slice(1).join('=') : undefined
}

/** 外部目录参数：优先 --open-dir=<path>，否则第一个非选项位置参数（dev 下 argv[1] 是脚本路径） */
function extractOpenDir(argv: string[]): string | undefined {
  const flag = argv.find((a) => a.startsWith('--open-dir='))
  if (flag) {
    const p = flag.slice('--open-dir='.length)
    if (p) return p
  }
  for (const a of argv.slice(app.isPackaged ? 1 : 2)) {
    if (!a.startsWith('-')) return a
  }
  return undefined
}

async function waitUntil(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 400
): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await delay(intervalMs)
  }
  return (await fn()) as boolean
}

interface E2EState {
  created: number
  latencies: number[]
  errors: string[]
  done: boolean
  activeId: string
}

async function pollE2EState(win: BrowserWindow): Promise<E2EState> {
  const raw = (await win.webContents.executeJavaScript(
    'JSON.stringify(window.__e2e)'
  )) as string
  return JSON.parse(raw) as E2EState
}

/** 端到端测试编排：批量开标签 → 截图 → xdotool 真实键盘注入 → 汇总性能 */
async function runE2ESequence(win: BrowserWindow, n: number): Promise<void> {
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }

  await delay(2000)
  await snap('01-boot')

  // 统计驱动阶段后端实际产出的事件数（区分"后端没输出"vs"渲染层收不到"）
  let backendEvents = 0
  let markersAtMain = 0
  const countTap = (id: string, d: string) => {
    backendEvents++
    if (d.includes('BM')) markersAtMain++
  }
  hub.on('term:data', countTap)

  await win.webContents.executeJavaScript(`window.__e2eStart(${n})`, true)
  const okFive = await waitUntil(async () => (await pollE2EState(win)).created >= Math.min(5, n), 60000)
  if (!okFive) console.error('E2E_WARN: 5-tab milestone timeout')
  await snap('02-tabs5')

  const done = await waitUntil(async () => (await pollE2EState(win)).done, 180000)
  const st = await pollE2EState(win)
  hub.off('term:data', countTap)
  await snap('03-all-tabs')
  console.log(`E2E_TABS_DONE created=${st.created} errors=${st.errors.length} backendEvents=${backendEvents}`)

  // 真实键盘注入（外部 xdotool 盯 E2E_XDO_MARKER 行动作），验证 GUI 输入链路
  const xdoMarker = `XDO_${randomUUID().slice(0, 8)}`
  let seen = false
  const tap = (id: string, d: string) => {
    if (d.includes(xdoMarker)) seen = true
  }
  hub.on('term:data', tap)
  await win.webContents.executeJavaScript('window.__e2eFocus && window.__e2eFocus()', true)
  console.log(`E2E_XDO_MARKER ${xdoMarker}`)
  let xdoOk = await waitUntil(() => seen, 8000, 200)
  let guiMethod = xdoOk ? 'xtest' : ''
  if (!xdoOk) {
    // X 层注入失败（无窗口管理器协作）时，退化为渲染层键盘/粘贴 API 注入
    await win.webContents.executeJavaScript(
      `window.__e2eType && window.__e2eType('echo ${xdoMarker}')`,
      true
    )
    await win.webContents.executeJavaScript('window.__e2eEnter && window.__e2eEnter()', true)
    xdoOk = await waitUntil(() => seen, 4000, 200)
    guiMethod = xdoOk ? 'synthetic-keyboard' : ''
  }
  if (!xdoOk) {
    await win.webContents.executeJavaScript(
      `window.__e2ePaste && window.__e2ePaste('echo ${xdoMarker}')`,
      true
    )
    await win.webContents.executeJavaScript('window.__e2eEnter && window.__e2eEnter()', true)
    xdoOk = await waitUntil(() => seen, 4000, 200)
    guiMethod = xdoOk ? 'paste-api' : ''
  }
  hub.off('term:data', tap)
  await snap('04-after-typing')

  // 设置页截图（--e2e-settings）：打开 → 外观/终端两页截图 → 关闭
  if (argvHas('--e2e-settings')) {
    await win.webContents.executeJavaScript('window.__e2eSettings && window.__e2eSettings(true)', true)
    await delay(500)
    await snap('05-settings')
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.settings-nav-item')[1]?.click()`,
      true
    )
    await delay(300)
    await snap('06-settings-terminal')
    await win.webContents.executeJavaScript('window.__e2eSettings && window.__e2eSettings(false)', true)
  }

  // 新建按钮的弹出菜单截图（--e2e-newtab-menu）：有默认终端时点箭头，否则点 + 本体
  if (argvHas('--e2e-newtab-menu')) {
    const clicked = (await win.webContents.executeJavaScript(
      `(() => {
        const b = document.querySelector('.newtab-caret') ?? document.querySelector('.newtab-split > .newtab')
        if (b) { b.click(); return b.className }
        return 'no-button'
      })()`,
      true
    )) as string
    console.log(`E2E_NEWTAB_MENU ${clicked}`)
    await delay(300)
    await snap('07-newtab-menu')
    await win.webContents.executeJavaScript(
      `document.querySelector('.menu')?.dispatchEvent(new MouseEvent('mouseleave'))`,
      true
    )
  }

  // 标签右键菜单（--e2e-tab-menu）：固定/取消固定 → 建组（截组头命名编辑态）→
  // 提交组名 → 移入组 → 折叠/展开，每步走真实右键 + 菜单点击链路
  if (argvHas('--e2e-tab-menu')) {
    const drive = async (idx: number, action: string, what: string) => {
      const ok = (await win.webContents.executeJavaScript(
        `window.__e2eTabMenu && window.__e2eTabMenu(${idx}, '${action}')`,
        true
      )) as boolean
      console.log(`E2E_TAB_MENU ${what} ${ok ? 'ok' : 'FAIL'}`)
      await delay(300)
      return ok
    }
    await drive(0, 'pin', 'pin-tab0')
    await snap('05-tab-pinned')
    await drive(0, 'pin', 'unpin-tab0')
    await drive(1, 'new-group', 'new-group-tab1')
    await snap('06-group-editing')
    await drive(0, 'commit-name', 'commit-group-name')
    await snap('07-group-named')
    await drive(2, 'move', 'move-tab2-into-group')
    await snap('08-group-two-tabs')
    await drive(0, 'group-head', 'collapse-group')
    await snap('09-group-collapsed')
    await drive(0, 'group-head', 'expand-group')
  }

  // 空闲态采样：全部标签就绪、无输入 3 秒后的 CPU/内存
  await delay(3000)
  const idleMetrics = snapshotMetrics()

  const metrics = snapshotMetrics()
  // 渲染层事件接收探针：主进程发合成事件，渲染层注册一次性监听
  const probePromise = win.webContents.executeJavaScript(
    `new Promise(res => { const off = window.api.onData((id, d) => { off(); res(id + '|' + d) }); setTimeout(() => res('PROBE_TIMEOUT'), 2500) })`,
    true
  ) as Promise<string>
  await delay(200)
  win.webContents.send('term:data', 'PROBE_ID', 'PROBE_DATA')
  const probeResult = await probePromise
  const result = {
    requestedTabs: n,
    createdTabs: st.created,
    errors: st.errors,
    backendEvents,
    markersAtMain,
    inputEventsAtMain,
    rendererProbe: probeResult,
    echoLatencyMs: {
      p50: percentile(st.latencies, 50),
      p95: percentile(st.latencies, 95),
      max: st.latencies.length ? Math.max(...st.latencies) : 0
    },
    guiKeystrokeOk: xdoOk,
    guiMethod,
    metrics,
    idleMetrics
  }
  console.log('E2E_RESULT ' + JSON.stringify(result))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(xdoOk && st.errors.length === 0 && done ? 0 : 1)
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const s = [...sorted].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

// ── 真实输入链路回归（--e2e-input）──
// sendInputEvent 派发的是可信事件，走与用户操作相同的输入管线（合成
// el.click()/dispatchEvent 不触发焦点转移，测不出这类回归）。覆盖三处历史缺陷：
// 真实点击标签后焦点应落在终端（曾甩到 body，键盘输入丢失）、Ctrl+Tab 应切换
// 标签且不向 shell 注入 \t（曾整族 Tab 被 xterm cancel() stopPropagation 吞掉）、
// 大流量中文输出不应因 %output 跨 chunk 解码出现 U+FFFD；
// 另覆盖组内广播输入路由：设置门控与 UI 出现、组内双 pane 同达、组外不收、
// 关广播恢复独立输入

interface InputPaneState {
  panes: number
  focused: number
  visible: number
  ae: string
}

async function typeChars(win: BrowserWindow, text: string): Promise<void> {
  for (const ch of text) {
    // keyDown 事件本身不携带字符文本（sendInputEvent 的 keyDown 只映射键位），
    // 需补一个 char 事件才会产生输入；xterm 对两者各走 keydown/insert 路径，各一次
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }
}

// 方向键的 Windows 虚拟键码：sendInputEvent 不带 vkCode 时派发的 DOM 事件
// key/code 均为空串（真实键盘输入恒携带 vkCode，只有合成输入需要显式补）
const ARROW_VK: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }

async function pressKey(
  win: BrowserWindow,
  keyCode: string,
  modifiers: ('ctrl' | 'shift' | 'alt')[] = []
): Promise<void> {
  const vk = ARROW_VK[keyCode]
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode,
    modifiers,
    ...(vk ? { windowsVirtualKeyCode: vk } : {})
  })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

async function runInputSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string): Promise<T> =>
    JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_INPUT ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }

  await js('window.__e2eStart(2)')
  await waitUntil(
    async () => await json<boolean>('window.__e2e && window.__e2e.done && window.__e2e.created >= 2'),
    60000
  )
  const state = () => json<InputPaneState>('window.__e2eInputState()')
  const paneHas = (idx: number, sub: string) =>
    json<boolean>(`window.__e2ePaneHas(${idx}, ${JSON.stringify(sub)})`)

  const s0 = await state()
  // 裸启动会自动开一个默认标签，实际标签数 = 1 + __e2eStart(n)；只断言焦点与可见终端一致
  check(
    'boot-focus',
    s0.focused === s0.visible && s0.focused >= 0 && s0.ae.includes('xterm-helper-textarea'),
    JSON.stringify(s0)
  )

  // 1) 真实点击第一个标签：焦点必须随切换落到该终端（曾丢到 body）
  const rect = await json<{ x: number; y: number; width: number; height: number }>(
    'document.querySelectorAll(".tab")[0].getBoundingClientRect()'
  )
  const cx = Math.round(rect.x + rect.width / 2)
  const cy = Math.round(rect.y + rect.height / 2)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
  await delay(400)
  const s1 = await state()
  check(
    'click-tab-focus',
    s1.visible === 0 && s1.focused === 0 && s1.ae.includes('xterm-helper-textarea'),
    JSON.stringify(s1)
  )

  // 点击后立即打字：回显必须落在被点击的 pane（焦点丢了会打到 body 什么也收不到）。
  // 标记用小写：sendInputEvent 的 keyDown 事件 key 为小写，xterm 以 ev.key 产出字符
  await typeChars(win, 'clickmk')
  await pressKey(win, 'Enter')
  check('click-tab-type', await waitUntil(() => paneHas(0, 'clickmk'), 6000))

  // 2) Ctrl+Tab：切换标签且焦点跟随（曾在终端聚焦时被 xterm 吞掉，\t 打进 shell）
  await pressKey(win, 'Tab', ['ctrl'])
  await delay(400)
  const s2 = await state()
  check(
    'ctrltab-switch',
    s2.visible === 1 && s2.focused === 1 && s2.ae.includes('xterm-helper-textarea'),
    JSON.stringify(s2)
  )
  await typeChars(win, 'tabmk')
  await pressKey(win, 'Enter')
  check('ctrltab-type', await waitUntil(() => paneHas(1, 'tabmk'), 6000))
  check(
    'ctrltab-no-leak',
    !(await waitUntil(() => paneHas(0, 'tabmk'), 800)),
    'pane0 不应收到 pane1 的输入'
  )

  // 3) Ctrl+Shift+Tab 切回
  await pressKey(win, 'Tab', ['ctrl', 'shift'])
  await delay(400)
  const s3 = await state()
  check('ctrlshifttab-back', s3.visible === 0 && s3.focused === 0, JSON.stringify(s3))

  // 4) 大流量中文：backend.send-keys 注入 printf，3000 个「中」= 9KB UTF-8，
  //    必然横跨多个 %output chunk，扫描全部 pane 的 buffer 不应出现 U+FFFD
  const ids = await json<string[]>('window.__e2eIds()')
  backend.write(ids[0], "printf '中%.0s' {1..3000}\r")
  await delay(2500)
  const bad = await json<Array<{ pane: number; line: string }>>('window.__e2eUtf8Bad()')
  check('utf8-clean', bad.length === 0, JSON.stringify(bad))

  // 5) 组内广播：先建组（设置仍关，组头不应有广播开关）→ 真实勾选设置 →
  //    开关出现 → 开广播 → 打字同段输入双达组内两 pane、组外不收 → 关广播恢复独立。
  //    --e2e-input 走真实 userData：先记录原值，结束时还原，不把测试态留进用户配置
  const menu = async (idx: number, action: string) =>
    (await js<boolean>(`window.__e2eTabMenu && window.__e2eTabMenu(${idx}, '${action}')`)) === true
  // 标签0+1 入同一组（真实右键菜单链路），标签2 留组外作对照
  check(
    'broadcast-group-setup',
    (await menu(0, 'new-group')) && (await menu(0, 'commit-name')) && (await menu(1, 'move'))
  )
  await delay(300)

  const hasBtn = () => js<boolean>('!!document.querySelector(".tabgroup-head .g-broadcast")')
  const setViaSettingsPage = async (on: boolean): Promise<boolean> => {
    await js('window.__e2eSettings && window.__e2eSettings(true)')
    await delay(300)
    await js(`document.querySelectorAll('.settings-nav-item')[1]?.click()`)
    await delay(200)
    const ok = await js<boolean>(
      `(() => { const cb = document.querySelector('[data-setting="groupBroadcast"]'); ` +
        `if (!cb) return false; if (cb.checked !== ${on}) cb.click(); return cb.checked === ${on} })()`
    )
    await delay(150)
    await js('window.__e2eSettings && window.__e2eSettings(false)')
    await delay(150)
    return ok
  }
  // getSettings 返回 Promise：须由 executeJavaScript 解析，JSON.stringify(Promise) 是 {}
  const prevBroadcast = (await js<{ groupBroadcast: boolean }>('window.api.getSettings()'))
    .groupBroadcast
  if (prevBroadcast) await setViaSettingsPage(false)
  check('broadcast-hidden-when-off', !(await hasBtn()))
  check('broadcast-setting-on', (await setViaSettingsPage(true)) && (await hasBtn()))

  // 开广播：组头开关点亮 + 活跃标签（0，在组内）触发常驻警示徽标。
  // __e2eBroadcastToggle 返回 Promise，须由 executeJavaScript 解析（json 包
  // JSON.stringify 会把 Promise 序列化成 {}）
  const t1 = await js<{ ok: boolean; on: boolean }>('window.__e2eBroadcastToggle()')
  const bs = await json<{ groups: number; badge: boolean }>('window.__e2eBroadcastState()')
  check('broadcast-on', t1.ok && t1.on && bs.groups === 1 && bs.badge, JSON.stringify({ t1, bs }))

  // 真实点击标签0 后打字：sendInputEvent → xterm onData → 广播路由 → 全组
  const r0 = await json<{ x: number; y: number; width: number; height: number }>(
    'document.querySelectorAll(".tab")[0].getBoundingClientRect()'
  )
  const tx = Math.round(r0.x + r0.width / 2)
  const ty = Math.round(r0.y + r0.height / 2)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: tx, y: ty, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 })
  await delay(400)
  const bm = `bc${randomUUID().slice(0, 5)}`
  await typeChars(win, bm)
  await pressKey(win, 'Enter')
  check(
    'broadcast-fanout',
    await waitUntil(async () => (await paneHas(0, bm)) && (await paneHas(1, bm)), 6000)
  )
  check('broadcast-no-leak', !(await waitUntil(() => paneHas(2, bm), 800)), '组外 pane 不应收到广播')

  // 关广播：打字恢复只进自己的 pane
  const t2 = await js<{ ok: boolean; on: boolean }>('window.__e2eBroadcastToggle()')
  const sm = `sm${randomUUID().slice(0, 5)}`
  await typeChars(win, sm)
  await pressKey(win, 'Enter')
  check(
    'broadcast-off-restore',
    t2.ok &&
      !t2.on &&
      (await waitUntil(() => paneHas(0, sm), 6000)) &&
      !(await waitUntil(() => paneHas(1, sm), 800)),
    JSON.stringify(t2)
  )
  // 还原用户原设置（主进程 store 直写即可；应用即将退出，渲染层态无需回灌）
  await js(`window.api.setSettings && window.api.setSettings({ groupBroadcast: ${!!prevBroadcast} })`)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_INPUT_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 终端查找回归（--e2e-search）：Ctrl+Shift+F 真实快捷键通路（sendInputEvent
// 可信事件）开合与再聚焦、匹配计数与 Enter/Shift+Enter 跳转、匹配点埋进
// scrollback 的滚动定位、大小写/正则开关、无匹配文案、Esc 关闭归还焦点（打字
// 回到 shell）、重开预填上次查询词、开框期间 Ctrl+Tab 切标签重跑新终端、
// 焦点不在终端（blur 到 body）时开框——window 单通路须覆盖 ──

interface SearchBoxState {
  open: boolean
  value: string
  counter: string
  caseOn: boolean
  wordOn: boolean
  regexOn: boolean
  inputFocused: boolean
}

async function runSearchSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string): Promise<T> =>
    JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_SEARCH ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }

  await js('window.__e2eStart(2)')
  await waitUntil(
    async () =>
      await json<boolean>('window.__e2e && window.__e2e.done && window.__e2e.created >= 2'),
    60000
  )
  const ids = await json<string[]>('window.__e2eIds()')
  const paneHas = (idx: number, sub: string) =>
    json<boolean>(`window.__e2ePaneHas(${idx}, ${JSON.stringify(sub)})`)
  const state = () => json<InputPaneState>('window.__e2eInputState()')
  // 可见 pane 的视口滚动位置（scrollback 定位断言用；display:none 的 pane 被排除）
  const vpScroll = () =>
    js<number>(
      `document.querySelector('.content > .tab-view:not([style*="none"]) .xterm-viewport')?.scrollTop ?? -1`
    )

  // 灌内容：tab0 两处匹配埋进 scrollback（162 行输出、视口在底部时两个匹配点
  // 都在视口上方），tab1 一处匹配
  await backend.write(
    ids[0],
    "clear; for i in $(seq 1 60); do echo \"filler-a-$i\"; done; echo 'SRCH alpha one'; for i in $(seq 1 60); do echo \"filler-b-$i\"; done; echo 'SRCH alpha two'; for i in $(seq 1 40); do echo \"filler-c-$i\"; done\r"
  )
  check('seed-tab0', await waitUntil(() => paneHas(0, 'SRCH alpha two'), 15000))
  await backend.write(ids[1], "clear; echo 'SRCH beta one'; echo filler-x\r")
  check('seed-tab1', await waitUntil(() => paneHas(1, 'SRCH beta one'), 15000))

  // __e2eStart 的最后建标签成为活跃标签（空提示符），先把标签 0（有内容）
  // 点成活跃：查找框作用于活跃终端，后续断言都以 pane 0 为对象
  const tabRect = await json<{ x: number; y: number; width: number; height: number }>(
    'document.querySelectorAll(".tab")[0].getBoundingClientRect()'
  )
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(tabRect.x + tabRect.width / 2),
    y: Math.round(tabRect.y + tabRect.height / 2),
    button: 'left',
    clickCount: 1
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(tabRect.x + tabRect.width / 2),
    y: Math.round(tabRect.y + tabRect.height / 2),
    button: 'left',
    clickCount: 1
  })
  check(
    'activate-tab0',
    await waitUntil(async () => (await state()).visible === 0, 6000)
  )

  // 1) Ctrl+Shift+F 开框：焦点本在终端（启动自动聚焦），输入框抢焦点
  await pressKey(win, 'F', ['ctrl', 'shift'])
  await delay(300)
  let st = await json<SearchBoxState>('window.__e2eSearchState()')
  check('hotkey-open', st.open && st.inputFocused, JSON.stringify(st))

  // 2) 查询计数（初始 findNext 落在首个匹配，1-based 计数显示）
  st = await js<SearchBoxState>('window.__e2eSearchInput("SRCH alpha")')
  check(
    'query-count',
    st.counter === '1/2',
    `${JSON.stringify(st)} lines=${JSON.stringify(
      await json<Array<{ line: number; text: string }>>(
        'window.__e2ePaneLinesWith(0, "SRCH alpha")'
      )
    )}`
  )
  await snap('01-search-open')

  // 3) Enter 下一个 / Shift+Enter 上一个
  await pressKey(win, 'Enter')
  await delay(300)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check('enter-next', st.counter === '2/2', st.counter)
  await pressKey(win, 'Enter', ['shift'])
  await delay(300)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check('shift-enter-prev', st.counter === '1/2', st.counter)

  // 4) scrollback 定位：匹配点在视口上方，滚动位置应大幅非零且两次导航落点不同
  const scroll1 = await vpScroll()
  check('scrollback-jump', scroll1 > 50, String(scroll1))
  await pressKey(win, 'Enter')
  await delay(300)
  const scroll2 = await vpScroll()
  check('nav-scroll-moves', Math.abs(scroll2 - scroll1) > 5, `${scroll1} -> ${scroll2}`)

  // 5) 大小写开关：默认不区分（小写查大写内容命中 2 处）。断言只看计数不看
  //    活跃下标：换词后 addon 从当前选区锚定续搜，索引跟随先前位置非恒为 1
  st = await js<SearchBoxState>('window.__e2eSearchInput("srch alpha")')
  check('case-insensitive', st.counter.endsWith('/2'), st.counter)
  st = await js<SearchBoxState>('window.__e2eSearchClick("search-case")')
  check('case-sensitive', st.caseOn && st.counter === '无匹配', JSON.stringify(st))
  st = await js<SearchBoxState>('window.__e2eSearchClick("search-case")')

  // 6) 正则开关：分组表达式命中（字面量形态则必不中，可区分正则真的生效）
  st = await js<SearchBoxState>('window.__e2eSearchClick("search-regex")')
  check('regex-on', st.regexOn, JSON.stringify(st))
  st = await js<SearchBoxState>('window.__e2eSearchInput("SRCH alpha (one|two)")')
  check('regex-count', st.counter.endsWith('/2'), JSON.stringify(st))
  st = await js<SearchBoxState>('window.__e2eSearchClick("search-regex")')

  // 7) 无匹配文案
  st = await js<SearchBoxState>('window.__e2eSearchInput("zzz-qqq-nomatch")')
  check('no-match', st.counter === '无匹配', st.counter)

  // 8) Esc 关闭：框消亡、焦点归还终端、打字回到 shell（查找框不再截获键盘）
  await pressKey(win, 'Escape')
  await delay(300)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  const inputSt = await state()
  check(
    'esc-close-focus',
    !st.open && inputSt.ae.includes('xterm-helper-textarea'),
    JSON.stringify({ box: st, input: inputSt })
  )
  // 标记避开 srch 字样：大小写不敏感的后续查询不该把它数进来
  await typeChars(win, 'typemk')
  await pressKey(win, 'Enter')
  check('focus-return-type', await waitUntil(() => paneHas(0, 'typemk'), 6000))

  // 9) 重开预填上次查询词且聚焦
  await pressKey(win, 'F', ['ctrl', 'shift'])
  await delay(300)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check(
    'reopen-persist',
    st.open && st.value === 'zzz-qqq-nomatch' && st.inputFocused,
    JSON.stringify(st)
  )

  // 10) 开框期间 Ctrl+Tab 切标签：搜索在标签 1 重跑（其缓冲区只有一处 SRCH）；
  //     标签 0 侧同样只看计数（选区锚定，活跃下标不定）
  st = await js<SearchBoxState>('window.__e2eSearchInput("SRCH")')
  check('query-tab0', st.counter.endsWith('/2'), st.counter)
  await pressKey(win, 'Tab', ['ctrl'])
  await delay(500)
  check('switch-visible', (await state()).visible === 1)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check('switch-tab-rerun', st.counter === '1/1', JSON.stringify(st))
  await snap('02-search-switched')

  // 11) 焦点已随切标签回终端，再按 Ctrl+Shift+F 应收回输入框（而非翻关）
  await pressKey(win, 'F', ['ctrl', 'shift'])
  await delay(300)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check('hotkey-refocus', st.open && st.inputFocused, JSON.stringify(st))

  // 12) 焦点不在终端（blur 到 body）时开框：window 单通路覆盖两种焦点情况
  await pressKey(win, 'Escape')
  await delay(300)
  await js('document.activeElement && document.activeElement.blur()')
  await delay(200)
  const blurred = await state()
  await pressKey(win, 'F', ['ctrl', 'shift'])
  await delay(300)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check(
    'hotkey-unfocused',
    !blurred.ae.includes('xterm') && st.open && st.inputFocused,
    JSON.stringify({ blurred: blurred.ae, box: st })
  )

  // 13) 框开期间键盘落输入框不落 shell（焦点在输入框，char 事件不进终端）
  st = await js<SearchBoxState>('window.__e2eSearchInput("SRCH beta")')
  await typeChars(win, 'noleak')
  await delay(400)
  st = await json<SearchBoxState>('window.__e2eSearchState()')
  check(
    'input-no-leak',
    st.value === 'SRCH betanoleak' && !(await waitUntil(() => paneHas(1, 'noleak'), 800)),
    JSON.stringify(st)
  )

  // 收尾：Esc 关闭归还焦点
  await pressKey(win, 'Escape')
  await delay(300)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_SEARCH_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 分屏回归（--e2e-splits）：真实输入管线覆盖 Ctrl+Shift+D/E 分屏（含嵌套）、
// tmux 权威几何与 xterm 实测 cols 的一致性、新 pane 获焦、Ctrl+Alt+方向导航、
// 点击切焦点、输入精确落点、Ctrl+Shift+W 关 pane 的分级语义（多 pane 关 pane /
// 单 pane 关标签 / 固定标签守卫）、把手拖拽 resize、关标签级联清理 ──

interface SplitPaneInfo {
  id: string
  active: boolean
  visible: boolean
  zoomed: boolean
  left: number
  top: number
  w: number
  h: number
  cols: number
  rows: number
}
interface SplitGripInfo {
  dir: string
  target: string
  x: number
  y: number
}
interface SplitState {
  panes: SplitPaneInfo[]
  grips: SplitGripInfo[]
  viewW: number
  viewH: number
  zoomBadge: boolean
}

async function runSplitsSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_SPLITS ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `splits-${name}.png`), img.toPNG())
    console.log(`E2E_SNAP splits-${name}`)
  }
  const split = (): Promise<SplitState> => json<SplitState>('window.__e2eSplitState()')
  const tabsCount = () => json<number>('document.querySelectorAll(".tab").length')
  const paneHas = (paneId: string, sub: string) =>
    json<boolean>(
      `window.__e2ePaneHas(window.__e2eIds().indexOf(${JSON.stringify(paneId)}), ${JSON.stringify(sub)})`
    )

  await js('window.__e2eStart(1)')
  await waitUntil(
    async () => await json<boolean>('window.__e2e && window.__e2e.done && window.__e2e.created >= 1'),
    60000
  )

  // 0) 初始单 pane 满铺（term:panes 已到：cols 为真实值而非兜底 -1）
  const s0 = await split()
  check('seed-single', s0.panes.length === 1 && s0.panes[0]!.cols > 40, JSON.stringify(s0.panes))

  // 1) Ctrl+Shift+D 左右分屏：2 pane、新 pane 获焦、左右几何、把手在位
  await pressKey(win, 'D', ['ctrl', 'shift'])
  const okSplitH = await waitUntil(async () => (await split()).panes.length === 2, 8000)
  const s1 = await split()
  check('split-h-count', s1.panes.length === 2)
  check(
    'split-h-focus-new',
    okSplitH && s1.panes.filter((p) => p.active).length === 1 && s1.panes[1]!.active,
    JSON.stringify(s1.panes.map((p) => p.active))
  )
  check(
    'split-h-geom',
    s1.panes[0]!.left === 0 && s1.panes[1]!.left >= s1.panes[0]!.w && s1.panes[1]!.top === 0,
    JSON.stringify(s1.panes.map((p) => [p.left, p.top, p.w]))
  )
  // tmux 几何与 xterm 实测一致：两 pane 的 cols 之和 + 1 分隔缝 ≈ 原单 pane cols
  check(
    'split-h-cols-authoritative',
    s1.panes[0]!.cols + s1.panes[1]!.cols + 1 >= s0.panes[0]!.cols - 2 &&
      s1.panes[0]!.cols + s1.panes[1]!.cols + 1 <= s0.panes[0]!.cols,
    `${s1.panes[0]!.cols}+${s1.panes[1]!.cols}+1 vs ${s0.panes[0]!.cols}`
  )
  check('split-h-grip', s1.grips.some((g) => g.dir === 'v'), JSON.stringify(s1.grips))
  await snap('h')

  // 2) 输入精确落到新 pane（右），不泄漏到左 pane
  await typeChars(win, 'spmk1')
  await delay(600)
  const rightId = s1.panes[1]!.id
  const leftId = s1.panes[0]!.id
  check('input-new-pane', await paneHas(rightId, 'spmk1'))
  check('input-no-leak', !(await paneHas(leftId, 'spmk1')))

  // 3) Ctrl+Shift+E 嵌套：右列上下再分 → 3 pane
  await pressKey(win, 'E', ['ctrl', 'shift'])
  const okSplitV = await waitUntil(async () => (await split()).panes.length === 3, 8000)
  const s2 = await split()
  check('split-v-count', s2.panes.length === 3)
  const rightCol = s2.panes.filter((p) => p.left > 0)
  check(
    'split-v-geom',
    okSplitV && rightCol.length === 2 && rightCol[0]!.left === rightCol[1]!.left && rightCol[1]!.top > rightCol[0]!.top,
    JSON.stringify(s2.panes.map((p) => [p.left, p.top]))
  )
  check(
    'split-v-focus-new',
    s2.panes.filter((p) => p.active).length === 1 &&
      s2.panes.find((p) => p.active)!.top === Math.max(...s2.panes.map((p) => p.top)),
    ''
  )
  await snap('v')

  // 4) Ctrl+Alt+Left：从右下 pane 导航回左列（焦点在终端内，xterm 键位表认领
  //    Ctrl+Alt+方向，customKeyEventHandler 拦截通路）。走 CDP debugger 通路：
  //    sendInputEvent 对方向键派发的 DOM 事件 key/code/keyCode 全空（vkCode
  //    也不达 DOM），无法按键名判定；CDP 事件与真实键盘同形
  try {
    win.webContents.debugger.attach('1.3')
  } catch {
    // 已附着（同序列第二次进入）
  }
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: 2 | 1, // ctrl | alt
    code: 'ArrowLeft',
    key: 'ArrowLeft',
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 0,
    code: 'ArrowLeft',
    key: 'ArrowLeft',
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37
  })
  await delay(300)
  const s3 = await split()
  check(
    'nav-left',
    s3.panes.length === 3 &&
      s3.panes.find((p) => p.active)?.left === 0,
    JSON.stringify(s3.panes.map((p) => [p.left, p.active]))
  )

  // 5) 点击右下 pane 聚焦（pane-box 的 mousedown → App 切活跃 pane）
  const target = s3.panes.find((p) => p.left > 0 && p.top > 0)!
  await win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(target.left + target.w / 2),
    y: Math.round(target.top + target.h / 2),
    button: 'left',
    clickCount: 1
  })
  await win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(target.left + target.w / 2),
    y: Math.round(target.top + target.h / 2),
    button: 'left',
    clickCount: 1
  })
  await delay(400)
  const s4 = await split()
  check('click-focus', s4.panes.find((p) => p.active)?.id === target.id)

  // 6) 拖拽把手 resize（此时是 3 pane：左列全高 + 右列上下两块，水平缝在右列
  //    之间）：缝下移 → 上 pane 行数增、下 pane 行数减，总行数守恒
  const grip = s4.grips.find((g) => g.dir === 'h')
  const beforeRows = s4.panes.map((p) => p.rows)
  if (grip) {
    await win.webContents.sendInputEvent({ type: 'mouseDown', x: grip.x, y: grip.y, button: 'left', clickCount: 1 })
    await win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x, y: grip.y + 40, button: 'left' })
    await delay(120)
    await win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x, y: grip.y + 90, button: 'left' })
    await delay(120)
    await win.webContents.sendInputEvent({ type: 'mouseUp', x: grip.x, y: grip.y + 90, button: 'left', clickCount: 1 })
  }
  const gripOk = await waitUntil(
    async () => {
      const s = await split()
      return s.panes.some((p, i) => Math.abs(p.rows - beforeRows[i]!) >= 2)
    },
    8000,
    400
  )
  const s6 = await split()
  check('grip-drag', !!grip && gripOk, JSON.stringify({ beforeRows, after: s6.panes.map((p) => p.rows) }))
  check(
    'grip-conservation',
    Math.abs(s6.panes.reduce((a, p) => a + p.rows, 0) - beforeRows.reduce((a, b) => a + b, 0)) <= 1,
    JSON.stringify(s6.panes.map((p) => p.rows))
  )
  await snap('grip')

  // 7) Ctrl+Shift+W 关活跃 pane（点击后焦点在右下）：3 → 2；右列下块死亡，
  //    上块拉伸补位。渲染层本地先行除名（立即变 2），行数增长要等后端
  //    %layout-change → list-panes 权威刷新（约 150ms 防抖 + 往返）
  await pressKey(win, 'W', ['ctrl', 'shift'])
  const okClose = await waitUntil(async () => (await split()).panes.length === 2, 8000)
  const grew = await waitUntil(
    async () => {
      const s = await split()
      return s.panes.some((p5) => {
        const before = s6.panes.find((p) => p.id === p5.id)
        return before && p5.rows > before.rows
      })
    },
    8000,
    400
  )
  const s5 = await split()
  check('close-pane-count', s5.panes.length === 2)
  check(
    'close-pane-collapse',
    okClose && grew,
    JSON.stringify({ before: s6.panes.map((p) => p.rows), after: s5.panes.map((p) => p.rows) })
  )
  check('close-pane-focus', s5.panes.some((p) => p.active))

  // 8) 关到单 pane 后 Ctrl+Shift+W = 关标签（回归原语义）；渲染实例数同步收敛
  const termsBefore = await json<number>('window.__e2eIds().length')
  await pressKey(win, 'W', ['ctrl', 'shift'])
  await waitUntil(async () => (await split()).panes.length === 1, 8000)
  const tabsBefore = await tabsCount()
  await pressKey(win, 'W', ['ctrl', 'shift'])
  const tabClosed = await waitUntil(async () => (await tabsCount()) === tabsBefore - 1, 8000)
  check('close-last-closes-tab', tabClosed)
  const termsAfter = await json<number>('window.__e2eIds().length')
  check(
    'tab-close-cascade',
    termsAfter === termsBefore - 2, // 该 tab 的 2 个 pane 实例全部注销
    `terms ${termsBefore} -> ${termsAfter}`
  )

  // 9) 固定标签守卫：pin 活跃标签后分 2 pane，Ctrl+Shift+W 仍关 pane（固定保护
  //    的是标签不丢），关到剩 1 个 pane 后再按不再关标签
  const curTabs = await tabsCount()
  const activeIdx = await json<number>(
    `[...document.querySelectorAll('.tab')].findIndex((t) => t.classList.contains('active'))`
  )
  await js(`window.__e2eTabMenu && window.__e2eTabMenu(${activeIdx}, 'pin')`)
  await delay(400)
  await pressKey(win, 'D', ['ctrl', 'shift'])
  await waitUntil(async () => (await split()).panes.length === 2, 8000)
  await pressKey(win, 'W', ['ctrl', 'shift'])
  const paneClosed = await waitUntil(async () => (await split()).panes.length === 1, 8000)
  check('pinned-pane-close', paneClosed)
  await pressKey(win, 'W', ['ctrl', 'shift'])
  await delay(800)
  check('pinned-tab-guard', (await tabsCount()) === curTabs, `tabs ${curTabs}`)
  // 还原 pin（key 恒为 'pin'，label 随状态翻转为取消固定）。pin 会把标签挪到
  // 固定块头部，DOM 下标已变，重新按活跃态定位
  const activeIdx2 = await json<number>(
    `[...document.querySelectorAll('.tab')].findIndex((t) => t.classList.contains('active'))`
  )
  await js(`window.__e2eTabMenu && window.__e2eTabMenu(${activeIdx2}, 'pin')`)
  await delay(300)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_SPLITS_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 窗格放大回归（--e2e-zoom）：Ctrl+Shift+Enter 的 toggle 通路（TermView 拦截）、
// 满铺几何与输入落点、焦点保持、切标签往返保持放大态、退出还原原布局、
// Ctrl+Alt+方向导航自动退出放大（tmux select-pane 语义）、放大态关 pane 降级、
// 单 pane 守卫 ──

async function runZoomSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_ZOOM ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `zoom-${name}.png`), img.toPNG())
    console.log(`E2E_SNAP zoom-${name}`)
  }
  const split = (): Promise<SplitState> => json<SplitState>('window.__e2eSplitState()')
  const tabsCount = () => json<number>('document.querySelectorAll(".tab").length')
  const paneHas = (paneId: string, sub: string) =>
    json<boolean>(
      `window.__e2ePaneHas(window.__e2eIds().indexOf(${JSON.stringify(paneId)}), ${JSON.stringify(sub)})`
    )
  const inputState = (): Promise<{ focused: number; visibleCount: number }> =>
    json<{ focused: number; visibleCount: number }>('window.__e2eInputState()')
  const paneIdx = async (paneId: string) => json<number>(`window.__e2eIds().indexOf(${JSON.stringify(paneId)})`)
  // 方向键导航走 CDP debugger（sendInputEvent 对方向键派发的 DOM 事件
  // key/code/keyCode 全空，按键名判定不可能；CDP 事件与真实键盘同形）
  const cdpArrow = async (code: string, vk: number) => {
    try {
      win.webContents.debugger.attach('1.3')
    } catch {
      // 已附着
    }
    for (const type of ['keyDown', 'keyUp'] as const) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        modifiers: type === 'keyDown' ? 2 | 1 : 0, // ctrl | alt
        code,
        key: code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      })
    }
  }

  await js('window.__e2eStart(1)')
  await waitUntil(
    async () => await json<boolean>('window.__e2e && window.__e2e.done && window.__e2e.created >= 1'),
    60000
  )

  // 0) 分屏出双 pane 基线（记录未 zoom 几何供还原断言）
  await pressKey(win, 'D', ['ctrl', 'shift'])
  await waitUntil(async () => (await split()).panes.length === 2, 8000)
  const s0 = await split()
  const leftId = s0.panes[0]!.id
  const rightId = s0.panes[1]!.id
  check('seed-split', s0.panes.length === 2 && s0.panes.every((p) => p.visible), JSON.stringify(s0.panes.map((p) => p.visible)))
  const beforeCols = s0.panes.map((p) => p.cols)

  // 1) Ctrl+Shift+Enter 放大：只留被放大 pane 可见（其余保活隐藏）、带 zoom 标记
  //    且恰为活跃 pane
  await pressKey(win, 'Enter', ['ctrl', 'shift'])
  const zoomed = await waitUntil(
    async () => {
      const s = await split()
      return s.panes.length === 2 && s.panes.filter((p) => p.visible).length === 1
    },
    8000,
    300
  )
  const s1 = await split()
  const zPane = s1.panes.find((p) => p.zoomed)
  check(
    'zoom-toggle',
    zoomed && !!zPane && zPane.id === rightId && zPane.active && zPane.visible && s1.grips.length === 0 && s1.zoomBadge,
    JSON.stringify(s1.panes.map((p) => [p.zoomed, p.active, p.visible]))
  )

  // 2) 满铺几何：zoomed pane 铺满容器（tmux 侧它就是 window 总尺寸）
  check(
    'zoom-geom-full',
    !!zPane && zPane.left === 0 && zPane.top === 0 && Math.abs(zPane.w - s1.viewW) <= 2 && Math.abs(zPane.h - s1.viewH) <= 2,
    `pane ${zPane?.w}x${zPane?.h} vs view ${s1.viewW}x${s1.viewH}`
  )
  await snap('zoomed')

  // 3) 输入到达被放大 pane，不泄漏到隐藏 pane
  await typeChars(win, 'zmk1')
  await delay(600)
  check('zoom-input', await paneHas(rightId, 'zmk1'))
  check('zoom-no-leak', !(await paneHas(leftId, 'zmk1')))

  // 4) 焦点保持在被放大 pane（布局重排不重挂载，输入焦点不漂移）
  const st = await inputState()
  check('zoom-focus-kept', st.focused === (await paneIdx(rightId)), JSON.stringify(st))

  // 5) 切标签往返：放大态保持（zoom 存于 tmux，随 tab 显隐不丢）
  await pressKey(win, 'Tab', ['ctrl'])
  await delay(400)
  await pressKey(win, 'Tab', ['ctrl'])
  const still = await waitUntil(
    async () => {
      const s = await split()
      return s.panes.length === 2 && s.panes.filter((p) => p.visible).length === 1 && s.panes.find((p) => p.zoomed)?.id === rightId
    },
    8000,
    300
  )
  check('zoom-tab-switch-keep', still)

  // 6) 再按 Ctrl+Shift+Enter 退出放大：双 pane 可见、几何还原到放大前
  await pressKey(win, 'Enter', ['ctrl', 'shift'])
  const unzoomed = await waitUntil(
    async () => {
      const s = await split()
      return s.panes.length === 2 && s.panes.every((p) => p.visible) && !s.panes.some((p) => p.zoomed)
    },
    8000,
    300
  )
  const s2 = await split()
  check(
    'zoom-unzoom-restore',
    unzoomed &&
      !s2.zoomBadge &&
      s2.panes.every((p, i) => Math.abs(p.cols - beforeCols[i]!) <= 1) &&
      s2.grips.some((g) => g.dir === 'v'),
    JSON.stringify({ before: beforeCols, after: s2.panes.map((p) => p.cols) })
  )

  // 7) 重新放大后 Ctrl+Alt+Left 导航：tmux select-pane 其它 pane 自动退出放大
  //    （快照几何算目标 = 左 pane），焦点随之迁移。被放大的是右 pane（分屏后
  //    新 pane 活跃），向左有邻居
  await pressKey(win, 'Enter', ['ctrl', 'shift'])
  await waitUntil(
    async () => {
      const s = await split()
      return s.panes.filter((p) => p.visible).length === 1 && s.panes.some((p) => p.zoomed)
    },
    8000,
    300
  )
  await cdpArrow('ArrowLeft', 37)
  const navOk = await waitUntil(
    async () => {
      const s = await split()
      return s.panes.length === 2 && s.panes.every((p) => p.visible) && !s.panes.some((p) => p.zoomed)
    },
    8000,
    300
  )
  const s3 = await split()
  check(
    'zoom-nav-unzooms',
    navOk && s3.panes.find((p) => p.active)?.id === leftId,
    JSON.stringify(s3.panes.map((p) => [p.active, p.visible]))
  )

  // 8) 放大态下 Ctrl+Shift+W：关的是被放大 pane（导航后活跃 = 左 pane），标签
  //    存活回到单 pane（active 边框按单 pane 规则熄灭，断言不查它）
  const tabsBefore = await tabsCount()
  await pressKey(win, 'Enter', ['ctrl', 'shift'])
  await waitUntil(
    async () => {
      const s = await split()
      return s.panes.filter((p) => p.visible).length === 1 && s.panes.some((p) => p.zoomed)
    },
    8000,
    300
  )
  await pressKey(win, 'W', ['ctrl', 'shift'])
  const closed = await waitUntil(async () => (await split()).panes.length === 1, 8000)
  await delay(400)
  const s4 = await split()
  check(
    'zoom-close-pane',
    closed && s4.panes.length === 1 && s4.panes[0]!.visible && !s4.panes[0]!.zoomed && (await tabsCount()) === tabsBefore,
    JSON.stringify(s4.panes)
  )

  // 9) 单 pane 标签上按放大：无动作（满铺与放大无差别，守卫拦截）
  await pressKey(win, 'Enter', ['ctrl', 'shift'])
  await delay(600)
  const s5 = await split()
  check(
    'zoom-single-noop',
    s5.panes.length === 1 && s5.panes[0]!.visible && !s5.panes[0]!.zoomed && (await tabsCount()) === tabsBefore,
    JSON.stringify(s5.panes)
  )

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_ZOOM_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 链接与 OSC 52 回归（--e2e-links）：URL 检测（addon-web-links）与 OSC 8
// 超链接点击经主进程白名单出口（api.openExternal 换记录桩断言，真实打开会拉
// 起浏览器）；OSC 52 走真实全链路——printf 产出序列 → pane 原始输出 → %output
// 透传 → xterm parser → 渲染层 handler → clipboard IPC → 主进程 clipboard 读取
// 断言。覆盖 UTF-8 解码、序列不落 buffer、1MB 上限、'?' 读查询不响应、设置页
// 开关真实点击。URL/链接文本独占一行（printf 换行输出），列偏移不受提示符宽
// 字符影响 ──
async function runLinksSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_LINKS ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `links-${name}.png`), img.toPNG())
    console.log(`E2E_SNAP links-${name}`)
  }
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const paneHas = (sub: string) => json<boolean>(`window.__e2ePaneHas(0, ${JSON.stringify(sub)})`)
  // 链接点击 = 先 hover（linkifier 的 provideLinks 异步）再按下抬起；坐标由
  // 渲染层 __e2eLinkPoint 按终端字体实测 cell 换算
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number) =>
    win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
  const clickLink = async (sub: string, snapName?: string): Promise<boolean> => {
    const p = await json<{ visible: boolean; x?: number; y?: number } | null>(
      `window.__e2eLinkPoint && window.__e2eLinkPoint(${JSON.stringify(sub)})`
    )
    if (!p?.visible || p.x === undefined || p.y === undefined) return false
    mouse('mouseMove', p.x, p.y)
    await delay(500)
    if (snapName) await snap(snapName) // hover 态快照（下划线装饰已绘制）
    mouse('mouseDown', p.x, p.y)
    mouse('mouseUp', p.x, p.y)
    return true
  }
  const setViaSettingsPage = async (on: boolean): Promise<boolean> => {
    await js('window.__e2eSettings && window.__e2eSettings(true)')
    await delay(300)
    await js(`document.querySelectorAll('.settings-nav-item')[1]?.click()`)
    await delay(200)
    const ok = await js<boolean>(
      `(() => { const cb = document.querySelector('[data-setting="osc52Copy"]'); ` +
        `if (!cb) return false; if (cb.checked !== ${on}) cb.click(); return cb.checked === ${on} })()`
    )
    await delay(150)
    await js('window.__e2eSettings && window.__e2eSettings(false)')
    await delay(150)
    return ok
  }

  // 裸启动的默认标签即测试标签（单 tab，idx 0）
  const ids = await json<string[]>('window.__e2eIds()')
  const tid = ids[0] ?? ''
  const ready = `LNKRDY_${randomUUID().slice(0, 8)}`
  backend.write(tid, `echo ${ready}\r`)
  check('shell-ready', tid.length > 0 && (await waitUntil(() => paneHas(ready), 10000)), tid)

  // 1) OSC 52 全链路：printf 产出序列（敲进 shell 的只是纯 ASCII 文本）→ 主进程剪贴板
  //（Electron 44 起 clipboard 异步化，读取一律 await）
  const mk1 = `L52A_${randomUUID().slice(0, 8)}`
  backend.write(tid, `printf '\\033]52;c;${b64(mk1)}\\007'\r`)
  check('osc52-roundtrip', await waitUntil(async () => (await clipboard.readText()) === mk1, 8000, 200))

  // 2) UTF-8 解码：中文 + emoji 的 base64 精确还原
  const mk2 = `L52U_中文剪贴板🎉_${randomUUID().slice(0, 8)}`
  backend.write(tid, `printf '\\033]52;c;${b64(mk2)}\\007'\r`)
  check('osc52-unicode', await waitUntil(async () => (await clipboard.readText()) === mk2, 8000, 200))

  // 3) 序列被 parser 消费：解码后的文本不落 buffer（回显行只有 base64 形态）
  check('osc52-consumed', !(await paneHas(mk2)))

  // 4) 读查询（Pd='?'）不响应：剪贴板不变、不崩、pane 仍可交互
  const mk4 = `L52Q_${randomUUID().slice(0, 8)}`
  backend.write(tid, `printf '\\033]52;c;?\\007'; echo ${mk4}\r`)
  await delay(800)
  check(
    'osc52-query-ignored',
    (await clipboard.readText()) === mk2 && (await paneHas(mk4)),
    (await clipboard.readText()).slice(0, 24)
  )

  // 5) 1MB 上限：1.5MB 载荷（base64 约 2MB，单行 -w0 不折行）被丢弃，剪贴板不变
  backend.write(tid, `printf -v big 'x%.0s' $(seq 1 1500000)\r`)
  await delay(1500)
  backend.write(tid, `printf '\\033]52;c;%s\\007' "$(printf %s \"$big\" | base64 -w0)"\r`)
  await delay(2500)
  check('osc52-cap', (await clipboard.readText()) === mk2, `len=${(await clipboard.readText()).length}`)

  // 6) 设置页开关：真实点击关掉后新序列不再写剪贴板，恢复后设置回原值
  const prevOsc52 = (await js<{ osc52Copy: boolean }>('window.api.getSettings()')).osc52Copy
  check('osc52-toggle-off', (await setViaSettingsPage(false)) === true)
  const mk6 = `L52T_${randomUUID().slice(0, 8)}`
  backend.write(tid, `printf '\\033]52;c;${b64(mk6)}\\007'\r`)
  await delay(1000)
  check('osc52-off-kept', (await clipboard.readText()) === mk2)
  if (prevOsc52 !== false) await setViaSettingsPage(true)

  // 7) URL 检测点击：echo 出的 https 链接 → 真实鼠标链路 → openExternal。换桩在
  //    主进程：window.api 是 contextBridge 代理，主世界不可写（渲染层 monkeypatch
  //    必抛 TypeError）；直接替换 shell:openExternal 监听记录 URL，渲染层链路
  //    （TermView → preload → IPC）全真实，也不真拉起系统浏览器
  let lastOpened = ''
  ipcMain.removeAllListeners('shell:openExternal')
  ipcMain.on('shell:openExternal', (_e, url: unknown) => {
    if (typeof url === 'string') lastOpened = url
  })
  const rnd = randomUUID().slice(0, 8)
  const url1 = `https://links-e2e-${rnd}.example.com/path?q=1`
  // URL 加引号：zsh 会把 ? 当通配符（裸 echo 报 no matches found）
  backend.write(tid, `echo '${url1}'\r`)
  await waitUntil(() => paneHas(url1), 8000)
  check(
    'weblink-click',
    (await clickLink(url1, 'url-hover')) && (await waitUntil(() => lastOpened === url1, 5000, 150)),
    url1
  )

  // 8) OSC 8 超链接：printf 包裹（ST 终止符）→ 点击可见文本 → 打开的是链接 URI
  const url2 = `https://osc8-e2e-${rnd}.example.com/deep`
  const label2 = `OSC8LINK${rnd}`
  backend.write(tid, `printf '\\033]8;;${url2}\\033\\\\${label2}\\033]8;;\\033\\\\\\n'\r`)
  await waitUntil(() => paneHas(label2), 8000)
  check(
    'osc8-click',
    (await clickLink(label2)) && (await waitUntil(() => lastOpened === url2, 5000, 150)),
    url2
  )

  // 9) OSC 8 非 http 协议：内核过滤（allowNonHttpProtocols=false），点击无动作
  const label3 = `BADLINK${rnd}`
  backend.write(tid, `printf '\\033]8;;file:///etc/passwd\\033\\\\${label3}\\033]8;;\\033\\\\\\n'\r`)
  await waitUntil(() => paneHas(label3), 8000)
  await clickLink(label3)
  await delay(700)
  check('osc8-nonhttp-ignored', lastOpened === url2)

  // 10) 纯文本非 http URL：addon 正则只认 https?，点击无动作
  const ftp = `ftp://ftp-e2e-${rnd}.example.com/x`
  backend.write(tid, `echo '${ftp}'\r`)
  await waitUntil(() => paneHas(ftp), 8000)
  await clickLink(ftp)
  await delay(700)
  check('weblink-http-only', lastOpened === url2)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_LINKS_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 分组侧栏回归（--e2e-sidebar）：真实 DOM 链路覆盖开关三条通路（标签栏按钮/
// 侧栏✕/Ctrl+Shift+B）、树结构与标签数组一致性、菜单建组/移入/改名、树内拖拽
// 入组/出组/同父重排（合成 DragEvent）、折叠、点选激活+焦点跟随、开关侧栏的
// 终端 resize 生效（cols 收窄）。走真实 userData：记原值结束还原 ──

interface SidebarState {
  setting: boolean
  sidebar: boolean
  tabbar: boolean
  termCols: number[]
  rows: Array<
    | { kind: 'tab'; title: string; active: boolean }
    | { kind: 'group'; name: string; count: number; collapsed: boolean; members: Array<{ title: string; active: boolean }> }
  >
}

async function runSidebarSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_SIDEBAR ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const state = async (): Promise<SidebarState> =>
    JSON.parse(await js<string>('JSON.stringify(window.__e2eSidebarState())'))
  const paneHas = (idx: number, sub: string) =>
    json<boolean>(`window.__e2ePaneHas(${idx}, ${JSON.stringify(sub)})`)
  const tab = (idx: number, action: string) =>
    js<boolean>(`window.__e2eSidebarTab && window.__e2eSidebarTab(${idx}, '${action}')`)
  const group = (action: string) =>
    js<boolean>(`window.__e2eSidebarGroup && window.__e2eSidebarGroup('${action}')`)

  // 记录用户原设置（结束还原）：getSettings 返回 Promise，须 executeJavaScript 解析
  const prevSettings = await js<{ sidebarVisible: boolean; groupBroadcast: boolean }>(
    'window.api.getSettings()'
  )

  // 1) 启动态：标签栏在（含侧栏入口按钮）、无侧栏
  const s0 = await state()
  check(
    'boot-tabbar',
    s0.tabbar && !s0.sidebar && !s0.setting && !!(await js<boolean>('!!document.querySelector(".tabbar .side-toggle")')),
    JSON.stringify({ tabbar: s0.tabbar, sidebar: s0.sidebar })
  )

  // 2) 标签栏按钮开侧栏：侧栏取代标签栏，设置持久化，可见终端 cols 收窄
  //    （ResizeObserver → fit → tmux resize 全链路）
  const colsBefore = s0.termCols[0] ?? 0
  const t1 = await js<{ sidebar: boolean; tabbar: boolean }>('window.__e2eSidebarToggle(true)')
  await delay(250)
  const s1 = await state()
  check(
    'open-btn-toggle',
    t1.sidebar && !t1.tabbar && s1.setting,
    JSON.stringify({ t1, setting: s1.setting })
  )
  check('resize-narrower', (s1.termCols[0] ?? 0) < colsBefore, `${colsBefore} -> ${s1.termCols[0]}`)
  await snap('01-sidebar-open')

  // 3) 建 3 个标签（+裸启动 1 个 = 4）：树 = 4 行根级标签
  await js('window.__e2eStart(3)')
  await waitUntil(
    async () => await json<boolean>('window.__e2e && window.__e2e.done && window.__e2e.created >= 3'),
    60000
  )
  const s2 = await state()
  check(
    'tree-flat',
    s2.rows.length === 4 && s2.rows.every((r) => r.kind === 'tab'),
    JSON.stringify(s2.rows.map((r) => (r.kind === 'tab' ? r.title : 'group')))
  )

  // 4) 右键菜单建组（含组名 Enter 提交）+ 移入第二名成员：与标签栏菜单同构建器。
  //    树行序随标签数组同步：[T0, 组{T1}, T2, T3] → [T0, 组{T1,T2}, T3]
  check('group-create', (await tab(1, 'new-group')) && (await group('commit-name')))
  await delay(300)
  const s3 = await state()
  check(
    'group-created-state',
    s3.rows.length === 4 &&
      s3.rows[1]!.kind === 'group' &&
      s3.rows[1].count === 1 &&
      s3.rows[1].members.length === 1,
    JSON.stringify(s3.rows)
  )
  check('group-move', (await tab(2, 'move')) === true)
  await delay(300)
  const s4 = await state()
  check(
    'group-moved-state',
    s4.rows.length === 3 &&
      s4.rows[0]!.kind === 'tab' &&
      s4.rows[1]!.kind === 'group' &&
      s4.rows[1].count === 2 &&
      s4.rows[1].members.length === 2,
    JSON.stringify(s4.rows)
  )
  await snap('02-sidebar-group')

  // 5) 双击改名（React 受控填值 + Enter 提交）
  check('rename-in-tree', (await tab(0, 'rename')) === true)
  await delay(300)
  const s5 = await state()
  check(
    'rename-committed',
    s5.rows[0]!.kind === 'tab' && s5.rows[0].title === '侧栏改名',
    JSON.stringify(s5.rows[0])
  )

  // 6) 树内拖拽（合成 DragEvent）：组外标签拖到组头 = 入组；成员拖到未分组行 =
  //    出组；两个未分组行互拖 = 同父重排。全程 .side-tab DOM 序：T0=0 起按数组序
  check('drag-into-group', (await js<boolean>('window.__e2eSidebarDrag(3, "group", 0)')) === true)
  await delay(300)
  const s6 = await state()
  check(
    'drag-into-state',
    s6.rows.length === 2 &&
      s6.rows[0]!.kind === 'tab' &&
      s6.rows[1]!.kind === 'group' &&
      s6.rows[1].count === 3,
    JSON.stringify(s6.rows)
  )
  check('drag-out-of-group', (await js<boolean>('window.__e2eSidebarDrag(2, "tab", 0)')) === true)
  await delay(300)
  const s7 = await state()
  check(
    'drag-out-state',
    s7.rows.length === 3 &&
      s7.rows[0]!.kind === 'tab' &&
      s7.rows[1]!.kind === 'tab' &&
      s7.rows[2]!.kind === 'group' &&
      s7.rows[2].count === 2 &&
      s7.rows[2].members.length === 2,
    JSON.stringify(s7.rows)
  )
  // 出组后根级行 = T2(DOM 0) 与 T0(DOM 1)：拖 T0 到 T2 上 = 同父重排
  check('drag-reorder', (await js<boolean>('window.__e2eSidebarDrag(1, "tab", 0)')) === true)
  await delay(300)
  const s8 = await state()
  check(
    'drag-reorder-state',
    s8.rows.length === 3 &&
      s8.rows[0]!.kind === 'tab' &&
      s8.rows[0].title === '侧栏改名' &&
      s8.rows[1]!.kind === 'tab' &&
      s8.rows[2]!.kind === 'group',
    JSON.stringify(s8.rows)
  )
  await snap('03-sidebar-dragged')

  // 7) 组折叠/展开（与标签栏共用 collapsed 态，随会话持久化）
  check('collapse-toggle', (await group('toggle')) === true)
  await delay(200)
  const s9 = await state()
  const collapsedGroup = s9.rows.find((r) => r.kind === 'group')
  check(
    'collapse-state',
    !!collapsedGroup && collapsedGroup.kind === 'group' && collapsedGroup.collapsed && collapsedGroup.members.length === 0,
    JSON.stringify(s9.rows)
  )
  check('expand-toggle', (await group('toggle')) === true)

  // 8) 点树节点激活：焦点必须落进对应终端（侧栏行不可聚焦，点击后由 App
  //    [activeId] effect 聚焦），后续键盘输入到达被点标签
  check('click-activate', (await tab(0, 'click')) === true)
  await delay(400)
  const st = await json<{ panes: number; focused: number; visible: number; ae: string }>(
    'window.__e2eInputState()'
  )
  check(
    'click-focus-follows',
    st.focused === st.visible && st.focused >= 0 && st.ae.includes('xterm-helper-textarea'),
    JSON.stringify(st)
  )
  const mk = `sb${randomUUID().slice(0, 5)}`
  await typeChars(win, mk)
  await pressKey(win, 'Enter')
  check('type-after-click', await waitUntil(() => paneHas(st.visible, mk), 6000))

  // 9) 广播开关在侧栏组头同样受设置总开关门控（正反向）——完整广播路由已由
  //    --e2e-input 覆盖，这里只验侧栏 UI 接线
  check('broadcast-hidden-when-off', !(await js<boolean>('!!document.querySelector(".side-group-head .g-broadcast")')))
  const setViaSettingsPage = async (on: boolean): Promise<boolean> => {
    await js('window.__e2eSettings && window.__e2eSettings(true)')
    await delay(300)
    await js(`document.querySelectorAll('.settings-nav-item')[1]?.click()`)
    await delay(200)
    const ok = await js<boolean>(
      `(() => { const cb = document.querySelector('[data-setting="groupBroadcast"]'); ` +
        `if (!cb) return false; if (cb.checked !== ${on}) cb.click(); return cb.checked === ${on} })()`
    )
    await delay(150)
    await js('window.__e2eSettings && window.__e2eSettings(false)')
    await delay(150)
    return ok
  }
  if (prevSettings.groupBroadcast) await setViaSettingsPage(false)
  check('broadcast-btn-appears', (await setViaSettingsPage(true)) === true)
  const bc1 = await js<boolean>('!!document.querySelector(".side-group-head .g-broadcast.on")')
  check('broadcast-off-initially', !bc1)
  check('broadcast-toggle-on-off', ((await group('broadcast')) === true) &&
    (await js<boolean>('!!document.querySelector(".side-group-head .g-broadcast.on")')) === true)
  check('broadcast-toggle-back', ((await group('broadcast')) === true) &&
    (await js<boolean>('!!document.querySelector(".side-group-head .g-broadcast.on")')) === false)
  await js(`window.api.setSettings && window.api.setSettings({ groupBroadcast: ${!!prevSettings.groupBroadcast} })`)

  // 10) Ctrl+Shift+B（终端聚焦态，sendInputEvent 可信事件）：快捷键须穿透
  //     xterm 到达 App（若被认领则侧栏不会关），关闭后标签栏回归、设置落盘。
  //     设置页交互会把焦点留在 body，先点树行收回终端焦点（activateTab 对已
  //     激活标签同步聚焦），保证快捷键真实走「焦点在终端内」的通路
  check('refocus-before-shortcut', (await tab(0, 'click')) === true)
  await delay(300)
  const fs = await json<{ focused: number; visible: number; ae: string }>('window.__e2eInputState()')
  check(
    'focus-in-terminal',
    fs.ae.includes('xterm-helper-textarea') && fs.focused === fs.visible,
    JSON.stringify(fs)
  )
  await pressKey(win, 'B', ['ctrl', 'shift'])
  await delay(300)
  const s10 = await state()
  check('shortcut-close', !s10.sidebar && s10.tabbar && !s10.setting, JSON.stringify({ sidebar: s10.sidebar, tabbar: s10.tabbar }))
  // 关闭后输入仍到达（快捷键处理没有弄丢焦点/没有把 \x02 打进 shell）
  const mk2 = `sc${randomUUID().slice(0, 5)}`
  await typeChars(win, mk2)
  await pressKey(win, 'Enter')
  check('type-after-shortcut', await waitUntil(() => paneHas(fs.visible, mk2), 6000))
  await snap('04-shortcut-back')

  // 11) 快捷键再开 + 侧栏 ✕ 关：三条开关通路全覆盖
  await pressKey(win, 'B', ['ctrl', 'shift'])
  await delay(300)
  const reopened = await state()
  check('shortcut-reopen', reopened.sidebar && !reopened.tabbar)
  const t2 = await js<{ sidebar: boolean; tabbar: boolean }>('window.__e2eSidebarToggle(false)')
  check('close-btn-toggle', !t2.sidebar && t2.tabbar, JSON.stringify(t2))

  // 12) 设置还原（侧栏开着退出会改变下次启动布局，必须回到原值）
  await js(
    `window.api.setSettings && window.api.setSettings({ sidebarVisible: ${!!prevSettings.sidebarVisible} })`
  )
  const final = await js<{ sidebarVisible: boolean; groupBroadcast: boolean }>(
    'window.api.getSettings()'
  )
  check(
    'settings-restored',
    final.sidebarVisible === prevSettings.sidebarVisible &&
      final.groupBroadcast === prevSettings.groupBroadcast,
    JSON.stringify({ final, prev: prevSettings })
  )

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_SIDEBAR_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 命令面板回归（--e2e-palette）：真实快捷键通路（sendInputEvent 注入
// Ctrl+Shift+P，含终端聚焦态穿透 xterm 的实证）+ 面板内模糊过滤、键盘导航、
// Enter/鼠标执行、二段改名、上下文命令随状态出现（固定置灰关闭、广播随设置
// 门控、主题当前项置灰）、Esc 关闭与焦点归还。走真实 userData：记原值结束还原 ──

interface PaletteState {
  open: boolean
  mode: string
  value: string
  count: number
  selected: number
  empty: boolean
  items: Array<{ key: string; label: string; disabled: boolean }>
}

const PALETTE_THEME_LABEL: Record<string, string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

async function runPaletteSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_PALETTE ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const state = async (): Promise<PaletteState> =>
    JSON.parse(await js<string>('JSON.stringify(window.__e2ePaletteState())'))
  // __e2ePaletteInput/Key/Click 返回 Promise，须由 executeJavaScript 解析
  const input = (text: string) => js<PaletteState>(`window.__e2ePaletteInput(${JSON.stringify(text)})`)
  const key = (k: string) => js<PaletteState>(`window.__e2ePaletteKey('${k}')`)
  const clickItem = (i: number) => js<PaletteState>(`window.__e2ePaletteClick(${i})`)
  // 幂等开面板：某步 Enter 落空（空过滤/置灰项）时面板保持打开，直接再按
  // Ctrl+Shift+P 会把它反向关掉——已开就直接复用当前面板
  const open = async (): Promise<PaletteState> => {
    let s = await state()
    if (s.open) return s
    await pressKey(win, 'P', ['ctrl', 'shift'])
    await delay(300)
    return state()
  }
  const sessionCount = async () => (await json<{ count: number }>('window.__e2eSessionState()')).count
  const paneHas = (idx: number, sub: string) =>
    json<boolean>(`window.__e2ePaneHas(${idx}, ${JSON.stringify(sub)})`)

  // 真实显示器上物理鼠标指针可能恰好停在面板列表区域：Chromium 会给指针下的
  // 命令项派发 mouseenter，面板的悬停选中会把初始选中从 0 挪走（悬停选中本身
  // 是正常产品行为）。先合成一次鼠标移动把指针带离面板区，断言才不受环境影响
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 640, y: 600 })
  await delay(150)

  // 记录用户原设置（结束还原）：getSettings 返回 Promise，须 executeJavaScript 解析
  const prevSettings = await js<{ sidebarVisible: boolean; groupBroadcast: boolean; theme: string }>(
    'window.api.getSettings()'
  )
  const themeBefore = await js<string>('document.documentElement.dataset.theme')

  // 1) 裸启动 1 + __e2eStart(2) = 3 个标签；面板初始关闭
  await js('window.__e2eStart(2)')
  await waitUntil(
    async () => await json<boolean>('window.__e2e && window.__e2e.done && window.__e2e.created >= 2'),
    60000
  )
  const s0 = await state()
  check('boot-closed', !s0.open)

  // 2) 终端聚焦态按 Ctrl+Shift+P：快捷键须穿透 xterm 到达 App（若被键位表认领
  //    面板不会开），面板开、输入框聚焦、全量列表就绪
  check('focus-in-terminal', (await js<boolean>('window.__e2eFocus()')) === true)
  await delay(200)
  const fs0 = await json<{ focused: number; visible: number; ae: string }>('window.__e2eInputState()')
  check(
    'terminal-focused',
    fs0.ae.includes('xterm-helper-textarea') && fs0.focused === fs0.visible,
    JSON.stringify(fs0)
  )
  const s1 = await open()
  const ae1 = await js<string>('String(document.activeElement && document.activeElement.className)')
  check(
    'shortcut-open',
    s1.open && s1.mode === 'cmd' && s1.selected === 0 && s1.count >= 10,
    JSON.stringify({ count: s1.count, selected: s1.selected })
  )
  check('input-focused', ae1.includes('palette-input'), ae1)
  check(
    'commands-listed',
    s1.items.some((i) => i.key === 'quit') &&
      s1.items.filter((i) => i.key.startsWith('switch:')).length === 2,
    `switch=${s1.items.filter((i) => i.key.startsWith('switch:')).length}`
  )
  await snap('01-palette-open')

  // 3) Esc 关闭 + 焦点归还终端（面板输入框拿着焦点时终端收不到键盘）
  const sEsc = await key('Escape')
  check('esc-close', !sEsc.open)
  const fs1 = await json<{ focused: number; visible: number; ae: string }>('window.__e2eInputState()')
  check(
    'focus-return',
    fs1.ae.includes('xterm-helper-textarea') && fs1.focused === fs1.visible,
    JSON.stringify(fs1)
  )
  const mk = `pa${randomUUID().slice(0, 5)}`
  await typeChars(win, mk)
  await pressKey(win, 'Enter')
  check('type-after-esc', await waitUntil(() => paneHas(fs1.visible, mk), 6000))

  // 4) 快捷键 toggle：开 → 再按即关（直接按 P，不经过幂等 open）
  await open()
  await pressKey(win, 'P', ['ctrl', 'shift'])
  await delay(300)
  check('shortcut-toggle-close', !(await state()).open)

  // 5) 过滤「新建」+ Enter：走 new-tab 命令建第 4 个标签
  const sNew = await (await open(), input('新建'))
  check(
    'filter-newtab',
    sNew.count >= 2 && sNew.items[0]!.key === 'new-tab',
    JSON.stringify(sNew.items.map((i) => i.key))
  )
  await key('Enter')
  check('newtab-exec', await waitUntil(async () => (await sessionCount()) === 4, 6000))

  // 6) 按 profile 名过滤建第 5 个标签（取首个可用 profile）
  const profiles = await js<Array<{ id: string; name: string; available?: boolean }>>(
    'window.api.listProfiles()'
  )
  const prof = profiles.find((p) => p.available !== false)!
  const sProf = await (await open(), input(prof.name))
  check(
    'filter-profile',
    sProf.items.some((i) => i.key === `new-tab:${prof.id}`),
    JSON.stringify({ prof: prof.id, items: sProf.items.map((i) => i.key) })
  )
  await key('Enter')
  check('profile-exec', await waitUntil(async () => (await sessionCount()) === 5, 6000))

  // 7) 二段改名：rename 命令切入改名模式（预填当前标题）→ 填新名 Enter →
  //    标题落库且进入「手动改名后 shell 标题不再覆盖」态；Esc 则返回命令模式不落
  const sRen1 = await (await open(), input('重命名'))
  check('rename-entry', sRen1.items[0]?.key === 'rename')
  await key('Enter')
  const sRen2 = await state()
  check('rename-mode', sRen2.open && sRen2.mode === 'rename' && sRen2.value !== '', sRen2.value)
  await input('面板改名')
  await key('Enter')
  await delay(300)
  const sess1 = await json<{ titles: string[]; renamed: number }>('window.__e2eSessionState()')
  check('rename-exec', sess1.titles.includes('面板改名') && sess1.renamed >= 1)
  await open()
  await input('重命名')
  await key('Enter')
  const sRen3 = await key('Escape')
  check('rename-esc-back', sRen3.open && sRen3.mode === 'cmd')
  await key('Escape')

  // 8) 标签快速切换：过滤「切换」列出除活跃外的全部 4 个；↑↓ 导航；Enter 切走
  //    再按新标题切回（visible = 活跃 pane 下标）
  const sSw = await (await open(), input('切换'))
  check(
    'switch-listed',
    sSw.count === 4 && sSw.items.every((i) => i.key.startsWith('switch:')),
    JSON.stringify(sSw.items.map((i) => i.key))
  )
  const sDown = await key('ArrowDown')
  check('arrow-down', sDown.selected === 1, `selected=${sDown.selected}`)
  const sUp = await key('ArrowUp')
  check('arrow-up', sUp.selected === 0, `selected=${sUp.selected}`)
  await key('Enter')
  await delay(400)
  const fs2 = await json<{ focused: number; visible: number }>('window.__e2eInputState()')
  check('switch-exec', fs2.visible === 0 && fs2.focused === 0, JSON.stringify(fs2))
  const sBack = await (await open(), input('面板改名'))
  check(
    'switch-filter',
    sBack.items.length === 1 && sBack.items[0]!.key.startsWith('switch:'),
    JSON.stringify(sBack.items.map((i) => i.key))
  )
  await key('Enter')
  await delay(400)
  const fs3 = await json<{ focused: number; visible: number }>('window.__e2eInputState()')
  check('switch-back', fs3.visible === 4 && fs3.focused === 4, JSON.stringify(fs3))

  // 9) 固定：命令固定当前标签（pinned 计数 +1，标签挪到头部）；固定后关闭命令
  //    置灰（防误关语义与快捷键/× 一致）；再执行变「取消固定」恢复
  const sPin = await (await open(), input('固定'))
  check('pin-entry', sPin.items[0]?.key === 'pin' && !sPin.items[0].disabled)
  await key('Enter')
  await delay(300)
  const sess2 = await json<{ pinned: number }>('window.__e2eSessionState()')
  check('pin-exec', sess2.pinned === 1)
  const sClose = await (await open(), input('关闭'))
  check('close-disabled-when-pinned', sClose.items[0]?.key === 'close' && sClose.items[0].disabled)
  await key('Escape')
  const sUnpin = await (await open(), input('取消固定'))
  check('unpin-entry', sUnpin.items[0]?.key === 'pin' && sUnpin.items[0].label.includes('取消固定'))
  await key('Enter')
  await delay(300)
  const sess3 = await json<{ pinned: number }>('window.__e2eSessionState()')
  check('unpin-exec', sess3.pinned === 0)

  // 10) 分组与广播：建组命令入新组；广播命令随设置总开关门控（关时过滤「广播」
  //     为空）→ 设置页真实开启 → 命令出现并执行（广播组计数 1）→ 移出组清空
  const sGrp = await (await open(), input('新组'))
  check('group-new-entry', sGrp.items[0]?.key === 'group-new')
  await key('Enter')
  await delay(300)
  const sess4 = await json<{ groups: Array<{ members: number }> }>('window.__e2eSessionState()')
  check('group-new-exec', sess4.groups.length === 1 && sess4.groups[0].members === 1)
  const sBc0 = await (await open(), input('广播'))
  check('broadcast-hidden-when-off', sBc0.count === 0 && sBc0.empty)
  await key('Escape')
  const setViaSettingsPage = async (on: boolean): Promise<boolean> => {
    await js('window.__e2eSettings && window.__e2eSettings(true)')
    await delay(300)
    await js(`document.querySelectorAll('.settings-nav-item')[1]?.click()`)
    await delay(200)
    const ok = await js<boolean>(
      `(() => { const cb = document.querySelector('[data-setting="groupBroadcast"]'); ` +
        `if (!cb) return false; if (cb.checked !== ${on}) cb.click(); return cb.checked === ${on} })()`
    )
    await delay(150)
    await js('window.__e2eSettings && window.__e2eSettings(false)')
    await delay(150)
    return ok
  }
  check('broadcast-setting-on', (await setViaSettingsPage(true)) === true)
  const sBc1 = await (await open(), input('广播'))
  check(
    'broadcast-cmd-appears',
    sBc1.items.some((i) => i.key === 'group-broadcast'),
    JSON.stringify(sBc1.items.map((i) => i.key))
  )
  await key('Enter')
  const bs = await json<{ groups: number }>('window.__e2eBroadcastState()')
  check('broadcast-exec', bs.groups === 1, JSON.stringify(bs))
  const sLeave = await (await open(), input('移出'))
  check('group-leave-entry', sLeave.items[0]?.key === 'group-leave')
  await key('Enter')
  await delay(300)
  const sess5 = await json<{ groups: unknown[] }>('window.__e2eSessionState()')
  check('group-leave-exec', sess5.groups.length === 0)

  // 11) 主题：三条 + 当前项置灰；「浅色」执行后 html data-theme 立变；按原主题
  //     名切回应还原
  const sTheme = await (await open(), input('主题'))
  check('theme-listed', sTheme.count === 3, JSON.stringify(sTheme.items.map((i) => i.key)))
  const curTheme = sTheme.items.find((i) => i.key === `theme:${prevSettings.theme}`)
  check('theme-current-disabled', !!curTheme && curTheme.disabled === true)
  await input('浅色')
  await key('Enter')
  await delay(300)
  const dt1 = await js<string>('document.documentElement.dataset.theme')
  check('theme-light', dt1 === 'light', dt1)
  await snap('02-palette-light')
  await open()
  await input(PALETTE_THEME_LABEL[prevSettings.theme] ?? '深色')
  await key('Enter')
  await delay(300)
  const dt2 = await js<string>('document.documentElement.dataset.theme')
  check('theme-revert', dt2 === themeBefore, `${dt2} vs ${themeBefore}`)

  // 12) 侧栏命令：开（侧栏取代标签栏）/ 关，label 随当前状态翻转
  const sSide = await (await open(), input('侧栏'))
  check('sidebar-entry', sSide.items[0]?.key === 'sidebar')
  await key('Enter')
  await delay(300)
  const side1 = await json<{ sidebar: boolean; tabbar: boolean }>('window.__e2eSidebarState()')
  check('sidebar-exec', side1.sidebar && !side1.tabbar, JSON.stringify(side1))
  await snap('03-palette-sidebar')
  const sSide2 = await (await open(), input('侧栏'))
  check('sidebar-label-flip', sSide2.items[0]?.label.includes('隐藏') === true)
  await key('Enter')
  await delay(300)
  const side2 = await json<{ sidebar: boolean; tabbar: boolean }>('window.__e2eSidebarState()')
  check('sidebar-back', !side2.sidebar && side2.tabbar, JSON.stringify(side2))

  // 13) 设置命令：Enter 打开设置页；关闭（Esc 与 × 两条路）都必须归还焦点到
  //     活跃终端——焦点曾落在设置控件上时随卸载掉到 body，终端键盘输入会静默
  //     失效（合成 el.click() 不移焦点测不出，须先真实 .focus() 进设置页）
  const sSet = await (await open(), input('设置'))
  check('settings-entry', sSet.items[0]?.key === 'settings')
  await key('Enter')
  await delay(300)
  check('settings-exec', (await js<boolean>('!!document.querySelector(".settings")')) === true)
  await js('document.querySelector(\'[data-setting="gpuRendering"]\')?.focus()')
  await delay(150)
  await pressKey(win, 'Escape')
  await delay(300)
  const escState = await json<{ focused: number; visible: number }>('window.__e2eInputState()')
  check(
    'settings-esc',
    (await js<boolean>('!!document.querySelector(".settings")')) === false &&
      escState.focused === escState.visible &&
      escState.focused >= 0,
    JSON.stringify(escState)
  )
  // × 路径：重新打开设置、真实聚焦进控件后点关闭按钮
  await js('window.__e2eSettings && window.__e2eSettings(true)')
  await delay(400)
  await js('document.querySelector(\'[data-setting="gpuRendering"]\')?.focus()')
  await delay(150)
  await js('document.querySelector(".settings-close")?.click()')
  await delay(300)
  const xState = await json<{ focused: number; visible: number; ae: string }>('window.__e2eInputState()')
  check(
    'settings-x-close-focus',
    (await js<boolean>('!!document.querySelector(".settings")')) === false &&
      xState.focused === xState.visible &&
      xState.ae.includes('xterm-helper-textarea'),
    JSON.stringify(xState)
  )

  // 14) 空结果态：乱串过滤无命中显示空态，Enter 不误执行也不崩，Esc 正常关闭
  const sEmpty = await (await open(), input('zzqx不存在的命令'))
  check('empty-state', sEmpty.count === 0 && sEmpty.empty)
  const sNoop = await key('Enter')
  check('empty-enter-noop', sNoop.open)
  await key('Escape')

  // 15) 鼠标点击执行（真实 onClick）：点第二个「新建」项（profile 命令）建标签
  const c0 = await sessionCount()
  await open()
  await input('新建')
  await clickItem(1)
  check('mouse-click-exec', await waitUntil(async () => (await sessionCount()) === c0 + 1, 6000))

  // 16) 设置还原（主题/侧栏/广播开关被测试动过，退出前回到用户原值）
  await js(
    `window.api.setSettings && window.api.setSettings({ sidebarVisible: ${!!prevSettings.sidebarVisible}, ` +
      `groupBroadcast: ${!!prevSettings.groupBroadcast}, theme: '${prevSettings.theme}' })`
  )
  const final = await js<{ sidebarVisible: boolean; groupBroadcast: boolean; theme: string }>(
    'window.api.getSettings()'
  )
  check(
    'settings-restored',
    final.sidebarVisible === prevSettings.sidebarVisible &&
      final.groupBroadcast === prevSettings.groupBroadcast &&
      final.theme === prevSettings.theme,
    JSON.stringify({ final, prev: prevSettings })
  )

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_PALETTE_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── profile 可用性运行中刷新回归（--e2e-profile-refresh，环境自备）──
// 预置：隔离 userData + profiles.json（含 PATH 上不存在的假 shell 条目），PATH
// 前插一个空「安装目录」；运行中把假 shell 写进该目录即模拟「装了新 shell」，
// 删除即卸载。断言：主进程每次 profiles:list 重探、＋菜单/命令面板打开时渲染层
// 重拉、新装内建 shell 补齐、变化落盘。期望集由主进程同一 PATH/fs 现算，机器无关

interface ProfListEntry {
  id: string
  name: string
  command?: string
  available?: boolean
}

// 与 profiles.ts 的 SHELL_CANDIDATES 对应（测试本地常量，随 gate 一起被剥离）
const PROF_BUILTIN_IDS: Array<[id: string, command: string]> = [
  ['bash', 'bash'],
  ['zsh', 'zsh'],
  ['fish', 'fish'],
  ['pwsh', 'pwsh'],
  ['docker-sh', 'docker']
]

async function runProfileRefreshSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_PROF ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const listProfiles = () => js<ProfListEntry[]>('window.api.listProfiles()')
  const menu = () =>
    js<{ open: boolean; items: Array<{ name: string; disabled: boolean }> }>(
      'window.__e2eNewTabToggle()'
    )
  // 主进程视角的期望集：内建候选里 command 在本进程 PATH 上的条目（与
  // profiles.ts 的 findOnPath 同逻辑；本套件启动时已把 PROF_BIN 前插进 PATH）
  const onPath = (cmd: string) =>
    (process.env.PATH ?? '').split(':').some((d) => d && existsSync(join(d, cmd)))
  const expectedBuiltins = PROF_BUILTIN_IDS.filter(([, cmd]) => onPath(cmd)).map(([id]) => id)

  // 1) 启动态：假 shell 未装（安装目录为空）→ available=false；bash 真 installed
  const boot = await listProfiles()
  check(
    'boot-grayed',
    boot.some((p) => p.id === 'e2e-sh' && p.available === false) &&
      boot.some((p) => p.id === 'bash' && p.available === true),
    JSON.stringify(boot.map((p) => [p.id, p.available]))
  )

  // 2) ＋菜单里该条目置灰（渲染层初始态；设置入口行健在）
  let m = await menu()
  check(
    'menu-open-grayed',
    m.open &&
      m.items.some((i) => i.name.includes('E2E Shell') && i.disabled) &&
      m.items.some((i) => i.name.includes('设置')),
    JSON.stringify(m)
  )
  await menu() // 关闭

  // 3) handler 级重探（不经 UI）：写入假 shell 模拟安装，直接 invoke 即变可用
  //    ——证明 profiles:list 每次重探，而不是只有启动 load 探一次
  writeFileSync(join(PROF_BIN, 'e2e-fake-sh'), '')
  const afterInstall = await listProfiles()
  check(
    'handler-reprobe',
    afterInstall.some((p) => p.id === 'e2e-sh' && p.available === true),
    JSON.stringify(afterInstall.find((p) => p.id === 'e2e-sh'))
  )

  // 4) 菜单重开解灰：渲染层持有的是第 2 步的旧列表，打开瞬间 onOpenMenu 重拉生效
  m = await menu()
  check(
    'menu-refresh-ungray',
    m.open && m.items.some((i) => i.name.includes('E2E Shell') && !i.disabled),
    JSON.stringify(m.items)
  )
  await snap('01-installed-ungrayed')
  await menu() // 关闭

  // 5) 内建补齐：本机已装但预置列表缺条的内建 shell（如 zsh/docker）被 refresh 补上
  const merged = await listProfiles()
  const ids = new Set(merged.map((p) => p.id))
  check(
    'builtin-merged',
    expectedBuiltins.every((id) => ids.has(id)),
    `have=[${[...ids]}] want=[${expectedBuiltins}]`
  )

  // 6) 变化落盘：profiles.json 出现 available 翻转与补齐条目（仅变化时回写）
  const disk = JSON.parse(readFileSync(join(PROF_UD, 'profiles.json'), 'utf-8')) as {
    profiles: ProfListEntry[]
  }
  check(
    'persisted',
    disk.profiles.some((p) => p.id === 'e2e-sh' && p.available === true) &&
      expectedBuiltins.every((id) => disk.profiles.some((p) => p.id === id)),
    JSON.stringify(disk.profiles.map((p) => [p.id, p.available]))
  )

  // 7) 卸载模拟：删掉假 shell 后菜单重开又置灰（渲染态随每次打开刷新，非一次性）
  rmSync(join(PROF_BIN, 'e2e-fake-sh'))
  m = await menu()
  check(
    'menu-regray-after-rm',
    m.open && m.items.some((i) => i.name.includes('E2E Shell') && i.disabled),
    JSON.stringify(m.items.find((i) => i.name.includes('E2E Shell')))
  )
  await menu() // 关闭

  // 8) 命令面板同源刷新：面板打开也会重拉（App 的 paletteOpen effect），
  //    不可用条目不进 profile 命令——过滤 'E2E' 应无 new-tab:e2e-sh
  await pressKey(win, 'P', ['ctrl', 'shift'])
  await delay(400)
  const pal = await json<{ open: boolean }>('window.__e2ePaletteState()')
  check('palette-open', pal.open)
  const filtered = await js<{ items: Array<{ key: string }> }>(
    `window.__e2ePaletteInput(${JSON.stringify('E2E')})`
  )
  check(
    'palette-excludes-unavailable',
    !filtered.items.some((i) => i.key === 'new-tab:e2e-sh'),
    JSON.stringify(filtered.items.map((i) => i.key))
  )
  await pressKey(win, 'Escape')
  await delay(200)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_PROF_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 自定义配色回归（--e2e-themes，环境自备）──
// 预置：隔离 userData + themes 目录夹具（好深/浅各一、坏 JSON、坏颜色字段、
// 保留字 id、非法文件名）。断言：加载器的丢弃路径、设置页深浅双选择器、
// 内联 CSS 变量覆盖与级联继承、xterm 调色板「partial 显式合并」语义（未声明
// 键继承内建而非 xterm 默认）、深浅两端独立切换、坏 id 防御回退、preapply 缓存
async function runThemesSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_THEME ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const schemeState = () => json<Record<string, unknown>>('window.__e2eSchemeState()')
  const term = async () => {
    const s = (await schemeState()) as {
      dataTheme?: string
      vars?: Record<string, string>
      terms?: Array<{ id: string; bg: string | null; green: string | null; red: string | null }>
    }
    return s.terms?.[0]
  }

  const prevSettings = await js<{ theme: string; darkTheme: string; lightTheme: string }>(
    'window.api.getSettings()'
  )

  // 1) 启动默认：深色 + 内建 Mocha，无内联变量（走 :root 级联），红绿均为 Mocha 值
  let s = (await schemeState()) as {
    dataTheme: string
    vars: Record<string, string>
    terms: Array<{ bg: string | null }>
  }
  let t = await term()
  check(
    'boot-default-mocha',
    s.dataTheme === 'dark' &&
      s.vars.bg === '' &&
      s.vars.accent === '' &&
      t?.bg === '#1e1e2e' &&
      t?.green === '#a6e3a1' &&
      t?.red === '#f38ba8',
    JSON.stringify({ dataTheme: s.dataTheme, vars: s.vars, t })
  )

  // 2) 加载器集合：内建 2 + 好文件 3；坏 JSON/保留字/非法文件名整文件丢弃；
  //    坏颜色值字段级丢弃（badcolor 的 ui 只剩 accent、terminal 整段没了）。
  //    注意 listThemes 返回 Promise：走 js（awaitPromise 解包），不能套 JSON.stringify
  interface ThemeListEntry {
    id: string
    name: string
    type: string
    ui?: Record<string, string>
    terminal?: Record<string, string>
  }
  const themes = await js<ThemeListEntry[]>('window.api.listThemes()')
  const ids = themes.map((x) => x.id)
  const badcolor = themes.find((x) => x.id === 'e2e-badcolor')
  check(
    'themes-listed',
    ids.filter((id) => id === 'mocha').length === 1 &&
      ['latte', 'e2e-dusk', 'e2e-paper', 'e2e-badcolor'].every((id) => ids.includes(id)) &&
      !ids.includes('e2e-broken') &&
      !ids.some((id) => id.includes(' ')) &&
      badcolor?.ui !== undefined &&
      Object.keys(badcolor.ui).join(',') === 'accent' &&
      badcolor.ui.accent === '#89b4fa' &&
      badcolor.terminal === undefined,
    JSON.stringify(ids)
  )

  // 3) 设置页双选择器：按 type 过滤分组；主题 select 仍是面板第一个（__e2eTheme 契约）
  await js('window.__e2eSettings(true)')
  await delay(300)
  const firstSelOptions = await json<string[]>(
    `[...document.querySelector('.settings-panel .settings-select').options].map(o=>o.value)`
  )
  const darkOptions = await json<string[]>(
    `[...document.querySelectorAll('.settings-panel select[data-setting="darkTheme"] option')].map(o=>o.value)`
  )
  const lightOptions = await json<string[]>(
    `[...document.querySelectorAll('.settings-panel select[data-setting="lightTheme"] option')].map(o=>o.value)`
  )
  check(
    'scheme-selects',
    JSON.stringify(firstSelOptions) === JSON.stringify(['dark', 'light', 'system']) &&
      darkOptions.includes('mocha') &&
      darkOptions.includes('e2e-dusk') &&
      !darkOptions.includes('e2e-paper') &&
      lightOptions.includes('latte') &&
      lightOptions.includes('e2e-paper') &&
      !lightOptions.includes('e2e-dusk'),
    JSON.stringify({ firstSelOptions, darkOptions, lightOptions })
  )

  // 4) 应用自定义深色：声明的变量走内联覆盖，未声明的 surface 仍空（级联继承
  //    内建基线）；终端背景/绿为方案值，未声明的红继承 Mocha——partial 合并语义
  await js(`window.__e2eScheme('darkTheme', 'e2e-dusk')`)
  await delay(300)
  s = (await schemeState()) as typeof s
  t = await term()
  check(
    'dusk-applied',
    s.dataTheme === 'dark' &&
      s.vars.bg === '#26251f' &&
      s.vars.accent === '#d8a657' &&
      s.vars.surface === '' &&
      t?.bg === '#26251f' &&
      t?.green === '#a9b665' &&
      t?.red === '#f38ba8',
    JSON.stringify({ vars: s.vars, t })
  )
  await snap('01-dusk')

  // 5) 深浅两端独立：切浅色端用 paper，深色端的 dusk 选择不受影响；
  //    切回深色时 dusk 恢复（跟随系统切换的通路同款）
  await js(`window.__e2eTheme('light')`)
  await delay(300)
  await js(`window.__e2eScheme('lightTheme', 'e2e-paper')`)
  await delay(300)
  s = (await schemeState()) as typeof s
  t = await term()
  check(
    'paper-light-independent',
    s.dataTheme === 'light' &&
      s.vars.bg === '#f5f0e8' &&
      s.vars.accent === '#8f5e15' &&
      t?.bg === '#f5f0e8',
    JSON.stringify({ dataTheme: s.dataTheme, vars: s.vars, t })
  )
  await snap('02-paper-light')
  await js(`window.__e2eTheme('dark')`)
  await delay(300)
  s = (await schemeState()) as typeof s
  check('dusk-restored', s.dataTheme === 'dark' && s.vars.bg === '#26251f', JSON.stringify(s.vars))

  // 6) preapply 缓存：dusk 生效中，localStorage 里深/浅两侧各存了对应方案的 ui
  //    变量表，供下次启动同步预应用防首帧闪内建色
  const cached = await json<{ dark?: Record<string, string> | null; light?: Record<string, string> | null }>(
    `JSON.parse(localStorage.getItem('tm.schemeVars') ?? '{}')`
  )
  check(
    'preapply-cache',
    cached.dark?.bg === '#26251f' &&
      cached.dark?.accent === '#d8a657' &&
      cached.light?.bg === '#f5f0e8',
    JSON.stringify(cached)
  )

  // 7) 防御回退（真实路径）：选中 dusk 后主题文件被删，重开设置页触发重扫——
  //    pickScheme 找不到存的 id，回退该侧内建（内联变量清空、调色板回 Mocha），
  //    下拉出现「未找到，已回退内建」占位项而不是空白
  rmSync(join(THEMES_UD, 'themes', 'e2e-dusk.json'))
  await pressKey(win, 'Escape')
  await delay(250)
  await js('window.__e2eSettings(true)')
  await delay(450)
  s = (await schemeState()) as typeof s
  t = await term()
  const staleOption = await json<string>(
    `document.querySelector('.settings-panel select[data-setting="darkTheme"] option')?.textContent ?? ''`
  )
  check(
    'deleted-file-fallback',
    s.dataTheme === 'dark' &&
      s.vars.bg === '' &&
      t?.bg === '#1e1e2e' &&
      staleOption.includes('未找到'),
    JSON.stringify({ vars: s.vars, t, staleOption })
  )

  // 8) 还原设置（settings:set 全链路回写）并关闭设置页；同样返回 Promise，走 js
  const final = await js<{ theme: string; darkTheme: string; lightTheme: string }>(
    `window.api.setSettings({ theme: ${JSON.stringify(prevSettings.theme)}, darkTheme: ${JSON.stringify(
      prevSettings.darkTheme
    )}, lightTheme: ${JSON.stringify(prevSettings.lightTheme)} })`
  )
  check(
    'settings-restored',
    final.theme === prevSettings.theme &&
      final.darkTheme === prevSettings.darkTheme &&
      final.lightTheme === prevSettings.lightTheme,
    JSON.stringify({ final, prevSettings })
  )
  await pressKey(win, 'Escape')
  await delay(200)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_THEME_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 声明式插件回归（--e2e-plugins，环境自备）──
// 断言：manifest 校验的丢弃路径（坏 JSON/未知动作类型/launch 坏引用/重复 id）、
// profile 注入进 ＋ 菜单、term:create 按「插件:局部」id 解析插件 profile（终端
// 真实回显）、面板命令段执行（launch/open-settings）、set-scheme 引用不存在方案
// 时置灰、插件主题包进 themes:list 且可选用（与主题数据化打通）
interface PluginListEntry {
  id: string
  name: string
  profiles: Array<{ id: string; name: string; available?: boolean }>
  commands: Array<{ id: string; label: string }>
  themes: Array<{ id: string; type: string }>
}

async function runPluginsSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_PLUG ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const paneHas = (idx: number, sub: string) =>
    json<boolean>(`window.__e2ePaneHas(${idx}, ${JSON.stringify(sub)})`)
  // 回显到达轮询：echo 经 tmux 控制协议回来有毫秒级延迟
  const waitPane = async (idx: number, sub: string) => {
    for (let i = 0; i < 12; i++) {
      if (await paneHas(idx, sub)) return true
      await delay(250)
    }
    return false
  }

  const prevSettings = await js<{ theme: string; darkTheme: string; lightTheme: string }>(
    'window.api.getSettings()'
  )

  // 1) 注册表集合：坏 JSON 与重复 id 整插件丢弃；e2e-tools 的坏引用命令被丢弃、
  //    好命令保留；profile id 已重写为「插件:局部」并探测 available。
  //    顺序按目录名排序：e2e-bad 在 e2e-tools 前
  const plugins = await js<PluginListEntry[]>('window.api.listPlugins()')
  const ids = plugins.map((p) => p.id)
  const tools = plugins.find((p) => p.id === 'e2e-tools')
  const bad = plugins.find((p) => p.id === 'e2e-bad')
  check(
    'plugins-listed',
    ids.join(',') === 'e2e-bad,e2e-tools' &&
      tools?.profiles.length === 1 &&
      tools.profiles[0]?.id === 'e2e-tools:hello' &&
      tools.profiles[0]?.available === true &&
      tools.commands.map((c) => c.id).join(',') === 'run-hello,open-set,bad-scheme' &&
      tools.themes.map((t) => t.id).join(',') === 'e2e-tools/e2e-night' &&
      bad?.commands.length === 0,
    JSON.stringify(plugins.map((p) => ({ id: p.id, cmds: p.commands.map((c) => c.id) })))
  )

  // 2) ＋菜单出现插件 profile（合并视图直通 NewTabMenu），真实点击启动——
  //    走 onNewTab → newTab → term:create（主进程按「插件:局部」id 解析插件
  //    profile），终端真实回显插件命令输出
  const menu = await js<{ open: boolean; items: Array<{ name: string; disabled: boolean }> }>(
    'window.__e2eNewTabToggle()'
  )
  check(
    'menu-plugin-profile',
    menu.open && menu.items.some((i) => i.name.includes('E2E Hello') && !i.disabled),
    JSON.stringify(menu.items.map((i) => i.name))
  )
  const clicked = await js<boolean>(
    `(() => { const el = [...document.querySelectorAll('.menu .menu-item')].find((e) => (e.textContent ?? '').includes('E2E Hello')); if (el) el.click(); return !!el })()`
  )
  const echoed = clicked ? await waitPane(1, 'PLUGIN_READY') : false
  const idsNow = await json<string[]>('window.__e2eIds()')
  const pane1 = await json<string[] | null>('window.__e2ePaneText(1)')
  check(
    'menu-launch-plugin-profile',
    clicked && echoed,
    JSON.stringify({ clicked, ids: idsNow.length, pane1 })
  )

  // 3) 面板命令段：过滤后插件命令可执行、坏引用命令已被丢弃不出现、
  //    set-scheme 引用不存在方案时置灰、零命令插件（e2e-bad）不贡献任何条目
  const before = await json<string[]>('window.__e2eIds()')
  await pressKey(win, 'P', ['ctrl', 'shift'])
  await delay(400)
  const filtered = await js<{ open: boolean; items: Array<{ key: string; disabled: boolean }> }>(
    `window.__e2ePaletteInput(${JSON.stringify('E2E 插件')})`
  )
  const runIdx = filtered.items.findIndex((i) => i.key === 'plugin:e2e-tools:run-hello')
  check(
    'palette-plugin-commands',
    runIdx >= 0 &&
      !filtered.items[runIdx]?.disabled &&
      filtered.items.some((i) => i.key === 'plugin:e2e-tools:open-set') &&
      filtered.items.some((i) => i.key === 'plugin:e2e-tools:bad-scheme' && i.disabled) &&
      !filtered.items.some((i) => i.key.startsWith('plugin:e2e-bad')),
    JSON.stringify(filtered.items.map((i) => [i.key, i.disabled]))
  )
  // launch 动作经真实点击执行：面板关闭、新标签建立、回显到达
  await json(`window.__e2ePaletteClick(${runIdx})`)
  await delay(250)
  const after = await json<string[]>('window.__e2eIds()')
  const echoed2 = await waitPane(2, 'PLUGIN_READY')
  check(
    'palette-launch-exec',
    after.length === before.length + 1 && echoed2,
    JSON.stringify({ before: before.length, after: after.length })
  )
  await snap('01-plugin-launched')

  // 4) open-settings 动作：面板命令打开设置页（走 App 的 setSettingsOpen）
  await pressKey(win, 'P', ['ctrl', 'shift'])
  await delay(400)
  const setFiltered = await js<{ items: Array<{ key: string }> }>(
    `window.__e2ePaletteInput(${JSON.stringify('E2E 插件：打开设置')})`
  )
  const setIdx = setFiltered.items.findIndex((i) => i.key === 'plugin:e2e-tools:open-set')
  await json(`window.__e2ePaletteClick(${setIdx})`)
  await delay(300)
  check(
    'palette-open-settings',
    setIdx >= 0 && (await js<boolean>('!!document.querySelector(".settings")')) === true,
    JSON.stringify(setFiltered.items.map((i) => i.key))
  )

  // 5) 插件主题包：全局 themes:list 不含插件主题（分离供给，渲染层合并）——
  //    判据读设置页下拉的真实呈现（合并视图）：深色下拉有命名空间 id、浅色无；
  //    经真实下拉选用后内联变量与全部终端背景跟随
  const nightInSelect = await js<boolean>(
    `[...document.querySelectorAll('.settings-panel select[data-setting="darkTheme"] option')].some((o) => o.value === 'e2e-tools/e2e-night')`
  )
  const nightNotInLight = await js<boolean>(
    `[...document.querySelectorAll('.settings-panel select[data-setting="lightTheme"] option')].every((o) => o.value !== 'e2e-tools/e2e-night')`
  )
  await js(`window.__e2eScheme('darkTheme', 'e2e-tools/e2e-night')`)
  await delay(300)
  const s = (await json('window.__e2eSchemeState()')) as {
    dataTheme?: string
    vars?: Record<string, string>
    terms?: Array<{ bg: string | null }>
  }
  check(
    'plugin-theme-selectable',
    nightInSelect &&
      nightNotInLight &&
      s.dataTheme === 'dark' &&
      s.vars?.bg === '#0f172a' &&
      (s.terms ?? []).every((t) => t.bg === '#0f172a'),
    JSON.stringify({ nightInSelect, nightNotInLight, dataTheme: s.dataTheme, vars: s.vars, terms: s.terms?.map((t) => t.bg) })
  )
  await snap('02-plugin-night')

  // 6) 还原设置并退出（Esc 关设置页，焦点归还终端）
  const final = await js<{ theme: string; darkTheme: string; lightTheme: string }>(
    `window.api.setSettings({ theme: ${JSON.stringify(prevSettings.theme)}, darkTheme: ${JSON.stringify(
      prevSettings.darkTheme
    )}, lightTheme: ${JSON.stringify(prevSettings.lightTheme)} })`
  )
  check(
    'settings-restored',
    final.darkTheme === prevSettings.darkTheme && final.lightTheme === prevSettings.lightTheme,
    JSON.stringify({ final, prevSettings })
  )
  await pressKey(win, 'Escape')
  await delay(200)

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_PLUG_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 代码级插件回归（--e2e-code-plugins，Tier 2 隔离宿主）──
// 覆盖：entry/permissions 字段下发、插件在沙箱 iframe 真实执行（帧桥 RPC）、
// 动态命令进面板并可执行（副作用+建标签）、事件订阅送达、动态主题进设置
// 下拉并生效、宿主 window 无 termManager（隔离方向 1）、插件帧摸不到宿主
// DOM/window.api（隔离方向 2）、逐插件 CSP（未声明/被拒的连接被禁、批准的
// origin 放行）、权限批准弹窗两条路径（允许/拒绝）、语法错误脚本不拖累
// 应用与兄弟插件、目录删除即卸载（注册物与 realm 一并消失）
async function runCodePluginsSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_CODE ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const prevSettings = await js<{ theme: string; darkTheme: string; lightTheme: string }>(
    'window.api.getSettings()'
  )

  // 本地 HTTP 上下文：验证逐插件 CSP 的放行/拦截。端口固定——权限批准流依赖
  // 渲染层启动时的 plugins:list 快照（弹窗里的声明列表来自它），端口必须早在
  // 模块初始化的夹具落盘阶段就定死，不能等序列运行时再改写 manifest
  const mkSrv = (port: number, body: string) =>
    new Promise<Server | null>((res) => {
      const srv = createServer((_req, rs) => {
        // 插件帧的 fetch 是跨源请求（tmplug:// → http://127.0.0.1），没有 ACAO
        // 会被 CORS 拒掉——那测的是 CORS 不是 CSP
        rs.setHeader('access-control-allow-origin', '*')
        rs.end(body)
      })
      srv.once('error', () => res(null)) // 端口被占：对应断言自然失败，可读的降级
      srv.listen(port, '127.0.0.1', () => res(srv))
    })
  const okSrv = await mkSrv(E2E_NET_OK_PORT, 'NET_OK')
  const badSrv = await mkSrv(E2E_NET_BAD_PORT, 'NET_BAD')
  const okPort = E2E_NET_OK_PORT
  const badPort = E2E_NET_BAD_PORT

  // 插件帧内执行 JS：经 WebFrameMain 定位 tmplug 帧（executeJavaScript 只进主框架）
  const frameFor = (pid: string) =>
    win.webContents.mainFrame.frames.find((f) => f.url.startsWith(`tmplug://${pid}/`))
  const fjs = async <T,>(pid: string, expr: string): Promise<T> => {
    const f = frameFor(pid)
    if (!f) throw new Error(`frame not found: ${pid}`)
    return f.executeJavaScript(expr, true) as Promise<T>
  }

  // 1) entry / permissions 字段：好插件与坏脚本插件都带相对路径（主进程只验
  //    形状/存在性，语法错误是加载期的事），纯声明插件缺省；codenet 声明的
  //    connect 已随端口改写进入下发数据
  const infos = await js<
    Array<{ id: string; entry?: string; permissions?: { connect?: string[] }; permDecision?: { decided: boolean } }>
  >('window.api.listPlugins()')
  const byId = new Map(infos.map((p) => [p.id, p]))
  check(
    'entry-fields',
    byId.get('e2e-codegood')?.entry === 'main.mjs' &&
      byId.get('e2e-codebad')?.entry === 'main.mjs' &&
      byId.get('e2e-plain')?.entry === undefined,
    JSON.stringify(infos.map((p) => ({ id: p.id, entry: p.entry })))
  )
  check(
    'permissions-fields',
    byId.get('e2e-codenet')?.permissions?.connect?.[0] === `http://127.0.0.1:${okPort}` &&
      byId.get('e2e-codenet')?.permDecision?.decided === false &&
      byId.get('e2e-codegood')?.permDecision === undefined,
    JSON.stringify({ codenet: byId.get('e2e-codenet')?.permissions, codegood: byId.get('e2e-codegood')?.permDecision })
  )

  // 2) 无权限声明的插件立即可用：module 在沙箱帧内异步到达，等插件初始化
  //    标记出现（状态栏项是帧桥 RPC 落到宿主注册表的可见结果）
  const scriptLoaded = await waitUntil(
    async () => (await js<boolean>("document.querySelector('.statusbar')?.textContent?.includes('CODE_SB') ?? false")) === true,
    8000,
    200
  )
  check('script-executed', scriptLoaded)
  await snap('01-code-statusbar')

  // 3) 隔离方向 1：宿主页面不再有 termManager（Tier 2 唯一入口在插件帧内）
  const hostTm = await js<boolean>('window.termManager === undefined')
  check('host-no-termManager', hostTm)

  // 4) 隔离方向 2：插件帧摸不到宿主 DOM 与 window.api，父窗口跨源不可达
  const isoRaw = await fjs<string>(
    'e2e-codegood',
    `JSON.stringify({
      api: typeof window.api !== 'undefined',
      parentSelf: window.parent === window,
      parentDoc: (function () { try { void window.parent.document; return 'leak' } catch (e) { return 'isolated' } })()
    })`
  )
  const iso = JSON.parse(isoRaw) as { api: boolean; parentSelf: boolean; parentDoc: string }
  check(
    'frame-isolated',
    !iso.api && !iso.parentSelf && iso.parentDoc === 'isolated',
    JSON.stringify(iso)
  )

  // 5) 权限批准：codenet（允许）→ codenet2（拒绝）两个弹窗依次出现并决策
  const allowShown = await waitUntil(
    async () => (await js<boolean>("!!document.querySelector('[data-key=perm-allow]')")) === true,
    5000,
    200
  )
  check('perm-prompt-allow', allowShown)
  await snap('02-perm-allow')
  await js("document.querySelector('[data-key=perm-allow]')?.click()")
  const denyShown = await waitUntil(
    async () => (await js<boolean>("(document.querySelector('.perm-card strong')?.textContent ?? '').includes('E2E 网络拒绝')")) === true,
    5000,
    200
  )
  check('perm-prompt-deny', denyShown)
  await js("document.querySelector('[data-key=perm-deny]')?.click()")
  const codenetFrame = await waitUntil(async () => frameFor('e2e-codenet') !== undefined, 5000, 200)
  const codenet2Frame = await waitUntil(async () => frameFor('e2e-codenet2') !== undefined, 5000, 200)
  check('perm-frames-mounted', codenetFrame && codenet2Frame)

  // 6) 逐插件 CSP：批准的 origin 放行（fetch 成功且读到测试服务器内容），
  //    未声明的 origin 被拦；拒绝路径（codenet2）全拦；无声明插件（codegood）全拦
  const probe = (port: number) =>
    `fetch('http://127.0.0.1:${port}/x').then((r) => r.text()).then((t) => 'ok:' + t).catch(() => 'blocked')`
  const netOk = await fjs<string>('e2e-codenet', probe(okPort))
  const netBad = await fjs<string>('e2e-codenet', probe(badPort))
  const netDenied = await fjs<string>('e2e-codenet2', probe(badPort))
  const netNoDecl = await fjs<string>('e2e-codegood', probe(okPort))
  check(
    'per-plugin-csp',
    netOk === 'ok:NET_OK' && netBad === 'blocked' && netDenied === 'blocked' && netNoDecl === 'blocked',
    JSON.stringify({ netOk, netBad, netDenied, netNoDecl })
  )

  // 7) 动态命令：面板出现 code: 前缀命令，执行后帧内副作用标记 + 新标签
  const before = await json<string[]>('window.__e2eIds()')
  await pressKey(win, 'P', ['ctrl', 'shift'])
  await delay(400)
  const filtered = await js<{ items: Array<{ key: string; disabled: boolean }> }>(
    `window.__e2ePaletteInput(${JSON.stringify('E2E Code')})`
  )
  const pingIdx = filtered.items.findIndex((i) => i.key === 'code:e2e-codegood:ping')
  check(
    'palette-code-command',
    pingIdx >= 0 && filtered.items[pingIdx]?.disabled !== true,
    JSON.stringify(filtered.items.map((i) => i.key))
  )
  await json(`window.__e2ePaletteClick(${pingIdx})`)
  await delay(300)
  const ran = await fjs<boolean>('e2e-codegood', 'window.__e2eCodeRan === true')
  const after = await json<string[]>('window.__e2eIds()')
  check(
    'command-exec',
    ran && after.length === before.length + 1,
    JSON.stringify({ ran, before: before.length, after: after.length })
  )

  // 8) 事件：tab-created/tab-activated 已送达插件（ping 建的新标签保证有 new: 记录）
  const eventsRaw = await fjs<string[] | undefined>('e2e-codegood', 'window.__e2eCodeEvents')
  const events = Array.isArray(eventsRaw) ? eventsRaw : []
  check(
    'events-delivered',
    events.some((e) => e.startsWith('new:')) && events.some((e) => e.startsWith('act:')),
    JSON.stringify(events)
  )

  // 9) 动态主题：设置页下拉出现命名空间 id（渲染层合并视图），选用后内联
  //    变量与全部终端背景跟随
  await js('window.__e2eSettings(true)')
  await delay(300)
  const dynInSelect = await js<boolean>(
    `[...document.querySelectorAll('.settings-panel select[data-setting="darkTheme"] option')].some((o) => o.value === 'e2e-codegood/dyn')`
  )
  await js(`window.__e2eScheme('darkTheme', 'e2e-codegood/dyn')`)
  await delay(300)
  const st = (await json('window.__e2eSchemeState()')) as {
    dataTheme?: string
    vars?: Record<string, string>
    terms?: Array<{ bg: string | null }>
  }
  check(
    'dynamic-theme-applied',
    dynInSelect && st.dataTheme === 'dark' && st.vars?.bg === '#1a2b3c' && (st.terms ?? []).every((t) => t.bg === '#1a2b3c'),
    JSON.stringify({ dynInSelect, dataTheme: st.dataTheme, vars: st.vars, terms: st.terms?.map((t) => t.bg) })
  )
  await snap('03-code-dyn-theme')

  // 10) 宿主页生产 CSP：连接通道全禁（应用零网络原则的技术强制）
  const fetchRes = await js<string>(
    `fetch('http://127.0.0.1:${badPort}/x').then(() => 'ok').catch(() => 'blocked')`
  )
  check('csp-connect-blocked', fetchRes === 'blocked', fetchRes)

  // 11) 语法错误脚本不拖累：应用存活（本轮 js 调用本身即证明）、纯声明插件的
  //     profile 仍在 ＋ 菜单、好插件注册物仍在（状态栏）
  await pressKey(win, 'Escape')
  await delay(200)
  const menu = await js<{ open: boolean; items: Array<{ name: string; disabled: boolean }> }>(
    'window.__e2eNewTabToggle()'
  )
  const sbStill = await js<string>("document.querySelector('.statusbar')?.textContent ?? ''")
  check(
    'bad-script-contained',
    menu.items.some((i) => i.name.includes('E2E Plain Shell')) && sbStill.includes('CODE_SB'),
    JSON.stringify({ items: menu.items.map((i) => i.name), sbStill })
  )
  await js('window.__e2eNewTabToggle()') // 菜单是 toggle 语义：再点一次关掉，别挡住下面的设置页路径

  // 12) 卸载：删掉 codegood 目录 → 重扫 → 注册物与 iframe 一并消失（Tier 2
  //     的 realm 销毁）；放回目录 → 重扫即恢复（帧重建重新执行）
  await js('window.__e2eSettings(false)')
  rmSync(join(CODE_UD, 'plugins', 'e2e-codegood'), { recursive: true, force: true })
  await js('window.api.listPlugins()')
  await js('window.__e2eSettings(true)') // 设置页打开触发渲染层 refreshProfiles
  await delay(500)
  const gone = await waitUntil(
    async () =>
      (await js<boolean>("!(document.querySelector('.statusbar')?.textContent ?? '').includes('CODE_SB')")) === true &&
      frameFor('e2e-codegood') === undefined,
    5000,
    200
  )
  const goneDiag = gone
    ? ''
    : JSON.stringify({
        sb: await js<string>("document.querySelector('.statusbar')?.textContent ?? ''"),
        frame: frameFor('e2e-codegood')?.url ?? null,
        mainHasCodegood: (await js<Array<{ id: string }>>('window.api.listPlugins()')).some((p) => p.id === 'e2e-codegood'),
        settingsDom: await js<boolean>("!!document.querySelector('.settings')")
      })
  check('plugin-unloaded', gone, goneDiag)
  writeCodeGoodFixture()
  await js('window.__e2eSettings(false)')
  await js('window.api.listPlugins()')
  await js('window.__e2eSettings(true)')
  const back = await waitUntil(
    async () =>
      (await js<boolean>("(document.querySelector('.statusbar')?.textContent ?? '').includes('CODE_SB')")) === true &&
      frameFor('e2e-codegood') !== undefined,
    5000,
    200
  )
  check('plugin-reloaded', back)

  // 13) 管理 UI（设置页此时是开着的——上一节留的）：切到「插件」节，卡片
  //     列表 / 禁用开关（帧与贡献双拆）/ 权限查看与重新询问（弹窗重批→CSP 收紧）
  await js("document.querySelector('[data-key=nav-plugins]')?.click()")
  await delay(300)
  const cards = (await json(`[...document.querySelectorAll('.plugin-card')].map((c) => ({
    id: c.dataset.plugin,
    type: c.querySelector('.plugin-badge')?.textContent ?? '',
    unchecked: !c.querySelector('[data-plugin-enable]')?.checked,
    granted: [...c.querySelectorAll('.plugin-perm-item')]
      .filter((i) => i.querySelector('.plugin-perm-state')?.classList.contains('ok'))
      .map((i) => i.querySelector('code')?.textContent ?? '')
  }))`)) as Array<{ id: string; type: string; unchecked: boolean; granted: string[] }>
  const listed =
    cards.length === 5 &&
    cards.find((c) => c.id === 'e2e-codegood')?.type === '代码级' &&
    cards.find((c) => c.id === 'e2e-plain')?.type === '声明式' &&
    (cards.find((c) => c.id === 'e2e-codenet')?.granted ?? []).includes(`http://127.0.0.1:${okPort}`) &&
    (cards.find((c) => c.id === 'e2e-codenet2')?.granted ?? []).length === 0
  check('mgmt-listed', listed, JSON.stringify(cards))
  await snap('04-plugin-mgmt')

  // 禁用 codegood：帧与注册物双拆（等价卸载），list 回包带 disabled 且贡献清空
  await js("document.querySelector('[data-plugin-enable=e2e-codegood]')?.click()")
  const off = await waitUntil(
    async () =>
      (await js<boolean>("!(document.querySelector('.statusbar')?.textContent ?? '').includes('CODE_SB')")) === true &&
      frameFor('e2e-codegood') === undefined,
    5000,
    200
  )
  const offList = await js<Array<{ id: string; disabled?: boolean }>>('window.api.listPlugins()')
  const cgOff = offList.find((p) => p.id === 'e2e-codegood')
  // 禁用期间的状态文件快照（持久化实证，mgmt-state-file 一并断言）
  let stateDuring: string[] = []
  try {
    stateDuring = (JSON.parse(readFileSync(join(CODE_UD, 'plugin-state.json'), 'utf-8')) as {
      disabled: string[]
    }).disabled
  } catch {
    stateDuring = []
  }
  check('mgmt-disable', off && cgOff?.disabled === true, JSON.stringify({ off, cgOff }))

  // 重新启用：帧重建、注册物恢复
  await js("document.querySelector('[data-plugin-enable=e2e-codegood]')?.click()")
  const on = await waitUntil(
    async () =>
      (await js<boolean>("(document.querySelector('.statusbar')?.textContent ?? '').includes('CODE_SB')")) === true &&
      frameFor('e2e-codegood') !== undefined,
    5000,
    200
  )
  check('mgmt-reenable', on)

  // 声明式插件的禁用：贡献（profiles）清空下发，再启用恢复
  await js("document.querySelector('[data-plugin-enable=e2e-plain]')?.click()")
  const plainOff = await waitUntil(
    async () =>
      (await js<Array<{ id: string; profiles: unknown[] }>>('window.api.listPlugins()')).find(
        (p) => p.id === 'e2e-plain'
      )?.profiles.length === 0,
    5000,
    200
  )
  await js("document.querySelector('[data-plugin-enable=e2e-plain]')?.click()")
  const plainOn = await waitUntil(
    async () =>
      ((await js<Array<{ id: string; profiles: unknown[] }>>('window.api.listPlugins()')).find(
        (p) => p.id === 'e2e-plain'
      )?.profiles.length ?? 0) > 0,
    5000,
    200
  )
  check('mgmt-declarative', plainOff && plainOn)

  // 重新询问网络权限：清除决策 → 重扫即弹批准框（压在设置页上）→ 拒绝 →
  // 帧重挂后 CSP 收紧（原本放行的 28123 变 blocked）
  await js("document.querySelector('.plugin-card[data-plugin=e2e-codenet] [data-key=plugin-reset-perm]')?.click()")
  const reask = await waitUntil(
    async () => (await js<boolean>("!!document.querySelector('.perm-card')")) === true,
    5000,
    200
  )
  await snap('05-plugin-reask')
  await js("document.querySelector('[data-key=perm-deny]')?.click()")
  await waitUntil(async () => frameFor('e2e-codenet') !== undefined, 5000, 200)
  await delay(300)
  const netAfter = await fjs<string>('e2e-codenet', probe(okPort))
  const deniedList = await js<
    Array<{ id: string; permDecision?: { decided: boolean; denied?: boolean; granted: string[] } }>
  >('window.api.listPlugins()')
  const cnPerm = deniedList.find((p) => p.id === 'e2e-codenet')?.permDecision
  check(
    'mgmt-reset-perm',
    reask && netAfter === 'blocked' && cnPerm?.decided === true && cnPerm?.denied === true && !cnPerm.granted.length,
    JSON.stringify({ reask, netAfter, cnPerm })
  )

  // 状态文件：禁用期间含 codegood、恢复后清干净（全部启用）
  let stateFinal: string[] = []
  try {
    stateFinal = (JSON.parse(readFileSync(join(CODE_UD, 'plugin-state.json'), 'utf-8')) as {
      disabled: string[]
    }).disabled
  } catch {
    stateFinal = []
  }
  check(
    'mgmt-state-file',
    stateDuring.includes('e2e-codegood') && !stateFinal.includes('e2e-codegood') && !stateFinal.includes('e2e-plain'),
    JSON.stringify({ stateDuring, stateFinal })
  )

  // 14) 还原设置并退出
  await js('window.__e2eSettings(false)')
  const final = await js<{ theme: string; darkTheme: string; lightTheme: string }>(
    `window.api.setSettings({ theme: ${JSON.stringify(prevSettings.theme)}, darkTheme: ${JSON.stringify(
      prevSettings.darkTheme
    )}, lightTheme: ${JSON.stringify(prevSettings.lightTheme)} })`
  )
  check(
    'settings-restored',
    final.darkTheme === prevSettings.darkTheme && final.lightTheme === prevSettings.lightTheme,
    JSON.stringify({ final, prevSettings })
  )

  okSrv?.close()
  badSrv?.close()
  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_CODE_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── GPU 渲染回归（--e2e-webgl 常规 / --e2e-webgl-fallback 回退）──
// 判据：WebGL 渲染器的主 canvas（无类名，上下文创建成功后才入 DOM）在
// .xterm-screen 下可查到；addon 的 link 层 canvas（xterm-link-layer）在更早的
// 构造期插入、失败路径会残留，判据用 :not() 排除。常规模式（GPU 可用）：默认
// 开启生效、设置开关即时切换且不重建终端实例、新建终端跟随、字号/主题变化的
// 重绘路径不丢渲染器；回退模式在启动早期禁用 WebGL，确定性触发创建失败 →
// 全部 DOM + 层残留清扫 + 功能完好

interface RenderEntry {
  id: string
  canvas: boolean
}

async function runWebglSequence(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const outDir = argvFlag('--e2e-out') ?? join(app.getPath('userData'), 'e2e')
  mkdirSync(outDir, { recursive: true })
  const snap = async (name: string) => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log(`E2E_SNAP ${name}`)
  }
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_WEBGL ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }
  const renderState = () => js<RenderEntry[]>('window.__e2eRenderState()')
  const allCanvas = async () => (await renderState()).every((e) => e.canvas)
  const noCanvas = async () => (await renderState()).every((e) => !e.canvas)
  const paneHas = (idx: number, sub: string) =>
    json<boolean>(`window.__e2ePaneHas(${idx}, ${JSON.stringify(sub)})`)
  const startTabs = async (n: number) => {
    await js(`window.__e2eStart(${n})`)
    await waitUntil(
      async () =>
        await json<boolean>(`window.__e2e && window.__e2e.done && window.__e2e.created >= ${n}`),
      60000
    )
  }
  // 在最后一个终端打 echo 标记并等回显到达（__e2eStart 后焦点/activeId 都在最后一个）
  const echo = async (tag: string) => {
    const marker = `${tag}_${randomUUID().slice(0, 8)}`
    await js(`window.__e2ePaste(${JSON.stringify(`echo ${marker}`)})`)
    await delay(600)
    return marker
  }
  // 设置页「终端」节开关 GPU（同 palette 套件的 setViaSettingsPage 模式）
  const setGpu = async (on: boolean): Promise<boolean> => {
    await js('window.__e2eSettings && window.__e2eSettings(true)')
    await delay(300)
    await js(`document.querySelectorAll('.settings-nav-item')[1]?.click()`)
    await delay(200)
    const ok = await js<boolean>(
      `(() => { const cb = document.querySelector('[data-setting="gpuRendering"]'); ` +
        `if (!cb) return false; if (cb.checked !== ${on}) cb.click(); return cb.checked === ${on} })()`
    )
    await delay(250)
    await js('window.__e2eSettings && window.__e2eSettings(false)')
    await delay(150)
    return ok
  }

  // 回退模式：WebGL 被禁用，addon 创建必走 catch → 全部 DOM 渲染、输入输出完好
  if (argvHas('--e2e-webgl-fallback')) {
    await startTabs(1)
    const rs = await renderState()
    check(
      'fallback-no-canvas',
      rs.length >= 2 && rs.every((e) => !e.canvas),
      JSON.stringify(rs)
    )
    const marker = await echo('WGLF')
    check('fallback-echo-ok', await paneHas(1, marker))
    // 失败路径的层残留必须被清扫（DOM 渲染器元素内不应有任何 canvas），且反复
    // 开关 GPU（每次都重试失败）不会越积越多
    const residue = async () =>
      (await js<number>('document.querySelectorAll(".term-mount canvas").length')) === 0
    check('fallback-no-residue', await residue())
    const toggled =
      (await setGpu(false)) && (await setGpu(true)) && (await delay(300), await residue())
    check('fallback-toggle-still-clean', toggled)
    await snap('01-fallback-dom')
    const fbOk = !results.some((r) => r.startsWith('FAIL:'))
    console.log('E2E_WEBGL_RESULT ' + JSON.stringify({ ok: fbOk, mode: 'fallback', results }))
    if (argvHas('--e2e-quit')) {
      await backend.dispose()
      app.exit(fbOk ? 0 : 1)
    }
    return
  }

  // ── 常规模式 ──
  const prev = await js<{ gpuRendering: boolean; theme: string; fontSize: number }>(
    'window.api.getSettings()'
  )

  // 1) 默认设置（gpuRendering=true）下裸启动 + 追加 1 = 2 个终端全 WebGL，
  //    输入→后端→shell→回显→WebGL 绘制链路完整
  await startTabs(1)
  const rs0 = await renderState()
  check('webgl-active', rs0.length >= 2 && rs0.every((e) => e.canvas), JSON.stringify(rs0))
  const m1 = await echo('WGL1')
  check('webgl-echo-ok', await paneHas(1, m1))
  await snap('01-webgl-active')

  // 2) 设置关 → 同一批终端实例（id 不变，验证不重建）即时回 DOM，输入仍通
  const ids0 = (await renderState()).map((e) => e.id).join(',')
  check('toggle-off-dom', (await setGpu(false)) && (await noCanvas()))
  const ids1 = (await renderState()).map((e) => e.id).join(',')
  check('toggle-keeps-instances', ids0 === ids1, `${ids0} -> ${ids1}`)
  const m2 = await echo('WGL2')
  check('dom-echo-ok', await paneHas(1, m2))

  // 3) 设置开 → canvas 回到全部终端
  check('toggle-on-webgl', (await setGpu(true)) && (await allCanvas()))

  // 4) 之后新建的终端跟随 WebGL
  await startTabs(1)
  const rs2 = await renderState()
  check('new-tab-webgl', rs2.length >= 3 && rs2.every((e) => e.canvas), JSON.stringify(rs2))

  // 5) WebGL 激活下改字号（字形纹理图集重建）与切主题（调色板重传）：
  //    外观节的步进器/下拉走真实 onChange → applySettings，重绘后渲染器不丢
  await js('window.__e2eSettings && window.__e2eSettings(true)')
  await delay(300)
  const fontOk = await js<boolean>(
    `(() => { const inp = document.querySelector('.stepper input'); if (!inp) return false; ` +
      `const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; ` +
      `setter?.call(inp, '16'); inp.dispatchEvent(new Event('input', { bubbles: true })); ` +
      `inp.blur(); return true })()`
  )
  await delay(400)
  const themeOk = await js<boolean>('window.__e2eTheme && window.__e2eTheme("light")')
  await delay(400)
  const themeNow = await js<string>('document.documentElement.dataset.theme')
  check(
    'restyle-keeps-webgl',
    fontOk && themeOk && themeNow === 'light' && (await allCanvas()),
    `fontOk=${fontOk} themeOk=${themeOk} dataset=${themeNow}`
  )
  await snap('02-webgl-restyled')
  await js('window.__e2eSettings && window.__e2eSettings(false)')
  await delay(150)

  // 6) 还原（字号/主题/GPU 走 IPC 直写主进程；进程即将退出，渲染层内存态无需跟随）
  await js(
    `window.api.setSettings({ gpuRendering: ${prev.gpuRendering}, fontSize: ${prev.fontSize}, ` +
      `theme: '${prev.theme}' })`
  )
  const final = await js<{ gpuRendering: boolean; theme: string; fontSize: number }>(
    'window.api.getSettings()'
  )
  check(
    'settings-restored',
    final.gpuRendering === prev.gpuRendering &&
      final.theme === prev.theme &&
      final.fontSize === prev.fontSize,
    JSON.stringify({ final, prev })
  )

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_WEBGL_RESULT ' + JSON.stringify({ ok: allOk, mode: 'normal', results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
}

// ── 会话保持两段回归（--e2e-session=phase1 / phase2，共享 --e2e-user-data）──
// phase1：建标签 + pin + 建组 + 改名 + 输入标记串 → 保留退出（detach）；
// phase2：附着恢复 → 断言标签数/固定/分组/改名态/屏幕回放/可继续交互 → 终结清场。
// 两个进程顺序跑，最接近真实"重启应用"

async function runSessionPhase1(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const marker = `SESS1_${randomUUID().slice(0, 8)}`

  // 裸启动已开 1 个默认标签，再追加 2 个 → 共 3 个
  await js('window.__e2eStart(2)')
  await waitUntil(
    async () =>
      (await js<string>(`JSON.stringify(window.__e2e && window.__e2e.done && window.__e2e.created >= 2)`)) === 'true',
    60000
  )

  // 标记串打进第一个标签（恢复后回放断言用）
  const ids = await json<string[]>('window.__e2eIds()')
  let seen = false
  const tap = (_id: string, d: string) => {
    if (d.includes(marker)) seen = true
  }
  hub.on('term:data', tap)
  backend.write(ids[0], `echo ${marker}\r`)
  const echoed = await waitUntil(() => seen, 8000, 200)
  hub.off('term:data', tap)
  console.log(`E2E_SESS1 ${echoed ? 'marker-echo' : 'marker-FAIL'}`)
  console.log(`E2E_SESS1_MARKER ${marker}`) // 外部脚本传给 phase2 断言回放

  // 分屏（标签 2，建组之前的原位下标）：真实快捷键链路 Ctrl+Shift+D → 2 pane。
  // phase2 断言布局经 tmux 权威重建恢复
  const tab2 = await json<{ x: number; y: number; width: number; height: number }>(
    'document.querySelectorAll(".tab")[2].getBoundingClientRect()'
  )
  const t2x = Math.round(tab2.x + tab2.width / 2)
  const t2y = Math.round(tab2.y + tab2.height / 2)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: t2x, y: t2y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: t2x, y: t2y, button: 'left', clickCount: 1 })
  await delay(300)
  await pressKey(win, 'D', ['ctrl', 'shift'])
  const splitOk = await waitUntil(
    async () => (await json<number>('window.__e2eSplitState().panes.length')) === 2,
    8000
  )
  console.log(`E2E_SESS1 split ${splitOk ? 'ok' : 'FAIL'}`)

  // 放大标签 2 的活跃 pane（真实 Ctrl+Shift+Enter 链路）：zoom 态存于 tmux 侧，
  // phase2 断言随会话恢复原样重建
  await pressKey(win, 'Enter', ['ctrl', 'shift'])
  const zoomOk = await waitUntil(
    async () => (await json<boolean>('window.__e2eSplitState().zoomBadge')) === true,
    8000
  )
  console.log(`E2E_SESS1 zoom ${zoomOk ? 'ok' : 'FAIL'}`)

  // UI 态：pin 标签0 → 标签1 建组并命名 → 标签2 移入 → 标签0 改名
  const menu = async (idx: number, action: string) =>
    (await js<boolean>(`window.__e2eTabMenu && window.__e2eTabMenu(${idx}, '${action}')`)) === true
  console.log(`E2E_SESS1 pin ${await menu(0, 'pin') ? 'ok' : 'FAIL'}`)
  console.log(`E2E_SESS1 new-group ${await menu(1, 'new-group') ? 'ok' : 'FAIL'}`)
  console.log(`E2E_SESS1 commit-name ${await menu(0, 'commit-name') ? 'ok' : 'FAIL'}`)
  console.log(`E2E_SESS1 move ${await menu(2, 'move') ? 'ok' : 'FAIL'}`)
  console.log(`E2E_SESS1 rename ${await menu(0, 'rename') ? 'ok' : 'FAIL'}`)
  await delay(700) // 等渲染层 session:sync debounce 到达主进程

  // 保留退出：先以主进程权威状态落盘，再 detach（不 kill 会话）
  persistSession()
  await backend.dispose({ keep: true })
  console.log('E2E_SESS1_DONE')
  app.exit(echoed ? 0 : 1)
}

async function runSessionPhase2(win: BrowserWindow): Promise<void> {
  const js = <T,>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>
  const json = async <T,>(expr: string) => JSON.parse(await js<string>(`JSON.stringify(${expr})`))
  const results: string[] = []
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(ok ? name : `FAIL:${name}`)
    console.log(`E2E_SESS2 ${name} ${ok ? 'ok' : 'FAIL'}${extra ? ' ' + extra : ''}`)
  }

  interface RestoredState {
    count: number
    pinned: number
    renamed: number
    groups: Array<{ name: string; members: number }>
    titles: string[]
  }
  // 渲染层 mount → session:restore → 标签恢复（轮询直到拿到状态）
  const pollState = async (): Promise<RestoredState | null> => {
    const s = await json<RestoredState | null>(
      'window.__e2eSessionState && window.__e2eSessionState()'
    )
    return s && s.count > 0 ? s : null
  }
  let st: RestoredState | null = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    st = await pollState()
    if (st) break
    await delay(300)
  }

  check('tabs-restored', !!st && st.count === 3, JSON.stringify(st))
  if (!st) {
    console.log('E2E_SESS2_RESULT ' + JSON.stringify({ ok: false, results }))
    await backend.dispose().catch(() => undefined)
    app.exit(1)
    return
  }
  check('pin-restored', st.pinned === 1, `pinned=${st.pinned}`)
  check(
    'group-restored',
    st.groups.length === 1 && st.groups[0].name === '组 1' && st.groups[0].members === 2,
    JSON.stringify(st.groups)
  )
  check('rename-restored', st.renamed === 1, `renamed=${st.renamed}`)

  // 屏幕回放：恢复后的第一个标签应含有 phase1 的标记串（capture-pane 快照写入 xterm）
  const marker = argvFlag('--e2e-sess-marker') ?? '__no_marker__'
  check(
    'replay-marker',
    await json<boolean>(`window.__e2ePaneHas(0, ${JSON.stringify(marker)})`)
  )

  // 恢复的会话可继续交互：向第一个标签注入新回显
  const ids = await json<string[]>('window.__e2eIds()')
  const probe = `SESS2_${randomUUID().slice(0, 8)}`
  let probeSeen = false
  const tap = (_id: string, d: string) => {
    if (d.includes(probe)) probeSeen = true
  }
  hub.on('term:data', tap)
  backend.write(ids[0], `echo ${probe}\r`)
  check('interactive', await waitUntil(() => probeSeen, 8000, 200))
  hub.off('term:data', tap)

  // 分屏恢复：标签 2 的 2 pane 布局经 tmux 权威重建（list-panes 对账），
  // 且回放覆盖（phase1 时标签 2 首 pane 含 marker 前 shell 输出）与可交互
  check(
    'split-restored',
    await json<boolean>(
      `[...document.querySelectorAll('.tab-view')].some((v) => v.querySelectorAll('.pane-box').length === 2)`
    )
  )
  const splitPaneId = await json<string>(
    `(function () {
      const v = [...document.querySelectorAll('.tab-view')].find(
        (x) => x.querySelectorAll('.pane-box').length === 2
      )
      return v ? (v.querySelectorAll('.pane-box')[1].dataset.paneId ?? '') : ''
    })()`
  )
  check('split-panes-registered', splitPaneId.length > 0)
  // 放大恢复：zoom 态存于 tmux（resize-pane -Z），附着对账后标签 2 仍在放大中
  //（恰一个 pane 带 zoom 标记 + 放大徽标在位；不依赖该标签此刻是否可见）
  check(
    'zoom-restored',
    await json<boolean>(
      `(function () {
        const v = [...document.querySelectorAll('.tab-view')].find(
          (x) => x.querySelectorAll('.pane-box').length === 2
        )
        if (!v) return false
        const boxes = [...v.querySelectorAll('.pane-box')]
        return boxes.filter((b) => b.dataset.zoomed === '1').length === 1 && !!v.querySelector('.pane-zoom-badge')
      })()`
    )
  )
  if (splitPaneId) {
    const probe2 = `SESS2S_${randomUUID().slice(0, 8)}`
    let probe2Seen = false
    const tap2 = (_id: string, d: string) => {
      if (d.includes(probe2)) probe2Seen = true
    }
    hub.on('term:data', tap2)
    backend.write(splitPaneId, `echo ${probe2}\r`)
    check('split-interactive', await waitUntil(() => probe2Seen, 8000, 200))
    hub.off('term:data', tap2)
  }

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_SESS2_RESULT ' + JSON.stringify({ ok: allOk, results }))
  sessionStore.clear() // 清场：不留 sessions.json，重跑 phase1 从零开始
  await backend.dispose()
  app.exit(allOk ? 0 : 1)
}

function argvHas(name: string): boolean {
  return process.argv.includes(name)
}

/** 无窗口冒烟：真实 shell 回显往返，验证 输入→tmux→shell→输出 全链路 */
async function runSmoke(): Promise<void> {
  try {
    const profile = registry.list()[0]
    const info = await backend.create(profile)
    const marker = `SMOKE_${randomUUID().slice(0, 8)}`
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('smoke timeout')), 15000)
      const onData = (_id: string, d: string) => {
        if (d.includes(marker)) {
          clearTimeout(timer)
          hub.off('term:data', onData)
          resolve()
        }
      }
      hub.on('term:data', onData)
      backend.write(info.id, `echo ${marker}\r`)
    })
    const m = snapshotMetrics()
    console.log('SMOKE_OK ' + JSON.stringify({ metrics: m }))
    await backend.dispose()
    app.exit(0)
  } catch (err) {
    console.error('SMOKE_FAIL:', err)
    await backend.dispose().catch(() => undefined)
    app.exit(1)
  }
}

// smoke / e2e 属于独立测试进程，不能和正在运行的 GUI 实例抢单实例锁。
// sessionE2E/sidebarE2E 套 __E2E__ 门：剥离构建把参数名与 userData 重定向
// 逻辑一并摇出产物（--smoke/--e2e-tabs/--e2e-input 为历史基线字面量，保留）
const sessionE2E = __E2E__ ? argvFlag('--e2e-session') : undefined
const sidebarE2E = __E2E__ ? argvHas('--e2e-sidebar') : false
const paletteE2E = __E2E__ ? argvHas('--e2e-palette') : false
const splitsE2E = __E2E__ ? argvHas('--e2e-splits') : false
const zoomE2E = __E2E__ ? argvHas('--e2e-zoom') : false
const linksE2E = __E2E__ ? argvHas('--e2e-links') : false
const profileRefreshE2E = __E2E__ ? argvHas('--e2e-profile-refresh') : false
const themesE2E = __E2E__ ? argvHas('--e2e-themes') : false
const pluginsE2E = __E2E__ ? argvHas('--e2e-plugins') : false
const codePluginsE2E = __E2E__ ? argvHas('--e2e-code-plugins') : false
const webglE2E = __E2E__ ? argvHas('--e2e-webgl') || argvHas('--e2e-webgl-fallback') : false
const isolatedRun =
  argvHas('--smoke') ||
  argvFlag('--e2e-tabs') !== undefined ||
  argvHas('--e2e-input') ||
  sidebarE2E ||
  paletteE2E ||
  splitsE2E ||
  zoomE2E ||
  linksE2E ||
  profileRefreshE2E ||
  themesE2E ||
  pluginsE2E ||
  codePluginsE2E ||
  webglE2E ||
  sessionE2E !== undefined
const cliOpenDir = extractOpenDir(process.argv)

// --e2e-webgl-fallback：启动早期禁用 WebGL（appendSwitch 必须早于 app ready），
// 确定性触发 WebglAddon 创建失败路径 → 断言自动回退 DOM 渲染后功能完好。
// 实测 --disable-webgl 单独拦不住 WebGL2（SwiftShader 软件实现仍发上下文），
// 须连软件光栅化一并禁掉才让 getContext('webgl2') 返回 null
if (__E2E__ && argvHas('--e2e-webgl-fallback')) {
  app.commandLine.appendSwitch('disable-webgl')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}

// --e2e-session 用独立 userData 跑两段，避免污染真实 profiles/settings/sessions
if (sessionE2E) {
  const dir = argvFlag('--e2e-user-data')
  if (!dir) {
    console.error('E2E_FAIL: --e2e-session 需要 --e2e-user-data=<dir>')
    process.exit(1)
  }
  app.setPath('userData', resolve(dir))
}

// --e2e-profile-refresh 的自备环境，须在 whenReady 的 registry.load() 之前就绪：
// 隔离 userData 预写 profiles.json（PATH 上不存在的假 shell 条目 + bash），PATH
// 前插空的「安装目录」——套件运行中写入/删除该目录里的 e2e-fake-sh 即模拟
// 安装/卸载（findOnPath 只看 existsSync，不需要可执行位）
const PROF_UD = '/tmp/e2e-prof-ud'
const PROF_BIN = '/tmp/e2e-prof-bin'
if (profileRefreshE2E) {
  rmSync(PROF_UD, { recursive: true, force: true })
  rmSync(PROF_BIN, { recursive: true, force: true })
  mkdirSync(PROF_UD, { recursive: true })
  mkdirSync(PROF_BIN, { recursive: true })
  writeFileSync(
    join(PROF_UD, 'profiles.json'),
    JSON.stringify(
      {
        version: 2,
        profiles: [
          { id: 'e2e-sh', name: 'E2E Shell', command: 'e2e-fake-sh', color: '#888888' },
          { id: 'bash', name: 'bash', command: 'bash', color: '#4fc3f7' }
        ]
      },
      null,
      2
    )
  )
  process.env.PATH = `${PROF_BIN}:${process.env.PATH ?? ''}`
  app.setPath('userData', PROF_UD)
}

// --e2e-themes 的自备环境，须在 whenReady 的 themes.load() 之前就绪：隔离
// userData 预写 themes 目录夹具，覆盖加载器各条丢弃路径（坏 JSON / 坏颜色字段 /
// 保留字 id / 非法文件名）与两条正常路径（深色/浅色自定义各一）
const THEMES_UD = '/tmp/e2e-themes-ud'
if (themesE2E) {
  const themesDir = join(THEMES_UD, 'themes')
  rmSync(THEMES_UD, { recursive: true, force: true })
  mkdirSync(themesDir, { recursive: true })
  // 好的深色方案：只声明部分 ui/terminal 字段——继承语义是断言点之一
  writeFileSync(
    join(themesDir, 'e2e-dusk.json'),
    JSON.stringify({
      name: 'E2E 黄昏',
      type: 'dark',
      ui: { bg: '#26251f', accent: '#d8a657' },
      terminal: { background: '#26251f', foreground: '#d4be98', green: '#a9b665' }
    })
  )
  // 好的浅色方案：字段全一点的另一套
  writeFileSync(
    join(themesDir, 'e2e-paper.json'),
    JSON.stringify({
      name: 'E2E 纸白',
      type: 'light',
      ui: { bg: '#f5f0e8', accent: '#8f5e15' },
      terminal: { background: '#f5f0e8', foreground: '#4f4538' }
    })
  )
  // 坏 JSON：整文件丢弃
  writeFileSync(join(themesDir, 'e2e-broken.json'), '{ not json')
  // 好结构 + 坏颜色值：字段级丢弃，主题本身保留（断言 ui 里只剩好字段）
  writeFileSync(
    join(themesDir, 'e2e-badcolor.json'),
    JSON.stringify({
      name: 'E2E 坏色',
      type: 'dark',
      ui: { bg: 'notacolor', accent: '#89b4fa' },
      terminal: { background: 'javascript:' }
    })
  )
  // 保留字 id：文件被跳过，内建 mocha 不受影响
  writeFileSync(
    join(themesDir, 'mocha.json'),
    JSON.stringify({ name: '假 Mocha', type: 'dark', ui: { bg: '#ff0000' } })
  )
  // 非法文件名（含空格）：跳过
  writeFileSync(
    join(themesDir, 'e2e bad name.json'),
    JSON.stringify({ name: '坏名', type: 'dark' })
  )
  app.setPath('userData', THEMES_UD)
}

// --e2e-plugins 的自备环境，须在 whenReady 的 plugins.load() 之前就绪：隔离
// userData 预写 plugins 目录夹具。好插件 e2e-tools（1 个 bash 回显 profile +
// launch/open-settings/坏引用三命令 + 1 个主题文件）、坏 JSON 插件、命令动作
// 类型非法的插件（插件保留、坏命令丢弃）、目录名排在后的重复 id 插件（后者弃）。
// 注意重复 id 夹具目录名以 zz 开头：目录按名排序取先，必须让真插件排在前面
const PLUG_UD = '/tmp/e2e-plugins-ud'
if (pluginsE2E) {
  const mkPlugin = (name: string, manifest: string) => {
    const dir = join(PLUG_UD, 'plugins', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), manifest)
    return dir
  }
  rmSync(PLUG_UD, { recursive: true, force: true })
  const toolsDir = mkPlugin(
    'e2e-tools',
    JSON.stringify({
      id: 'e2e-tools',
      name: 'E2E 工具箱',
      version: '1.0.0',
      profiles: [
        {
          id: 'hello',
          name: 'E2E Hello',
          command: 'echo',
          args: ['PLUGIN_READY'],
          color: '#66c2a5'
        }
      ],
      commands: [
        { id: 'run-hello', label: 'E2E 插件：跑 Hello', keywords: 'plugin hello', action: { type: 'launch', profile: 'hello' } },
        { id: 'open-set', label: 'E2E 插件：打开设置', action: { type: 'open-settings' } },
        { id: 'bad-ref', label: '坏引用命令', action: { type: 'launch', profile: 'ghost' } },
        { id: 'bad-scheme', label: 'E2E 插件：坏配色', action: { type: 'set-scheme', id: 'ghost/scheme' } }
      ]
    })
  )
  mkdirSync(join(toolsDir, 'themes'), { recursive: true })
  writeFileSync(
    join(toolsDir, 'themes', 'e2e-night.json'),
    JSON.stringify({
      name: 'E2E 夜蓝',
      type: 'dark',
      ui: { bg: '#0f172a' },
      terminal: { background: '#0f172a', foreground: '#cdd6f4' }
    })
  )
  mkPlugin('e2e-broken', '{ not json')
  mkPlugin(
    'e2e-bad',
    JSON.stringify({
      id: 'e2e-bad',
      name: 'E2E 坏动作',
      commands: [{ id: 'evil', label: '未知动作', action: { type: 'rm-rf' } }]
    })
  )
  mkPlugin('zz-e2e-dup', JSON.stringify({ id: 'e2e-tools', name: '重复 id 冒名' }))
  app.setPath('userData', PLUG_UD)
}

// --e2e-code-plugins 的自备环境，须在 whenReady 的 plugins.load() 之前就绪：
// 好的代码级插件（entry + 覆盖 API 全部能力面）、entry 语法错误的插件（脚本
// 加载失败不得拖累应用与兄弟插件）、无 entry 纯声明式插件（字段缺省语义）、
// 声明网络权限的两个插件（codenet 允许路径 / codenet2 拒绝路径——权限批准
// 弹窗与逐插件 CSP 的验证对象）。
// 本地 HTTP 测试端口固定（见序列内注释）：夹具落盘在模块初始化期，端口必须
// 此刻定死，渲染层启动时的 plugins:list 快照（弹窗声明列表来源）才能对上
const CODE_UD = '/tmp/e2e-code-ud'
const E2E_NET_OK_PORT = 28123
const E2E_NET_BAD_PORT = 28124
const CODE_MAIN = [
  "const tm = termManager.init('e2e-codegood')",
  'window.__e2eCodeEvents = []',
  "tm.on('tab-created', (e) => window.__e2eCodeEvents.push('new:' + e.id))",
  "tm.on('tab-activated', (e) => window.__e2eCodeEvents.push('act:' + e.id))",
  'tm.registerCommand({',
  "  id: 'ping',",
  "  label: 'E2E Code Ping',",
  "  keywords: 'code ping',",
  '  run: () => {',
  '    window.__e2eCodeRan = true',
  '    void tm.tabs.create()',
  '  }',
  '})',
  'tm.registerTheme({',
  "  id: 'dyn',",
  "  name: 'E2E Dyn',",
  "  type: 'dark',",
  "  ui: { bg: '#1a2b3c' },",
  "  terminal: { background: '#1a2b3c', green: '#00ff66' }",
  '})',
  "tm.statusbar.setItem('s1', { text: 'CODE_SB', tooltip: 'from code plugin' })",
  ''
].join('\n')

// 卸载断言删目录后原样放回（目录名与内容一致，重扫即恢复）
function writeCodeGoodFixture(): void {
  const good = join(CODE_UD, 'plugins', 'e2e-codegood')
  mkdirSync(good, { recursive: true })
  writeFileSync(
    join(good, 'manifest.json'),
    JSON.stringify({ id: 'e2e-codegood', name: 'E2E 代码插件', version: '1.0.0', entry: 'main.mjs' })
  )
  writeFileSync(join(good, 'main.mjs'), CODE_MAIN)
}

if (codePluginsE2E) {
  const base = join(CODE_UD, 'plugins')
  rmSync(CODE_UD, { recursive: true, force: true })
  writeCodeGoodFixture()
  const bad = join(base, 'e2e-codebad')
  mkdirSync(bad, { recursive: true })
  writeFileSync(
    join(bad, 'manifest.json'),
    JSON.stringify({ id: 'e2e-codebad', name: 'E2E 坏脚本', entry: 'main.mjs' })
  )
  writeFileSync(join(bad, 'main.mjs'), 'const const = broken\n')
  const plain = join(base, 'e2e-plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(
    join(plain, 'manifest.json'),
    JSON.stringify({
      id: 'e2e-plain',
      name: 'E2E 纯声明',
      profiles: [{ id: 'sh', name: 'E2E Plain Shell', command: 'bash', color: '#999999' }]
    })
  )
  const codenet = join(base, 'e2e-codenet')
  mkdirSync(codenet, { recursive: true })
  writeFileSync(
    join(codenet, 'manifest.json'),
    JSON.stringify({
      id: 'e2e-codenet',
      name: 'E2E 网络允许',
      version: '1.0.0',
      entry: 'main.mjs',
      permissions: { connect: [`http://127.0.0.1:${E2E_NET_OK_PORT}`] }
    })
  )
  writeFileSync(join(codenet, 'main.mjs'), "termManager.init('e2e-codenet')\n")
  const codenet2 = join(base, 'e2e-codenet2')
  mkdirSync(codenet2, { recursive: true })
  writeFileSync(
    join(codenet2, 'manifest.json'),
    JSON.stringify({
      id: 'e2e-codenet2',
      name: 'E2E 网络拒绝',
      version: '1.0.0',
      entry: 'main.mjs',
      permissions: { connect: [`http://127.0.0.1:${E2E_NET_BAD_PORT}`] }
    })
  )
  writeFileSync(join(codenet2, 'main.mjs'), "termManager.init('e2e-codenet2')\n")
  app.setPath('userData', CODE_UD)
}

if (!isolatedRun && !app.requestSingleInstanceLock({ openDir: cliOpenDir ?? null })) {
  // 第二实例：目录已通过 additionalData 带给首实例，自己直接退出
  app.quit()
} else {
  if (!isolatedRun) {
    app.on('second-instance', (_e, argv, _wd, additionalData) => {
      const data = additionalData as { openDir?: string | null } | undefined
      enqueueOpenDir(data?.openDir ?? extractOpenDir(argv))
      focusMainWindow()
    })
  }

  app.whenReady().then(async () => {
    registry.load()
    settingsStore.load()
    sessionStore.load()
    themes.load()
    pluginPerms.load()
    pluginState.load()
    plugins.load()
    // 启动即按存档主题定向：dark/light 覆盖，system 交给系统偏好；
    // 必须在 createWindow 之前，窗口装饰（darkTheme）取的是此刻的有效值
    nativeTheme.themeSource = settingsStore.get().theme
    registerIpc()
    registerTmplugProtocol()

    const smoke = argvHas('--smoke')
    const e2eTabs = argvFlag('--e2e-tabs')

    // 附着候选：上次退出保留的会话（属主进程已死 + socket 在）。smoke/e2e 隔离
    // 运行一律全新启动（共享真实 userData 时附着会破坏断言基数并误杀在保会话），
    // 唯 --e2e-session=phase2 是"模拟重启附着"本身
    const attachAllowed = !isolatedRun || sessionE2E === 'phase2'
    const attach = attachAllowed ? sessionStore.attachCandidate() ?? undefined : undefined
    // 遗留服务器清理只在真实 GUI 启动做：会话保持下"pid 死 + socket 在"可能是
    // 在保会话，隔离测试进程不该动它（清理目标也排除本次附着对象）
    if (!isolatedRun) sweepStaleServers(attach?.socketName)

    try {
      if (__E2E__ && smoke) {
        await backend.start()
        await runSmoke()
        return
      }

      createWindow()
      enqueueOpenDir(cliOpenDir)
      const started = backend.start(attach)
      backendStarted = started
      // GUI 路径不 await start：这里挂一个兜底 catch 防止 tmux 缺失时
      // unhandledRejection 刷屏；e2e 路径 await started 仍能拿到失败
      started
        .then((restored) => {
          if (restored.length > 0) restoredTabs = restored
        })
        .catch((e) => console.error('[tmux] backend start failed:', e))

      if (__E2E__ && sessionE2E && mainWindow) {
        const win = mainWindow
        win.webContents.once('did-finish-load', () => {
          void delay(800)
            .then(async () => {
              await started
              if (sessionE2E === 'phase1') await runSessionPhase1(win)
              else await runSessionPhase2(win)
            })
            .catch(async (e) => {
              console.error('E2E_FAIL:', e)
              await backend.dispose().catch(() => undefined)
              app.exit(1)
            })
        })
        return
      }

      if (
        __E2E__ &&
        (e2eTabs ||
          argvHas('--e2e-input') ||
          argvHas('--e2e-sidebar') ||
          argvHas('--e2e-palette') ||
          argvHas('--e2e-search') ||
          argvHas('--e2e-splits') ||
          zoomE2E ||
          linksE2E ||
          profileRefreshE2E ||
          themesE2E ||
          pluginsE2E ||
          codePluginsE2E ||
          webglE2E) &&
        mainWindow
      ) {
        const n =
          argvHas('--e2e-input') ||
          argvHas('--e2e-sidebar') ||
          argvHas('--e2e-palette') ||
          argvHas('--e2e-search') ||
          argvHas('--e2e-splits') ||
          zoomE2E ||
          linksE2E
            ? 2
            : Math.max(1, Number(e2eTabs) || 20)
        const win = mainWindow
        win.webContents.once('did-finish-load', () => {
          void delay(800)
            .then(async () => {
              await started
              if (argvHas('--e2e-input')) await runInputSequence(win)
              else if (argvHas('--e2e-sidebar')) await runSidebarSequence(win)
              else if (argvHas('--e2e-search')) await runSearchSequence(win)
              else if (argvHas('--e2e-splits')) await runSplitsSequence(win)
              else if (zoomE2E) await runZoomSequence(win)
              else if (linksE2E) await runLinksSequence(win)
              else if (argvHas('--e2e-palette')) await runPaletteSequence(win)
              else if (profileRefreshE2E) await runProfileRefreshSequence(win)
              else if (themesE2E) await runThemesSequence(win)
              else if (pluginsE2E) await runPluginsSequence(win)
              else if (codePluginsE2E) await runCodePluginsSequence(win)
              else if (webglE2E) await runWebglSequence(win)
              else await runE2ESequence(win, n)
            })
            .catch(async (e) => {
              console.error('E2E_FAIL:', e)
              await backend.dispose().catch(() => undefined)
              app.exit(1)
            })
        })
      }
    } catch (e) {
      console.error('BOOT_FAIL:', e)
      await backend.dispose().catch(() => undefined)
      app.exit(1)
    }
  })
}

process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION:', e))

// 退出语义：keepSessionOnExit（默认开）= 只 detach 不 kill，tmux 服务器与其上的
// shell 继续存活，下次启动附着恢复；关闭该设置或 Ctrl+Shift+Q 则终结会话退出。
// smoke/e2e 隔离运行一律终结，测试不残留服务器
app.on('window-all-closed', () => {
  if (isolatedRun) {
    void backend.dispose().then(() => app.quit())
    return
  }
  const keep = settingsStore.get().keepSessionOnExit
  if (keep) persistSession() // 渲染层 sync 是 debounce 的，退出前以主进程权威状态兜底落盘
  else sessionStore.clear()
  void backend.dispose({ keep }).then(() => app.quit())
})

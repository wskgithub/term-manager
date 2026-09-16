import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell } from 'electron'
import { execFile } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { ProfileRegistry } from './profiles'
import { SettingsStore, listMonospaceFonts } from './settings'
import { TmuxBackend, type TermInfo } from './tmux'

const registry = new ProfileRegistry()
const settingsStore = new SettingsStore()
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
    // 只放行网页协议：window.open（若有）交给系统浏览器；
    // file:// 等其他 scheme 交给外部处理器没有收益只有面
    try {
      const u = new URL(details.url)
      if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(details.url)
    } catch {
      // 非法 URL：直接拒绝
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let inputEventsAtMain = 0

function registerIpc(): void {
  ipcMain.handle('profiles:list', () => registry.list())

  ipcMain.handle('settings:get', () => settingsStore.get())
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const prev = settingsStore.get().theme
    const next = settingsStore.set(patch)
    // 主题变化同步到 nativeTheme：渲染层 prefers-color-scheme（matchMedia）随之联动
    if (next.theme !== prev) nativeTheme.themeSource = next.theme
    return next
  })
  ipcMain.handle('settings:fonts', () => listMonospaceFonts())

  ipcMain.handle('term:create', (_e, profileId: string, cwd?: unknown) => {
    const profile = registry.get(profileId)
    if (!profile) throw new Error(`profile not found: ${profileId}`)
    return backend.create(profile, existingDir(cwd))
  })

  // 渲染层完成 onOpenDir 订阅后调用：取走排队中的目录并放开后续推送
  ipcMain.handle('cli:ready', (): string[] => {
    rendererReady = true
    return pendingOpenDirs.splice(0)
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

  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) =>
    backend.resize(id, cols, rows)
  )
  ipcMain.on('term:kill', (_e, id: string) => backend.kill(id))
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
// 大流量中文输出不应因 %output 跨 chunk 解码出现 U+FFFD

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

async function pressKey(
  win: BrowserWindow,
  keyCode: string,
  modifiers: ('ctrl' | 'shift')[] = []
): Promise<void> {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
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

  const allOk = !results.some((r) => r.startsWith('FAIL:'))
  console.log('E2E_INPUT_RESULT ' + JSON.stringify({ ok: allOk, results }))
  if (argvHas('--e2e-quit')) {
    await backend.dispose()
    app.exit(allOk ? 0 : 1)
  }
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

// smoke / e2e 属于独立测试进程，不能和正在运行的 GUI 实例抢单实例锁
const isolatedRun =
  argvHas('--smoke') || argvFlag('--e2e-tabs') !== undefined || argvHas('--e2e-input')
const cliOpenDir = extractOpenDir(process.argv)

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
    // 启动即按存档主题定向：dark/light 覆盖，system 交给系统偏好；
    // 必须在 createWindow 之前，窗口装饰（darkTheme）取的是此刻的有效值
    nativeTheme.themeSource = settingsStore.get().theme
    registerIpc()

    const smoke = argvHas('--smoke')
    const e2eTabs = argvFlag('--e2e-tabs')

    try {
      if (smoke) {
        await backend.start()
        await runSmoke()
        return
      }

      createWindow()
      enqueueOpenDir(cliOpenDir)
      const started = backend.start()
      // GUI 路径不 await start：这里挂一个兜底 catch 防止 tmux 缺失时
      // unhandledRejection 刷屏；e2e 路径 await started 仍能拿到失败
      started.catch((e) => console.error('[tmux] backend start failed:', e))

      if ((e2eTabs || argvHas('--e2e-input')) && mainWindow) {
        const n = argvHas('--e2e-input') ? 2 : Math.max(1, Number(e2eTabs) || 20)
        const win = mainWindow
        win.webContents.once('did-finish-load', () => {
          void delay(800)
            .then(async () => {
              await started
              if (argvHas('--e2e-input')) await runInputSequence(win)
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

app.on('window-all-closed', () => {
  void backend.dispose().then(() => app.quit())
})

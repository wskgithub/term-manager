import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1e1e2e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (process.env.E2E_DEBUG) console.log('[renderer]', message)
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
  ipcMain.handle('settings:set', (_e, patch: unknown) => settingsStore.set(patch))
  ipcMain.handle('settings:fonts', () => listMonospaceFonts())

  ipcMain.handle('term:create', (_e, profileId: string) => {
    const profile = registry.get(profileId)
    if (!profile) throw new Error(`profile not found: ${profileId}`)
    return backend.create(profile)
  })

  ipcMain.on('term:input', (_e, id: string, data: string) => {
    inputEventsAtMain++
    backend.write(id, data)
  })
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

  // 设置页截图（--e2e-settings）：打开 → 截图 → 关闭
  if (argvHas('--e2e-settings')) {
    await win.webContents.executeJavaScript('window.__e2eSettings && window.__e2eSettings(true)', true)
    await delay(500)
    await snap('05-settings')
    await win.webContents.executeJavaScript('window.__e2eSettings && window.__e2eSettings(false)', true)
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

app.whenReady().then(async () => {
  registry.load()
  settingsStore.load()
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
    const started = backend.start()

    if (e2eTabs && mainWindow) {
      const n = Math.max(1, Number(e2eTabs) || 20)
      const win = mainWindow
      win.webContents.once('did-finish-load', () => {
        void delay(800)
          .then(async () => {
            await started
            await runE2ESequence(win, n)
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

process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION:', e))

app.on('window-all-closed', () => {
  void backend.dispose().then(() => app.quit())
})

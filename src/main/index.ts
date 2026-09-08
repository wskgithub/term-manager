import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { ProfileRegistry } from './profiles'
import { PtyManager } from './pty'

const registry = new ProfileRegistry()
const ptyManager = new PtyManager((channel, ...args) => {
  mainWindow?.webContents.send(channel, ...args)
})

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

function registerIpc(): void {
  ipcMain.handle('profiles:list', () => registry.list())

  ipcMain.handle('term:create', (_e, profileId: string) => {
    const profile = registry.get(profileId)
    if (!profile) throw new Error(`profile not found: ${profileId}`)
    return ptyManager.create(profile)
  })

  ipcMain.on('term:input', (_e, id: string, data: string) => ptyManager.write(id, data))
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) =>
    ptyManager.resize(id, cols, rows)
  )
  ipcMain.on('term:kill', (_e, id: string) => ptyManager.kill(id))
}

// 冒烟测试：不经 GUI 直接验证 node-pty 链路（spawn shell → 写入命令 → 读回输出）
async function runSmoke(): Promise<void> {
  const marker = 'SMOKE_PTY_42'
  try {
    const profile = registry.list()[0]
    let buf = ''
    let settled = false
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting shell output')), 15000)
      const s = ptyManager.create(profile, {
        onData: (data) => {
          buf += data
          if (!settled && buf.includes(marker)) {
            settled = true
            clearTimeout(timer)
            resolve()
          }
        },
        onExit: () => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(new Error(`shell exited early, tail=${JSON.stringify(buf.slice(-300))}`))
          }
        }
      })
      setTimeout(() => s.write(`echo ${marker}\r`), 500)
    })
    await done
    console.log('SMOKE_OK: node-pty spawn + read/write verified')
    app.quit()
  } catch (err) {
    console.error('SMOKE_FAIL:', err)
    app.exit(1)
  }
}

app.whenReady().then(() => {
  registry.load()
  registerIpc()
  createWindow()
  if (process.argv.includes('--smoke')) void runSmoke()
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  app.quit()
})

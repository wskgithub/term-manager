import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  PluginInfo,
  Profile,
  RestoredSession,
  SessionUiSync,
  TermInfo,
  ThemeDef
} from '../shared/types'

export type { RestoredSession, SessionUiSync } from '../shared/types'

const api = {
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:fonts'),
  listThemes: (): Promise<ThemeDef[]> => ipcRenderer.invoke('themes:list'),
  listPlugins: (): Promise<PluginInfo[]> => ipcRenderer.invoke('plugins:list'),
  // Tier 2 权限批准：origins = 授权的 origin 列表（须 ⊆ manifest 声明），
  // null = 拒绝。落盘后由渲染层重挂插件 iframe（新合成页的 CSP 才含授权）
  grantPluginPermission: (id: string, origins: string[] | null): Promise<void> =>
    ipcRenderer.invoke('plugins:grant-perm', id, origins),
  // 管理 UI：禁用开关（禁用 = 贡献清空 + 代码帧拆除，plugin-state.json 持久化）
  setPluginEnabled: (id: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('plugins:set-enabled', id, enabled),
  // 管理 UI：清除权限决策（「重新询问」），下次扫描重新弹批准框
  resetPluginPermission: (id: string): Promise<void> =>
    ipcRenderer.invoke('plugins:reset-perm', id),
  // 管理 UI：在文件管理器打开插件根目录，返回 {path, error?}
  openPluginsDir: (): Promise<{ path: string; error?: string }> =>
    ipcRenderer.invoke('plugins:open-dir'),
  // 管理 UI：插件根目录路径（纯查询，无副作用）
  pluginsDirPath: (): Promise<string> => ipcRenderer.invoke('plugins:dir-path'),
  createTerm: (profileId: string, cwd?: string): Promise<TermInfo> =>
    ipcRenderer.invoke('term:create', profileId, cwd),
  cliReady: (): Promise<string[]> => ipcRenderer.invoke('cli:ready'),
  restoreSession: (): Promise<RestoredSession | null> => ipcRenderer.invoke('session:restore'),
  replayTerm: (id: string): Promise<string> => ipcRenderer.invoke('session:replay', id),
  syncSession: (payload: SessionUiSync): void => ipcRenderer.send('session:sync', payload),
  quitAll: (): void => ipcRenderer.send('session:quit-all'),
  onOpenDir: (cb: (dir: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, dir: string): void => cb(dir)
    ipcRenderer.on('cli:open-dir', handler)
    return () => ipcRenderer.removeListener('cli:open-dir', handler)
  },
  write: (id: string, data: string): void => ipcRenderer.send('term:input', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('term:resize', id, cols, rows),
  kill: (id: string): void => ipcRenderer.send('term:kill', id),
  writeClipboard: (text: string): void => ipcRenderer.send('clipboard:write', text),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  onData: (cb: (id: string, data: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, data: string): void => cb(id, data)
    ipcRenderer.on('term:data', handler)
    return () => ipcRenderer.removeListener('term:data', handler)
  },
  onExit: (cb: (id: string, code: number) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, code: number): void => cb(id, code)
    ipcRenderer.on('term:exit', handler)
    return () => ipcRenderer.removeListener('term:exit', handler)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)

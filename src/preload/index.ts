import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, Profile, TermInfo } from '../shared/types'

const api = {
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:fonts'),
  createTerm: (profileId: string, cwd?: string): Promise<TermInfo> =>
    ipcRenderer.invoke('term:create', profileId, cwd),
  cliReady: (): Promise<string[]> => ipcRenderer.invoke('cli:ready'),
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

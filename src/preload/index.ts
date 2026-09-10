import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProfiles: (): Promise<unknown> => ipcRenderer.invoke('profiles:list'),
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('settings:set', patch),
  listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:fonts'),
  createTerm: (profileId: string): Promise<unknown> =>
    ipcRenderer.invoke('term:create', profileId),
  write: (id: string, data: string): void => ipcRenderer.send('term:input', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('term:resize', id, cols, rows),
  kill: (id: string): void => ipcRenderer.send('term:kill', id),
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

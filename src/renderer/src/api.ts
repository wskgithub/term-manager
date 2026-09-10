export interface Profile {
  id: string
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  color?: string
  // PATH 探测结果：不可用的 shell 在 "+" 菜单里置灰
  available?: boolean
}

export interface AppSettings {
  // 空串 = 自动（Nerd Font 优先，见 fonts.ts）
  fontFamily: string
  fontSize: number
}

export interface TermInfo {
  id: string
  profileId: string
  title: string
  color?: string
}

export interface Api {
  listProfiles(): Promise<Profile[]>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listFonts(): Promise<string[]>
  createTerm(profileId: string, cwd?: string): Promise<TermInfo>
  cliReady(): Promise<string[]>
  onOpenDir(cb: (dir: string) => void): () => void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  onData(cb: (id: string, data: string) => void): () => void
  onExit(cb: (id: string, code: number) => void): () => void
}

export const api: Api = (window as unknown as { api: Api }).api

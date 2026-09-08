export interface Profile {
  id: string
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  color?: string
}

export interface TermInfo {
  id: string
  profileId: string
  title: string
  color?: string
}

export interface Api {
  listProfiles(): Promise<Profile[]>
  createTerm(profileId: string): Promise<TermInfo>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  onData(cb: (id: string, data: string) => void): () => void
  onExit(cb: (id: string, code: number) => void): () => void
}

export const api: Api = (window as unknown as { api: Api }).api

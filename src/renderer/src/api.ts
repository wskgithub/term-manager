// 领域类型（Profile/AppSettings/TermInfo/TabGroup）与主进程同源自 src/shared/types，
// 此处 re-export 供渲染层各组件统一从 './api' 导入
import type {
  AppSettings,
  Profile,
  RestoredSession,
  SessionUiSync,
  TabGroup,
  TermInfo,
  ThemeDef
} from '../../shared/types'

export type {
  AppSettings,
  Profile,
  TermInfo,
  TabGroup,
  RestoredSession,
  SessionUiSync,
  ThemeDef
} from '../../shared/types'
export { DEFAULT_SETTINGS } from '../../shared/types'

// 组调色板（Catppuccin 八色）：作为组头圆点/容器色边使用，深浅主题下均可读
export const GROUP_COLORS = [
  '#f38ba8', // 红
  '#fab387', // 橙
  '#f9e2af', // 黄
  '#a6e3a1', // 绿
  '#94e2d5', // 青
  '#89b4fa', // 蓝
  '#cba6f7', // 紫
  '#f5c2e7', // 粉
]

export const GROUP_COLOR_NAMES = ['红色', '橙色', '黄色', '绿色', '青色', '蓝色', '紫色', '粉色']

// 新组默认名「组 N」：跳过与现有组重名的序号，避免出现两个「组 1」
export function nextGroupName(groups: TabGroup[]): string {
  const names = new Set(groups.map((g) => g.name))
  for (let i = groups.length + 1; ; i++) {
    const name = `组 ${i}`
    if (!names.has(name)) return name
  }
}

// 建组选色：取当前被占用最少的颜色（并列取调色板顺序靠前的）
export function nextGroupColor(groups: TabGroup[]): string {
  const counts = new Map<string, number>()
  for (const g of groups) counts.set(g.color, (counts.get(g.color) ?? 0) + 1)
  return GROUP_COLORS.reduce((best, c) =>
    (counts.get(c) ?? 0) < (counts.get(best) ?? 0) ? c : best
  )
}

export interface Api {
  listProfiles(): Promise<Profile[]>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listFonts(): Promise<string[]>
  listThemes(): Promise<ThemeDef[]>
  createTerm(profileId: string, cwd?: string): Promise<TermInfo>
  cliReady(): Promise<string[]>
  restoreSession(): Promise<RestoredSession | null>
  replayTerm(id: string): Promise<string>
  syncSession(payload: SessionUiSync): void
  quitAll(): void
  onOpenDir(cb: (dir: string) => void): () => void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  writeClipboard(text: string): void
  readClipboard(): Promise<string>
  onData(cb: (id: string, data: string) => void): () => void
  onExit(cb: (id: string, code: number) => void): () => void
}

export const api: Api = (window as unknown as { api: Api }).api

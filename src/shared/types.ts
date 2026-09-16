// 主进程与渲染层共用的领域类型：此前 Profile/AppSettings/TermInfo 在
// main/profiles.ts、main/settings.ts、renderer/api.ts 三处各有一份，靠人肉同步，
// 任何一侧漂移 typecheck 都发现不了。此文件被两侧直接 import，加字段即全链路生效。

export interface Profile {
  id: string
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  color?: string
  // PATH 探测结果：主进程注入，渲染层用它把不可用的 shell 项置灰
  available?: boolean
}

export type ThemeOption = 'dark' | 'light' | 'system'

export interface AppSettings {
  // 空串 = 自动（渲染层解析为 Nerd Font 优先栈，见 renderer/fonts.ts）
  fontFamily: string
  fontSize: number
  // 默认 profile id（对应 profiles.json），空串 = 未设置（+ 打开菜单）。
  // 只做字符串清洗，不校验存在性：profile 列表归 ProfileRegistry 管，
  // 消费方（渲染层）拿不到时自行回退，避免两份配置互相锁死
  defaultProfileId: string
  // 界面主题三态：深/浅/跟随系统。主进程把它映射到 nativeTheme.themeSource，
  // 同时驱动 Linux 窗口装饰（darkTheme）与渲染层 prefers-color-scheme
  theme: ThemeOption
}

// 主进程 settings.ts 的兜底值，渲染层 App 也用它做异步加载前的初值
//（避免终端闪一下默认字体）——两边必须同源
export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: '',
  fontSize: 14,
  defaultProfileId: '',
  theme: 'dark'
}

export interface TermInfo {
  id: string
  profileId: string
  title: string
  color?: string
  // 以下为渲染层 UI 态（固定/分组），主进程不感知，创建后由渲染层补充
  pinned?: boolean
  groupId?: string
}

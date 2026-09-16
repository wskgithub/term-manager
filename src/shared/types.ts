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
  // 退出时保留 tmux 会话（下次启动附着恢复）。Ctrl+Shift+Q 可随时显式终结
  keepSessionOnExit: boolean
  // 组内广播输入总开关（默认关）：开启后组头出现广播开关，广播中的组内
  // 任一标签的键盘输入会同时发往全组。广播态本身不持久化——重启即复位，
  // 避免用户忘记广播开着而误向多台机器输入
  groupBroadcast: boolean
  // 标签分组侧栏树视图（默认关）：开启后左侧显示「组→标签」树形面板并
  // 隐藏顶部标签栏（侧栏承担全部管理）。仅布局偏好，不涉会话数据
  sidebarVisible: boolean
}

// 主进程 settings.ts 的兜底值，渲染层 App 也用它做异步加载前的初值
//（避免终端闪一下默认字体）——两边必须同源
export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: '',
  fontSize: 14,
  defaultProfileId: '',
  theme: 'dark',
  keepSessionOnExit: true,
  groupBroadcast: false,
  sidebarVisible: false
}

export interface TermInfo {
  id: string
  profileId: string
  title: string
  color?: string
  // 以下为渲染层 UI 态（固定/分组），由渲染层经 session:sync 上报、随会话持久化
  pinned?: boolean
  groupId?: string
}

// 标签分组（原渲染层 api.ts 私有，会话持久化后主进程也要读写，提升到共享）
export interface TabGroup {
  id: string
  name: string
  color: string
  collapsed?: boolean
}

// sessions.json 里单个标签的持久化形态：TermInfo 的超集（多 windowId 用于
// 附着时与 tmux list-windows 对账、renamed 保留「手动改名后 shell 标题不再覆盖」语义）
export interface SessionTab {
  id: string
  profileId: string
  title: string
  color?: string
  pinned?: boolean
  groupId?: string
  renamed?: boolean
  windowId: string
}

// 会话恢复数据（session:restore 一次性返回给渲染层）
export interface RestoredSession {
  tabs: TermInfo[]
  groups: TabGroup[]
  activeId: string
  renamed: string[]
}

// 渲染层上报的标签 UI 态快照（session:sync，debounce 合并后全量推送）
export interface SessionUiSync {
  tabs: Array<{
    id: string
    profileId: string
    title: string
    color?: string
    pinned?: boolean
    groupId?: string
    renamed?: boolean
  }>
  groups: TabGroup[]
  activeId: string
}

// sessions.json：应用退出保留会话后，下次启动按
// socketName 重连既有 tmux 服务器、按 tabs[].windowId 对账恢复标签列表
export interface PersistedSession {
  version: 1
  socketName: string
  sessionName: string
  ownerPid: number
  savedAt: string
  tabs: SessionTab[]
  groups: TabGroup[]
  activeId: string
}

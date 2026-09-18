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

// ── 自定义配色方案（themes 目录数据化）──
// UI 侧可覆盖的 CSS 变量白名单（index.css 的 :root 变量去掉 --shadow-lg——
// 完整 box-shadow 串无法安全校验，维持按深浅内建；color-scheme 非变量）
export type ThemeUiVar =
  | 'bg'
  | 'bg-deep'
  | 'bg-inset'
  | 'surface'
  | 'surface-hover'
  | 'text'
  | 'text-bright'
  | 'accent'
  | 'warn'
  | 'hairline'
  | 'hover-wash'
  | 'menu-bg'
  | 'kbd'
  | 'kbd-strong'
  | 'thumb'
  | 'thumb-hover'
  | 'thumb-active'

// 终端侧可覆盖的 xterm 颜色键（前景/光标/选区 + ANSI 16 色），键名与 ITheme 对齐
export type ThemeColorKey =
  | 'background'
  | 'foreground'
  | 'cursor'
  | 'cursorAccent'
  | 'selectionBackground'
  | 'selectionForeground'
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'

// themes/*.json 的文件形态：type 声明归属深/浅（跟随系统切换在两端各自生效），
// ui/terminal 均可缺省——缺省字段继承同侧内建（UI 靠 CSS 级联，终端靠解析时显式合并）
export interface ThemeFile {
  name: string
  type: 'dark' | 'light'
  ui?: Partial<Record<ThemeUiVar, string>>
  terminal?: Partial<Record<ThemeColorKey, string>>
}

// 加载后的完整方案：id 来自文件名 stem（内建为 mocha/latte）
export interface ThemeDef extends ThemeFile {
  id: string
  builtin: boolean
}

// ── 声明式插件（plugins 目录 manifest，零代码执行零网络）──
// 面板命令可映射的动作词汇：封闭集合，launch 的 profile 引用主进程侧注册表
// 解析（渲染层永远只传 id，不传命令体——term:create 不开新 spawn 面）
export type PluginAction =
  | { type: 'launch'; profile: string }
  | { type: 'open-settings' }
  | { type: 'toggle-sidebar' }
  | { type: 'set-theme'; mode: ThemeOption }
  | { type: 'set-scheme'; id: string }

// manifest 里的命令条目（id 为插件内局部 id，主进程校验后原样下发）
export interface PluginCommandDef {
  id: string
  label: string
  keywords?: string
  hint?: string
  action: PluginAction
}

// plugins:list 下发的插件信息：profiles 的 id 已重写为「插件id:局部id」防与
// 用户 profiles.json 撞车；themes 的 id 已命名空间化为「插件id/stem」
export interface PluginInfo {
  id: string
  name: string
  version?: string
  profiles: Profile[]
  commands: PluginCommandDef[]
  themes: ThemeDef[]
  // 代码级插件入口（L3）：相对插件目录的 .js/.mjs 路径。Tier 2 下渲染层为它
  // 创建 tmplug:// 沙箱 iframe（隔离宿主），entry 经查询参数传给合成宿主页。
  // 缺省 = 纯声明式插件（L2）
  entry?: string
  // manifest 声明的权限（已校验）：主进程据此合成逐插件 CSP，渲染层据此弹批准框
  permissions?: PluginPermissions
  // 权限决策状态（仅带 entry 且声明了 connect 的插件附带）：decided=false 时
  // 渲染层先弹批准框，决策落盘后才挂 iframe（合成的 CSP 取已授权 ∩ 已声明）
  permDecision?: PluginPermDecision
  // 管理 UI 的禁用态（主进程 plugin-state.json 持久化）：禁用 = 声明式贡献清空
  // （profiles/commands/themes 置 []）+ 代码帧拆除（渲染层 loadCodePlugins 处理）；
  // entry/permissions/permDecision 保留，设置页的插件卡片仍要展示它们
  disabled?: boolean
}

// ── 代码级插件（L3 Tier 2：沙箱 iframe 隔离宿主）──
// 每个代码插件跑在独立的 sandbox iframe 里（tmplug://<id>/ 每插件独立 origin），
// 浏览器沙箱保证它碰不到宿主页面的 DOM 与 window.api——唯一通道是桥上显式
// 暴露的 termManager API（postMessage RPC）。逐插件 CSP 默认零网络；插件用
// manifest 声明的权限换放行（用户批准后合成页的 connect-src 才含该 origin）。
// 脚本样板（在插件 entry 模块里）：const tm = termManager.init('my-plugin')

// manifest 可声明的权限词汇：封闭集合，当前只有网络连接
export interface PluginPermissions {
  /** fetch/XHR/WebSocket 可达的 origin 白名单（https 任意主机；http 仅 localhost） */
  connect?: string[]
}

// 权限决策状态：hosts 是当前 manifest 声明（已校验）的列表（弹窗「允许」的
// 授权全集）；granted 是实授权（已授权 ∩ 当前声明，合成 CSP 的口径）；decided
// 表示已存在针对该列表的决策（拒绝也算）。声明列表变更后 decided 回落 false，
// 重新弹框。denied=true 表示用户明确拒绝过（granted 恒空）
export interface PluginPermDecision {
  hosts: string[]
  granted: string[]
  decided: boolean
  denied?: boolean
}

// 插件可订阅的应用事件（负载按事件名不同）
export type TmPluginEventName =
  | 'tab-created'
  | 'tab-closed'
  | 'tab-activated'
  | 'tab-renamed'
  | 'theme-changed'
  | 'scheme-changed'

export interface TmPluginEvents {
  'tab-created': { id: string; profileId?: string }
  'tab-closed': { id: string }
  'tab-activated': { id: string }
  'tab-renamed': { id: string; title: string }
  'theme-changed': { theme: ThemeOption }
  'scheme-changed': { schemeId: string }
}

// 运行期注册的面板命令（区别于 manifest 的 PluginCommandDef：动作是函数，
// 只存在于渲染层，永不过 IPC）
export interface TmRuntimeCommandDef {
  id: string
  label: string
  keywords?: string
  hint?: string
  run: () => void | Promise<void>
}

// 状态栏项：插件经 statusbar.setItem 放置的展示内容
export interface TmStatusItem {
  text: string
  color?: string
  tooltip?: string
  onClick?: () => void
}

// 状态栏渲染条目（pluginHost 生成、App 消费；onClick 回调留在渲染层注册表内）
export interface TmStatusbarEntry {
  key: string // `${pluginId}:${itemId}`，兼作 e2e data-key
  pluginId: string
  pluginName: string
  text: string
  color?: string
  tooltip?: string
  /** 有 onClick 回调的项才呈可点击样式 */
  clickable?: boolean
}

// termManager.init(pluginId) 返回的命名空间化 API：全部注册物自动归属该插件，
// 卸载（插件目录被删）时一并摘除。Tier 2 隔离宿主下 API 经 postMessage RPC
// 落地，带返回值的方法（registerCommand/registerTheme/tabs.list/tabs.active）
// 为 Promise 形态；事件/数据订阅的取消函数在插件帧内本地生效
export interface TmScopedApi {
  version: '1'
  info: { id: string; name: string; version?: string }
  registerCommand(def: TmRuntimeCommandDef): Promise<boolean>
  unregisterCommand(id: string): void
  /** theme.id 为插件内局部 id，实际注册为「pluginId/id」；格式非法 resolve false */
  registerTheme(theme: ThemeFile & { id: string }): Promise<boolean>
  unregisterTheme(id: string): void
  on<K extends keyof TmPluginEvents>(event: K, cb: (payload: TmPluginEvents[K]) => void): () => void
  tabs: {
    list(): Promise<TermInfo[]>
    active(): Promise<string | undefined>
    activate(id: string): void
    create(profileId?: string, cwd?: string): Promise<TermInfo | undefined>
  }
  ui: {
    setTheme(mode: ThemeOption): void
    setScheme(id: string): void
    toggleSidebar(): void
    openSettings(): void
  }
  terminals: {
    /** 订阅某标签的实时输出流（不含历史回放）；返回取消函数 */
    subscribe(id: string, cb: (data: string) => void): () => void
    /** 向指定标签注入输入（直达 tmux，不走广播扇出） */
    write(id: string, data: string): void
  }
  statusbar: {
    /** item 传 null 删除该项 */
    setItem(itemId: string, item: TmStatusItem | null): void
  }
}

// 插件脚本可见的全局对象（module 脚本直接读全局名 termManager）
export interface TermManagerGlobal {
  version: '1'
  init(pluginId: string): TmScopedApi
}

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
  // 深/浅两端各自的配色方案 id（themes 目录数据化的选择项）：跟随系统时
  // 系统深用 darkTheme、系统浅用 lightTheme，两端独立。只做字符串清洗，
  // 不校验存在性——方案列表归 ThemeRegistry 管，渲染层解析不到时回退内建
  darkTheme: string
  lightTheme: string
  // 退出时保留 tmux 会话（下次启动附着恢复）。Ctrl+Shift+Q 可随时显式终结
  keepSessionOnExit: boolean
  // 组内广播输入总开关（默认关）：开启后组头出现广播开关，广播中的组内
  // 任一标签的键盘输入会同时发往全组。广播态本身不持久化——重启即复位，
  // 避免用户忘记广播开着而误向多台机器输入
  groupBroadcast: boolean
  // 标签分组侧栏树视图（默认关）：开启后左侧显示「组→标签」树形面板并
  // 隐藏顶部标签栏（侧栏承担全部管理）。仅布局偏好，不涉会话数据
  sidebarVisible: boolean
  // GPU 渲染（默认开）：终端优先用 WebGL 渲染器（addon-webgl），创建失败
  //（驱动不支持/被开关禁用）或运行中上下文丢失时自动回退 DOM 渲染器，功能
  // 不受影响；关闭后一律 DOM 渲染。即时生效，不重建已开终端
  gpuRendering: boolean
}

// 主进程 settings.ts 的兜底值，渲染层 App 也用它做异步加载前的初值
//（避免终端闪一下默认字体）——两边必须同源
export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: '',
  fontSize: 14,
  defaultProfileId: '',
  theme: 'dark',
  darkTheme: 'mocha',
  lightTheme: 'latte',
  keepSessionOnExit: true,
  groupBroadcast: false,
  sidebarVisible: false,
  gpuRendering: true
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

// 分屏方向：h = 左右并排（tmux split-window -h）、v = 上下堆叠（默认方向）
export type SplitDir = 'h' | 'v'

// 单个 pane 的权威几何（tmux list-panes 的 cell 坐标）：id 是 pane 级 termId，
// 首个 pane 的 termId 恒等于 tabId（与 term:data/term:exit 通道协议一致）。
// x/y/left、cols/rows 为 window 内的绝对 cell 坐标（含 1-cell 分隔缝的占位）
export interface PaneGeom {
  id: string
  x: number
  y: number
  cols: number
  rows: number
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

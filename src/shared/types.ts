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
  // 面板声明（manifest panel 字段，已校验）：带 entry 的插件可把自己的沙箱帧
  // 挂进应用右侧的可开合面板（缺省挂 0 尺寸隐藏容器——面板是帧的唯一可见
  // 形态，帧本体仍常驻 DOM，开合走 CSS 防 realm 重载）
  panel?: PluginPanelDef
  // 来自安装包内置目录（resources/plugins，仓库 plugins-builtin/ 同源）：
  // 仅展示语义（设置页「官方」徽章），能力面与用户插件完全一致；用户在
  // userData/plugins 放同 id 插件可整体覆盖内置副本
  builtin?: boolean
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

// manifest 可声明的权限词汇：封闭集合——网络连接与本地文件系统
export interface PluginPermissions {
  /** fetch/XHR/WebSocket 可达的 origin 白名单（https 任意主机；http 仅 localhost） */
  connect?: string[]
  /** 本地文件系统访问档位：read（列目录/读内容）与 write（写/建/改名/入回收站） */
  fs?: PluginFsScope[]
}

// fs 权限档位：read 涵盖 list/stat/readText/readBase64，write 涵盖
// write/mkdir/rename/trash。文件管理器类插件需要全盘寻址（跟随终端 cwd），
// 授权粒度是档位而非目录白名单——删除只走回收站（可逆）是对 write 档位的
// 固定收敛，不提供真删
export type PluginFsScope = 'read' | 'write'

// manifest 的面板声明（已校验）
export interface PluginPanelDef {
  /** 面板标题（面板 header 展示，≤40 字符） */
  title: string
  /** 标题图标：相对插件目录的 .svg/.png（≤256KB），经 tmplug:// 静态服务 */
  icon?: string
}

// 权限决策状态：hosts 是当前 manifest 声明（已校验）的列表（弹窗「允许」的
// 授权全集）；granted 是实授权（已授权 ∩ 当前声明，合成 CSP 的口径）；decided
// 表示已存在针对该列表的决策（拒绝也算）。声明列表变更后 decided 回落 false，
// 重新弹框。denied=true 表示用户明确拒绝过（granted 恒空）。fs 与 connect 同
// 一套语义：允许 = 声明全集一次授予（弹窗二选一，无逐项勾选），fsGranted
// 是 fs 侧的实授权（fs gate 的口径）
export interface PluginPermDecision {
  hosts: string[]
  granted: string[]
  fs: PluginFsScope[]
  fsGranted: PluginFsScope[]
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

// ── 插件 fs API 的结果形状（主进程 pluginFs.ts 产出、帧内消费）──
// 全部字段主进程侧清洗防御后下发：路径绝对、大小/条数上限截断并标记。

export type FsEntryKind = 'dir' | 'file' | 'symlink' | 'other'

export interface FsEntry {
  name: string
  kind: FsEntryKind
  /** 字节数（目录为 0；symlink 为链接本身大小） */
  size: number
  /** 修改时间（epoch ms） */
  mtime: number
}

export interface FsListResult {
  path: string
  entries: FsEntry[]
  /** 单目录条数上限（20000）截断时为 true——大目录应提示用户改用过滤 */
  truncated: boolean
}

export interface FsStat {
  path: string
  kind: FsEntryKind
  size: number
  mtime: number
  /** symlink 的指向（readlink 原文，不解析） */
  target?: string
}

export interface FsTextResult {
  text: string
  size: number
  truncated: boolean
}

export interface FsBlobResult {
  /** base64（无 data: 前缀，帧内自行拼 MIME） */
  data: string
  size: number
  truncated: boolean
}

/** fs 通道的 IPC 形状（永不 reject，错误在 ok:false 里） */
export type FsCallShape = { ok: true; value: unknown } | { ok: false; error: string }

/** HostSnapshot.panels 条目：面板 header 切换器的展示数据 */
export interface TmPanelEntry {
  pluginId: string
  /** 插件名（fallback 展示） */
  name: string
  /** manifest panel.title */
  title: string
  /** manifest panel.icon（渲染为 tmplug://<id>/<icon>） */
  icon?: string
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
    /** 当前配色方案的关键 CSS 变量色值（17 个 ui 键 → 颜色串）：面板类插件
     *  自绘 UI 的主题适配数据源，scheme-changed 事件后重拉 */
    colors(): Promise<Partial<Record<string, string>>>
  }
  terminals: {
    /** 订阅某标签的实时输出流（不含历史回放）；返回取消函数 */
    subscribe(id: string, cb: (data: string) => void): () => void
    /** 向指定标签注入输入（直达 tmux，不经广播扇出） */
    write(id: string, data: string): void
    /** 标签活动 pane 的当前工作目录（tmux pane_current_path）；标签不存在
     *  或后端查询失败 resolve undefined（文件面板「跟随终端」的数据源） */
    cwd(id: string): Promise<string | undefined>
  }
  fs: {
    /** 列目录（目录优先排序在插件侧做，这里只给原始 stat 数据） */
    list(path: string): Promise<FsListResult>
    stat(path: string): Promise<FsStat>
    /** 读文本（≤2MB 截断；前 8KB 含 NUL 判二进制拒绝） */
    readText(path: string): Promise<FsTextResult>
    /** 读二进制为 base64（≤8MB 截断；图片预览用） */
    readBase64(path: string): Promise<FsBlobResult>
    /** 覆盖/新建文件（内容 ≤1MB；父目录必须已存在） */
    write(path: string, content: string): Promise<void>
    /** 建目录（递归） */
    mkdir(path: string): Promise<void>
    /** 改名/移动（目标已存在即拒绝，防覆盖） */
    rename(from: string, to: string): Promise<void>
    /** 移入系统回收站（唯一的删除通路，不提供真删） */
    trash(path: string): Promise<void>
  }
  panel: {
    /** 请求宿主收起面板并归还终端焦点（帧内 Esc 语义；非面板插件调用为空操作） */
    close(): void
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

// ── AI Agent CLI（终端右键子菜单 / Nautilus 右键子菜单的启动目标）──
// 内置注册表单源是 src/shared/agents.json：主进程 TS 直接 import，Nautilus
// python 扩展读 deb/rpm 装到 /usr/share/nautilus-python/extensions/ 的同一份
// （fpm 原样拷贝），三端零漂移。此处只放跨进程类型，探测逻辑归 main/agents.ts
export interface CustomAgent {
  id: string
  name: string
  // 启动命令（首项 + 参数）：字符集白名单在 settings.ts sanitize（禁 shell 元字符）
  argv: string[]
}

// agents:list 下发条目：命令体（argv）不出主进程——渲染层只拿展示与可用性
export interface AgentEntry {
  id: string
  name: string
  builtIn: boolean
  // 可执行文件可寻址（$PATH + agents.json 的 extraBinDirs）
  available: boolean
  resolvedPath: string | null
  // 本机有使用痕迹（hintDirs 配置目录存在）：仅用于排序/设置页提示，不参与 available
  usedHint: boolean
}

// cli:open-dir / cli:ready 的排队请求：agentId 存在 = 在 dir 启动该 agent
//（Nautilus 子菜单 / CLI --agent=），否则 = 原有「打开目录」语义
export interface OpenDirRequest {
  dir: string
  agentId?: string
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
  // 终端程序写系统剪贴板（OSC 52，默认开）：任意 pane 内程序（含 ssh 远端
  // 经转发到达的序列）输出的 OSC 52 可把文本写入系统剪贴板——ssh 远程复制
  // 的主通路。有 1MB 解码上限防滥用；读方向（'?' 查询）一律不响应，剪贴板
  // 内容不外流。即时生效，不重建已开终端
  osc52Copy: boolean
  // 自定义 AI Agent 条目（设置页增删）：id 由渲染层生成（c- 前缀），与内置
  // 注册表合并后进「启动 AI Agent」子菜单；Nautilus 右键子菜单也会读它
  customAgents: CustomAgent[]
  // 被隐藏的 agent id（内置或自定义）：不出现在子菜单（设置页可再开）
  hiddenAgents: string[]
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
  gpuRendering: true,
  osc52Copy: true,
  customAgents: [],
  hiddenAgents: []
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
  // 窗格放大态（resize-pane -Z）：只标在被放大的 pane 上（tmux 侧 window 级
  // zoom 标志 ∩ 活跃 pane）。zoomed pane 的几何是满铺值（0,0,cols,rows = 窗口
  // 总尺寸），其余 pane 保留原布局几何供退出放大时还原
  zoomed?: boolean
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

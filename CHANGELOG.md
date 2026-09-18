# Changelog / 更新日志

All notable changes to Term Manager are documented in this file.
本项目的所有重要变更都记录在此文件中。

## Unreleased

### English

- **Pane zoom** (`Ctrl+Shift+Enter`): temporarily maximize the active pane to fill its
  tab (tmux `resize-pane -Z`); the same shortcut restores the exact previous layout.
  Hidden panes stay alive with their buffers; zoom state lives in the tmux server, so
  it survives session keep-and-restore. Navigating away, splitting or closing the
  zoomed pane zooms out automatically (tmux semantics); a small corner badge reminds
  you that you are zoomed and how to leave (the focus outline would be hidden by the
  full-bleed terminal). Also in the terminal
  context menu and the command palette. Covered by the new `--e2e-zoom` suite
  (11 assertions: toggle paths, full-tab geometry, input delivery and focus
  retention, tab-switch round-trip, exact restore, auto-unzoom on navigation,
  close-while-zoomed, single-pane guard) plus a zoom step and restore assertion in
  the session two-phase suite.
- **Split panes**: `Ctrl+Shift+D` / `Ctrl+Shift+E` split the active pane side by side /
  stacked (iTerm convention, nests freely); the new pane runs the tab's profile,
  inherits the source pane's working directory and takes focus. `Ctrl+Alt+Arrow keys`
  (or a click) move focus between panes, the focused pane is outlined, separators are
  drag-resizable, and `Ctrl+Shift+W` degrades gracefully (close pane when several
  remain — even on pinned tabs — close the tab for the last one). The tmux server is
  the single source of truth for layout: the renderer only reports the window size,
  pane rectangles arrive via `%layout-change` reconciled through `list-panes`, which
  doubles as pane-death detection on tmux 3.2a (no pane-died notification there).
  Splits survive session keep-and-restore, layout included. Covered by the new
  `--e2e-splits` suite (22 assertions) and three new session-phase2 assertions.
- **Terminal buffer search** (`Ctrl+Shift+F`): a find bar for the active terminal's
  buffer, scrollback included. All matches are highlighted (decoration layer) with an
  `i/n` counter; `Enter` / `Shift+Enter` jump between matches, `Esc` closes and returns
  focus to the terminal. Case-sensitive, whole-word and regex toggles; re-runs on the
  new terminal when switching tabs while open; remembers the last query. The shortcut
  deliberately avoids `Ctrl+F` so the readline forward-char binding keeps reaching the
  shell. Covered end-to-end by the new `--e2e-search` suite (23 assertions, including
  both shortcut paths, scrollback jumps and the focus hand-back).
- **Plugin management UI** (Settings → *Plugins*): every installed plugin appears as a
  card (name, version, declarative / code-level type) with an **enable toggle** —
  disabling immediately removes all of its contributions (profiles, commands, themes)
  and destroys its sandbox frame; the state persists across restarts
  (`plugin-state.json`). Code-level plugins that declared network permissions list each
  origin with its granted state, plus a **re-ask** button that clears the stored
  decision and re-shows the approval dialog (the frame is torn down first, so the CSP
  of the rebuilt frame always matches the new decision). The plugins directory path is
  shown with an open-directory button. `--e2e-code-plugins` grew six management
  assertions (24 total) covering cards, disable/enable round-trips, declarative
  contribution removal and CSP tightening after re-ask.

### 中文

- **窗格放大**（`Ctrl+Shift+Enter`）：把活跃 pane 临时放大铺满整个标签（tmux
  `resize-pane -Z`），再按一次还原到放大前的精确布局。被遮住的 pane 保持存活、
  缓冲不丢；放大态存于 tmux server，随会话保持与恢复存活。导航离开、分屏、
  关闭被放大的 pane 都会自动退出放大（tmux 语义）；角落的轻量徽标提示「已
  放大」与退出方式（满铺终端会盖住 pane 边框，边框做不了提示）。终端右键菜
  单与命令面板同入口。新增 `--e2e-zoom` 套件覆盖（11 条断言：toggle 通路、满
  铺几何、输入落点
  与焦点保持、切标签往返、精确还原、导航自动退出放大、放大态关 pane、单 pane
  守卫），另会话双相套件加放大步骤与恢复断言。
- **分屏**：`Ctrl+Shift+D` / `Ctrl+Shift+E` 向右 / 向下分屏（iTerm 惯例，可任意
  嵌套）；新 pane 跑标签的 profile、继承源 pane 工作目录并获得焦点。`Ctrl+Alt+
  方向键`（或点击）在 pane 间移动焦点，焦点 pane 带描边，分隔条可拖拽调比例，
  `Ctrl+Shift+W` 优雅降级（多 pane 关 pane——固定标签也允许，最后一个恢复关
  标签）。布局唯一权威是 tmux server：渲染层只上报 window 尺寸，pane 矩形经
  `%layout-change` + `list-panes` 对账回推，这同时是 tmux 3.2a 上 pane 死亡的
  检测通路（该版本无 pane 死亡通知）。分屏随会话保持与恢复存活（含布局）。
  新增 `--e2e-splits` 套件（22 断言）与会话 phase2 三条新断言覆盖。
- **终端缓冲区搜索**（`Ctrl+Shift+F`）：针对当前终端缓冲区的查找框，**含滚动回溯**。
  全部匹配高亮（装饰层）并显示 `i/n` 计数；`Enter` / `Shift+Enter` 在匹配间跳转，
  `Esc` 关闭并归还终端焦点。支持区分大小写、全字与正则三个开关；开框状态下切标签
  即在新终端重跑；记住上次查询词。快捷键刻意避开 `Ctrl+F`，readline 的前移字符
  绑定原样直达 shell。新增 `--e2e-search` 套件端到端覆盖（23 条断言：双快捷键通路、
  回溯跳转与焦点归还等）。
- **插件管理 UI**（设置 → 插件）：每个已装插件一张卡片（名称、版本、声明式/代码级
  类型）带**启用开关**——禁用即时移除其全部贡献（profile、命令、主题）并销毁沙箱帧，
  状态跨重启保留（`plugin-state.json`）。声明了网络权限的代码级插件逐条列出 origin
  与授权状态，并有**重新询问**按钮：清除已存决策、先拆帧再重弹批准框（重建帧的 CSP
  恒与新决策一致）。插件目录路径旁有「打开目录」按钮。`--e2e-code-plugins` 新增六条
  管理断言（共 24 条），覆盖卡片、禁用/启用往返、声明式贡献移除与重问后的 CSP 收紧。

## 0.2.0 — 2026-09-17

### English

- **Code-level plugins upgraded to the Tier 2 isolated host**: every code plugin now
  runs in its own sandboxed iframe (a unique `tmplug://` origin per plugin). The browser
  sandbox keeps plugins away from the UI DOM and `window.api` — the `termManager` API
  (over a postMessage RPC bridge) becomes the entire capability surface.
- **Declared network permissions**: manifests may declare a `permissions.connect`
  origin allow-list; the first load shows an approval dialog (allow / deny, Esc = deny).
  Approved origins enter the plugin frame CSP's `connect-src`; changing the declared
  list re-prompts. The per-plugin CSP starts at zero network.
- **Plugins truly unload**: deleting the plugin folder destroys the sandbox frame and
  all registrations (previously resident JS required a restart).
- API semantic change: value-returning methods (`registerCommand` / `registerTheme` /
  `tabs.list` / `tabs.active`) resolve Promises under the isolated host; plugins get
  localStorage on their own origin (no longer shared with the app).
- **New package formats**: one `npm run dist` now produces **AppImage** (portable,
  no install; bring your own tmux) and **rpm** (Fedora / RHEL family, Requires includes
  tmux) alongside the deb; CI builds all three and attaches them as artifacts.

### 中文

- **代码级插件升级为 Tier 2 隔离宿主**：每个代码插件运行在独立的沙箱 iframe 里
  （`tmplug://` 每插件独立 origin），浏览器沙箱保证插件碰不到界面 DOM 与
  `window.api`——`termManager` API（postMessage RPC 桥）成为全部能力面。
- **声明式网络权限**：manifest `permissions.connect` 声明 origin 白名单，首次加载
  弹批准框（允许/拒绝，Esc=拒绝）；批准后进插件帧 CSP 的 `connect-src`，改声明
  列表会重新询问。默认逐插件 CSP 零网络。
- **插件真正可卸载**：删除插件文件夹即销毁沙箱帧与全部注册物（此前驻留 JS 须重启）。
- API 语义变化：带返回值的方法（`registerCommand` / `registerTheme` /
  `tabs.list` / `tabs.active`）在隔离宿主下返回 Promise；插件获得自己 origin 的
  localStorage（不再与应用共享）。
- **新增打包格式**：一次 `npm run dist` 产出 **AppImage**（免安装便携版，tmux 自备）与
  **rpm**（Fedora / RHEL 系，Requires 含 tmux），与 deb 并列；CI 构建三格式并作为
  artifact 附带。

## 0.1.0 — 2026-09-17

First public release. / 首个公开发布的版本。

### English

**Terminals & tabs**

- Multiple tabs: click to switch, drag-and-drop reordering, double-click rename
  (title-override semantics), close with grayed-out process tracking.
- Pinned tabs and colored tab groups (rename, per-group color, collapse/expand);
  a group-sidebar tree view as a vertical alternative to the tab bar.
- Per-group broadcast input: type into every terminal of a group at once
  (settings toggle, works at tab granularity).
- Session persistence built on a tmux Control Mode backend: closing the window
  keeps sessions alive; relaunching re-attaches and restores tabs.
- Profile system: the `+` menu lists locally available shells (bash / zsh /
  fish / pwsh / Docker shell), extensible with any command via `profiles.json`.

**Appearance**

- Dark / light / follow-system themes, with the native titlebar following in
  real time.
- Custom themes as data files: UI colors and 22 terminal colors, partial
  declarations inherit from the built-in theme of the same side.
- Settings page: font picker (monospace fonts enumerated via fontconfig), font
  size, theme controls.
- GPU rendering via xterm addon-webgl by default, automatic DOM-renderer
  fallback on failure.

**Extensibility**

- Command palette (`Ctrl+Shift+P`): fuzzy search over tabs, profiles and
  commands.
- Declarative plugins: drop a `manifest.json` into the plugins directory to
  contribute profiles, palette commands and theme packs — no code required.
- Code-level plugin API (Tier 1): a plugin `entry` module loaded via the
  `tmplug://` protocol with the `termManager` API (commands, dynamic themes,
  events, tabs, terminal read/write, status-bar items). A strict CSP
  (`connect-src 'none'` in production) technically enforces the zero-network
  principle for both the app and plugins.

**Packaging & desktop integration**

- deb packaging: desktop entry, icons and dependency metadata included.
- Nautilus context-menu integration: "Open in Term Manager" plus single-instance
  window reuse.

**Engineering**

- CI (typecheck + smoke) on every push and PR; E2E suites covering input
  focus, tabs, settings, themes, plugins and code-level plugins; deep security
  audits with all dependency advisories resolved.

### 中文

**终端与标签**

- 多标签：点击切换、拖拽排序、双击重命名（标题覆盖语义）、关闭时进程灰显跟踪。
- 固定标签与彩色标签分组（重命名、组色、折叠/展开）；分组侧栏树视图作为标签栏的
  纵向替代。
- 分组广播输入：一次输入同时打进组内所有终端（设置页开关，标签粒度）。
- 基于 tmux Control Mode 后端的会话持久化：关窗不杀会话，重新启动自动附着并恢复
  标签。
- Profile 体系：`+` 菜单列出本机可用的 shell（bash / zsh / fish / pwsh /
  Docker shell），经 `profiles.json` 可扩展为任意命令。

**外观**

- 深色 / 浅色 / 跟随系统三态主题，原生标题栏实时跟随。
- 自定义主题即数据文件：UI 颜色 + 22 个终端配色，部分声明自动继承同侧内建主题。
- 设置页：字体选择（fontconfig 枚举等宽字体）、字号、主题控制。
- 默认启用 xterm addon-webgl 的 GPU 渲染，失败时自动回退 DOM 渲染器。

**扩展性**

- 命令面板（`Ctrl+Shift+P`）：标签、profile 与命令的模糊搜索执行。
- 声明式插件：向插件目录放入 `manifest.json` 即可贡献 profile、面板命令与主题包，
  无需写代码。
- 代码级插件 API（Tier 1）：插件 `entry` 模块经 `tmplug://` 协议加载，获得
  `termManager` API（命令、动态主题、事件、标签、终端读写、状态栏项）；生产环境
  严格 CSP（`connect-src 'none'`）把零网络原则升级为对应用与插件的技术强制。

**打包与桌面集成**

- deb 打包：含 desktop entry、图标与依赖元数据。
- Nautilus 右键菜单集成：「在 Term Manager 中打开」+ 单实例窗口复用。

**工程**

- 每次 push / PR 跑 CI（typecheck + smoke）；E2E 套件覆盖输入焦点、标签、设置、
  主题、插件与代码级插件；深度安全审计，依赖通告全部清零。

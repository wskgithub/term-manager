# Changelog / 更新日志

All notable changes to Term Manager are documented in this file.
本项目的所有重要变更都记录在此文件中。

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

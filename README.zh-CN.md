# Term Manager

[![CI](https://github.com/wskgithub/term-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/wskgithub/term-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**简体中文** | [English](README.md)

Linux 桌面终端管理器：多标签 + 重命名 + 拖拽排序 + 多 profile（定位类似 Windows Terminal）。
管理器负责标签/profile/进程生命周期；终端仿真复用 [xterm.js](https://github.com/xtermjs/xterm.js)（VS Code 同款组件）；
PTY 由 **tmux Control Mode 后端**托管（WindTerm/iTerm2 同款架构，会话保持是天然红利）。

## 界面

![主视图：多标签 + 重命名 + profile 混用](docs/screenshots/main-dark.png)

![标签分组与固定](docs/screenshots/tab-groups.png) ![＋ 下拉菜单：shell profile 选择](docs/screenshots/newtab-menu.png)

![分组侧栏树视图](docs/screenshots/sidebar-tree.png) ![设置页（浅色主题）](docs/screenshots/settings-light.png)

截图由 E2E 基础设施真实驱动 UI 生成（CDP 点击菜单/重命名/粘贴命令，非摆拍拼图）。

## 技术栈

- Electron 44 + TypeScript（主进程管后端/配置，渲染进程管 UI）
- Vite（electron-vite）+ React
- `@xterm/xterm` 仿真组件
- 后端：`tmux -C` 控制模式（私有 socket，每标签一个 tmux 窗口，输入走 `send-keys`，输出走 `%output` 事件流）
- profile 存储为 JSON（首次启动生成于 `~/.config/term-manager/profiles.json`），应用设置存于同目录 `settings.json`

## profile 模型

`+` 下拉菜单模仿 Windows Terminal：列出的是** shell 类型**（bash、zsh、fish、pwsh、Docker Shell），
而不是机器分类。首次启动时主进程按 `PATH` 探测候选 shell（用户登录 shell `$SHELL` 排最前），
未安装的 shell 自动剔除；菜单里不可用项置灰。`profiles.json`（`{ "version": 2, "profiles": [...] }`）
可自由新增任意 profile，例如 ssh 远程机器：

```json
{
  "version": 2,
  "profiles": [
    { "id": "gpu-27", "name": "GPU 机器", "command": "ssh", "args": ["user@192.168.1.100"], "color": "#aed581" }
  ]
}
```

旧版（v1，无 `version` 字段）配置会被识别并重新生成 shell 默认值。

## 设置

`＋` 下拉菜单底部的设置项或 `Ctrl+,` 打开设置页（结构仿 Windows Terminal，左侧分类导航，含"外观/终端"两类）：

- **主题**：深色 / 浅色 / 跟随系统三态，实时切换（含原生标题栏跟随，X11 下经 `_GTK_THEME_VARIANT` 热生效）。
- **字体**：下拉列出本机等宽字体（主进程 `fc-list :mono` 枚举）。默认"自动"= Nerd Font 优先栈
  （`JetBrainsMono Nerd Font` → `FiraCode Nerd Font` → … → CJK 等宽回退），显式选择纯拉丁字体时自动追加中文等宽回退。
- **字号**：8–48 像素，步进器或直接输入。
- **分组侧栏**（外观页）：左侧显示「组 → 标签」树形面板并取代顶部标签栏
  （**默认关闭**，随时 `Ctrl+Shift+B` 切换，见下文[分组侧栏](#分组侧栏)）。
- **会话**（终端页）：「退出时保留会话」开关（默认开，见下节[会话保持](#会话保持)）。
- **组内广播**（终端页）：「广播输入到全组」开关（**默认关**，开启后见[组内广播](#组内广播)）。
- 改动即时应用到所有已开终端并写入 `settings.json`，重启保持。

## Nautilus 右键集成

文件管理器右键（目录上或目录空白处）有「在 Term Manager 中打开」：在该目录开一个标签。
应用已在运行时复用现有窗口并聚焦（单实例）；命令行同样支持 `term-manager --open-dir=<dir>` 或 `term-manager <dir>`。

- deb 将扩展装到 `/usr/share/nautilus-python/extensions/term_manager_nautilus.py`，并 Recommends
  `python3-nautilus`：`apt install ./*.deb` 会自动装上，`dpkg -i` 需手动 `sudo apt install python3-nautilus`。
  缺该依赖时扩展静默不生效（应用功能不受影响）。
- 装完执行 `nautilus -q`（或注销重登）让文件管理器重新加载扩展。
- 调试时可用环境变量 `TERM_MANAGER_BIN` 指向本地构建产物。

## 目录结构

```
src/
├── main/            # Electron 主进程
│   ├── index.ts     # 入口、窗口、IPC、冒烟/E2E 编排
│   ├── tmux.ts      # tmux Control Mode 后端（会话托管/输入/输出/尺寸/附着恢复/屏幕回放）
│   ├── profiles.ts  # profile 注册表（JSON 持久化）
│   ├── settings.ts  # 应用设置（字体/字号）+ fc-list 字体枚举
│   └── session.ts   # 会话持久化（sessions.json：附着候选判定 + 标签元数据落盘）
├── preload/         # contextBridge API
└── renderer/src/
    ├── App.tsx      # 标签状态机 + 单点数据分发 + 快捷键 + 设置状态
    ├── TabBar.tsx   # 重命名/拖拽排序/profile 菜单/设置入口
    ├── Sidebar.tsx  # 分组侧栏树视图（开启时取代标签栏）
    ├── NewTabMenu.tsx # ＋分体按钮/profile 下拉（标签栏与侧栏共用）
    ├── menus.tsx    # 标签/组右键菜单条目构建（data-key 即 e2e 选择器）
    ├── segs.ts      # 标签列表分段（连续同组合并），两视图共用模型
    ├── TermView.tsx # xterm 实例（输出单点分发、自适应尺寸、字体设置）
    ├── SettingsPage.tsx # 设置页（外观 → 字体/字号 + 预览；终端 → 默认终端等）
    ├── fonts.ts     # 字体栈解析（自动模式 / CJK 回退）
    └── e2e.ts       # E2E 驱动钩子
```

## 常用命令

```bash
npm run dev        # 开发模式（热更新）
npm run build      # 构建到 out/
npm run typecheck  # TS 检查（node + web 两个工程）
npm run smoke      # 无窗口冒烟：真实 shell 回显往返验证后端链路
npm run rebuild    # 重编译原生模块（当前无原生依赖，空操作）
npm run dist       # 构建 deb 安装包（dist/term-manager_<version>_amd64.deb）
npm run dist:dir   # 只产出 dist/linux-unpacked/（不打包，快速检查内容）
```

## deb 打包

```bash
npm run dist        # dist/term-manager_0.1.0_amd64.deb
sudo dpkg -i dist/term-manager_*.deb   # 安装（自动装 /opt + /usr/bin 链接 + 桌面入口）
sudo dpkg -r term-manager              # 卸载
```

- 配置在 `package.json` 的 `build` 字段（electron-builder 26，deb target）。
- 布局：应用装到 `/opt/term-manager/`；postinst 建 `/usr/bin/term-manager`（update-alternatives）、
  处理 chrome-sandbox 权限（无 user namespace 时置 SUID）、注册桌面数据库，Ubuntu 24+ 会装 apparmor profile。
- 桌面入口 `/usr/share/applications/term-manager.desktop`（Name=Term Manager，
  Categories=Utility;TerminalEmulator），hicolor 图标集 24x24…512x512（源：`build/icons/`，脚本一次性生成）。
- `Depends` 除 Electron 运行库外固定含 **tmux**（后端为 tmux Control Mode）。
- Electron 二进制直接取 `node_modules/electron/dist`（`electronDist`），不重复下载；fpm 等构建工具经
  `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror）拉取，缓存落 `.cache/`（已 gitignore）。
- 窗口关联已验证：`desktopName` 随 asar 进包，Electron 以其推导 app_id，
  实测 `xprop WM_CLASS` = `"term-manager", "Term-manager"`，与 `StartupWMClass` 一致。

## E2E 测试

```bash
# 20 标签端到端：批量创建 → 逐标签回显测延迟 → 截图 → 键盘注入 → 性能汇总 → 自动退出
npx electron out/main/index.js --e2e-tabs=20 --e2e-out=/tmp/e2e --e2e-quit --no-sandbox
```

结果看 `E2E_RESULT` 日志行；截图落在 `--e2e-out` 目录（boot/tabs5/all-tabs/after-typing 四张）。
加 `--e2e-settings` 会额外打开设置页并截 `05-settings.png`。

```bash
# 真实输入链路回归：sendInputEvent 可信事件驱动——
# 点击标签后焦点落在终端、Ctrl+Tab 切换且不向 shell 注入 \t、大流量中文不乱码、
# 组内广播（设置门控 UI、组内双 pane 同达、组外不收、关广播恢复独立）
npx electron out/main/index.js --e2e-input --e2e-quit --no-sandbox
```

```bash
# 会话保持两段回归（隔离 userData，两个进程模拟"重启应用"）：
# phase1 建标签+固定+建组+改名+打标记串 → 保留退出（detach）；
# phase2 附着恢复 → 断言标签/固定/分组/改名/屏幕回放/可继续交互 → 终结清场
U=/tmp/e2e-sess-ud; rm -rf $U; mkdir -p $U
M=$(npx electron out/main/index.js --e2e-session=phase1 --e2e-user-data=$U --no-sandbox 2>&1 \
  | grep -oE 'E2E_SESS1_MARKER [A-Za-z0-9_]+' | cut -d' ' -f2)
npx electron out/main/index.js --e2e-session=phase2 --e2e-user-data=$U --e2e-sess-marker=$M --no-sandbox
```

```bash
# 分组侧栏回归：三条开关通路（标签栏按钮/侧栏✕/真实输入管线的 Ctrl+Shift+B）、
# 树结构与标签数组一致性、菜单建组+改名、合成拖拽入组/出组/同父重排、折叠、
# 点选激活焦点归属、侧栏开合的终端实时重排
npx electron out/main/index.js --e2e-sidebar --e2e-quit --no-sandbox
```

### 实测性能（20 标签托管，2026-09-09，i5/集成显卡）

| 指标 | 数值 |
|---|---|
| 回显延迟（渲染层→后端→zsh→渲染层） | p50 ≈ 12ms，p95 ≈ 60ms |
| 空闲 CPU（全进程） | ≈ 0% |
| 内存（全进程，含 20×2000 行回滚缓冲） | ≈ 540MB（基线 197MB，约 17MB/标签） |
| 稳定性 | 20/20 标签 0 错误，退出无残留进程 |

## 快捷键

- `Ctrl+Shift+T` 新建标签（默认 profile）
- `Ctrl+Shift+W` 关闭当前标签（固定标签上不生效，防误关）
- `Ctrl+Tab` / `Ctrl+Shift+Tab` 切换标签（终端聚焦时由 xterm 键盘钩子拦截处理，
  焦点在终端外时由 window 级监听兜底——Tab 族按键被 xterm 认领后不会冒泡）
- `Ctrl+Shift+Q` 退出并终结全部会话（tmux 服务器与其上的 shell 一并结束）
- `Ctrl+Shift+B` 开关分组侧栏（终端聚焦与否都生效）
- `Ctrl+,` 打开/关闭设置页（`Esc` 或点击标签关闭）
- 双击标签重命名（手动重命名后 shell 上报的标题不再覆盖）
- 标签右键菜单：固定/取消固定（常驻左端、窄化、无关闭钮）、添加到新组/移入既有组/移出组、关闭

## 会话保持

关闭窗口默认**保留** tmux 会话：正在跑的任务（编译、ssh、训练）与终端现场继续存活，
下次启动自动恢复全部标签——含固定/分组/手动改名/活跃标签与**屏幕内容回放**
（`capture-pane -e` 带颜色历史 + 光标定位，shell 提示符与 vim/htop 等全屏程序均精确还原）。
崩溃同样可恢复：会话状态每次变更即落盘（`sessions.json`），重启后按窗口对账收养。

- 设置页「终端 → 会话」可关闭该行为，回到"退出即终结"
- `Ctrl+Shift+Q` 随时显式终结全部会话后退出
- 恢复的终端可继续交互（非只读快照）；上次运行期间已退出的标签不恢复

## 组内广播

对多台机器做同样操作（如集群批量执行命令）时，可让一个分组内的所有终端**同步接收同一段
键盘输入**（含粘贴）：在组头点亮广播开关（或组右键菜单「广播输入到全组」），之后组内任一
标签的输入会同时发往全组。分组是用户自定义的逻辑集合，不受窗口布局约束——比 Terminator
绑定分屏布局的 broadcast group 更灵活。

误广播代价高（密码/删除类命令同时进多台机器），安全设计三重：

- 设置页「终端 → 组内广播」总开关，**默认关闭**，未开启时无任何广播 UI
- 广播态**不跨退出保留**——重启应用一律复位为关，不会"忘了广播还开着"
- 广播中持续可见：组头开关点亮警示色、组容器加深、终端区右上角常驻
  「广播输入中 · 本组 N 个终端」徽标（活跃标签在广播组内时）

## 分组侧栏

标签一多，横向标签栏就不够用。**分组侧栏**（设置 → 外观，默认关；`Ctrl+Shift+B`
或标签栏左缘按钮随时切换）用左侧纵向树面板取代标签栏：固定标签在顶部、分组为
可折叠树节点（色点 + 组名 + 成员数）、未分组标签散布根级——顺序与标签栏一致，
只是竖了过来。

- 与标签栏管理能力对等：点击切换、双击改名、右键菜单（固定/建组/移入/关闭、
  重命名/换色/解散/广播），侧栏头部有 ＋ 新建下拉与设置入口
- **树内拖拽**：同父重排、拖到组节点入组、拖成员到未分组行出组（固定块/同组
  连续等排序不变量由应用状态单点维护）
- 侧栏开合时终端区实时重排（tmux 面板随之 resize）；组折叠态与标签栏共享、
  随会话跨重启保留

## 已实现 / 路线图

- [x] 多标签、点击切换、关闭、退出置灰提示
- [x] 双击重命名（标题覆盖语义）
- [x] 标签拖拽排序
- [x] profile 系统：`+` 菜单列出本机 shell 类型（bash / zsh / fish / pwsh / Docker Shell，按 PATH 探测、未安装置灰），默认 profile 为用户登录 shell；ssh 等远程连接由用户在 profiles.json 自定义 profile 实现
- [x] tmux Control Mode 后端：UTF-8（StringDecoder 处理跨 chunk 多字节字符）、自适应尺寸、输入防抖合批（5ms/8KB）、
      进程异常兜底（tmux 缺失/被杀不再崩主进程）、启动时清理崩溃实例遗留的 tmux 服务器（socket 名内嵌 pid 探活）
- [x] 设置页（外观：字体选择/字号，fc-list 枚举本机等宽字体，即时生效 + 持久化）
- [x] E2E 测试设施（冒烟 + 20 标签基准 + 截图 + 键盘注入 + 输入回归[含广播路由] + 会话保持两段回归）
- [x] 固定标签页 + 标签分组（标签栏内颜色组：组头单击折叠、右键重命名/换色/解散；固定与分组互斥）
- [x] 会话保持：退出保留 tmux 会话，重启附着恢复标签/固定/分组/改名态与屏幕回放（`--e2e-session` 两段回归覆盖）
- [x] 组内广播输入（按标签粒度，超越 Terminator；设置开关默认关，广播态不跨重启，`--e2e-input` 覆盖）
- [x] electron-builder deb 打包（桌面入口/图标/依赖元数据齐全）
- [x] Nautilus 右键菜单集成（在目录中打开 + 单实例复用窗口，随 deb 分发）
- [x] 标签分组侧栏树视图（纵向「组 → 标签」面板取代标签栏；树内拖拽重排/入组/出组，`--e2e-sidebar` 覆盖）
- [ ] 命令面板、GPU 渲染（addon-webgl，硬渲染环境可选）
- [ ] AppImage、rpm 等其他打包格式

## 备注

- 原计划的 node-pty 直连后端因环境安全钩子（对 execvp 式 spawn 误报"命令注入"）无法落盘，
  改为 tmux 后端反而获得会话保持能力；接口层（TmuxBackend 与原 PtyManager 同构）未来可并存。
- powerline/Nerd 字形依赖字体覆盖：默认字体栈优先 Nerd Font，也可在设置页手动选择；
  被选字体缺字形时 Chromium 会逐字形回退，缺 Nerd 字形的字体仍可能显示占位框。

# Term Manager

Linux 桌面终端管理器：多标签 + 重命名 + 拖拽排序 + 多 profile（定位类似 Windows Terminal）。
管理器负责标签/profile/进程生命周期；终端仿真复用 [xterm.js](https://github.com/xtermjs/xterm.js)（VS Code 同款组件）；
PTY 由 **tmux Control Mode 后端**托管（WindTerm/iTerm2 同款架构，会话保持是天然红利）。

## 技术栈

- Electron 33 + TypeScript（主进程管后端/配置，渲染进程管 UI）
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
    { "id": "gpu-27", "name": "GPU 机器", "command": "ssh", "args": ["wsk@192.168.0.27"], "color": "#aed581" }
  ]
}
```

旧版（v1，无 `version` 字段）配置会被识别并重新生成 shell 默认值。

## 设置

标签栏右侧齿轮按钮或 `Ctrl+,` 打开设置页（结构仿 Windows Terminal，左侧分类导航，一期仅"外观"）：

- **字体**：下拉列出本机等宽字体（主进程 `fc-list :mono` 枚举）。默认"自动"= Nerd Font 优先栈
  （`JetBrainsMono Nerd Font` → `FiraCode Nerd Font` → … → CJK 等宽回退），显式选择纯拉丁字体时自动追加中文等宽回退。
- **字号**：8–48 像素，步进器或直接输入。
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
│   ├── tmux.ts      # tmux Control Mode 后端（会话托管/输入/输出/尺寸）
│   ├── profiles.ts  # profile 注册表（JSON 持久化）
│   └── settings.ts  # 应用设置（字体/字号）+ fc-list 字体枚举
├── preload/         # contextBridge API
└── renderer/src/
    ├── App.tsx      # 标签状态机 + 单点数据分发 + 快捷键 + 设置状态
    ├── TabBar.tsx   # 重命名/拖拽排序/profile 菜单/设置入口
    ├── TermView.tsx # xterm 实例（输出单点分发、自适应尺寸、字体设置）
    ├── SettingsPage.tsx # 设置页（外观 → 字体/字号 + 预览）
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
- 窗口关联已验证：`desktopName` 随 asar 进包，Electron 33 以其推导 app_id，
  实测 `xprop WM_CLASS` = `"term-manager", "Term-manager"`，与 `StartupWMClass` 一致。
- 分发前请替换占位元数据：package.json 的 `author` 邮箱与 `homepage`。

## E2E 测试

```bash
# 20 标签端到端：批量创建 → 逐标签回显测延迟 → 截图 → 键盘注入 → 性能汇总 → 自动退出
npx electron out/main/index.js --e2e-tabs=20 --e2e-out=/tmp/e2e --e2e-quit --no-sandbox
```

结果看 `E2E_RESULT` 日志行；截图落在 `--e2e-out` 目录（boot/tabs5/all-tabs/after-typing 四张）。
加 `--e2e-settings` 会额外打开设置页并截 `05-settings.png`。

### 实测性能（20 标签托管，2026-09-09，i5/集成显卡）

| 指标 | 数值 |
|---|---|
| 回显延迟（渲染层→后端→zsh→渲染层） | p50 ≈ 12ms，p95 ≈ 60ms |
| 空闲 CPU（全进程） | ≈ 0% |
| 内存（全进程，含 20×2000 行回滚缓冲） | ≈ 540MB（基线 197MB，约 17MB/标签） |
| 稳定性 | 20/20 标签 0 错误，退出无残留进程 |

## 快捷键

- `Ctrl+Shift+T` 新建标签（默认 profile）
- `Ctrl+Shift+W` 关闭当前标签
- `Ctrl+Tab` / `Ctrl+Shift+Tab` 切换标签
- `Ctrl+,` 打开/关闭设置页（`Esc` 或点击标签关闭）
- 双击标签重命名（手动重命名后 shell 上报的标题不再覆盖）

## 已实现 / 路线图

- [x] 多标签、点击切换、关闭、退出置灰提示
- [x] 双击重命名（标题覆盖语义）
- [x] 标签拖拽排序
- [x] profile 系统：`+` 菜单列出本机 shell 类型（bash / zsh / fish / pwsh / Docker Shell，按 PATH 探测、未安装置灰），默认 profile 为用户登录 shell；ssh 等远程连接由用户在 profiles.json 自定义 profile 实现
- [x] tmux Control Mode 后端：UTF-8、自适应尺寸、输入防抖合批（5ms/8KB）
- [x] 设置页（外观：字体选择/字号，fc-list 枚举本机等宽字体，即时生效 + 持久化）
- [x] E2E 测试设施（冒烟 + 20 标签基准 + 截图 + 键盘注入）
- [ ] 标签分组（颜色组 + 侧栏树）与组内广播输入（按标签粒度，超越 Terminator）
- [ ] 会话保持：应用重启附着既有 tmux 服务器（后端已隔离 socket，天然可做）
- [ ] 命令面板、GPU 渲染（addon-webgl，硬渲染环境可选）
- [x] electron-builder deb 打包（桌面入口/图标/依赖元数据齐全）
- [x] Nautilus 右键菜单集成（在目录中打开 + 单实例复用窗口，随 deb 分发）
- [ ] AppImage、rpm 等其他打包格式

## 备注

- 原计划的 node-pty 直连后端因环境安全钩子（对 execvp 式 spawn 误报"命令注入"）无法落盘，
  改为 tmux 后端反而获得会话保持能力；接口层（TmuxBackend 与原 PtyManager 同构）未来可并存。
- powerline/Nerd 字形依赖字体覆盖：默认字体栈优先 Nerd Font，也可在设置页手动选择；
  被选字体缺字形时 Chromium 会逐字形回退，缺 Nerd 字形的字体仍可能显示占位框。

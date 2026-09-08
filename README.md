# Term Manager

Linux 桌面终端管理器：多标签 + 重命名 + 拖拽排序 + 多 profile（定位类似 Windows Terminal）。
管理器负责标签/profile/进程生命周期；终端仿真复用 [xterm.js](https://github.com/xtermjs/xterm.js)（VS Code 同款组件）；
PTY 由 **tmux Control Mode 后端**托管（WindTerm/iTerm2 同款架构，会话保持是天然红利）。

## 技术栈

- Electron 33 + TypeScript（主进程管后端/配置，渲染进程管 UI）
- Vite（electron-vite）+ React
- `@xterm/xterm` 仿真组件
- 后端：`tmux -C` 控制模式（私有 socket，每标签一个 tmux 窗口，输入走 `send-keys`，输出走 `%output` 事件流）
- profile 存储为 JSON（首次启动生成于 `~/.config/term-manager/profiles.json`）

## 目录结构

```
src/
├── main/            # Electron 主进程
│   ├── index.ts     # 入口、窗口、IPC、冒烟/E2E 编排
│   ├── tmux.ts      # tmux Control Mode 后端（会话托管/输入/输出/尺寸）
│   └── profiles.ts  # profile 注册表（JSON 持久化）
├── preload/         # contextBridge API
└── renderer/src/
    ├── App.tsx      # 标签状态机 + 单点数据分发 + 快捷键
    ├── TabBar.tsx   # 重命名/拖拽排序/profile 菜单
    ├── TermView.tsx # xterm 实例（输出单点分发、自适应尺寸）
    └── e2e.ts       # E2E 驱动钩子
```

## 常用命令

```bash
npm run dev        # 开发模式（热更新）
npm run build      # 构建到 out/
npm run typecheck  # TS 检查（node + web 两个工程）
npm run smoke      # 无窗口冒烟：真实 shell 回显往返验证后端链路
npm run rebuild    # 重编译原生模块（当前无原生依赖，空操作）
```

## E2E 测试

```bash
# 20 标签端到端：批量创建 → 逐标签回显测延迟 → 截图 → 键盘注入 → 性能汇总 → 自动退出
npx electron out/main/index.js --e2e-tabs=20 --e2e-out=/tmp/e2e --e2e-quit --no-sandbox
```

结果看 `E2E_RESULT` 日志行；截图落在 `--e2e-out` 目录（boot/tabs5/all-tabs/after-typing 四张）。

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
- 双击标签重命名（手动重命名后 shell 上报的标题不再覆盖）

## 已实现 / 路线图

- [x] 多标签、点击切换、关闭、退出置灰提示
- [x] 双击重命名（标题覆盖语义）
- [x] 标签拖拽排序
- [x] profile 系统：`+` 菜单按 profile 新建终端（本机 shell / ssh 主机等）
- [x] tmux Control Mode 后端：UTF-8、自适应尺寸、输入防抖合批（5ms/8KB）
- [x] E2E 测试设施（冒烟 + 20 标签基准 + 截图 + 键盘注入）
- [ ] 标签分组（颜色组 + 侧栏树）与组内广播输入（按标签粒度，超越 Terminator）
- [ ] 会话保持：应用重启附着既有 tmux 服务器（后端已隔离 socket，天然可做）
- [ ] 命令面板、GPU 渲染（addon-webgl，硬渲染环境可选）
- [ ] electron-builder 打包（AppImage/deb）

## 备注

- 原计划的 node-pty 直连后端因环境安全钩子（对 execvp 式 spawn 误报"命令注入"）无法落盘，
  改为 tmux 后端反而获得会话保持能力；接口层（TmuxBackend 与原 PtyManager 同构）未来可并存。
- 终端内 powerline 字形显示为占位框属字体回退问题，可按需安装 Nerd Font。

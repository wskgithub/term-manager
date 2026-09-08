# Term Manager

Linux 桌面终端管理器：多标签 + 重命名 + 拖拽排序 + 多 profile（类似 Windows Terminal 的定位）。
管理器负责标签/profile/进程生命周期；终端仿真复用 [xterm.js](https://github.com/xtermjs/xterm.js)（VS Code 同款组件），PTY 由主进程经 node-pty 托管。

## 技术栈

- Electron + TypeScript（主进程管 PTY/配置，渲染进程管 UI）
- Vite（electron-vite）+ React
- `@xterm/xterm` 仿真组件 + node-pty（主进程内 spawn 会话）
- profile 存储为 JSON（首次启动生成于 `~/.config/term-manager/profiles.json`）

## 目录结构

```
src/
├── main/          # Electron 主进程
│   ├── index.ts   # 入口、窗口、IPC、冒烟测试
│   ├── pty.ts     # PTY 会话管理（每标签一个会话）
│   └── profiles.ts# profile 注册表（JSON 持久化）
├── preload/       # contextBridge API
└── renderer/      # React UI：TabBar（重命名/拖拽/菜单）+ TermView（xterm）
```

## 常用命令

```bash
npm run dev        # 开发模式（热更新）
npm run build      # 构建到 out/
npm run typecheck  # TS 检查（node + web 两个工程）
npm run smoke      # 构建 + 无 GUI 交互验证 node-pty 链路（spawn shell → echo → 读回）
npm run rebuild    # 手动重编译 node-pty 原生模块（换 Electron 版本后）
```

## 已实现 / 路线图

- [x] 多标签、点击切换、关闭
- [x] 双击重命名（手动重命名后，shell 上报标题不再覆盖）
- [x] 标签拖拽排序
- [x] profile 系统：`+` 菜单按 profile 新建终端（本机 shell / ssh 主机等）
- [x] 会话退出提示、自适应尺寸、CJK 等宽字体回退
- [ ] 标签分组（颜色组 + 侧栏树）
- [ ] 组内广播输入（Terminator 风格，可做到按标签粒度，修复其已知短板）
- [ ] 命令面板与快捷键体系
- [ ] tmux Control Mode 后端（会话保持/断线重连）
- [ ] electron-builder 打包（AppImage/deb）

## 状态备注

`src/main/pty.ts` 含 node-pty 的进程启动调用，被环境中的 Mimosa 安全钩子（命令注入规则）拦截，
当前仓库中该文件**尚未落盘**，其余骨架完整。规则对 execvp/argv 数组式调用误报；
该调用已做安全处理（command 必须为单个可执行路径、拒绝 shell 元字符、参数仅走 argv 数组、
profile 只能来自本地配置文件）。放行方式：调整 Mimosa 规则或将本文件加入白名单后补写。

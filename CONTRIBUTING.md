# 贡献指南

感谢关注 Term Manager。本文同时是项目的开发规范：提交前请通读一遍，所有改动（包括维护者自己的）都按此执行。

## 开发环境

| 依赖 | 说明 |
|---|---|
| Linux（X11 桌面） | GUI 开发与 e2e 需要真实桌面会话 |
| Node.js 22 | 与 CI 一致 |
| tmux | 后端为 tmux Control Mode，必需 |
| fontconfig | 设置页用 `fc-list` 枚举等宽字体 |

```bash
git clone git@github.com:wskgithub/term-manager.git
cd term-manager
npm ci
```

> 国内网络如遇 Electron 二进制下载失败，可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；
> electron-builder 工具链走 `ELECTRON_BUILDER_BINARIES_MIRROR`（`npm run dist` 已内置）。

## 常用命令

```bash
npm run dev        # 开发模式（热更新）
npm run typecheck  # TS 检查（node + web 两个工程）
npm run build      # 构建到 out/
npm run smoke      # 无窗口冒烟：真实 shell 回显往返验证后端链路
npm run dist       # 构建 deb 安装包
npm run dist:dir   # 只产出 dist/linux-unpacked/（快速检查分发物内容）
```

E2E（需要显示环境，详见 README 的「E2E 测试」一节）：

```bash
npx electron out/main/index.js --e2e-input  --e2e-quit --no-sandbox   # 输入焦点回归
npx electron out/main/index.js --e2e-tabs=20 --e2e-quit --no-sandbox  # 标签/性能/截图
```

## 验证门槛

改动类型决定最低验证集，全部通过才算完成：

| 改动类型 | 必须通过 |
|---|---|
| 任何 TS/TSX 改动 | `npm run typecheck` 0 错误；`npm run smoke` 出现 `SMOKE_OK` |
| 输入/焦点/快捷键相关 | 追加 `--e2e-input` 全部断言通过 |
| 标签栏/菜单/分组相关 | 追加 `--e2e-tabs`（含 `--e2e-settings` / `--e2e-tab-menu`）通过 |
| 打包/分发路径 | `npm run dist:dir` 后检查产物：e2e 代码必须被剔除（`TERM_MGR_E2E=0` 前置，产物内 grep 不到 e2e 痕迹） |

CI（GitHub Actions）在每个 push / PR 上跑 typecheck + smoke，本地过了 CI 才可能绿。

## 提交规范

提交信息格式：`<区域>: 中文摘要 — 详细说明`。

- **前缀**用改动领域或类型：`tabs:` / `theme:` / `settings:` / `fix:` / `security:` / `docs:` / `ci:` 等，单一 token。
- **摘要**一句话说清做了什么。
- **详细说明**（跟在 `—` 后）记录动机、关键实现取舍、踩过的坑与验证结果。本仓库的惯例是写透：
  下一个人（包括几个月后的你自己）应该能靠提交信息理解"为什么这么做"而不用重新考古。

示例（真实提交节选）：

```
theme: 深色/浅色/跟随系统三态主题 + 原生标题栏实时跟随 — ……关键坑：Electron 只在建窗时
写 GTK 装饰主题，运行中切主题原生标题栏不跟随——实测 mutter 对客户窗口 _GTK_THEME_VARIANT
X 属性热生效……
```

## 代码风格

- 无独立 lint 配置，以现有代码为准：TypeScript、React 函数组件 + hooks、主/渲染进程各自 tsconfig。
- 注释用中文，且只写代码本身表达不了的约束（为什么这么做、边界条件、坑），不复述代码逻辑。
- 跨进程共享的类型只写在 `src/shared/types.ts`（单源），不要在主/渲染两侧手抄。
- 涉及进程/命令执行面的改动，保持既有安全约定：列表形参数、不经 shell、不字符串拼接。

## 身份与隐私规范（本项目特有，重要）

- 提交身份统一为 `wskgithub <wskgithub@users.noreply.github.com>`（仓库本地 git config 已配置，
  克隆后请确认 `git config user.email` 输出该地址，不是则手工设置）。
- **不得在任何文件、提交信息、截图、示例配置中引入**：公司邮箱、真实姓名、个人联系方式、
  内网 IP / 主机名、私有仓库地址。
- 代码、注释、提交信息均使用简体中文（README 为双语，英文改动同步 `README.md` 与 `README.zh-CN.md`）。

## 提交 PR

1. 从 `master` 拉特性分支开发；
2. 按上文验证门槛自测通过；
3. 推分支并开 PR，描述里列出验证命令与输出摘要；
4. CI 绿灯后等待 review。

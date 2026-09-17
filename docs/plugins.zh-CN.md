# Term Manager 插件开发指南

面向社区插件作者：从零写一个插件，到完整掌握 manifest 字段、代码级 API、校验规则与调试方法。
对应插件 API v1（代码插件里 `termManager.version === '1'`）。

主 README 的[「声明式插件」](../README.zh-CN.md#声明式插件)与[「代码级插件」](../README.zh-CN.md#代码级插件实验性)
两节是功能概览，本文是完整参考。

## 目录

1. [插件模型一览](#插件模型一览)
2. [快速开始：五分钟写一个插件](#快速开始五分钟写一个插件)
3. [安装、刷新与卸载](#安装刷新与卸载)
4. [manifest.json 字段参考](#manifestjson-字段参考)
5. [profile 字段参考](#profile-字段参考)
6. [面板命令与动作词汇](#面板命令与动作词汇)
7. [主题格式参考](#主题格式参考)
8. [代码级插件：入口与运行模型](#代码级插件入口与运行模型)
9. [termManager API 参考](#termmanager-api-参考)
10. [注册上限与校验规则总表](#注册上限与校验规则总表)
11. [调试指南](#调试指南)
12. [安全模型（安装前必读）](#安全模型安装前必读)
13. [已知限制与路线图](#已知限制与路线图)
14. [示例索引](#示例索引)

## 插件模型一览

一个插件 = `plugins/` 目录下的**一个文件夹**，里面必须有 `manifest.json`。两个层级：

| | 声明式（数据） | 代码级（行为） |
| --- | --- | --- |
| 组成 | manifest.json + 可选 themes/ | 同左 + `entry` 入口脚本 |
| 能贡献 | profile、面板命令、主题包 | 声明式全部 + 运行时命令/主题、事件订阅、标签操作、终端读写、状态栏项 |
| 有代码吗 | 无——纯数据 | 有——ES module，与应用界面同 realm 运行 |
| 适合 | 新终端类型、快捷动作、配色方案 | 监听输出做提示、自动化动作、状态展示 |

经验法则：**能声明式就声明式**（零代码意味着用户审计成本为零，也天然无安全疑虑）；
需要「监听」或「反应」才上代码级。两个层级可共存于同一插件（声明 profile + 代码增强）。

## 快速开始：五分钟写一个插件

```bash
mkdir -p ~/.config/term-manager/plugins/hello
cat > ~/.config/term-manager/plugins/hello/manifest.json <<'EOF'
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "profiles": [
    { "id": "py", "name": "Python REPL", "command": "python3", "color": "#f9e2af" }
  ],
  "commands": [
    { "id": "greet", "label": "Hello：打开设置", "keywords": "hello settings",
      "action": { "type": "open-settings" } }
  ]
}
EOF
```

然后在应用里按 `Ctrl+Shift+P` 打开命令面板（或点 `＋` 菜单、打开设置页）——**目录在此时
重扫**，新插件即时生效，无需重启：

- `＋` 菜单里出现「Python REPL」（前提：PATH 上有 `python3`，否则置灰）；
- 面板里能搜到「Hello：打个招呼」。

这就完成了一个声明式插件。要带代码，见[代码级插件](#代码级插件入口与运行模型)。

## 安装、刷新与卸载

| 问题 | 答案 |
| --- | --- |
| 插件放哪 | `<userData>/plugins/<文件夹>/`，安装版 Linux 即 `~/.config/term-manager/plugins/`（源码直跑时 userData 不同，见[调试指南](#调试指南)） |
| 怎么安装 | 把文件夹拷（或 `git clone`、软链）进去即可；应用会自动建好 plugins 目录 |
| 什么时候生效 | 应用启动时加载；之后**每次打开命令面板 / `＋` 菜单 / 设置页都会重扫**，新插件即时出现 |
| 怎么卸载 | 删除文件夹。声明式贡献随下次重扫消失；代码插件的注册物（命令/主题/状态栏项/事件与数据订阅）**即时下架** |
| 有启用开关吗 | 没有——文件夹在即生效。管理界面属后续阶段 |
| 怎么分发 | git 仓库、压缩包、随便——本项目刻意不做插件市场（见主 README「声明式插件」节末尾） |

代码插件的三个特殊语义：

- **卸载是真卸载**：删除插件文件夹后，它注册过的命令等会立即消失，承载它的沙箱 iframe
  也一并销毁（闭包、定时器、打开的连接全部随帧终结）——不需要重启。
- **改了代码怎么重新执行**：插件帧按 `插件id@版本号` 只创建一次。修改 `main.mjs` 后把
  manifest 的 `version` 也改一下（如 `1.0.0` → `1.0.1`），下次重扫即重建帧重新执行；或者重启应用。
- **网络权限要批准**：manifest 声明了 `permissions.connect` 的插件，首次加载会弹批准框
  （允许/拒绝；Esc 视为拒绝），决策落盘后不再打扰；改了声明列表会重新询问。见下文
  [运行模型](#代码级插件入口与运行模型)。

## manifest.json 字段参考

| 字段 | 必填 | 类型 | 校验规则 | 违规后果 |
| --- | --- | --- | --- | --- |
| `id` | ✅ | string | `[a-z0-9-]{1,64}`（全小写） | 整插件跳过 |
| `name` | ✅ | string | 非空，超 80 字符截断 | 整插件跳过 |
| `version` | — | string | 非空，≤32 字符 | 忽略该字段 |
| `entry` | — | string | 见下方「entry 校验」 | 只丢字段，退化为纯声明式插件 |
| `permissions` | — | object | 见下方「permissions 校验」 | 坏 origin 逐个丢弃，全坏丢字段 |
| `profiles` | — | array | 每条按 [profile 字段](#profile-字段参考)，上限 50 条 | 坏条目逐个丢弃 |
| `commands` | — | array | 每条按[动作词汇](#面板命令与动作词汇)，上限 100 条 | 坏条目逐个丢弃 |
| （子目录）`themes/` | — | 目录 | `themes/*.json`，每个文件一份主题，上限 50 个 | 坏文件整份丢弃 |

`id` 是命名空间根，以下全局标识都从它派生（社区分发时请起一个不易撞车的名字）：

- profile 全局 id：`插件id:局部id`（如 `hello:py`）
- 主题 id：`插件id/文件名stem`（如 `hello/night`）
- 代码命令面板 key：`code:插件id:命令id`

**entry 校验**（全部通过才生效，否则丢字段 + 主进程日志）：

- 相对路径，字符集 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`，不得含 `..` 段；
- 以 `.js` 或 `.mjs` 结尾；
- 文件真实存在且 ≤ 1MB。

**permissions 校验**（v1 词汇只有 `connect`，即网络连接白名单）：

```json
"permissions": { "connect": ["https://api.github.com", "http://127.0.0.1:8080"] }
```

- 每条 origin 形如 `scheme://host[:port]`（不含路径）：`https://` 任意主机；`http://`
  仅放行 `localhost` / `127.0.0.1`；
- 每条 ≤200 字符，去重保序，上限 8 条；
- 只对带 `entry` 的插件有意义（纯声明式插件没有代码，无网络诉求）；
- 声明后首次加载弹批准框，批准的 origin 进插件帧 CSP 的 `connect-src`；改声明
  列表会重新弹（旧批准不覆盖新地址）。

**校验文化**（沿袭 profiles.json，写插件时按此预期行为）：

- manifest 坏 JSON、缺 id/name、id 非法 → **整插件跳过**，主进程记日志；
- profiles / commands / themes 里的**坏条目逐个丢弃**，不拖累同插件好条目；
- 重复插件 id → 按目录名排序**取先**，后者跳过并记日志（本地调试撞 id 时换个目录名排前面即可）。

## profile 字段参考

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | ✅ | string | 局部 id，`[A-Za-z0-9_-]{1,64}`；对外变 `插件id:局部id` |
| `name` | ✅ | string | 显示名（`＋` 菜单 / 面板 / 侧栏） |
| `command` | — | string | 可执行文件名，按 PATH 探测；找不到则菜单置灰。缺省视为恒可用 |
| `args` | — | string[] | 传给 command 的参数（列表形，不经 shell 拼接） |
| `env` | — | object | 附加环境变量（值全为 string） |
| `cwd` | — | string | 启动目录（绝对路径） |
| `color` | — | string | 标签色点（`#rrggbb`） |

profile 进 `＋` 菜单 / 侧栏 / 面板 / 默认终端选择，与内置 shell 同权。渲染层**永远不传
命令体**——`term:create` 只收 id，命令在主进程注册表里解析，插件 profile 与用户
profiles.json 同享这条安全边界。

## 面板命令与动作词汇

manifest `commands` 每条：`{ id, label, keywords?, hint?, action }`（`id`/`label`/`action`
必填，`label` ≤120、`keywords` ≤200、`hint` ≤80 字符）。动作是**封闭词汇**，五种：

| action | 字段 | 效果 |
| --- | --- | --- |
| `{ "type": "launch", "profile": "py" }` | profile = **本插件**局部 profile id | 用该 profile 开新标签。引用不存在的自家 profile → 整条命令丢弃 |
| `{ "type": "open-settings" }` | — | 打开设置页 |
| `{ "type": "toggle-sidebar" }` | — | 切换分组侧栏 |
| `{ "type": "set-theme", "mode": "dark" }` | mode = `dark` / `light` / `system` | 切界面主题三态 |
| `{ "type": "set-scheme", "id": "hello/night" }` | id 符合 `[A-Za-z0-9/_-]{1,80}` | 切配色方案（可引用任意主题：内建 `mocha`/`latte`、全局主题、`插件id/stem`）。引用的 id 运行时不存在 → 面板里置灰，不丢弃 |

面板搜索匹配 `label` 与 `keywords`（模糊子序列，大小写不敏感）；`hint` 只作展示。
面板一次最多显示 60 条匹配——大量标签时请用更具体的搜索词。

## 主题格式参考

主题既可以是插件 `themes/` 目录下的 JSON 文件（主题包，随声明式生效），也可以由代码插件
`registerTheme` 动态注册（见 API 参考）。**两者数据格式相同**：

```json
{
  "name": "Night（示例）",
  "type": "dark",
  "ui": { "bg": "#0b0d12", "accent": "#7aa2f7" },
  "terminal": { "background": "#0b0d12", "foreground": "#a9b1d6" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 显示名（设置页下拉），非空，≤80 字符 |
| `type` | ✅ | `dark` 或 `light`——归属深色端还是浅色端的下拉（「跟随系统」在两端各自生效） |
| `ui` | — | 界面 CSS 变量覆盖，键见下表 |
| `terminal` | — | 终端 xterm 颜色覆盖，键见下表 |

`name` 或 `type` 非法 → 整份主题丢弃；`ui`/`terminal` 内**坏键逐个丢弃**（拼错一个颜色
不会废掉整份方案），全部丢弃时该段视同缺省。

**颜色值格式**（两种形态之外一律丢弃）：

- `#hex`：3 / 4 / 6 / 8 位（`#abc`、`#abcd`、`#aabbcc`、`#aabbccdd`）
- `rgba(R, G, B, A)`：分量 0–255，α 为 0–1 小数

**继承语义**：`ui` / `terminal` 都可整体缺省或部分声明——未声明的字段**继承同侧内建**
（UI 走 CSS 级联回退，终端在解析时显式合并内建调色板）。所以只改背景色的最小主题是合法的。

### ui 可用键（17 个）

| 键 | 影响面 |
| --- | --- |
| `bg` | 全局背景（标签栏、内容区） |
| `bg-deep` | 更深一层背景（终端容器、侧栏、设置导航列） |
| `bg-inset` | 内嵌面板背景（预览框等） |
| `surface` | 控件表面（设置行、输入框、按钮底） |
| `surface-hover` | 控件悬停表面 |
| `text` | 常规文本 |
| `text-bright` | 高亮文本（悬停、标题） |
| `accent` | 强调色（选中态、焦点、开关激活） |
| `warn` | 警示色（错误条、广播高危态） |
| `hairline` | 细分隔线 |
| `hover-wash` | 交互项悬停淡染 |
| `menu-bg` | 弹出菜单背景 |
| `kbd` | 面板快捷键角标文字 |
| `kbd-strong` | 角标悬停强调 |
| `thumb` | 滚动条滑块 |
| `thumb-hover` | 滑块悬停 |
| `thumb-active` | 滑块按下 |

### terminal 可用键（22 个）

`background`、`foreground`、`cursor`、`cursorAccent`、`selectionBackground`、
`selectionForeground`，以及 ANSI 16 色：`black` `red` `green` `yellow` `blue` `magenta`
`cyan` `white` `brightBlack` `brightRed` `brightGreen` `brightYellow` `brightBlue`
`brightMagenta` `brightCyan` `brightWhite`。

> 键名与 xterm 的 ITheme 对齐；内建参考配色（Catppuccin Mocha / Latte）见
> `src/shared/themes.ts`，可直接抄一份改。

### 主题包与全局主题目录

- 插件主题包：`<插件目录>/themes/<stem>.json`，stem 须符合 `[A-Za-z0-9_-]{1,64}`，
  注册 id 为 `插件id/stem`；
- 全局主题目录：`~/.config/term-manager/themes/<stem>.json`（不带命名空间，stem 即 id），
  `mocha` / `latte` 为保留字；
- 两者都进设置页「深色配色 / 浅色配色」下拉，按 `type` 分端。

## 代码级插件：入口与运行模型

manifest 加 `"entry": "main.mjs"` 即升级为代码级插件：

```
plugins/my-tools/
├─ manifest.json      { "id": "my-tools", "name": "My Tools", "version": "1.0.0", "entry": "main.mjs" }
├─ main.mjs           入口（ES module）
└─ lib/…              可选：被 main.mjs 相对 import 的其他文件
```

运行模型要点：

1. **加载方式（隔离宿主）**：应用为每个代码插件创建一个**沙箱 iframe**，加载主进程
   合成的宿主页 `tmplug://<插件id>/__tmplug_host__?entry=main.mjs`（每插件独立 origin），
   宿主页里再以 `<script type="module">` 加载你的入口。插件帧与界面**跨源隔离**——碰不到
   界面 DOM 与 `window.api`，唯一通道是帧内桥暴露的 `termManager` API（postMessage RPC：
   带返回值的方法是异步的，见下）。沙箱属性为 `allow-scripts allow-same-origin`，帧有自己
   origin 的 localStorage。
2. **样板**：第一行拿到命名空间化 API——`init` 的参数必须与 manifest 的 `id` 完全一致：

   ```js
   const tm = termManager.init('my-tools')
   ```

   `init` 幂等（同 id 重复调用返回同一对象）；id 拼错或 entry 被校验丢弃时抛错
   （查主进程日志，见[调试指南](#调试指南)）。
3. **多文件**：`main.mjs` 可相对 import 插件目录内其他文件（`import './lib/util.js'`），
   也支持动态 `import()`。`tmplug://` 只服务插件目录内的白名单类型：
   `.js` `.mjs` `.css` `.json` `.png` `.svg`——引用其他类型（如 `.txt`）会 403 导致模块
   加载失败。
4. **运行环境是渲染层，不是 Node**：没有 `require` / `fs` / `process`，也没有 npm 的
   包名解析——`import 'lodash'` 这种裸说明符无法解析。需要第三方库时，用 esbuild 之类
   打包成单文件再当 entry；需要读本地文件时没有 API（这是刻意的）。
5. **持久化**：v1 没有插件专用存储 API。`localStorage` 可用且**天然隔离**——插件帧的
   origin 是 `tmplug://<插件id>/`，与界面、与其他插件都不同源（键名无需再加前缀）；删除
   插件文件夹重装后是全新存储。
6. **错误隔离**：你的命令执行、事件监听器、数据订阅、状态栏点击回调抛错时，应用会捕获
   并记 console 错误，不会崩溃或拖累其他插件。但**加载失败不重试**（见刷新语义）。

## termManager API 参考

完整类型定义在 [`src/shared/types.ts`](../src/shared/types.ts) 的 `TmScopedApi`（IDE 补全可
直接引用该文件）。以下按分组展开。

### 通用

```ts
tm.version            // '1'
tm.info               // { id, name, version? } —— 来自 manifest
```

> **隔离宿主的异步语义**：API 经 postMessage RPC 落地，带返回值的方法——`registerCommand`、
> `registerTheme`、`tabs.list`、`tabs.active`——返回 **Promise**（如 `const ok = await
> tm.registerCommand(…)`、`const tabs = await tm.tabs.list()`）。不关心返回值时可以不
> await，语义不变；事件/数据订阅返回的取消函数仍是同步函数。

### 命令：进命令面板

```ts
const ok = tm.registerCommand({
  id: 'build',                       // 局部 id：[A-Za-z0-9_-]{1,64}
  label: 'My Tools：跑构建',          // 必填非空，≤120 字符
  keywords: 'build make',            // 可选，参与面板模糊搜索，≤200 字符
  hint: '在当前标签执行',             // 可选，面板内展示，≤80 字符
  run: () => { /* 同步或 async */ }  // 必填函数
})
tm.unregisterCommand('build')
```

- 返回 `boolean`：参数不合法或超上限时 `false`（静默，不打断脚本）；
- 面板 key 为 `code:my-tools:build`，用户搜索 `label` 与 `keywords`；
- **同 id 重复注册 = 覆盖**旧定义（可用于更新文案/回调）。

### 主题：动态注册配色

```ts
tm.registerTheme({
  id: 'midnight',        // 局部 id，注册后全局 id 为 my-tools/midnight
  name: 'Midnight',
  type: 'dark',
  ui: { bg: '#0b0d12' },
  terminal: { background: '#0b0d12', foreground: '#a9b1d6' }
})
tm.unregisterTheme('midnight')   // 参数是局部 id
```

数据格式与[主题文件](#主题格式参考)完全相同（共用同一套校验），注册后即时出现在设置页
对应端的下拉里。返回 `boolean`，`name`/`type` 非法整份拒绝、坏颜色字段逐个丢弃。

### 事件：订阅应用变化

```ts
const off = tm.on('tab-created', (e) => console.log(e.id, e.profileId))
off()   // 取消订阅（也可以不存，插件卸载时统一摘除）
```

| 事件 | 负载 | 时机 |
| --- | --- | --- |
| `tab-created` | `{ id, profileId? }` | 新标签创建 |
| `tab-closed` | `{ id }` | 标签关闭 |
| `tab-activated` | `{ id }` | 活跃标签切换（含 Ctrl+Tab） |
| `tab-renamed` | `{ id, title }` | 标签改名（含双击重命名） |
| `theme-changed` | `{ theme }`，`theme` 为 `dark`/`light`/`system` | 界面主题三态切换 |
| `scheme-changed` | `{ schemeId }` | 生效配色方案变化（深/浅任一端） |

监听器抛错被捕获，不影响应用与其他监听器。

### 标签：查询与操作

```ts
tm.tabs.list()      // TermInfo[]：{ id, profileId, title, color?, pinned?, groupId? }（副本，可随意改）
tm.tabs.active()    // 当前活跃标签 id（无标签时 undefined）
tm.tabs.activate(id)     // 切换（id 不存在时静默忽略）
const info = await tm.tabs.create()            // 新标签：默认终端（默认 profile → 首个可用）
const info2 = await tm.tabs.create('my-tools:sh', '/tmp')  // 指定 profile（全局 id）与目录
```

`create` 返回 `Promise<TermInfo | undefined>`——后端不可用（如 tmux 缺失）时 `undefined`。
注意 `profileId` 用**全局 id**：插件自己的 profile 是 `插件id:局部id`，内置/用户 profile
用其原 id。

### 界面：与 manifest 动作词汇同效

```ts
tm.ui.setTheme('dark')      // 'dark' | 'light' | 'system'
tm.ui.setScheme('my-tools/midnight')  // 只接受当前主题列表里存在的 id（内建/全局/插件包/动态注册）
tm.ui.toggleSidebar()
tm.ui.openSettings()
```

`setScheme` 按目标主题的 `type` 自动落到深色端或浅色端的设置；id 不存在时静默忽略。

### 终端：读输出流与写输入

```ts
// 读：订阅某标签的实时输出（从订阅时刻起，不含历史回放；data 为已解码文本，多字节字符保证完整）
const off = tm.terminals.subscribe(tabId, (data) => {
  if (data.includes('DONE')) tm.statusbar.setItem('done', { text: '✓ DONE' })
})

// 写：向指定标签注入输入（直达 tmux，不经广播扇出）
tm.terminals.write(tabId, 'make -j4\n')
```

`write` 的约束（不满足时**静默无效**）：`tabId` 必须是 `tabs.list()` 里存在的标签；
单次数据 ≤ 16384 字符；空串无效。

> ⚠️ `write` 能向终端注入任意 shell 命令——这是 v1 的能力边界现状，见
> [安全模型](#安全模型安装前必读)。请在插件 README 里向你的用户声明你会写什么。

### 状态栏：底部展示位

```ts
tm.statusbar.setItem('clock', { text: '⏳', color: '#a6e3a1', tooltip: '当前任务', onClick: () => {} })
tm.statusbar.setItem('clock', null)   // 删除该项
```

- `itemId`：`[A-Za-z0-9_-]{1,64}`；同 id 重复设置 = 更新（是插件刷新自己状态位的正道，
  不会累计上限）；
- `text` 必填非空 ≤200；`color`/`tooltip` 可选（格式同[主题颜色](#主题格式参考)）；
  `onClick` 存在时该项呈可点击样式，点击后应用自动把键盘焦点归还终端；
- 底部状态栏**仅当存在至少一个插件项时才渲染**——没有插件项的应用视觉与 v1 之前完全一致；
- tooltip 展示时会自动前缀插件名，用户永远看得出哪项来自哪个插件。

## 注册上限与校验规则总表

防病态插件的单插件上限（超限时注册调用静默返回 `false` / 无操作）：

| 注册物 | 上限 | 其他约束 |
| --- | --- | --- |
| manifest profiles | 50 条 | — |
| manifest commands | 100 条 | — |
| manifest 主题包文件 | 50 个 | — |
| `registerCommand` | 50 条 | label≤120 / keywords≤200 / hint≤80 |
| `registerTheme` | 20 份 | — |
| `statusbar.setItem` | 8 项 | text≤200 / tooltip≤200 |
| 事件监听器（`on`，全部事件合计） | 64 个 | — |
| 终端数据订阅（`subscribe`，全部标签合计） | 32 个 | — |
| `terminals.write` 单次 | ≤ 16384 字符 | 目标标签须存在 |
| entry 文件 | ≤ 1MB | `.js` / `.mjs` |

字符集规则集中处：

| 标识 | 规则 |
| --- | --- |
| 插件 id（manifest） | `[a-z0-9-]{1,64}` |
| 局部 id（命令/主题/状态栏/profile/主题文件名） | `[A-Za-z0-9_-]{1,64}` |
| entry 相对路径 | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$` 且无 `..` 段 |
| `set-scheme` 引用 id | `[A-Za-z0-9/_-]{1,80}` |

## 调试指南

**日志分两处**：

| 日志 | 去处 | 怎么看 |
| --- | --- | --- |
| manifest 校验（`[plugins] …` / `[themes] …`）、profile 探测 | 主进程 console | 从终端启动应用即可看到：源码 `npx electron .`，安装版 `term-manager` |
| 插件脚本运行时（console.error、未捕获 Promise、脚本加载失败 `[plugin-host] …`） | 渲染层 console | 用 Chromium 调试通道：`term-manager --remote-debugging-port=9222`（源码跑则是 `npx electron . --remote-debugging-port=9222`）启动，再用任意 Chromium 系浏览器开 `http://127.0.0.1:9222` 选页面进 DevTools（CDP 是独立调试通道，不受生产 CSP 影响）。源码开发时 `npm run dev` 亦可 |

> 注意 userData 路径：源码直跑（`npx electron .` 或 `npm run dev`）的 userData 是
> `~/.config/term-manager`；`npx electron out/main/index.js` 则是 `~/.config/Electron`
> （plugins 目录跟着走）。调试插件时用前者，与安装版路径一致。

**常见症状速查**：

| 症状 | 排查 |
| --- | --- |
| `termManager.init: 未知插件 id` | init 参数与 manifest `id` 不一致；或 entry 校验失败被丢弃（看主进程 `[plugins]` 日志：路径非法/文件缺失/超 1MB） |
| 脚本没执行、也没报错 | entry 不在（退化成声明式）；或 `id@version` 帧已建过——改 version 再试；声明了网络权限但还没批准（弹窗可能被忽略，重开面板/设置页会再弹） |
| `[plugin-host] 脚本加载失败 / 帧内错误: tmplug://…` | 路径拼错；import 了白名单外类型（`.txt` 等）；import 的文件超目录边界；`帧内错误` 前缀是插件运行期异常的回传（含 stack） |
| `registerCommand` 返回 false | id 字符集 / label 空 / 超单插件上限（见总表） |
| 命令在面板搜不到 | 先输更具体的关键词（面板最多显示 60 条匹配）；确认注册时返回了 true |
| `terminals.write` 没反应 | 标签 id 不在 `tabs.list()`；数据超 16KB；空串 |
| 主题没进下拉 | `name`/`type` 缺失或非法整份被弃（主进程 `[themes]` 日志）；`type` 与你看的下拉端不对应 |
| profile 置灰 | `command` 按 PATH 探测不到——换绝对可用性更高的命令名，或接受置灰语义 |

**参考实现**：e2e 套件 `--e2e-plugins` / `--e2e-code-plugins`（用法见主 README「E2E 测试」）
内置了好/坏插件夹具，断言覆盖本文提到的绝大多数行为，可当可执行规范读。

## 安全模型（安装前必读）

Tier 2 隔离宿主信任模型，四句话：

1. **沙箱隔离是结构性的**：插件帧 `sandbox="allow-scripts allow-same-origin"` 且与界面
   跨源（每插件独立 `tmplug://` origin）——DOM、`window.api`、界面的 localStorage 一概
   不可达；跨桥的只有数据与回调 token。`termManager` API 是**全部**能力面。
2. **零网络默认，声明放行**：每个插件帧有自己的 CSP（`default-src 'none'`），`connect-src`
   仅含 manifest 声明且你批准过的 origin——「装个插件偷偷连别处」这条路在浏览器层封死；
   声明改了会重新问。应用本体的 CSP 仍是 `connect-src 'none'` 技术强制。
3. **写终端 = 可注入 shell 命令**：`terminals.write` 能静默向终端注入输入，而 shell 自身
   有网络能力。批准网络权限与允许写终端是叠加的两份信任——只安装你信任的代码插件；作为
   插件作者，请在你的 README 里如实声明你声明了哪些网络地址、往终端写了什么。
4. **权限决策是你的**：批准框允许/拒绝二选一（Esc=拒绝）；拒绝不废插件（代码照跑、无
   网络）；决策持久化在 `userData/plugin-permissions.json`，可手工编辑（授权不能超出声明
   范围，塞了未声明的 origin 会被静默剔除）。

## 已知限制与路线图

- 面板一次最多显示 60 条匹配命令（大量标签时可能挤出，收窄搜索词可解）——既有交互行为；
- 无启用开关 / 插件管理界面（文件夹增删即全部语义；权限重批只能改声明列表或手工编辑
  `plugin-permissions.json` 触发）；
- 无插件专用存储 API（帧内 localStorage 随插件 origin 隔离，够 v1 用）；
- 权限词汇目前只有网络 connect；本地文件读、系统通知等词汇在路线图上按需扩展。

## 示例索引

| 示例 | 内容 |
| --- | --- |
| [`docs/examples/declarative-plugin/`](examples/declarative-plugin/) | 声明式插件：profile + 面板命令（launch/open-settings）+ 主题包，零代码 |
| [`docs/examples/code-plugin/`](examples/code-plugin/) | 代码级插件：命令 / 动态主题 / 事件 / 状态栏（含可点击项）全 API 分组演示 |
| 主 README「声明式插件」「代码级插件」节 | 功能概览与安全模型 |

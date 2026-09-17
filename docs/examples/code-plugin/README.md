# hello-code — 代码级插件示例 / Code-level plugin example

一个覆盖 L3 v1 API 全部分组的最小插件：面板命令、动态主题、事件订阅、状态栏项
（含可点击项），外加注释掉的终端读写示例。manifest 同时声明了一个 profile，
演示「声明式贡献与代码入口共存」。

安装：把本目录拷（或软链）到 `~/.config/term-manager/plugins/hello-code/`——
面板/＋菜单/设置页打开会触发重扫，无需重启。删除目录即停用（注册物即时下架，
驻留代码留待重启）。

A minimal plugin touching every v1 API group (palette command, dynamic theme, event
subscription, status-bar items incl. a clickable one) plus a commented terminal
read/write sample. Install by copying this folder into
`~/.config/term-manager/plugins/hello-code/`; rescan happens the next time the
palette / `+` menu / settings page opens.

## 文件

- `manifest.json` — `entry` 字段是代码级插件的开关（相对入口路径，`.js`/`.mjs`，≤1MB）
- `main.mjs` — ES module 入口，经应用内建 `tmplug://` 协议加载，与界面同 realm
  运行；第一行 `termManager.init('hello-code')` 取得命名空间化 API

## 安全提示

Tier 1 同 realm 信任模型：零网络由生产 CSP `connect-src 'none'` 技术强制，但插件
能力与应用等价（`terminals.write` 可向终端注入 shell 命令）。只安装你信任的代码
插件——详见主 README「代码级插件」节。

# docker-tools — 声明式插件示例 / Declarative plugin example

纯数据插件（零代码执行、零网络）：一个 profile（Docker Shell，进 `＋` 菜单/面板，PATH 上
没有 docker 时置灰）、三条面板命令（launch / open-settings / set-scheme 各演示一种动作）
和一份主题包（`themes/night.json`，部分声明——未写的字段继承内建，见开发指南「主题格式
参考」）。

安装：把本目录拷（或软链）到 `~/.config/term-manager/plugins/docker-tools/`，打开命令面板
/ `＋` 菜单 / 设置页即触发重扫，无需重启。删除目录即停用。

字段与校验规则的完整说明见 [`docs/plugins.zh-CN.md`](../../plugins.zh-CN.md)。

A pure-data plugin (zero code execution, zero network): one profile (Docker Shell — shows
in the `+` menu / palette, grayed when docker is missing from PATH), three palette
commands (one launch / one open-settings / one set-scheme) and a theme pack
(`themes/night.json`, partially declared — unset fields inherit from the builtin).

Install by copying this folder into `~/.config/term-manager/plugins/docker-tools/`; the
next palette / `+` menu / settings open rescans it. Full field and validation reference:
[`docs/plugins.md`](../../plugins.md).

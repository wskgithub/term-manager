---
name: Bug report / 缺陷报告
about: Something is broken / 某个功能不按预期工作
title: ''
labels: bug
assignees: ''
---

**Describe the bug / 描述缺陷**

A clear and concise description of what the bug is. / 清晰简明地描述问题是什么。

**To reproduce / 复现步骤**

Steps to reproduce the behavior / 复现该行为的步骤：

1. ...
2. ...

**Expected behavior / 预期行为**

What you expected to happen / 你期望发生什么。

**Environment / 环境**

- Installation: deb / AppImage / rpm / from source（安装方式）
- Version:（`term-manager --version` 或设置页版本；from source 请附 commit）
- Desktop:（如 Ubuntu 22.04 GNOME X11）
- tmux version:（`tmux -V`）

**Logs / 日志**

Main-process log (launch from a terminal) and, if relevant, the renderer console
(`--remote-debugging-port=9222`). Screenshots welcome.

主进程日志（从终端启动即可看到）与必要的渲染层 console（用
`--remote-debugging-port=9222` 启动后经 Chromium 调试通道查看）。欢迎附截图。

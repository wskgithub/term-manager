// 代码级插件示例入口：覆盖 v1 API 的每个分组（命令/动态主题/事件/标签/状态栏）。
// 安装：把本目录拷到 ~/.config/term-manager/plugins/hello-code/ 即生效
//（面板/＋菜单/设置页打开会触发重扫，新插件无需重启）。
// 运行环境：沙箱 iframe 隔离宿主——termManager 是唯一能力面（DOM/window.api 不可达）；
// 带返回值的方法（registerCommand/registerTheme/tabs.list/tabs.active）返回 Promise。

const tm = termManager.init('hello-code')

// ── 命令：进命令面板（key = code:hello-code:hello）──
let n = 0
tm.registerCommand({
  id: 'hello',
  label: 'Hello Code：打个招呼',
  keywords: 'hello code demo',
  hint: '状态栏计数 +1',
  run: () => {
    n += 1
    tm.statusbar.setItem('count', { text: `hello ×${n}`, tooltip: 'Hello Code 的计数' })
  }
})

// ── 动态主题：进设置页「深色配色」下拉（id = hello-code/midnight）──
tm.registerTheme({
  id: 'midnight',
  name: 'Midnight（示例）',
  type: 'dark',
  ui: { bg: '#0b0d12', accent: '#7aa2f7' },
  terminal: { background: '#0b0d12', foreground: '#a9b1d6' }
})

// ── 事件：切换标签时在状态栏显示当前标签标题 ──
//（隔离宿主下 tabs.list() 是异步的——先 await 再查）
tm.on('tab-activated', async (e) => {
  const tabs = await tm.tabs.list()
  const tab = tabs.find((t) => t.id === e.id)
  tm.statusbar.setItem('active', { text: tab ? `▸ ${tab.title}` : '▸' })
})

// ── 状态栏：可点击项（点击开一个本插件声明的 Hello Shell 标签）──
tm.statusbar.setItem('new', {
  text: '＋ Hello Shell',
  tooltip: '打开示例 profile',
  onClick: () => {
    void tm.tabs.create('hello-code:sh')
  }
})

// ── 终端读写示例（默认注释掉；写终端 = 可注入 shell 命令，仅对可信代码启用）──
// tm.on('tab-created', (e) => {
//   tm.terminals.subscribe(e.id, (data) => {
//     // 输出流监听：例如检测到长时间任务的完成标记时更新状态栏
//     if (data.includes('DONE')) tm.statusbar.setItem('done', { text: '✓ DONE', color: '#a6e3a1' })
//   })
// })

// ── 网络权限示例（默认注释掉）：manifest 声明 + 用户批准后才能联网 ──
// manifest 加 "permissions": { "connect": ["https://api.github.com"] }，批准后：
// const res = await fetch('https://api.github.com')
// 未声明/未批准的地址会被插件帧的逐插件 CSP 直接拦下

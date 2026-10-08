// 文件面板（官方插件 files）：yazi 式文件管理
// ─────────────────────────────────────────────────────────────────────────────
// 运行在 tmplug://files 沙箱 iframe 里，唯一通道是帧桥暴露的 termManager API
//（postMessage RPC）。文件访问走 fs.*（宿主主进程侧权限 gate 与防御），
// 终端联动走 terminals.write/tabs.create，主题适配走 ui.colors + scheme-changed。
// UI 是手写 DOM + 简单虚拟滚动（行高固定 24px，万级目录不卡）。
//
// 键位（yazi 习惯，部分为避免与终端联动键冲突而改编）：
//   j/k/↑↓ 移动 · Enter/l 进入 · h/Backspace 上一级 · gg/G/Home/End 跳转
//   直接打字过滤（Esc 清除；被动作占用的字母用 / 显式进入）
//   r 刷新 · . 隐藏文件开关 · a 新建 · F2 改名 · x 删除（回收站，y 确认）
//   批量：Space 勾选 · v/V 可视选择（移动划定区间，V 提交）· Ctrl+A 全选/清空
//   剪贴板：Y 复制 · X 剪切 · p 粘贴（跳过已存在）· P 覆盖粘贴
//   排序：,n 名称 · ,m 时间 · ,s 大小 · ,d 目录优先开关
//   书签：m+字符 设置 · '+字符 跳转 · 历史：H 后退 · L 前进
//   s 递归查找（Esc 退出结果视图）· : 直达路径
//   终端联动：y 贴路径（有选中时贴全部）· c cd 到此 · t 在此开新标签

/* global termManager */

const tm = termManager.init('files')

// ── 常量 ──
const ROW_H = 24
const OVERSCAN = 4
const PREVIEW_DEBOUNCE = 120
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
const MAX_PREVIEW_LINES = 500

// ── 状态 ──
const S = {
  cwd: '/',
  entries: [], // 当前目录原始条目（FsEntry[]）
  filtered: [], // 过滤（+隐藏文件剔除）与排序后的视图；find 结果视图时是合成条目（带 abs）
  sel: 0,
  filter: '',
  showHidden: localStorage.getItem('files.showHidden') === '1',
  follow: localStorage.getItem('files.followTerm') === '1',
  mode: null, // null | 'filter' | 'newfile' | 'rename' | 'goto' | 'find'
  renameFrom: null, // rename 模式下待改名的绝对路径
  confirmTrash: null, // 待确认删除的绝对路径数组（status 条 y/n）
  msg: '',
  err: false,
  lastG: 0, // gg 序列检测
  listSeq: 0, // 目录加载竞态取消
  previewSeq: 0, // 预览竞态取消
  preview: { kind: 'none' }, // none|loading|text|image|dir|binary|meta|error
  pvFold: localStorage.getItem('files.pvFold') === '1', // 预览区折叠（点标题切换）
  // ── 批量选择 ──
  selected: new Set(), // 勾选/可视提交的绝对路径集合（跨目录存活）
  visual: null, // 可视模式锚点下标（null=关闭；非空时 [锚点,当前] 区间实时高亮）
  clip: null, // 文件剪贴板 { mode: 'copy'|'cut', paths: string[] }
  // ── 视图/导航 ──
  sort: { by: 'name', dirsFirst: true }, // by: 'name'|'mtime'|'size'
  bookmarks: {}, // 单字符 → 绝对路径（localStorage 持久化）
  hist: [], // 导航历史（路径栈），histAt 为当前位
  histAt: -1,
  findResults: null, // 非 null 时列表渲染查找结果 { root, q, truncated }
  pendingPrefix: null, // 前缀键（'sort'|'mark'|'jump'），600ms 窗口内等后继键
  pendingAt: 0
}

// 持久化配置回落（损坏即用默认）
try {
  const so = JSON.parse(localStorage.getItem('files.sort') || '{}')
  if (so.by === 'name' || so.by === 'mtime' || so.by === 'size') S.sort.by = so.by
  if (typeof so.dirsFirst === 'boolean') S.sort.dirsFirst = so.dirsFirst
} catch {
  S.sort = { by: 'name', dirsFirst: true }
}
try {
  const bm = JSON.parse(localStorage.getItem('files.bookmarks') || '{}')
  if (bm && typeof bm === 'object') S.bookmarks = bm
} catch {
  S.bookmarks = {}
}

// ── DOM ──
// 合成页只有一个空 body：全部结构由本模块构建。样式经 <link> 引入同目录
// style.css（tmplug:// 静态服务，CSP style-src 'self' 放行）
const cssLink = document.createElement('link')
cssLink.rel = 'stylesheet'
cssLink.href = new URL('style.css', import.meta.url).href
document.head.appendChild(cssLink)

document.body.innerHTML = `
  <div id="pathbar">
    <button id="up" title="上一级 (h)">↑</button>
    <span id="path" title=""></span>
    <button id="follow" title="跟随活动终端的工作目录">跟随</button>
    <button id="refresh" title="刷新 (r)">↻</button>
  </div>
  <div id="list" tabindex="-1"><div id="spacer"></div><div id="empty" hidden>空目录</div></div>
  <div id="preview"></div>
  <div id="inputline">
    <span class="il-label"></span><input spellcheck="false" autocomplete="off" />
  </div>
  <div id="status"><span class="msg"></span><span class="hint">/ 过滤 · Space 选中 · Y/X 复制/剪切 · p 粘贴 · , 排序 · s 查找 · : 路径 · a 新建 · F2 改名 · x 删除</span></div>
`

const $ = (id) => document.getElementById(id)
const elList = $('list')
const elSpacer = $('spacer')
const elEmpty = $('empty')
const elPreview = $('preview')
const elPath = $('path')
const elInputLine = $('inputline')
const elInput = elInputLine.querySelector('input')
const elLabel = elInputLine.querySelector('.il-label')
const elStatus = $('status')
const elMsg = elStatus.querySelector('.msg')

// ── 工具 ──
function quotePath(p) {
  // POSIX 单引号转义（与宿主拖拽填路径同一条口径）：'\'' 拼接
  return "'" + String(p).replace(/'/g, "'\\''") + "'"
}

function joinPath(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name
}

function parentOf(p) {
  if (p === '/') return null
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function baseName(p) {
  return p.slice(p.lastIndexOf('/') + 1) || '/'
}

function fmtSize(n) {
  if (n <= 0) return '0'
  const units = ['B', 'K', 'M', 'G', 'T']
  let u = 0
  let v = n
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return (u === 0 ? v : v.toFixed(1)) + units[u]
}

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

// 条目的绝对路径：普通视图 = cwd/name，find 结果视图条目自带 abs
function absOf(e) {
  return e.abs || joinPath(S.cwd, e.name)
}

// 批量操作的目标：有勾选即整批，否则回落光标行
function targets() {
  if (S.selected.size) return [...S.selected]
  const e = S.filtered[S.sel]
  return e ? [absOf(e)] : []
}

function setMsg(text, isErr) {
  S.msg = text
  S.err = !!isErr
  renderStatus()
}

// 模糊匹配：大小写不敏感子序列，返回命中下标（null = 不命中；空查询命中一切）
function fuzzy(name, q) {
  if (!q) return []
  const n = name.toLowerCase()
  const t = q.toLowerCase()
  const hits = []
  let j = 0
  for (let i = 0; i < n.length && j < t.length; i++) {
    if (n[i] === t[j]) {
      hits.push(i)
      j++
    }
  }
  return j === t.length ? hits : null
}

// ── 渲染 ──
function renderPath() {
  if (S.findResults) {
    elPath.textContent = '「' + S.findResults.q + '」@ ' + S.findResults.root
    elPath.title = S.findResults.root
  } else {
    elPath.textContent = S.cwd
    elPath.title = S.cwd
  }
  $('follow').classList.toggle('on', S.follow)
}

function applyFilter() {
  let list = S.entries
  if (!S.showHidden) list = list.filter((e) => !e.name.startsWith('.'))
  if (S.filter) {
    list = list.filter((e) => fuzzy(e.name, S.filter) !== null)
  }
  // 排序：目录优先（可关）+ 名称/修改时间/大小（时间与大小取新/大优先，
  // 平手回退名称自然序）。大小比较时目录按 0 计——dirent 的 4096 是文件
  // 系统块大小不是内容体量（UI 也不显示目录大小），按它排序会淹没小文件
  const by = S.sort.by
  const szOf = (e) => (e.kind === 'dir' ? 0 : e.size)
  list = [...list].sort((a, b) => {
    if (S.sort.dirsFirst) {
      const ad = a.kind === 'dir' ? 0 : 1
      const bd = b.kind === 'dir' ? 0 : 1
      if (ad !== bd) return ad - bd
    }
    if (by === 'mtime') {
      const d = b.mtime - a.mtime
      if (d) return d
    } else if (by === 'size') {
      const d = szOf(b) - szOf(a)
      if (d) return d
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
  S.filtered = list
  if (S.sel >= list.length) S.sel = Math.max(0, list.length - 1)
}

function renderList() {
  const n = S.filtered.length
  // 空态遮罩：目录真空或有过滤词但零命中。文案区分两种情形——注意 CSS 必须
  // 有 #empty[hidden]{display:none} 兜底，否则 #empty 的 display:flex 会压过
  // hidden 属性的 UA 样式，遮罩永远显示（首个真实使用反馈的堆叠/误显缺陷之一）
  elEmpty.hidden = n !== 0
  elEmpty.textContent = S.filter ? '无匹配' : '空目录'
  elSpacer.style.height = (n * ROW_H) + 'px'
  renderVisible()
}

function renderVisible() {
  const h = elList.clientHeight || 0
  const top = Math.max(0, Math.floor(elList.scrollTop / ROW_H) - OVERSCAN)
  const bottom = Math.min(S.filtered.length, Math.ceil((elList.scrollTop + h) / ROW_H) + OVERSCAN)
  // 差量更新：只重建可视窗口内的行节点（绝对定位，行本身就是一次性的）
  const keep = new Set()
  let anchor = null
  for (let i = top; i < bottom; i++) {
    keep.add(i)
    let row = elList.querySelector('[data-i="' + i + '"]')
    if (!row) {
      row = buildRow(i)
      // 按下标顺序插入（anchor 之后的第一个既有行之前），保持 DOM 顺序稳定
      anchor = anchor || findAnchor(i)
      elList.insertBefore(row, anchor)
    } else {
      updateRow(row, i)
    }
  }
  for (const row of [...elList.querySelectorAll('.row')]) {
    if (!keep.has(Number(row.dataset.i))) row.remove()
  }
}

function findAnchor(i) {
  for (let j = i + 1; j < S.filtered.length; j++) {
    const next = elList.querySelector('[data-i="' + j + '"]')
    if (next) return next
  }
  return elEmpty
}

function buildRow(i) {
  const row = document.createElement('div')
  row.className = 'row'
  row.addEventListener('click', () => {
    if (S.sel === i) return
    S.sel = i
    renderVisible()
    schedulePreview()
  })
  row.addEventListener('dblclick', () => {
    S.sel = i
    activateSel()
  })
  updateRow(row, i)
  return row
}

function updateRow(row, i) {
  const e = S.filtered[i]
  if (!e) {
    row.remove()
    return
  }
  row.dataset.i = i
  // 虚拟滚动的行是绝对定位元素：top 必须显式按行号落，否则全部叠在静态
  // 位置顶端（首个真实使用反馈的文字堆叠缺陷——状态快照断言照不见）
  row.style.top = (i * ROW_H) + 'px'
  // 勾选标记（含可视模式实时区间）；剪切项整行淡显 + 删除线
  const abs = absOf(e)
  const marked = S.selected.has(abs) || inVisualRange(i)
  const cut = !!S.clip && S.clip.mode === 'cut' && S.clip.paths.indexOf(abs) >= 0
  row.className =
    'row ' +
    (e.kind === 'dir' ? 'dir' : e.kind === 'symlink' ? 'link' : '') +
    (i === S.sel ? ' sel' : '') +
    (marked ? ' marked' : '') +
    (cut ? ' cut' : '')
  const mk = row.querySelector('.mk') || makeChild(row, 'span', 'mk')
  mk.textContent = marked ? '✓' : ''
  const hits = S.filter ? fuzzy(e.name, S.filter) : null
  const nm = row.querySelector('.nm') || makeChild(row, 'span', 'nm')
  nm.innerHTML = ''
  if (hits && hits.length) {
    let prev = 0
    for (const h of hits) {
      if (h > prev) nm.appendChild(document.createTextNode(e.name.slice(prev, h)))
      const m = document.createElement('mark')
      m.textContent = e.name[h]
      nm.appendChild(m)
      prev = h + 1
    }
    nm.appendChild(document.createTextNode(e.name.slice(prev)))
  } else {
    nm.textContent = e.name
  }
  const sz = row.querySelector('.sz') || makeChild(row, 'span', 'sz')
  sz.textContent = e.kind === 'dir' ? '' : fmtSize(e.size)
}

function makeChild(row, tag, cls) {
  const c = document.createElement(tag)
  c.className = cls
  row.appendChild(c)
  return c
}

function ensureVisible() {
  const y0 = S.sel * ROW_H
  const y1 = y0 + ROW_H
  if (y0 < elList.scrollTop) elList.scrollTop = y0
  else if (y1 > elList.scrollTop + elList.clientHeight) {
    elList.scrollTop = y1 - elList.clientHeight
  }
}

elList.addEventListener('scroll', renderVisible)

// ── 预览（防抖 + 竞态取消）──
let previewTimer = 0
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE)
}

async function runPreview() {
  const seq = ++S.previewSeq
  const e = S.filtered[S.sel]
  if (!e) {
    S.preview = { kind: 'none' }
    renderPreview()
    return
  }
  const path = absOf(e)
  S.preview = { kind: 'loading', name: e.name }
  renderPreview()
  try {
    if (e.kind === 'dir') {
      const r = await tm.fs.list(path)
      if (seq !== S.previewSeq) return
      const names = r.entries.slice(0, 8).map((x) => x.name + (x.kind === 'dir' ? '/' : ''))
      S.preview = { kind: 'dir', name: e.name, count: r.entries.length, truncated: r.truncated, names }
    } else if (e.kind === 'symlink') {
      const st = await tm.fs.stat(path)
      if (seq !== S.previewSeq) return
      S.preview = { kind: 'meta', name: e.name, lines: ['符号链接 → ' + (st.target ?? '?'), fmtSize(e.size) + ' · ' + new Date(e.mtime).toLocaleString()] }
    } else if (IMAGE_EXTS.has(extOf(e.name)) && e.size > 0) {
      const r = await tm.fs.readBase64(path)
      if (seq !== S.previewSeq) return
      if (r.truncated) {
        S.preview = { kind: 'meta', name: e.name, lines: [fmtSize(e.size) + ' · 超出预览上限，仅展示前 8MB'] }
      } else {
        S.preview = { kind: 'image', name: e.name, data: r.data, ext: extOf(e.name) }
      }
    } else if (e.size > 0) {
      try {
        const r = await tm.fs.readText(path)
        if (seq !== S.previewSeq) return
        const lines = r.text.split('\n', MAX_PREVIEW_LINES + 1)
        const cut = lines.length > MAX_PREVIEW_LINES
        S.preview = { kind: 'text', name: e.name, lines: lines.slice(0, MAX_PREVIEW_LINES), truncated: r.truncated || cut, size: r.size }
      } catch (err) {
        if (seq !== S.previewSeq) return
        // 宿主对前 8KB 含 NUL 的读取判二进制拒绝
        S.preview = { kind: 'binary', name: e.name, size: e.size }
      }
    } else {
      S.preview = { kind: 'meta', name: e.name, lines: ['空文件'] }
    }
  } catch (err) {
    if (seq !== S.previewSeq) return
    S.preview = { kind: 'error', name: e.name, error: String(err && err.message || err) }
  }
  if (seq === S.previewSeq) renderPreview()
}

function renderPreview() {
  const p = S.preview
  elPreview.scrollTop = 0
  elPreview.classList.toggle('folded', S.pvFold)
  if (p.kind === 'none') {
    elPreview.innerHTML = ''
    return
  }
  // 标题行 = 折叠箭头 + 「预览」标签 + 条目名；整行可点折叠/展开。
  // 没有这行标注时，用户无从知道下方块是选中条目的预览（真实反馈：
  // 「下半部分的迅雷下载是什么东西」）
  elPreview.innerHTML = ''
  const title = document.createElement('div')
  title.className = 'pv-title'
  title.title = S.pvFold ? '展开预览' : '折叠预览'
  const fold = document.createElement('span')
  fold.className = 'pv-fold'
  fold.textContent = S.pvFold ? '▸' : '▾'
  const tag = document.createElement('span')
  tag.className = 'pv-tag'
  tag.textContent = '预览'
  const nm = document.createElement('span')
  nm.className = 'pv-name'
  nm.textContent = p.name
  title.appendChild(fold)
  title.appendChild(tag)
  title.appendChild(nm)
  elPreview.appendChild(title)
  if (p.kind === 'loading') {
    const d = document.createElement('div')
    d.className = 'pv-dim'
    d.textContent = '…'
    elPreview.appendChild(d)
  } else if (p.kind === 'dir') {
    const meta = document.createElement('div')
    meta.className = 'pv-meta'
    meta.textContent = '目录 · ' + p.count + ' 项' + (p.truncated ? '（超出单目录上限，已截断）' : '')
    elPreview.appendChild(meta)
    for (const nm of p.names) {
      const d = document.createElement('div')
      d.className = 'pv-dir-line'
      d.textContent = nm
      elPreview.appendChild(d)
    }
    if (p.count > p.names.length) {
      const d = document.createElement('div')
      d.className = 'pv-dim'
      d.textContent = '… 共 ' + p.count + ' 项'
      elPreview.appendChild(d)
    }
  } else if (p.kind === 'image') {
    const img = document.createElement('img')
    img.src = 'data:image/' + (p.ext === 'svg' ? 'svg+xml' : p.ext) + ';base64,' + p.data
    elPreview.appendChild(img)
  } else if (p.kind === 'text') {
    const pre = document.createElement('pre')
    pre.textContent = p.lines.join('\n')
    elPreview.appendChild(pre)
    if (p.truncated) {
      const d = document.createElement('div')
      d.className = 'pv-trunc'
      d.textContent = '（内容已截断 · ' + fmtSize(p.size) + '）'
      elPreview.appendChild(d)
    }
  } else if (p.kind === 'binary') {
    const d = document.createElement('div')
    d.className = 'pv-dim'
    d.textContent = '二进制文件 · ' + fmtSize(p.size)
    elPreview.appendChild(d)
  } else if (p.kind === 'meta') {
    for (const line of p.lines) {
      const d = document.createElement('div')
      d.className = 'pv-dir-line'
      d.textContent = line
      elPreview.appendChild(d)
    }
  } else if (p.kind === 'error') {
    const d = document.createElement('div')
    d.className = 'pv-dim'
    d.textContent = '预览失败：' + p.error
    elPreview.appendChild(d)
  }
}

// 预览标题行点击 → 折叠/展开（委托：标题每次渲染重建，监听只挂一次）。
// 折叠态持久化，窄面板把空间还给列表
elPreview.addEventListener('click', (ev) => {
  if (ev.target instanceof Element && ev.target.closest('.pv-title')) {
    S.pvFold = !S.pvFold
    localStorage.setItem('files.pvFold', S.pvFold ? '1' : '0')
    renderPreview()
  }
})

// ── 目录加载 ──
async function loadDir(path, opts) {
  const seq = ++S.listSeq
  try {
    const r = await tm.fs.list(path)
    if (seq !== S.listSeq) return
    S.cwd = r.path
    S.entries = r.entries
    // 导航（进入/返回/跳转）即退出查找结果视图与可视模式；过滤清回全量，
    // 刷新（keepFilter）保留过滤词
    S.findResults = null
    S.visual = null
    S.pendingPrefix = null
    if (!(opts && opts.keepFilter)) {
      S.filter = ''
      S.mode = null
      hideInput()
    }
    S.sel = 0
    applyFilter()
    renderPath()
    renderList()
    schedulePreview()
    // 导航历史：用户主动导航才入栈（跟随终端/刷新不污染）；跳到与当前位置
    // 相同的路径不重复入栈
    if (!(opts && (opts.noHistory || opts.fromHistory))) {
      if (S.hist[S.histAt] !== r.path) {
        S.hist = S.hist.slice(0, S.histAt + 1)
        S.hist.push(r.path)
        if (S.hist.length > 100) S.hist.shift()
        S.histAt = S.hist.length - 1
      }
    }
    if (r.truncated) setMsg('目录过大，仅显示前 ' + r.entries.length + ' 项')
    else if (!(opts && opts.quiet)) setMsg('')
    if (opts && opts.select) {
      const i = S.filtered.findIndex((e) => e.name === opts.select)
      if (i >= 0) {
        S.sel = i
        renderVisible()
        schedulePreview()
      }
    }
    ensureVisible()
  } catch (err) {
    if (seq !== S.listSeq) return
    setMsg('无法打开 ' + path + '：' + String((err && err.message) || err), true)
  }
}

async function reload() {
  await loadDir(S.cwd, { quiet: true, keepFilter: true, noHistory: true })
}

// ── 行内输入（过滤/新建/改名/查找/直达路径）──
function showInput(mode, initial) {
  S.mode = mode
  S.confirmTrash = null
  elInputLine.classList.add('show')
  elLabel.textContent =
    mode === 'filter'
      ? '过滤:'
      : mode === 'newfile'
        ? '新建:'
        : mode === 'rename'
          ? '改名:'
          : mode === 'goto'
            ? '路径:'
            : '查找:'
  elInput.value = initial || ''
  elInput.focus()
  if (mode !== 'filter') elInput.select()
}

function hideInput() {
  S.mode = null
  elInputLine.classList.remove('show')
  elList.focus()
}

elInput.addEventListener('input', () => {
  if (S.mode === 'filter') {
    S.filter = elInput.value
    applyFilter()
    renderList()
  }
})
elInput.addEventListener('keydown', (ev) => {
  ev.stopPropagation()
  if (ev.key === 'Escape') {
    if (S.mode === 'filter') {
      S.filter = ''
      applyFilter()
      renderList()
    }
    hideInput()
  } else if (ev.key === 'Enter') {
    submitInput()
  }
})

function submitInput() {
  const v = elInput.value.trim()
  if (S.mode === 'newfile' && v) {
    const isDir = v.endsWith('/')
    const name = isDir ? v.slice(0, -1) : v
    if (!name || name.includes('/')) {
      setMsg('名称不能为空或含 /', true)
      return
    }
    const path = joinPath(S.cwd, name)
    const p = isDir ? tm.fs.mkdir(path) : tm.fs.write(path, '')
    p.then(() => loadDir(S.cwd, { select: name, quiet: true }).then(() => setMsg('已创建 ' + name)))
      .catch((err) => setMsg('创建失败：' + String((err && err.message) || err), true))
    hideInput()
  } else if (S.mode === 'rename' && v && S.renameFrom) {
    if (v.includes('/')) {
      setMsg('名称不能含 /', true)
      return
    }
    const to = joinPath(S.cwd, v)
    tm.fs.rename(S.renameFrom, to)
      .then(() => loadDir(S.cwd, { select: v, quiet: true }).then(() => setMsg('已改名 ' + baseName(S.renameFrom) + ' → ' + v)))
      .catch((err) => setMsg('改名失败：' + String((err && err.message) || err), true))
    S.renameFrom = null
    hideInput()
  } else if (S.mode === 'goto' && v) {
    hideInput()
    if (!v.startsWith('/')) {
      setMsg('路径须以 / 开头（绝对路径）', true)
      return
    }
    // 直达：目录即进入；文件跳父目录并选中
    tm.fs
      .stat(v)
      .then((st) => {
        if (st.kind === 'dir') return loadDir(st.path)
        return loadDir(parentOf(st.path), { select: baseName(st.path) })
      })
      .catch((err) => setMsg('无法打开：' + String((err && err.message) || err), true))
  } else if (S.mode === 'find') {
    hideInput()
    if (v) runFind(v)
  } else {
    // filter：保留过滤退出输入（再打字继续追加），Esc 才清除
    hideInput()
  }
}

// ── 递归查找（结果视图）──
function runFind(q) {
  setMsg('查找「' + q + '」…')
  tm.fs
    .find(S.cwd, q)
    .then((r) => {
      S.findResults = { root: r.root, q, truncated: r.truncated }
      S.filter = ''
      S.sel = 0
      // 结果条目：name 为相对路径（展示），abs 为绝对路径（导航/预览/批量
      // 操作统一走 absOf）
      S.filtered = r.items.map((it) => ({
        name: it.rel,
        kind: it.kind,
        size: it.size,
        mtime: it.mtime,
        abs: joinPath(r.root, it.rel)
      }))
      renderPath()
      renderList()
      schedulePreview()
      renderStatus()
      setMsg(r.truncated ? '结果过多已截断，请收窄关键词' : '')
    })
    .catch((err) => setMsg('查找失败：' + String((err && err.message) || err), true))
}

function exitFind() {
  S.findResults = null
  applyFilter()
  renderPath()
  renderList()
  schedulePreview()
  renderStatus()
}

// ── 终端联动 ──
async function activeTerm() {
  const id = await tm.tabs.active()
  return id || null
}

async function yankPath() {
  const paths = targets()
  if (!paths.length) return
  const id = await activeTerm()
  if (!id) {
    setMsg('没有活动标签', true)
    return
  }
  tm.terminals.write(id, paths.map(quotePath).join(' ') + ' ')
  setMsg('已贴入 ' + paths.length + ' 个路径')
}

async function cdHere() {
  const e = S.filtered[S.sel]
  if (!e || e.kind !== 'dir') {
    setMsg('c 仅对目录生效', true)
    return
  }
  const id = await activeTerm()
  if (!id) {
    setMsg('没有活动标签', true)
    return
  }
  tm.terminals.write(id, 'cd ' + quotePath(joinPath(S.cwd, e.name)) + '\r')
  setMsg('已发送 cd ' + e.name)
}

async function newTabHere() {
  const e = S.filtered[S.sel]
  const dir = e ? (e.kind === 'dir' ? joinPath(S.cwd, e.name) : S.cwd) : S.cwd
  try {
    await tm.tabs.create(undefined, dir)
    setMsg('已在 ' + dir + ' 打开新标签')
  } catch (err) {
    setMsg('打开失败：' + String((err && err.message) || err), true)
  }
}

// ── 批量选择 ──
function inVisualRange(i) {
  if (S.visual == null) return false
  const a = Math.min(S.visual, S.sel)
  const b = Math.max(S.visual, S.sel)
  return i >= a && i <= b
}

function toggleMark() {
  const e = S.filtered[S.sel]
  if (!e) return
  const p = absOf(e)
  if (S.selected.has(p)) S.selected.delete(p)
  else S.selected.add(p)
  renderVisible()
  renderStatus()
}

function toggleSelectAll() {
  const all = S.filtered.map(absOf)
  if (all.length && all.every((p) => S.selected.has(p))) {
    all.forEach((p) => S.selected.delete(p))
  } else {
    all.forEach((p) => S.selected.add(p))
  }
  renderVisible()
  renderStatus()
}

function enterVisual() {
  if (!S.filtered.length) return
  S.visual = S.sel
  renderVisible()
  renderStatus()
}

function exitVisual(commit) {
  if (S.visual == null) return
  if (commit) {
    S.filtered.forEach((e, i) => {
      if (inVisualRange(i)) S.selected.add(absOf(e))
    })
  }
  S.visual = null
  renderVisible()
  renderStatus()
}

// ── 文件剪贴板（复制/剪切 → 粘贴）──
function yankFiles(mode) {
  const paths = targets()
  if (!paths.length) return
  S.clip = { mode, paths }
  renderVisible()
  renderStatus()
  setMsg((mode === 'copy' ? '已复制 ' : '已剪切 ') + paths.length + ' 项（p 粘贴 · P 覆盖粘贴）')
}

async function paste(overwrite) {
  if (!S.clip || !S.clip.paths.length) {
    setMsg('剪贴板为空（Y 复制 / X 剪切）', true)
    return
  }
  const clip = S.clip
  let done = 0
  let skipped = 0
  const failed = []
  for (const src of clip.paths) {
    const dst = joinPath(S.cwd, baseName(src))
    if (dst === src) {
      skipped++
      continue
    }
    try {
      if (clip.mode === 'copy') await tm.fs.copy(src, dst, { overwrite })
      else await tm.fs.move(src, dst, { overwrite })
      // 剪切后源路径已不存在（复制则保持 yazi 习惯不清选中）：选中集里
      // 清掉失效路径，粘贴产物不自动选中
      S.selected.delete(src)
      S.selected.delete(dst)
      done++
    } catch (err) {
      const m = String((err && err.message) || err)
      if (/exist/i.test(m)) skipped++
      else failed.push(baseName(src) + '：' + m)
    }
  }
  if (clip.mode === 'cut') S.clip = null
  await loadDir(S.cwd, { quiet: true, keepFilter: true, noHistory: true })
  const parts = ['已粘贴 ' + done + ' 项']
  if (skipped) parts.push('跳过已存在 ' + skipped + ' 项（P 覆盖）')
  if (failed.length) parts.push('失败 ' + failed.length + ' 项：' + failed[0])
  setMsg(parts.join(' · '), failed.length > 0)
}

// ── 排序 ──
function setSort(patch) {
  Object.assign(S.sort, patch)
  localStorage.setItem('files.sort', JSON.stringify(S.sort))
  applyFilter()
  renderList()
  schedulePreview()
  renderStatus()
}

// ── 导航历史 ──
function histGo(d) {
  const t = S.histAt + d
  if (t < 0 || t >= S.hist.length) {
    setMsg(d < 0 ? '已到最早位置' : '已到最新位置')
    return
  }
  S.histAt = t
  loadDir(S.hist[t], { fromHistory: true })
}

// ── 删除（回收站 + 确认条，整批）──
function askTrash() {
  const paths = targets()
  if (!paths.length) return
  S.confirmTrash = paths
  S.mode = null
  hideInput()
  renderStatus()
}

async function doTrash() {
  const paths = S.confirmTrash || []
  S.confirmTrash = null
  renderStatus()
  if (!paths.length) return
  let done = 0
  const failed = []
  for (const p of paths) {
    try {
      await tm.fs.trash(p)
      S.selected.delete(p)
      done++
    } catch (err) {
      failed.push(baseName(p) + '：' + String((err && err.message) || err))
    }
  }
  await loadDir(S.cwd, { quiet: true, keepFilter: true, noHistory: true })
  if (failed.length) setMsg('部分删除失败：' + failed.join(' · '), true)
  else setMsg('已移入回收站 ' + done + ' 项')
}

// ── 状态条 ──
function renderStatus() {
  elStatus.classList.toggle('confirm', !!S.confirmTrash)
  elStatus.classList.toggle('err', !S.confirmTrash && S.err)
  if (S.confirmTrash) {
    elMsg.textContent =
      S.confirmTrash.length === 1
        ? '移入回收站：' + baseName(S.confirmTrash[0]) + ' ？（y 确认 / n 取消）'
        : '移入回收站：' + S.confirmTrash.length + ' 项？（y 确认 / n 取消）'
  } else {
    const parts = []
    if (S.visual != null) parts.push('可视选择（V 完成 · Esc 取消）')
    else if (S.selected.size) parts.push('已选 ' + S.selected.size + ' 项')
    if (S.clip) parts.push((S.clip.mode === 'copy' ? '已复制 ' : '已剪切 ') + S.clip.paths.length + ' 项')
    if (S.sort.by !== 'name' || !S.sort.dirsFirst) {
      parts.push('排序:' + (S.sort.by === 'name' ? '名称' : S.sort.by === 'mtime' ? '时间' : '大小') + (S.sort.dirsFirst ? '·目录优先' : ''))
    }
    if (S.findResults) parts.push('查到 ' + S.filtered.length + ' 项（Esc 退出）')
    if (S.filter) parts.push('过滤「' + S.filter + '」· ' + S.filtered.length + '/' + S.entries.length + ' 项')
    if (S.msg) parts.push(S.msg)
    elMsg.textContent = parts.join(' · ')
  }
}

// ── 键位 ──
function moveSel(delta) {
  const n = S.filtered.length
  if (!n) return
  S.sel = Math.min(n - 1, Math.max(0, S.sel + delta))
  renderVisible()
  ensureVisible()
  schedulePreview()
}

function activateSel() {
  const e = S.filtered[S.sel]
  if (!e) return
  if (S.findResults) {
    // 查找结果视图：目录（或指向目录的链接）进入；文件跳父目录并选中
    const p = absOf(e)
    if (e.kind === 'dir' || e.kind === 'symlink') {
      loadDir(p)
    } else {
      loadDir(parentOf(p), { select: baseName(p) })
    }
    return
  }
  if (e.kind === 'dir' || e.kind === 'symlink') {
    // 目录（或指向目录的链接）尝试进入；链接坏/指向文件则由 list 报错兜底
    loadDir(absOf(e))
  } else {
    // 文件：无默认打开动作（避免误执行），聚焦预览即可
    elPreview.scrollTop = 0
  }
}

function goUp() {
  const p = parentOf(S.cwd)
  if (!p) return
  loadDir(p, { select: baseName(S.cwd) })
}

document.addEventListener('keydown', (ev) => {
  // 输入模式与确认条优先（elInput 的 keydown 已 stopPropagation，这里只在
  // 非输入焦点时到达；确认条是 status 呈现，键盘仍走全局）
  if (S.confirmTrash) {
    if (ev.key === 'y' || ev.key === 'Y' || ev.key === 'Enter') {
      ev.preventDefault()
      void doTrash()
    } else if (ev.key === 'n' || ev.key === 'N' || ev.key === 'Escape') {
      ev.preventDefault()
      S.confirmTrash = null
      renderStatus()
    }
    return
  }
  // Ctrl/Cmd+A 全选/清空（输入框内不到这里：elInput 已 stopPropagation，
  // 浏览器原生全选保留）
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'a' || ev.key === 'A')) {
    ev.preventDefault()
    toggleSelectAll()
    return
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return
  const k = ev.key
  // 前缀序列（600ms 窗口）：, 排序 · m 设置书签 · ' 跳书签；不认识的后继键
  // 落回常规处理
  if (S.pendingPrefix && Date.now() - S.pendingAt < 600) {
    const what = S.pendingPrefix
    S.pendingPrefix = null
    if (what === 'sort' && (k === 'n' || k === 'm' || k === 's' || k === 'd')) {
      ev.preventDefault()
      if (k === 'n') setSort({ by: 'name' })
      else if (k === 'm') setSort({ by: 'mtime' })
      else if (k === 's') setSort({ by: 'size' })
      else setSort({ dirsFirst: !S.sort.dirsFirst })
      setMsg('排序：' + (S.sort.by === 'name' ? '名称' : S.sort.by === 'mtime' ? '修改时间' : '大小') + (S.sort.dirsFirst ? ' · 目录优先' : ''))
      return
    }
    if (what === 'mark' && /^[a-zA-Z0-9]$/.test(k)) {
      ev.preventDefault()
      S.bookmarks[k] = S.cwd
      localStorage.setItem('files.bookmarks', JSON.stringify(S.bookmarks))
      setMsg('书签 «' + k + '» → ' + S.cwd)
      return
    }
    if (what === 'jump' && /^[a-zA-Z0-9]$/.test(k)) {
      ev.preventDefault()
      const p = S.bookmarks[k]
      if (p) loadDir(p)
      else setMsg('无书签 «' + k + '»', true)
      return
    }
  } else {
    S.pendingPrefix = null
  }
  if (k === 'j' || k === 'ArrowDown') {
    ev.preventDefault()
    moveSel(1)
  } else if (k === 'k' || k === 'ArrowUp') {
    ev.preventDefault()
    moveSel(-1)
  } else if (k === 'g') {
    const now = Date.now()
    if (now - S.lastG < 500) {
      ev.preventDefault()
      S.lastG = 0
      S.sel = 0
      renderVisible()
      ensureVisible()
      schedulePreview()
    } else {
      S.lastG = now
    }
  } else if (k === 'G' || k === 'End') {
    ev.preventDefault()
    S.sel = Math.max(0, S.filtered.length - 1)
    renderVisible()
    ensureVisible()
    schedulePreview()
  } else if (k === 'Home') {
    ev.preventDefault()
    S.sel = 0
    renderVisible()
    ensureVisible()
    schedulePreview()
  } else if (k === 'Enter' || k === 'l' || k === 'ArrowRight') {
    ev.preventDefault()
    activateSel()
  } else if (k === 'h' || k === 'ArrowLeft' || k === 'Backspace') {
    ev.preventDefault()
    goUp()
  } else if (k === 'r') {
    ev.preventDefault()
    reload().then(() => setMsg('已刷新'))
  } else if (k === '.') {
    ev.preventDefault()
    S.showHidden = !S.showHidden
    localStorage.setItem('files.showHidden', S.showHidden ? '1' : '0')
    applyFilter()
    renderList()
    schedulePreview()
    setMsg(S.showHidden ? '显示隐藏文件' : '隐藏点文件')
  } else if (k === 'y') {
    ev.preventDefault()
    void yankPath()
  } else if (k === 'c') {
    ev.preventDefault()
    void cdHere()
  } else if (k === 't') {
    ev.preventDefault()
    void newTabHere()
  } else if (k === 'a') {
    ev.preventDefault()
    showInput('newfile', '')
  } else if (k === 'F2') {
    ev.preventDefault()
    const e = S.filtered[S.sel]
    if (e) {
      S.renameFrom = absOf(e)
      showInput('rename', e.name)
    }
  } else if (k === 'x' || k === 'Delete') {
    ev.preventDefault()
    askTrash()
  } else if (k === ' ') {
    ev.preventDefault()
    toggleMark()
  } else if (k === 'v') {
    ev.preventDefault()
    enterVisual()
  } else if (k === 'V') {
    ev.preventDefault()
    exitVisual(true)
  } else if (k === 'Y') {
    ev.preventDefault()
    yankFiles('copy')
  } else if (k === 'X') {
    ev.preventDefault()
    yankFiles('cut')
  } else if (k === 'p') {
    ev.preventDefault()
    void paste(false)
  } else if (k === 'P') {
    ev.preventDefault()
    void paste(true)
  } else if (k === ',') {
    ev.preventDefault()
    S.pendingPrefix = 'sort'
    S.pendingAt = Date.now()
  } else if (k === 'm') {
    ev.preventDefault()
    S.pendingPrefix = 'mark'
    S.pendingAt = Date.now()
  } else if (k === "'") {
    ev.preventDefault()
    S.pendingPrefix = 'jump'
    S.pendingAt = Date.now()
  } else if (k === 's') {
    ev.preventDefault()
    showInput('find', '')
  } else if (k === ':') {
    ev.preventDefault()
    showInput('goto', S.cwd)
  } else if (k === 'H') {
    ev.preventDefault()
    histGo(-1)
  } else if (k === 'L') {
    ev.preventDefault()
    histGo(1)
  } else if (k === '/') {
    ev.preventDefault()
    showInput('filter', S.filter)
  } else if (k === 'Escape') {
    ev.preventDefault()
    if (S.visual != null) {
      exitVisual(false)
    } else if (S.filter) {
      S.filter = ''
      applyFilter()
      renderList()
      schedulePreview()
      renderStatus()
    } else if (S.findResults) {
      exitFind()
    } else {
      tm.panel.close()
    }
  } else if (k.length === 1 && !ev.repeat && S.visual == null) {
    // 直接打字进入过滤（yazi 习惯：免按 /）；追加到现有词。被动作占用的
    // 字母（v/Y/X/p/P/m/s 等）从这里让位，过滤用 / 显式进入
    ev.preventDefault()
    showInput('filter', S.filter + k)
    elInput.setSelectionRange(elInput.value.length, elInput.value.length)
  }
})

// ── 路径行按钮 ──
$('up').addEventListener('click', goUp)
$('refresh').addEventListener('click', () => {
  reload().then(() => setMsg('已刷新'))
})
$('follow').addEventListener('click', () => {
  S.follow = !S.follow
  localStorage.setItem('files.followTerm', S.follow ? '1' : '0')
  renderPath()
  if (S.follow) void followTermCwd()
})

// ── 跟随活动终端（尽力而为：终端消失/后端未就绪静默）──
async function followTermCwd(id) {
  try {
    const termId = id || (await tm.tabs.active())
    if (!termId) return
    const cwd = await tm.terminals.cwd(termId)
    if (cwd && S.follow && cwd !== S.cwd) {
      // 跟随是后台漂移不是用户导航：不进历史栈
      await loadDir(cwd, { quiet: true, noHistory: true })
      setMsg('已跟随终端 → ' + cwd)
    }
  } catch {
    // 静默
  }
}

tm.on('tab-activated', (e) => {
  if (S.follow && e && e.id) void followTermCwd(e.id)
})

// ── 主题适配 ──
async function applyColors() {
  try {
    const colors = await tm.ui.colors()
    const root = document.documentElement
    for (const [key, v] of Object.entries(colors || {})) {
      root.style.setProperty('--' + key, v)
    }
  } catch {
    // 主题拉取失败保持默认色
  }
}

tm.on('scheme-changed', () => {
  void applyColors()
})

// ── e2e 快照（帧桥应答器存在时才挂：发布构建无 responder，这段永不激活）──
if (window.__TMPLUG_E2E__) {
  window.__e2ePlugin = () => ({
    cwd: S.cwd,
    sel: S.filtered[S.sel] ? S.filtered[S.sel].name : null,
    selKind: S.filtered[S.sel] ? S.filtered[S.sel].kind : null,
    count: S.filtered.length,
    total: S.entries.length,
    filter: S.filter,
    mode: S.mode,
    follow: S.follow,
    confirm: S.confirmTrash,
    preview: S.preview.kind,
    msg: S.msg,
    // 批量选择 / 剪贴板 / 排序 / 历史 / 查找视图
    selN: S.selected.size,
    visual: S.visual != null,
    clip: S.clip ? S.clip.mode + ':' + S.clip.paths.length : null,
    sort: S.sort.by + (S.sort.dirsFirst ? '+d' : ''),
    histN: S.hist.length,
    histAt: S.histAt,
    view: S.findResults ? 'find' : 'dir',
    findQ: S.findResults ? S.findResults.q : null,
    names: S.filtered.slice(0, 10).map((e) => e.name),
    // 布局几何：前三个渲染行的视口 top（严格递增才算行真正铺开）、空态遮罩
    // 可见性、预览折叠态——纯视觉缺陷状态快照照不见，用几何量守
    rowTops: [...document.querySelectorAll('#list .row')]
      .slice(0, 3)
      .map((r) => Math.round(r.getBoundingClientRect().top)),
    emptyShown: !elEmpty.hidden,
    pvFold: S.pvFold
  })
}

// ── 启动 ──
void applyColors()
;(async () => {
  // 初始目录：活动终端的工作目录（面板语境下最相关的位置），拿不到回退根
  let start = '/'
  try {
    const id = await tm.tabs.active()
    if (id) start = (await tm.terminals.cwd(id)) || '/'
  } catch {
    // 无标签/后端未就绪
  }
  await loadDir(start)
})()

// 文件面板（官方插件 files）：yazi 式文件管理
// ─────────────────────────────────────────────────────────────────────────────
// 运行在 tmplug://files 沙箱 iframe 里，唯一通道是帧桥暴露的 termManager API
//（postMessage RPC）。文件访问走 fs.*（宿主主进程侧权限 gate 与防御），
// 终端联动走 terminals.write/tabs.create，主题适配走 ui.colors + scheme-changed。
// UI 是手写 DOM + 简单虚拟滚动（行高固定 24px，万级目录不卡）。
//
// 键位（yazi 习惯）：j/k/↑↓ 移动 · Enter/l 进入 · h/Backspace 上一级 ·
// gg/G/Home/End 跳转 · 直接打字过滤（Esc 清除）· r 刷新 · . 隐藏文件开关 ·
// y 贴路径到终端 · c cd 到此 · t 在此开新标签 · a 新建 · F2 改名 · x 删除
//（移入回收站，按 y 确认）· Esc 关面板/退出输入。

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
  filtered: [], // 过滤（+隐藏文件剔除）与排序后的视图
  sel: 0,
  filter: '',
  showHidden: localStorage.getItem('files.showHidden') === '1',
  follow: localStorage.getItem('files.followTerm') === '1',
  mode: null, // null | 'filter' | 'newfile' | 'rename'
  renameFrom: null, // rename 模式下待改名的绝对路径
  confirmTrash: null, // 待确认删除的绝对路径（status 条 y/n）
  msg: '',
  err: false,
  lastG: 0, // gg 序列检测
  listSeq: 0, // 目录加载竞态取消
  previewSeq: 0, // 预览竞态取消
  preview: { kind: 'none' } // none|loading|text|image|dir|binary|meta|error
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
  <div id="status"><span class="msg"></span><span class="hint">j/k 移动 · Enter 进入 · / 过滤 · y 贴路径 · c cd · t 新标签 · a 新建 · F2 改名 · x 删除</span></div>
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
  elPath.textContent = S.cwd
  elPath.title = S.cwd
  $('follow').classList.toggle('on', S.follow)
}

function applyFilter() {
  let list = S.entries
  if (!S.showHidden) list = list.filter((e) => !e.name.startsWith('.'))
  if (S.filter) {
    list = list.filter((e) => fuzzy(e.name, S.filter) !== null)
  }
  // 目录优先，名称自然排序
  list = [...list].sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1
    const bd = b.kind === 'dir' ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
  S.filtered = list
  if (S.sel >= list.length) S.sel = Math.max(0, list.length - 1)
}

function renderList() {
  const n = S.filtered.length
  elEmpty.hidden = n !== 0 || !!S.filter
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
  row.className = 'row ' + (e.kind === 'dir' ? 'dir' : e.kind === 'symlink' ? 'link' : '') + (i === S.sel ? ' sel' : '')
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
  const path = joinPath(S.cwd, e.name)
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
  if (p.kind === 'none') {
    elPreview.innerHTML = ''
    return
  }
  const title = document.createElement('div')
  title.className = 'pv-title'
  title.textContent = p.name
  elPreview.innerHTML = ''
  elPreview.appendChild(title)
  if (p.kind === 'loading') {
    const d = document.createElement('div')
    d.className = 'pv-dim'
    d.textContent = '…'
    elPreview.appendChild(d)
  } else if (p.kind === 'dir') {
    const meta = document.createElement('div')
    meta.className = 'pv-meta'
    meta.textContent = p.count + ' 项' + (p.truncated ? '（超出单目录上限，已截断）' : '')
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

// ── 目录加载 ──
async function loadDir(path, opts) {
  const seq = ++S.listSeq
  try {
    const r = await tm.fs.list(path)
    if (seq !== S.listSeq) return
    S.cwd = r.path
    S.entries = r.entries
    // 导航（进入/返回）清过滤回到全量视图；刷新（keepFilter）保留过滤词
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
  await loadDir(S.cwd, { quiet: true, keepFilter: true })
}

// ── 行内输入（过滤/新建/改名）──
function showInput(mode, initial) {
  S.mode = mode
  S.confirmTrash = null
  elInputLine.classList.add('show')
  elLabel.textContent = mode === 'filter' ? '过滤:' : mode === 'newfile' ? '新建:' : '改名:'
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
  } else {
    // filter：保留过滤退出输入（再打字继续追加），Esc 才清除
    hideInput()
  }
}

// ── 终端联动 ──
async function activeTerm() {
  const id = await tm.tabs.active()
  return id || null
}

async function yankPath() {
  const e = S.filtered[S.sel]
  if (!e) return
  const id = await activeTerm()
  if (!id) {
    setMsg('没有活动标签', true)
    return
  }
  tm.terminals.write(id, quotePath(joinPath(S.cwd, e.name)) + ' ')
  setMsg('已贴入路径：' + e.name)
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

// ── 删除（回收站 + 确认条）──
function askTrash() {
  const e = S.filtered[S.sel]
  if (!e) return
  S.confirmTrash = joinPath(S.cwd, e.name)
  S.mode = null
  hideInput()
  renderStatus()
}

async function doTrash() {
  const path = S.confirmTrash
  S.confirmTrash = null
  renderStatus()
  if (!path) return
  try {
    await tm.fs.trash(path)
    await reload()
    setMsg('已移入回收站：' + baseName(path))
  } catch (err) {
    setMsg('删除失败：' + String((err && err.message) || err), true)
  }
}

// ── 状态条 ──
function renderStatus() {
  elStatus.classList.toggle('confirm', !!S.confirmTrash)
  elStatus.classList.toggle('err', !S.confirmTrash && S.err)
  if (S.confirmTrash) {
    elMsg.textContent = '移入回收站：' + baseName(S.confirmTrash) + ' ？（y 确认 / n 取消）'
  } else {
    const parts = []
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
  if (e.kind === 'dir' || e.kind === 'symlink') {
    // 目录（或指向目录的链接）尝试进入；链接坏/指向文件则由 list 报错兜底
    loadDir(joinPath(S.cwd, e.name), { select: undefined })
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
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return
  const k = ev.key
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
      S.renameFrom = joinPath(S.cwd, e.name)
      showInput('rename', e.name)
    }
  } else if (k === 'x' || k === 'Delete') {
    ev.preventDefault()
    askTrash()
  } else if (k === '/') {
    ev.preventDefault()
    showInput('filter', S.filter)
  } else if (k === 'Escape') {
    ev.preventDefault()
    if (S.filter) {
      S.filter = ''
      applyFilter()
      renderList()
      schedulePreview()
      renderStatus()
    } else {
      tm.panel.close()
    }
  } else if (k.length === 1 && !ev.repeat) {
    // 直接打字进入过滤（yazi 习惯：免按 /）；追加到现有词
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
      await loadDir(cwd, { quiet: true })
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
    msg: S.msg
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

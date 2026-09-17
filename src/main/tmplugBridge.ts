// Tier 2 帧桥：tmplug://<id>/__tmplug_bridge__.js 的响应体（主进程合成下发，
// 不读磁盘）。它运行在插件的沙箱 iframe 里，做三件事：
//   1. 暴露 window.termManager——API 形状与 Tier 1 相同，带返回值的方法
//      （registerCommand/registerTheme/tabs.list/tabs.active）经 postMessage
//      RPC 异步化，其余为通知式（不等回执）；
//   2. 把宿主推来的事件/终端数据/命令与状态栏点击回调，扇出到插件注册的
//      本地回调（回调函数永远不出帧，跨桥的只有数据与 token）；
//   3. 插件侧异常回传宿主控制台（帧的 console 渲染层默认看不到）。
//
// 这是字符串而非模块：作为普通 <script> 注入合成页，不得使用 import/export；
// 语法故意压到 ES5 风格（var/无箭头函数），任何现代 Chromium 都能跑。
// 写法约束：不使用反引号与 ${（本文件以模板字面量承载，见 BRIDGE_BODY）。

export const BRIDGE_BODY = `
'use strict'
;(function () {
  var META = window.__TMPLUG_META__
  if (!META || typeof META.id !== 'string') return

  var seq = 0
  var pending = new Map() // rid -> {resolve, reject}
  var cmdRuns = new Map() // 命令局部 id -> run 回调
  var statusClicks = new Map() // 状态栏 itemId -> onClick 回调
  var eventCbs = new Map() // 事件名 -> Map(token -> cb)
  var dataCbs = new Map() // 标签 id -> Map(token -> cb)
  var inited = null

  function send(msg) {
    msg.__tmplug = 1
    // targetOrigin 用 '*'：接收方（宿主）按 event.source 甄别来源，帧侧无秘密可泄
    parent.postMessage(msg, '*')
  }
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      seq += 1
      var rid = seq
      pending.set(rid, { resolve: resolve, reject: reject })
      send({ kind: 'call', id: rid, method: method, args: args })
      // 回执超时：宿主重载/帧被摘除时别让插件永久挂起
      setTimeout(function () {
        if (pending.delete(rid)) reject(new Error('tmplug rpc timeout: ' + method))
      }, 15000)
    })
  }
  function notify(method, args) {
    send({ kind: 'call', id: 0, method: method, args: args })
  }
  function logErr(e) {
    send({ kind: 'log', level: 'error', message: String((e && e.stack) || e) })
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (!d || d.__tmplug !== 1 || ev.source !== parent) return
    if (d.kind === 'reply') {
      var p = pending.get(d.id)
      if (!p) return
      pending.delete(d.id)
      if (d.ok) p.resolve(d.result)
      else p.reject(new Error(d.error || 'tmplug rpc error'))
      return
    }
    if (d.kind === 'event') {
      var m = eventCbs.get(d.event)
      if (m) m.forEach(function (cb) { try { Promise.resolve(cb(d.payload)).catch(logErr) } catch (e) { logErr(e) } })
      return
    }
    if (d.kind === 'data') {
      var dm = dataCbs.get(d.termId)
      if (dm) dm.forEach(function (cb) { try { Promise.resolve(cb(d.data)).catch(logErr) } catch (e) { logErr(e) } })
      return
    }
    if (d.kind === 'invoke') {
      var f = d.what === 'command' ? cmdRuns.get(d.cmdId) : d.what === 'status' ? statusClicks.get(d.itemId) : null
      if (typeof f === 'function') {
        try { Promise.resolve(f()).catch(logErr) } catch (e) { logErr(e) }
      }
    }
  })

  // 跨桥前把函数字段剥掉（结构化克隆会拒绝函数，回调改为本地表 + token 引用）
  function wireCommand(d) {
    var o = { id: d.id, label: d.label, hasRun: typeof d.run === 'function' }
    if (typeof d.keywords === 'string') o.keywords = d.keywords
    if (typeof d.hint === 'string') o.hint = d.hint
    if (o.hasRun) cmdRuns.set(d.id, d.run)
    return o
  }
  function wireTheme(t) {
    var o = { id: t.id, name: t.name, type: t.type }
    if (t.ui) o.ui = t.ui
    if (t.terminal) o.terminal = t.terminal
    return o
  }

  var api = {
    version: '1',
    info: { id: META.id, name: META.name, version: META.version },
    registerCommand: function (d) {
      return d && typeof d === 'object' ? call('registerCommand', [wireCommand(d)]) : Promise.resolve(false)
    },
    unregisterCommand: function (cid) {
      cmdRuns.delete(cid)
      notify('unregisterCommand', [cid])
    },
    registerTheme: function (t) {
      return t && typeof t === 'object' ? call('registerTheme', [wireTheme(t)]) : Promise.resolve(false)
    },
    unregisterTheme: function (id) {
      notify('unregisterTheme', [id])
    },
    on: function (event, cb) {
      if (typeof event !== 'string' || typeof cb !== 'function') return function () {}
      seq += 1
      var token = seq
      var m = eventCbs.get(event)
      if (!m) { m = new Map(); eventCbs.set(event, m) }
      m.set(token, cb)
      notify('on', [event, token])
      return function () {
        var cur = eventCbs.get(event)
        if (cur && cur.delete(token)) notify('off', [token])
      }
    },
    tabs: {
      list: function () { return call('tabs.list', []) },
      active: function () { return call('tabs.active', []) },
      activate: function (id) { notify('tabs.activate', [id]) },
      create: function (profileId, cwd) { return call('tabs.create', [profileId, cwd]) }
    },
    ui: {
      setTheme: function (mode) { notify('ui.setTheme', [mode]) },
      setScheme: function (id) { notify('ui.setScheme', [id]) },
      toggleSidebar: function () { notify('ui.toggleSidebar', []) },
      openSettings: function () { notify('ui.openSettings', []) }
    },
    terminals: {
      subscribe: function (termId, cb) {
        if (typeof termId !== 'string' || typeof cb !== 'function') return function () {}
        seq += 1
        var token = seq
        var m = dataCbs.get(termId)
        if (!m) { m = new Map(); dataCbs.set(termId, m) }
        m.set(token, cb)
        notify('sub', [termId, token])
        return function () {
          var cur = dataCbs.get(termId)
          if (cur && cur.delete(token)) notify('unsub', [token])
        }
      },
      write: function (termId, data) { notify('terminals.write', [termId, data]) }
    },
    statusbar: {
      setItem: function (itemId, item) {
        if (item === null || item === undefined) {
          statusClicks.delete(itemId)
          notify('statusbar.setItem', [itemId, null])
          return
        }
        var wire = null
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          wire = { text: item.text }
          if (typeof item.color === 'string') wire.color = item.color
          if (typeof item.tooltip === 'string') wire.tooltip = item.tooltip
          wire.hasClick = typeof item.onClick === 'function'
          if (wire.hasClick) statusClicks.set(itemId, item.onClick)
        }
        notify('statusbar.setItem', [itemId, wire])
      }
    }
  }

  window.termManager = {
    version: '1',
    init: function (id) {
      if (typeof id !== 'string' || id !== META.id) {
        throw new Error("termManager.init: 插件 id 必须是本插件的 id '" + META.id + "'")
      }
      if (!inited) inited = api
      return inited
    }
  }
})()
`

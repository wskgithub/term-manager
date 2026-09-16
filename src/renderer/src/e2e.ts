import type { Terminal } from '@xterm/xterm'
import { api, type Profile, type TabGroup, type TermInfo } from './api'

interface E2EState {
  created: number
  latencies: number[]
  errors: string[]
  done: boolean
  activeId: string
}

interface E2ECtx {
  getProfiles: () => Profile[]
  createTab: () => Promise<unknown>
  terms: { current: Map<string, Terminal> }
  // 会话恢复回归（--e2e-session phase2 断言用）
  getTabs: () => TermInfo[]
  getGroups: () => TabGroup[]
  getRenamed: () => string[]
  // 组内广播回归（--e2e-input 断言用）：广播中的组 id
  getBroadcast: () => string[]
  // 分组侧栏回归（--e2e-sidebar 断言用）：设置开关实时值
  getSidebarVisible: () => boolean
}

/**
 * E2E 测试驱动：由主进程通过 executeJavaScript 调用 __e2eStart(n)，
 * 经 React 的 newTab 批量创建标签（真实上屏），并对每个标签做 shell 回显往返测延迟，
 * 结果挂在 window.__e2e 上供主进程轮询。
 */
export function setupE2E(ctx: E2ECtx): void {
  const w = window as unknown as Record<string, unknown>
  const state: E2EState = { created: 0, latencies: [], errors: [], done: true, activeId: '' }
  w.__e2e = state

  w.__e2eStart = (n: number) => {
    void (async () => {
      state.done = false
      state.created = 0
      state.latencies = []
      state.errors = []
      const profiles: Profile[] = ctx.getProfiles()
      if (!profiles.length) {
        state.errors.push('no profile available')
        state.done = true
        return
      }
      for (let i = 0; i < n; i++) {
        try {
          const info = (await ctx.createTab()) as TermInfo | undefined
          if (!info) throw new Error('createTab returned nothing')
          state.activeId = info.id
          state.created++
          const marker = `BM${i}_${Math.random().toString(36).slice(2, 8)}`
          const t0 = performance.now()
          const lat = await new Promise<number>((resolve, reject) => {
            let buf = ''
            const off = api.onData((id, d) => {
              if (id !== info.id) return
              buf += d
              if (buf.includes(marker)) {
                off()
                resolve(performance.now() - t0)
              }
            })
            api.write(info.id, `echo ${marker}\r`)
            setTimeout(() => {
              off()
              reject(new Error('marker timeout'))
            }, 3000)
          })
          state.latencies.push(lat)
        } catch (e) {
          state.errors.push(String(e))
        }
        await new Promise((r) => setTimeout(r, 120))
      }
      const last = [...ctx.terms.current.values()].pop()
      last?.focus()
      state.done = true
    })()
  }

  w.__e2eFocus = () => {
    const last = [...ctx.terms.current.values()].pop()
    last?.focus()
    return !!last
  }

  // 对活动终端的 textarea 派发真实 KeyboardEvent（验证 keydown→onData→write→shell 链路）
  const activeTerm = () => [...ctx.terms.current.values()].pop()
  w.__e2eType = (text: string) => {
    const t = activeTerm()
    if (!t?.textarea) return false
    for (const ch of text) {
      const keyCode = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0)
      t.textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: ch, keyCode, which: keyCode, bubbles: true, cancelable: true })
      )
    }
    return true
  }
  w.__e2eEnter = () => {
    const t = activeTerm()
    if (!t?.textarea) return false
    t.textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
    )
    return true
  }
  // 设置页开关（主进程 E2E 截图用）：点 × 关闭；打开走下拉菜单（点箭头/＋开菜单 → 点设置项）
  w.__e2eSettings = (open: boolean) => {
    if (!open) {
      const btn = document.querySelector<HTMLButtonElement>('.settings-close')
      btn?.click()
      return !!btn
    }
    const toggle = document.querySelector<HTMLButtonElement>('.newtab-caret') ??
      document.querySelector<HTMLButtonElement>('.newtab-split > .newtab')
    if (!toggle) return false
    toggle.click()
    // 等 React 把菜单渲染出来再点设置项
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        const item = document.querySelector<HTMLElement>('.menu-settings')
        item?.click()
        resolve(!!item)
      }, 100)
    })
  }

  // GUI 层输入兜底：xterm 官方 paste API（onData→IPC→后端→shell→输出→渲染 全链路）。
  // 括号粘贴模式下粘贴的换行不执行，粘贴后补一个真实回车。
  w.__e2ePaste = (text: string) => {
    const t = activeTerm()
    if (!t) return false
    t.paste(text)
    api.write(state.activeId, '\r')
    return true
  }

  // 主题切换（配合 __e2eSettings(true) 使用）：改真实设置页下拉并派发 change，
  // 走 onChange → applySettings → settings:set → nativeTheme 全链路
  w.__e2eTheme = (theme: string) => {
    const sel = document.querySelector<HTMLSelectElement>('.settings-panel .settings-select')
    if (!sel) return false
    sel.value = theme
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  // 标签右键菜单驱动（--e2e-tab-menu）：对第 tabIndex 个 .tab 派发真实 contextmenu，
  // 等 React 渲染出浮层后按 data-key 点菜单项，走 onContextMenu → ContextMenu action 全链路。
  // action 特例：'move' 点第一个「移入」项（组 id 动态，data-key 前缀匹配）；
  // 'group-head' 点第一个组头（折叠/展开）；'commit-name' 在组头输入框按 Enter 提交；
  // 'rename' 双击标签进内联编辑、以 React 受控方式填新名后 Enter 提交（会话改名态回归用）
  w.__e2eTabMenu = (tabIndex: number, action: string) => {
    if (action === 'group-head') {
      const head = document.querySelector<HTMLElement>('.tabgroup-head')
      head?.click()
      return !!head
    }
    if (action === 'commit-name') {
      const input = document.querySelector<HTMLInputElement>('.tabgroup-head input')
      if (!input) return false
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    }
    const tab = document.querySelectorAll<HTMLElement>('.tab')[tabIndex]
    if (!tab) return false
    if (action === 'rename') {
      tab.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          const input = tab.querySelector<HTMLInputElement>('input')
          if (!input) return resolve(false)
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, '已改名')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          resolve(true)
        }, 150)
      })
    }
    const r = tab.getBoundingClientRect()
    tab.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 30),
        clientY: Math.round(r.bottom + 4),
      })
    )
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        const item =
          action === 'move'
            ? document.querySelector<HTMLElement>('.ctx-item[data-key^="move-"]')
            : document.querySelector<HTMLElement>(`.ctx-item[data-key="${action}"]`)
        item?.click()
        resolve(!!item)
      }, 150)
    })
  }

  // ── 会话恢复回归（--e2e-session phase2）：恢复态快照，主进程轮询断言 ──
  w.__e2eSessionState = () => {
    const tabs = ctx.getTabs()
    const groups = ctx.getGroups()
    const renamed = new Set(ctx.getRenamed())
    return {
      count: tabs.length,
      pinned: tabs.filter((t) => t.pinned).length,
      renamed: tabs.filter((t) => renamed.has(t.id)).length,
      groups: groups.map((g) => ({
        name: g.name,
        color: g.color,
        collapsed: !!g.collapsed,
        members: tabs.filter((t) => t.groupId === g.id).length,
      })),
      titles: tabs.map((t) => t.title),
    }
  }

  // ── 组内广播回归（--e2e-input）：点击第一个组头的广播开关（真实 onClick 链路），
  // 返回点击后按钮是否点亮；getBroadcast 取实时广播组数 ──
  w.__e2eBroadcastToggle = () => {
    const btn = document.querySelector<HTMLButtonElement>('.tabgroup-head .g-broadcast')
    if (!btn) return { ok: false, on: false }
    btn.click()
    return new Promise<{ ok: boolean; on: boolean }>((resolve) => {
      setTimeout(() => resolve({ ok: true, on: btn.className.includes('on') }), 120)
    })
  }

  w.__e2eBroadcastState = () => ({
    groups: ctx.getBroadcast().length,
    // 活跃标签处于广播组时的常驻警示徽标（应为 true）
    badge: !!document.querySelector('.broadcast-badge')
  })

  // ── 分组侧栏回归（--e2e-sidebar）：全部走真实 DOM 事件驱动 ──

  /** 开关侧栏（点击标签栏左缘按钮 / 侧栏头部收起按钮），返回两侧栏可见性 */
  w.__e2eSidebarToggle = (on: boolean) => {
    const btn = on
      ? document.querySelector<HTMLButtonElement>('.tabbar .side-toggle')
      : document.querySelector<HTMLButtonElement>('.sidebar .side-close')
    if (!btn) return { sidebar: !!document.querySelector('.sidebar'), tabbar: !!document.querySelector('.tabbar') }
    btn.click()
    return new Promise<{ sidebar: boolean; tabbar: boolean }>((resolve) => {
      setTimeout(() => {
        resolve({
          sidebar: !!document.querySelector('.sidebar'),
          tabbar: !!document.querySelector('.tabbar'),
        })
      }, 150)
    })
  }

  /** 侧栏树结构快照（DOM 顺序 = 标签数组顺序）：根级行 + 组节点（含折叠态/成员行）；
      termCols = 各终端当前列数（开关侧栏断言 resize 生效用） */
  w.__e2eSidebarState = () => ({
    setting: ctx.getSidebarVisible(),
    sidebar: !!document.querySelector('.sidebar'),
    tabbar: !!document.querySelector('.tabbar'),
    termCols: [...ctx.terms.current.values()].map((t) => t.cols),
    rows: [...document.querySelectorAll<HTMLElement>('.sidebar .side-tree > *')].map((el) =>
      el.classList.contains('side-group')
        ? {
            kind: 'group' as const,
            name: el.querySelector('.g-name')?.textContent ?? '',
            count: Number(el.querySelector('.g-count')?.textContent ?? 0),
            collapsed: el.classList.contains('collapsed'),
            members: [...el.querySelectorAll<HTMLElement>('.side-tab')].map((m) => ({
              title: m.querySelector('.title')?.textContent ?? '',
              active: m.classList.contains('active'),
            })),
          }
        : {
            kind: 'tab' as const,
            title: el.querySelector('.title')?.textContent ?? '',
            active: el.classList.contains('active'),
          }
    ),
  })

  /** 侧栏标签行驱动（index = 全侧栏 .side-tab 的 DOM 序）：与 __e2eTabMenu 同构，
      'rename' 双击进编辑后填新名提交，其余 = 右键菜单 data-key（'move' 前缀匹配首个移入项） */
  w.__e2eSidebarTab = (index: number, action: string) => {
    const row = document.querySelectorAll<HTMLElement>('.sidebar .side-tab')[index]
    if (!row) return Promise.resolve(false)
    if (action === 'rename') {
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          const input = row.querySelector<HTMLInputElement>('input')
          if (!input) return resolve(false)
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, '侧栏改名')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          resolve(true)
        }, 150)
      })
    }
    if (action === 'click') {
      row.click()
      return Promise.resolve(true)
    }
    const r = row.getBoundingClientRect()
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + 30),
        clientY: Math.round(r.bottom + 4),
      })
    )
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        const item =
          action === 'move'
            ? document.querySelector<HTMLElement>('.ctx-item[data-key^="move-"]')
            : document.querySelector<HTMLElement>(`.ctx-item[data-key="${action}"]`)
        item?.click()
        resolve(!!item)
      }, 150)
    })
  }

  /** 侧栏组节点驱动：'toggle' 单击折叠/展开；'broadcast' 点组头广播开关；
      'commit-name' 在组名输入框按 Enter；'menu-<data-key>' 右键后点菜单项 */
  w.__e2eSidebarGroup = (action: string) => {
    const head = document.querySelector<HTMLElement>('.sidebar .side-group-head')
    if (!head) return Promise.resolve(false)
    if (action === 'toggle' || action === 'broadcast') {
      const btn =
        action === 'broadcast'
          ? head.querySelector<HTMLButtonElement>('.g-broadcast')
          : null
      if (action === 'broadcast' && !btn) return Promise.resolve(false)
      ;(btn ?? head).click()
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 120))
    }
    if (action === 'commit-name') {
      const input = head.querySelector<HTMLInputElement>('input')
      if (!input) return Promise.resolve(false)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return Promise.resolve(true)
    }
    if (action.startsWith('menu-')) {
      const r = head.getBoundingClientRect()
      head.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left + 30),
          clientY: Math.round(r.bottom + 4),
        })
      )
      const key = action.slice(5)
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          const item = document.querySelector<HTMLElement>(`.ctx-item[data-key="${key}"]`)
          item?.click()
          resolve(!!item)
        }, 150)
      })
    }
    return Promise.resolve(false)
  }

  /** 合成 HTML5 拖拽（组件用 ref 存源、不读 dataTransfer，DragEvent 可直接派发）：
      fromIdx = .side-tab DOM 序；target = 'group'（第 gIdx 个组头，入组）或
      'tab'（第 tIdx 个标签行，重排/出组） */
  w.__e2eSidebarDrag = (fromIdx: number, target: 'tab' | 'group', targetIdx: number) => {
    const rows = document.querySelectorAll<HTMLElement>('.sidebar .side-tab')
    const src = rows[fromIdx]
    if (!src) return false
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))
    const el =
      target === 'group'
        ? document.querySelectorAll<HTMLElement>('.sidebar .side-group-head')[targetIdx]
        : rows[targetIdx]
    if (!el) return false
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }))
    return true
  }


  // ── 真实输入回归探针（--e2e-input，主进程用 sendInputEvent 派可信事件驱动）──

  const termsInOrder = () => [...ctx.terms.current.values()]

  /** 焦点归属快照：focused/visible 为 term-pane 下标（DOM 顺序=创建顺序） */
  w.__e2eInputState = () => {
    const ae = document.activeElement as HTMLElement | null
    const panes = [...document.querySelectorAll<HTMLElement>('.term-pane')]
    const pane = ae?.closest<HTMLElement>('.term-pane')
    return {
      panes: panes.length,
      focused: pane ? panes.indexOf(pane) : -1,
      visible: panes.findIndex((p) => p.style.display !== 'none'),
      ae: String(ae?.className ?? ae?.tagName ?? 'null'),
    }
  }

  /** 全部终端 id（创建顺序，即 terms Map 的 key） */
  w.__e2eIds = () => [...ctx.terms.current.keys()]

  /** 第 idx 个终端的 buffer（含 scrollback）里是否出现 sub */
  w.__e2ePaneHas = (idx: number, sub: string) => {
    const t = termsInOrder()[idx]
    if (!t) return false
    const b = t.buffer.active
    for (let i = 0; i < b.length; i++) {
      if ((b.getLine(i)?.translateToString(true) ?? '').includes(sub)) return true
    }
    return false
  }

  /** 含 U+FFFD 的终端及行内容（应为空：多字节字符跨 %output chunk 解码损坏的标志） */
  w.__e2eUtf8Bad = () => {
    const bad: Array<{ pane: number; line: string }> = []
    let i = 0
    for (const t of ctx.terms.current.values()) {
      const b = t.buffer.active
      for (let r = 0; r < b.length; r++) {
        const s = b.getLine(r)?.translateToString(true) ?? ''
        if (s.includes('\uFFFD')) {
          bad.push({ pane: i, line: s.slice(0, 60) })
          break
        }
      }
      i++
    }
    return bad
  }
}

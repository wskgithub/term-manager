import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  api,
  DEFAULT_SETTINGS,
  nextGroupColor,
  nextGroupName,
  type AppSettings,
  type Profile,
  type TabGroup,
  type TermInfo,
} from './api'
import { TabBar } from './TabBar'
import { TermView } from './TermView'
import { SettingsPage } from './SettingsPage'
import { ContextMenu, CopyIcon, PasteIcon } from './ContextMenu'
import { resolveDark, subscribeScheme, xtermTheme, rememberTheme } from './theme'
import { setupE2E } from './e2e'

// 摘出标签并给出插回锚点：原本在组内则锚在原组块末尾之后（原地改组会把同组切成
// 前后两段，破坏「同组连续」不变量），未分组则锚在原位置
function takeTabOut(ts: TermInfo[], id: string): { list: TermInfo[]; tab: TermInfo; insertAt: number } {
  const idx = ts.findIndex((t) => t.id === id)
  const tab = ts[idx]
  const list = ts.filter((_, i) => i !== idx)
  let insertAt = idx
  if (tab.groupId) {
    let last = -1
    for (let i = 0; i < list.length; i++) if (list[i].groupId === tab.groupId) last = i
    if (last >= 0) insertAt = last + 1
  }
  return { list, tab, insertAt }
}

export default function App() {
  const [tabs, setTabs] = useState<TermInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  const [exited, setExited] = useState<Set<string>>(() => new Set())
  // 标签分组：UI 态由渲染层维护，经 session:sync 上报主进程随会话持久化（跨重启恢复）
  const [groups, setGroups] = useState<TabGroup[]>([])
  // 广播中的组 id：纯运行时态，刻意不进 session:sync——重启/重开应用后广播一律
  // 复位为关，避免用户忘记广播仍开着而把密码敲进多台机器
  const [broadcastGroups, setBroadcastGroups] = useState<Set<string>>(() => new Set())
  const broadcastRef = useRef(new Set<string>())
  broadcastRef.current = broadcastGroups
  // 终端右键菜单：坐标 + 打开瞬间的可复制状态（随打开冻结，避免后续选择变化影响已开菜单）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; canCopy: boolean } | null>(null)
  // 新建终端失败提示（tmux 死了/profile 失效等），下次成功即清除
  const [createError, setCreateError] = useState('')
  // 用户手动重命名后，shell 上报的标题不再覆盖
  const renamed = useRef(new Set<string>())
  // 单点分发：所有终端实例注册在这里，一个 onData 订阅服务全部标签
  const terms = useRef(new Map<string, Terminal>())
  const tabsRef = useRef<TermInfo[]>([])
  const activeRef = useRef('')
  tabsRef.current = tabs
  activeRef.current = activeId
  const groupsRef = useRef<TabGroup[]>([])
  groupsRef.current = groups
  const profilesRef = useRef<Profile[]>([])
  profilesRef.current = profiles
  // newTab 会被挂载时的闭包（快捷键/onOpenDir）长期持有，设置走 ref 避免拿到过期值
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // 主题三态 → 实际深浅：显式深/浅是常量；system 跟随 prefers-color-scheme
  // （主进程 themeSource 驱动，含运行中的系统深浅切换），订阅同一通路即可全覆盖
  const theme = settings.theme
  const dark = useSyncExternalStore(subscribeScheme, () => resolveDark(theme))
  // 深浅落到 <html data-theme>（CSS 变量组挂这里），并记 localStorage 供下次启动预应用
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    rememberTheme(theme)
  }, [dark, theme])
  // xterm 画布不走 CSS：所有已开终端随深浅整体换调色板
  useEffect(() => {
    for (const t of terms.current.values()) t.options.theme = xtermTheme(dark)
  }, [dark])

  // 总开关关闭时广播态全部撤下（设置页即时生效）：组头开关随 UI 消失，
  // 残留的广播组会让输入悄悄复制，必须显式清空
  useEffect(() => {
    if (!settings.groupBroadcast) setBroadcastGroups(new Set())
  }, [settings.groupBroadcast])

  // 激活标签变化后把焦点交给它：真实点击标签（mousedown 已 preventDefault 保住
  // 原焦点，但目标终端此刻还 display:none、focus() 无效）与 Ctrl+Tab 切换
  // （旧终端被藏起，焦点不能留在不可见的 textarea 里）之后，键盘输入都应落在新终端
  useEffect(() => {
    if (activeId) terms.current.get(activeId)?.focus()
  }, [activeId])

  // 会话持久化上报：标签顺序/固定/分组/活跃/改名态变化后 debounce 全量推送主进程
  //（数据量极小，全量快照比增量补丁简单可靠），主进程与窗口映射对账后落盘
  useEffect(() => {
    if (!tabs.length) return
    const timer = setTimeout(() => {
      api.syncSession({
        tabs: tabs.map((t) => ({
          id: t.id,
          profileId: t.profileId,
          title: t.title,
          color: t.color,
          pinned: t.pinned,
          groupId: t.groupId,
          renamed: renamed.current.has(t.id)
        })),
        groups: groups.map((g) => ({ ...g })),
        activeId
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [tabs, groups, activeId])

  useEffect(() => {
    let alive = true
    // 先订阅外部目录请求（Nautilus 右键 / CLI），再做 ready 握手取走排队项
    const offOpenDir = api.onOpenDir((dir) => {
      if (alive) void newTab(undefined, dir)
    })
    void api.listProfiles().then((ps) => {
      if (!alive) return
      // 同步刷 ref：下面 drain 时 newTab 需要据此选默认 profile
      profilesRef.current = ps
      setProfiles(ps)
      void api.cliReady().then(async (dirs) => {
        if (!alive) return
        for (const d of dirs) void newTab(undefined, d)
        if (dirs.length || tabsRef.current.length) return
        // 会话恢复：上次退出保留的 tmux 会话已由主进程附着，这里取回标签
        // （含固定/分组/活跃/改名态）；恢复成功则不再裸启动开默认终端
        const restored = await api.restoreSession()
        if (!alive) return
        if (restored && restored.tabs.length > 0) {
          restored.renamed.forEach((id) => renamed.current.add(id))
          setTabs(restored.tabs)
          setGroups(restored.groups)
          setActiveId(restored.activeId || restored.tabs[0]!.id)
          return
        }
        // 裸启动（应用菜单/命令行，无右键或 CLI 目录请求，无可恢复会话）开一个
        // 默认终端；cwd 不传，后端回退 ~（profile.cwd 优先）
        void api.getSettings().then((s) => {
          if (!alive) return
          // 同步刷 ref：newTab 要读到最新 defaultProfileId，不等 React 重渲染
          settingsRef.current = s
          setSettings(s)
          if (!tabsRef.current.length) void newTab()
        })
      })
    })
    api.getSettings().then((s) => {
      if (alive) setSettings(s)
    })
    const offData = api.onData((id, d) => terms.current.get(id)?.write(d))
    const offExit = api.onExit((id) => {
      terms.current.get(id)?.write('\r\n\x1b[90m[会话已退出]\x1b[0m\r\n')
      setExited((s) => {
        const next = new Set(s)
        next.add(id)
        return next
      })
    })
    return () => {
      alive = false
      offData()
      offExit()
      offOpenDir()
    }
  }, [])

  const newTab = async (profileId?: string, cwd?: string): Promise<TermInfo | undefined> => {
    const ps = profilesRef.current
    let pid = profileId
    if (!pid) {
      // 无显式 profile 的新建（+ 直建、Ctrl+Shift+T、Nautilus/CLI 打开目录）优先用默认终端；
      // 默认未设置、已删除或未安装时回退原有规则（首个可用 profile）
      const def = settingsRef.current.defaultProfileId
      pid =
        (def ? ps.find((p) => p.id === def && p.available !== false) : undefined)?.id ??
        (ps.find((p) => p.available !== false) ?? ps[0])?.id
    }
    if (!pid) return undefined
    let info: TermInfo
    try {
      info = await api.createTerm(pid, cwd)
    } catch (e) {
      // 后端不可用（tmux 缺失/服务器死了）不能只静默 reject：用户按了新建却毫无反馈
      console.error('[term] create failed:', e)
      setCreateError(e instanceof Error ? e.message : String(e))
      return undefined
    }
    setCreateError('')
    setTabs((ts) => [...ts, info])
    setActiveId(info.id)
    setSettingsOpen(false)
    return info
  }

  // Ctrl+Tab 循环切换。两条触发通路：焦点在终端内时 Tab 族被 xterm 键位表认领
  // （cancel = preventDefault + stopPropagation，window 层监听收不到），由
  // TermView 的 customKeyEventHandler 拦截后回调到这里；焦点在终端外
  // （菜单/设置页等）时走 App 的 window keydown 兜底
  const cycleTab = (dir: 1 | -1) => {
    const ts = tabsRef.current
    if (!ts.length) return
    const i = ts.findIndex((t) => t.id === activeRef.current)
    activateTab(ts[(i + dir + ts.length) % ts.length].id)
  }

  // 给 TabBar 的默认终端：设置了且本机可用才生效，否则视为未设置（+ 打开菜单）
  const defaultProfileId =
    settings.defaultProfileId &&
    profiles.some((p) => p.id === settings.defaultProfileId && p.available !== false)
      ? settings.defaultProfileId
      : ''

  // 乐观更新即时生效，回包以主进程 sanitize 结果为准
  const applySettings = (patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    void api.setSettings(patch).then(setSettings)
  }

  // 组内最后一个成员离开（关闭/移出/固定）时组自动消失
  const pruneGroups = (ts: TermInfo[]) => {
    setGroups((gs) => {
      const live = new Set(ts.map((t) => t.groupId).filter((g): g is string => !!g))
      const next = gs.filter((g) => live.has(g.id))
      return next.length === gs.length ? gs : next
    })
  }

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id)
    api.kill(id)
    const next = tabsRef.current.filter((t) => t.id !== id)
    setTabs(next)
    pruneGroups(next)
    setExited((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
    if (activeRef.current === id) {
      setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? '')
    }
  }

  const renameTab = (id: string, title: string) => {
    renamed.current.add(id)
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)))
  }

  // shell 通过 OSC 序列上报标题（如 ssh 到远端、进入目录时）
  const shellTitle = (id: string, title: string) => {
    if (renamed.current.has(id) || !title) return
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)))
  }

  const reorder = (from: number, to: number) => {
    setTabs((ts) => {
      const next = [...ts]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  // ── 固定/分组操作。不变量：固定标签是数组头部连续块、同组标签连续、固定标签永无 groupId ──

  // 固定：移到固定块尾并移出原组（固定与分组互斥）；取消固定：移到未固定区头部
  const togglePin = (id: string) => {
    const ts = tabsRef.current
    const t = ts.find((x) => x.id === id)
    if (!t) return
    const rest = ts.filter((x) => x.id !== id)
    // 锚点 = 其余标签里最后一个固定标签：固定插到它后面（固定块尾），取消固定也插到它后面（未固定区头）
    let anchor = -1
    for (let i = 0; i < rest.length; i++) if (rest[i].pinned) anchor = i
    const updated: TermInfo = t.pinned ? { ...t, pinned: false } : { ...t, pinned: true, groupId: undefined }
    const next = [...rest.slice(0, anchor + 1), updated, ...rest.slice(anchor + 1)]
    setTabs(next)
    pruneGroups(next)
  }

  // 归入新组：同步建组（默认名+轮选色）并返回组对象，供 TabBar 把组头置入重命名编辑态
  const addToNewGroup = (id: string): TabGroup => {
    const group: TabGroup = {
      id: crypto.randomUUID(),
      name: nextGroupName(groupsRef.current),
      color: nextGroupColor(groupsRef.current),
    }
    setGroups((gs) => [...gs, group])
    const { list, tab, insertAt } = takeTabOut(tabsRef.current, id)
    const next = [...list.slice(0, insertAt), { ...tab, groupId: group.id }, ...list.slice(insertAt)]
    setTabs(next)
    // 原组可能因此变空（换组场景）
    pruneGroups(next)
    return group
  }

  // 移入既有组：改组并挪到目标组块末尾
  const moveToGroup = (id: string, gid: string) => {
    const { list, tab } = takeTabOut(tabsRef.current, id)
    let at = list.length
    for (let i = 0; i < list.length; i++) if (list[i].groupId === gid) at = i + 1
    const next = [...list.slice(0, at), { ...tab, groupId: gid }, ...list.slice(at)]
    setTabs(next)
    pruneGroups(next)
  }

  // 移出组：挪到原组块右侧（原地清组会切断组）
  const removeFromGroup = (id: string) => {
    const { list, tab, insertAt } = takeTabOut(tabsRef.current, id)
    const next = [...list.slice(0, insertAt), { ...tab, groupId: undefined }, ...list.slice(insertAt)]
    setTabs(next)
    pruneGroups(next)
  }

  // 解散组：成员就地变回未分组（连续块整体清组不会切断任何东西，无需挪位）
  const dissolveGroup = (gid: string) => {
    setTabs(tabsRef.current.map((t) => (t.groupId === gid ? { ...t, groupId: undefined } : t)))
    setGroups((gs) => gs.filter((g) => g.id !== gid))
    setBroadcastGroups((bs) => {
      if (!bs.has(gid)) return bs
      const next = new Set(bs)
      next.delete(gid)
      return next
    })
  }

  // 组内广播开关（总开关 groupBroadcast 开启时组头/组菜单可见）
  const toggleGroupBroadcast = (gid: string) => {
    setBroadcastGroups((bs) => {
      const next = new Set(bs)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      return next
    })
  }

  // 键盘输入路由：普通标签直达自己的 pane；广播组内的标签则同段输入发往全组
  //（含自身）。粘贴走 xterm paste → onData，同样被广播——向多机贴同一段命令
  // 正是广播的用途，属用户显式动作
  const sendInput = (id: string, data: string) => {
    const ts = tabsRef.current
    const gid = ts.find((t) => t.id === id)?.groupId
    if (gid && settingsRef.current.groupBroadcast && broadcastRef.current.has(gid)) {
      for (const t of ts) if (t.groupId === gid) api.write(t.id, data)
    } else {
      api.write(id, data)
    }
  }

  const renameGroup = (gid: string, name: string) => {
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, name } : g)))
  }

  const setGroupColor = (gid: string, color: string) => {
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, color } : g)))
  }

  const toggleGroupCollapse = (gid: string) => {
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)))
  }

  // 激活标签：切入折叠组的成员时自动展开该组（点选与 Ctrl+Tab 共用）。
  // 焦点：切换场景（含真实点击标签——.tab 不可聚焦，点击会把焦点甩到 body）
  // 由 [activeId] effect 在渲染后聚焦新终端；点已激活的标签没有状态变化，
  // effect 不会重跑，这里同步聚焦（此刻终端可见，focus() 立即生效）
  const activateTab = (id: string) => {
    if (id === activeRef.current) terms.current.get(id)?.focus()
    setActiveId(id)
    setSettingsOpen(false)
    const gid = tabsRef.current.find((t) => t.id === id)?.groupId
    if (gid) {
      setGroups((gs) => gs.map((g) => (g.id === gid && g.collapsed ? { ...g, collapsed: false } : g)))
    }
  }

  const registerTerminal = (id: string, t: Terminal | null) => {
    if (t) {
      terms.current.set(id, t)
      // 会话恢复的标签：挂载即拉屏幕回放（capture-pane 快照 + 光标定位序列）。
      // 新建标签 replayTerm 返回空串，多一次往返无副作用
      void api
        .replayTerm(id)
        .then((text) => {
          if (text) t.write(text)
        })
        .catch((e) => console.error('[term] replay failed:', e))
    } else {
      terms.current.delete(id)
    }
  }

  // 右键菜单动作：目标始终是当前活跃终端（可见的那个 pane）。
  // 点击菜单项会把 DOM 焦点从 xterm 的 textarea 挪走（原生 Menu 无此问题），
  // 动作完成后必须把焦点还给终端，否则后续按键全部丢失
  const openTermContextMenu = (x: number, y: number) => {
    setCtxMenu({ x, y, canCopy: !!terms.current.get(activeRef.current)?.hasSelection() })
  }

  const focusActiveTerm = () => {
    terms.current.get(activeRef.current)?.focus()
  }

  const copySelection = () => {
    const t = terms.current.get(activeRef.current)
    if (t?.hasSelection()) api.writeClipboard(t.getSelection())
    focusActiveTerm()
  }

  const pasteClipboard = () => {
    focusActiveTerm()
    void api.readClipboard().then((text) => {
      if (text) terms.current.get(activeRef.current)?.paste(text)
    })
  }

  // 快捷键：Ctrl+Shift+T 新建 / Ctrl+Shift+W 关闭 / Ctrl+Tab、Ctrl+Shift+Tab 切换
  // / Ctrl+Shift+Q 退出并终结会话（终端聚焦时 Ctrl+Q 族被 xterm 认领，由
  // TermView 的 customKeyEventHandler 拦截后同样走 quitAll，这里是不在终端时的兜底）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && k === 't') {
        e.preventDefault()
        void newTab()
      } else if (e.ctrlKey && e.shiftKey && k === 'w') {
        e.preventDefault()
        // 固定标签防误关：快捷键不关（× 也不渲染），关闭走右键菜单的显式动作
        const cur = tabsRef.current.find((t) => t.id === activeRef.current)
        if (activeRef.current && !cur?.pinned) closeTab(activeRef.current)
      } else if (e.ctrlKey && e.shiftKey && k === 'q') {
        e.preventDefault()
        api.quitAll()
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
      } else if (e.ctrlKey && !e.shiftKey && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((open) => !open)
      } else if (e.key === 'Escape' && settingsOpenRef.current) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // E2E 驱动（仅当主进程调用 __e2eStart 时激活）；__E2E__ 在 dist 打包时被
  // define 成 false，rollup 把钩子从产物中摇掉（见 shared/globals.d.ts）
  useEffect(() => {
    if (__E2E__) {
      setupE2E({
        getProfiles: () => profilesRef.current,
        createTab: newTab,
        terms,
        getTabs: () => tabsRef.current,
        getGroups: () => groupsRef.current,
        getRenamed: () => [...renamed.current],
        getBroadcast: () => [...broadcastRef.current]
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 广播警示徽标：活跃标签处于广播中的组时，内容区右上角常驻提示——误向
  // 多台机器输入（密码/rm）代价极高，键盘落点必须时刻可见
  const activeGid = tabs.find((t) => t.id === activeId)?.groupId
  const broadcastTargets =
    activeGid && settings.groupBroadcast && broadcastGroups.has(activeGid)
      ? tabs.filter((t) => t.groupId === activeGid).length
      : 0

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        profiles={profiles}
        exited={exited}
        defaultProfileId={defaultProfileId}
        groups={groups}
        broadcastEnabled={settings.groupBroadcast}
        broadcastGroups={broadcastGroups}
        onSelect={activateTab}
        onClose={closeTab}
        onRename={renameTab}
        onRenameEnd={(id) => terms.current.get(id)?.focus()}
        onReorder={reorder}
        onNewTab={(pid) => void newTab(pid)}
        onOpenSettings={() => setSettingsOpen(true)}
        onTogglePin={togglePin}
        onGroupNew={addToNewGroup}
        onGroupMove={moveToGroup}
        onGroupLeave={removeFromGroup}
        onGroupRename={renameGroup}
        onGroupColor={setGroupColor}
        onGroupDissolve={dissolveGroup}
        onGroupBroadcast={toggleGroupBroadcast}
        onGroupToggle={toggleGroupCollapse}
        // 组头重命名提交/取消后归还焦点（同标签重命名：焦点丢失会漏按键进终端）
        onGroupRenameEnd={focusActiveTerm}
        // 标签/组右键菜单任意关闭（动作执行、点击外部、Escape）后把焦点还给活跃终端
        onMenuClose={focusActiveTerm}
      />
      <div className="content">
        {tabs.map((t) => (
          <TermView
            key={t.id}
            termId={t.id}
            active={t.id === activeId}
            fontFamily={settings.fontFamily}
            fontSize={settings.fontSize}
            dark={dark}
            onTitle={(title) => shellTitle(t.id, title)}
            onTerminal={registerTerminal}
            onContextMenu={openTermContextMenu}
            onInput={(d) => sendInput(t.id, d)}
            onCycleTab={cycleTab}
          />
        ))}
        {broadcastTargets > 1 && (
          <div className="broadcast-badge" title="关闭广播：组头广播开关或组右键菜单">
            ⩕ 广播输入中 · 本组 {broadcastTargets} 个终端同步接收
          </div>
        )}
        {createError && <div className="create-error">新建终端失败：{createError}</div>}
        {settingsOpen && (
          <SettingsPage
            settings={settings}
            profiles={profiles}
            onChange={applySettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              key: 'copy',
              label: '复制',
              shortcut: 'Ctrl+Shift+C',
              icon: CopyIcon,
              disabled: !ctxMenu.canCopy,
              action: copySelection
            },
            {
              key: 'paste',
              label: '粘贴',
              shortcut: 'Ctrl+Shift+V',
              icon: PasteIcon,
              action: pasteClipboard
            }
          ]}
        />
      )}
    </div>
  )
}

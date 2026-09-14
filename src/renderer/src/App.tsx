import { useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { api, type AppSettings, type Profile, type TermInfo } from './api'
import { TabBar } from './TabBar'
import { TermView } from './TermView'
import { SettingsPage } from './SettingsPage'
import { setupE2E } from './e2e'

// 与主进程 DEFAULT_SETTINGS 一致的初值，仅用于设置异步加载完成前，避免终端闪一下默认字体
const DEFAULT_SETTINGS: AppSettings = { fontFamily: '', fontSize: 14, defaultProfileId: '' }

export default function App() {
  const [tabs, setTabs] = useState<TermInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  const [exited, setExited] = useState<Set<string>>(() => new Set())
  // 用户手动重命名后，shell 上报的标题不再覆盖
  const renamed = useRef(new Set<string>())
  // 单点分发：所有终端实例注册在这里，一个 onData 订阅服务全部标签
  const terms = useRef(new Map<string, Terminal>())
  const tabsRef = useRef<TermInfo[]>([])
  const activeRef = useRef('')
  tabsRef.current = tabs
  activeRef.current = activeId
  const profilesRef = useRef<Profile[]>([])
  profilesRef.current = profiles
  // newTab 会被挂载时的闭包（快捷键/onOpenDir）长期持有，设置走 ref 避免拿到过期值
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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
      void api.cliReady().then((dirs) => {
        if (!alive) return
        for (const d of dirs) void newTab(undefined, d)
        // 裸启动（应用菜单/命令行，无右键或 CLI 目录请求）也开一个默认终端；
        // cwd 不传，后端回退 ~（profile.cwd 优先），有目录请求时不重复开
        if (!dirs.length && !tabsRef.current.length) {
          void api.getSettings().then((s) => {
            if (!alive) return
            // 同步刷 ref：newTab 要读到最新 defaultProfileId，不等 React 重渲染
            settingsRef.current = s
            setSettings(s)
            if (!tabsRef.current.length) void newTab()
          })
        }
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
    const info = await api.createTerm(pid, cwd)
    setTabs((ts) => [...ts, info])
    setActiveId(info.id)
    setSettingsOpen(false)
    return info
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

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id)
    api.kill(id)
    const next = tabsRef.current.filter((t) => t.id !== id)
    setTabs(next)
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

  const registerTerminal = (id: string, t: Terminal | null) => {
    if (t) terms.current.set(id, t)
    else terms.current.delete(id)
  }

  // 快捷键：Ctrl+Shift+T 新建 / Ctrl+Shift+W 关闭 / Ctrl+Tab、Ctrl+Shift+Tab 切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && k === 't') {
        e.preventDefault()
        void newTab()
      } else if (e.ctrlKey && e.shiftKey && k === 'w') {
        e.preventDefault()
        if (activeRef.current) closeTab(activeRef.current)
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const ts = tabsRef.current
        if (!ts.length) return
        const i = ts.findIndex((t) => t.id === activeRef.current)
        const next = e.shiftKey ? (i - 1 + ts.length) % ts.length : (i + 1) % ts.length
        setActiveId(ts[next].id)
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

  // E2E 驱动（仅当主进程调用 __e2eStart 时激活）
  useEffect(() => {
    setupE2E({ getProfiles: () => profilesRef.current, createTab: newTab, terms })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        profiles={profiles}
        exited={exited}
        defaultProfileId={defaultProfileId}
        onSelect={(id) => {
          setActiveId(id)
          setSettingsOpen(false)
        }}
        onClose={closeTab}
        onRename={renameTab}
        onReorder={reorder}
        onNewTab={(pid) => void newTab(pid)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="content">
        {tabs.map((t) => (
          <TermView
            key={t.id}
            termId={t.id}
            active={t.id === activeId}
            fontFamily={settings.fontFamily}
            fontSize={settings.fontSize}
            onTitle={(title) => shellTitle(t.id, title)}
            onTerminal={registerTerminal}
          />
        ))}
        {settingsOpen && (
          <SettingsPage
            settings={settings}
            profiles={profiles}
            onChange={applySettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

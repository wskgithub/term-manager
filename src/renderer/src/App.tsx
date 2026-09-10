import { useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { api, type Profile, type TermInfo } from './api'
import { TabBar } from './TabBar'
import { TermView } from './TermView'
import { setupE2E } from './e2e'

export default function App() {
  const [tabs, setTabs] = useState<TermInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
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

  useEffect(() => {
    api.listProfiles().then(setProfiles)
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
      offData()
      offExit()
    }
  }, [])

  const newTab = async (profileId?: string): Promise<TermInfo | undefined> => {
    const ps = profilesRef.current
    const pid = profileId ?? (ps.find((p) => p.available !== false) ?? ps[0])?.id
    if (!pid) return undefined
    const info = await api.createTerm(pid)
    setTabs((ts) => [...ts, info])
    setActiveId(info.id)
    return info
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
        onSelect={setActiveId}
        onClose={closeTab}
        onRename={renameTab}
        onReorder={reorder}
        onNewTab={(pid) => void newTab(pid)}
      />
      <div className="content">
        {tabs.map((t) => (
          <TermView
            key={t.id}
            termId={t.id}
            active={t.id === activeId}
            onTitle={(title) => shellTitle(t.id, title)}
            onTerminal={registerTerminal}
          />
        ))}
      </div>
    </div>
  )
}

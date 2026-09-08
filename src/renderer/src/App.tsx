import { useEffect, useRef, useState } from 'react'
import { api, type Profile, type TermInfo } from './api'
import { TabBar } from './TabBar'
import { TermView } from './TermView'

export default function App() {
  const [tabs, setTabs] = useState<TermInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
  // 用户手动重命名后，shell 上报的标题不再覆盖
  const renamed = useRef(new Set<string>())

  useEffect(() => {
    api.listProfiles().then(setProfiles)
  }, [])

  const newTab = async (profileId: string) => {
    const info = await api.createTerm(profileId)
    setTabs((ts) => [...ts, info])
    setActiveId(info.id)
  }

  const closeTab = (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id)
    api.kill(id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (activeId === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? '')
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

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        profiles={profiles}
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
          />
        ))}
      </div>
    </div>
  )
}

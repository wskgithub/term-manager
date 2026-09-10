import { useRef, useState } from 'react'
import type { Profile, TermInfo } from './api'

interface Props {
  tabs: TermInfo[]
  activeId: string
  profiles: Profile[]
  exited: Set<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  onReorder: (from: number, to: number) => void
  onNewTab: (profileId: string) => void
  onOpenSettings: () => void
}

export function TabBar(props: Props) {
  const { tabs, activeId, profiles, exited, onSelect, onClose, onRename, onReorder, onNewTab, onOpenSettings } = props
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const dragFromRef = useRef<number | null>(null)

  const commitRename = (id: string) => {
    const t = tabs.find((x) => x.id === id)
    onRename(id, draft.trim() || t?.title || '')
    setEditingId(null)
  }

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className={
              'tab' +
              (t.id === activeId ? ' active' : '') +
              (exited.has(t.id) ? ' exited' : '')
            }
            draggable={editingId !== t.id}
            onDragStart={() => (dragFromRef.current = i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFromRef.current !== null && dragFromRef.current !== i) {
                onReorder(dragFromRef.current, i)
              }
              dragFromRef.current = null
            }}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => {
              setEditingId(t.id)
              setDraft(t.title)
            }}
            title="双击重命名"
          >
            <span className="dot" style={{ background: t.color ?? '#888' }} />
            {editingId === t.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="title">{t.title}</span>
            )}
            <button
              className="close"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <button className="newtab" onClick={() => setMenuOpen(!menuOpen)} title="新建终端">
        +
      </button>
      {menuOpen && (
        <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
          {profiles.map((p) => (
            <div
              key={p.id}
              className={'menu-item' + (p.available === false ? ' disabled' : '')}
              title={p.available === false ? '本机未安装该 shell' : undefined}
              onClick={() => {
                if (p.available === false) return
                onNewTab(p.id)
                setMenuOpen(false)
              }}
            >
              <span className="dot" style={{ background: p.color ?? '#888' }} />
              {p.name}
            </div>
          ))}
          {profiles.length === 0 && <div className="menu-item muted">加载中…</div>}
        </div>
      )}

      <button className="newtab settings-btn" onClick={onOpenSettings} title="设置 (Ctrl+,)">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  )
}

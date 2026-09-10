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
}

export function TabBar(props: Props) {
  const { tabs, activeId, profiles, exited, onSelect, onClose, onRename, onReorder, onNewTab } = props
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
    </div>
  )
}

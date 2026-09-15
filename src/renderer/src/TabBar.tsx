import { useRef, useState } from 'react'
import type { Profile, TermInfo } from './api'

interface Props {
  tabs: TermInfo[]
  activeId: string
  profiles: Profile[]
  exited: Set<string>
  // 已校验可用的默认终端 profile id；空串 = 未设置（+ 即菜单开关）
  defaultProfileId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  // 提交/取消重命名后把焦点归还该终端：否则输入框卸载、焦点落 body，
  // 用户继续打字会静默漏进终端（ssh raw 模式下直达远端，无本地回显）
  onRenameEnd: (id: string) => void
  onReorder: (from: number, to: number) => void
  onNewTab: (profileId: string) => void
  onOpenSettings: () => void
}

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
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
  )
}

export function TabBar(props: Props) {
  const { tabs, activeId, profiles, exited, defaultProfileId, onSelect, onClose, onRename, onRenameEnd, onReorder, onNewTab, onOpenSettings } = props
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const dragFromRef = useRef<number | null>(null)
  const defaultProfile = defaultProfileId
    ? profiles.find((p) => p.id === defaultProfileId)
    : undefined

  const commitRename = (id: string) => {
    const t = tabs.find((x) => x.id === id)
    onRename(id, draft.trim() || t?.title || '')
    setEditingId(null)
    onRenameEnd(id)
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
                  if (e.key === 'Escape') {
                    setEditingId(null)
                    onRenameEnd(t.id)
                  }
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

      {/* 设置了默认终端时 + 为分体按钮：本体直接创建，箭头才开菜单；未设置时 + 仍是菜单开关 */}
      <div className="newtab-split">
        <button
          className="newtab"
          title={defaultProfile ? `新建 ${defaultProfile.name} 终端` : '新建终端'}
          onClick={() => {
            if (defaultProfile) {
              onNewTab(defaultProfile.id)
              setMenuOpen(false)
            } else {
              setMenuOpen(!menuOpen)
            }
          }}
        >
          +
        </button>
        {defaultProfile && (
          <button
            className="newtab-caret"
            title="选择其他 shell"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
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
                {p.id === defaultProfileId && <span className="menu-badge">默认</span>}
              </div>
            ))}
            {profiles.length === 0 && <div className="menu-item muted">加载中…</div>}
            <div className="menu-sep" />
            <div
              className="menu-item menu-settings"
              onClick={() => {
                setMenuOpen(false)
                onOpenSettings()
              }}
            >
              <span className="menu-icon">
                <GearIcon />
              </span>
              设置
              <span className="menu-kbd">Ctrl+,</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

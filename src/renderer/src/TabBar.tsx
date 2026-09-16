import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ContextMenu,
  FolderPlusIcon,
  PencilIcon,
  PinIcon,
  XIcon,
  type MenuEntry,
} from './ContextMenu'
import {
  GROUP_COLORS,
  GROUP_COLOR_NAMES,
  type Profile,
  type TabGroup,
  type TermInfo,
} from './api'

interface Props {
  tabs: TermInfo[]
  activeId: string
  profiles: Profile[]
  exited: Set<string>
  // 已校验可用的默认终端 profile id；空串 = 未设置（+ 即菜单开关）
  defaultProfileId: string
  groups: TabGroup[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  // 提交/取消重命名后把焦点归还该终端：否则输入框卸载、焦点落 body，
  // 用户继续打字会静默漏进终端（ssh raw 模式下直达远端，无本地回显）
  onRenameEnd: (id: string) => void
  onReorder: (from: number, to: number) => void
  onNewTab: (profileId: string) => void
  onOpenSettings: () => void
  // ── 固定/分组 ──
  onTogglePin: (id: string) => void
  // 归入新组，返回新组对象（组头随即进入重命名编辑态）
  onGroupNew: (id: string) => TabGroup
  onGroupMove: (id: string, groupId: string) => void
  onGroupLeave: (id: string) => void
  onGroupRename: (groupId: string, name: string) => void
  onGroupColor: (groupId: string, color: string) => void
  onGroupDissolve: (groupId: string) => void
  onGroupToggle: (groupId: string) => void
  // 组头重命名结束后归还焦点：组头不属于任何终端，统一还到当前活跃的那个
  onGroupRenameEnd: () => void
  // 标签/组右键菜单任意途径关闭后归还焦点到活跃终端（点击菜单项会把 DOM
  // 焦点挪到 body，不归还则后续按键静默丢失）
  onMenuClose: () => void
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

/** 分段渲染：tabs 数组顺序即标签栏顺序（固定区在头部、同组连续由 App 维护），
    连续的同组标签合并为一个组段（.tabgroup 包裹），其余为裸标签段 */
type Seg =
  | { kind: 'tab'; tab: TermInfo; index: number }
  | { kind: 'group'; group: TabGroup; tabs: { tab: TermInfo; index: number }[] }

export function TabBar(props: Props) {
  const {
    tabs,
    activeId,
    profiles,
    exited,
    defaultProfileId,
    groups,
    onSelect,
    onClose,
    onRename,
    onRenameEnd,
    onReorder,
    onNewTab,
    onOpenSettings,
    onTogglePin,
    onGroupNew,
    onGroupMove,
    onGroupLeave,
    onGroupRename,
    onGroupColor,
    onGroupDissolve,
    onGroupToggle,
    onGroupRenameEnd,
    onMenuClose,
  } = props
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  // ＋下拉菜单的键盘/失焦关闭：此前只有 mouseLeave 一条关闭路径，
  // 键盘用户按 Esc 或切走窗口后菜单会悬着不关
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    const onBlur = () => setMenuOpen(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [menuOpen])
  // 组头重命名（与标签重命名同一套内联编辑模式）
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  // 标签/组右键菜单（portal 浮层，坐标 + 目标 id）
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; groupId: string } | null>(null)
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

  const commitGroupRename = (gid: string) => {
    const g = groups.find((x) => x.id === gid)
    onGroupRename(gid, groupDraft.trim() || g?.name || '')
    setEditingGroupId(null)
    onGroupRenameEnd()
  }

  const segs: Seg[] = []
  tabs.forEach((tab, index) => {
    const g = tab.groupId ? groups.find((x) => x.id === tab.groupId) : undefined
    if (g) {
      const last = segs[segs.length - 1]
      if (last && last.kind === 'group' && last.group.id === g.id) last.tabs.push({ tab, index })
      else segs.push({ kind: 'group', group: g, tabs: [{ tab, index }] })
    } else {
      segs.push({ kind: 'tab', tab, index })
    }
  })

  const renderTab = (t: TermInfo, i: number) => (
    <div
      key={t.id}
      className={
        'tab' +
        (t.pinned ? ' pinned' : '') +
        (t.id === activeId ? ' active' : '') +
        (exited.has(t.id) ? ' exited' : '')
      }
      draggable={editingId !== t.id}
      onDragStart={() => (dragFromRef.current = i)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        const from = dragFromRef.current
        dragFromRef.current = null
        if (from === null || from === i) return
        // 拖拽约束：仅同区（固定态相同）且同组内可重排；跨区/跨组静默忽略，归并只走菜单
        const a = tabs[from]
        const b = tabs[i]
        if (a?.pinned === b?.pinned && a?.groupId === b?.groupId) onReorder(from, i)
      }}
      onClick={() => onSelect(t.id)}
      onDoubleClick={() => {
        setEditingId(t.id)
        setDraft(t.title)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setTabMenu({ x: e.clientX, y: e.clientY, tabId: t.id })
      }}
      title={`${t.title}（双击重命名）`}
    >
      {t.pinned ? (
        <span className="pin-mark">{PinIcon}</span>
      ) : (
        <span className="dot" style={{ background: t.color ?? '#888' }} />
      )}
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
      {/* 固定标签不渲染关闭钮（防误关），关闭走右键菜单的显式动作。
          mousedown 阻止默认（按钮夺焦）：点击后焦点保持在终端，不必再点回终端 */}
      {!t.pinned && (
        <button
          className="close"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onClose(t.id)
          }}
        >
          ×
        </button>
      )}
    </div>
  )

  const tabMenuTab = tabMenu ? tabs.find((t) => t.id === tabMenu.tabId) : undefined
  const tabMenuItems = (t: TermInfo): MenuEntry[] => {
    const others = groups.filter((g) => g.id !== t.groupId)
    return [
      {
        key: 'pin',
        label: t.pinned ? '取消固定标签页' : '固定标签页',
        icon: PinIcon,
        action: () => onTogglePin(t.id),
      },
      { key: 'sep-pin', sep: true },
      {
        key: 'new-group',
        label: '将标签页添加到新组',
        icon: FolderPlusIcon,
        // 固定与分组互斥：固定标签上置灰，取消固定后可用
        disabled: !!t.pinned,
        action: () => {
          const g = onGroupNew(t.id)
          setEditingGroupId(g.id)
          setGroupDraft(g.name)
        },
      },
      ...others.map<MenuEntry>((g) => ({
        key: `move-${g.id}`,
        label: `移入「${g.name}」`,
        icon: <span className="dot" style={{ background: g.color }} />,
        disabled: !!t.pinned,
        action: () => onGroupMove(t.id, g.id),
      })),
      ...(t.groupId
        ? [
            {
              key: 'leave-group',
              label: '从组中移除',
              icon: XIcon,
              action: () => onGroupLeave(t.id),
            } as MenuEntry,
          ]
        : []),
      { key: 'sep-close', sep: true },
      { key: 'close', label: '关闭标签页', action: () => onClose(t.id) },
    ]
  }

  const groupMenuGroup = groupMenu ? groups.find((g) => g.id === groupMenu.groupId) : undefined
  const groupMenuItems = (g: TabGroup): MenuEntry[] => [
    {
      key: 'rename',
      label: '重命名组',
      icon: PencilIcon,
      action: () => {
        setEditingGroupId(g.id)
        setGroupDraft(g.name)
      },
    },
    { key: 'sep-rename', sep: true },
    ...GROUP_COLORS.map<MenuEntry>((c, i) => ({
      key: `color-${i}`,
      label: GROUP_COLOR_NAMES[i],
      icon: <span className="dot" style={{ background: c }} />,
      shortcut: c === g.color ? '✓' : undefined,
      action: () => onGroupColor(g.id, c),
    })),
    { key: 'sep-dissolve', sep: true },
    { key: 'dissolve', label: '解散组', icon: XIcon, action: () => onGroupDissolve(g.id) },
  ]

  return (
    <div className="tabbar">
      <div className="tabs">
        {segs.map((seg) =>
          seg.kind === 'tab' ? (
            renderTab(seg.tab, seg.index)
          ) : (
            <div
              key={seg.group.id}
              className={'tabgroup' + (seg.group.collapsed ? ' collapsed' : '')}
              style={{ '--g-color': seg.group.color } as CSSProperties}
            >
              {/* 组头：单击折叠/展开（点击即意图明确，重命名走右键，避免双击先触两次折叠）。
                  mousedown 阻止默认（夺焦）：折叠后键盘输入应继续落在终端 */}
              <div
                className="tabgroup-head"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onGroupToggle(seg.group.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setGroupMenu({ x: e.clientX, y: e.clientY, groupId: seg.group.id })
                }}
                title="单击折叠/展开，右键重命名/换色/解散"
              >
                <span className="dot" />
                {editingGroupId === seg.group.id ? (
                  <input
                    autoFocus
                    value={groupDraft}
                    onChange={(e) => setGroupDraft(e.target.value)}
                    onBlur={() => commitGroupRename(seg.group.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') {
                        setEditingGroupId(null)
                        onGroupRenameEnd()
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="g-name">{seg.group.name}</span>
                )}
                <svg
                  className="g-chev"
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
              </div>
              {!seg.group.collapsed && seg.tabs.map(({ tab, index }) => renderTab(tab, index))}
            </div>
          )
        )}
      </div>

      {/* 设置了默认终端时 + 为分体按钮：本体直接创建，箭头才开菜单；未设置时 + 仍是菜单开关 */}
      <div className="newtab-split">
        <button
          className="newtab"
          onMouseDown={(e) => e.preventDefault()}
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
            onMouseDown={(e) => e.preventDefault()}
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
                onMouseDown={(e) => e.preventDefault()}
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
              onMouseDown={(e) => e.preventDefault()}
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

      {tabMenu && tabMenuTab && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabMenuTab)}
          onClose={() => {
            setTabMenu(null)
            onMenuClose()
          }}
        />
      )}
      {groupMenu && groupMenuGroup && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          items={groupMenuItems(groupMenuGroup)}
          onClose={() => {
            setGroupMenu(null)
            onMenuClose()
          }}
        />
      )}
    </div>
  )
}

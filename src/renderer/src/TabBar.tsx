import { useRef, useState, type CSSProperties } from 'react'
import { BroadcastIcon, ChevronIcon, ContextMenu, PinIcon, SidebarIcon } from './ContextMenu'
import { NewTabMenu } from './NewTabMenu'
import { buildGroupMenuItems, buildTabMenuItems } from './menus'
import { buildSegs } from './segs'
import { type Profile, type TabGroup, type TermInfo } from './api'

interface Props {
  tabs: TermInfo[]
  activeId: string
  profiles: Profile[]
  exited: Set<string>
  // 已校验可用的默认终端 profile id；空串 = 未设置（+ 即菜单开关）
  defaultProfileId: string
  groups: TabGroup[]
  // 组内广播输入（设置总开关开启时才有 UI）：广播中的组 id 集合与切换回调
  broadcastEnabled: boolean
  broadcastGroups: Set<string>
  onGroupBroadcast: (groupId: string) => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  // 提交/取消重命名后把焦点归还该终端：否则输入框卸载、焦点落 body，
  // 用户继续打字会静默漏进终端（ssh raw 模式下直达远端，无本地回显）
  onRenameEnd: (id: string) => void
  onReorder: (from: number, to: number) => void
  onNewTab: (profileId: string) => void
  onOpenSettings: () => void
  // ＋菜单打开时重拉 profile 列表（透传给 NewTabMenu）
  onRefreshProfiles: () => void
  // 打开分组侧栏（侧栏开启时隐藏标签栏，按钮承担切回入口）
  onToggleSidebar: () => void
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

export function TabBar(props: Props) {
  const {
    tabs,
    activeId,
    profiles,
    exited,
    defaultProfileId,
    groups,
    broadcastEnabled,
    broadcastGroups,
    onGroupBroadcast,
    onSelect,
    onClose,
    onRename,
    onRenameEnd,
    onReorder,
    onNewTab,
    onOpenSettings,
    onRefreshProfiles,
    onToggleSidebar,
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
  // 组头重命名（与标签重命名同一套内联编辑模式）
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  // 标签/组右键菜单（portal 浮层，坐标 + 目标 id）
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; groupId: string } | null>(null)
  const dragFromRef = useRef<number | null>(null)

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

  const segs = buildSegs(tabs, groups)

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
            // Enter 直接提交，不经 blur→onBlur 链：提交语义不应依赖 input
            // 持有焦点——焦点被外部夺走时 blur() 不派发事件，编辑态会残留
            if (e.key === 'Enter') commitRename(t.id)
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
  const tabMenuHandlers = {
    onTogglePin,
    onMenuNewGroup: (id: string) => {
      const g = onGroupNew(id)
      setEditingGroupId(g.id)
      setGroupDraft(g.name)
    },
    onGroupMove,
    onGroupLeave,
    onClose,
  }

  const groupMenuGroup = groupMenu ? groups.find((g) => g.id === groupMenu.groupId) : undefined
  const groupMenuHandlers = {
    onMenuRename: (g: TabGroup) => {
      setEditingGroupId(g.id)
      setGroupDraft(g.name)
    },
    broadcastEnabled,
    broadcastGroups,
    onGroupBroadcast,
    onGroupColor,
    onGroupDissolve,
  }

  return (
    <div className="tabbar">
      {/* 分组侧栏入口：侧栏开启时标签栏整体隐藏，此按钮承担切回。
          mousedown 阻止默认（夺焦）：点击后焦点保持在终端 */}
      <button
        className="side-toggle"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleSidebar}
        title="显示分组侧栏 (Ctrl+Shift+B)"
      >
        <SidebarIcon />
      </button>
      <div className="tabs">
        {segs.map((seg) =>
          seg.kind === 'tab' ? (
            renderTab(seg.tab, seg.index)
          ) : (
            <div
              key={seg.group.id}
              className={
                'tabgroup' +
                (seg.group.collapsed ? ' collapsed' : '') +
                (broadcastEnabled && broadcastGroups.has(seg.group.id) ? ' broadcasting' : '')
              }
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
                      // 与标签改名同理：Enter 直接提交，不依赖 input 持焦
                      if (e.key === 'Enter') commitGroupRename(seg.group.id)
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
                {/* 广播开关（设置总开关开启时渲染）：输入复制到全组属高危操作，
                    常驻可见 + 开启态高亮，杜绝"忘了广播还开着"。stopPropagation
                    阻断组头的折叠单击；mousedown preventDefault 同组头，点击后
                    焦点保持在终端 */}
                {broadcastEnabled && (
                  <button
                    className={'g-broadcast' + (broadcastGroups.has(seg.group.id) ? ' on' : '')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onGroupBroadcast(seg.group.id)
                    }}
                    title={
                      broadcastGroups.has(seg.group.id)
                        ? '广播输入中：键盘输入发往本组全部终端，点击停止'
                        : '广播输入：本组全部终端同步接收键盘输入'
                    }
                  >
                    {BroadcastIcon}
                  </button>
                )}
                <ChevronIcon className="g-chev" />
              </div>
              {!seg.group.collapsed && seg.tabs.map(({ tab, index }) => renderTab(tab, index))}
            </div>
          )
        )}
      </div>

      <NewTabMenu
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        onNewTab={onNewTab}
        onOpenSettings={onOpenSettings}
        onOpenMenu={onRefreshProfiles}
      />

      {tabMenu && tabMenuTab && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={buildTabMenuItems(tabMenuTab, groups, tabMenuHandlers)}
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
          items={buildGroupMenuItems(groupMenuGroup, groupMenuHandlers)}
          onClose={() => {
            setGroupMenu(null)
            onMenuClose()
          }}
        />
      )}
    </div>
  )
}

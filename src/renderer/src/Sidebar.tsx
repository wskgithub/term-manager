import { useRef, useState, type CSSProperties } from 'react'
import { BroadcastIcon, ChevronIcon, ContextMenu, GearIcon, PinIcon, SidebarIcon } from './ContextMenu'
import { NewTabMenu } from './NewTabMenu'
import { buildGroupMenuItems, buildTabMenuItems } from './menus'
import { buildSegs } from './segs'
import { type Profile, type TabGroup, type TermInfo } from './api'

/** 侧栏树拖拽的落点意图：拖到组头 = 入组；拖到标签行 = 同父重排 / 出组。
    具体执行在 App（sidebarDrop），「固定块头部/同组连续/固定无组」不变量单点维护 */
export type SideDropTarget =
  | { kind: 'tab'; id: string }
  | { kind: 'group'; groupId: string }

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
  // 提交/取消重命名后把焦点归还该终端（焦点落 body 会静默漏进终端）
  onRenameEnd: (id: string) => void
  onNewTab: (profileId: string) => void
  onOpenSettings: () => void
  // ＋菜单打开时重拉 profile 列表（透传给 NewTabMenu）
  onRefreshProfiles: () => void
  onToggleSidebar: () => void
  onDrop: (fromId: string, target: SideDropTarget) => void
  // ── 固定/分组（与 TabBar 同一套 App 回调）──
  onTogglePin: (id: string) => void
  // 归入新组，返回新组对象（组节点随即进入重命名编辑态）
  onGroupNew: (id: string) => TabGroup
  onGroupMove: (id: string, groupId: string) => void
  onGroupLeave: (id: string) => void
  onGroupRename: (groupId: string, name: string) => void
  onGroupColor: (groupId: string, color: string) => void
  onGroupDissolve: (groupId: string) => void
  onGroupToggle: (groupId: string) => void
  // 组节点重命名结束后归还焦点：统一还到当前活跃终端
  onGroupRenameEnd: () => void
  // 标签/组右键菜单任意途径关闭后归还焦点到活跃终端
  onMenuClose: () => void
}

/** 分组侧栏树视图（设置开启后取代顶部标签栏）：固定标签在顶部，组为可折叠
    树节点（成员缩进），未分组标签散布在根级；点击切换、双击改名、右键菜单
    与标签栏完全同源（menus.tsx 共用构建器），另支持树内拖拽整理 */
export function Sidebar(props: Props) {
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
    onNewTab,
    onOpenSettings,
    onRefreshProfiles,
    onToggleSidebar,
    onDrop,
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
  // 与 TabBar 同一套内联编辑模式（标签/组各一份 editing + draft）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  // 标签/组右键菜单（portal 浮层，坐标 + 目标 id）
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; groupId: string } | null>(null)
  // 拖拽源标签 id；取消拖拽（drop 落在无效区）由 dragEnd 兜底清空
  const dragFromRef = useRef<string | null>(null)
  // 拖拽悬停高亮直接操作 DOM class：拖拽期间无重渲染，避免高频 setState
  const dragOver = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault()
    e.currentTarget.classList.add('drop-on')
  }
  const dragLeave = (e: React.DragEvent<HTMLElement>) => e.currentTarget.classList.remove('drop-on')
  // 清高亮 + 取走拖拽源 id（无源 = 非法落点，调用方静默忽略）
  const takeDrop = (e: React.DragEvent<HTMLElement>): string | null => {
    e.currentTarget.classList.remove('drop-on')
    const from = dragFromRef.current
    dragFromRef.current = null
    return from
  }

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

  const renderTab = (t: TermInfo, inGroup: boolean) => (
    <div
      key={t.id}
      className={
        'side-tab' +
        (inGroup ? ' in-group' : '') +
        (t.pinned ? ' pinned' : '') +
        (t.id === activeId ? ' active' : '') +
        (exited.has(t.id) ? ' exited' : '')
      }
      draggable={editingId !== t.id}
      onDragStart={() => (dragFromRef.current = t.id)}
      onDragEnd={() => (dragFromRef.current = null)}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={(e) => {
        const from = takeDrop(e)
        if (from && from !== t.id) onDrop(from, { kind: 'tab', id: t.id })
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
          mousedown 阻止默认（按钮夺焦）：点击后焦点保持在终端 */}
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
    <div className="sidebar">
      {/* 头部：＋新建（含 profile 菜单）/ 设置 / 收起侧栏。
          按钮 mousedown 阻止默认（夺焦）：点击后焦点保持在终端 */}
      <div className="side-head">
        <NewTabMenu
          profiles={profiles}
          defaultProfileId={defaultProfileId}
          onNewTab={onNewTab}
          onOpenSettings={onOpenSettings}
          onOpenMenu={onRefreshProfiles}
        />
        <button
          className="side-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenSettings}
          title="设置 (Ctrl+,)"
        >
          <GearIcon />
        </button>
        <button
          className="side-btn side-close"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleSidebar}
          title="收起侧栏，恢复标签栏 (Ctrl+Shift+B)"
        >
          <SidebarIcon />
        </button>
      </div>
      <div className="side-tree">
        {segs.map((seg) =>
          seg.kind === 'tab' ? (
            renderTab(seg.tab, false)
          ) : (
            <div
              key={seg.group.id}
              className={
                'side-group' +
                (seg.group.collapsed ? ' collapsed' : '') +
                (broadcastEnabled && broadcastGroups.has(seg.group.id) ? ' broadcasting' : '')
              }
              style={{ '--g-color': seg.group.color } as CSSProperties}
            >
              {/* 组节点：单击折叠/展开（重命名走右键）。组头可作拖拽入组落点 */}
              <div
                className="side-group-head"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onGroupToggle(seg.group.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setGroupMenu({ x: e.clientX, y: e.clientY, groupId: seg.group.id })
                }}
                onDragOver={dragOver}
                onDragLeave={dragLeave}
                onDrop={(e) => {
                  const from = takeDrop(e)
                  if (from) onDrop(from, { kind: 'group', groupId: seg.group.id })
                }}
                title="单击折叠/展开，右键重命名/换色/解散；拖标签到此处入组"
              >
                <ChevronIcon className="g-chev" />
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
                <span className="g-count">{seg.tabs.length}</span>
                {/* 广播开关（设置总开关开启时渲染），语义/警示与标签栏组头一致 */}
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
              </div>
              {!seg.group.collapsed && seg.tabs.map(({ tab }) => renderTab(tab, true))}
            </div>
          )
        )}
      </div>

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

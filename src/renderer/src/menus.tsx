import {
  BroadcastIcon,
  FolderPlusIcon,
  PencilIcon,
  PinIcon,
  XIcon,
  type MenuEntry,
} from './ContextMenu'
import { GROUP_COLORS, GROUP_COLOR_NAMES, type TabGroup, type TermInfo } from './api'

// 标签/组右键菜单条目构建：条目 key（pin/new-group/move-*/leave-group/close、
// rename/broadcast/color-*/dissolve）是 e2e 的点击选择器，标签栏与分组侧栏
// 共用此构建器，两处菜单行为与 key 永远一致

export interface TabMenuHandlers {
  onTogglePin: (id: string) => void
  // 「归入新组」：调用方完成建组（onGroupNew）+ 进入组名编辑态两步
  onMenuNewGroup: (id: string) => void
  onGroupMove: (id: string, groupId: string) => void
  onGroupLeave: (id: string) => void
  onClose: (id: string) => void
}

export function buildTabMenuItems(t: TermInfo, groups: TabGroup[], h: TabMenuHandlers): MenuEntry[] {
  const others = groups.filter((g) => g.id !== t.groupId)
  return [
    {
      key: 'pin',
      label: t.pinned ? '取消固定标签页' : '固定标签页',
      icon: PinIcon,
      action: () => h.onTogglePin(t.id),
    },
    { key: 'sep-pin', sep: true },
    {
      key: 'new-group',
      label: '将标签页添加到新组',
      icon: FolderPlusIcon,
      // 固定与分组互斥：固定标签上置灰，取消固定后可用
      disabled: !!t.pinned,
      action: () => h.onMenuNewGroup(t.id),
    },
    ...others.map<MenuEntry>((g) => ({
      key: `move-${g.id}`,
      label: `移入「${g.name}」`,
      icon: <span className="dot" style={{ background: g.color }} />,
      disabled: !!t.pinned,
      action: () => h.onGroupMove(t.id, g.id),
    })),
    ...(t.groupId
      ? [
          {
            key: 'leave-group',
            label: '从组中移除',
            icon: XIcon,
            action: () => h.onGroupLeave(t.id),
          } as MenuEntry,
        ]
      : []),
    { key: 'sep-close', sep: true },
    { key: 'close', label: '关闭标签页', action: () => h.onClose(t.id) },
  ]
}

export interface GroupMenuHandlers {
  // 「重命名组」：调用方进入组名编辑态
  onMenuRename: (group: TabGroup) => void
  // 广播入口之二（组头开关是之一）：总开关开启时才出现
  broadcastEnabled: boolean
  broadcastGroups: Set<string>
  onGroupBroadcast: (groupId: string) => void
  onGroupColor: (groupId: string, color: string) => void
  onGroupDissolve: (groupId: string) => void
}

export function buildGroupMenuItems(g: TabGroup, h: GroupMenuHandlers): MenuEntry[] {
  return [
    {
      key: 'rename',
      label: '重命名组',
      icon: PencilIcon,
      action: () => h.onMenuRename(g),
    },
    ...(h.broadcastEnabled
      ? [
          {
            key: 'broadcast',
            label: h.broadcastGroups.has(g.id) ? '停止广播输入' : '广播输入到全组',
            icon: BroadcastIcon,
            shortcut: h.broadcastGroups.has(g.id) ? '✓' : undefined,
            action: () => h.onGroupBroadcast(g.id),
          } as MenuEntry,
        ]
      : []),
    { key: 'sep-rename', sep: true },
    ...GROUP_COLORS.map<MenuEntry>((c, i) => ({
      key: `color-${i}`,
      label: GROUP_COLOR_NAMES[i],
      icon: <span className="dot" style={{ background: c }} />,
      shortcut: c === g.color ? '✓' : undefined,
      action: () => h.onGroupColor(g.id, c),
    })),
    { key: 'sep-dissolve', sep: true },
    { key: 'dissolve', label: '解散组', icon: XIcon, action: () => h.onGroupDissolve(g.id) },
  ]
}

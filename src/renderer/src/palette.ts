import type { AppSettings, Profile, TabGroup, TermInfo } from './api'

// 命令面板注册表：key 同时是 e2e 的 data-key 选择器（.palette-item[data-key]），
// label 参与模糊匹配与展示，keywords 提供附加匹配词（中文命令也能用英文命中）。
// 所有 action 都映射 App 现有回调，面板本身不产生新的数据流
export interface PaletteCommand {
  key: string
  label: string
  /** 右侧浅色提示（快捷键 / 上下文标记） */
  hint?: string
  keywords?: string
  disabled?: boolean
  /** 破坏性命令（退出终结会话）红色提示 */
  danger?: boolean
  /** 命令色点（profile/标签原色） */
  color?: string
  /** 特殊交互：rename 不直接执行，面板切换到二段改名模式 */
  mode?: 'rename'
  action?: () => void
}

export interface PaletteHandlers {
  newTab: (profileId?: string) => void
  togglePin: (id: string) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  addToNewGroup: (id: string) => void
  removeFromGroup: (id: string) => void
  toggleGroupBroadcast: (groupId: string) => void
  toggleSidebar: () => void
  openSettings: () => void
  setTheme: (theme: AppSettings['theme']) => void
  quitAll: () => void
}

export interface PaletteCtx {
  tabs: TermInfo[]
  groups: TabGroup[]
  activeId: string
  profiles: Profile[]
  settings: AppSettings
  broadcastGroups: Set<string>
  handlers: PaletteHandlers
}

const THEME_NAMES: Record<AppSettings['theme'], string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

/** 按当前状态构建全部命令：上下文相关项条件出现（在组才出移出/广播、
    广播命令随设置总开关门控、固定标签的关闭置灰、主题当前项置灰） */
export function buildCommands(ctx: PaletteCtx): PaletteCommand[] {
  const { tabs, groups, activeId, profiles, settings, broadcastGroups, handlers: h } = ctx
  const active = tabs.find((t) => t.id === activeId)
  const activeGroup = active?.groupId ? groups.find((g) => g.id === active.groupId) : undefined

  return [
    // ── 标签操作 ──
    { key: 'new-tab', label: '新建标签', hint: 'Ctrl+Shift+T', keywords: 'new tab', action: () => h.newTab() },
    ...profiles
      .filter((p) => p.available !== false)
      .map((p) => ({
        key: `new-tab:${p.id}`,
        label: `新建标签：${p.name}`,
        keywords: `new tab ${p.id}`,
        color: p.color,
        action: () => h.newTab(p.id)
      })),
    ...(active
      ? [
          { key: 'rename', label: '重命名当前标签…', keywords: 'rename', mode: 'rename' as const },
          {
            key: 'pin',
            label: active.pinned ? '取消固定当前标签' : '固定当前标签',
            keywords: 'pin unpin',
            action: () => h.togglePin(active.id)
          },
          {
            key: 'close',
            label: '关闭当前标签',
            hint: 'Ctrl+Shift+W',
            keywords: 'close',
            // 固定标签防误关：快捷键与 × 都不关，面板同样置灰（关闭走菜单显式动作）
            disabled: !!active.pinned,
            action: () => h.closeTab(active.id)
          }
        ]
      : []),
    // ── 标签快速切换（面板兼作切换器；活跃标签自身不列）──
    ...tabs
      .filter((t) => t.id !== activeId)
      .map((t) => {
        const g = groups.find((x) => x.id === t.groupId)
        const marks = [t.pinned ? '已固定' : undefined, g ? `组「${g.name}」` : undefined]
          .filter(Boolean)
          .join(' · ')
        return {
          key: `switch:${t.id}`,
          label: `切换到标签：${t.title}`,
          hint: marks || undefined,
          keywords: `switch tab ${g?.name ?? ''}`,
          color: t.color,
          action: () => h.activateTab(t.id)
        }
      }),
    // ── 分组与广播（上下文 = 当前标签）──
    ...(active
      ? [
          {
            key: 'group-new',
            label: '将当前标签添加到新组',
            keywords: 'group new',
            disabled: !!active.pinned,
            action: () => h.addToNewGroup(active.id)
          },
          ...(activeGroup
            ? [
                {
                  key: 'group-leave',
                  label: `将当前标签移出组「${activeGroup.name}」`,
                  keywords: 'leave group remove 移出',
                  action: () => h.removeFromGroup(active.id)
                },
                ...(settings.groupBroadcast
                  ? [
                      {
                        key: 'group-broadcast',
                        label: broadcastGroups.has(activeGroup.id)
                          ? `停止向组「${activeGroup.name}」广播输入`
                          : `广播输入到组「${activeGroup.name}」`,
                        // 误广播代价高（密码/rm 同进多机）：开启动作以警示色强调
                        danger: !broadcastGroups.has(activeGroup.id),
                        keywords: 'broadcast',
                        action: () => h.toggleGroupBroadcast(activeGroup.id)
                      }
                    ]
                  : [])
              ]
            : [])
        ]
      : []),
    // ── 应用层 ──
    {
      key: 'sidebar',
      label: settings.sidebarVisible ? '隐藏分组侧栏' : '显示分组侧栏',
      hint: 'Ctrl+Shift+B',
      keywords: 'sidebar',
      action: h.toggleSidebar
    },
    { key: 'settings', label: '打开设置', hint: 'Ctrl+,', keywords: 'settings', action: h.openSettings },
    ...(['dark', 'light', 'system'] as const).map((th) => ({
      key: `theme:${th}`,
      label: `主题：${THEME_NAMES[th]}${settings.theme === th ? '（当前）' : ''}`,
      keywords: `theme ${th}`,
      disabled: settings.theme === th,
      action: () => h.setTheme(th)
    })),
    {
      key: 'quit',
      label: '退出并终结全部会话',
      hint: 'Ctrl+Shift+Q',
      keywords: 'quit exit',
      danger: true,
      action: h.quitAll
    }
  ]
}

// ── 模糊匹配：大小写不敏感子序列；打分偏爱连续命中与词首（串首或分隔符后），
//    返回命中下标供高亮。空查询命中一切（score 0，保持注册顺序）──

export interface FuzzyMatch {
  score: number
  hits: number[]
}

const SEPARATOR = /[\s·：:./-]/

export function fuzzy(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const hits: number[] = []
  let score = 0
  let qi = 0
  let prev = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    hits.push(ti)
    score += ti === prev + 1 ? 3 : ti === 0 || SEPARATOR.test(t[ti - 1]!) ? 2 : 1
    prev = ti
    qi++
  }
  return qi === q.length ? { score, hits } : null
}

export interface PaletteEntry {
  cmd: PaletteCommand
  score: number
  /** label 上的命中下标（keywords 命中时为空，不高亮） */
  hits: number[]
}

/** 过滤 + 打分排序（分降序，同分保持注册顺序——Array.prototype.sort 稳定），
    上限 60 条：20 标签场景约 40 条命令，滚动列表足够 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteEntry[] {
  const q = query.trim()
  if (!q) return commands.map((cmd) => ({ cmd, score: 0, hits: [] }))
  const out: PaletteEntry[] = []
  for (const cmd of commands) {
    const byLabel = fuzzy(q, cmd.label)
    const byKeywords = cmd.keywords ? fuzzy(q, cmd.keywords) : null
    const best = byLabel && byKeywords ? (byLabel.score >= byKeywords.score ? byLabel : byKeywords) : (byLabel ?? byKeywords)
    if (best) out.push({ cmd, score: best.score, hits: byLabel?.hits ?? [] })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 60)
}

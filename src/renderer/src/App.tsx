import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import {
  api,
  DEFAULT_SETTINGS,
  nextGroupColor,
  nextGroupName,
  type AppSettings,
  type PaneGeom,
  type PluginInfo,
  type Profile,
  type SplitDir,
  type TabGroup,
  type TermInfo,
  type ThemeDef,
} from './api'
import { TabBar } from './TabBar'
import { Sidebar, type SideDropTarget } from './Sidebar'
import { PaneLayout } from './PaneLayout'
import { TermSearch } from './TermSearch'
import { CommandPalette } from './CommandPalette'
import { buildCommands, type PaletteCommand } from './palette'
import { SettingsPage } from './SettingsPage'
import { ContextMenu, CopyIcon, PasteIcon, SplitHIcon, SplitVIcon, MaximizeIcon, XIcon } from './ContextMenu'
import {
  applyUiVars,
  pickScheme,
  rememberSchemeVars,
  rememberTheme,
  resolveDark,
  subscribeScheme,
} from './theme'
import { BUILTIN_THEMES } from '../../shared/themes'
import { setupE2E } from './e2e'
import { PluginPermissionModal } from './PluginPermissionModal'
import {
  clickStatusItem,
  dispatchTermData,
  emitTmEvent,
  initPluginHost,
  loadCodePlugins,
  onHostChange,
  permissionDecided,
  type HostSnapshot,
  type PluginPermPrompt,
} from './pluginHost'

// 摘出标签并给出插回锚点：原本在组内则锚在原组块末尾之后（原地改组会把同组切成
// 前后两段，破坏「同组连续」不变量），未分组则锚在原位置
function takeTabOut(ts: TermInfo[], id: string): { list: TermInfo[]; tab: TermInfo; insertAt: number } {
  const idx = ts.findIndex((t) => t.id === id)
  const tab = ts[idx]
  const list = ts.filter((_, i) => i !== idx)
  let insertAt = idx
  if (tab.groupId) {
    let last = -1
    for (let i = 0; i < list.length; i++) if (list[i].groupId === tab.groupId) last = i
    if (last >= 0) insertAt = last + 1
  }
  return { list, tab, insertAt }
}

export default function App() {
  const [tabs, setTabs] = useState<TermInfo[]>([])
  const [activeId, setActiveId] = useState('')
  // 分屏：tabId → 权威 pane 几何（后端 term:panes 推送，tmux 是唯一权威）；
  // 缺失时 PaneLayout 兜底渲染单 pane 满铺（tabId 即首 pane 的 termId）
  const [paneGeoms, setPaneGeoms] = useState<Record<string, PaneGeom[]>>({})
  // 分屏：tabId → 该 tab 内的活跃 pane termId；无记录 = 首 pane（== tabId）
  const [activePanes, setActivePanes] = useState<Record<string, string>>({})
  // 用户 profiles.json 的条目；插件注入的 profile 在 allProfiles 合并视图里追加
  const [profiles, setProfiles] = useState<Profile[]>([])
  // 声明式插件（面板命令 + 主题包 + profile 注入体），plugins:list 每次调用都重扫
  const [pluginInfos, setPluginInfos] = useState<PluginInfo[]>([])
  // themes 目录的配色方案（不含内建/插件包），themes:list 每次调用都重扫。
  // 初值给内建两套：异步拉取前 pickScheme/设置页下拉即有正确内容，无空白帧
  const [themeList, setThemeList] = useState<ThemeDef[]>(BUILTIN_THEMES)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  const [exited, setExited] = useState<Set<string>>(() => new Set())
  // Tier 2 待批准的插件网络权限队列（每次弹队首；决策后 pluginHost 补挂帧）
  const [permPrompts, setPermPrompts] = useState<PluginPermPrompt[]>([])

  // 权限批准入队（已在队列的插件不重复弹——refreshProfiles 会反复到达）
  const enqueuePermPrompts = (prompts: PluginPermPrompt[]) => {
    if (!prompts.length) return
    setPermPrompts((q) => [...q, ...prompts.filter((p) => !q.some((x) => x.id === p.id))])
  }
  // 决策落盘（允许 = 授权声明的 origin；拒绝 = null）→ pluginHost 补挂帧 → 出队；
  // 再回流刷新一次（设置页插件卡的权限状态即时更新；对队列无副作用——已决策者
  // 不会再产生 prompt，enqueue 去重兜底）
  const decidePerm = (allow: boolean) => {
    const p = permPrompts[0]
    if (!p) return
    void api.grantPluginPermission(p.id, allow ? p.hosts : null).then(() => {
      permissionDecided(p.id)
      setPermPrompts((q) => q.slice(1))
      refreshProfiles()
    })
  }
  // 标签分组：UI 态由渲染层维护，经 session:sync 上报主进程随会话持久化（跨重启恢复）
  const [groups, setGroups] = useState<TabGroup[]>([])
  // 广播中的组 id：纯运行时态，刻意不进 session:sync——重启/重开应用后广播一律
  // 复位为关，避免用户忘记广播仍开着而把密码敲进多台机器
  const [broadcastGroups, setBroadcastGroups] = useState<Set<string>>(() => new Set())
  const broadcastRef = useRef(new Set<string>())
  broadcastRef.current = broadcastGroups
  // 终端右键菜单：坐标 + 打开瞬间的可复制状态（随打开冻结，避免后续选择变化影响已开菜单）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; canCopy: boolean } | null>(null)
  // 新建终端失败提示（tmux 死了/profile 失效等），下次成功即清除
  const [createError, setCreateError] = useState('')
  // 命令面板开关（Ctrl+Shift+P；纯运行时态，不持久化）
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 终端查找框开关（Ctrl+Shift+F；纯运行时态）+ 上次查询词记忆（重开预填）。
  // 查询词由 TermSearch 渲染期实时回写 lastQuery——外部收起（设置页/面板打开）
  // 不走 onClose 也能留住当前词
  const [searchOpen, setSearchOpen] = useState(false)
  const lastQuery = useRef('')
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  // 代码级插件（L3）的注册物快照：面板命令/动态主题/状态栏项。pluginHost 单
  // 订阅推送，插件脚本异步注册时经 onHostChange 到达这里
  const [hostSnap, setHostSnap] = useState<HostSnapshot>({ commands: [], themes: [], statusbar: [] })
  // 用户手动重命名后，shell 上报的标题不再覆盖
  const renamed = useRef(new Set<string>())
  // 单点分发：所有终端实例注册在这里，一个 onData 订阅服务全部标签
  const terms = useRef(new Map<string, Terminal>())
  // 搜索 addon 注册表（TermView 上报，镜像 terms Map 惯例）：查找框经它对
  // 活跃终端执行 findNext/clearDecorations；终端销毁时上报 null 一并移除
  const searchAddons = useRef(new Map<string, SearchAddon>())
  const registerSearchAddon = (id: string, addon: SearchAddon | null) => {
    if (addon) searchAddons.current.set(id, addon)
    else searchAddons.current.delete(id)
  }
  // 早期输出缓冲：瞬逝命令（echo/一次性脚本）的 %output 可能跑赢 TermView 挂载
  // 注册，届时 terms.get(id) 为空、直接 write 会静默丢数据（交互 shell 提示符
  // 到得晚所以从未暴露；插件快捷命令让它成一等场景）。按 id 暂存，注册时冲刷
  const earlyData = useRef(new Map<string, string[]>())
  const writeTerm = (id: string, d: string) => {
    const t = terms.current.get(id)
    if (t) {
      t.write(d)
      return
    }
    const buf = earlyData.current.get(id) ?? []
    if (buf.length < 400) buf.push(d) // 上限防永不注册的 id 泄漏
    earlyData.current.set(id, buf)
  }
  const tabsRef = useRef<TermInfo[]>([])
  const activeRef = useRef('')
  tabsRef.current = tabs
  activeRef.current = activeId
  const paneGeomsRef = useRef(paneGeoms)
  paneGeomsRef.current = paneGeoms
  // 最近一次未 zoom 的 pane 几何（zoom 中邻接导航的基准，见 onPanes 订阅处注释）
  const unzoomedGeoms = useRef<Record<string, PaneGeom[]>>({})
  const activePanesRef = useRef(activePanes)
  activePanesRef.current = activePanes
  // pane termId → 所属 tabId（paneGeoms 反查；兜底期 pane 不在表里，回退 tab
  // 命中判定）。pane 数很小，O(n) 遍历足够
  const tabOfPane = (id: string): string | undefined => {
    for (const [tid, list] of Object.entries(paneGeomsRef.current)) {
      if (list.some((p) => p.id === id)) return tid
    }
    return undefined
  }
  // tab 的活跃 pane（无记录 = 首 pane）；「当前终端」= 活跃 tab 的活跃 pane
  const activePaneOf = (tabId: string): string => activePanesRef.current[tabId] ?? tabId
  const resolveActiveTermId = (): string => activePaneOf(activeRef.current)
  const groupsRef = useRef<TabGroup[]>([])
  groupsRef.current = groups
  const pluginInfosRef = useRef<PluginInfo[]>([])
  pluginInfosRef.current = pluginInfos
  // 合并视图：用户 profiles + 插件注入的 profile（id 已是「插件:局部」全局唯一）。
  // 菜单/侧栏/面板/默认 profile 全走这一份单一消费面，插件 profile 无需特判
  const allProfiles = useMemo(
    () => [...profiles, ...pluginInfos.flatMap((p) => p.profiles)],
    [profiles, pluginInfos]
  )
  const profilesRef = useRef<Profile[]>([])
  profilesRef.current = allProfiles
  // 配色全集 = themes 目录 + 插件主题包 + 代码级插件动态注册（id 命名空间化
  // 含 /，不会与全局撞）
  const themeDefs = useMemo(
    () => [...themeList, ...pluginInfos.flatMap((p) => p.themes), ...hostSnap.themes],
    [themeList, pluginInfos, hostSnap.themes]
  )
  // pluginHost 的 setScheme 依赖要读最新 themeDefs（含动态主题），走 ref 免闭包过期
  const themeDefsRef = useRef(themeDefs)
  themeDefsRef.current = themeDefs
  // newTab 会被挂载时的闭包（快捷键/onOpenDir）长期持有，设置走 ref 避免拿到过期值
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // 主题三态 → 实际深浅：显式深/浅是常量；system 跟随 prefers-color-scheme
  // （主进程 themeSource 驱动，含运行中的系统深浅切换），订阅同一通路即可全覆盖
  const theme = settings.theme
  const dark = useSyncExternalStore(subscribeScheme, () => resolveDark(theme))
  // 生效配色方案：themes 异步加载前列表为空 → pickScheme 回退内建，数据到位自然切换；
  // memo 保证无关渲染不产生新对象（下面的 [scheme] effect 靠引用相等去重）
  const scheme = useMemo(
    () => pickScheme(themeDefs, dark, settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeDefs, dark, settings.darkTheme, settings.lightTheme]
  )
  // 深浅落到 <html data-theme>（CSS 变量组挂这里），并记 localStorage 供下次启动预应用
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    rememberTheme(theme)
  }, [dark, theme])
  // 自定义配色的 UI 变量走 <html> 内联样式覆盖 :root 基线（清除即回退级联），
  // 同时缓存两侧最近生效值，供 preapplyTheme 防自定义主题首帧闪内建色
  useEffect(() => {
    applyUiVars(scheme.ui)
    rememberSchemeVars(dark, scheme)
  }, [scheme, dark])
  // xterm 画布不走 CSS：所有已开终端随方案整体换调色板（partial 已在 pickScheme
  // 与内建合并成套，不会出现缺省色打回 xterm 默认的问题）
  useEffect(() => {
    for (const t of terms.current.values()) t.options.theme = scheme.terminal
  }, [scheme])

  // 总开关关闭时广播态全部撤下（设置页即时生效）：组头开关随 UI 消失，
  // 残留的广播组会让输入悄悄复制，必须显式清空
  useEffect(() => {
    if (!settings.groupBroadcast) setBroadcastGroups(new Set())
  }, [settings.groupBroadcast])

  // 激活标签变化后把焦点交给它：真实点击标签（mousedown 已 preventDefault 保住
  // 原焦点，但目标终端此刻还 display:none、focus() 无效）与 Ctrl+Tab 切换
  // （旧终端被藏起，焦点不能留在不可见的 textarea 里）之后，键盘输入都应落在新终端
  useEffect(() => {
    if (!activeId) return
    terms.current.get(activePaneOf(activeId))?.focus()
    // 代码级插件事件：首启激活也发（语义上「当前标签」确实激活了）
    emitTmEvent('tab-activated', { id: activeId })
  }, [activeId])

  // pane 间焦点迁移（点击 pane / Ctrl+Alt+方向导航 / 新 pane 分屏后）：tab 不变、
  // 上面 [activeId] 的 effect 不会重跑，这里单独聚焦。新分屏的 pane 此刻可能
  // 尚未挂载注册（term:panes 异步推送），挂载时 TermView 自带的 focus() 接力
  useEffect(() => {
    if (!activeId) return
    terms.current.get(resolveActiveTermId())?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanes[activeId], activeId])

  // 会话持久化上报：标签顺序/固定/分组/活跃/改名态变化后 debounce 全量推送主进程
  //（数据量极小，全量快照比增量补丁简单可靠），主进程与窗口映射对账后落盘
  useEffect(() => {
    if (!tabs.length) return
    const timer = setTimeout(() => {
      api.syncSession({
        tabs: tabs.map((t) => ({
          id: t.id,
          profileId: t.profileId,
          title: t.title,
          color: t.color,
          pinned: t.pinned,
          groupId: t.groupId,
          renamed: renamed.current.has(t.id)
        })),
        groups: groups.map((g) => ({ ...g })),
        activeId
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [tabs, groups, activeId])

  useEffect(() => {
    let alive = true
    // 代码级插件宿主：先装全局对象与依赖（脚本注入前必须就位），再订阅快照
    initPluginHost({
      newTab,
      activateTab,
      getTabs: () => tabsRef.current,
      getActiveId: () => activeRef.current,
      getThemeDefs: () => themeDefsRef.current,
      getSettings: () => settingsRef.current,
      applySettings,
      openSettings: () => setSettingsOpen(true),
      writeInput: (id, data) => api.write(id, data)
    })
    onHostChange(setHostSnap)
    // 先订阅外部目录请求（Nautilus 右键 / CLI），再做 ready 握手取走排队项
    const offOpenDir = api.onOpenDir((dir) => {
      if (alive) void newTab(undefined, dir)
    })
    void Promise.all([api.listProfiles(), api.listPlugins()]).then(([ps, infos]) => {
      if (!alive) return
      // 同步刷 ref：下面 drain 时 newTab 需要据此选默认 profile（含插件注入的条目）
      pluginInfosRef.current = infos
      profilesRef.current = [...ps, ...infos.flatMap((p) => p.profiles)]
      setProfiles(ps)
      setPluginInfos(infos)
      // 带 entry 的插件在此挂沙箱 iframe（Tier 2 隔离宿主）；声明了网络权限
      // 且未决策的进批准队列
      enqueuePermPrompts(loadCodePlugins(infos))
      void api.cliReady().then(async (dirs) => {
        if (!alive) return
        for (const d of dirs) void newTab(undefined, d)
        if (dirs.length || tabsRef.current.length) return
        // 会话恢复：上次退出保留的 tmux 会话已由主进程附着，这里取回标签
        // （含固定/分组/活跃/改名态）；恢复成功则不再裸启动开默认终端
        const restored = await api.restoreSession()
        if (!alive) return
        if (restored && restored.tabs.length > 0) {
          restored.renamed.forEach((id) => renamed.current.add(id))
          setTabs(restored.tabs)
          setGroups(restored.groups)
          setActiveId(restored.activeId || restored.tabs[0]!.id)
          return
        }
        // 裸启动（应用菜单/命令行，无右键或 CLI 目录请求，无可恢复会话）开一个
        // 默认终端；cwd 不传，后端回退 ~（profile.cwd 优先）
        void api.getSettings().then((s) => {
          if (!alive) return
          // 同步刷 ref：newTab 要读到最新 defaultProfileId，不等 React 重渲染
          settingsRef.current = s
          setSettings(s)
          if (!tabsRef.current.length) void newTab()
        })
      })
    })
    api.getSettings().then((s) => {
      if (alive) setSettings(s)
    })
    // 配色方案列表：启动拉一次；设置页/面板打开时再重扫（主进程每次重读目录）
    void api.listThemes().then((ts) => {
      if (alive) setThemeList(ts)
    })
    const offData = api.onData((id, d) => {
      writeTerm(id, d)
      dispatchTermData(id, d)
    })
    // pane 布局权威推送（split/resize/pane 死亡塌缩后的 %layout-change 对账）
    const offPanes = api.onPanes((tabId, panes) => {
      setPaneGeoms((prev) => ({ ...prev, [tabId]: panes }))
      // 未 zoom 的几何快照：zoom 态下 paneGeoms 是满铺值（邻接导航判定失效），
      // Ctrl+Alt+方向导航换用快照算目标。zoomed pane 自身的原几何无从恢复，
      // 快照缺失时（恢复即 zoom 的边角）导航静默无动作，退出放大后自然补齐
      if (!panes.some((p) => p.zoomed)) unzoomedGeoms.current[tabId] = panes
    })
    const offExit = api.onExit((id) => {
      // pane 级退出语义分叉：id 是 pane 的 termId。非首 pane 死 → 即刻从布局
      // 除名（tmux 已销毁该 pane，幸存者拉伸补位）；首 pane（id==tabId）死且
      // window 还有别的 pane → tab 仍在、活跃 pane 迁移；否则 window 级死亡
      // → 现状语义：保留最后一帧画面 + [会话已退出] 标记
      const tabId = tabOfPane(id) ?? (tabsRef.current.some((t) => t.id === id) ? id : undefined)
      if (!tabId) return // tab 已删（closeTab 竞态残留）：静默
      const rest = (paneGeomsRef.current[tabId] ?? []).filter((p) => p.id !== id)
      if (id !== tabId || rest.length > 0) {
        setPaneGeoms((prev) =>
          tabId in prev ? { ...prev, [tabId]: (prev[tabId] ?? []).filter((p) => p.id !== id) } : prev
        )
        setActivePanes((prev) =>
          prev[tabId] === id ? { ...prev, [tabId]: rest[0]?.id ?? tabId } : prev
        )
        return
      }
      writeTerm(id, '\r\n\x1b[90m[会话已退出]\x1b[0m\r\n')
      setExited((s) => {
        const next = new Set(s)
        next.add(id)
        return next
      })
    })
    return () => {
      alive = false
      offData()
      offPanes()
      offExit()
      offOpenDir()
    }
  }, [])

  const newTab = async (profileId?: string, cwd?: string): Promise<TermInfo | undefined> => {
    const ps = profilesRef.current
    let pid = profileId
    if (!pid) {
      // 无显式 profile 的新建（+ 直建、Ctrl+Shift+T、Nautilus/CLI 打开目录）优先用默认终端；
      // 默认未设置、已删除或未安装时回退原有规则（首个可用 profile）
      const def = settingsRef.current.defaultProfileId
      pid =
        (def ? ps.find((p) => p.id === def && p.available !== false) : undefined)?.id ??
        (ps.find((p) => p.available !== false) ?? ps[0])?.id
    }
    if (!pid) return undefined
    let info: TermInfo
    try {
      info = await api.createTerm(pid, cwd)
    } catch (e) {
      // 后端不可用（tmux 缺失/服务器死了）不能只静默 reject：用户按了新建却毫无反馈
      console.error('[term] create failed:', e)
      setCreateError(e instanceof Error ? e.message : String(e))
      return undefined
    }
    setCreateError('')
    setTabs((ts) => [...ts, info])
    setActiveId(info.id)
    setSettingsOpen(false)
    emitTmEvent('tab-created', { id: info.id, profileId: info.profileId })
    return info
  }

  // Ctrl+Tab 循环切换。两条触发通路：焦点在终端内时 Tab 族被 xterm 键位表认领
  // （cancel = preventDefault + stopPropagation，window 层监听收不到），由
  // TermView 的 customKeyEventHandler 拦截后回调到这里；焦点在终端外
  // （菜单/设置页等）时走 App 的 window keydown 兜底
  const cycleTab = (dir: 1 | -1) => {
    const ts = tabsRef.current
    if (!ts.length) return
    const i = ts.findIndex((t) => t.id === activeRef.current)
    activateTab(ts[(i + dir + ts.length) % ts.length].id)
  }

  // ── 分屏操作 ──

  // pane 聚焦（点击 pane / Ctrl+Alt+方向导航）：本地切活跃 pane + 同步 tmux 侧
  // active（外部 attach 时焦点语义一致）
  const focusPane = (id: string) => {
    const tabId = tabOfPane(id)
    if (!tabId) return
    setActivePanes((prev) => (prev[tabId] === id ? prev : { ...prev, [tabId]: id }))
    api.selectPane(id)
  }

  // 在当前活跃 pane 旁分出新 pane（iTerm 惯例：D 左右 / E 上下）。新 pane 的
  // 焦点经 setActivePanes 记账，[activePanes] effect 与 TermView 挂载 focus 接力
  const doSplit = async (dir: SplitDir) => {
    const tabId = activeRef.current
    if (!tabId) return
    try {
      const id = await api.splitPane(tabId, activePaneOf(tabId), dir)
      setActivePanes((prev) => ({ ...prev, [tabId]: id }))
      setCreateError('')
    } catch (e) {
      console.error('[pane] split failed:', e)
      setCreateError(e instanceof Error ? e.message : String(e))
    }
  }

  // 关闭单个 pane：多 pane 时本地先行除名 + 焦点迁往剩余首个 pane（后端
  // term:exit 到达时幂等）；首 pane 走关闭整个标签（后端 killPane 对唯一 pane
  // 同样降级，语义闭合）
  const closePane = (id: string) => {
    const tabId = tabOfPane(id)
    if (!tabId) return
    const rest = (paneGeomsRef.current[tabId] ?? []).filter((p) => p.id !== id)
    if (id === tabId && rest.length === 0) {
      closeTab(tabId)
      return
    }
    api.killPane(id)
    setPaneGeoms((prev) =>
      tabId in prev ? { ...prev, [tabId]: (prev[tabId] ?? []).filter((p) => p.id !== id) } : prev
    )
    setActivePanes((prev) =>
      prev[tabId] === id ? { ...prev, [tabId]: rest[0]?.id ?? tabId } : prev
    )
  }

  // Ctrl+Alt+方向：几何邻接导航（paneGeoms 在手，无 IPC 往返）。left = 行区间
  // 与当前 pane 重叠且右边缘贴到当前左侧的最近 pane，其余方向对称
  const cyclePane = (dir: 'left' | 'right' | 'up' | 'down') => {
    const tabId = activeRef.current
    let panes = paneGeomsRef.current[tabId]
    if (!tabId || !panes || panes.length < 2) return
    // zoom 态下几何是满铺值（邻接判定永远落空），换用最近一次未 zoom 的快照；
    // 命中目标后 focusPane 的 select-pane 会让 tmux 自动退出放大（实测 3.2a）
    if (panes.some((p) => p.zoomed)) {
      panes = unzoomedGeoms.current[tabId] ?? []
      if (panes.length < 2) return
    }
    const cur = panes.find((p) => p.id === activePaneOf(tabId))
    if (!cur) return
    let best: PaneGeom | undefined
    for (const p of panes) {
      if (p.id === cur.id) continue
      const overlapY = p.y < cur.y + cur.rows && p.y + p.rows > cur.y
      const overlapX = p.x < cur.x + cur.cols && p.x + p.cols > cur.x
      if (dir === 'left' && p.x + p.cols <= cur.x && overlapY) {
        if (!best || p.x > best.x) best = p
      } else if (dir === 'right' && p.x >= cur.x + cur.cols && overlapY) {
        if (!best || p.x < best.x) best = p
      } else if (dir === 'up' && p.y + p.rows <= cur.y && overlapX) {
        if (!best || p.y > best.y) best = p
      } else if (dir === 'down' && p.y >= cur.y + cur.rows && overlapX) {
        if (!best || p.y < best.y) best = p
      }
    }
    if (best) focusPane(best.id)
  }

  // Ctrl+Shift+Enter 放大/还原当前 pane（tmux resize-pane -Z 的 toggle）：几何
  // 变化经 term:panes 权威推送回摆，焦点留在原 pane（zoom 的正是它）。单 pane
  // 无意义不动作；zoom 态随 tmux 会话存活，恢复免费
  const zoomToggle = () => {
    const tabId = activeRef.current
    const panes = tabId ? paneGeomsRef.current[tabId] : undefined
    const cur = tabId ? activePaneOf(tabId) : ''
    if (!tabId || !cur || !panes || panes.length < 2) return
    api.zoomPane(cur)
  }

  // 重拉 profile 列表：主进程每次 list 都重探 PATH（并补齐新装的内建 shell），
  // ＋ 菜单与命令面板打开时调用，运行中安装的 shell 无需重启立即可选
  // 重拉 profile/插件列表：主进程每次 list 都重扫（PATH 重探 + 插件目录重扫），
  // ＋ 菜单与命令面板打开时调用，运行中新增无需重启立即可选
  const refreshProfiles = () => {
    void Promise.all([api.listProfiles(), api.listPlugins()]).then(([ps, infos]) => {
      pluginInfosRef.current = infos
      profilesRef.current = [...ps, ...infos.flatMap((p) => p.profiles)]
      setProfiles(ps)
      setPluginInfos(infos)
      // 代码级插件：新出现的挂帧、消失的摘注册物销毁 realm（与 plugins:list
      // 同一节拍）；未决策的网络权限进批准队列
      enqueuePermPrompts(loadCodePlugins(infos))
    })
  }

  // 命令面板的 profile 命令与 ＋ 菜单同源：面板打开瞬间同步刷新一次
  useEffect(() => {
    if (paletteOpen) refreshProfiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen])

  // 设置页打开时重扫配色与插件：运行中新增/编辑的 themes/*.json、增删插件
  // 目录无需重启即可选（refreshProfiles 连带重拉插件，其主题包进 themeDefs）
  useEffect(() => {
    if (settingsOpen) {
      void api.listThemes().then(setThemeList)
      refreshProfiles()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  // 给 TabBar 的默认终端：设置了且本机可用才生效，否则视为未设置（+ 打开菜单）；
  // 合并视图下插件 profile 亦可被设为默认（id 全局唯一）
  const defaultProfileId =
    settings.defaultProfileId &&
    allProfiles.some((p) => p.id === settings.defaultProfileId && p.available !== false)
      ? settings.defaultProfileId
      : ''

  // 乐观更新即时生效，回包以主进程 sanitize 结果为准
  const applySettings = (patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    void api.setSettings(patch).then(setSettings)
    // 代码级插件事件：通告本次变更请求（同步语义，非回包确认）
    if (patch.theme) emitTmEvent('theme-changed', { theme: patch.theme })
    if (patch.darkTheme) emitTmEvent('scheme-changed', { schemeId: patch.darkTheme })
    if (patch.lightTheme) emitTmEvent('scheme-changed', { schemeId: patch.lightTheme })
  }

  // 声明式插件的面板命令段：动作词汇在此映射到 App 既有回调——launch 走
  // newTab（term:create 主进程侧按 id 解析插件 profile）、open-settings/
  // toggle-sidebar/set-theme 直连、set-scheme 按方案自身 type 落到对应设置项；
  // launch 的 profile 不可用或 set-scheme 引用不存在的方案时置灰不执行
  const pluginCommands: PaletteCommand[] = useMemo(() => {
    const out: PaletteCommand[] = []
    for (const info of pluginInfos) {
      for (const c of info.commands) {
        const base = { key: `plugin:${info.id}:${c.id}`, label: c.label, keywords: c.keywords, hint: c.hint }
        if (c.action.type === 'launch') {
          const pid = `${info.id}:${c.action.profile}`
          out.push({
            ...base,
            disabled: allProfiles.find((p) => p.id === pid)?.available === false,
            action: () => void newTab(pid)
          })
        } else if (c.action.type === 'open-settings') {
          out.push({ ...base, action: () => setSettingsOpen(true) })
        } else if (c.action.type === 'toggle-sidebar') {
          out.push({ ...base, action: () => applySettings({ sidebarVisible: !settingsRef.current.sidebarVisible }) })
        } else if (c.action.type === 'set-theme') {
          const mode = c.action.mode
          out.push({ ...base, action: () => applySettings({ theme: mode }) })
        } else {
          const schemeId = c.action.id
          const def = themeDefs.find((t) => t.id === schemeId)
          out.push({
            ...base,
            disabled: !def,
            action: def
              ? () => applySettings(def.type === 'dark' ? { darkTheme: def.id } : { lightTheme: def.id })
              : undefined
          })
        }
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginInfos, allProfiles, themeDefs])

  // 组内最后一个成员离开（关闭/移出/固定）时组自动消失
  const pruneGroups = (ts: TermInfo[]) => {
    setGroups((gs) => {
      const live = new Set(ts.map((t) => t.groupId).filter((g): g is string => !!g))
      const next = gs.filter((g) => live.has(g.id))
      return next.length === gs.length ? gs : next
    })
  }

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id)
    api.kill(id)
    const next = tabsRef.current.filter((t) => t.id !== id)
    setTabs(next)
    pruneGroups(next)
    // 分屏级联：该 tab 的 pane 布局与活跃 pane 记录一并清（各 pane 的 TermView
    // 随 PaneLayout 卸载自行注销；后端 kill-window 对全部 pane 发 term:exit，
    // 到达时 tab 已不在，onExit 静默）
    setPaneGeoms((prev) => {
      if (!(id in prev)) return prev
      const next2 = { ...prev }
      delete next2[id]
      return next2
    })
    delete unzoomedGeoms.current[id]
    setActivePanes((prev) => {
      if (!(id in prev)) return prev
      const next2 = { ...prev }
      delete next2[id]
      return next2
    })
    setExited((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
    if (activeRef.current === id) {
      setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? '')
    }
    emitTmEvent('tab-closed', { id })
  }

  const renameTab = (id: string, title: string) => {
    renamed.current.add(id)
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)))
    emitTmEvent('tab-renamed', { id, title })
  }

  // shell 通过 OSC 序列上报标题（如 ssh 到远端、进入目录时）；分屏后标题跟随
  // 各 tab 的活跃 pane，手动改名（renamed 按 tabId 记）后任何 pane 都不再覆盖
  const shellTitle = (id: string, title: string) => {
    if (!title) return
    const tabId = tabOfPane(id) ?? (tabsRef.current.some((t) => t.id === id) ? id : undefined)
    if (!tabId || renamed.current.has(tabId)) return
    if (id !== activePaneOf(tabId)) return
    setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, title } : t)))
  }

  const reorder = (from: number, to: number) => {
    setTabs((ts) => {
      const next = [...ts]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  // ── 固定/分组操作。不变量：固定标签是数组头部连续块、同组标签连续、固定标签永无 groupId ──

  // 固定：移到固定块尾并移出原组（固定与分组互斥）；取消固定：移到未固定区头部
  const togglePin = (id: string) => {
    const ts = tabsRef.current
    const t = ts.find((x) => x.id === id)
    if (!t) return
    const rest = ts.filter((x) => x.id !== id)
    // 锚点 = 其余标签里最后一个固定标签：固定插到它后面（固定块尾），取消固定也插到它后面（未固定区头）
    let anchor = -1
    for (let i = 0; i < rest.length; i++) if (rest[i].pinned) anchor = i
    const updated: TermInfo = t.pinned ? { ...t, pinned: false } : { ...t, pinned: true, groupId: undefined }
    const next = [...rest.slice(0, anchor + 1), updated, ...rest.slice(anchor + 1)]
    setTabs(next)
    pruneGroups(next)
  }

  // 归入新组：同步建组（默认名+轮选色）并返回组对象，供 TabBar 把组头置入重命名编辑态
  const addToNewGroup = (id: string): TabGroup => {
    const group: TabGroup = {
      id: crypto.randomUUID(),
      name: nextGroupName(groupsRef.current),
      color: nextGroupColor(groupsRef.current),
    }
    setGroups((gs) => [...gs, group])
    const { list, tab, insertAt } = takeTabOut(tabsRef.current, id)
    const next = [...list.slice(0, insertAt), { ...tab, groupId: group.id }, ...list.slice(insertAt)]
    setTabs(next)
    // 原组可能因此变空（换组场景）
    pruneGroups(next)
    return group
  }

  // 移入既有组：改组并挪到目标组块末尾
  const moveToGroup = (id: string, gid: string) => {
    const { list, tab } = takeTabOut(tabsRef.current, id)
    let at = list.length
    for (let i = 0; i < list.length; i++) if (list[i].groupId === gid) at = i + 1
    const next = [...list.slice(0, at), { ...tab, groupId: gid }, ...list.slice(at)]
    setTabs(next)
    pruneGroups(next)
  }

  // 移出组：挪到原组块右侧（原地清组会切断组）
  const removeFromGroup = (id: string) => {
    const { list, tab, insertAt } = takeTabOut(tabsRef.current, id)
    const next = [...list.slice(0, insertAt), { ...tab, groupId: undefined }, ...list.slice(insertAt)]
    setTabs(next)
    pruneGroups(next)
  }

  // 解散组：成员就地变回未分组（连续块整体清组不会切断任何东西，无需挪位）
  const dissolveGroup = (gid: string) => {
    setTabs(tabsRef.current.map((t) => (t.groupId === gid ? { ...t, groupId: undefined } : t)))
    setGroups((gs) => gs.filter((g) => g.id !== gid))
    setBroadcastGroups((bs) => {
      if (!bs.has(gid)) return bs
      const next = new Set(bs)
      next.delete(gid)
      return next
    })
  }

  // 组内广播开关（总开关 groupBroadcast 开启时组头/组菜单可见）
  const toggleGroupBroadcast = (gid: string) => {
    setBroadcastGroups((bs) => {
      const next = new Set(bs)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      return next
    })
  }

  // 分组侧栏开关（持久化设置；侧栏开启时标签栏隐藏，侧栏承担全部管理）
  const toggleSidebar = () => {
    applySettings({ sidebarVisible: !settingsRef.current.sidebarVisible })
  }

  // 侧栏树拖拽落点执行（不变量仍由本组件单点维护）：
  // 组头落点 = 入组（固定标签永不入组、同组无意义，静默忽略）；标签行落点 =
  // 同父（固定态与分组都相同）重排；分组标签落到未分组行 = 出组后插到目标旁
  //（单次数组操作完成，避免两次 setTabs 之间索引漂移）
  const sidebarDrop = (fromId: string, target: SideDropTarget) => {
    const ts = tabsRef.current
    const from = ts.find((t) => t.id === fromId)
    if (!from) return
    if (target.kind === 'group') {
      if (from.pinned || from.groupId === target.groupId) return
      moveToGroup(fromId, target.groupId)
      return
    }
    const to = ts.find((t) => t.id === target.id)
    if (!to || to.id === fromId) return
    if (from.pinned === to.pinned && from.groupId === to.groupId) {
      reorder(ts.findIndex((t) => t.id === fromId), ts.findIndex((t) => t.id === to.id))
      return
    }
    // 其余组合（未分组入组行走菜单/拖组头、固定↔未固定交叉）静默忽略
    if (!from.groupId || to.groupId || from.pinned !== to.pinned) return
    const { list, tab, insertAt } = takeTabOut(ts, fromId)
    const cleared = [...list.slice(0, insertAt), { ...tab, groupId: undefined }, ...list.slice(insertAt)]
    const src = cleared.findIndex((t) => t.id === fromId)
    const dst = cleared.findIndex((t) => t.id === to.id)
    if (src < 0 || dst < 0) return
    const next = [...cleared]
    const [moved] = next.splice(src, 1)
    next.splice(dst, 0, moved)
    setTabs(next)
    pruneGroups(next)
  }

  // 键盘输入路由：普通标签直达自己的 pane；广播组内的标签则同段输入发往全组
  //（含自身）。粘贴走 xterm paste → onData，同样被广播——向多机贴同一段命令
  // 正是广播的用途，属用户显式动作
  const sendInput = (id: string, data: string) => {
    const ts = tabsRef.current
    const gid = ts.find((t) => t.id === id)?.groupId
    if (gid && settingsRef.current.groupBroadcast && broadcastRef.current.has(gid)) {
      for (const t of ts) if (t.groupId === gid) api.write(t.id, data)
    } else {
      api.write(id, data)
    }
  }

  const renameGroup = (gid: string, name: string) => {
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, name } : g)))
  }

  const setGroupColor = (gid: string, color: string) => {
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, color } : g)))
  }

  const toggleGroupCollapse = (gid: string) => {
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)))
  }

  // 激活标签：切入折叠组的成员时自动展开该组（点选与 Ctrl+Tab 共用）。
  // 焦点：切换场景（含真实点击标签——.tab 不可聚焦，点击会把焦点甩到 body）
  // 由 [activeId] effect 在渲染后聚焦新终端；点已激活的标签没有状态变化，
  // effect 不会重跑，这里同步聚焦（此刻终端可见，focus() 立即生效）
  const activateTab = (id: string) => {
    if (id === activeRef.current) terms.current.get(activePaneOf(id))?.focus()
    setActiveId(id)
    setSettingsOpen(false)
    const gid = tabsRef.current.find((t) => t.id === id)?.groupId
    if (gid) {
      setGroups((gs) => gs.map((g) => (g.id === gid && g.collapsed ? { ...g, collapsed: false } : g)))
    }
  }

  const registerTerminal = (id: string, t: Terminal | null) => {
    if (t) {
      terms.current.set(id, t)
      // 会话恢复的标签：挂载即拉屏幕回放（capture-pane 快照 + 光标定位序列）。
      // 新建标签 replayTerm 返回空串，多一次往返无副作用。回放落定后冲刷早期
      // 缓冲——capture 已含此前内容，先写快照再写其后到达的实时输出，顺序不乱
      void api
        .replayTerm(id)
        .then((text) => {
          if (text) t.write(text)
        })
        .catch((e) => console.error('[term] replay failed:', e))
        .finally(() => {
          const buf = earlyData.current.get(id)
          if (buf) {
            for (const d of buf) t.write(d)
            earlyData.current.delete(id)
          }
        })
    } else {
      terms.current.delete(id)
    }
  }

  // 右键菜单动作：目标始终是当前活跃终端（可见的活跃 pane；右键前的 mousedown
  // 已把该 pane 切成活跃）。点击菜单项会把 DOM 焦点从 xterm 的 textarea 挪走
  // （原生 Menu 无此问题），动作完成后必须把焦点还给终端，否则后续按键全部丢失
  const openTermContextMenu = (x: number, y: number) => {
    setCtxMenu({ x, y, canCopy: !!terms.current.get(resolveActiveTermId())?.hasSelection() })
  }

  const focusActiveTerm = () => {
    terms.current.get(resolveActiveTermId())?.focus()
  }

  const copySelection = () => {
    const t = terms.current.get(resolveActiveTermId())
    if (t?.hasSelection()) api.writeClipboard(t.getSelection())
    focusActiveTerm()
  }

  const pasteClipboard = () => {
    focusActiveTerm()
    void api.readClipboard().then((text) => {
      if (text) terms.current.get(resolveActiveTermId())?.paste(text)
    })
  }

  // 命令面板关闭（Esc/执行命令/点击外部）：焦点还给活跃终端——面板输入框
  // 拿着焦点时终端收不到键盘，与菜单关闭归还焦点同一语义
  const closePalette = () => {
    setPaletteOpen(false)
    focusActiveTerm()
  }

  // 查找框关闭（Esc/×）：匹配装饰随 TermSearch 卸载清理，这里只收状态与
  // 归还终端焦点（palette 关闭同语义）；查询词已由组件实时写进 lastQuery
  const closeTermSearch = () => {
    setSearchOpen(false)
    focusActiveTerm()
  }

  // 设置页(z20 低于查找框 z26)/命令面板打开时收起查找框：层压关系在这里
  // 不可靠，且两者打开时焦点应归各自输入框，不收起会互相纠缠
  useEffect(() => {
    if ((settingsOpen || paletteOpen) && searchOpenRef.current) setSearchOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, paletteOpen])

  // 快捷键：Ctrl+Shift+T 新建 / Ctrl+Shift+W 关闭 / Ctrl+Tab、Ctrl+Shift+Tab 切换
  // / Ctrl+Shift+Q 退出并终结会话（终端聚焦时 Ctrl+Q 族被 xterm 认领，由
  // TermView 的 customKeyEventHandler 拦截后同样走 quitAll，这里是不在终端时的兜底）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && k === 't') {
        e.preventDefault()
        void newTab()
      } else if (e.ctrlKey && e.shiftKey && k === 'w') {
        e.preventDefault()
        // 多 pane 标签：降级为关当前活跃 pane（固定标签也允许——固定保护的是
        // 标签不丢，pane 关到只剩一个时回到固定守卫不再动作）；单 pane 走原
        // 关标签路径（固定标签防误关：快捷键不关，关闭走右键菜单的显式动作）
        const cur = tabsRef.current.find((t) => t.id === activeRef.current)
        const panes = paneGeomsRef.current[activeRef.current]
        if (activeRef.current && panes && panes.length > 1) {
          closePane(activePaneOf(activeRef.current))
        } else if (activeRef.current && !cur?.pinned) {
          closeTab(activeRef.current)
        }
      } else if (e.ctrlKey && e.shiftKey && (k === 'd' || k === 'e')) {
        // 分屏（iTerm 惯例）：D 左右 / E 上下。Ctrl+Shift+D/E 不在 xterm 键位表
        //（Ctrl+D 的 EOF 认领不带 Shift），window 层单通路覆盖终端聚焦/失焦
        e.preventDefault()
        void doSplit(k === 'd' ? 'h' : 'v')
      } else if (e.ctrlKey && e.shiftKey && k === 'enter') {
        // 窗格放大/还原的兜底通路：终端聚焦时 Enter 族被 xterm 键位表认领
        //（TermView 的 customKeyEventHandler 拦截后走同一 zoomToggle），这里
        // 覆盖焦点不在终端时的情况
        e.preventDefault()
        zoomToggle()
      } else if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key.startsWith('Arrow') || (e.keyCode >= 37 && e.keyCode <= 40))) {
        // pane 导航的兜底通路：焦点在终端内时 Ctrl+Alt+方向被 xterm 键位表认领，
        // 由 TermView 的 customKeyEventHandler 拦截后回调同一 cyclePane。合成输入
        // 可能不生成 key 文本，DOM keyCode（37-40）兜底
        e.preventDefault()
        cyclePane(e.keyCode === 37 || e.key === 'ArrowLeft' ? 'left' : e.keyCode === 39 || e.key === 'ArrowRight' ? 'right' : e.keyCode === 38 || e.key === 'ArrowUp' ? 'up' : 'down')
      } else if (e.ctrlKey && e.shiftKey && k === 'q') {
        e.preventDefault()
        api.quitAll()
      } else if (e.ctrlKey && e.shiftKey && k === 'b') {
        // 分组侧栏开关：Ctrl+Shift+B 不在 xterm 键位表（Ctrl+B 位移符不带 Shift
        // 才被认领），window 层一条通路即可覆盖终端聚焦/失焦两种情况
        e.preventDefault()
        toggleSidebar()
      } else if (e.ctrlKey && e.shiftKey && k === 'p') {
        // 命令面板开关：与 Ctrl+Shift+B 同族，不被 xterm 键位表认领，window 层
        // 单通路覆盖终端聚焦/失焦（面板开着时焦点在输入框，再按即关闭）
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (e.ctrlKey && e.shiftKey && k === 'f') {
        // 终端查找框：Ctrl+Shift+F 同样不被 xterm 键位表认领（不抢 shell 的
        // Ctrl+F=forward-char），window 层单通路覆盖终端聚焦/失焦两种情况。
        // 已开着则把焦点收回输入框并全选（焦点在输入框内时由其 onKeyDown
        // 拦截处理，不会走到这里的分支）
        e.preventDefault()
        if (searchOpenRef.current) {
          document.querySelector<HTMLInputElement>('.term-search-input')?.select()
        } else {
          setSearchOpen(true)
        }
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        cycleTab(e.shiftKey ? -1 : 1)
      } else if (e.ctrlKey && !e.shiftKey && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((open) => !open)
      } else if (e.key === 'Escape' && settingsOpenRef.current) {
        setSettingsOpen(false)
        // 焦点归还：焦点曾在设置页控件上（点过复选框/下拉或 Tab 导航），随卸载
        // 掉到 body 的话终端键盘输入会静默失效——同菜单/重命名关闭的归还语义
        focusActiveTerm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // E2E 驱动（仅当主进程调用 __e2eStart 时激活）；__E2E__ 在 dist 打包时被
  // define 成 false，rollup 把钩子从产物中摇掉（见 shared/globals.d.ts）
  useEffect(() => {
    if (__E2E__) {
      setupE2E({
        getProfiles: () => profilesRef.current,
        createTab: newTab,
        terms,
        getTabs: () => tabsRef.current,
        getGroups: () => groupsRef.current,
        getRenamed: () => [...renamed.current],
        getBroadcast: () => [...broadcastRef.current],
        getSidebarVisible: () => settingsRef.current.sidebarVisible
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 广播警示徽标：活跃标签处于广播中的组时，内容区右上角常驻提示——误向
  // 多台机器输入（密码/rm）代价极高，键盘落点必须时刻可见
  const activeGid = tabs.find((t) => t.id === activeId)?.groupId
  const broadcastTargets =
    activeGid && settings.groupBroadcast && broadcastGroups.has(activeGid)
      ? tabs.filter((t) => t.groupId === activeGid).length
      : 0

  return (
    <div className="app">
      {/* 分组侧栏与标签栏互斥呈现（同一份数据的两个视图），避免双份信息占空间 */}
      {settings.sidebarVisible && (
        <Sidebar
          tabs={tabs}
          activeId={activeId}
          profiles={allProfiles}
          exited={exited}
          defaultProfileId={defaultProfileId}
          groups={groups}
          broadcastEnabled={settings.groupBroadcast}
          broadcastGroups={broadcastGroups}
          onSelect={activateTab}
          onClose={closeTab}
          onRename={renameTab}
          onRenameEnd={(id) => terms.current.get(activePaneOf(id))?.focus()}
          onNewTab={(pid) => void newTab(pid)}
          onOpenSettings={() => setSettingsOpen(true)}
          onRefreshProfiles={refreshProfiles}
          onToggleSidebar={toggleSidebar}
          onDrop={sidebarDrop}
          onTogglePin={togglePin}
          onGroupNew={addToNewGroup}
          onGroupMove={moveToGroup}
          onGroupLeave={removeFromGroup}
          onGroupRename={renameGroup}
          onGroupColor={setGroupColor}
          onGroupDissolve={dissolveGroup}
          onGroupBroadcast={toggleGroupBroadcast}
          onGroupToggle={toggleGroupCollapse}
          onGroupRenameEnd={focusActiveTerm}
          onMenuClose={focusActiveTerm}
        />
      )}
      <div className="app-body">
        {!settings.sidebarVisible && (
          <TabBar
            tabs={tabs}
            activeId={activeId}
            profiles={allProfiles}
            exited={exited}
            defaultProfileId={defaultProfileId}
            groups={groups}
            broadcastEnabled={settings.groupBroadcast}
            broadcastGroups={broadcastGroups}
            onSelect={activateTab}
            onClose={closeTab}
            onRename={renameTab}
            onRenameEnd={(id) => terms.current.get(activePaneOf(id))?.focus()}
            onReorder={reorder}
            onNewTab={(pid) => void newTab(pid)}
            onOpenSettings={() => setSettingsOpen(true)}
            onRefreshProfiles={refreshProfiles}
            onToggleSidebar={toggleSidebar}
            onTogglePin={togglePin}
            onGroupNew={addToNewGroup}
            onGroupMove={moveToGroup}
            onGroupLeave={removeFromGroup}
            onGroupRename={renameGroup}
            onGroupColor={setGroupColor}
            onGroupDissolve={dissolveGroup}
            onGroupBroadcast={toggleGroupBroadcast}
            onGroupToggle={toggleGroupCollapse}
            // 组头重命名提交/取消后归还焦点（同标签重命名：焦点丢失会漏按键进终端）
            onGroupRenameEnd={focusActiveTerm}
            // 标签/组右键菜单任意关闭（动作执行、点击外部、Escape）后把焦点还给活跃终端
            onMenuClose={focusActiveTerm}
          />
        )}
        <div className="content">
          {tabs.map((t) => (
            <PaneLayout
              key={t.id}
              tabId={t.id}
              visible={t.id === activeId}
              panes={paneGeoms[t.id] ?? []}
              activePaneId={activePanes[t.id] ?? t.id}
              fontFamily={settings.fontFamily}
              fontSize={settings.fontSize}
              gpu={settings.gpuRendering}
              scheme={scheme}
              onTitle={shellTitle}
              onTerminal={registerTerminal}
              onSearchAddon={registerSearchAddon}
              onContextMenu={openTermContextMenu}
              onInput={sendInput}
              onCycleTab={cycleTab}
              onCyclePane={cyclePane}
              onPaneFocus={focusPane}
              onZoomToggle={zoomToggle}
            />
          ))}
          {broadcastTargets > 1 && (
            <div className="broadcast-badge" title="关闭广播：组头广播开关或组右键菜单">
              ⩕ 广播输入中 · 本组 {broadcastTargets} 个终端同步接收
            </div>
          )}
          {searchOpen && (
            <TermSearch
              activeId={resolveActiveTermId()}
              getAddon={(id) => searchAddons.current.get(id)}
              dark={dark}
              queryMem={lastQuery}
              initialQuery={lastQuery.current}
              onClose={closeTermSearch}
            />
          )}
          {createError && <div className="create-error">新建终端失败：{createError}</div>}
          {settingsOpen && (
            <SettingsPage
              settings={settings}
              profiles={allProfiles}
              themes={themeDefs}
              pluginInfos={pluginInfos}
              onPluginsChanged={refreshProfiles}
              onChange={applySettings}
              onClose={() => {
                setSettingsOpen(false)
                // × 关闭与 Esc 同语义：归还焦点到活跃终端（防 body 吞键盘）
                focusActiveTerm()
              }}
            />
          )}
        </div>
        {/* 状态栏（代码级插件的 UI 扩展点）：有插件项才渲染，默认视觉零变化。
            点击后归还终端焦点（除非回调打开了设置页——设置页是覆盖层，焦点
            该留在里面）；样式全走主题 CSS 变量自动适配深浅 */}
        {hostSnap.statusbar.length > 0 && (
          <footer className="statusbar">
            {hostSnap.statusbar.map((it) => (
              <span
                key={it.key}
                className={it.clickable ? 'statusbar-item clickable' : 'statusbar-item'}
                style={it.color ? { color: it.color } : undefined}
                title={it.tooltip}
                data-key={it.key}
                onClick={
                  it.clickable
                    ? () => {
                        clickStatusItem(it.key)
                        if (!settingsOpenRef.current) focusActiveTerm()
                      }
                    : undefined
                }
              >
                {it.text}
              </span>
            ))}
          </footer>
        )}
      </div>
      {/* Tier 2 权限批准弹窗：最顶层（面板/菜单/设置页之上），Esc/Enter 快捷决策。
          key 按插件 id 强制重建——弹窗内的防双击 ref 不跨插件复用 */}
      {permPrompts.length > 0 && permPrompts[0] && (
        <PluginPermissionModal key={permPrompts[0].id} prompt={permPrompts[0]} onDecide={decidePerm} />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              key: 'copy',
              label: '复制',
              shortcut: 'Ctrl+Shift+C',
              icon: CopyIcon,
              disabled: !ctxMenu.canCopy,
              action: copySelection
            },
            {
              key: 'paste',
              label: '粘贴',
              shortcut: 'Ctrl+Shift+V',
              icon: PasteIcon,
              action: pasteClipboard
            },
            { key: 'sep-split', sep: true },
            {
              key: 'term-split-h',
              label: '向右分屏',
              shortcut: 'Ctrl+Shift+D',
              icon: SplitHIcon,
              action: () => void doSplit('h')
            },
            {
              key: 'term-split-v',
              label: '向下分屏',
              shortcut: 'Ctrl+Shift+E',
              icon: SplitVIcon,
              action: () => void doSplit('v')
            },
            {
              key: 'term-zoom',
              // 菜单打开时按当前 zoom 态翻转文案（toggle 语义）
              label: (paneGeomsRef.current[activeRef.current] ?? []).some((p) => p.zoomed)
                ? '退出窗格放大'
                : '放大窗格',
              shortcut: 'Ctrl+Shift+Enter',
              icon: MaximizeIcon,
              // 单 pane 满铺与放大无差别，不提供动作
              disabled: (paneGeomsRef.current[activeRef.current]?.length ?? 1) < 2,
              action: zoomToggle
            },
            {
              key: 'term-close-pane',
              label: '关闭窗格',
              shortcut: 'Ctrl+Shift+W',
              icon: XIcon,
              // 单 pane 时关闭=关标签，语义已有更明确的入口（× / 关闭标签页）
              disabled: (paneGeomsRef.current[activeRef.current]?.length ?? 1) < 2,
              action: () => closePane(resolveActiveTermId())
            }
          ]}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={[...buildCommands({
            tabs,
            groups,
            activeId,
            profiles: allProfiles,
            settings,
            broadcastGroups,
            activePaneCount: paneGeoms[activeId]?.length ?? 1,
            paneZoomed: (paneGeoms[activeId] ?? []).some((p) => p.zoomed),
            handlers: {
              newTab: (pid) => void newTab(pid),
              togglePin,
              closeTab,
              activateTab,
              addToNewGroup,
              removeFromGroup,
              toggleGroupBroadcast,
              toggleSidebar,
              openSettings: () => setSettingsOpen(true),
              setTheme: (theme) => applySettings({ theme }),
              quitAll: () => api.quitAll(),
              splitPane: (dir) => void doSplit(dir),
              closePane: () => closePane(resolveActiveTermId()),
              toggleZoomPane: zoomToggle
            }
          }), ...pluginCommands, ...hostSnap.commands]}
          activeTitle={tabs.find((t) => t.id === activeId)?.title ?? ''}
          onClose={closePalette}
          onRename={(title) => {
            const id = activeRef.current
            if (id && title.trim()) renameTab(id, title)
          }}
        />
      )}
    </div>
  )
}

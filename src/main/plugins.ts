import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type {
  PluginAction,
  PluginCommandDef,
  PluginFsScope,
  PluginInfo,
  PluginPanelDef,
  PluginPermDecision,
  Profile,
  ThemeDef
} from '../shared/types'
import { parseThemeFile } from '../shared/themes'
import { PluginPermStore, MAX_PLUGIN_CONNECT, validConnectOrigin } from './pluginPerms'
import { PluginStateStore } from './pluginState'
import { findOnPath, validProfile } from './profiles'

export type { PluginInfo } from '../shared/types'

// 声明式插件注册表：plugins/<目录>/manifest.json，一个文件夹一个插件。
// 能力封闭为三类数据贡献——注入 profile（新标签菜单/面板可选）、命令面板条目
// （动作词汇封闭，见 PluginAction）、主题包（themes/ 子目录，与全局主题同格式、
// id 命名空间化）。零代码执行、零网络：manifest 是纯数据，安装即信任其声明的
// 内容（launch 动作 = 用户亲手在面板触发）。文件夹在即生效、删除即停用，
// 无启用状态持久化（管理界面属后续阶段）。
//
// 扫描目录两级：用户目录 userData/plugins（先扫，先到先得）+ 内置目录
// （安装包 resources/plugins，仓库 plugins-builtin/ 同源；dev 直读仓库）。
// 同 id 时用户副本整体覆盖内置——官方插件可被本地替换/降级，内置目录只读。
//
// 只读不落盘（同 ThemeRegistry）：plugins:list 每次调用重扫。

const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// 插件 id 更严：全小写（它要进 palette 的 data-key 与主题 id 命名空间）
const PLUGIN_ID_RE = /^[a-z0-9-]{1,64}$/
// set-scheme 引用的方案 id：与 settings.ts 的 SCHEME_ID_RE 同集（/ 为插件主题）
const SCHEME_REF_RE = /^[A-Za-z0-9/_-]{1,80}$/
// 代码级插件入口（L3）：相对路径、白名单字符集、.js/.mjs；
// 存在性与大小在 loadPlugin 里核（不合法只丢字段，声明式贡献保留）
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const MAX_ENTRY_BYTES = 1_000_000
// 面板图标（manifest panel.icon）：与入口同款字符集白名单 + 图像扩展名 +
// 存在性 + 大小上限，在 validPanelDef 里核
const PANEL_ICON_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const MAX_PANEL_ICON_BYTES = 262_144
// 防病态 manifest：单插件贡献条目上限
const MAX_PROFILES = 50
const MAX_COMMANDS = 100
const MAX_THEMES = 50

/**
 * entry 路径的完整校验（形状 + 无 .. 段 + 扩展名 + 真实存在 + ≤1MB）。
 * manifest 加载与 tmplug:// 合成宿主页共用同一条口径——渲染层只传来相对
 * 路径字符串，协议侧不能比 manifest 侧更松
 */
export function validEntryPath(dir: string, entry: string): boolean {
  if (
    typeof entry !== 'string' ||
    !ENTRY_RE.test(entry) ||
    entry.split('/').includes('..') ||
    !(entry.endsWith('.js') || entry.endsWith('.mjs'))
  ) {
    return false
  }
  try {
    const st = statSync(join(dir, entry))
    return st.isFile() && st.size <= MAX_ENTRY_BYTES
  } catch {
    return false
  }
}

interface LoadedPlugin extends PluginInfo {
  // 本地 profile id 集：launch 动作引用合法性的校验依据
  localProfileIds: Set<string>
  // 插件目录绝对路径：tmplug:// 协议解析的唯一权威（重复 id 先到先得）
  dir: string
  // fs 声明的内存形态（loadPlugin 已校验；permissions.fs 字段只有 entry 插件
  // 才有意义——纯声明式插件没有代码，无从发起 fs 调用）
  declaredFs: PluginFsScope[]
}

/**
 * manifest panel 字段的完整校验：title 非空且 ≤40 字符；icon（可选）相对
 * 路径白名单 + .svg/.png + 真实存在 + ≤256KB（经 tmplug:// 静态服务，与
 * entry 同一条收紧口径）。面板是 entry 插件的可见形态，无 entry 时字段丢弃
 */
function validPanelDef(dir: string, raw: unknown, source: string): PluginPanelDef | undefined {
  if (typeof raw !== 'object' || raw === null) {
    console.error(`[plugins] ${source}: panel 必须是对象，字段丢弃`)
    return undefined
  }
  const r = raw as Record<string, unknown>
  if (typeof r.title !== 'string' || !r.title.trim()) {
    console.error(`[plugins] ${source}: panel.title 必填，字段丢弃`)
    return undefined
  }
  const def: PluginPanelDef = { title: r.title.trim().slice(0, 40) }
  const icon = r.icon
  if (icon !== undefined) {
    // 直接 if 保持 string 收窄（布尔中间变量会让 TS 丢失 narrowing）
    if (typeof icon !== 'string' || !PANEL_ICON_RE.test(icon) || icon.split('/').includes('..')) {
      console.error(`[plugins] ${source}: panel.icon 非法，丢弃`)
      return def
    }
    try {
      const st = statSync(join(dir, icon))
      if (!st.isFile() || st.size > MAX_PANEL_ICON_BYTES || !/\.(svg|png)$/.test(icon)) {
        console.error(`[plugins] ${source}: panel.icon 缺失/超限/非图像，丢弃`)
        return def
      }
    } catch {
      console.error(`[plugins] ${source}: panel.icon 读取失败，丢弃`)
      return def
    }
    def.icon = icon
  }
  return def
}

function validCommand(
  raw: unknown,
  plugin: { id: string; localProfileIds: Set<string> },
  source: string
): PluginCommandDef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !LOCAL_ID_RE.test(r.id)) {
    console.error(`[plugins] ${source}: 命令 id 非法，丢弃`)
    return null
  }
  if (typeof r.label !== 'string' || !r.label.trim()) {
    console.error(`[plugins] ${source}: 命令 label 必填，丢弃`)
    return null
  }
  const action = validAction(r.action, plugin, `${source}#${r.id}`)
  if (!action) return null
  const cmd: PluginCommandDef = { id: r.id, label: r.label.trim().slice(0, 120), action }
  if (typeof r.keywords === 'string' && r.keywords.trim()) cmd.keywords = r.keywords.slice(0, 200)
  if (typeof r.hint === 'string' && r.hint.trim()) cmd.hint = r.hint.slice(0, 80)
  return cmd
}

// 动作词汇校验：类型之外的引用字段也要合法（launch 必须指向自家 profile，
// set-scheme 的 id 只查字符集——存在性由渲染层置灰处理，主进程不感知主题表）
function validAction(
  raw: unknown,
  plugin: { id: string; localProfileIds: Set<string> },
  source: string
): PluginAction | null {
  if (typeof raw !== 'object' || raw === null) {
    console.error(`[plugins] ${source}: 缺少 action，丢弃`)
    return null
  }
  const a = raw as Record<string, unknown>
  switch (a.type) {
    case 'launch':
      if (typeof a.profile !== 'string' || !plugin.localProfileIds.has(a.profile)) {
        console.error(`[plugins] ${source}: launch 引用了不存在的自家 profile，丢弃`)
        return null
      }
      return { type: 'launch', profile: a.profile }
    case 'open-settings':
      return { type: 'open-settings' }
    case 'toggle-sidebar':
      return { type: 'toggle-sidebar' }
    case 'set-theme':
      if (a.mode !== 'dark' && a.mode !== 'light' && a.mode !== 'system') {
        console.error(`[plugins] ${source}: set-theme 的 mode 非法，丢弃`)
        return null
      }
      return { type: 'set-theme', mode: a.mode }
    case 'set-scheme':
      if (typeof a.id !== 'string' || !SCHEME_REF_RE.test(a.id)) {
        console.error(`[plugins] ${source}: set-scheme 的 id 非法，丢弃`)
        return null
      }
      return { type: 'set-scheme', id: a.id }
    default:
      console.error(`[plugins] ${source}: 未知 action 类型 '${String(a.type)}'，丢弃`)
      return null
  }
}

function loadPlugin(dir: string, dirName: string): LoadedPlugin | null {
  const source = `plugins/${dirName}`
  let raw: string
  try {
    raw = readFileSync(join(dir, 'manifest.json'), 'utf-8')
  } catch (e) {
    console.error(`[plugins] ${source}: manifest.json 读取失败, skipped:`, e)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[plugins] ${source}: bad JSON, skipped:`, e)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (typeof r.id !== 'string' || !PLUGIN_ID_RE.test(r.id)) {
    console.error(`[plugins] ${source}: id 必须是 [a-z0-9-]{1,64}，skipped`)
    return null
  }
  if (typeof r.name !== 'string' || !r.name.trim()) {
    console.error(`[plugins] ${source}: name 必填，skipped`)
    return null
  }

  // profiles：validProfile 复用 + 本地 id 字符集收紧（id 会被重写成「插件:局部」
  // 进 palette key），availability 与 ProfileRegistry.detectAvailability 同口径
  const localProfileIds = new Set<string>()
  const profiles: Profile[] = []
  if (r.profiles !== undefined) {
    if (!Array.isArray(r.profiles)) {
      console.error(`[plugins] ${source}: profiles 必须是数组，整段忽略`)
    } else {
      for (const p of r.profiles.slice(0, MAX_PROFILES)) {
        const localId = (p as { id?: unknown })?.id
        if (!validProfile(p) || typeof localId !== 'string' || !LOCAL_ID_RE.test(localId)) {
          console.error(`[plugins] ${source}: dropped malformed plugin profile:`, JSON.stringify(p)?.slice(0, 200))
          continue
        }
        const merged: Profile = { ...p, id: `${r.id}:${localId}` }
        merged.available = merged.command ? findOnPath(merged.command) : true
        localProfileIds.add(localId)
        profiles.push(merged)
      }
    }
  }

  // commands：动作词汇封闭；launch 引用自家 profile，坏引用整条丢弃
  const commands: PluginCommandDef[] = []
  if (r.commands !== undefined) {
    if (!Array.isArray(r.commands)) {
      console.error(`[plugins] ${source}: commands 必须是数组，整段忽略`)
    } else {
      const plugin = { id: r.id, localProfileIds }
      for (const c of r.commands.slice(0, MAX_COMMANDS)) {
        const cmd = validCommand(c, plugin, source)
        if (cmd) commands.push(cmd)
      }
    }
  }

  // themes：插件目录 themes/*.json，与全局主题同格式，id 命名空间化「插件/stem」
  const themes: ThemeDef[] = []
  try {
    const files = readdirSync(join(dir, 'themes')).filter((f) => f.endsWith('.json')).sort()
    for (const f of files.slice(0, MAX_THEMES)) {
      const stem = f.slice(0, -'.json'.length)
      if (!LOCAL_ID_RE.test(stem)) {
        console.error(`[plugins] ${source}/themes: skipped '${f}': 文件名必须是 [A-Za-z0-9_-] id`)
        continue
      }
      const parsedTheme = parseThemeFile(readFileSync(join(dir, 'themes', f), 'utf-8'), `${source}/themes/${f}`)
      if (parsedTheme) themes.push({ id: `${r.id}/${stem}`, builtin: false, ...parsedTheme })
    }
  } catch {
    // themes 子目录不存在是常态，静默
  }

  const info: LoadedPlugin = {
    id: r.id,
    name: r.name.trim().slice(0, 80),
    profiles,
    commands,
    themes,
    localProfileIds,
    dir,
    declaredFs: []
  }
  if (typeof r.version === 'string' && r.version.trim()) info.version = r.version.slice(0, 32)

  // entry：代码级插件入口。字符串形态 + 字符集 + 无 .. 段 + .js/.mjs 扩展名，
  // 且文件真实存在、不超过 1MB——协议侧按相对路径拼接，这里收紧到位
  if (r.entry !== undefined) {
    if (typeof r.entry === 'string' && validEntryPath(dir, r.entry)) {
      info.entry = r.entry
    } else {
      console.error(`[plugins] ${source}: entry 非法或文件缺失/超限，字段丢弃`)
    }
  }

  // panel：面板声明（帧的可见形态）。只对 entry 插件有意义——无代码的声明式
  // 插件没有帧可挂面板，字段丢弃（与 permissions 的 entry 门槛同理）
  if (r.panel !== undefined && info.entry) {
    const panel = validPanelDef(dir, r.panel, source)
    if (panel) info.panel = panel
  }

  // permissions：Tier 2 权限词汇（connect 的 origin 白名单 + fs 档位）。
  // 逐条校验，坏条目丢弃（去重保序）；全坏或形状不对则整字段丢弃——
  // 不合法的权限声明不至于废掉整个插件，只是没有对应放行
  if (r.permissions !== undefined) {
    const p = r.permissions
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      console.error(`[plugins] ${source}: permissions 必须是对象，字段丢弃`)
    } else {
      const rawConnect = (p as Record<string, unknown>).connect
      if (rawConnect === undefined) {
        // 空权限对象合法（无诉求）
      } else if (!Array.isArray(rawConnect)) {
        console.error(`[plugins] ${source}: permissions.connect 必须是数组，字段丢弃`)
      } else {
        const connect: string[] = []
        for (const o of rawConnect) {
          if (validConnectOrigin(o) && !connect.includes(o)) {
            if (connect.length < MAX_PLUGIN_CONNECT) connect.push(o)
          } else if (!validConnectOrigin(o)) {
            console.error(`[plugins] ${source}: permissions.connect 含非法 origin，已丢弃:`, String(o).slice(0, 200))
          }
        }
        if (connect.length) info.permissions = { connect }
      }
      const rawFs = (p as Record<string, unknown>).fs
      if (rawFs === undefined) {
        // 无 fs 诉求合法
      } else if (!Array.isArray(rawFs)) {
        console.error(`[plugins] ${source}: permissions.fs 必须是数组，字段丢弃`)
      } else {
        const fs: PluginFsScope[] = []
        for (const s of rawFs) {
          if ((s === 'read' || s === 'write') && !fs.includes(s)) fs.push(s)
        }
        // fs 只对 entry 插件有意义（无帧即无调用方），但声明仍记入 declaredFs：
        // 权限决策快照对上才会 decided，纯声明式插件的这份声明永远空转
        if (fs.length) {
          info.declaredFs = fs
          if (info.entry) info.permissions = { ...info.permissions, fs }
        }
      }
    }
  }
  return info
}

export class PluginRegistry {
  private dir = ''
  private builtinDir = ''
  private plugins: LoadedPlugin[] = []
  // 权限决策存储（Tier 2）：list() 附带决策状态给渲染层弹批准框用。可选注入
  // 保持构造简单（测试/无决策场景传 undefined 即一切按未决策处理）
  // state：管理 UI 的禁用态（plugin-state.json），禁用的贡献过滤在这里收口
  constructor(
    private readonly perms?: PluginPermStore,
    private readonly state?: PluginStateStore
  ) {}

  load(): void {
    this.dir = join(app.getPath('userData'), 'plugins')
    // 建目录只为可发现性
    mkdirSync(this.dir, { recursive: true })
    // 内置目录只读不建：打包后 = resources/plugins（electron-builder
    // extraResources 从仓库 plugins-builtin/ 拷入，与 asar 无关）；dev 直读
    // 仓库根。dev 路径按 __dirname 上溯（out/main → 仓库根）——getAppPath
    // 在直跑 out/main/index.js 时返回 out/main 而非仓库根，不可依赖
    this.builtinDir = app.isPackaged
      ? join(process.resourcesPath, 'plugins')
      : join(__dirname, '..', '..', 'plugins-builtin')
    this.refresh()
  }

  /** 重扫两个目录（plugins:list 每次调用触发）。用户目录先扫（目录名排序
   *  先到先得），内置目录跳过已见 id——用户副本整体覆盖内置插件，官方插件
   *  可被本地替换 */
  refresh(): void {
    const found: LoadedPlugin[] = []
    const seen = new Set<string>()
    for (const root of [this.dir, this.builtinDir]) {
      let entries: Array<{ name: string; isDirectory: boolean }> = []
      try {
        entries = readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => ({ name: e.name, isDirectory: true }))
          .sort((a, b) => (a.name < b.name ? -1 : 1))
      } catch {
        // 内置目录缺失是常态（开发环境未带）；用户目录 load() 已建，异常静默
        continue
      }
      for (const e of entries) {
        const plugin = loadPlugin(join(root, e.name), e.name)
        if (!plugin) continue
        if (seen.has(plugin.id)) {
          if (root === this.dir) {
            console.error(`[plugins] plugins/${e.name}: 重复插件 id '${plugin.id}'，skipped`)
          } else {
            console.error(`[plugins] builtin/${e.name}: 插件 id '${plugin.id}' 已被用户插件覆盖，skipped`)
          }
          continue
        }
        seen.add(plugin.id)
        plugin.builtin = root === this.builtinDir
        found.push(plugin)
      }
    }
    this.plugins = found
  }

  list(): PluginInfo[] {
    return this.plugins.map((p) => {
      const disabled = this.state?.isDisabled(p.id) ?? false
      const info: PluginInfo = {
        id: p.id,
        name: p.name,
        version: p.version,
        // 禁用即贡献清空（渲染层 allProfiles/pluginCommands/themeDefs 三个消费点
        // 自然脱落，无需各自特判）；entry/权限状态保留给设置页的插件卡片展示
        profiles: disabled ? [] : p.profiles,
        commands: disabled ? [] : p.commands,
        themes: disabled ? [] : p.themes,
        entry: p.entry,
        ...(p.builtin ? { builtin: true } : {}),
        ...(p.panel ? { panel: { ...p.panel } } : {}),
        ...(disabled ? { disabled: true } : {})
      }
      const declared = p.entry && p.permissions?.connect?.length ? p.permissions.connect : []
      const declaredFs = p.entry && p.declaredFs.length ? p.declaredFs : []
      if (p.entry && (declared.length || declaredFs.length)) {
        info.permissions = {}
        if (declared.length) info.permissions.connect = declared
        if (declaredFs.length) info.permissions.fs = [...declaredFs]
        // 决策状态只对带 entry 的插件附带：纯声明式插件没有代码，权限声明无意义；
        // granted 是实授权（∩ 当前声明），denied 是显式拒绝——设置页据此展示
        const decided = this.perms?.isDecided(p.id, declared, declaredFs) ?? false
        const perm: PluginPermDecision = {
          hosts: declared,
          granted: decided ? this.perms!.effectiveConnect(p.id, declared) : [],
          fs: [...declaredFs],
          fsGranted: decided ? this.perms!.effectiveFs(p.id, declaredFs) : [],
          decided
        }
        const d = this.perms?.get(p.id)
        if (decided && d?.denied) perm.denied = true
        info.permDecision = perm
      }
      return info
    })
  }

  /** 插件根目录（load() 之后有效）：管理 UI「打开插件目录」用 */
  rootDir(): string {
    return this.dir
  }

  /** term:create 解析：渲染层只传「插件:局部」形式的全局 id，命令体永远不收。
   *  禁用的插件贡献不下发，陈旧 UI 引用在这里兜底拒绝 */
  getProfile(id: string): Profile | undefined {
    for (const p of this.plugins) {
      if (this.state?.isDisabled(p.id)) continue
      const hit = p.profiles.find((x) => x.id === id)
      if (hit) return hit
    }
    return undefined
  }

  /** tmplug:// 协议解析：插件 id → 胜出插件目录的绝对路径（渲染层拿不到路径） */
  getDir(id: string): string | undefined {
    return this.plugins.find((p) => p.id === id)?.dir
  }

  /** tmplug:// 合成宿主页用：插件展示元信息（name/version 内嵌进帧桥） */
  getMeta(id: string): { name: string; version?: string } | undefined {
    const p = this.plugins.find((x) => x.id === id)
    return p ? { name: p.name, version: p.version } : undefined
  }

  /** tmplug:// 合成宿主页用：entry 插件声明的 connect 白名单（无 entry/未声明为空） */
  declaredConnect(id: string): string[] {
    const p = this.plugins.find((x) => x.id === id)
    return p?.entry && p.permissions?.connect?.length ? p.permissions.connect : []
  }

  /** fs gate 用：entry 插件声明的 fs 档位（无 entry/未声明为空） */
  declaredFs(id: string): PluginFsScope[] {
    const p = this.plugins.find((x) => x.id === id)
    return p?.entry && p.declaredFs.length ? [...p.declaredFs] : []
  }
}

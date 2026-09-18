import { useEffect, useRef, useState } from 'react'
import { api, type AppSettings, type PluginInfo, type Profile, type ThemeDef } from './api'
import { PluginManager } from './PluginManager'
import { resolveFontStack } from './fonts'

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 48

const PREVIEW_TEXT = '❯ ls -la 中文测试 AaBbC 0123'
// 用转义字面量表示 Nerd Font 私用区字形（powerline / 图标），避免源码出现不可见字符
const PREVIEW_GLYPHS = '\ue0b0\ue0b2 \uf015 \uf07b \u250c\u2500\u252c\u2500\u2510 \u2514\u2500\u2534\u2500\u2518'

const NAV_ITEMS = [
  { key: 'appearance', label: '外观' },
  { key: 'terminal', label: '终端' },
  { key: 'plugins', label: '插件' }
] as const

type SectionKey = (typeof NAV_ITEMS)[number]['key']

interface Props {
  settings: AppSettings
  profiles: Profile[]
  // 可选配色方案（App 持有，内建 + themes 目录自定义；设置页打开时 App 会重扫）
  themes: ThemeDef[]
  // 插件信息（App 持有，含禁用态与权限决策状态），插件节的展示数据源
  pluginInfos: PluginInfo[]
  // 插件节动作（禁用/重批权限）后的回流刷新（= App 的 refreshProfiles：重拉
  // profiles+plugins 并重挂/拆除代码帧）
  onPluginsChanged: () => void
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

/** 设置页（外观 → 主题/配色/字体/字号；终端 → 默认终端；插件 → 管理），结构对齐 Windows Terminal，左侧导航便于后续扩展 */
export function SettingsPage({
  settings,
  profiles,
  themes,
  pluginInfos,
  onPluginsChanged,
  onChange,
  onClose
}: Props) {
  const [section, setSection] = useState<SectionKey>('appearance')
  const [fonts, setFonts] = useState<string[]>([])
  const [sizeDraft, setSizeDraft] = useState(String(settings.fontSize))
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void api.listFonts().then((list) => {
      if (alive) setFonts(list)
    })
    return () => {
      alive = false
    }
  }, [])

  // 抢占焦点：否则焦点仍在 xterm 的 textarea，设置页打开时键盘输入会漏进 shell
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(() => {
    setSizeDraft(String(settings.fontSize))
  }, [settings.fontSize])

  const commitSize = () => {
    if (!sizeDraft.trim()) {
      setSizeDraft(String(settings.fontSize))
      return
    }
    const n = Math.round(Number(sizeDraft))
    const next = Number.isFinite(n)
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n))
      : settings.fontSize
    setSizeDraft(String(next))
    if (next !== settings.fontSize) onChange({ fontSize: next })
  }

  // 手改 settings.json 指定了未安装/未枚举的字体时，保证已存值在下拉里可见而不是空白
  const fontOptions =
    settings.fontFamily && !fonts.includes(settings.fontFamily)
      ? [settings.fontFamily, ...fonts]
      : fonts

  const stepSize = (delta: number) => {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize + delta))
    if (next !== settings.fontSize) onChange({ fontSize: next })
  }

  // 未安装的 shell 不能选为默认（选了 + 也只会回退开菜单），置灰防误选；
  // 手改 settings.json 指向已删除的 profile 时，补一个同名项保证已存值可见
  const profileOptions =
    settings.defaultProfileId && !profiles.some((p) => p.id === settings.defaultProfileId)
      ? [{ id: settings.defaultProfileId, name: settings.defaultProfileId, available: false } as Profile, ...profiles]
      : profiles

  // 配色下拉按方案 type 过滤；存值指向已删除的主题文件时补一项占位（实际生效
  // 的是 pickScheme 的内建回退，占位只为让已存值可见不空白）
  const schemeOptions = (type: 'dark' | 'light', selected: string): ThemeDef[] => {
    const list = themes.filter((t) => t.type === type)
    return list.some((t) => t.id === selected)
      ? list
      : [{ id: selected, name: `${selected}（未找到，已回退内建）`, type, builtin: false }, ...list]
  }

  return (
    <div className="settings" ref={rootRef} tabIndex={-1}>
      <div className="settings-header">
        <span className="settings-title">设置</span>
        <button className="settings-close" onClick={onClose} title="关闭 (Esc)">
          ×
        </button>
      </div>
      <div className="settings-body">
        <nav className="settings-nav">
          {NAV_ITEMS.map((item) => (
            <div
              key={item.key}
              className={'settings-nav-item' + (section === item.key ? ' active' : '')}
              data-key={`nav-${item.key}`}
              onClick={() => setSection(item.key)}
            >
              {item.label}
            </div>
          ))}
        </nav>
        {section === 'appearance' && (
          <div className="settings-panel">
            <div className="settings-section">外观</div>
            <div className="settings-row">
              <label className="settings-label">主题</label>
              <select
                className="settings-select"
                value={settings.theme}
                onChange={(e) => onChange({ theme: e.target.value as AppSettings['theme'] })}
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </select>
              <span className="settings-hint">跟随系统时随系统深色模式自动切换</span>
            </div>
            {/* 两行配色选择必须排在「主题」select 之后：e2e 的 __e2eTheme 取
                面板里第一个 .settings-select，DOM 顺序即契约 */}
            <div className="settings-row">
              <label className="settings-label">深色配色</label>
              <select
                className="settings-select"
                data-setting="darkTheme"
                value={settings.darkTheme}
                onChange={(e) => onChange({ darkTheme: e.target.value })}
              >
                {schemeOptions('dark', settings.darkTheme).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="settings-hint">深色模式（含系统深）时生效，自定义主题放 ~/.config/term-manager/themes/</span>
            </div>
            <div className="settings-row">
              <label className="settings-label">浅色配色</label>
              <select
                className="settings-select"
                data-setting="lightTheme"
                value={settings.lightTheme}
                onChange={(e) => onChange({ lightTheme: e.target.value })}
              >
                {schemeOptions('light', settings.lightTheme).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="settings-hint">浅色模式（含系统浅）时生效，方案未声明的字段继承内建</span>
            </div>
            <div className="settings-row">
              <label className="settings-label">字体</label>
              <select
                className="settings-select"
                value={settings.fontFamily}
                onChange={(e) => onChange({ fontFamily: e.target.value })}
              >
                <option value="">自动（Nerd Font 优先）</option>
                {fontOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <label className="settings-label">字号</label>
              <div className="stepper">
                <button
                  onClick={() => stepSize(-1)}
                  disabled={settings.fontSize <= FONT_SIZE_MIN}
                  title="减小"
                >
                  −
                </button>
                <input
                  type="number"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  value={sizeDraft}
                  onChange={(e) => setSizeDraft(e.target.value)}
                  onBlur={commitSize}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <button
                  onClick={() => stepSize(1)}
                  disabled={settings.fontSize >= FONT_SIZE_MAX}
                  title="增大"
                >
                  +
                </button>
              </div>
              <span className="settings-hint">
                像素（{FONT_SIZE_MIN}–{FONT_SIZE_MAX}）
              </span>
            </div>
            <div className="settings-row preview-row">
              <label className="settings-label">预览</label>
              <div
                className="preview"
                style={{
                  fontFamily: resolveFontStack(settings.fontFamily),
                  fontSize: settings.fontSize
                }}
              >
                <div>{PREVIEW_TEXT}</div>
                <div>{PREVIEW_GLYPHS}</div>
              </div>
            </div>
            <div className="settings-section">布局</div>
            <div className="settings-row">
              <label className="settings-label">分组侧栏</label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  data-setting="sidebarVisible"
                  checked={settings.sidebarVisible}
                  onChange={(e) => onChange({ sidebarVisible: e.target.checked })}
                />
                <span>左侧显示「组 → 标签」树形面板并隐藏顶部标签栏，适合大量标签时导航与管理</span>
              </label>
            </div>
            <div className="settings-row">
              <span className="settings-hint">
                随时可用 Ctrl+Shift+B 或标签栏左缘按钮切换，开关状态跨重启保留
              </span>
            </div>
          </div>
        )}
        {section === 'terminal' && (
          <div className="settings-panel">
            <div className="settings-section">默认终端</div>
            <div className="settings-row">
              <label className="settings-label">默认终端</label>
              <select
                className="settings-select"
                value={settings.defaultProfileId}
                onChange={(e) => onChange({ defaultProfileId: e.target.value })}
              >
                <option value="">未设置</option>
                {profileOptions.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.available === false}>
                    {p.name}
                    {p.available === false ? '（未安装）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <span className="settings-hint">
                设置后点击 + 直接以此新建标签页，+ 旁的箭头仍可选择其他 shell；未设置时 + 打开菜单
              </span>
            </div>
            <div className="settings-section">组内广播</div>
            <div className="settings-row">
              <label className="settings-label">广播输入到全组</label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  data-setting="groupBroadcast"
                  checked={settings.groupBroadcast}
                  onChange={(e) => onChange({ groupBroadcast: e.target.checked })}
                />
                <span>开启后组头出现广播开关：广播中的组，任一标签的键盘输入（含粘贴）会同时发往组内全部终端</span>
              </label>
            </div>
            <div className="settings-row">
              <span className="settings-hint">
                广播态不跨退出保留（重启即复位）。多终端同步输入密码或删除类命令前请先确认键盘落点
              </span>
            </div>
            <div className="settings-section">渲染</div>
            <div className="settings-row">
              <label className="settings-label">GPU 渲染（WebGL）</label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  data-setting="gpuRendering"
                  checked={settings.gpuRendering}
                  onChange={(e) => onChange({ gpuRendering: e.target.checked })}
                />
                <span>终端用 WebGL 加速绘制，滚动与高频输出的流畅度更好；即时生效，无需重开标签</span>
              </label>
            </div>
            <div className="settings-row">
              <span className="settings-hint">
                不可用（驱动不支持/被禁用）或运行中图形上下文丢失时自动回退常规 DOM 渲染，功能不受影响；关闭则一律 DOM 渲染
              </span>
            </div>
            <div className="settings-section">会话</div>
            <div className="settings-row">
              <label className="settings-label">退出时保留会话</label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  data-setting="keepSessionOnExit"
                  checked={settings.keepSessionOnExit}
                  onChange={(e) => onChange({ keepSessionOnExit: e.target.checked })}
                />
                <span>关闭窗口后终端与正在运行的任务继续存活，下次启动自动恢复标签、固定/分组与屏幕内容</span>
              </label>
            </div>
            <div className="settings-row">
              <span className="settings-hint">
                关闭后可用 Ctrl+Shift+Q 一次性终结全部会话再退出
              </span>
            </div>
          </div>
        )}
        {section === 'plugins' && (
          <div className="settings-panel">
            <PluginManager infos={pluginInfos} onChanged={onPluginsChanged} />
          </div>
        )}
      </div>
    </div>
  )
}

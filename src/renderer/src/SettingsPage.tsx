import { useEffect, useRef, useState } from 'react'
import { api, type AppSettings } from './api'
import { resolveFontStack } from './fonts'

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 48

const PREVIEW_TEXT = '❯ ls -la 中文测试 AaBbC 0123'
// 用转义字面量表示 Nerd Font 私用区字形（powerline / 图标），避免源码出现不可见字符
const PREVIEW_GLYPHS = '\ue0b0\ue0b2 \uf015 \uf07b \u250c\u2500\u252c\u2500\u2510 \u2514\u2500\u2534\u2500\u2518'

interface Props {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

/** 设置页（一期：外观 → 字体 / 字号），结构对齐 Windows Terminal，左侧导航便于后续扩展 */
export function SettingsPage({ settings, onChange, onClose }: Props) {
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
          <div className="settings-nav-item active">外观</div>
        </nav>
        <div className="settings-panel">
          <div className="settings-section">外观</div>
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
        </div>
      </div>
    </div>
  )
}

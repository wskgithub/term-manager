// 插件面板壳（panel 型代码插件的可见宿主）：App 常驻渲染本组件——只要还有
// 面板帧就不卸载（卸载会连带销毁 iframe realm，插件状态全丢），开合只切换
// width 与可见性。React 只负责 header（面板切换器/关闭钮）与左缘拖宽把手；
// body div 的子节点（面板 iframe）由 pluginHost 命令式挂载，React 永不渲染
// 它的 children——两边互不践踏。
// 面板宽度是纯 UI 偏好，localStorage 持久化（不进 settings.json——它不属于
// 应用设置语义，且渲染层自闭环即可）。

import { useCallback, useRef, useState, type RefObject } from 'react'
import type { TmPanelEntry } from '../../shared/types'

interface Props {
  open: boolean
  panels: TmPanelEntry[]
  activePanelId: string | null
  bodyRef: RefObject<HTMLDivElement>
  onSelect(pluginId: string): void
  onClose(): void
}

const WIDTH_KEY = 'pluginPanelWidth'
const MIN_WIDTH = 260
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 380

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n))) : DEFAULT_WIDTH
}

export function PluginPanel({ open, panels, activePanelId, bodyRef, onSelect, onClose }: Props) {
  const [width, setWidth] = useState(loadWidth)
  const widthRef = useRef(width)
  widthRef.current = width
  const dragging = useRef(false)

  const beginResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // pointer capture：后续 move/up 全归把手元素，免挂 window 级监听
      e.currentTarget.setPointerCapture(e.pointerId)
      dragging.current = true
    },
    []
  )
  const moveResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    // 面板贴窗口右缘：宽度 = 视口右界 - 指针 x（把手在面板左缘）
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(window.innerWidth - e.clientX)))
    setWidth(next)
  }, [])
  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    localStorage.setItem(WIDTH_KEY, String(widthRef.current))
  }, [])

  // 常驻渲染（不因 panels 空而卸载）：pluginHost 挂帧时读 bodyRef，若此刻
  // 组件未挂载，帧会降级进隐藏容器且再无回迁时机——section 必须始终在 DOM。
  // 无面板插件时 header/body 为空，宽度归零零视觉足迹
  return (
    <section
      className={`plugin-panel${open && panels.length ? ' open' : ''}`}
      style={open && panels.length ? { width } : undefined}
      role="complementary"
      aria-label="插件面板"
      aria-hidden={!open || !panels.length}
    >
      <div
        className="plugin-panel-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
      />
      <header className="plugin-panel-header">
        <div className="plugin-panel-tabs">
          {panels.map((p) => (
            <button
              key={p.pluginId}
              type="button"
              className={`plugin-panel-tab${p.pluginId === activePanelId ? ' active' : ''}`}
              data-plugin={p.pluginId}
              onClick={() => onSelect(p.pluginId)}
              title={p.name}
            >
              {p.icon && <img src={`tmplug://${p.pluginId}/${p.icon}`} alt="" draggable={false} />}
              <span>{p.title}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="plugin-panel-close"
          title="关闭面板（Ctrl+Shift+G）"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {/* 帧容器：pluginHost 命令式管理子节点，React 不碰 */}
      <div className="plugin-panel-body" ref={bodyRef} />
    </section>
  )
}

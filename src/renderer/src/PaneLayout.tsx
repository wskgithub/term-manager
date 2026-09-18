import { useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import { api, type PaneGeom, type ThemeDef } from './api'
import { TermView } from './TermView'

// 分隔把手：垂直缝（col-resize）调缝隙右侧 pane 的宽度，水平缝调下侧 pane 的高度
interface Grip {
  key: string
  vertical: boolean
  paneId: string // 被调整的目标 pane（缝隙右侧/下侧）
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  tabId: string
  // 标签显隐（display 控制；隐藏时内部 pane 全部 0 尺寸，TermView 的 fit 守卫拦住）
  visible: boolean
  // 权威 pane 几何（term:panes 推送；未到达前兜底渲染单 pane 满铺）
  panes: PaneGeom[]
  activePaneId: string
  fontFamily: string
  fontSize: number
  scheme: ThemeDef
  gpu: boolean
  onTitle: (id: string, title: string) => void
  onTerminal: (id: string, t: Terminal | null) => void
  onSearchAddon: (id: string, addon: SearchAddon | null) => void
  onContextMenu: (x: number, y: number) => void
  onInput: (id: string, data: string) => void
  onCycleTab: (dir: 1 | -1) => void
  onCyclePane: (dir: 'left' | 'right' | 'up' | 'down') => void
  // 点击 pane（App 更新 activePanes 并同步 tmux 侧 active）
  onPaneFocus: (id: string) => void
  // Ctrl+Shift+Enter 放大/还原活跃 pane（透传给 TermView 的快捷键拦截）
  onZoomToggle: () => void
}

export function PaneLayout({
  tabId,
  visible,
  panes,
  activePaneId,
  fontFamily,
  fontSize,
  scheme,
  gpu,
  onTitle,
  onTerminal,
  onSearchAddon,
  onContextMenu,
  onInput,
  onCycleTab,
  onCyclePane,
  onPaneFocus,
  onZoomToggle
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  // cell 尺寸估算（TermView fit 后的容器像素 ÷ cols）：布局像素换算与 window
  // 总尺寸上报的公共基准；字体变化时经 metrics 自然刷新。同一终端字体下所有
  // pane 的 cell 一致，任一 pane 的上报都更新它
  const [cell, setCell] = useState<{ w: number; h: number } | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // 上次上报给 tmux 的 window 总尺寸：目标不变不重报（floor 的天然滞回之外，
  // 再挡住 cell 估算微抖）
  const reportedRef = useRef<{ cols: number; rows: number } | null>(null)
  // 把手拖拽态：起点像素 + 目标 pane 起始 cell 尺寸，松手换算成 delta cells
  const dragRef = useRef<{
    grip: Grip
    startX: number
    startY: number
    baseCols: number
    baseRows: number
  } | null>(null)
  const [dragLine, setDragLine] = useState<{ vertical: boolean; pos: number } | null>(null)
  const panesRef = useRef(panes)
  panesRef.current = panes

  // 容器尺寸（布局换算与 window 总尺寸上报的输入）
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // window 总尺寸上报：渲染层在此扮演 tmux client（唯一 resize-window 通路；
  // pane 几何全部听 server 的 %layout-change 推送）。cell/容器尺寸任一就绪
  // 变化都重算一次目标（防抖合并交给后端 resize 的 120ms 定时器）
  useEffect(() => {
    if (!cell || size.w <= 0 || size.h <= 0) return
    const cols = Math.floor(size.w / cell.w)
    const rows = Math.floor(size.h / cell.h)
    if (cols <= 0 || rows <= 0) return
    const prev = reportedRef.current
    if (prev && prev.cols === cols && prev.rows === rows) return
    reportedRef.current = { cols, rows }
    api.resize(tabId, cols, rows)
  }, [cell, size, tabId])

  // TermView 的 fit 实测上报 → cell 估算（容器像素 ÷ cols，略大于真实 cell，
  // 余量由布局的边缘对齐吃掉）。抖动过滤：<2% 视为取整噪声不更新（字体真实
  // 变化远大于此），否则会与 resize-window 的回推互相追逐
  const handleMetrics = (_id: string, cols: number, rows: number, cw: number, ch: number) => {
    if (cols > 0 && rows > 0 && cw > 0 && ch > 0) {
      const w = cw / cols
      const h = ch / rows
      setCell((prev) =>
        !prev || Math.abs(prev.w - w) / prev.w > 0.02 || Math.abs(prev.h - h) / prev.h > 0.02
          ? { w, h }
          : prev
      )
    }
  }

  // 布局换算：cell 已知用 cell 乘法（resize 回推后像素稳定），右/下边缘 pane
  // 对齐容器边界吃掉累计余量；未知（挂载首帧）按几何比例兜底
  const layout = useMemo(() => {
    const list: PaneGeom[] = panes.length
      ? panes
      : [{ id: tabId, x: 0, y: 0, cols: 0, rows: 0 }]
    if (list.length === 1 && (!cell || !size.w || !size.h || !list[0]!.cols)) {
      // 权威几何/cell 未就绪：单 pane 百分比满铺（fit 照常工作并驱动 cell 就绪）
      return {
        pct: true as const,
        boxes: [{ id: list[0]!.id }],
        rects: null as null | Map<string, { left: number; top: number; width: number; height: number }>,
        grips: [] as Grip[],
        zoomedId: null as string | null
      }
    }
    // 窗格放大态：被放大 pane 满铺整个容器（百分比，不经 cell 换算——tmux 侧
    // 它就是 window 总尺寸，与我们上报的容器尺寸同源）；其余 pane 保留挂载但
    // 隐藏（卸载会销毁 xterm 实例丢 buffer，退出放大要还原），fit 守卫拦住隐藏
    // 期间的拟合。把手不出现（无可见缝隙）
    const zm = list.find((p) => p.zoomed)
    if (zm) {
      const rects = new Map<string, { left: number; top: number; width: number; height: number }>()
      for (const p of list) {
        rects.set(
          p.id,
          p.id === zm.id ? { left: 0, top: 0, width: size.w, height: size.h } : { left: 0, top: 0, width: 0, height: 0 }
        )
      }
      return { pct: false as const, boxes: list, rects, grips: [] as Grip[], zoomedId: zm.id }
    }
    const W = Math.max(...list.map((p) => p.x + p.cols))
    const H = Math.max(...list.map((p) => p.y + p.rows))
    const rects = new Map<string, { left: number; top: number; width: number; height: number }>()
    for (const p of list) {
      let left: number
      let top: number
      let width: number
      let height: number
      if (cell && size.w && size.h) {
        left = Math.round(p.x * cell.w)
        top = Math.round(p.y * cell.h)
        width = (p.x + p.cols >= W ? size.w : Math.round((p.x + p.cols) * cell.w)) - left
        height = (p.y + p.rows >= H ? size.h : Math.round((p.y + p.rows) * cell.h)) - top
      } else {
        left = Math.round((p.x / W) * size.w)
        top = Math.round((p.y / H) * size.h)
        width = Math.round(((p.x + p.cols) / W) * size.w) - left
        height = Math.round(((p.y + p.rows) / H) * size.h) - top
      }
      rects.set(p.id, { left, top, width: Math.max(0, width), height: Math.max(0, height) })
    }
    // 把手推导：pane 左侧有 1-cell 缝（存在左邻 q.x+q.cols+1 === p.x）→ 垂直
    // 把手，拖动调整 p 自身宽度；上侧同理。把手段取 p 自己的行/列区间（tmux
    // 布局里与邻接缝至少覆盖 p 的区间，视觉总是合理）
    const grips: Grip[] = []
    if (cell && size.w && size.h) {
      for (const p of list) {
        const r = rects.get(p.id)!
        if (p.x > 0 && list.some((q) => q.x + q.cols + 1 === p.x)) {
          grips.push({
            key: `v:${p.id}`,
            vertical: true,
            paneId: p.id,
            x: Math.round((p.x - 1) * cell.w),
            y: r.top,
            w: Math.max(4, Math.round(cell.w)),
            h: r.height
          })
        }
        if (p.y > 0 && list.some((q) => q.y + q.rows + 1 === p.y)) {
          grips.push({
            key: `h:${p.id}`,
            vertical: false,
            paneId: p.id,
            x: r.left,
            y: Math.round((p.y - 1) * cell.h),
            w: r.width,
            h: Math.max(4, Math.round(cell.h))
          })
        }
      }
    }
    return { pct: false as const, boxes: list, rects, grips, zoomedId: null as string | null }
  }, [panes, cell, size, tabId])

  // 把手拖拽：pointer capture + window 级 move/up（合成事件与真实输入管线都
  // 可驱动）；拖拽中只显示指示线，松手一次性按 delta cells 落点（resize-pane
  // → %layout-change 权威刷新，不做乐观布局）
  const startDrag = (grip: Grip) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const pane = panesRef.current.find((p) => p.id === grip.paneId)
    if (!pane) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      grip,
      startX: e.clientX,
      startY: e.clientY,
      baseCols: pane.cols,
      baseRows: pane.rows
    }
    const host = hostRef.current
    const toLocal = (vertical: boolean, v: number) =>
      vertical ? v - (host?.getBoundingClientRect().left ?? 0) : v - (host?.getBoundingClientRect().top ?? 0)
    setDragLine({ vertical: grip.vertical, pos: toLocal(grip.vertical, grip.vertical ? e.clientX : e.clientY) })
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      setDragLine({ vertical: d.grip.vertical, pos: toLocal(d.grip.vertical, d.grip.vertical ? ev.clientX : ev.clientY) })
    }
    const stop = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      const d = dragRef.current
      dragRef.current = null
      setDragLine(null)
      if (!d) return
      const cur = panesRef.current.find((p) => p.id === d.grip.paneId)
      // cell 取拖拽启动时的渲染值（拖拽期间字体不会变）
      if (d.grip.vertical) {
        // 把手右移（dx>0）= 缝隙右移 = 目标 pane 收缩；另一维保持当前值不动
        api.resizePane(
          d.grip.paneId,
          d.baseCols - (cell ? Math.round((ev.clientX - d.startX) / cell.w) : 0),
          cur?.rows ?? d.baseRows
        )
      } else {
        api.resizePane(
          d.grip.paneId,
          cur?.cols ?? d.baseCols,
          d.baseRows - (cell ? Math.round((ev.clientY - d.startY) / cell.h) : 0)
        )
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return (
    <div
      className="tab-view"
      style={{ display: visible ? 'block' : 'none' }}
      data-tab-id={tabId}
      ref={hostRef}
    >
      {layout.pct
        ? layout.boxes.map((b) => (
            <div key={b.id} className="pane-box pct">
              <TermView
                termId={b.id}
                fontFamily={fontFamily}
                fontSize={fontSize}
                scheme={scheme}
                gpu={gpu}
                onTitle={(t) => onTitle(b.id, t)}
                onTerminal={onTerminal}
                onSearchAddon={onSearchAddon}
                onMetrics={handleMetrics}
                onContextMenu={onContextMenu}
                onInput={(d) => onInput(b.id, d)}
                onCycleTab={onCycleTab}
                onCyclePane={onCyclePane}
                onZoomToggle={onZoomToggle}
              />
            </div>
          ))
        : layout.boxes.map((p) => {
            const r = layout.rects!.get(p.id)!
            return (
              <div
                key={p.id}
                // 活跃边框只在多 pane 时点亮（单 pane 全幅边框是噪音）；zoom 态
                // 下被放大 pane 恒为活跃 pane，满幅边框正好充当「在放大中」的提示
                className={`pane-box${p.id === activePaneId && layout.boxes.length > 1 ? ' active' : ''}`}
                // zoom 态：非被放大的 pane 隐藏保活（见 layout 注释）
                style={{
                  display: layout.zoomedId && p.id !== layout.zoomedId ? 'none' : undefined,
                  left: r.left,
                  top: r.top,
                  width: r.width,
                  height: r.height
                }}
                data-pane-id={p.id}
                data-zoomed={p.zoomed ? '1' : undefined}
                onMouseDown={() => onPaneFocus(p.id)}
              >
                <TermView
                  termId={p.id}
                  fontFamily={fontFamily}
                  fontSize={fontSize}
                  scheme={scheme}
                  gpu={gpu}
                  onTitle={(t) => onTitle(p.id, t)}
                  onTerminal={onTerminal}
                  onSearchAddon={onSearchAddon}
                  onMetrics={handleMetrics}
                  onContextMenu={onContextMenu}
                  onInput={(d) => onInput(p.id, d)}
                  onCycleTab={onCycleTab}
                  onCyclePane={onCyclePane}
                  onZoomToggle={onZoomToggle}
                />
                {/* 放大指示徽标：zoom 满铺时 pane 边框被 xterm 画布盖住（分屏态
                    靠 pane 间缝隙露出活跃边框，满铺时三边无缝），需要一个明确的
                    「在放大中」提示与退出方式 */}
                {p.zoomed && (
                  <div className="pane-zoom-badge">已放大 · Ctrl+Shift+Enter 退出</div>
                )}
              </div>
            )
          })}
      {layout.grips.map((g) => (
        <div
          key={g.key}
          className={`pane-grip${g.vertical ? ' v' : ' h'}`}
          style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
          data-grip={g.vertical ? 'v' : 'h'}
          data-target={g.paneId}
          onPointerDown={startDrag(g)}
        />
      ))}
      {dragLine && (
        <div
          className={`pane-dragline${dragLine.vertical ? ' v' : ' h'}`}
          style={dragLine.vertical ? { left: dragLine.pos } : { top: dragLine.pos }}
        />
      )}
    </div>
  )
}

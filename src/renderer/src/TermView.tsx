import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from './api'
import { resolveFontStack } from './fonts'
import { xtermTheme } from './theme'

interface Props {
  termId: string
  active: boolean
  fontFamily: string
  fontSize: number
  // 创建实例时的深浅（决定初始调色板）；运行中切换由 App 的全局主题 effect 统一下发
  dark: boolean
  onTitle: (title: string) => void
  onTerminal: (id: string, t: Terminal | null) => void
  // 右键菜单由 App 统一渲染（自绘浮层），这里只上报光标坐标
  onContextMenu: (x: number, y: number) => void
  // Ctrl+Tab / Ctrl+Shift+Tab 循环切标签：焦点在终端内时必须由这里拦截
  //（Tab 族按键被 xterm 键位表认领，见下方 customKeyEventHandler 注释），
  // window 层监听收不到；焦点在终端外时走 App 的兜底通路
  onCycleTab: (dir: 1 | -1) => void
}

interface Thumb {
  top: number
  height: number
}

export function TermView({ termId, active, fontFamily, fontSize, dark, onTitle, onTerminal, onContextMenu, onCycleTab }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [thumb, setThumb] = useState<Thumb | null>(null)
  const rafRef = useRef(0)
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  // customKeyEventHandler 挂在 mount-once 的 effect 里，回调经 ref 拿最新闭包
  const cycleTabRef = useRef(onCycleTab)
  cycleTabRef.current = onCycleTab
  // 设置是异步加载的：建实例时用最新值，晚到的变化由下面的 effect 补齐
  const latest = useRef({ fontFamily, fontSize })
  latest.current = { fontFamily, fontSize }

  // 浮层滚动条：原生滚动条在 Linux/Chromium 下不能自定义外观（自绘样式不渲染），
  // 故隐藏原生滚动条，按 xterm 视口的 DOM 滚动几何自绘细圆角滑块（见 index.css）。
  // 用 DOM 滚动量而不是 buffer 行号：滚轮/拖拽/程序滚动都会更新它，且必然触发 scroll 事件
  const syncScrollbar = () => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const vp = viewportRef.current
      const el = ref.current
      if (!vp || !el) return
      const track = el.clientHeight
      const range = vp.scrollHeight - vp.clientHeight
      if (track === 0 || range < 2) {
        setThumb((t) => (t === null ? t : null))
        return
      }
      const height = Math.max(20, Math.round((vp.clientHeight / vp.scrollHeight) * track))
      const top = Math.round((vp.scrollTop / range) * (track - height))
      setThumb((t) => (t && t.top === top && t.height === height ? t : { top, height }))
    })
  }

  // 隐藏标签（display:none）尺寸为 0，FitAddon 会算出最小 2×1 并把 tmux 窗口缩掉，
  // 所以只在容器真实可见时才 fit + 上报尺寸
  const fitIfVisible = () => {
    const el = ref.current
    const term = termRef.current
    const fit = fitRef.current
    if (!el || !term || !fit) return
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fit.fit()
        api.resize(termId, term.cols, term.rows)
      } catch {
        // 尺寸无效时忽略
      }
    }
    syncScrollbar()
  }

  // 拖动滑块：指针位移映射为视口 scrollTop（与拖动原生滚动条等价，xterm 会同步 buffer）
  const dragThumb = (e: React.PointerEvent<HTMLDivElement>) => {
    const vp = viewportRef.current
    const el = ref.current
    if (!vp || !el || !thumb) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const travel = el.clientHeight - thumb.height
    const maxScroll = vp.scrollHeight - vp.clientHeight
    const startY = e.clientY
    const startTop = vp.scrollTop
    const onMove = (ev: PointerEvent) => {
      if (travel <= 0 || maxScroll <= 0) return
      const next = startTop + ((ev.clientY - startY) / travel) * maxScroll
      vp.scrollTop = Math.max(0, Math.min(maxScroll, next))
      syncScrollbar()
    }
    const stop = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  useEffect(() => {
    const term = new Terminal({
      fontFamily: resolveFontStack(latest.current.fontFamily),
      fontSize: latest.current.fontSize,
      cursorBlink: true,
      scrollback: 2000,
      theme: xtermTheme(dark)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    termRef.current = term
    fitRef.current = fit
    fitIfVisible()
    term.onTitleChange((t) => titleRef.current(t))
    // 用户键盘输入：xterm 行编辑产出 → 写回后端 PTY
    term.onData((d) => api.write(termId, d))
    // 键盘拦截都在 xterm 自身处理之前（customKeyEventHandler 返回 false 会直接
    // 跳过 xterm 的键位评估与 cancel，见 xterm Terminal._keyDown）：
    // 1) Ctrl+Tab / Ctrl+Shift+Tab 切标签——Tab 族在 xterm 键位表里被认领
    //    （result.cancel → cancel() = preventDefault + stopPropagation），window
    //    层监听收不到，还会把字面 \t / 反向 tab 发进 shell，必须在此拦截；
    //    返回 false 并不自动 preventDefault（xterm 丢弃返回值），须自己调
    // 2) 复制/粘贴：Ctrl+Shift+C/V 是 Linux 终端惯例（Ctrl+C 必须保持 SIGINT
    //    语义不能劫持）；Ctrl+Insert / Shift+Insert 是同义的传统键位
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.code === 'Tab') {
        // stopPropagation：App 在 window 层还有 Ctrl+Tab 兜底通路（焦点不在终端时用），
        // 不拦住会双触发——一次切换变两步
        ev.preventDefault()
        ev.stopPropagation()
        cycleTabRef.current(ev.shiftKey ? -1 : 1)
        return false
      }
      if (!ev.ctrlKey && !ev.shiftKey) return true
      const copy =
        (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyC') ||
        (ev.ctrlKey && !ev.shiftKey && ev.code === 'Insert')
      const paste =
        (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyV') ||
        (!ev.ctrlKey && ev.shiftKey && ev.code === 'Insert')
      if (copy) {
        if (term.hasSelection()) api.writeClipboard(term.getSelection())
        // xterm 对 customKeyEventHandler 返回 false 并不 preventDefault（_bindKeys 丢弃返回值），
        // 不拦的话 Chromium 会把 Ctrl+Shift+V/Shift+Insert 当原生粘贴再往 textarea 塞一份 → 双份
        ev.preventDefault()
        return false
      }
      if (paste) {
        void api.readClipboard().then((text) => {
          if (text) term.paste(text)
        })
        ev.preventDefault()
        return false
      }
      return true
    })
    // 滚动条跟随：新输出撑出 scrollback / 尺寸变化；滚动本身由视口 scroll 事件捕获
    term.onWriteParsed(syncScrollbar)
    term.onResize(syncScrollbar)
    const viewport = term.element?.querySelector<HTMLDivElement>('.xterm-viewport') ?? null
    viewportRef.current = viewport
    viewport?.addEventListener('scroll', syncScrollbar, { passive: true })
    // 输出由 App 单点分发；这里注册实例本身
    onTerminal(termId, term)

    const ro = new ResizeObserver(() => fitIfVisible())
    ro.observe(ref.current!)
    term.focus()

    return () => {
      ro.disconnect()
      viewport?.removeEventListener('scroll', syncScrollbar)
      viewportRef.current = null
      cancelAnimationFrame(rafRef.current)
      onTerminal(termId, null)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  // 字体/字号变化即时应用到已开终端；容器尺寸不变，ResizeObserver 不会触发，需显式 refit
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const stack = resolveFontStack(fontFamily)
    if (term.options.fontFamily !== stack) term.options.fontFamily = stack
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
    fitIfVisible()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, fontFamily, fontSize])

  return (
    <div
      className="term-pane"
      style={{ display: active ? 'block' : 'none' }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e.clientX, e.clientY)
      }}
    >
      <div className="term-mount" ref={ref} />
      {thumb && (
        <div className="term-scrollbar">
          <div
            className="term-scrollbar-thumb"
            style={{ top: thumb.top, height: thumb.height }}
            onPointerDown={dragThumb}
          />
        </div>
      )}
    </div>
  )
}

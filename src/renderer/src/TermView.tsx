import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { api, type ThemeDef } from './api'
import { resolveFontStack } from './fonts'

interface Props {
  termId: string
  fontFamily: string
  fontSize: number
  // 创建实例时的生效配色方案（决定初始调色板，已与内建合并成完整 22 键）；
  // 运行中切换由 App 的全局主题 effect 统一下发，这里不订阅
  scheme: ThemeDef
  // GPU 渲染开关（设置页「渲染」节）：开=尝试 WebGL 渲染器，失败/上下文丢失
  // 自动回退 DOM 渲染器；关=DOM。变化即时生效，不重建终端实例
  gpu: boolean
  onTitle: (title: string) => void
  onTerminal: (id: string, t: Terminal | null) => void
  // 搜索 addon 实例上交 App（镜像 onTerminal 惯例）：App 的查找框经它对
  // 对应终端执行 findNext/clearDecorations；term.dispose() 会连带释放 addon
  onSearchAddon: (id: string, addon: SearchAddon | null) => void
  // fit 后的实测尺寸（termId, cols, rows, 容器像素宽高）：PaneLayout 用它估算
  // cell 尺寸做布局换算与 window 总尺寸上报。pane 几何的权威在 tmux server，
  // TermView 自身不再向 tmux 上报 resize
  onMetrics: (id: string, cols: number, rows: number, cw: number, ch: number) => void
  // 右键菜单由 App 统一渲染（自绘浮层），这里只上报光标坐标
  onContextMenu: (x: number, y: number) => void
  // 键盘输入上交 App 路由：所属组开启广播时 App 会把同一段输入发往全组
  //（渲染层持有权威的标签/分组实时态，比主进程 debounce 后的 sync 快照可靠）
  onInput: (data: string) => void
  // Ctrl+Tab / Ctrl+Shift+Tab 循环切标签：焦点在终端内时必须由这里拦截
  //（Tab 族按键被 xterm 键位表认领，见下方 customKeyEventHandler 注释），
  // window 层监听收不到；焦点在终端外时走 App 的兜底通路
  onCycleTab: (dir: 1 | -1) => void
  // Ctrl+Alt+方向键在 pane 间导航：同 Ctrl+Tab 的双通路模式（xterm 键位表认领
  // Ctrl+Alt+方向序列，window 层收不到），App 侧单 pane 时无动作
  onCyclePane: (dir: 'left' | 'right' | 'up' | 'down') => void
  // Ctrl+Shift+Enter 放大/还原当前 pane：Enter 族被 xterm 键位表认领
  //（Ctrl+Enter 映射 \n 且 cancel，window 层收不到），同上双通路模式
  onZoomToggle: () => void
}

interface Thumb {
  top: number
  height: number
}

export function TermView({ termId, fontFamily, fontSize, scheme, gpu, onTitle, onTerminal, onSearchAddon, onMetrics, onContextMenu, onInput, onCycleTab, onCyclePane, onZoomToggle }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [thumb, setThumb] = useState<Thumb | null>(null)
  const rafRef = useRef(0)
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  // customKeyEventHandler 挂在 mount-once 的 effect 里，回调经 ref 拿最新闭包
  const cycleTabRef = useRef(onCycleTab)
  cycleTabRef.current = onCycleTab
  const cyclePaneRef = useRef(onCyclePane)
  cyclePaneRef.current = onCyclePane
  const zoomToggleRef = useRef(onZoomToggle)
  zoomToggleRef.current = onZoomToggle
  // onMetrics 同理：PaneLayout 的 cell 估算要拿到最新回调
  const metricsRef = useRef(onMetrics)
  metricsRef.current = onMetrics
  // onData 同理：广播路由依赖 App 的实时分组态，必须每次按键都拿到最新闭包
  const inputRef = useRef(onInput)
  inputRef.current = onInput
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

  // 隐藏标签（display:none）尺寸为 0，FitAddon 会算出最小 2×1，所以只在容器
  // 真实可见时才 fit。pane 几何的权威在 tmux server（%layout-change →
  // term:panes 推送），这里只做像素适配并把实测尺寸上报给 PaneLayout 换算
  const fitIfVisible = () => {
    const el = ref.current
    const term = termRef.current
    const fit = fitRef.current
    if (!el || !term || !fit) return
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fit.fit()
        metricsRef.current(termId, term.cols, term.rows, el.clientWidth, el.clientHeight)
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
      // 搜索高亮（addon-search 装饰）依赖提案期 API（registerDecoration），必须
      // 显式开启；xterm 实例只在自研代码内使用（插件永不接触），无暴露面
      allowProposedApi: true,
      theme: scheme.terminal
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    termRef.current = term
    fitRef.current = fit
    fitIfVisible()
    term.onTitleChange((t) => titleRef.current(t))
    // 用户键盘输入：xterm 行编辑产出 → 交 App 路由（广播组内复制到全组）
    term.onData((d) => inputRef.current(d))
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
      // Ctrl+Alt+方向键 pane 导航：同 Tab 族的拦截模式（xterm 键位表认领
      // Ctrl+Alt+方向产生的修饰序列并 cancel，window 层收不到）。该组合在裸
      // shell/readline/tmux 默认绑定里均无操作，吞掉无副作用；App 侧单 pane
      // 时不动作。key/code/keyCode 三路判：合成输入（sendInputEvent）可能
      // 不生成 key/code 文本，DOM keyCode（37-40）恒有
      if (ev.ctrlKey && ev.altKey && !ev.shiftKey && !ev.metaKey) {
        const dir =
          ev.code === 'ArrowLeft' || ev.key === 'ArrowLeft' || ev.keyCode === 37
            ? 'left'
            : ev.code === 'ArrowRight' || ev.key === 'ArrowRight' || ev.keyCode === 39
              ? 'right'
              : ev.code === 'ArrowUp' || ev.key === 'ArrowUp' || ev.keyCode === 38
                ? 'up'
                : ev.code === 'ArrowDown' || ev.key === 'ArrowDown' || ev.keyCode === 40
                  ? 'down'
                  : ''
        if (dir) {
          ev.preventDefault()
          ev.stopPropagation()
          cyclePaneRef.current(dir)
          return false
        }
      }
      // Ctrl+Shift+Q 退出并终结会话：Ctrl+Q 在 xterm 键位表被认领（^Q/XON，
      // cancel 掉且 window 层收不到），同样须在此拦截并阻断 App 兜底通路
      if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyQ') {
        ev.preventDefault()
        ev.stopPropagation()
        api.quitAll()
        return false
      }
      // Ctrl+Shift+Enter 放大/还原当前 pane：Enter 在 xterm 键位表被认领
      //（Ctrl+Enter 映射 \n 且 cancel），window 层兜底收不到，须在此拦截；
      // stopPropagation 防与 App 的 window 层兜底双触发。裸 Ctrl+Enter（无
      // Shift）不在拦截范围，shell 侧的自定义绑定原样直达
      if (
        ev.ctrlKey &&
        ev.shiftKey &&
        !ev.altKey &&
        !ev.metaKey &&
        (ev.key === 'Enter' || ev.code === 'Enter')
      ) {
        ev.preventDefault()
        ev.stopPropagation()
        zoomToggleRef.current()
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
    // 搜索 addon（Ctrl+Shift+F 查找框的数据面）：与终端同生命周期，一并上报
    const search = new SearchAddon()
    term.loadAddon(search)
    onSearchAddon(termId, search)

    const ro = new ResizeObserver(() => fitIfVisible())
    ro.observe(ref.current!)
    term.focus()

    return () => {
      ro.disconnect()
      viewport?.removeEventListener('scroll', syncScrollbar)
      viewportRef.current = null
      cancelAnimationFrame(rafRef.current)
      onTerminal(termId, null)
      onSearchAddon(termId, null)
      termRef.current = null
      fitRef.current = null
      // term.dispose() 会连带释放已挂的 WebGL addon，这里置空 ref 防二次 dispose
      webglRef.current = null
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

  // GPU 渲染（同字体 effect 模式：改 addon 不重建 Terminal，开关即时生效）：
  // 开 = 尝试 WebGL 渲染器（必须在 term.open 之后 load，本 effect 声明在挂载
  // effect 之后、同批执行，顺序天然满足）；创建抛错（驱动不支持/被开关禁用）
  // 静默保持 DOM 渲染器。上下文丢失回调里弃用 addon 即回退 DOM——浏览器对
  // WebGL 上下文数有上限（约 16），标签开满超额时最旧上下文被逐出，靠这条
  // 路径自动降级，自愈不崩溃。卸载时挂载 effect 的 term.dispose() 会连带释放
  // addon，这里再置空 ref 兜底
  useEffect(() => {
    const term = termRef.current
    if (!term || !gpu) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        if (webglRef.current === addon) webglRef.current = null
      })
      term.loadAddon(addon)
      webglRef.current = addon
    } catch {
      // WebGL 不可用：xterm 保留 DOM 渲染器，输入输出路径不受影响。但 addon 的
      // 渲染层 canvas（xterm-link-layer 等）在创建 WebGL 上下文之前就已插进
      // DOM，构造抛错后无人回收——每次重试都会再插一层，这里整体清扫
      //（DOM 渲染器本身只用 div/span，元素内出现 canvas 必属半途而废的 addon）
      term.element?.querySelectorAll('canvas').forEach((c) => c.remove())
    }
    return () => {
      webglRef.current?.dispose()
      webglRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, gpu])

  return (
    // 显隐由外层 .pane-box / .tab-view 的 display 控制（分屏后「标签可见」与
    // 「pane 布局」是两个维度，TermView 不再自管 display）
    <div
      className="term-pane"
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

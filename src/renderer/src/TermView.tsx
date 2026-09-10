import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from './api'
import { resolveFontStack } from './fonts'

interface Props {
  termId: string
  active: boolean
  fontFamily: string
  fontSize: number
  onTitle: (title: string) => void
  onTerminal: (id: string, t: Terminal | null) => void
}

export function TermView({ termId, active, fontFamily, fontSize, onTitle, onTerminal }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  // 设置是异步加载的：建实例时用最新值，晚到的变化由下面的 effect 补齐
  const latest = useRef({ fontFamily, fontSize })
  latest.current = { fontFamily, fontSize }

  // 隐藏标签（display:none）尺寸为 0，FitAddon 会算出最小 2×1 并把 tmux 窗口缩掉，
  // 所以只在容器真实可见时才 fit + 上报尺寸
  const fitIfVisible = () => {
    const el = ref.current
    const term = termRef.current
    const fit = fitRef.current
    if (!el || !term || !fit) return
    if (el.clientWidth === 0 || el.clientHeight === 0) return
    try {
      fit.fit()
      api.resize(termId, term.cols, term.rows)
    } catch {
      // 尺寸无效时忽略
    }
  }

  useEffect(() => {
    const term = new Terminal({
      fontFamily: resolveFontStack(latest.current.fontFamily),
      fontSize: latest.current.fontSize,
      cursorBlink: true,
      scrollback: 2000,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' }
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
    // 输出由 App 单点分发；这里注册实例本身
    onTerminal(termId, term)

    const ro = new ResizeObserver(() => fitIfVisible())
    ro.observe(ref.current!)
    term.focus()

    return () => {
      ro.disconnect()
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

  return <div ref={ref} style={{ display: active ? 'block' : 'none', width: '100%', height: '100%' }} />
}

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from './api'

interface Props {
  termId: string
  active: boolean
  onTitle: (title: string) => void
  onTerminal: (id: string, t: Terminal | null) => void
}

export function TermView({ termId, active, onTitle, onTerminal }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 2000,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    try {
      fit.fit()
    } catch {
      // 隐藏标签页尺寸为 0 时跳过，激活时 ResizeObserver 会再次 fit
    }
    term.onTitleChange((t) => titleRef.current(t))
    // 用户键盘输入：xterm 行编辑产出 → 写回后端 PTY
    term.onData((d) => api.write(termId, d))
    // 输出由 App 单点分发；这里注册实例本身
    onTerminal(termId, term)

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        api.resize(termId, term.cols, term.rows)
      } catch {
        // 尺寸无效时忽略
      }
    })
    ro.observe(ref.current!)
    term.focus()

    return () => {
      ro.disconnect()
      onTerminal(termId, null)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  return <div ref={ref} style={{ display: active ? 'block' : 'none', width: '100%', height: '100%' }} />
}

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from './api'

interface Props {
  termId: string
  active: boolean
  onTitle: (title: string) => void
}

export function TermView({ termId, active, onTitle }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      cursorBlink: true,
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
    term.onData((d) => api.write(termId, d))
    term.onTitleChange(onTitle)

    const offData = api.onData((id, data) => {
      if (id === termId) term.write(data)
    })
    const offExit = api.onExit((id) => {
      if (id === termId) term.write('\r\n\x1b[90m[会话已退出，可关闭此标签]\x1b[0m\r\n')
    })

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
      offData()
      offExit()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  return (
    <div
      ref={ref}
      style={{ display: active ? 'block' : 'none', width: '100%', height: '100%' }}
    />
  )
}

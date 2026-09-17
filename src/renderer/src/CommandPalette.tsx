import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { filterCommands, type PaletteCommand, type PaletteEntry } from './palette'

interface Props {
  commands: PaletteCommand[]
  /** 二段改名的预填值（当前活跃标签标题） */
  activeTitle: string
  onClose: () => void
  onRename: (title: string) => void
}

const firstSelectable = (list: PaletteEntry[]): number => {
  const i = list.findIndex((e) => !e.cmd.disabled)
  return i < 0 ? 0 : i
}

/** 命中字符高亮：把 label 按命中下标拆成普通片段与 <b class="hl"> 片段 */
function highlight(label: string, hits: number[]): React.ReactNode {
  if (!hits.length) return label
  const set = new Set(hits)
  const out: React.ReactNode[] = []
  let buf = ''
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      out.push(<b key={i} className="hl">{label[i]}</b>)
    } else {
      buf += label[i]
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 命令面板（Ctrl+Shift+P）：VS Code 风格顶部居中浮层，portal 到 body 盖过
 * 全部内容。↑↓ 键盘导航跳过置灰项、Enter 执行、Esc 关闭（改名模式先返回命令
 * 模式）、点击外部关闭。执行任意命令后统一 onClose（App 负责归还终端焦点）。
 * 「重命名当前标签」不直接执行：面板切换到二段改名模式，Enter 提交新名。
 */
export function CommandPalette({ commands, activeTitle, onClose, onRename }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(() => firstSelectable(filterCommands(commands, '')))
  const [mode, setMode] = useState<'cmd' | 'rename'>('cmd')
  const [renameDraft, setRenameDraft] = useState('')

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query])
  // 列表缩短（过滤变化）时钳住选中下标
  const cur = Math.min(sel, Math.max(0, filtered.length - 1))

  // 查询变化重置选中到首个可选项
  useEffect(() => {
    setSel(firstSelectable(filterCommands(commands, query)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // 挂载与模式切换都把焦点收进输入框（改名模式全选便于直接覆盖）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (mode === 'rename') el.select()
  }, [mode])

  // 关闭通路（mount 一次，回调经 ref 取最新闭包——同 TermView cycleTabRef 模式）：
  // Esc 走 window 捕获层，焦点不在输入框（如刚点过滚动条）也能关；改名模式的
  // Esc 是「返回命令模式」而非关闭。pointerdown 点面板外部关闭（同 ContextMenu）
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const modeRef = useRef(mode)
  modeRef.current = mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (modeRef.current === 'rename') {
        setMode('cmd')
        setQuery('')
      } else {
        onCloseRef.current()
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry || entry.cmd.disabled) return
    if (entry.cmd.mode === 'rename') {
      setMode('rename')
      setRenameDraft(activeTitle)
      return
    }
    entry.cmd.action?.()
    onClose()
  }

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mode === 'rename') {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (renameDraft.trim()) onRename(renameDraft)
        onClose()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      setSel((c) => {
        const n = filtered.length
        if (!n) return c
        for (let step = 1; step <= n; step++) {
          const idx = (c + dir * step + n * step) % n
          if (!filtered[idx]!.cmd.disabled) return idx
        }
        return c
      })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(filtered[cur])
    }
  }

  return createPortal(
    <div ref={rootRef} className="palette">
      {mode === 'rename' && <div className="palette-mode">重命名标签 · Esc 返回</div>}
      <input
        ref={inputRef}
        className="palette-input"
        spellCheck={false}
        placeholder={mode === 'rename' ? '输入新的标签名，Enter 提交' : '输入命令名称…'}
        value={mode === 'rename' ? renameDraft : query}
        onChange={(e) => (mode === 'rename' ? setRenameDraft(e.target.value) : setQuery(e.target.value))}
        onKeyDown={onInputKey}
      />
      {mode === 'cmd' &&
        (filtered.length ? (
          <div className="palette-list">
            {filtered.map((entry, i) => {
              const c = entry.cmd
              return (
                <div
                  key={c.key}
                  data-key={c.key}
                  className={
                    'palette-item' +
                    (i === cur ? ' active' : '') +
                    (c.disabled ? ' disabled' : '') +
                    (c.danger ? ' danger' : '')
                  }
                  onMouseEnter={() => !c.disabled && setSel(i)}
                  onClick={() => run(entry)}
                >
                  {c.color && <span className="dot" style={{ background: c.color }} />}
                  <span className="pal-label">{highlight(c.label, entry.hits)}</span>
                  {c.hint && <span className="pal-hint">{c.hint}</span>}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="palette-empty">没有匹配的命令</div>
        ))}
    </div>,
    document.body
  )
}

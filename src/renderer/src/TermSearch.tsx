import { useEffect, useRef, useState } from 'react'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'

interface Props {
  // 当前活跃标签：查找框永远作用于它；标签切换时旧终端装饰清掉、新终端重跑
  activeId: string
  getAddon: (id: string) => SearchAddon | undefined
  // 深浅决定装饰配色组（装饰必须不透明 hex，不能读 CSS 变量）
  dark: boolean
  /** 查询词记忆（App 持有的 ref）：实时回写，重开预填——外部关闭路径
   *  （设置页/面板打开时 App 收起本框）不走 onClose，也能留住当前词 */
  queryMem: { current: string }
  /** 重开时预填的上次查询词 */
  initialQuery: string
  onClose: () => void
}

// 装饰配色：addon 要求 #RRGGBB 不透明格式（rgba 不生效），按深浅各一组——
// 数值为 accent 与终端底色（Mocha #1e1e2e / Latte #eff1f5）的混合（深色侧
// match≈30%、active≈65%，浅色侧更淡），与 CSS 变量视觉同源（.create-error
// 硬编码先例）。overview ruler 刻度刻意不启用：xterm 需设 overviewRulerWidth
// 才渲染该层，启用会让终端为刻度让出固定宽度、并与自绘滚动条槽（FitAddon
// 预留的 gutter）叠放冲突——两个字段是类型必填项，width 为 0 时为无害占位
const DECOR_DARK: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#3e4b6b',
  activeMatchBackground: '#6480b3',
  matchOverviewRuler: '#89b4fa',
  activeMatchColorOverviewRuler: '#fab387'
}
const DECOR_LIGHT: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#c9d5f5',
  activeMatchBackground: '#9bb9f5',
  matchOverviewRuler: '#1e66f5',
  activeMatchColorOverviewRuler: '#fe640b'
}

/**
 * 终端查找框（Ctrl+Shift+F）：搜索当前活跃终端的缓冲区（含 scrollback），
 * 全部匹配高亮 + i/n 计数 + Enter/Shift+Enter 前后跳转 + 大小写/全字/正则
 * 三开关。Cmd 面板同款交互惯例：Esc 走 window 捕获层（焦点不在输入框——
 * 如已点进终端——也能关）、卸载清装饰（App 负责归还终端焦点）。开关态
 * （incremental）下打字扩选不闪跳。装饰配色随深浅整体切换。
 */
export function TermSearch({ activeId, getAddon, dark, queryMem, initialQuery, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  // null = 无匹配或尚未出结果（空查询/无插件实例/非法正则）
  const [counter, setCounter] = useState<{ index: number; count: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 事件回调/effect 清理都拿最新值（TermView titleRef 同款直赋惯例）；查询词
  // 实时回写 App 的记忆 ref（渲染期赋值与 latest 同理，ref 可变无碍）
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  queryMem.current = query
  const queryRef = useRef(query)
  queryRef.current = query
  const latest = useRef({ caseSensitive, wholeWord, regex, dark, onClose })
  latest.current = { caseSensitive, wholeWord, regex, dark, onClose }

  /** 按当前开关组装 findNext/findPrevious 的参数（正则模式下全字开关不参与） */
  const searchOptions = (): ISearchOptions => {
    const s = latest.current
    return {
      caseSensitive: s.caseSensitive,
      wholeWord: s.regex ? false : s.wholeWord,
      regex: s.regex,
      decorations: s.dark ? DECOR_DARK : DECOR_LIGHT
    }
  }

  /** 执行一次搜索：refresh=增量重搜（打字/切标签），next/prev=跳转 */
  const run = (dir: 'next' | 'prev' | 'refresh') => {
    const addon = getAddon(activeIdRef.current)
    const query = queryRef.current
    if (!addon || !query) {
      try {
        addon?.clearDecorations()
      } catch {
        // 终端可能已销毁
      }
      setCounter(null)
      return
    }
    try {
      const opts = searchOptions()
      if (dir === 'refresh') opts.incremental = true
      if (dir === 'prev') addon.findPrevious(query, opts)
      else addon.findNext(query, opts)
    } catch {
      // 非法正则等：计数置空即可，不扰主流程
      setCounter(null)
    }
  }

  // 挂载抢焦点（预填词全选便于直接覆盖）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (initialQuery) el.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc 关闭走 window 捕获层：焦点在输入框、终端甚至别处都能关（palette 同款）；
  // 捕获层先于 xterm 的 textarea 键位评估执行，终端聚焦时 Esc 不会漏进 shell
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      latest.current.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 查询/开关/深浅变化 → 防抖重搜（高频打字不刷装饰）
  useEffect(() => {
    const t = setTimeout(() => run('refresh'), 150)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex, dark])

  // 计数来自活跃 addon 的结果事件（-1 表示超出高亮上限 1000，只显示总数）。
  // 必须声明在标签切换 effect 之前：切换时的 run('refresh') 同步触发该事件，
  // 顺序反了首次搜索会因监听未挂而丢计数
  useEffect(() => {
    const addon = getAddon(activeId)
    if (!addon) return
    const d = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setCounter(resultCount > 0 ? { index: resultIndex, count: resultCount } : null)
    })
    return () => d.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // 标签切换：旧终端的匹配装饰清掉（try/catch 容忍刚被销毁的实例），
  // 新终端重跑当前查询——计数经上面新挂的监听自然刷新
  const prevIdRef = useRef(activeId)
  useEffect(() => {
    if (prevIdRef.current === activeId) return
    const prev = prevIdRef.current
    prevIdRef.current = activeId
    try {
      getAddon(prev)?.clearDecorations()
    } catch {
      // 旧终端可能随标签关闭已销毁
    }
    run('refresh')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // 卸载（Esc/×/开设置/开面板）清掉当前终端的全部搜索装饰
  useEffect(() => {
    return () => {
      try {
        getAddon(activeIdRef.current)?.clearDecorations()
      } catch {
        // 终端可能已销毁
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      run(e.shiftKey ? 'prev' : 'next')
    } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') {
      // 搜索框已开着再按 Ctrl+Shift+F：全选输入便于覆盖。拦在输入框层并
      // stopPropagation，否则冒泡到 App 的 window 开关层会把框翻关
      e.preventDefault()
      e.stopPropagation()
      inputRef.current?.select()
    }
  }

  const counterText = counter
    ? counter.index >= 0
      ? `${counter.index + 1}/${counter.count}`
      : `${counter.count}+`
    : query
      ? '无匹配'
      : ''

  return (
    <div className="term-search">
      <input
        ref={inputRef}
        className="term-search-input"
        spellCheck={false}
        placeholder="查找终端缓冲区…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKey}
      />
      <span className="term-search-counter">{counterText}</span>
      <button
        type="button"
        className={'term-search-toggle' + (caseSensitive ? ' on' : '')}
        data-key="search-case"
        title="区分大小写"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button
        type="button"
        className={'term-search-toggle' + (wholeWord ? ' on' : '')}
        data-key="search-word"
        title={regex ? '正则模式下全字不参与' : '全字匹配'}
        disabled={regex}
        onClick={() => setWholeWord((v) => !v)}
      >
        全字
      </button>
      <button
        type="button"
        className={'term-search-toggle' + (regex ? ' on' : '')}
        data-key="search-regex"
        title="正则表达式"
        onClick={() => setRegex((v) => !v)}
      >
        .*
      </button>
      <button
        type="button"
        className="term-search-nav"
        data-key="search-prev"
        title="上一个 (Shift+Enter)"
        onClick={() => run('prev')}
      >
        ↑
      </button>
      <button
        type="button"
        className="term-search-nav"
        data-key="search-next"
        title="下一个 (Enter)"
        onClick={() => run('next')}
      >
        ↓
      </button>
      <button
        type="button"
        className="term-search-close"
        data-key="search-close"
        title="关闭 (Esc)"
        onClick={() => latest.current.onClose()}
      >
        ×
      </button>
    </div>
  )
}

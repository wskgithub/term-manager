import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: string
  shortcut?: string
  icon: ReactNode
  disabled?: boolean
  action: () => void
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** 复制/粘贴线性图标（lucide 风格，stroke 跟随文字颜色） */
export const CopyIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

export const PasteIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </svg>
)

/**
 * 终端右键菜单：portal 到 body 的自绘浮层。
 * 弹出前用 useLayoutEffect 量自身尺寸并钳到视口内（贴边时向反方向翻转），
 * 首帧就在最终位置，不闪跳。关闭途径：点击外部 / Escape / 滚轮 / 窗口失焦、缩放。
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y, flipX: false, flipY: false })
  // 键盘高亮项：默认落在首个可用项上
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((i) => !i.disabled)))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const m = 8
    let nx = x
    let ny = y
    let flipX = false
    let flipY = false
    if (x + r.width + m > window.innerWidth) {
      nx = x - r.width
      flipX = true
    }
    if (y + r.height + m > window.innerHeight) {
      ny = y - r.height
      flipY = true
    }
    nx = Math.max(m, Math.min(nx, window.innerWidth - r.width - m))
    ny = Math.max(m, Math.min(ny, window.innerHeight - r.height - m))
    setPos({ x: nx, y: ny, flipX, flipY })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onWheel = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        setActive((cur) => {
          for (let step = 1; step <= items.length; step++) {
            const idx = (cur + dir * step + items.length * step) % items.length
            if (!items[idx].disabled) return idx
          }
          return cur
        })
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        const item = items[active]
        if (item && !item.disabled) {
          item.action()
          onClose()
        }
        return
      }
      // 其余按键像原生菜单一样收起菜单，按键本身照常送达终端（不吞快速输入）
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, active, onClose])

  const origin = `${pos.flipY ? 'bottom' : 'top'} ${pos.flipX ? 'right' : 'left'}`

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y, transformOrigin: origin }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div
          key={item.key}
          className={
            'ctx-item' +
            (i === active ? ' active' : '') +
            (item.disabled ? ' disabled' : '')
          }
          onMouseEnter={() => setActive(i)}
          onClick={() => {
            if (item.disabled) return
            item.action()
            onClose()
          }}
        >
          <span className="ctx-icon">{item.icon}</span>
          <span className="ctx-label">{item.label}</span>
          {item.shortcut && <span className="ctx-kbd">{item.shortcut}</span>}
        </div>
      ))}
    </div>,
    document.body
  )
}

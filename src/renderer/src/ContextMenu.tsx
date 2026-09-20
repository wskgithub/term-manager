import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: string
  shortcut?: string
  icon?: ReactNode
  disabled?: boolean
  // 无 children 的普通项：动作执行后关闭菜单
  action?: () => void
  // 有 children 即父项：点击/Enter = 展开（再点收起），不关闭菜单、无 action
  children?: MenuEntry[]
}

/** 分隔线条目：不占键盘焦点，方向键/回车都会跳过 */
export interface MenuSep {
  key: string
  sep: true
}

export type MenuEntry = MenuItem | MenuSep

// 可选中 = 非分隔线且未禁用（键盘导航与回车的判定基准）
function selectable(e: MenuEntry): e is MenuItem {
  return !('sep' in e) && !e.disabled
}

interface Props {
  x: number
  y: number
  items: MenuEntry[]
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

/** 标签右键菜单用图标（lucide 风格，stroke 跟随文字颜色） */
export const PinIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </svg>
)

export const FolderPlusIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)

export const XIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export const PencilIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </svg>
)

/** 分屏菜单用图标（lucide 风格：外框 + 中缝线，横竖各一） */
export const SplitHIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 8v8" />
  </svg>
)

export const SplitVIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 12h8" />
  </svg>
)

/** 窗格放大用图标（lucide maximize-2 风格：对角双箭头向外撑满） */
export const MaximizeIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </svg>
)

/** 组广播开关用图标（lucide radio 风格：中点 + 两侧弧段） */
export const BroadcastIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="2" />
    <path d="M7.9 16.1a6 6 0 0 1 0-8.2" />
    <path d="M16.1 7.9a6 6 0 0 1 0 8.2" />
    <path d="M5 19a10 10 0 0 1 0-14" />
    <path d="M19 5a10 10 0 0 1 0 14" />
  </svg>
)

/** 下折箭头（组折叠指示/＋箭头共用；旋转态由外层 class 控制） */
export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** 设置入口齿轮（lucide settings 风格） */
export function GearIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

/** 左侧面板开关图标（lucide panel-left 风格：外框 + 左栏填充线） */
export function SidebarIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

/** 「启动 AI Agent」父项图标（lucide bot 风格：方头 + 双眼 + 天线） */
export const BotIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="9" width="14" height="10" rx="2" />
    <path d="M12 9V5" />
    <circle cx="12" cy="3.5" r="1" />
    <path d="M9.2 13.5h.01" />
    <path d="M14.8 13.5h.01" />
    <path d="M9.5 16.5h5" />
  </svg>
)

/**
 * 终端右键菜单：portal 到 body 的自绘浮层。
 * 弹出前用 useLayoutEffect 量自身尺寸并钳到视口内（贴边时向反方向翻转），
 * 首帧就在最终位置，不闪跳。关闭途径：点击外部 / Escape / 滚轮 / 窗口失焦、缩放。
 * 支持 children 二级子菜单：hover 或点击/Enter 展开（→ 键进入、←/Esc 返回），
 * 子菜单 portal 到 body、锚在父项右缘（右侧放不下翻到左侧），键盘导航与
 * 父层共用 window 捕获层的同一套 active/subActive 状态（菜单项不占真实焦点）。
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y, flipX: false, flipY: false })
  // 键盘高亮项：默认落在首个可用项上
  const [active, setActive] = useState(() => Math.max(0, items.findIndex(selectable)))
  // 子菜单状态：openSub = 展开中的父项 key；subAnchor = 打开瞬间的父项矩形
  //（定位锚）；subActive = 子菜单键盘高亮。hover 父项即开、移到其他顶层项即收，
  // 子菜单贴父项右缘（移动路径不经过兄弟项），无需关闭容差定时器
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [subAnchor, setSubAnchor] = useState<{ right: number; left: number; top: number } | null>(null)
  const [subActive, setSubActive] = useState(0)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })
  const subRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())

  const parentItem = openSub
    ? items.find((i): i is MenuItem => !('sep' in i) && i.key === openSub)
    : undefined
  const subItems: MenuEntry[] = parentItem?.children ?? []

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

  // 子菜单钳位：右侧放不下整宽翻到父项左侧，底部溢出上移（与主菜单同语义）
  useLayoutEffect(() => {
    const el = subRef.current
    if (!el || !subAnchor) return
    const r = el.getBoundingClientRect()
    const m = 8
    let nx = subAnchor.right + 2
    if (nx + r.width + m > window.innerWidth) nx = Math.max(m, subAnchor.left - r.width - 2)
    const ny = Math.max(m, Math.min(subAnchor.top, window.innerHeight - r.height - m))
    setSubPos({ x: nx, y: ny })
  }, [subAnchor])

  // 展开子菜单：锚定父项矩形，键盘高亮重置到首个可用子项
  const openSubmenu = (item: MenuItem, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setSubAnchor({ right: r.right, left: r.left, top: r.top })
    setSubPos({ x: r.right + 2, y: r.top })
    setOpenSub(item.key)
    const children = item.children ?? []
    setSubActive(Math.max(0, children.findIndex(selectable)))
  }

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      // 主菜单与子菜单都在「菜单内」，点外部（两者之外）才关闭
      if (!ref.current?.contains(t) && !subRef.current?.contains(t)) onClose()
    }
    const onWheel = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        // 已开子菜单时首个 Escape 只收子菜单（菜单本体保留，再 Esc 才关）
        if (openSub) setOpenSub(null)
        else onClose()
        return
      }
      if (openSub) {
        // 子菜单持有键盘：上下导航/回车执行/左箭头返回父层
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          const dir = e.key === 'ArrowDown' ? 1 : -1
          setSubActive((cur) => {
            for (let step = 1; step <= subItems.length; step++) {
              const idx = (cur + dir * step + subItems.length * step) % subItems.length
              if (selectable(subItems[idx])) return idx
            }
            return cur
          })
          return
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          e.stopPropagation()
          setOpenSub(null)
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          const item = subItems[subActive]
          if (item && selectable(item)) {
            item.action?.()
            onClose()
          }
          return
        }
      } else {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          const dir = e.key === 'ArrowDown' ? 1 : -1
          setActive((cur) => {
            for (let step = 1; step <= items.length; step++) {
              const idx = (cur + dir * step + items.length * step) % items.length
              if (selectable(items[idx])) return idx
            }
            return cur
          })
          return
        }
        if (e.key === 'ArrowRight') {
          const item = items[active]
          if (item && selectable(item) && item.children?.length) {
            e.preventDefault()
            e.stopPropagation()
            const el = itemRefs.current.get(item.key)
            if (el) openSubmenu(item, el)
            return
          }
          // 非父项上的右箭头不拦：像原生菜单一样收起并送达终端
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          const item = items[active]
          if (item && selectable(item)) {
            if (item.children?.length) {
              const el = itemRefs.current.get(item.key)
              if (el) openSubmenu(item, el)
            } else {
              item.action?.()
              onClose()
            }
          }
          return
        }
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
  }, [items, active, onClose, openSub, subActive, subItems])

  const origin = `${pos.flipY ? 'bottom' : 'top'} ${pos.flipX ? 'right' : 'left'}`

  return createPortal(
    <>
      <div
        ref={ref}
        className="ctx-menu"
        style={{ left: pos.x, top: pos.y, transformOrigin: origin }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) =>
          'sep' in item ? (
            <div key={item.key} className="ctx-sep" />
          ) : (
            <div
              key={item.key}
              ref={(el) => {
                if (el) itemRefs.current.set(item.key, el)
                else itemRefs.current.delete(item.key)
              }}
              data-key={item.key}
              className={
                'ctx-item' +
                (i === active || openSub === item.key ? ' active' : '') +
                (item.disabled ? ' disabled' : '')
              }
              onMouseEnter={(e) => {
                setActive(i)
                if (item.children?.length) openSubmenu(item, e.currentTarget)
                else setOpenSub(null)
              }}
              onClick={(e) => {
                if (item.disabled) return
                if (item.children?.length) {
                  if (openSub === item.key) setOpenSub(null)
                  else openSubmenu(item, e.currentTarget)
                  return
                }
                item.action?.()
                onClose()
              }}
            >
              {item.icon !== undefined && <span className="ctx-icon">{item.icon}</span>}
              <span className="ctx-label">{item.label}</span>
              {item.children?.length ? (
                <span className="ctx-sub-arrow">
                  <ChevronIcon className="ctx-sub-chevron" />
                </span>
              ) : (
                item.shortcut && <span className="ctx-kbd">{item.shortcut}</span>
              )}
            </div>
          )
        )}
      </div>
      {openSub &&
        createPortal(
          <div
            ref={subRef}
            className="ctx-menu ctx-submenu"
            style={{ left: subPos.x, top: subPos.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {subItems.map((item, i) =>
              'sep' in item ? (
                <div key={item.key} className="ctx-sep" />
              ) : (
                <div
                  key={item.key}
                  data-key={item.key}
                  className={
                    'ctx-item' + (i === subActive ? ' active' : '') + (item.disabled ? ' disabled' : '')
                  }
                  onMouseEnter={() => setSubActive(i)}
                  onClick={() => {
                    if (item.disabled) return
                    item.action?.()
                    onClose()
                  }}
                >
                  {item.icon !== undefined && <span className="ctx-icon">{item.icon}</span>}
                  <span className="ctx-label">{item.label}</span>
                  {item.shortcut && <span className="ctx-kbd">{item.shortcut}</span>}
                </div>
              )
            )}
          </div>,
          document.body
        )}
    </>,
    document.body
  )
}

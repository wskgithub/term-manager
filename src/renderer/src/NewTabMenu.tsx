import { useEffect, useState } from 'react'
import { GearIcon } from './ContextMenu'
import type { Profile } from './api'

interface Props {
  profiles: Profile[]
  // 已校验可用的默认终端 profile id；空串 = 未设置（+ 即菜单开关）
  defaultProfileId: string
  onNewTab: (profileId: string) => void
  onOpenSettings: () => void
}

/** ＋新建下拉（自 TabBar 平移，标签栏与分组侧栏共用）：
    设置了默认终端时 + 为分体按钮——本体直接创建，箭头才开菜单；
    未设置时 + 仍是菜单开关。菜单含 profile 列表与设置入口 */
export function NewTabMenu({ profiles, defaultProfileId, onNewTab, onOpenSettings }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  // ＋下拉菜单的键盘/失焦关闭：此前只有 mouseLeave 一条关闭路径，
  // 键盘用户按 Esc 或切走窗口后菜单会悬着不关
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    const onBlur = () => setMenuOpen(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [menuOpen])
  const defaultProfile = defaultProfileId
    ? profiles.find((p) => p.id === defaultProfileId)
    : undefined

  return (
    <div className="newtab-split">
      <button
        className="newtab"
        onMouseDown={(e) => e.preventDefault()}
        title={defaultProfile ? `新建 ${defaultProfile.name} 终端` : '新建终端'}
        onClick={() => {
          if (defaultProfile) {
            onNewTab(defaultProfile.id)
            setMenuOpen(false)
          } else {
            setMenuOpen(!menuOpen)
          }
        }}
      >
        +
      </button>
      {defaultProfile && (
        <button
          className="newtab-caret"
          onMouseDown={(e) => e.preventDefault()}
          title="选择其他 shell"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <svg
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
        </button>
      )}
      {menuOpen && (
        <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
          {profiles.map((p) => (
            <div
              key={p.id}
              className={'menu-item' + (p.available === false ? ' disabled' : '')}
              title={p.available === false ? '本机未安装该 shell' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (p.available === false) return
                onNewTab(p.id)
                setMenuOpen(false)
              }}
            >
              <span className="dot" style={{ background: p.color ?? '#888' }} />
              {p.name}
              {p.id === defaultProfileId && <span className="menu-badge">默认</span>}
            </div>
          ))}
          {profiles.length === 0 && <div className="menu-item muted">加载中…</div>}
          <div className="menu-sep" />
          <div
            className="menu-item menu-settings"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setMenuOpen(false)
              onOpenSettings()
            }}
          >
            <span className="menu-icon">
              <GearIcon />
            </span>
            设置
            <span className="menu-kbd">Ctrl+,</span>
          </div>
        </div>
      )}
    </div>
  )
}

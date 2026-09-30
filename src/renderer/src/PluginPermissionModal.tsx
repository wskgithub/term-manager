// 代码级插件的权限批准弹窗（Tier 2）：插件 manifest 声明了 permissions
//（connect 的 origin 白名单与/或 fs 档位）且尚无有效决策时弹出。批准 = 声明
// 全集落盘主进程 plugin-permissions.json（合成宿主页 CSP 的 connect-src 与
// fs gate 才放行）；拒绝 = 插件照常加载但零网络、零文件访问。没有第三态
//（必须二选一）。队列逐个弹（App 传队首），决策后自动显示下一个。弹窗不夺
// 焦点也不截获全局按键（弹窗可能在用户输入中途出现，偷终端的键=静默授权或
// 无声丢输入）；键盘决策仅在焦点位于弹窗内时受理（见下方 effect）。

import { useEffect, useRef } from 'react'
import type { PluginPermPrompt } from './pluginHost'

interface Props {
  prompt: PluginPermPrompt
  onDecide: (allow: boolean) => void
}

// fs 档位的展示文案：与 docs/plugins.md 的权限词汇说明同口径
const FS_SCOPE_TEXT: Record<string, string> = {
  read: '读取文件系统（浏览目录、读取文件内容与图片预览）',
  write: '写入文件系统（新建/修改文件、重命名、移入回收站）'
}

export function PluginPermissionModal({ prompt, onDecide }: Props): JSX.Element {
  // 决策只允许一次：按钮点击后组件随即卸载，双击/回车连击由此兜底
  const decided = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const decide = (allow: boolean) => {
    if (decided.current) return
    decided.current = true
    onDecide(allow)
  }

  // 弹窗不夺焦点也不截获全局按键：权限弹窗可能在用户输入终端的中途弹出，
  // 若全局截获 Enter/Esc（或挂载即自持焦点），用户敲给 shell 的回车会被偷去
  // 当成「允许」静默授予文件系统权限（Esc 同理误拒）、敲键中途被夺焦点则
  // 后续输入无声丢失。键盘决策只在焦点已位于弹窗内时受理——点击按钮后焦点
  // 自然在弹窗内，Escape 此时视为拒绝（保守退出），Enter 交给浏览器原生的
  // 按钮激活（焦点在「允许」上按 Enter 才授权）；焦点在终端时按键原样直达
  // 终端
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const root = rootRef.current
      if (!root || !root.contains(document.activeElement)) return
      e.stopPropagation()
      decide(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={rootRef}
      className="perm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="插件权限请求">
      <div className="perm-card">
        <div className="perm-title">插件权限请求</div>
        <p className="perm-text">
          代码插件「<strong>{prompt.name}</strong>」声明了以下权限请求。批准后该插件即获得对应能力；
          拒绝则插件正常加载，但这些能力不可用：
        </p>
        {prompt.fs.length > 0 && (
          <ul className="perm-hosts">
            {prompt.fs.map((s) => (
              <li key={s}>{FS_SCOPE_TEXT[s] ?? s}</li>
            ))}
          </ul>
        )}
        {prompt.hosts.length > 0 && (
          <>
            <p className="perm-text">以及网络访问（仅限下列地址，其余地址仍被禁用）：</p>
            <ul className="perm-hosts">
              {prompt.hosts.map((h) => (
                <li key={h}>
                  <code>{h}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="perm-actions">
          <button className="perm-btn" data-key="perm-deny" onClick={() => decide(false)}>
            拒绝
          </button>
          <button className="perm-btn primary" data-key="perm-allow" onClick={() => decide(true)}>
            允许
          </button>
        </div>
      </div>
    </div>
  )
}

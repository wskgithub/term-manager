// 代码级插件的权限批准弹窗（Tier 2）：插件 manifest 声明了 permissions
//（connect 的 origin 白名单与/或 fs 档位）且尚无有效决策时弹出。批准 = 声明
// 全集落盘主进程 plugin-permissions.json（合成宿主页 CSP 的 connect-src 与
// fs gate 才放行）；拒绝 = 插件照常加载但零网络、零文件访问。没有第三态
//（必须二选一，Esc 视为拒绝——保守默认不放行）。队列逐个弹（App 传队首），
// 决策后自动显示下一个。

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
  const decide = (allow: boolean) => {
    if (decided.current) return
    decided.current = true
    onDecide(allow)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        decide(false)
      } else if (e.key === 'Enter') {
        e.stopPropagation()
        decide(true)
      }
    }
    // capture 阶段截住：别让底层的面板/设置页快捷键先消费掉
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="perm-overlay" role="dialog" aria-modal="true" aria-label="插件权限请求">
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

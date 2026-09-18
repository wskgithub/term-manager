import { useEffect, useState } from 'react'
import { api, type PluginInfo } from './api'

interface Props {
  infos: PluginInfo[]
  /** 动作（禁用/重批权限）后的回流刷新（= App 的 refreshProfiles：重拉数据并重挂/拆除代码帧） */
  onChanged: () => void
}

/**
 * 设置页「插件」节：已装插件卡片（禁用开关 + 权限展示与重新询问）+ 插件目录行。
 * 卸载语义保持文件夹模型（删除即卸载），这里不做删除按钮；权限重新决定复用
 * 全局批准弹窗（重新询问 = 清除决策，下次扫描弹框）
 */
export function PluginManager({ infos, onChanged }: Props) {
  const [dirPath, setDirPath] = useState('')

  // 插件目录路径只在挂载时取一次（userData 不会变）；openPluginsDir 的副作用
  // 是打开文件管理器，路径获取单独走 IPC 返回值，不在这里触发打开
  useEffect(() => {
    let alive = true
    void api.pluginsDirPath().then((p) => {
      if (alive) setDirPath(p)
    })
    return () => {
      alive = false
    }
  }, [])

  const setEnabled = (id: string, enabled: boolean) => {
    void api.setPluginEnabled(id, enabled).then(onChanged)
  }

  const resetPerm = (id: string) => {
    // 清除决策 → onChanged 重扫 → 未决策状态触发全局批准弹窗（压在设置页之上，
    // Esc=拒绝/Enter=允许），决策落盘后 App 会再回流刷新本节
    void api.resetPluginPermission(id).then(onChanged)
  }

  const openDir = () => {
    void api.openPluginsDir()
  }

  return (
    <>
      <div className="settings-section">已安装插件</div>
      {infos.length === 0 && (
        <div className="settings-row">
          <span className="settings-hint">
            未安装插件——把插件文件夹放进 {dirPath || '插件目录'}（下方可打开），
            打开命令面板或 + 菜单时自动加载
          </span>
        </div>
      )}
      {infos.map((p) => {
        const perm = p.entry && p.permissions?.connect?.length ? p.permDecision : undefined
        return (
          <div key={p.id} className="plugin-card" data-plugin={p.id}>
            <div className="plugin-card-head">
              <span className="plugin-name">{p.name}</span>
              {p.version && <span className="plugin-version">v{p.version}</span>}
              <span className="plugin-badge">{p.entry ? '代码级' : '声明式'}</span>
              {p.disabled && <span className="plugin-badge off">已禁用</span>}
              <label className="settings-checkbox plugin-enable" title={p.disabled ? '启用' : '禁用'}>
                <input
                  type="checkbox"
                  data-plugin-enable={p.id}
                  checked={!p.disabled}
                  onChange={(e) => setEnabled(p.id, e.target.checked)}
                />
                <span>启用</span>
              </label>
            </div>
            <div className="plugin-meta">
              id: {p.id}
              {p.disabled
                ? ' · 贡献已全部移除（代码帧与声明式 profile/命令/主题）'
                : ` · ${p.profiles.length} 个 profile · ${p.commands.length} 条命令 · ${p.themes.length} 个主题`}
            </div>
            {perm && (
              <div className="plugin-perm">
                <div className="plugin-perm-title">
                  网络权限（{perm.hosts.length} 项声明）
                  {perm.denied ? ' · 已拒绝' : !perm.decided ? ' · 未决策' : ''}
                </div>
                <div className="plugin-perm-list">
                  {perm.hosts.map((h) => (
                    <div key={h} className="plugin-perm-item">
                      <span className={'plugin-perm-state' + (perm.granted.includes(h) ? ' ok' : '')}>
                        {perm.granted.includes(h) ? '✓' : '·'}
                      </span>
                      <code>{h}</code>
                      <span className="plugin-perm-label">
                        {perm.granted.includes(h) ? '已授权' : '未授权'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="plugin-actions">
                  <button className="plugin-btn" data-key="plugin-reset-perm" onClick={() => resetPerm(p.id)}>
                    重新询问网络权限
                  </button>
                  <span className="settings-hint">
                    清除当前决策并重新弹批准框；拒绝后插件保持零网络
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
      <div className="settings-section">插件目录</div>
      <div className="settings-row">
        <span className="plugin-dir-path">{dirPath || '…'}</span>
        <button className="plugin-btn" data-key="plugin-open-dir" onClick={openDir}>
          打开目录
        </button>
      </div>
      <div className="settings-row">
        <span className="settings-hint">
          文件夹放进去即安装（打开命令面板 / + 菜单 / 设置页时自动重扫）；删除文件夹即卸载；
          改 manifest 版本号会让代码插件重新加载
        </span>
      </div>
    </>
  )
}

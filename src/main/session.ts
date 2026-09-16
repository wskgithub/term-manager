import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PersistedSession, SessionTab, TabGroup } from '../shared/types'

export type { PersistedSession, SessionTab, TabGroup } from '../shared/types'

const SESSION_VERSION = 1
// 校验上限：超过即视为坏数据整条丢弃，防止异常膨胀的配置拖垮启动
const MAX_TABS = 200
const MAX_GROUPS = 50
const TITLE_MAX = 200

function validId(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 100
}

function validTab(t: unknown): t is SessionTab {
  if (typeof t !== 'object' || t === null) return false
  const r = t as Record<string, unknown>
  if (!validId(r.id) || !validId(r.profileId)) return false
  if (typeof r.title !== 'string' || r.title.length > TITLE_MAX) return false
  if (!validId(r.windowId)) return false
  if (r.color !== undefined && typeof r.color !== 'string') return false
  if (r.pinned !== undefined && typeof r.pinned !== 'boolean') return false
  if (r.groupId !== undefined && !validId(r.groupId)) return false
  if (r.renamed !== undefined && typeof r.renamed !== 'boolean') return false
  return true
}

function validGroup(g: unknown): g is TabGroup {
  if (typeof g !== 'object' || g === null) return false
  const r = g as Record<string, unknown>
  if (!validId(r.id) || !validId(r.name) || !validId(r.color)) return false
  if (r.collapsed !== undefined && typeof r.collapsed !== 'boolean') return false
  return true
}

function validSession(raw: unknown): raw is PersistedSession {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  if (r.version !== SESSION_VERSION) return false
  if (!validId(r.socketName) || !validId(r.sessionName)) return false
  if (typeof r.ownerPid !== 'number' || !Number.isInteger(r.ownerPid) || r.ownerPid <= 0) return false
  if (typeof r.activeId !== 'string') return false
  if (!Array.isArray(r.tabs) || r.tabs.length > MAX_TABS) return false
  if (!Array.isArray(r.groups) || r.groups.length > MAX_GROUPS) return false
  return r.tabs.every(validTab) && r.groups.every(validGroup)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH = 进程确实死了；EPERM 等其它错误保守当作活着（与 sweepStaleServers 同策略）
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 会话持久化（userData/sessions.json）：退出保留会话时记录 tmux 服务器身份
 * 与标签元数据（含固定/分组/改名态），下次启动据此附着恢复。主进程是唯一写者：
 * 渲染层 session:sync 上报 UI 态、后端 create/kill 改变窗口集合时都会经 save() 落盘。
 */
export class SessionStore {
  private file = ''
  private session: PersistedSession | null = null

  load(): void {
    this.file = join(app.getPath('userData'), 'sessions.json')
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown
      if (!validSession(raw)) throw new Error('unexpected sessions.json structure')
      this.session = raw
    } catch (e) {
      console.error('[session] bad sessions.json, ignoring:', e)
      this.session = null
    }
  }

  get(): PersistedSession | null {
    return this.session
  }

  /**
   * 附着候选判定：有持久化记录、记录的属主进程已死（活进程 = 另一实例在管，
   * 单实例锁之外的双保险）、socket 名形如本应用私有命名（防外部文件名注入命令行）。
   */
  attachCandidate(): PersistedSession | null {
    const s = this.session
    if (!s) return null
    if (pidAlive(s.ownerPid)) return null
    if (!/^termmgr-\d+$/.test(s.socketName)) return null
    return s
  }

  /** 渲染层 UI 态上报后与后端窗口映射 join 落盘；tabs 为空时清空记录。 */
  update(patch: {
    socketName: string
    sessionName: string
    tabs: SessionTab[]
    groups: TabGroup[]
    activeId: string
  }): void {
    this.session = {
      version: SESSION_VERSION,
      ownerPid: process.pid,
      savedAt: new Date().toISOString(),
      ...patch
    }
    this.save()
  }

  clear(): void {
    this.session = null
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      if (!this.session) {
        writeFileSync(this.file, JSON.stringify({ version: SESSION_VERSION, tabs: [] }, null, 2))
        return
      }
      writeFileSync(this.file, JSON.stringify(this.session, null, 2))
    } catch (e) {
      console.error('[session] failed to write sessions.json:', e)
    }
  }
}

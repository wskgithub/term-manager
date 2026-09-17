import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// 代码级插件的网络权限决策存储（Tier 2）：userData/plugin-permissions.json。
// 形态 {version:1, grants:{'<插件id>':{declared:[...], connect:[...], denied?:true, decidedAt:iso}}}：
// - declared 是决策时的 manifest 声明快照——插件事后改声明，与当前声明集合
//   不一致即视为未决策，渲染层重新弹批准框（防"先申请无害域名、改 manifest
//   塞进新域名后静默沿用旧批准"）；
// - connect 是实际授权列表（合成宿主页 CSP 的 connect-src 取它与当前声明的
//   交集），denied=true 表示用户拒绝（connect 恒空）；
// - 只在变化时回写（沿用 profiles.json 的口径）。

// origin 白名单条目：scheme://host[:port]，http 仅放行本机回环（https 任意）
const CONNECT_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const MAX_ORIGIN_LEN = 200
// 单插件声明的 origin 条数上限（manifest 侧同值，见 plugins.ts）
export const MAX_PLUGIN_CONNECT = 8

export function validConnectOrigin(s: unknown): s is string {
  if (typeof s !== 'string' || !s || s.length > MAX_ORIGIN_LEN) return false
  if (!CONNECT_ORIGIN_RE.test(s)) return false
  if (s.startsWith('http://')) {
    const host = s.slice('http://'.length).split(':')[0]!
    return host === 'localhost' || host === '127.0.0.1'
  }
  return true
}

// 一次已落盘的决策
export interface PermDecision {
  /** 决策时的 manifest 声明快照（校验后的 origin 列表） */
  declared: string[]
  /** 实际授权的 origin 列表（拒绝时为空） */
  connect: string[]
  denied?: boolean
  decidedAt: string
}

interface GrantsFile {
  version: 1
  grants: Record<string, PermDecision>
}

// 存储内条目的清洗：文件可被手工编辑，坏条目丢弃（同 profiles.json 口径）
function cleanDecision(raw: unknown): PermDecision | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.declared) || !Array.isArray(r.connect)) return null
  const seen = new Set<string>()
  const declared: string[] = []
  for (const o of r.declared) {
    if (validConnectOrigin(o) && !seen.has(o)) {
      seen.add(o)
      declared.push(o)
    }
  }
  const connect: string[] = []
  for (const o of r.connect) {
    // 授权必须落在声明范围内（手工编辑塞进未声明的 origin 一律无效）
    if (validConnectOrigin(o) && declared.includes(o) && !connect.includes(o)) connect.push(o)
  }
  const d: PermDecision = { declared, connect, decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : '' }
  if (r.denied === true) d.denied = true
  return d
}

export class PluginPermStore {
  private file = ''
  private raw = ''
  private grants = new Map<string, PermDecision>()

  load(): void {
    this.file = join(app.getPath('userData'), 'plugin-permissions.json')
    this.raw = existsSync(this.file) ? readFileSync(this.file, 'utf-8') : ''
    this.grants.clear()
    if (this.raw) {
      try {
        const parsed = JSON.parse(this.raw) as GrantsFile
        if (parsed && typeof parsed === 'object' && parsed.grants && typeof parsed.grants === 'object') {
          for (const [id, d] of Object.entries(parsed.grants)) {
            const c = cleanDecision(d)
            if (c) this.grants.set(id, c)
            else console.error(`[plugin-perms] dropped malformed grant for '${id}'`)
          }
        }
      } catch (e) {
        console.error('[plugin-perms] bad plugin-permissions.json, starting empty:', e)
      }
    }
  }

  get(id: string): PermDecision | undefined {
    return this.grants.get(id)
  }

  /** 决策是否仍有效：存在且声明快照与当前声明集合一致（顺序无关；拒绝也算决策） */
  isDecided(id: string, declared: string[]): boolean {
    const d = this.grants.get(id)
    if (!d) return false
    return d.declared.length === declared.length && d.declared.every((o) => declared.includes(o))
  }

  /** 合成 CSP 用：已授权 ∩ 当前声明（授权永远不超出声明范围） */
  effectiveConnect(id: string, declared: string[]): string[] {
    const d = this.grants.get(id)
    if (!d || d.denied) return []
    return d.connect.filter((o) => declared.includes(o))
  }

  /** 落一次决策：connect=null 表示拒绝；授权列表由调用方保证 ⊆ declared */
  decide(id: string, declared: string[], connect: string[] | null): void {
    const decision: PermDecision = {
      declared: [...declared],
      connect: connect ? [...new Set(connect)].slice(0, MAX_PLUGIN_CONNECT) : [],
      decidedAt: new Date().toISOString()
    }
    if (connect === null) decision.denied = true
    this.grants.set(id, decision)
    this.save()
  }

  private serialize(): string {
    const out: GrantsFile = { version: 1, grants: Object.fromEntries(this.grants) }
    return JSON.stringify(out, null, 2)
  }

  private save(): void {
    const next = this.serialize()
    if (next === this.raw) return
    this.raw = next
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(this.file, next)
  }
}

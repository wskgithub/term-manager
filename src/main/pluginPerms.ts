import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PluginFsScope } from '../shared/types'

// 代码级插件的权限决策存储（Tier 2）：userData/plugin-permissions.json。
// 形态 {version:1, grants:{'<插件id>':{declared:[...], declaredFs:[...], connect:[...],
// fs:[...], denied?:true, decidedAt:iso}}}：
// - declared/declaredFs 是决策时的 manifest 声明快照——插件事后改声明（connect
//   加 origin、fs 加 write 档），与当前声明集合不一致即视为未决策，渲染层
//   重新弹批准框（防"先申请无害权限、改 manifest 塞进高危权限后静默沿用旧
//   批准"）；
// - connect/fs 是实际授权列表（CSP 与 fs gate 分别取它们与当前声明的交集），
//   denied=true 表示用户拒绝（两者恒空）；
// - 只在变化时回写（沿用 profiles.json 的口径）。
// 旧格式（无 declaredFs/fs 字段）按空数组清洗——对纯 connect 插件语义不变。

// origin 白名单条目：scheme://host[:port]，http 仅放行本机回环（https 任意）
const CONNECT_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const MAX_ORIGIN_LEN = 200
// 单插件声明的 origin 条数上限（manifest 侧同值，见 plugins.ts）
export const MAX_PLUGIN_CONNECT = 8

// fs 档位词汇与 PluginFsScope 同集，这里独立校验（清洗手工编辑的落盘文件）
function cleanFsScopes(raw: unknown): PluginFsScope[] {
  if (!Array.isArray(raw)) return []
  const out: PluginFsScope[] = []
  for (const s of raw) {
    if ((s === 'read' || s === 'write') && !out.includes(s)) out.push(s)
  }
  return out
}

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
  /** 决策时的 connect 声明快照（校验后的 origin 列表） */
  declared: string[]
  /** 决策时的 fs 声明快照（read/write 档位） */
  declaredFs: PluginFsScope[]
  /** 实际授权的 origin 列表（拒绝时为空） */
  connect: string[]
  /** 实际授权的 fs 档位（拒绝时为空） */
  fs: PluginFsScope[]
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
  const declaredFs = cleanFsScopes(r.declaredFs)
  const fs = cleanFsScopes(r.fs).filter((s) => declaredFs.includes(s))
  const d: PermDecision = {
    declared,
    declaredFs,
    connect,
    fs,
    decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : ''
  }
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

  /** 决策是否仍有效：connect 与 fs 两维声明快照均与当前声明一致（顺序无关；
   *  拒绝也算决策）。任一维漂移即回落未决策，重新弹批准框 */
  isDecided(id: string, declared: string[], declaredFs: PluginFsScope[]): boolean {
    const d = this.grants.get(id)
    if (!d) return false
    const connectOk =
      d.declared.length === declared.length && d.declared.every((o) => declared.includes(o))
    const fsOk =
      d.declaredFs.length === declaredFs.length && d.declaredFs.every((s) => declaredFs.includes(s))
    return connectOk && fsOk
  }

  /** 合成 CSP 用：已授权 ∩ 当前声明（授权永远不超出声明范围） */
  effectiveConnect(id: string, declared: string[]): string[] {
    const d = this.grants.get(id)
    if (!d || d.denied) return []
    return d.connect.filter((o) => declared.includes(o))
  }

  /** fs gate 用：已授权档位 ∩ 当前声明（拒绝/未决策恒空——写操作在主进程
   *  侧被拒，读操作同样不放行，保持权限模型的对称性） */
  effectiveFs(id: string, declaredFs: PluginFsScope[]): PluginFsScope[] {
    const d = this.grants.get(id)
    if (!d || d.denied) return []
    return d.fs.filter((s) => declaredFs.includes(s))
  }

  /** 落一次决策：allow=false 表示拒绝（connect/fs 全空）；允许 = 两维声明
   *  全集一次授予（弹窗二选一，无逐项勾选，与 connect 语义一致） */
  decide(id: string, declared: string[], declaredFs: PluginFsScope[], allow: boolean): void {
    const decision: PermDecision = {
      declared: [...declared],
      declaredFs: cleanFsScopes(declaredFs),
      connect: allow ? [...new Set(declared)].slice(0, MAX_PLUGIN_CONNECT) : [],
      fs: allow ? cleanFsScopes(declaredFs) : [],
      decidedAt: new Date().toISOString()
    }
    if (!allow) decision.denied = true
    this.grants.set(id, decision)
    this.save()
  }

  /** 清除决策（管理 UI 的「重新询问」）：回到未决策态，下次扫描重新弹批准框 */
  clear(id: string): void {
    if (!this.grants.has(id)) return
    this.grants.delete(id)
    this.save()
  }

  private serialize(): GrantsFile {
    return { version: 1, grants: Object.fromEntries(this.grants) }
  }

  private save(): void {
    const next = JSON.stringify(this.serialize(), null, 2)
    if (next === this.raw) return
    this.raw = next
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(this.file, next)
  }
}

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Profile } from '../shared/types'

export type { Profile } from '../shared/types'

// 一层 Shell 类型候选（类似 Windows Terminal 的下拉：bash/zsh/fish/…），
// 只列本机 PATH 里真实存在的。机器类连接（ssh 等）不再是内置分类，
// 用户可在 profiles.json 里自行追加任意 Profile。
const SHELL_CANDIDATES: Profile[] = [
  { id: 'bash', name: 'bash', command: 'bash', color: '#4fc3f7' },
  { id: 'zsh', name: 'zsh', command: 'zsh', color: '#aed581' },
  { id: 'fish', name: 'fish', command: 'fish', color: '#b39ddb' },
  { id: 'pwsh', name: 'pwsh', command: 'pwsh', color: '#64b5f6' },
  { id: 'docker-sh', name: 'Docker Shell', command: 'docker', args: ['run', '--rm', '-it', 'alpine', '/bin/sh'], color: '#ffcc80' }
]

// 配置文件版本：v2 起默认 profile 改为"shell 类型"。旧结构（v1 的
// 本机/SSH 机器分类）在重新生成默认值时被替换。
const CONFIG_VERSION = 2

interface ConfigFile {
  version: number
  profiles: Profile[]
}

function findOnPath(command: string): boolean {
  const path = process.env['PATH'] ?? ''
  for (const dir of path.split(':')) {
    if (dir && existsSync(join(dir, command))) return true
  }
  return false
}

// 用户登录 shell（$SHELL）排在最前，作为 "+" 菜单的第一项
function shellOrder(p: Profile): number {
  const login = process.env['SHELL']?.split('/').pop() ?? ''
  return p.command === login ? 0 : 1
}

// profiles.json 可被手工编辑：字段级形状校验，坏条目整条丢弃并告警，
// 而不是留到拼装 tmux 命令时才 TypeError（id/name 必填非空，可选字段类型不符即弃）
function validProfile(p: unknown): p is Profile {
  if (typeof p !== 'object' || p === null) return false
  const r = p as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return false
  if (typeof r.name !== 'string' || !r.name) return false
  if (r.command !== undefined && typeof r.command !== 'string') return false
  if (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === 'string')))
    return false
  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env)) return false
    for (const v of Object.values(r.env)) if (typeof v !== 'string') return false
  }
  if (r.cwd !== undefined && typeof r.cwd !== 'string') return false
  if (r.color !== undefined && typeof r.color !== 'string') return false
  if (r.available !== undefined && typeof r.available !== 'boolean') return false
  return true
}

function newDefaults(): ConfigFile {
  const candidates = [...SHELL_CANDIDATES].sort((a, b) => shellOrder(a) - shellOrder(b))
  const profiles = candidates.filter((p) => (p.command ? findOnPath(p.command) : true))
  if (!profiles.length) profiles.push(SHELL_CANDIDATES[0])
  return { version: CONFIG_VERSION, profiles }
}

export class ProfileRegistry {
  private profiles: Profile[] = []
  private file = ''
  // 最近一次落盘的内容：refresh 比对用，避免无变化时重写 profiles.json
  private raw = ''

  load(): void {
    this.file = join(app.getPath('userData'), 'profiles.json')
    this.raw = existsSync(this.file) ? readFileSync(this.file, 'utf-8') : ''
    this.profiles = this.readConfig(this.raw).profiles
    this.refresh()
  }

  /**
   * 重探可用性并补齐新装的内建 shell，启动与运行中（profiles:list 每次调用）
   * 共用同一条路径。newDefaults 只在首次生成时按 PATH 过滤候选，此后装上的
   * shell 靠这里的合并补回；已有条目以 profiles.json 为准（改名/改色不覆盖），
   * 只翻 available——代价是用户手工删掉某内建条目后 shell 仍在机上就会被加回
   * （内建 shell 类型语义是"自动列出"，自定义条目不受影响）。探测就是几个
   * existsSync，开销可忽略；落盘沿用「仅变化时回写」，不无谓刷 mtime。
   */
  refresh(): void {
    const known = new Set(this.profiles.map((p) => p.id))
    for (const c of SHELL_CANDIDATES) {
      if (!known.has(c.id) && c.command && findOnPath(c.command)) this.profiles.push({ ...c })
    }
    this.detectAvailability()
    const next = this.serialize()
    if (next !== this.raw) {
      this.raw = next
      this.save()
    }
  }

  private readConfig(raw: string): ConfigFile {
    if (!raw) return newDefaults()
    try {
      const parsed = JSON.parse(raw) as unknown
      // v1 结构是裸数组或无 version 的对象：视为过期，重新生成 shell 默认值
      if (Array.isArray(parsed) || !(parsed as ConfigFile).profiles) return newDefaults()
      const cfg = parsed as ConfigFile
      if (!Array.isArray(cfg.profiles) || !cfg.profiles.length) return newDefaults()
      const profiles = cfg.profiles.filter((p): p is Profile => {
        if (validProfile(p)) return true
        console.error('[profiles] dropped malformed profile entry:', JSON.stringify(p)?.slice(0, 200))
        return false
      })
      if (!profiles.length) return newDefaults()
      cfg.profiles = profiles
      return cfg
    } catch (e) {
      console.error('[profiles] bad profiles.json, falling back to defaults:', e)
      return newDefaults()
    }
  }

  private detectAvailability(): void {
    for (const p of this.profiles) {
      if (!p.command) {
        p.available = true
        continue
      }
      p.available = findOnPath(p.command)
    }
  }

  list(): Profile[] {
    return this.profiles
  }

  get(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  private serialize(): string {
    const cfg: ConfigFile = { version: CONFIG_VERSION, profiles: this.profiles }
    return JSON.stringify(cfg, null, 2)
  }

  private save(): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(this.file, this.serialize())
  }
}

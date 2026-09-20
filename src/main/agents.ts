// AI Agent CLI 注册表与自发现：参照 cc-switch 的「已知清单 + 逐个探测」模型，
// 但判定比它更严格——我们要真拉起进程，available 以「可执行文件可寻址」为准
//（cc-switch 只看配置目录存在）。注册表数据单源 src/shared/agents.json，
// Nautilus python 扩展读同一份文件的安装副本（fpm 拷贝，见 package.json）。
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import agentsData from '../shared/agents.json'
import type { AgentEntry, AppSettings, CustomAgent } from '../shared/types'

interface AgentDef {
  id: string
  name: string
  argv: string[]
  hintDirs: string[]
}

const REGISTRY = agentsData as { agents: AgentDef[]; extraBinDirs: string[] }

/** 单层通配匹配（'*' 在段内任意处，覆盖 nvm 版本目录这类形态；
    不支持跨段递归通配——extraBinDirs 不需要。Nautilus python 侧 glob 模块同语义 */
function segMatch(pattern: string, name: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === name
  let rest = name
  if (!rest.startsWith(parts[0]!)) return false
  rest = rest.slice(parts[0]!.length)
  for (let i = parts.length - 1; i > 0; i--) {
    const tail = parts[i]!
    if (i === 1) {
      if (!rest.endsWith(tail) || rest.length - tail.length < parts[0]!.length) return false
      // 中段 '*' 至少匹配 0 字符（多段 '*' 时此处按宽松处理，段形态够用）
      return true
    }
    const at = rest.lastIndexOf(tail)
    if (at < 0) return false
    rest = rest.slice(0, at)
  }
  return true
}

/** HOME 相对目录模式（可含 '*' 单段通配）展开为绝对目录列表 */
function expandHomeDirs(pattern: string): string[] {
  const segs = pattern.split('/').filter(Boolean)
  let dirs = [homedir()]
  for (const seg of segs) {
    const next: string[] = []
    for (const base of dirs) {
      if (seg.includes('*')) {
        let names: string[]
        try {
          names = readdirSync(base)
        } catch {
          continue
        }
        for (const n of names) if (segMatch(seg, n)) next.push(join(base, n))
      } else {
        const p = join(base, seg)
        if (existsSync(p)) next.push(p)
      }
    }
    if (!next.length) return []
    dirs = next
  }
  return dirs
}

/**
 * 在 $PATH 与常见全局 bin 目录里找可执行文件，命中返回绝对路径：
 * 启动一律用解析出的绝对路径，保证「菜单里看得到」和「点下去能起来」一致
 *（tmux server 继承主进程环境，PATH 盲区一致）。profiles.findOnPath
 * 只回布尔，这里要拿到路径，故自带一份同语义实现。argv[0] 含 '/' 时按
 * 相对/绝对路径直接探测（自定义 agent 允许写绝对路径）。extraBinDirs 支持
 * '*' 单段通配（nvm 版本目录随 Node 升级漂移，静态路径跟不上）
 */
function locateBin(cmd: string): string | null {
  if (!cmd) return null
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const p = join(dir, cmd)
    if (existsSync(p)) return p
  }
  for (const d of REGISTRY.extraBinDirs) {
    for (const dir of expandHomeDirs(d)) {
      const p = join(dir, cmd)
      if (existsSync(p)) return p
    }
  }
  return null
}

// 内置 + 自定义合并视图：自定义 id 撞内置时内置优先（id 是菜单 data-key 与
// hiddenAgents 的键，必须稳定指向内置语义）
function agentDefs(settings: AppSettings): Array<AgentDef & { builtIn: boolean }> {
  const builtin = REGISTRY.agents.map((a) => ({ ...a, builtIn: true }))
  const custom: Array<AgentDef & { builtIn: boolean }> = settings.customAgents.map(
    (c: CustomAgent) => ({ id: c.id, name: c.name, argv: c.argv, hintDirs: [], builtIn: false })
  )
  return [...builtin, ...custom.filter((c) => !builtin.some((b) => b.id === c.id))]
}

/** 全量条目（含未安装/被隐藏——过滤归渲染层菜单；设置页要展示全部）。
    排序：内置在前且其中有使用痕迹的靠前（注册表序为次序），自定义恒在内置后 */
export function listAgents(settings: AppSettings): AgentEntry[] {
  const builtin: AgentEntry[] = []
  const custom: AgentEntry[] = []
  for (const d of agentDefs(settings)) {
    const resolvedPath = locateBin(d.argv[0] ?? '')
    const entry: AgentEntry = {
      id: d.id,
      name: d.name,
      builtIn: d.builtIn,
      available: !!resolvedPath,
      resolvedPath,
      usedHint: d.hintDirs.some((h) => existsSync(join(homedir(), h)))
    }
    ;(d.builtIn ? builtin : custom).push(entry)
  }
  builtin.sort((a, b) => Number(b.usedHint) - Number(a.usedHint))
  return [...builtin, ...custom]
}

/** 解析待启动 agent：argv[0] 替换为绝对路径。找不到定义或可执行文件 → null
    （调用方回退开普通 shell 标签并发通知，不能让点击无声无效） */
export function resolveAgent(
  id: string,
  settings: AppSettings
): { name: string; argv: string[] } | null {
  const def = agentDefs(settings).find((d) => d.id === id)
  if (!def || !def.argv.length) return null
  const resolved = locateBin(def.argv[0])
  if (!resolved) return null
  return { name: def.name, argv: [resolved, ...def.argv.slice(1)] }
}

/** agent 显示名（找不到定义时回退 id）——回退通知等提示文案用 */
export function agentName(id: string, settings: AppSettings): string {
  return agentDefs(settings).find((d) => d.id === id)?.name ?? id
}

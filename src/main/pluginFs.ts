import { shell } from 'electron'
import { access, lstat, mkdir, readFile, readdir, readlink, rename, stat, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import type {
  FsBlobResult,
  FsEntry,
  FsEntryKind,
  FsListResult,
  FsStat,
  FsTextResult,
  PluginFsScope
} from '../shared/types'

// 插件 fs 通道的执行层（Tier 2 fs 权限的 gate 在这里收口）：渲染层只透传
// 「插件 id + 操作名 + 参数」，权限判定/路径防御/大小上限全部在本模块——
// 即使渲染层被攻破，也拿不到绕过权限词汇的文件访问面。所有操作走
// fs/promises（不阻塞主进程），删除只走回收站（shell.trashItem，可逆），
// 不提供真删。
//
// 权限语义：op→档位映射固定（read: list/stat/readText/readBase64；
// write: write/mkdir/rename/trash），实授权 = pluginPerms 的已决策 ∩ 当前
// manifest 声明（declaredFs），未声明/未决策/被拒一律 error。禁用插件
// （plugin-state.json）同样拒绝——帧虽已拆除，这里再兜一层。

export type FsOp =
  | 'list'
  | 'stat'
  | 'readText'
  | 'readBase64'
  | 'write'
  | 'mkdir'
  | 'rename'
  | 'trash'

const OP_SCOPE: Record<FsOp, PluginFsScope> = {
  list: 'read',
  stat: 'read',
  readText: 'read',
  readBase64: 'read',
  write: 'write',
  mkdir: 'write',
  rename: 'write',
  trash: 'write'
}

// 防御常量：单目录条数 / 文本与二进制读取上限 / 写入上限 / 路径长度
const MAX_ENTRIES = 20_000
const MAX_TEXT_BYTES = 2_000_000
const MAX_BLOB_BYTES = 8_000_000
const MAX_WRITE_BYTES = 1_000_000
const MAX_PATH_LEN = 4_096
// 二进制嗅探窗口：文本读取前 8KB 含 NUL 即判二进制拒绝（省得把 ELF/GIF 当
// utf-8 灌进插件 DOM）
const SNIFF_BYTES = 8_192
// 每插件在飞 fs 调用上限：防病态插件把主进程 IO 打满（超出直接拒绝，
// 不排队——插件侧自行串行）
const MAX_INFLIGHT_PER_PLUGIN = 8

// registry/perms 的窄依赖（index.ts 注入实例；e2e 可注入桩直测 gate）
export interface PluginFsDeps {
  /** 插件存在且未被禁用（禁用即视为无权限面） */
  pluginActive(id: string): boolean
  declaredFs(id: string): PluginFsScope[]
  effectiveFs(id: string, declared: PluginFsScope[]): PluginFsScope[]
}

export type FsCallResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 路径防御：必须是字符串、以 / 开头（绝对路径，防 cwd 歧义）、无 NUL、
 *  ≤4096；resolve 消掉 ./ 与 ../ 段后返回（符号链接不解析——文件管理器
 *  语义本来就要跟链接走） */
function checkPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\0')) return null
  if (raw.length > MAX_PATH_LEN) return null
  try {
    return resolve(raw)
  } catch {
    return null
  }
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function entryKind(isDirectory: boolean, isSymbolicLink: boolean, isFile: boolean): FsEntryKind {
  if (isDirectory) return 'dir'
  if (isSymbolicLink) return 'symlink'
  if (isFile) return 'file'
  return 'other'
}

const inflight = new Map<string, number>()

/** 每插件的在飞闸 + 异常归一：fn 抛错转 ok:false（错误串优先取 errno 代码，
 *  给插件可判定的稳定文案），返回值包 ok:true */
async function gated<T>(pluginId: string, fn: () => Promise<T>): Promise<FsCallResult<T>> {
  const n = inflight.get(pluginId) ?? 0
  if (n >= MAX_INFLIGHT_PER_PLUGIN) return err('too many concurrent fs calls')
  inflight.set(pluginId, n + 1)
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    const code = (e as { code?: string }).code
    return err(String(code ?? (e as Error)?.message ?? e))
  } finally {
    const cur = inflight.get(pluginId) ?? 1
    if (cur <= 1) inflight.delete(pluginId)
    else inflight.set(pluginId, cur - 1)
  }
}

async function listDir(pluginId: string, path: string | null): Promise<FsCallResult<FsListResult>> {
  if (!path) return err('bad path')
  return gated(pluginId, async () => {
    const dirents = await readdir(path, { withFileTypes: true })
    const truncated = dirents.length > MAX_ENTRIES
    const sliced = truncated ? dirents.slice(0, MAX_ENTRIES) : dirents
    // stat 数据（size/mtime）逐项 lstat：分批并发（每批 64）避免万项目录
    // 打满 fd；单项失败按最小信息降级（kind 仍可知，size/mtime 归 0）——
    // 竞态删除的条目不该让整个列表失败
    const entries: FsEntry[] = []
    for (let i = 0; i < sliced.length; i += 64) {
      const batch = sliced.slice(i, i + 64)
      const stats = await Promise.all(
        batch.map(async (d) => {
          try {
            const st = await lstat(resolve(path, d.name))
            return { size: st.size, mtime: st.mtimeMs }
          } catch {
            return { size: 0, mtime: 0 }
          }
        })
      )
      batch.forEach((d, j) => {
        entries.push({
          name: d.name,
          kind: entryKind(d.isDirectory(), d.isSymbolicLink(), d.isFile()),
          size: stats[j]!.size,
          mtime: stats[j]!.mtime
        })
      })
    }
    return { path, entries, truncated } satisfies FsListResult
  })
}

async function statPath(pluginId: string, path: string | null): Promise<FsCallResult<FsStat>> {
  if (!path) return err('bad path')
  return gated(pluginId, async () => {
    const st = await lstat(path)
    const out: FsStat = {
      path,
      kind: entryKind(st.isDirectory(), st.isSymbolicLink(), st.isFile()),
      size: st.size,
      mtime: st.mtimeMs
    }
    if (out.kind === 'symlink') {
      try {
        out.target = await readlink(path)
      } catch {
        // 竞态删除：target 缺省，kind 仍有效
      }
    }
    return out
  })
}

async function readText(pluginId: string, path: string | null): Promise<FsCallResult<FsTextResult>> {
  if (!path) return err('bad path')
  return gated(pluginId, async () => {
    const st = await stat(path)
    if (!st.isFile()) throw new Error('not a regular file')
    const buf = await readFile(path)
    const sniffEnd = Math.min(buf.length, SNIFF_BYTES)
    for (let i = 0; i < sniffEnd; i++) {
      if (buf[i] === 0) throw new Error('binary file (NUL in head)')
    }
    const truncated = buf.length > MAX_TEXT_BYTES
    const text = (truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf).toString('utf-8')
    return { text, size: buf.length, truncated } satisfies FsTextResult
  })
}

async function readBlob(pluginId: string, path: string | null): Promise<FsCallResult<FsBlobResult>> {
  if (!path) return err('bad path')
  return gated(pluginId, async () => {
    const st = await stat(path)
    if (!st.isFile()) throw new Error('not a regular file')
    const buf = await readFile(path)
    const truncated = buf.length > MAX_BLOB_BYTES
    const data = (truncated ? buf.subarray(0, MAX_BLOB_BYTES) : buf).toString('base64')
    return { data, size: buf.length, truncated } satisfies FsBlobResult
  })
}

async function writeFileGuarded(
  pluginId: string,
  path: string | null,
  content: unknown
): Promise<FsCallResult<null>> {
  if (!path) return err('bad path')
  if (typeof content !== 'string') return err('content must be a string')
  if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) return err('content too large')
  return gated(pluginId, async () => {
    // 父目录必须已存在（不递归建——新建文件/目录是两个明确动作，避免
    // 拼错路径悄悄建出整串目录）
    const parent = await stat(dirname(path))
    if (!parent.isDirectory()) throw new Error('parent is not a directory')
    await writeFile(path, content, 'utf-8')
    return null
  })
}

async function mkdirGuarded(pluginId: string, path: string | null): Promise<FsCallResult<null>> {
  if (!path) return err('bad path')
  return gated(pluginId, async () => {
    await mkdir(path, { recursive: true })
    return null
  })
}

async function renameGuarded(
  pluginId: string,
  from: string | null,
  to: string | null
): Promise<FsCallResult<null>> {
  if (!from || !to) return err('bad path')
  return gated(pluginId, async () => {
    // 目标必须不存在（POSIX rename 会静默覆盖，文件管理器语义应显式拒绝
    // 覆盖——要覆盖得先删目标）；目标父目录必须存在（不隐式建）
    await access(from)
    try {
      await access(to)
      throw new Error('target exists')
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e
    }
    const parent = await stat(dirname(to))
    if (!parent.isDirectory()) throw new Error('target parent is not a directory')
    await rename(from, to)
    return null
  })
}

async function trashPath(pluginId: string, path: string | null): Promise<FsCallResult<null>> {
  if (!path) return err('bad path')
  return gated(pluginId, async () => {
    // trashItem 自身校验存在性；回收站缺失（无桌面环境）会 reject，原样上抛
    await shell.trashItem(path)
    return null
  })
}

/**
 * 插件 fs 调用的唯一入口：权限 gate → 参数防御 → 执行。args 形状按 op
 * 不同（list、stat、readText、readBase64、mkdir、trash: [path]；rename:
 * [from, to]；write: [path, content]）。返回值永远 resolve（错误在 ok:false
 * 里，不抛——渲染层 IPC 不必 try/catch）
 */
export async function pluginFsCall(
  deps: PluginFsDeps,
  pluginId: unknown,
  op: unknown,
  args: unknown
): Promise<FsCallResult<unknown>> {
  if (typeof pluginId !== 'string' || typeof op !== 'string') return err('bad call shape')
  if (!Object.prototype.hasOwnProperty.call(OP_SCOPE, op)) return err(`unknown op: ${op}`)
  const theOp = op as FsOp
  if (!Array.isArray(args)) return err('bad args')
  // 权限三连：插件在且未禁用 → 声明含所需档位 → 实授权含所需档位
  if (!deps.pluginActive(pluginId)) return err('plugin not active')
  const declared = deps.declaredFs(pluginId)
  if (!declared.includes(OP_SCOPE[theOp])) return err(`fs "${OP_SCOPE[theOp]}" not declared`)
  const granted = deps.effectiveFs(pluginId, declared)
  if (!granted.includes(OP_SCOPE[theOp])) return err(`fs "${OP_SCOPE[theOp]}" not granted`)

  switch (theOp) {
    case 'list':
      return listDir(pluginId, checkPath(args[0]))
    case 'stat':
      return statPath(pluginId, checkPath(args[0]))
    case 'readText':
      return readText(pluginId, checkPath(args[0]))
    case 'readBase64':
      return readBlob(pluginId, checkPath(args[0]))
    case 'write':
      return writeFileGuarded(pluginId, checkPath(args[0]), args[1])
    case 'mkdir':
      return mkdirGuarded(pluginId, checkPath(args[0]))
    case 'rename':
      return renameGuarded(pluginId, checkPath(args[0]), checkPath(args[1]))
    case 'trash':
      return trashPath(pluginId, checkPath(args[0]))
  }
}

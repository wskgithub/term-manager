import { shell } from 'electron'
import { access, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { Stats } from 'fs'
import type {
  FsBlobResult,
  FsEntry,
  FsEntryKind,
  FsFindItem,
  FsFindResult,
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
// 权限语义：op→档位映射固定（read: list/stat/readText/readBase64/find；
// write: write/mkdir/rename/trash/copy/move），实授权 = pluginPerms 的已决策 ∩ 当前
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
  | 'copy'
  | 'move'
  | 'find'

const OP_SCOPE: Record<FsOp, PluginFsScope> = {
  list: 'read',
  stat: 'read',
  readText: 'read',
  readBase64: 'read',
  write: 'write',
  mkdir: 'write',
  rename: 'write',
  trash: 'write',
  copy: 'write',
  move: 'write',
  find: 'read'
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
// copy/move 的总量防御：单次操作合计字节与条数上限（目录树先 walk 计量，
// 超限拒绝——不落半个副本）
const MAX_COPY_BYTES = 2_000_000_000
const MAX_COPY_ITEMS = 20_000
// find 的遍历边界：深度 / 走访条目 / 结果数
const MAX_FIND_DEPTH = 6
const MAX_FIND_WALK = 50_000
const MAX_FIND_RESULTS = 200

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

/** 目录树总量预检（copy/move 跨盘回退路径共用）：条数与字节数超限即抛，
 *  复制开始前拒绝，绝不留半个副本；竞态消失的条目按不存在跳过 */
async function assertTreeBudget(root: string): Promise<void> {
  const queue = [root]
  let total = 0
  let items = 0
  while (queue.length) {
    const dir = queue.shift()!
    const dirents = await readdir(dir, { withFileTypes: true })
    for (const d of dirents) {
      items += 1
      if (items > MAX_COPY_ITEMS) throw new Error('copy too many entries')
      const p = resolve(dir, d.name)
      let ls: Stats | null = null
      try {
        ls = await lstat(p)
      } catch {
        ls = null
      }
      if (ls) {
        total += ls.size
        if (total > MAX_COPY_BYTES) throw new Error('copy too large')
        // 只递归真实目录：符号链接按链接本身计量，防环
        if (ls.isDirectory()) queue.push(p)
      }
    }
  }
}

/** copy/move 共用的形状防御：源存在、目标父目录存在、非同路径、
 *  目录源不得把目标含在自身内部（自递归复制） */
async function assertCopyShape(src: string, dst: string): Promise<Stats> {
  const st = await lstat(src)
  if (dst === src) throw new Error('same path')
  if (st.isDirectory() && dst.startsWith(src + '/')) throw new Error('dest inside source')
  const parent = await stat(dirname(dst))
  if (!parent.isDirectory()) throw new Error('target parent is not a directory')
  return st
}

/** overwrite 归一：帧桥透传的第三参可能是 boolean 或 {overwrite} */
function overwriteArg(raw: unknown): boolean {
  if (raw === true) return true
  if (typeof raw === 'object' && raw !== null && (raw as { overwrite?: unknown }).overwrite === true) return true
  return false
}

/** 目标已存在且未要求覆盖 → 显式拒绝（与 renameGuarded 同一防覆盖立场） */
async function refuseIfExists(dst: string, overwrite: boolean): Promise<void> {
  if (overwrite) return
  try {
    await access(dst)
    throw new Error('target exists')
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
  }
}

async function copyGuarded(
  pluginId: string,
  src: string | null,
  dst: string | null,
  rawOverwrite: unknown
): Promise<FsCallResult<null>> {
  if (!src || !dst) return err('bad path')
  const overwrite = overwriteArg(rawOverwrite)
  return gated(pluginId, async () => {
    const st = await assertCopyShape(src, dst)
    await refuseIfExists(dst, overwrite)
    if (st.isDirectory()) await assertTreeBudget(src)
    else if (st.size > MAX_COPY_BYTES) throw new Error('copy too large')
    await cp(src, dst, { recursive: true, force: overwrite, errorOnExist: !overwrite })
    return null
  })
}

async function moveGuarded(
  pluginId: string,
  src: string | null,
  dst: string | null,
  rawOverwrite: unknown
): Promise<FsCallResult<null>> {
  if (!src || !dst) return err('bad path')
  const overwrite = overwriteArg(rawOverwrite)
  return gated(pluginId, async () => {
    const st = await assertCopyShape(src, dst)
    await refuseIfExists(dst, overwrite)
    try {
      // 同盘：rename 原子完成（POSIX rename 对已存在文件是覆盖语义，上面
      // 已按需拒绝；目录对已存在目录会 ENOTEMPTY 上抛）
      await rename(src, dst)
      return null
    } catch (e) {
      if ((e as { code?: string }).code !== 'EXDEV') throw e
    }
    // 跨盘：复制后删源。删源只发生在「移动」语义内部（用户明确把文件搬走
    // 的动作），不构成对外暴露的真删通路——trash 仍是唯一删除 op
    await assertTreeBudget(src)
    await cp(src, dst, { recursive: true, force: overwrite, errorOnExist: !overwrite })
    await rm(src, { recursive: true, force: true })
    return null
  })
}

/** 大小写不敏感子序列命中（与插件帧内 fuzzy 同一语义：空查询在外层已拒） */
function subseqHit(name: string, q: string): boolean {
  const n = name.toLowerCase()
  const t = q.toLowerCase()
  let j = 0
  for (let i = 0; i < n.length && j < t.length; i++) {
    if (n[i] === t[j]) j++
  }
  return j === t.length
}

async function findPaths(
  pluginId: string,
  root: string | null,
  pattern: unknown
): Promise<FsCallResult<FsFindResult>> {
  if (!root) return err('bad path')
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 200 || pattern.includes('\0')) {
    return err('bad pattern')
  }
  return gated(pluginId, async () => {
    const st = await stat(root)
    if (!st.isDirectory()) throw new Error('root is not a directory')
    const items: FsFindItem[] = []
    let walked = 0
    let truncated = false
    // BFS 逐层走访：只下钻真实目录（符号链接不跟，防环）；命中项 lstat 取
    // size/mtime，竞态删除按最小信息降级
    const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
    while (queue.length && !truncated) {
      const { dir, rel, depth } = queue.shift()!
      const dirents = await readdir(dir, { withFileTypes: true })
      for (const d of dirents) {
        walked += 1
        if (walked > MAX_FIND_WALK) {
          truncated = true
          break
        }
        const childRel = rel ? rel + '/' + d.name : d.name
        if (subseqHit(d.name, pattern)) {
          if (items.length >= MAX_FIND_RESULTS) truncated = true
          else {
            let size = 0
            let mtime = 0
            try {
              const ls = await lstat(resolve(dir, d.name))
              size = ls.size
              mtime = ls.mtimeMs
            } catch {
              // 竞态删除：最小信息
            }
            items.push({
              rel: childRel,
              kind: entryKind(d.isDirectory(), d.isSymbolicLink(), d.isFile()),
              size,
              mtime
            })
          }
        }
        if (d.isDirectory() && depth < MAX_FIND_DEPTH) {
          queue.push({ dir: resolve(dir, d.name), rel: childRel, depth: depth + 1 })
        }
      }
    }
    // 浅的在前，同层按路径字典序——越近的结果越可能想要
    items.sort((a, b) => {
      const da = a.rel.split('/').length
      const db = b.rel.split('/').length
      if (da !== db) return da - db
      return a.rel.localeCompare(b.rel)
    })
    return { root, items, truncated } satisfies FsFindResult
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
    case 'copy':
      return copyGuarded(pluginId, checkPath(args[0]), checkPath(args[1]), args[2])
    case 'move':
      return moveGuarded(pluginId, checkPath(args[0]), checkPath(args[1]), args[2])
    case 'find':
      return findPaths(pluginId, checkPath(args[0]), args[1])
  }
}

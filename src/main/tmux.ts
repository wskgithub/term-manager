import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { readdirSync, unlinkSync } from 'fs'
import os from 'os'
import { basename, join } from 'path'
import { StringDecoder } from 'string_decoder'
import type { Profile } from './profiles'
import type { TermInfo } from '../shared/types'

export type { TermInfo } from '../shared/types'

interface Tab {
  info: TermInfo
  pane: string // %N
  window: string // @N
  alive: boolean
}

interface PendingCommand {
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
  lines: string[]
  inBlock: boolean
  timer: NodeJS.Timeout
}

// tmux 命令行分词的字面量：双引号包裹，转义 \ 与 "
function tmuxToken(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// pane 内 /bin/sh -c 执行的单词引用
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

// 还原 tmux 控制协议 %output 负载中的八进制转义（\033、\015 等，tmux 恒发 3 位）。
// 字节级操作：除转义外的字节原样保留——其中包括 tmux 未转义、按事件边界
// 拆开的 UTF-8 残段（见 TmuxBackend.emitOutput，需按 pane 重组后再解码）
function unescapeBytes(buf: Buffer): Buffer {
  if (!buf.includes(0x5c)) return buf
  const out: number[] = []
  const oct = (b: number | undefined): boolean => b !== undefined && b >= 0x30 && b <= 0x37
  for (let i = 0; i < buf.length; ) {
    if (buf[i] === 0x5c && oct(buf[i + 1]) && oct(buf[i + 2]) && oct(buf[i + 3])) {
      out.push(((buf[i + 1]! - 0x30) << 6) | ((buf[i + 2]! - 0x30) << 3) | (buf[i + 3]! - 0x30))
      i += 4
    } else {
      out.push(buf[i]!)
      i++
    }
  }
  return Buffer.from(out)
}

const CMD_TIMEOUT_MS = 8000
const FLUSH_DEBOUNCE_MS = 5
const FLUSH_CHUNK = 8 * 1024
const RESIZE_DEBOUNCE_MS = 120

// "%output " 的字节前缀（onData 里做字节级行分发用）
const OUT_PREFIX = Buffer.from('%output ')

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 清理崩溃实例遗留的私有 tmux 服务器。socket 名固定为 termmgr-<创建进程 pid>：
    名字经 ^termmgr-(\d+)$ 白名单校验后只可能是「termmgr-」+纯数字，无注入面；
    pid 已死而 socket 仍在 ⇒ 上次实例未正常退出（正常退出会 kill-session），
    杀掉其服务器释放会话与 shell。pid 存活（另一运行实例 / pid 被复用）时保守跳过。
    会话保持功能落地后，此处应改为附着候选而不是清理 */
function sweepStaleServers(): void {
  const dir = process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 目录不存在：没有遗留
  }
  const prefix = 'termmgr-'
  for (const entry of names) {
    if (!entry.startsWith(prefix)) continue
    const digits = entry.slice(prefix.length)
    if (!/^\d+$/.test(digits) || Number(digits) === process.pid) continue
    try {
      process.kill(Number(digits), 0)
      continue // pid 还活着：另一实例在跑，不动
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue // EPERM 等：当作活着
    }
    const cleaner = spawn('tmux', ['-L', prefix + digits, 'kill-server'], { stdio: 'ignore' })
    cleaner.on('error', () => undefined) // tmux 缺失等：继续尝试清理 socket 文件
    console.log(`[tmux] cleaning stale server socket ${prefix + digits}`)
    // 服务器已死时（上次崩溃后又被系统清理/自杀）socket 文件也会残留
    // （tmux 只在服务器正常退出时移除它），一并 unlink；活服务器则由
    // kill-server 退出时自行移除，此处 ENOENT 忽略
    try {
      unlinkSync(join(dir, entry))
    } catch {
      // 已被 tmux 移除
    }
  }
}

/**
 * 基于 tmux Control Mode 的终端后端：
 * 每个"终端"= 私有 socket tmux 服务器里的一个窗口（单 pane），
 * 输出经 %output 事件流出，输入经 send-keys 写入，PTY 生命周期由 tmux 托管。
 */
export class TmuxBackend {
  private proc: ChildProcessWithoutNullStreams | null = null
  private tabs = new Map<string, Tab>()
  private paneToTerm = new Map<string, string>()
  private windowToTerm = new Map<string, string>()
  private pending: PendingCommand[] = []
  /** 行帧缓冲（字节级）：tmux 负载含未经转义的原样 UTF-8，先按 0x0A 分行再谈解码
      （多字节字符的组成字节均 ≥0x80，不可能与帧分隔符混淆） */
  private buf: Buffer = Buffer.alloc(0)
  private session = ''
  private autoWindow = ''
  private autoWindowKilled = false
  private inputBuffers = new Map<string, string>()
  private inputTimers = new Map<string, NodeJS.Timeout>()
  private resizeTimers = new Map<string, NodeJS.Timeout>()
  // \ek 标题序列跨 %output 事件分片时的残片缓存（pane id → 残片）
  private titleHold = new Map<string, string>()
  // %output 重组解码器（pane id → decoder）：tmux 可能把一个多字节字符按事件
  // 边界拆成两段原样（不转义）字节流，行帧里还夹着 "\n%output %N " 帧头，
  // 流级解码永远重组不回来——必须把负载字节按 pane 攒着解码，
  // StringDecoder 会把不完整序列留到下一个事件
  private paneDecoders = new Map<string, StringDecoder>()
  private disposed = false

  constructor(private emit: (channel: string, ...args: unknown[]) => void) {}

  async start(): Promise<void> {
    if (this.proc) return
    sweepStaleServers()
    this.proc = spawn('tmux', ['-C', '-u', '-L', `termmgr-${process.pid}`], {
      cwd: os.homedir()
    })
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => console.error('[tmux]', chunk.toString()))
    // tmux 缺失（spawn ENOENT）等进程级失败：error 事件不处理会把主进程崩掉，
    // 走与退出相同的通知语义，让渲染层拿到 term:exit 而不是应用闪退
    this.proc.on('error', (err) => {
      console.error('[tmux] process error:', err.message)
      this.onGone()
    })
    // 服务器先死时对 stdin 的残留写入会 EPIPE，同样不能变成未处理 error
    this.proc.stdin.on('error', () => undefined)
    this.proc.on('exit', () => this.onGone())

    // tmux -C 启动时自动创建并挂载一个会话（含一个默认 shell 窗口）。
    // 等它就绪后收编：改名作为工作会话；绝不能 kill 最后一个会话（服务器会随之退出）。
    for (let i = 0; i < 24 && !this.session; i++) {
      try {
        const r = await this.send(`display-message -p '#{session_id}'`, true, 1200)
        const s = r[r.length - 1]?.trim() ?? ''
        if (s.startsWith('$')) this.session = s
      } catch {
        await delay(200)
      }
    }
    if (!this.session) {
      // 兜底：自建会话并挂载
      const r = await this.send(`new-session -d -P -F '#{session_id}' -s tmgr-${process.pid}`)
      this.session = r[r.length - 1]?.trim() ?? ''
      if (!this.session.startsWith('$')) throw new Error('tmux: server not ready')
      await this.send(`attach-session -t ${this.session}`)
    } else {
      await this.send(`rename-session -t ${this.session} tmgr-${process.pid}`)
      const w = await this.send(`display-message -p '#{window_id}'`)
      this.autoWindow = w[w.length - 1]?.trim() ?? ''
    }
  }

  /** 服务器不可用（退出/启动失败）：所有会话终结 */
  private onGone(): void {
    this.proc = null
    for (const [id, tab] of this.tabs) {
      if (tab.alive) {
        tab.alive = false
        this.emit('term:exit', id, -1)
      }
    }
  }

  private onData(chunk: Buffer): void {
    // 字节级行帧：帧缓冲绝不做字符串解码（解码只在「整行非 %output」与
    // 「按 pane 重组后的负载」两个安全位置发生）
    this.buf = Buffer.concat([this.buf, chunk])
    let idx: number
    while ((idx = this.buf.indexOf(0x0a)) >= 0) {
      const lineBytes = this.buf.subarray(0, idx)
      this.buf = this.buf.subarray(idx + 1)
      if (lineBytes.subarray(0, 8).equals(OUT_PREFIX)) {
        // %output <pane> <payload>：payload 保持字节，交 pane 级重组解码
        const rest = lineBytes.subarray(8)
        const sp = rest.indexOf(0x20)
        if (sp !== -1) {
          this.emitOutput(rest.subarray(0, sp).toString(), unescapeBytes(rest.subarray(sp + 1)))
        }
      } else {
        // 回执/事件行是 tmux 生成的完整文本行（无跨行多字节问题），整行解码安全
        this.onLine(lineBytes.toString('utf8'))
      }
    }
  }

  /** pane 级负载解码：StringDecoder 把不完整的多字节序列留到下一个 %output
      事件，重组 tmux 按事件边界拆开的字符 */
  private emitOutput(pane: string, payload: Buffer): void {
    const id = this.paneToTerm.get(pane)
    if (!id || payload.length === 0) return
    let dec = this.paneDecoders.get(pane)
    if (!dec) {
      dec = new StringDecoder('utf8')
      this.paneDecoders.set(pane, dec)
    }
    const text = dec.write(payload)
    if (text) this.emit('term:data', id, this.convertTmuxTitle(pane, text))
  }

  private onLine(line: string): void {
    if (process.env.TMUX_DEBUG) console.log('[tmux:rx]', line)
    if (line.startsWith('%begin')) {
      const p = this.pending[0]
      if (p) p.inBlock = true
      return
    }
    if (line.startsWith('%end')) {
      const p = this.pending.shift()
      if (p) {
        clearTimeout(p.timer)
        p.resolve(p.lines)
      }
      return
    }
    if (line.startsWith('%error')) {
      const p = this.pending.shift()
      if (p) {
        clearTimeout(p.timer)
        p.reject(new Error(line))
      }
      return
    }
    if (line.startsWith('%window-close ')) {
      const win = line.slice('%window-close '.length).trim()
      const id = this.windowToTerm.get(win)
      if (id) {
        const tab = this.tabs.get(id)
        if (tab && tab.alive) {
          tab.alive = false
          this.emit('term:exit', id, 0)
          this.cleanup(id)
        }
      }
      return
    }
    // 回执块内的行都是命令输出（注意 pane id 形如 %N，也以 % 开头，不能当事件忽略）
    const cur = this.pending[0]
    if (cur && cur.inBlock) {
      cur.lines.push(line)
      return
    }
    if (line.startsWith('%')) return // 其余事件（layout-change 等）忽略
  }

  /** 发送一条控制命令。awaitReply=false 时仅排队占位（每个命令都会产生 %begin/%end 回执块）。 */
  private send(line: string, awaitReply = true, timeoutMs = CMD_TIMEOUT_MS): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      if (!this.proc) {
        // 进程不在：等待型命令直接失败；火忘型命令没有回执块，不入队
        if (awaitReply) reject(new Error('tmux backend not running'))
        else resolve([])
        return
      }
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(p)
        if (i !== -1) this.pending.splice(i, 1)
        reject(new Error(`tmux command timeout: ${line}`))
      }, timeoutMs)
      if (process.env.TMUX_DEBUG) console.log('[tmux:tx]', line, '(pending:', this.pending.length + 1 + ')')
      const p: PendingCommand = {
        resolve: (lines) => resolve(lines),
        reject,
        lines: [],
        inBlock: false,
        timer
      }
      this.pending.push(p)
      this.proc?.stdin.write(line + '\n')
    })
  }

  /** 火忘型命令：tmux 对每条命令都会回执（%end 或 %error），超时/%error 的
      rejection 在此吞掉——后端状态由后续命令与 %window-close 事件校准，
      冒成 unhandledRejection 只会污染日志 */
  private fire(line: string): void {
    this.send(line, false).catch(() => undefined)
  }

  async create(profile: Profile, cwdOverride?: string): Promise<TermInfo> {
    if (!this.proc) await this.start()

    // 注意：不要在命令前加 `exec`（tmux 会经 /bin/sh -c "exec …" 包装执行，
    // 该 execvp 包装在受限环境/沙箱会被误杀导致 pane 秒退）；直接把命令 token
    // 交给 tmux（sh -c 直接执行），带参数时避免引号歧义即可。
    const parts: string[] = []
    if (profile.command) {
      parts.push(shQuote(profile.command), ...(profile.args ?? []).map((a) => shQuote(a)))
    }
    const cmdline = profile.command ? parts.join(' ') : ''
    const envArgs = Object.entries(profile.env ?? {})
      .map(([k, v]) => `-e ${tmuxToken(`${k}=${v}`)}`)
      .join(' ')
    // cwdOverride 来自 CLI/文件管理器右键传入的目录，优先于 profile 自身的 cwd
    const cwd = cwdOverride || profile.cwd || os.homedir()
    const line =
      `new-window -d -P -F '#{pane_id} #{window_id}' -c ${tmuxToken(cwd)} ${envArgs} ${cmdline}`.trim()
    const reply = await this.send(line)
    const ids = (reply[reply.length - 1] ?? '').trim().split(/\s+/)
    const pane = ids[0]
    const window = ids[1]
    if (!pane.startsWith('%') || !window.startsWith('@')) {
      throw new Error(`tmux: unexpected new-window reply: ${reply.join(' | ')}`)
    }

    const id = randomUUID()
    const info: TermInfo = {
      id,
      profileId: profile.id,
      title: cwdOverride ? basename(cwdOverride) : profile.name,
      color: profile.color
    }
    this.tabs.set(id, { info, pane, window, alive: true })
    this.paneToTerm.set(pane, id)
    this.windowToTerm.set(window, id)

    // 首个标签建成后再关自动窗口（此时会话仍有窗口，服务器不会退出）
    if (!this.autoWindowKilled && this.autoWindow.startsWith('@')) {
      this.autoWindowKilled = true
      this.fire(`kill-window -t ${this.autoWindow}`)
    }
    return info
  }

  /**
   * tmux 在 automatic-rename 时会把自家标题序列 \ek<名>\e\\ 混进 pane 输出流
   * （如 ssh 时窗口名变成 "oem@1.2.3.4"）。xterm.js 不认识 \ek，会把负载当普通
   * 文本打印——正好落在 MOTD 第一行前，出现"ssh 后多出一串主机名"。
   * 这里把它转成等价的 OSC 2 序列：xterm 触发标题事件而非打印，标签名还能跟随。
   * 序列可能被 tmux 按 write 边界拆到多个 %output 事件里，需按 pane 留存残片。
   */
  private convertTmuxTitle(pane: string, data: string): string {
    let buf = (this.titleHold.get(pane) ?? '') + data
    let out = ''
    for (;;) {
      const start = buf.indexOf('\x1bk')
      if (start === -1) {
        out += buf
        buf = ''
        break
      }
      out += buf.slice(0, start)
      const end = buf.indexOf('\x1b\\', start + 2)
      if (end === -1) {
        buf = buf.slice(start)
        break
      }
      out += `\x1b]2;${buf.slice(start + 2, end)}\x1b\\`
      buf = buf.slice(end + 2)
    }
    // 残片过长视为序列损坏，直接放行避免无限滞留
    if (buf.length > 4096) {
      out += buf
      buf = ''
    }
    this.titleHold.set(pane, buf)
    return out
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id)
    if (!tab?.alive) return
    const acc = (this.inputBuffers.get(id) ?? '') + data
    this.inputBuffers.set(id, acc)
    if (!this.inputTimers.has(id)) {
      this.inputTimers.set(
        id,
        setTimeout(() => this.flushInput(id), FLUSH_DEBOUNCE_MS)
      )
    }
  }

  private flushInput(id: string): void {
    this.inputTimers.delete(id)
    const tab = this.tabs.get(id)
    const data = this.inputBuffers.get(id) ?? ''
    this.inputBuffers.delete(id)
    if (!tab?.alive || !data) return
    // 按 CR/LF 切分：文本段字面量发送，分隔符转成 Enter 键
    const segments = data.split(/(\r\n|\r|\n)/)
    for (const seg of segments) {
      if (!seg) continue
      if (seg === '\r' || seg === '\n' || seg === '\r\n') {
        this.fire(`send-keys -t ${tab.pane} Enter`)
      } else {
        // 大段输入切分为 ≤8KB 的命令行
        for (let i = 0; i < seg.length; i += FLUSH_CHUNK) {
          const piece = seg.slice(i, i + FLUSH_CHUNK)
          this.fire(`send-keys -t ${tab.pane} -l ${tmuxToken(piece)}`)
        }
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const tab = this.tabs.get(id)
    if (!tab?.alive || cols <= 0 || rows <= 0) return
    const prev = this.resizeTimers.get(id)
    if (prev) clearTimeout(prev)
    this.resizeTimers.set(
      id,
      setTimeout(() => {
        this.resizeTimers.delete(id)
        if (tab.alive) this.fire(`resize-window -t ${tab.window} -x ${cols} -y ${rows}`)
      }, RESIZE_DEBOUNCE_MS)
    )
  }

  kill(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab?.alive) return
    tab.alive = false
    this.fire(`kill-window -t ${tab.window}`)
    this.emit('term:exit', id, 0)
    this.cleanup(id)
  }

  private cleanup(id: string): void {
    const tab = this.tabs.get(id)
    if (tab) {
      this.paneToTerm.delete(tab.pane)
      this.windowToTerm.delete(tab.window)
      this.titleHold.delete(tab.pane)
      this.paneDecoders.delete(tab.pane)
    }
    this.tabs.delete(id)
    const t = this.inputTimers.get(id)
    if (t) clearTimeout(t)
    this.inputTimers.delete(id)
    this.inputBuffers.delete(id)
    const r = this.resizeTimers.get(id)
    if (r) clearTimeout(r)
    this.resizeTimers.delete(id)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.proc && this.session) {
      try {
        await this.send(`kill-session -t ${this.session}`)
      } catch {
        // 会话可能已退出
      }
    }
    this.proc?.stdin.end()
    const p = this.proc
    if (p) {
      const timer = setTimeout(() => p.kill(), 1500)
      p.once('exit', () => clearTimeout(timer))
    }
  }
}

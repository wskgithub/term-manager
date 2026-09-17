import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, unlinkSync } from 'fs'
import os from 'os'
import { basename, join } from 'path'
import { StringDecoder } from 'string_decoder'
import type { Profile } from './profiles'
import type { PersistedSession, TermInfo } from '../shared/types'

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
  // %begin 帧的序号：%end/%error 必须带相同序号才认。回执块内的内容行不转义
  // （spike 实测 pane 内容里的 "%end-FAKE" 原样出现），若 pane 里恰好显示了
  // 一行完整格式的 %end 会提前截断回执——序号配对把这种碰撞挡掉
  seq: string
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
// 会话回放取的历史行数：对齐渲染层 xterm scrollback
const REPLAY_LINES = 2000
// 附着时等待目标 session 出现的轮询上限
const ATTACH_TIMEOUT_MS = 4000

// "%output " 的字节前缀（onData 里做字节级行分发用）
const OUT_PREFIX = Buffer.from('%output ')

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 清理崩溃实例遗留的私有 tmux 服务器。socket 名固定为 termmgr-<创建进程 pid>：
    名字经 ^termmgr-(\d+)$ 白名单校验后只可能是「termmgr-」+纯数字，无注入面；
    pid 已死而 socket 仍在 ⇒ 上次实例未正常退出（会话保持下也可能是崩溃前的在保
    会话——因此只在真实 GUI 启动时由 index.ts 调用，keepSocket 排除本次要附着的
    服务器；smoke/e2e 隔离进程不调用，避免误杀用户在保会话）。
    pid 存活（另一运行实例 / pid 被复用）时保守跳过 */
export function sweepStaleServers(keepSocket?: string): void {
  const dir = process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 目录不存在：没有遗留
  }
  const prefix = 'termmgr-'
  for (const entry of names) {
    if (!entry.startsWith(prefix) || entry === keepSocket) continue
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
  private sessionName = ''
  private socketName = ''
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
  // 早期事件暂存：瞬逝命令（echo/一次性脚本）的 %output 与 %window-close 可能
  // 先于 new-window 回执到达，而 pane→id / window→id 映射要等回执解析后才建立
  // ——未知 id 的事件不能直接丢（否则输出与退出通知都静默丢失，交互 shell 的
  // 提示符到得晚从未暴露；插件快捷命令让它成一等场景）。create() 注册映射后
  // 原路冲刷输出/补发退出；已清理 pane 的迟到输出仍丢弃
  private earlyOutputs = new Map<string, Buffer[]>()
  private earlyWindowCloses = new Set<string>()
  private gonePanes = new Set<string>()
  // 会话恢复的标签集合：渲染层取走回放（takeReplay）前，其 %output 一律丢弃——
  // takeReplay 时的 capture-pane 快照必然覆盖取走时刻之前的全部屏幕内容
  private replayPending = new Set<string>()
  private disposed = false

  constructor(private emit: (channel: string, ...args: unknown[]) => void) {}

  /**
   * 启动后端。传入 attach（上次会话的持久化记录）时尝试附着既有服务器并恢复
   * 标签（返回恢复的 TermInfo[]，顺序即标签栏顺序）；附着失败自动回落全新启动。
   * （遗留服务器清理由 index.ts 在真实 GUI 启动时先行调用 sweepStaleServers）
   */
  async start(attach?: PersistedSession): Promise<TermInfo[]> {
    if (this.proc) return []
    if (attach) {
      try {
        return await this.startAttach(attach)
      } catch (e) {
        console.error('[tmux] attach failed, falling back to fresh start:', e)
        await this.stopClient()
      }
    }
    await this.startFresh()
    return []
  }

  /** tmux 私有 socket 目录（spawn 只传 -L 名，路径规则与 tmux/sweep 一致） */
  private socketDir(): string {
    return process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`
  }

  private spawnClient(socketName: string): void {
    this.socketName = socketName
    this.proc = spawn('tmux', ['-C', '-u', '-L', socketName], { cwd: os.homedir() })
    const proc = this.proc
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    proc.stderr.on('data', (chunk: Buffer) => console.error('[tmux]', chunk.toString()))
    // tmux 缺失（spawn ENOENT）等进程级失败：error 事件不处理会把主进程崩掉，
    // 走与退出相同的通知语义，让渲染层拿到 term:exit 而不是应用闪退
    proc.on('error', (err) => {
      console.error('[tmux] process error:', err.message)
      this.onGone()
    })
    // 服务器先死时对 stdin 的残留写入会 EPIPE，同样不能变成未处理 error
    proc.stdin.on('error', () => undefined)
    proc.on('exit', () => this.onGone())
  }

  /** 终结 control client 进程（不动服务器）：附着失败回落、dispose(keep) 共用 */
  private async stopClient(): Promise<void> {
    this.session = ''
    this.sessionName = ''
    const proc = this.proc
    this.proc = null
    this.pending.forEach((p) => {
      clearTimeout(p.timer)
      p.reject(new Error('tmux client stopped'))
    })
    this.pending = []
    if (!proc) return
    proc.removeAllListeners('exit')
    proc.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill()
        resolve()
      }, 800)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** 全新启动：私有 socket 服务器 + 收编 tmux 自动创建的会话 */
  private async startFresh(): Promise<void> {
    this.spawnClient(`termmgr-${process.pid}`)

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
    this.sessionName = `tmgr-${process.pid}`
  }

  /**
   * 附着既有服务器（会话保持）。spike 实测的关键协议行为：
   * control client 连上既有服务器时会自动新建一个 session（含一个窗口）并 attach 之，
   * 因此流程 = 连接 → 轮询 list-sessions 找到记录的目标 session → attach-session 切换
   * → kill 掉自动 session 等副产品 → list-windows 与 sessions.json 按 windowId 对账。
   * 任何一步失败抛错（由 start() 回落全新启动，已死服务器顺手 kill-server 清 socket）。
   */
  private async startAttach(a: PersistedSession): Promise<TermInfo[]> {
    if (!existsSync(join(this.socketDir(), a.socketName))) {
      throw new Error(`socket missing: ${a.socketName}`)
    }
    this.spawnClient(a.socketName)

    const rowRe = /^(\$\d+)\s+(.+)$/
    const listSessions = async (): Promise<{ id: string; name: string }[]> => {
      const rows = await this.send(`list-sessions -F '#{session_id} #{session_name}'`)
      const out: { id: string; name: string }[] = []
      for (const row of rows) {
        const m = row.trim().match(rowRe)
        if (m) out.push({ id: m[1], name: m[2] })
      }
      return out
    }

    const deadline = Date.now() + ATTACH_TIMEOUT_MS
    let sessions: { id: string; name: string }[] = []
    while (Date.now() < deadline) {
      try {
        sessions = await listSessions()
        if (sessions.some((s) => s.name === a.sessionName)) break
      } catch {
        // 服务器可能尚未应答，继续轮询
      }
      await delay(150)
    }
    const target = sessions.find((s) => s.name === a.sessionName)
    if (!target) {
      // 目标会话没了（全部窗口关闭后按 exit-empty 退出）或服务器无响应：清理整体
      await this.stopClient()
      this.killServer(a.socketName)
      throw new Error(`target session not found: ${a.sessionName}`)
    }

    // 切到目标会话（自动 session 变为无 client 的副产品）
    await this.send(`attach-session -t ${target.id}`)
    this.session = target.id
    this.sessionName = target.name
    // 副产品 session 的创建与 attach 异步完成，稍等再列一次；若仍迟到未列出，
    // 留给下次 attach / dispose(keep) 清理（kill 循环按 id 幂等）
    await delay(250)
    for (const s of await listSessions()) {
      if (s.id !== target.id) this.fire(`kill-session -t ${s.id}`)
    }

    // 窗口对账：sessions.json 记录的顺序 = 标签栏顺序（权威），tmux 侧多余的是
    // 崩溃后未及落盘的新建窗口 → 收养（新 id，标题取窗口名）；记录里已死的窗口丢弃
    const wins = await this.send(`list-windows -t ${target.id} -F '#{window_id} #{pane_id} #{window_name}'`)
    const live = new Map<string, { pane: string; name: string }>()
    for (const row of wins) {
      const m = row.trim().match(/^(@\d+)\s+(%\d+)\s+(.*)$/)
      if (m) live.set(m[1], { pane: m[2], name: m[3] })
    }
    if (live.size === 0) {
      // 目标会话已空（如 exit-empty off 的用户配置）：终结它（连带服务器）后走全新启动
      await this.send(`kill-session -t ${target.id}`)
      await this.stopClient()
      throw new Error('no live windows to restore')
    }

    const restored: TermInfo[] = []
    const hit = new Set<string>()
    for (const saved of a.tabs) {
      const w = live.get(saved.windowId)
      if (!w) continue
      hit.add(saved.windowId)
      const info: TermInfo = {
        id: saved.id,
        profileId: saved.profileId,
        title: saved.title,
        color: saved.color,
        pinned: saved.pinned,
        groupId: saved.groupId
      }
      this.adopt(info, w.pane, saved.windowId)
      restored.push(info)
    }
    for (const [win, w] of live) {
      if (hit.has(win)) continue
      const info: TermInfo = { id: randomUUID(), profileId: 'restored', title: w.name || '会话' }
      this.adopt(info, w.pane, win)
      restored.push(info)
    }
    return restored
  }

  /** 登记一个恢复的标签并挂起回放等待渲染层取走 */
  private adopt(info: TermInfo, pane: string, window: string): void {
    this.tabs.set(info.id, { info, pane, window, alive: true })
    this.paneToTerm.set(pane, info.id)
    this.windowToTerm.set(window, info.id)
    this.replayPending.add(info.id)
  }

  /** 杀掉指定 socket 的服务器并清残留 socket 文件（附着失败回落用） */
  private killServer(socketName: string): void {
    const cleaner = spawn('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' })
    cleaner.on('error', () => undefined)
    try {
      unlinkSync(join(this.socketDir(), socketName))
    } catch {
      // 已被 tmux 移除
    }
  }

  /** 当前服务器身份（会话持久化用）；未启动或已终止时为 null */
  describe(): { socketName: string; sessionName: string } | null {
    return this.proc && this.sessionName && this.session
      ? { socketName: this.socketName, sessionName: this.sessionName }
      : null
  }

  /** tabId → windowId 的活动映射（会话落盘时与渲染层 UI 态对账用） */
  windowIds(): Map<string, string> {
    const m = new Map<string, string>()
    for (const [id, t] of this.tabs) m.set(id, t.window)
    return m
  }

  /** 取标签的 TermInfo 快照（会话落盘对新标签兜底用） */
  tabInfo(id: string): TermInfo | undefined {
    const t = this.tabs.get(id)
    return t ? { ...t.info } : undefined
  }

  /**
   * 取走一个恢复标签的屏幕回放（渲染层 TermView 挂载后调用）：
   * capture-pane -e 拿带颜色（SGR 序列以字面 ESC 字节原样返回，spike 实测）的
   * 历史+整屏内容，再用 display-message 的 pane 光标位置换算成 xterm 绝对定位序列
   * 拼在末尾——shell 场景光标回到提示符行尾，全屏应用（vim/htop）也精确。
   * 此前该 pane 的 %output 全部被丢弃（本快照必含）；取走后输出流恢复直推。
   * capture 回执到达到 replayPending 清除之间存在几毫秒丢失窗口（工程取舍：
   * 重复输出比丢失更扎眼，且此刻用户尚未输入）。
   */
  async takeReplay(id: string): Promise<string> {
    const tab = this.tabs.get(id)
    if (!tab || !this.replayPending.has(id)) return ''
    let text = ''
    try {
      const cap = await this.send(`capture-pane -p -e -t ${tab.pane} -S -${REPLAY_LINES}`)
      text = cap.join('\r\n')
      const pos = await this.send(`display-message -p -t ${tab.pane} '#{cursor_y} #{cursor_x} #{pane_height}'`)
      const m = (pos[pos.length - 1] ?? '').trim().match(/^(\d+) (\d+) (\d+)$/)
      if (m) {
        const histRows = Math.max(0, cap.length - Number(m[3]))
        text += `\x1b[${histRows + Number(m[1]) + 1};${Number(m[2]) + 1}H`
      }
    } catch (e) {
      console.error('[tmux] replay capture failed:', e)
    }
    this.replayPending.delete(id)
    return text
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
    if (payload.length === 0) return
    const id = this.paneToTerm.get(pane)
    if (!id) {
      // 映射未建立：暂存等 create() 冲刷；已清理的 pane 是迟到事件，丢弃。
      // 暂存有界（pane 数与每 pane 块数都封顶），永不注册的 pane 不会积压
      if (this.gonePanes.has(pane)) return
      if (this.earlyOutputs.size >= 32) {
        const oldest = this.earlyOutputs.keys().next().value
        if (oldest !== undefined && oldest !== pane) this.earlyOutputs.delete(oldest)
      }
      const list = this.earlyOutputs.get(pane) ?? []
      if (list.length < 64) list.push(payload)
      this.earlyOutputs.set(pane, list)
      return
    }
    // 恢复标签尚未取走回放：丢弃（takeReplay 的 capture 快照必然覆盖此刻之前的
    // 全部屏幕内容，直推反而会与回放内容重复）
    if (this.replayPending.has(id)) return
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
    // %begin/%end/%error 帧格式均为 "%xxx <time> <序号> <flag>"，序号配对：
    // 只有序号与队首命令 %begin 一致的 %end/%error 才是真实回执帧。回执块内的
    // 内容行不转义（spike 实测 pane 里的 "%end-FAKE" 原样出现），不配对会把
    // pane 内容里碰巧整行匹配的伪造帧当真，提前截断回执
    const frame = line.match(/^(%begin|%end|%error) (\d+) (\d+) (\d+)$/)
    if (frame) {
      const cur = this.pending[0]
      if (frame[1] === '%begin') {
        if (cur && !cur.inBlock) {
          cur.inBlock = true
          cur.seq = frame[3]
        } else if (cur && cur.inBlock) {
          // 内容里伪造的 %begin：当普通内容行
          cur.lines.push(line)
        }
        return
      }
      if (cur && cur.inBlock && cur.seq === frame[3]) {
        this.pending.shift()
        clearTimeout(cur.timer)
        if (frame[1] === '%end') cur.resolve(cur.lines)
        else cur.reject(new Error(line))
      } else if (cur && cur.inBlock) {
        // 序号不匹配：内容里伪造的 %end/%error，当普通内容行
        cur.lines.push(line)
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
      } else if (!this.earlyWindowCloses.has(win)) {
        // 映射未建立（瞬逝命令的窗口先于回执关闭）：暂存，create() 补发退出。
        // 有界：未知窗口本就罕见，超限丢最旧
        if (this.earlyWindowCloses.size >= 32) {
          const oldest = this.earlyWindowCloses.values().next().value
          if (oldest !== undefined) this.earlyWindowCloses.delete(oldest)
        }
        this.earlyWindowCloses.add(win)
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
        seq: '',
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
    // 关键：new-window 的 shell-command 只取余下的【第一个】tmux token——此前
    // 把 command/args 逐个 shQuote 后平铺，tmux 只见首词、args 全部被静默丢弃
    // （带参数的 profile 一直在裸跑首词，如 Docker Shell 实际执行的是裸 docker）。
    // 正确拼装：argv 先各自 shQuote 保住 shell 层的词边界、join 成一条命令串，
    // 再整段经 tmuxToken 作为【一个】tmux 参数传入（spike 实测 tmux 双引号串
    // 原样交给 sh -c，pane_start_command 保留内层单引号）
    const cmdline = profile.command
      ? [shQuote(profile.command), ...(profile.args ?? []).map((a) => shQuote(a))].join(' ')
      : ''
    const envArgs = Object.entries(profile.env ?? {})
      .map(([k, v]) => `-e ${tmuxToken(`${k}=${v}`)}`)
      .join(' ')
    // cwdOverride 来自 CLI/文件管理器右键传入的目录，优先于 profile 自身的 cwd
    const cwd = cwdOverride || profile.cwd || os.homedir()
    const line =
      `new-window -d -P -F '#{pane_id} #{window_id}' -c ${tmuxToken(cwd)} ${envArgs} ${
        cmdline ? tmuxToken(cmdline) : ''
      }`.trim()
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

    // 冲刷早于回执到达的输出（原路走 emitOutput：解码、\ek 标题转换语义不变）；
    // 若窗口在回执前就已关闭（瞬逝命令），按既有通知语义补发退出——渲染层的
    // 早期缓冲会保证顺序（数据先落、退出消息随后）
    const early = this.earlyOutputs.get(pane)
    if (early) {
      this.earlyOutputs.delete(pane)
      for (const p of early) this.emitOutput(pane, p)
    }
    if (this.earlyWindowCloses.delete(window)) {
      const tab = this.tabs.get(id)
      if (tab) tab.alive = false
      this.emit('term:exit', id, 0)
      this.cleanup(id)
    }

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
    // NaN 会穿过 `<= 0` 比较（NaN <= 0 为 false）直进命令行，钳在入口
    const c = Math.round(cols)
    const r = Math.round(rows)
    if (!tab?.alive || !Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return
    const prev = this.resizeTimers.get(id)
    if (prev) clearTimeout(prev)
    this.resizeTimers.set(
      id,
      setTimeout(() => {
        this.resizeTimers.delete(id)
        if (tab.alive) this.fire(`resize-window -t ${tab.window} -x ${c} -y ${r}`)
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
      // 标记已走：此 pane 之后的迟到 %output 直接丢弃，不再进早期暂存
      this.gonePanes.add(tab.pane)
      this.earlyOutputs.delete(tab.pane)
      if (this.gonePanes.size > 1024) this.gonePanes.clear()
    }
    this.replayPending.delete(id)
    this.tabs.delete(id)
    const t = this.inputTimers.get(id)
    if (t) clearTimeout(t)
    this.inputTimers.delete(id)
    this.inputBuffers.delete(id)
    const r = this.resizeTimers.get(id)
    if (r) clearTimeout(r)
    this.resizeTimers.delete(id)
  }

  /**
   * 终结后端。keep=true 为会话保持退出：只断开 control client（detach），
   * 不 kill-session——tmux 服务器与其上的 shell 继续存活，下次启动附着恢复；
   * 默认 keep=false 沿用原语义（终结会话，服务器随之退出并移除 socket）。
   */
  async dispose(opts: { keep?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.proc && this.session) {
      if (opts.keep) {
        // 顺手清掉附着时可能迟到未列出的副产品 session（kill 按 id 幂等）
        try {
          for (const row of await this.send(`list-sessions -F '#{session_id}'`)) {
            const sid = row.trim()
            if (sid && sid !== this.session) this.fire(`kill-session -t ${sid}`)
          }
        } catch {
          // 服务器可能已无响应，继续走 detach
        }
      } else {
        try {
          await this.send(`kill-session -t ${this.session}`)
        } catch {
          // 会话可能已退出
        }
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

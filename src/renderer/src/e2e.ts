import type { Terminal } from '@xterm/xterm'
import { api, type Profile, type TermInfo } from './api'

interface E2EState {
  created: number
  latencies: number[]
  errors: string[]
  done: boolean
  activeId: string
}

interface E2ECtx {
  getProfiles: () => Profile[]
  createTab: () => Promise<unknown>
  terms: { current: Map<string, Terminal> }
}

/**
 * E2E 测试驱动：由主进程通过 executeJavaScript 调用 __e2eStart(n)，
 * 经 React 的 newTab 批量创建标签（真实上屏），并对每个标签做 shell 回显往返测延迟，
 * 结果挂在 window.__e2e 上供主进程轮询。
 */
export function setupE2E(ctx: E2ECtx): void {
  const w = window as unknown as Record<string, unknown>
  const state: E2EState = { created: 0, latencies: [], errors: [], done: true, activeId: '' }
  w.__e2e = state

  w.__e2eStart = (n: number) => {
    void (async () => {
      state.done = false
      state.created = 0
      state.latencies = []
      state.errors = []
      const profiles: Profile[] = ctx.getProfiles()
      if (!profiles.length) {
        state.errors.push('no profile available')
        state.done = true
        return
      }
      for (let i = 0; i < n; i++) {
        try {
          const info = (await ctx.createTab()) as TermInfo | undefined
          if (!info) throw new Error('createTab returned nothing')
          state.activeId = info.id
          state.created++
          const marker = `BM${i}_${Math.random().toString(36).slice(2, 8)}`
          const t0 = performance.now()
          const lat = await new Promise<number>((resolve, reject) => {
            let buf = ''
            const off = api.onData((id, d) => {
              if (id !== info.id) return
              buf += d
              if (buf.includes(marker)) {
                off()
                resolve(performance.now() - t0)
              }
            })
            api.write(info.id, `echo ${marker}\r`)
            setTimeout(() => {
              off()
              reject(new Error('marker timeout'))
            }, 3000)
          })
          state.latencies.push(lat)
        } catch (e) {
          state.errors.push(String(e))
        }
        await new Promise((r) => setTimeout(r, 120))
      }
      const last = [...ctx.terms.current.values()].pop()
      last?.focus()
      state.done = true
    })()
  }

  w.__e2eFocus = () => {
    const last = [...ctx.terms.current.values()].pop()
    last?.focus()
    return !!last
  }

  // 对活动终端的 textarea 派发真实 KeyboardEvent（验证 keydown→onData→write→shell 链路）
  const activeTerm = () => [...ctx.terms.current.values()].pop()
  w.__e2eType = (text: string) => {
    const t = activeTerm()
    if (!t?.textarea) return false
    for (const ch of text) {
      const keyCode = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0)
      t.textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: ch, keyCode, which: keyCode, bubbles: true, cancelable: true })
      )
    }
    return true
  }
  w.__e2eEnter = () => {
    const t = activeTerm()
    if (!t?.textarea) return false
    t.textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
    )
    return true
  }
  // GUI 层输入兜底：xterm 官方 paste API（onData→IPC→后端→shell→输出→渲染 全链路）。
  // 括号粘贴模式下粘贴的换行不执行，粘贴后补一个真实回车。
  w.__e2ePaste = (text: string) => {
    const t = activeTerm()
    if (!t) return false
    t.paste(text)
    api.write(state.activeId, '\r')
    return true
  }
}

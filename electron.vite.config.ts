import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 生产打包剔除 smoke/e2e 编排（安全加固：测试钩子不进分发物）。
// dist/dist:dir 置 TERM_MGR_E2E=0 → __E2E__=false；默认构建（smoke/e2e 回归用）
// 保留。常量声明见 src/shared/globals.d.ts。
const keepE2E = process.env.TERM_MGR_E2E !== '0'

// ── CSP 构建期收紧 ──
// 与 src/renderer/index.html 里的基础版同源：构建时把 meta 内容替换为严格版
//（default-src 收 'none'、显式 connect-src 'none'、object/base/form 全禁）。
// 严格版把「应用本体零网络」从约定升级为技术强制——fetch/XHR/WebSocket/
// sendBeacon 全拒；代码级插件跑在 tmplug:// 沙箱 iframe 里（Tier 2），有
// 自己的逐插件 CSP，这里只负责放行 frame-src。dev 不替换：vite HMR 的
// ws 连接依赖 default-src 'self'。替换用 split/join 全量替换（replace 只换首个）
const CSP_BASE =
  "default-src 'self'; script-src 'self' tmplug:; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' tmplug: data:; font-src 'self' tmplug: data:; frame-src tmplug:"
const CSP_STRICT =
  "default-src 'none'; script-src 'self' tmplug:; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' tmplug: data:; font-src 'self' tmplug: data:; frame-src tmplug:; connect-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"

function strictCsp(): Plugin {
  let building = false
  return {
    name: 'tm-strict-csp',
    config(_cfg, env) {
      building = env.command === 'build'
    },
    transformIndexHtml(html) {
      if (!building) return html
      return html.split(CSP_BASE).join(CSP_STRICT)
    }
  }
}

export default defineConfig({
  main: {
    define: { __E2E__: JSON.stringify(keepE2E) },
    // 默认配置下 rollup 不会摇掉 __E2E__=false 分支里失去引用的函数声明，
    // 'smallest' 把它们连同死分支一起剔除（入口模块顶层语句始终保留，安全）
    build: { rollupOptions: { treeshake: 'smallest' } }
  },
  preload: {},
  renderer: {
    define: { __E2E__: JSON.stringify(keepE2E) },
    plugins: [react(), strictCsp()]
  }
})

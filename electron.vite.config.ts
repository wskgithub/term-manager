import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 生产打包剔除 smoke/e2e 编排（安全加固：测试钩子不进分发物）。
// dist/dist:dir 置 TERM_MGR_E2E=0 → __E2E__=false；默认构建（smoke/e2e 回归用）
// 保留。常量声明见 src/shared/globals.d.ts。
const keepE2E = process.env.TERM_MGR_E2E !== '0'

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
    plugins: [react()]
  }
})

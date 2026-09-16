// 构建期常量（electron.vite.config.ts 的 define 注入，运行时不存在对应变量）：
// 默认 true；dist 打包前置 TERM_MGR_E2E=0 时为 false，rollup 会把引用它的
// smoke/e2e 编排分支摇掉，测试钩子不进分发物。两侧 tsconfig 都 include 本目录。
declare const __E2E__: boolean

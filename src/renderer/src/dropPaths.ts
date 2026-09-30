// 文件拖入终端：DataTransfer File[] → 带引用的绝对路径串。
// 与 GNOME Terminal 拖入文件的行为对齐：每个路径用单引号包裹、多文件空格
// 分隔，空格/换行/通配符/命令替换等 shell 元字符全部字面化，不经 shell 二次
// 解释（注入走 term.paste，bracketed paste 下原样进命令行不执行）
import { api } from './api'

// POSIX 单引号内嵌单引号：结束引号 + 转义引号 + 重开引号（'\''），引用后的
// 串对任意 shell 都是一段不含特殊语义的字面文本
export function quotePath(p: string): string {
  return `'${p.replaceAll("'", `'\\''`)}'`
}

// 拖入多文件时拼成一条命令行参数串（空格分隔，与手工键入多参数同构）
export function quotePaths(paths: string[]): string {
  return paths.map(quotePath).join(' ')
}

// e2e 注入点（生产恒为 null）：合成 DragEvent 里的 File 没有真实拖拽元数据，
// webUtils.getPathForFile 对其只能返回空串；--e2e-drop 套件用它在派发事件前
// 按序预置解析结果，跑通「drop → 解析 → 转义 → 注入」全链
let dropPathOverride: string[] | null = null
export function setDropPathOverride(paths: string[] | null): void {
  dropPathOverride = paths
}

// File[] → 绝对路径数组：空路径（非文件拖拽 / 合成事件 / 权限外来源）直接
// 丢弃，不让它们以空串形式混进命令行
export function resolveDropPaths(files: File[]): string[] {
  const paths = dropPathOverride ?? api.pathForFiles(files)
  return paths.filter((p) => p.length > 0)
}

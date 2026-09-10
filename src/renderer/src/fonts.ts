// 中文等宽回退：显式选择纯拉丁字体（如 FiraCode）时保证中文不落进非等宽字体
const CJK_FALLBACK = '"Noto Sans Mono CJK SC"'

// 自动模式：Nerd Font 优先（powerline/图标字形），其次常见等宽字体
const AUTO_STACK = `"JetBrainsMono Nerd Font", "FiraCode Nerd Font", "JetBrains Mono", ${CJK_FALLBACK}, "DejaVu Sans Mono", monospace`

/** 把设置里的字体族解析为 CSS font-family 栈（空串 = 自动） */
export function resolveFontStack(family: string): string {
  if (!family) return AUTO_STACK
  const quoted = '"' + family.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  return `${quoted}, ${CJK_FALLBACK}, "DejaVu Sans Mono", monospace`
}

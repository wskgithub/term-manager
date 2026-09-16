import type { TabGroup, TermInfo } from './api'

/** 分段渲染：tabs 数组顺序即标签栏顺序（固定区在头部、同组连续由 App 维护），
    连续的同组标签合并为一个组段，其余为裸标签段。标签栏（横向）与分组侧栏
    （纵向树）共用同一分段结果，保证两处视图的顺序与分组语义永远一致 */
export type Seg =
  | { kind: 'tab'; tab: TermInfo; index: number }
  | { kind: 'group'; group: TabGroup; tabs: { tab: TermInfo; index: number }[] }

export function buildSegs(tabs: TermInfo[], groups: TabGroup[]): Seg[] {
  const segs: Seg[] = []
  tabs.forEach((tab, index) => {
    const g = tab.groupId ? groups.find((x) => x.id === tab.groupId) : undefined
    if (g) {
      const last = segs[segs.length - 1]
      if (last && last.kind === 'group' && last.group.id === g.id) last.tabs.push({ tab, index })
      else segs.push({ kind: 'group', group: g, tabs: [{ tab, index }] })
    } else {
      segs.push({ kind: 'tab', tab, index })
    }
  })
  return segs
}

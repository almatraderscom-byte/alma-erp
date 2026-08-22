/**
 * Storage compaction for usage.timeline (handoff F-14 — reliability epic R-4).
 *
 * Both runners persisted only `timeline.slice(0, 60)`: on a long turn the cut
 * fell on whatever came last — which is exactly where the final answer, the
 * verify rows and the late progress lines live. The prose lifecycle v2 document
 * already keeps every committed prose block, but the timeline is still what the
 * v1 projection, the legacy web fallback and the activity rows read.
 *
 * Rule: never drop an owner-prose entry, a verification row or a file row.
 * Under pressure, drop the OLDEST thinking rows first, then the oldest tool
 * rows; only if prose alone exceeds the cap keep the most recent entries (the
 * terminal block is always last, so it is always kept).
 */

export type CompactableTimelineEntry = { t?: unknown; [k: string]: unknown }

const ALWAYS_KEEP = new Set(['text', 'verify', 'file'])

export function compactTimelineForStorage<T extends CompactableTimelineEntry>(
  timeline: readonly T[],
  cap = 60,
): T[] {
  return compactTimelineWithIndexMap(timeline, cap).timeline
}

/**
 * Same compaction, plus the old→new index map the prose-lifecycle document
 * needs: its blocks are anchored by ORIGINAL timeline index (Codex P1 #838 —
 * storing shifted entries with unshifted anchors put cold prose beside the
 * wrong activity). A dropped entry maps to -1.
 */
export function compactTimelineWithIndexMap<T extends CompactableTimelineEntry>(
  timeline: readonly T[],
  cap = 60,
): { timeline: T[]; indexMap: number[] } {
  if (timeline.length <= cap) {
    return { timeline: [...timeline], indexMap: timeline.map((_, i) => i) }
  }
  const kept: Array<{ entry: T; index: number }> = timeline.map((entry, index) => ({ entry, index }))
  const drop = (kind: string) => {
    for (let i = 0; i < kept.length && kept.length > cap; ) {
      if (kept[i].entry.t === kind) kept.splice(i, 1)
      else i += 1
    }
  }
  drop('think')
  if (kept.length > cap) drop('tool')
  if (kept.length > cap) {
    // Unknown kinds next; then, as a last resort, the oldest of everything.
    for (let i = 0; i < kept.length && kept.length > cap; ) {
      if (!ALWAYS_KEEP.has(String(kept[i].entry.t))) kept.splice(i, 1)
      else i += 1
    }
    while (kept.length > cap) kept.shift()
  }
  const indexMap = new Array<number>(timeline.length).fill(-1)
  kept.forEach((k, newIndex) => { indexMap[k.index] = newIndex })
  return { timeline: kept.map((k) => k.entry), indexMap }
}

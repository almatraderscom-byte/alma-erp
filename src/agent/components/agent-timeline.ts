import type { TimelineEntry } from './AgentThread'

/** Mark only the text entry that actually carried the server's preamble event. */
export function markTimelinePreamble(
  timeline: TimelineEntry[] | undefined,
  preambleText: string,
): TimelineEntry[] {
  const next = timeline ? timeline.slice() : []
  const marker = preambleText.trim()
  if (!marker) return next
  for (let index = next.length - 1; index >= 0; index--) {
    const entry = next[index]
    if (
      entry.t === 'text'
      && entry.state !== 'superseded'
      && entry.text.trimEnd().endsWith(marker)
    ) {
      next[index] = { ...entry, lead: true }
      break
    }
  }
  return next
}

/** Supersede the latest replaceable draft; an explicit speak-first lead survives. */
export function supersedeLatestTimelineDraft(
  timeline: TimelineEntry[] | undefined,
): TimelineEntry[] {
  const next = timeline ? timeline.slice() : []
  for (let index = next.length - 1; index >= 0; index--) {
    const entry = next[index]
    if (entry.t === 'text' && entry.lead !== true && entry.state !== 'superseded') {
      next[index] = { ...entry, state: 'superseded' }
      break
    }
  }
  return next
}

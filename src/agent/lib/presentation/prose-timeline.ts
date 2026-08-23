/**
 * Web-side bridge between the protocol-2 prose reducer and the thread's
 * ordered timeline (AgentThread ChronoFlow renders prose ↔ activity from ONE
 * ordered list). Pure helpers, unit-tested.
 *
 *   - live: every visible prose block owns exactly one `{t:'text', blockId}`
 *     placeholder in the timeline, created where the block first became
 *     visible; a superseded block's placeholder disappears when its
 *     replacement commits and the replacement is appended at that moment;
 *   - cold: the server's presentation v2 block list (already interleaved in
 *     true chronology) is turned into the same timeline shape, so live and
 *     cold render through one code path.
 */
import type { AgentPresentationV2 } from './build-presentation-v2'
import { visibleProseBlocks, type LiveProseBlock, type LiveProseState } from './live-prose-reducer'
import type { ProseKind } from './prose-lifecycle'

/** Structural subset of AgentThread's TimelineEntry (type-only coupling). */
export type ProseTimelineEntry =
  | { t: 'think'; text: string }
  | { t: 'text'; text: string; state?: 'superseded' | 'committed' | 'streaming'; lead?: true; blockId?: string; kind?: ProseKind }
  | { t: 'verify'; attempt?: number; max?: number }
  | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; live?: boolean; id?: string; shot?: string }
  | { t: 'file'; id: string; name: string; kind?: string }

function placeholderIndex(timeline: ProseTimelineEntry[], blockId: string): number {
  return timeline.findIndex((e) => e.t === 'text' && e.blockId === blockId)
}

/**
 * Re-derive the prose placeholders from the reducer state after an event.
 * Activity/file entries are untouched; only `{t:'text', blockId}` entries move.
 */
export function reconcileProseTimeline<T extends ProseTimelineEntry>(
  timeline: T[] | undefined,
  state: LiveProseState,
): T[] {
  const next: ProseTimelineEntry[] = (timeline ?? []).slice()
  const visible = visibleProseBlocks(state)
  const visibleIds = new Set(visible.map((b) => b.id))
  for (const b of visible) {
    // A block first shown NOW goes to the end — its true position in the
    // chronology. A committed replacement therefore lands after the verify /
    // activity rows that arrived while it was being written, exactly where the
    // server anchors it for the cold view (…draft → যাচাই → final).
    const idx = placeholderIndex(next, b.id)
    const entry: ProseTimelineEntry = {
      t: 'text',
      text: b.text,
      blockId: b.id,
      kind: b.kind,
      state: b.state === 'committed' ? 'committed' : 'streaming',
    }
    if (idx >= 0) next[idx] = entry
    else next.push(entry)
  }
  return next.filter((e) => !(e.t === 'text' && e.blockId && !visibleIds.has(e.blockId))) as T[]
}

/** Cold load: presentation v2 blocks → the same timeline shape the live path keeps. */
export function timelineFromPresentationV2(blocks: AgentPresentationV2['blocks']): ProseTimelineEntry[] {
  const out: ProseTimelineEntry[] = []
  for (const b of blocks) {
    if (b.type === 'prose') {
      out.push({ t: 'text', text: b.text, blockId: b.id, kind: b.kind, state: 'committed' })
    } else if (b.type === 'activity') {
      if (b.activityType === 'thinking') {
        out.push({ t: 'think', text: b.detail ?? b.label })
      } else if (b.activityType === 'tool') {
        out.push({
          t: 'tool',
          name: b.toolName ?? b.label,
          ok: b.status !== 'failed',
          input: b.input,
          result: b.result,
          shot: b.screenshot,
          id: b.id,
        })
      } else {
        const m = /\((\d+)\/(\d+)\)/.exec(b.label)
        out.push({ t: 'verify', attempt: m ? Number(m[1]) : undefined, max: m ? Number(m[2]) : undefined })
      }
    } else if (b.type === 'file') {
      out.push({ t: 'file', id: b.artifactId, name: b.title, kind: b.kind })
    }
    // confirm/ask cards render from the message's own card fields.
  }
  return out
}

/** Cold load: the committed prose blocks as reducer blocks (all visible). */
export function proseBlocksFromPresentationV2(blocks: AgentPresentationV2['blocks']): LiveProseBlock[] {
  const out: LiveProseBlock[] = []
  for (const b of blocks) {
    if (b.type !== 'prose') continue
    out.push({
      id: b.id,
      kind: b.kind,
      state: 'committed',
      revision: b.revision,
      text: b.text,
      hidden: false,
      awaitingReplacement: false,
    })
  }
  return out
}

/**
 * A CLIENT-authored terminal block for a protocol-2 message whose stream ended
 * in an error (Codex P1 on #834): the v2 render path draws only block-addressed
 * entries and never appends `msg.text`, so the warning the v1 path put in
 * `text` was invisible. Appended as a committed final block + placeholder.
 */
export function withClientErrorBlock<T extends ProseTimelineEntry>(message: {
  id: string
  proseProtocol?: 1 | 2
  prose?: LiveProseBlock[]
  timeline?: T[]
  text: string
}, errorText: string): { text: string; prose?: LiveProseBlock[]; timeline?: T[] } {
  if (message.proseProtocol !== 2) return { text: errorText }
  const id = `client-error:${message.id}`
  const prose = (message.prose ?? []).filter((b) => b.id !== id)
  prose.push({ id, kind: 'final', state: 'committed', revision: 1, text: errorText, hidden: false, awaitingReplacement: false })
  const timeline = ((message.timeline ?? []) as ProseTimelineEntry[]).filter((e) => !(e.t === 'text' && e.blockId === id))
  timeline.push({ t: 'text', text: errorText, blockId: id, kind: 'final', state: 'committed' })
  const visible = prose.filter((b) => !b.hidden && b.text.trim())
  return { text: visible.map((b) => b.text.trim()).join('\n\n'), prose, timeline: timeline as T[] }
}

/** Owner-visible prose of a cold-loaded v2 message, joined for copy/preview. */
export function proseTextFromPresentationV2(blocks: AgentPresentationV2['blocks']): string {
  return blocks
    .filter((b): b is Extract<typeof b, { type: 'prose' }> => b.type === 'prose')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

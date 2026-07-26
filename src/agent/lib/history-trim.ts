/**
 * Size-based history trimming (owner cost analysis 2026-07-26).
 *
 * His reading of his own meter was correct:
 *
 *   Σ293.9k · ↑100.0k ♻193.0k ↓842  $0.1700   ← ONE turn
 *   Σ368.9k · ↑66.9k  ♻293.2k ↓8.8k $0.1704   ← the next
 *
 * ~300k tokens re-sent per turn, and his point about why that is absurd:
 * *"প্রতিটা পেজের SEO করতে তো পুরো website বারবার লিখতে হয় না"*.
 *
 * Tail compaction already existed — but it counts TURNS (keep the last 6). In an
 * SEO chat six turns can be 300k tokens, because a single tool result is a whole
 * audit JSON or a full report. Six turns of that is a fortune, every turn.
 *
 * So the kept window gets a BYTE budget as well as a turn budget: an oversized
 * older block is replaced by its head and tail with an honest marker of what was
 * cut. The most recent messages are never touched — the model needs the thing it
 * is working on right now in full.
 */

export interface TrimmableMessage {
  role: string
  content: unknown
}

/** Characters kept from an oversized older block (head + tail). */
export const TRIM_HEAD_CHARS = 1200
export const TRIM_TAIL_CHARS = 400
/** A block bigger than this in an older turn gets trimmed. ~2k tokens. */
export const TRIM_THRESHOLD_CHARS = 8_000
/** How many of the newest messages are always kept verbatim. */
export const KEEP_VERBATIM_MESSAGES = 4

export function trimText(text: string): string {
  if (text.length <= TRIM_THRESHOLD_CHARS) return text
  const cut = text.length - (TRIM_HEAD_CHARS + TRIM_TAIL_CHARS)
  return (
    text.slice(0, TRIM_HEAD_CHARS)
    + `\n\n…[${cut.toLocaleString('en-US')} অক্ষর সংক্ষেপ করা হয়েছে — দরকার হলে টুল দিয়ে আবার পড়ো]…\n\n`
    + text.slice(-TRIM_TAIL_CHARS)
  )
}

function trimContent(content: unknown): unknown {
  if (typeof content === 'string') return trimText(content)
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block
    const b = block as Record<string, unknown>
    if (typeof b.text === 'string' && b.text.length > TRIM_THRESHOLD_CHARS) {
      return { ...b, text: trimText(b.text) }
    }
    // Tool results are the usual whale: a whole audit.json or crawl report.
    if (typeof b.content === 'string' && b.content.length > TRIM_THRESHOLD_CHARS) {
      return { ...b, content: trimText(b.content) }
    }
    return block
  })
}

/**
 * Trim oversized blocks in every message EXCEPT the newest few. Pure.
 * Returns the same array shape so callers can drop it straight in.
 */
export function trimHistoryBySize<T extends TrimmableMessage>(rows: T[]): T[] {
  if (rows.length <= KEEP_VERBATIM_MESSAGES) return rows
  const cutoff = rows.length - KEEP_VERBATIM_MESSAGES
  return rows.map((row, i) => (i >= cutoff ? row : ({ ...row, content: trimContent(row.content) })))
}

/**
 * How much transcript a SELF-CONTINUE hop replays. It resumes from the resume
 * directive + its checkpoint, so the older thread is dead weight — owner ruling
 * 2026-07-26: "আগের notes, progress এবং checkpoint থেকে শুরু করো"।
 */
export const SELF_CONTINUE_KEEP_MESSAGES = 6

/** Text of the newest user message — used to detect a self-continue hop. */
export function lastUserTextPeek(rows: TrimmableMessage[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.role !== 'user') continue
    if (typeof r.content === 'string') return r.content
    if (Array.isArray(r.content)) {
      const text = r.content
        .map((b) => {
          const rec = b as Record<string, unknown> | null
          return rec && rec.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
        })
        .join('\n')
        .trim()
      if (text) return text
    }
    return ''
  }
  return ''
}

/** Rough token estimate (4 chars ≈ 1 token) — used only for logging the saving. */
export function estimateChars(rows: TrimmableMessage[]): number {
  let n = 0
  for (const r of rows) {
    if (typeof r.content === 'string') n += r.content.length
    else if (Array.isArray(r.content)) {
      for (const b of r.content) {
        const rec = b as Record<string, unknown> | null
        if (rec && typeof rec.text === 'string') n += rec.text.length
        if (rec && typeof rec.content === 'string') n += rec.content.length
      }
    }
  }
  return n
}

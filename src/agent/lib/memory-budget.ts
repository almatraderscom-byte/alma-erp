/**
 * Hard retrieval budget for injected memory (owner-approved 2026-08-03).
 *
 * Recall used to be capped by COUNT alone (6 rows). A count cap is not a cost
 * cap: six long session summaries can be several thousand characters, and that
 * rides along in every single turn's prompt. Three ceilings are enforced here —
 * item count, per-item characters, total characters — plus a wall-clock timeout
 * on the retrieval itself, so a slow database degrades the turn to "no memory"
 * instead of stalling the owner's reply.
 *
 * Pure and deterministic: no DB, no model calls. Constants live in code (not env)
 * so a change is a reviewable commit, not a quiet SSH edit.
 */

/** Facts injected per turn (unchanged from the previous reranker take). */
export const MEMORY_MAX_ITEMS = 6
/** Characters kept from any single fact before it is cut. */
export const MEMORY_MAX_ITEM_CHARS = 400
/**
 * Total characters across all injected facts.
 *
 * Deliberately BELOW items × per-item (6 × 400 = 2400): a ceiling equal to the
 * product can never fire, which would make this constant decoration. At 1800 a
 * turn that retrieves six long facts really does give up the weakest ones — and
 * Bangla costs roughly two to three tokens per word, so those characters are not
 * cheap.
 */
export const MEMORY_MAX_TOTAL_CHARS = 1800
/** Digest blocks (L3 persona + L2 scenario) injected per turn. */
export const DIGEST_MAX_ITEMS = 2
/** Total characters across digest blocks — they sit in front of the facts. */
export const DIGEST_MAX_TOTAL_CHARS = 900
/**
 * Wall clock for the whole memory retrieval; past this the turn runs memory-less.
 *
 * Covers the embedding call AND both retrieval arms, so it cannot be tight: the
 * embedding is a network round trip that normally takes a few hundred ms but can
 * spike. A turn that waits an extra second is a small cost; a turn that answers
 * as if it never knew the owner is a wrong answer, so the ceiling is generous
 * and exists only to stop a hung database from holding up a reply.
 */
export const MEMORY_RETRIEVAL_TIMEOUT_MS = 4000

export interface BudgetedItem {
  content: string
}

export interface BudgetResult<T extends BudgetedItem> {
  kept: T[]
  /** Items dropped because a ceiling was reached. */
  dropped: number
  /** Items whose content was cut to the per-item ceiling. */
  truncated: number
  chars: number
}

/**
 * Applies the ceilings in order: per-item cut, then count, then total characters.
 * Input order is respected — callers pass rows already ranked best-first, so the
 * items that survive are always the strongest ones.
 */
export function applyMemoryBudget<T extends BudgetedItem>(
  items: T[],
  opts?: { maxItems?: number; maxItemChars?: number; maxTotalChars?: number },
): BudgetResult<T> {
  const maxItems = opts?.maxItems ?? MEMORY_MAX_ITEMS
  const maxItemChars = opts?.maxItemChars ?? MEMORY_MAX_ITEM_CHARS
  const maxTotalChars = opts?.maxTotalChars ?? MEMORY_MAX_TOTAL_CHARS

  const kept: T[] = []
  let chars = 0
  let truncated = 0

  for (const item of items) {
    if (kept.length >= maxItems) break
    let content = item.content
    if (content.length > maxItemChars) {
      content = `${content.slice(0, maxItemChars - 1).trimEnd()}…`
      truncated += 1
    }
    if (chars + content.length > maxTotalChars) {
      // A later, shorter item must not leapfrog a stronger one — stop here.
      break
    }
    chars += content.length
    kept.push(content === item.content ? item : { ...item, content })
  }

  return { kept, dropped: items.length - kept.length, truncated, chars }
}

/**
 * Resolves to `fallback` if the work has not finished within `ms`.
 *
 * The pending promise is not cancelled (nothing to cancel in node-postgres) —
 * it is simply abandoned, and its rejection is swallowed so a late failure
 * cannot surface as an unhandled rejection after the turn moved on.
 *
 * `onTimeout` fires the moment the deadline passes, so abandoned work can tell
 * that it lost the race and skip side effects the turn will never see (Codex P2,
 * PR #711 — memory that was never injected must not be marked as used).
 */
export async function withMemoryTimeout<T>(
  work: Promise<T>,
  fallback: T,
  ms = MEMORY_RETRIEVAL_TIMEOUT_MS,
  label = 'memory',
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guarded = work.catch((err) => {
    console.warn(`[${label}] retrieval failed:`, err instanceof Error ? err.message : err)
    return fallback
  })
  try {
    return await Promise.race([
      guarded,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[${label}] retrieval exceeded ${ms}ms — turn runs without it`)
          onTimeout?.()
          resolve(fallback)
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

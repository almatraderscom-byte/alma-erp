/**
 * Live reconciliation for an interrupted message that was successfully saved.
 *
 * A verifier retry is special: native keeps the pinned speak-first line visible
 * and buffers only its replacement body until `done`. Re-sending the whole
 * persisted message would duplicate that line. Web keeps the same line in its
 * timeline, so the wire replacement is the persisted body (including its exact
 * separator), followed by `done` carrying the durable message id.
 */

export type SalvageReconciliationEvent =
  | {
      type: 'verification_retry'
      attempt: number
      maxAttempts: number
      categories: string[]
      snippets: string[]
    }
  | { type: 'text_delta'; delta: string }

export interface SavedSalvageReconciliationInput {
  /** Exact text written to AgentMessage.content. */
  persistedText: string
  /** Pinned speak-first line, if this turn emitted one. */
  preambleText: string
}

function replacementAfterPreamble(persistedText: string, preambleText: string): string {
  const preamble = preambleText.trim()
  if (!preamble || !persistedText.startsWith(preamble)) return persistedText
  return persistedText.slice(preamble.length)
}

/**
 * Reset any live draft/replacement buffer and make terminal `done` commit the
 * exact persisted salvage. This is deliberately unconditional: at an abort or
 * provider throw the server cannot prove which provider chunks each client
 * flushed before the exception.
 */
export function buildSavedSalvageReconciliation(
  input: SavedSalvageReconciliationInput,
): SalvageReconciliationEvent[] {
  const replacement = replacementAfterPreamble(input.persistedText, input.preambleText)
  return [
    {
      type: 'verification_retry',
      attempt: 1,
      maxAttempts: 1,
      categories: [],
      snippets: [],
    },
    ...(replacement ? [{ type: 'text_delta' as const, delta: replacement }] : []),
  ]
}

/** A durable salvage is a successful terminal result, never a terminal error. */
export function buildSavedSalvageEventSequence<
  TDone extends { type: 'done'; messageId: string },
>(
  input: SavedSalvageReconciliationInput,
  done: TDone,
): Array<SalvageReconciliationEvent | TDone> {
  return [...buildSavedSalvageReconciliation(input), done]
}

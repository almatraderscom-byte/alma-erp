/**
 * Deterministic auto-continuation policy.
 *
 * Automatic continuation is a recovery mechanism for a turn that genuinely hit
 * the hosting deadline while browser work was still in progress. It must never
 * be inferred from prose (for example a Bangla sentence ending in "করব কি?") and
 * it must never reopen a task that already crossed a terminal proof gate.
 */

export interface ContinuationToolRecord {
  toolName: string
  status: 'success' | 'error'
}

const TERMINAL_TOOLS = new Set([
  'complete_skill_pack_run',
])

export function shouldAutoContinueTurn(input: {
  deadlineHit: boolean
  hasAskCard: boolean
  tools: ContinuationToolRecord[]
}): boolean {
  if (!input.deadlineHit || input.hasAskCard) return false

  const terminalProofLanded = input.tools.some(
    (tool) => tool.status === 'success' && TERMINAL_TOOLS.has(tool.toolName),
  )
  if (terminalProofLanded) return false

  // A failed/irrelevant browser probe is not evidence that browser work remains.
  return input.tools.some(
    (tool) => tool.status === 'success' && tool.toolName.startsWith('live_browser_'),
  )
}

/** Automatic continuation and model-switch resume are control state, not speech. */
export function shouldPersistIncomingMessage(input: {
  isResume: boolean
  autoContinueFromTurnId: string | null
  internalControl?: boolean
}): boolean {
  return !input.isResume && !input.autoContinueFromTurnId && input.internalControl !== true
}

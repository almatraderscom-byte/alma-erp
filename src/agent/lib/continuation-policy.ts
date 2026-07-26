/**
 * Deterministic auto-continuation policy.
 *
 * Automatic continuation is a recovery mechanism for a turn that genuinely hit
 * the hosting deadline with work still unfinished. It must never be inferred
 * from prose (for example a Bangla sentence ending in "করব কি?") and it must
 * never reopen a task that already crossed a terminal proof gate.
 *
 * OWNER RULING 2026-07-26. This used to require a successful `live_browser_*`
 * call, so a long SEO/tool job simply STOPPED at the hosting deadline and waited
 * for Boss to type "continue" — while a browser job resumed itself. His point
 * was exact: hitting a platform limit is the agent's own problem to handle. It
 * should save its state, set its own wake-up, and carry on until the work is
 * done. Any tool work in flight now qualifies.
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

  // Real work happened and the deadline cut it short → resume. A turn that made
  // no successful tool call has nothing in flight to resume.
  return input.tools.some((tool) => tool.status === 'success')
}

/**
 * How many times a single task may wake itself before it must report instead.
 * At ~12 minutes of work per hop this is a couple of hours of continuous work —
 * long enough for a real job, short enough that a confused loop cannot run all
 * night. Bounded on purpose; the cost caps still apply on top.
 */
export const MAX_SELF_CONTINUE_HOPS = 12

export function mayContinueChain(hopsSoFar: number): boolean {
  return hopsSoFar < MAX_SELF_CONTINUE_HOPS
}

/** Automatic continuation and model-switch resume are control state, not speech. */
export function shouldPersistIncomingMessage(input: {
  isResume: boolean
  autoContinueFromTurnId: string | null
  internalControl?: boolean
}): boolean {
  return !input.isResume && !input.autoContinueFromTurnId && input.internalControl !== true
}

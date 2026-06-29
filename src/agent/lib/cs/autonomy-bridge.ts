/**
 * Phase 2 (CS auto-reply autonomy) — the BRIDGE between the live customer-service
 * pipeline and the Phase-1 autonomy foundation.
 *
 * The CS pipeline already generates a reply and scores its confidence
 * (`scoreCsReplyConfidence`); when in live `auto` mode it sends the reply and
 * escalates low-confidence ones to a human. What it did NOT do until now is consult
 * the owner's UNIFIED autonomy policy (`decideAutonomy`). So flipping the master
 * `autonomy_enabled` switch or the per-category `cs_reply` mode in the Phase-1
 * control panel had no effect on customer replies, and auto-sent replies never
 * showed up in the autonomy ledger / daily digest.
 *
 * This module closes that gap with ONE rule: **autonomy only ever TIGHTENS, never
 * loosens.** A reply that the existing confidence gate already decided to send is
 * the input here; we only decide whether to (a) still send it and record it as an
 * autonomous action, (b) HOLD it for owner approval, or (c) let the existing
 * escalation stand.
 *
 * Safety — preserves current production behaviour exactly when autonomy is OFF
 * (the default): if the master switch is disabled, or anything throws, we pass the
 * reply straight through (`send`, no ledger write). Only when the owner has opted
 * `cs_reply` into the policy does this gate add restriction.
 */
import { evaluateAction } from '@/agent/lib/autonomy-policy'

export type CsAutoSendAction = 'send' | 'hold' | 'escalate'

export interface CsAutoSendDecision {
  /** What the live pipeline should do with this reply. */
  action: CsAutoSendAction
  /** Record this send as an autonomous action in the ledger (only true for policy-driven auto). */
  record: boolean
  /** The autonomy mode that drove the decision (null when policy disabled / passthrough). */
  autonomyMode: 'auto' | 'propose' | 'ask' | null
  /** Owner-facing Bangla reason (for the approval notice / ledger). */
  reason: string
}

/**
 * Decide whether a confidence-passing CS reply may be auto-sent under the owner's
 * autonomy policy. A CS reply is treated as REVERSIBLE (it can be corrected by a
 * follow-up message), so it is eligible for the policy's 'auto' mode — but the
 * confidence floor inside `decideAutonomy` still downgrades shaky replies.
 */
export async function decideCsAutoSend(input: {
  confidenceScore: number
  /** The existing confidence gate's verdict — a true here keeps the current human escalation. */
  confidenceEscalate: boolean
  /** Short Bangla summary for the ledger / approval notice. */
  summary?: string
}): Promise<CsAutoSendDecision> {
  // Low confidence keeps the existing behaviour: hand to a human. Never overridden here.
  if (input.confidenceEscalate) {
    return { action: 'escalate', record: false, autonomyMode: null, reason: 'কনফিডেন্স কম — মানুষের কাছে পাঠালাম।' }
  }

  let decision: Awaited<ReturnType<typeof evaluateAction>>
  try {
    decision = await evaluateAction({
      category: 'cs_reply',
      reversible: true, // a CS reply can be corrected by a follow-up message
      confidence: input.confidenceScore,
      summary: input.summary,
    })
  } catch (err) {
    // Defensive: a policy-read glitch must NEVER break the live customer pipeline.
    console.warn('[cs-autonomy-bridge] evaluateAction failed:', err instanceof Error ? err.message : err)
    return { action: 'send', record: false, autonomyMode: null, reason: '' }
  }

  // Master switch OFF (the production default) → preserve exact current behaviour:
  // the confidence gate already cleared this reply, so send it, no ledger noise.
  if (!decision.policyEnabled) {
    return { action: 'send', record: false, autonomyMode: null, reason: '' }
  }

  if (decision.mode === 'auto') {
    return { action: 'send', record: true, autonomyMode: 'auto', reason: decision.reason }
  }

  // 'propose' / 'ask' → hold for the owner (draft, do not auto-send).
  return { action: 'hold', record: false, autonomyMode: decision.mode, reason: decision.reason }
}

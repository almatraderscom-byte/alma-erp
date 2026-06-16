/**
 * Opus critical-escalation gate.
 *
 * Sonnet 4.6 is the brain for ~90% of work. This gate decides the rare ~10% that
 * should be re-run on Opus 4.8: high-risk + low-confidence decisions, or money
 * decisions above the owner-set taka threshold — subject to the owner's daily cap.
 */
import { DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import {
  getModelRoutingConfig,
  getOpusUsedToday,
  bumpOpusUsedToday,
  type ModelRoutingConfig,
} from './routing-config'

export const OPUS_MODEL_ID = 'claude-opus-4-8'

export interface CriticalSignal {
  /** Sonnet's self-reported risk for the decision. */
  risk?: 'low' | 'medium' | 'high'
  /** Sonnet's self-reported confidence, 0..1. */
  confidence?: number
  /** Money on the line, in taka (for finance / ads-spend decisions). */
  amountTaka?: number
  /** For logging / CCTV. */
  taskType?: string
}

export interface OpusDecision {
  model: string
  escalated: boolean
  reason: string
}

/** Pure decision — no IO, easy to unit test. */
export function evaluateOpusEscalation(
  signal: CriticalSignal,
  config: ModelRoutingConfig,
  opusUsedToday: number,
): OpusDecision {
  if (!config.opusEnabled) {
    return { model: DEFAULT_MODEL_ID, escalated: false, reason: 'opus disabled by owner' }
  }
  if (opusUsedToday >= config.opusDailyCap) {
    return { model: DEFAULT_MODEL_ID, escalated: false, reason: `opus daily cap reached (${config.opusDailyCap})` }
  }
  const highRiskLowConf =
    signal.risk === 'high' && (signal.confidence ?? 1) < config.opusConfidenceThreshold
  const bigMoney = (signal.amountTaka ?? 0) >= config.opusCriticalTaka
  if (bigMoney) {
    return { model: OPUS_MODEL_ID, escalated: true, reason: `money ≥ ৳${config.opusCriticalTaka}` }
  }
  if (highRiskLowConf) {
    return {
      model: OPUS_MODEL_ID,
      escalated: true,
      reason: `high risk, confidence ${(signal.confidence ?? 0).toFixed(2)} < ${config.opusConfidenceThreshold}`,
    }
  }
  return { model: DEFAULT_MODEL_ID, escalated: false, reason: 'within Sonnet bounds' }
}

/**
 * Reads owner config + today's counter, decides, and (if escalating) bumps the
 * daily Opus counter so the cap is enforced across calls.
 */
export async function decideCriticalModel(signal: CriticalSignal): Promise<OpusDecision> {
  const [config, used] = await Promise.all([getModelRoutingConfig(), getOpusUsedToday()])
  const decision = evaluateOpusEscalation(signal, config, used)
  if (decision.escalated) {
    try {
      await bumpOpusUsedToday()
    } catch {
      /* counter is best-effort; never block the decision */
    }
  }
  return decision
}

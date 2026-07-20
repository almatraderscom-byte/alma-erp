/**
 * Risk admission classification (G02 / SPEC-018).
 *
 * Deterministic risk tier — LOW / MED / HIGH — from what a request would DO.
 * Money movement, destructive actions, and external side effects escalate to
 * HIGH; HIGH requests are later gated by the Policy/Approval engine (G11/G12).
 * Fail-closed: an ambiguous money-adjacent request escalates rather than
 * de-escalates. No model (INV-01).
 */
import type { AdmissionStage } from './gateway';
import type { NormalizedRequest } from './normalize';

export const RISK_TIERS = ['LOW', 'MED', 'HIGH'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

// Money movement + destructive → HIGH (must be approved downstream).
const HIGH_RISK = /\b(pay|payment|transfer|refund|withdraw|salary|wage|delete|remove|drop|wipe|erase|cancel order|send money|taka pathao|taka dao|beton|mucho|delete koro)\b/i;
// External side effects that change state but are not money/destructive → MED.
const MED_RISK = /\b(send|post|publish|order|update|edit|schedule|message|notify|reply|invoice|pathao|post koro|update koro)\b/i;
// Explicit money mention without a clear verb still escalates (fail-closed).
const MONEY_HINT = /\b(taka|tk|৳|bdt|aed|amount|balance|due|payable|salary)\b/i;
// Interrogatives: a read-only question must not escalate on a mere noun match
// (e.g. "what is the order status?"). Money/destructive terms still win above.
const QUESTION_STARTERS = /^(who|what|when|where|why|how|which|is|are|can|could|do|does|did|should|koto|ki|kokhon|keno|kivabe|kothay)\b/i;

export interface RiskResult {
  risk: RiskTier;
  reasons: string[];
}

export function classifyRisk(n: NormalizedRequest): RiskResult {
  const reasons: string[] = [];
  const text = n.text;

  // Money / destructive always wins, even if phrased as a question (fail-closed).
  if (HIGH_RISK.test(text)) {
    reasons.push('money-or-destructive');
    return { risk: 'HIGH', reasons };
  }

  const money = MONEY_HINT.test(text);
  const isQuestion = text.trim().endsWith('?') || QUESTION_STARTERS.test(text.trim());

  // A read-only question does not escalate on side-effect nouns; money context
  // still lifts it to MED (asking about balances etc.).
  if (isQuestion) {
    if (money) { reasons.push('money-context'); return { risk: 'MED', reasons }; }
    return { risk: 'LOW', reasons };
  }

  const med = MED_RISK.test(text);

  // Fail-closed: money context + any side-effecting verb → HIGH, not MED.
  if (money && med) {
    reasons.push('money-context+side-effect');
    return { risk: 'HIGH', reasons };
  }
  if (med) {
    reasons.push('side-effect');
    return { risk: 'MED', reasons };
  }
  if (money) {
    reasons.push('money-context');
    return { risk: 'MED', reasons };
  }
  return { risk: 'LOW', reasons };
}

export const riskStage: AdmissionStage = {
  id: 'risk',
  run(ctx) {
    const normalized = ctx.annotations.normalized as NormalizedRequest | undefined;
    if (!normalized) return { ok: true, ctx };
    const result = classifyRisk(normalized);
    return { ok: true, ctx: { ...ctx, annotations: { ...ctx.annotations, risk: result.risk, riskResult: result } } };
  },
};

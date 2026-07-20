/**
 * Cost denial and degradation policy (G04 / SPEC-039).
 *
 * When the governor returns BUDGET_EXCEEDED the caller consults this policy. The
 * default is DENY — fail-closed, the call simply does not happen. DEGRADE is
 * OPT-IN (owner decision): only when a cheaper alternative that fits the budget
 * is explicitly available does the policy suggest it; otherwise it still DENIES.
 * The system never silently drops to a cheaper model on its own. Deterministic.
 */
export type DenialPolicy = 'deny' | 'degrade';

export interface DegradeOption {
  /** a cheaper model id to retry with */
  model: string;
  /** its worst-case cost for this call, nano-USD */
  worstCaseNanoUsd: number;
  /** optional reduced output-token ceiling */
  maxOutputTokens?: number;
}

export type DenialResolution =
  | { action: 'DENY'; reason: string }
  | { action: 'DEGRADE'; option: DegradeOption };

export interface DenialContext {
  /** remaining budget on the tightest scope, nano-USD */
  availableNanoUsd: number;
  /** cheaper alternatives, if the caller supplied any (opt-in) */
  degradeOptions?: DegradeOption[];
}

/**
 * Resolve what to do on a budget denial. DEGRADE only when policy is 'degrade'
 * AND a supplied option fits the remaining budget; otherwise DENY (fail-closed).
 */
export function resolveDenial(policy: DenialPolicy, ctx: DenialContext): DenialResolution {
  if (policy !== 'degrade') {
    return { action: 'DENY', reason: 'policy=deny (fail-closed default)' };
  }
  const affordable = (ctx.degradeOptions ?? [])
    .filter((o) => o.worstCaseNanoUsd <= ctx.availableNanoUsd)
    .sort((a, b) => a.worstCaseNanoUsd - b.worstCaseNanoUsd);
  if (affordable.length === 0) {
    return { action: 'DENY', reason: 'no cheaper option fits the remaining budget' };
  }
  return { action: 'DEGRADE', option: affordable[0] };
}

/** The safe default policy. */
export const DEFAULT_DENIAL_POLICY: DenialPolicy = 'deny';

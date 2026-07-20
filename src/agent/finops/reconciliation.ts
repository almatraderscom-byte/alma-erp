/**
 * Actual usage reconciliation (G03 / SPEC-027).
 *
 * After a call returns, compares the pre-call ESTIMATE against the provider's
 * ACTUAL reported usage and records the variance. If the provider did not report
 * usage, the outcome is UNKNOWN — it enters reconciliation, it is never silently
 * assumed (INV-06). Integer nano-USD, pure.
 */
import type { ProviderPrice } from '../providers/pricing/registry';
import type { TokenUsage } from './tokens';
import { costForUsage } from './usage-cost';

export type ReconcileStatus = 'RECONCILED' | 'OVER' | 'UNDER' | 'UNKNOWN';

export interface ReconcileResult {
  estimatedNanoUsd: number;
  actualNanoUsd: number | null; // null when usage was not reported
  varianceNanoUsd: number | null; // actual - estimated, null when unknown
  status: ReconcileStatus;
}

/**
 * @param actual the provider's reported usage, or `null` when none was returned.
 */
export function reconcile(
  price: ProviderPrice,
  estimatedNanoUsd: number,
  actual: TokenUsage | null,
): ReconcileResult {
  if (actual === null) {
    return { estimatedNanoUsd, actualNanoUsd: null, varianceNanoUsd: null, status: 'UNKNOWN' };
  }
  const actualNanoUsd = costForUsage(price, actual).totalNanoUsd;
  const varianceNanoUsd = actualNanoUsd - estimatedNanoUsd;
  const status: ReconcileStatus =
    varianceNanoUsd === 0 ? 'RECONCILED' : varianceNanoUsd > 0 ? 'OVER' : 'UNDER';
  return { estimatedNanoUsd, actualNanoUsd, varianceNanoUsd, status };
}

/** True when an outcome needs follow-up (unknown usage must be reconciled). */
export function needsReconciliation(r: ReconcileResult): boolean {
  return r.status === 'UNKNOWN';
}

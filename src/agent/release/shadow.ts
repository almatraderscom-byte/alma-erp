/**
 * Shadow-traffic framework (G20 / SPEC-195).
 *
 * To de-risk a change, a candidate path runs ALONGSIDE the authoritative one on
 * real traffic, and their results are compared — but the candidate NEVER affects
 * the owner-facing output (shadow = observe only). This module deterministically
 * compares an authoritative result against a shadow result and records
 * divergences, so a change is proven equivalent before it goes live (INV-08/INV-09).
 * Pure (INV-01).
 */
export interface ShadowComparison {
  authoritativeStatus: string;
  shadowStatus: string;
  statusMatch: boolean;
  valueMatch: boolean;
  match: boolean;
  divergences: string[];
}

/** Compare an authoritative result to a shadow result. The shadow is observe-only. */
export function compareShadow(
  authoritative: { status: string; value?: unknown },
  shadow: { status: string; value?: unknown },
): ShadowComparison {
  const divergences: string[] = [];
  const statusMatch = authoritative.status === shadow.status;
  if (!statusMatch) divergences.push(`status: ${authoritative.status} != ${shadow.status}`);
  const valueMatch = JSON.stringify(authoritative.value ?? null) === JSON.stringify(shadow.value ?? null);
  if (!valueMatch) divergences.push('value differs');
  return { authoritativeStatus: authoritative.status, shadowStatus: shadow.status, statusMatch, valueMatch, match: statusMatch && valueMatch, divergences };
}

/** Aggregate a batch of shadow comparisons into a divergence rate. */
export function shadowDivergenceRate(comparisons: ShadowComparison[]): { total: number; matched: number; divergenceRate: number } {
  const total = comparisons.length;
  const matched = comparisons.filter((c) => c.match).length;
  return { total, matched, divergenceRate: total === 0 ? 0 : (total - matched) / total };
}

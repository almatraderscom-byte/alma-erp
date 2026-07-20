/**
 * Pricing freshness and provider-doc verification (G03 / SPEC-030).
 *
 * Flags prices that are stale (past the freshness window), unverified, or missing
 * a source. Because every seed price is a documented ESTIMATE, "unverified" is a
 * WARNING (expected on day one) while "stale" and "missing source" are ERRORS
 * that fail the gate. Deterministic: `nowMs` is supplied by the caller.
 */
import { PRICING_REGISTRY, type ProviderPrice } from '../providers/pricing/registry';

export type FreshnessSeverity = 'warn' | 'error';

export interface FreshnessIssue {
  model: string;
  code: 'UNVERIFIED' | 'STALE' | 'NO_SOURCE';
  severity: FreshnessSeverity;
  detail: string;
}

export interface FreshnessReport {
  ok: boolean; // false if any ERROR-severity issue exists
  issues: FreshnessIssue[];
  checked: number;
}

const DAY_MS = 86_400_000;

export function checkPricingFreshness(
  nowMs: number,
  opts: { maxAgeDays?: number; registry?: ProviderPrice[] } = {},
): FreshnessReport {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const registry = opts.registry ?? PRICING_REGISTRY;
  const issues: FreshnessIssue[] = [];

  for (const p of registry) {
    const id = `${p.provider}/${p.model}@v${p.version}`;
    if (!p.source || p.source.trim() === '') {
      issues.push({ model: id, code: 'NO_SOURCE', severity: 'error', detail: 'price has no source reference' });
    }
    const effective = Date.parse(p.effectiveDate);
    if (!Number.isNaN(effective)) {
      const ageDays = (nowMs - effective) / DAY_MS;
      if (ageDays > maxAgeDays) {
        issues.push({ model: id, code: 'STALE', severity: 'error', detail: `price is ${Math.floor(ageDays)}d old (> ${maxAgeDays}d)` });
      }
    }
    if (!p.verified) {
      issues.push({ model: id, code: 'UNVERIFIED', severity: 'warn', detail: 'estimate not yet verified against provider doc' });
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues, checked: registry.length };
}

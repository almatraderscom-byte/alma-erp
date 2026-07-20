import { describe, it, expect } from 'vitest';
import { checkPricingFreshness } from '../freshness';
import type { ProviderPrice } from '../../providers/pricing/registry';

const base: ProviderPrice = {
  provider: 'google', model: 'm', version: 1, unit: 'per_mtok',
  inputNanoUsdPerMTok: 1, outputNanoUsdPerMTok: 1,
  source: 'https://doc', effectiveDate: '2026-07-20', verified: true,
};
const NOW = Date.parse('2026-07-25'); // 5 days after effective

describe('checkPricingFreshness', () => {
  it('passes fresh, verified, sourced prices (no errors)', () => {
    const r = checkPricingFreshness(NOW, { registry: [base] });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('warns (not errors) on unverified estimates — expected on day one', () => {
    const r = checkPricingFreshness(NOW, { registry: [{ ...base, verified: false }] });
    expect(r.ok).toBe(true); // warn does not fail the gate
    expect(r.issues.some((i) => i.code === 'UNVERIFIED' && i.severity === 'warn')).toBe(true);
  });

  it('errors + fails on a stale price', () => {
    const old = Date.parse('2026-09-01'); // >30d after effective
    const r = checkPricingFreshness(old, { registry: [base], maxAgeDays: 30 });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'STALE' && i.severity === 'error')).toBe(true);
  });

  it('errors + fails on a missing source', () => {
    const r = checkPricingFreshness(NOW, { registry: [{ ...base, source: '' }] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'NO_SOURCE')).toBe(true);
  });

  it('runs against the real registry (all sourced; unverified = warnings only)', () => {
    const r = checkPricingFreshness(Date.parse('2026-07-25'));
    expect(r.checked).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.code !== 'NO_SOURCE')).toBe(true); // all seeds have a source
    expect(r.ok).toBe(true); // within window; unverified are warnings
  });
});

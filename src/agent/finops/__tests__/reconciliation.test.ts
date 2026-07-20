import { describe, it, expect } from 'vitest';
import { needsReconciliation, reconcile } from '../reconciliation';
import { EMPTY_USAGE } from '../tokens';
import { getPrice, usdToNano } from '../../providers/pricing/registry';

const gemini = getPrice('google', 'gemini-3.1-pro')!;
const usage = (over: Partial<typeof EMPTY_USAGE>) => ({ ...EMPTY_USAGE, ...over });

describe('reconcile', () => {
  it('RECONCILED when actual matches estimate', () => {
    const actual = usage({ inputTokens: 1_000_000 }); // $2
    const r = reconcile(gemini, usdToNano(2), actual);
    expect(r.status).toBe('RECONCILED');
    expect(r.varianceNanoUsd).toBe(0);
  });

  it('OVER when actual exceeds estimate', () => {
    const r = reconcile(gemini, usdToNano(1), usage({ inputTokens: 1_000_000 }));
    expect(r.status).toBe('OVER');
    expect(r.varianceNanoUsd).toBe(usdToNano(1));
  });

  it('UNDER when actual is below estimate', () => {
    const r = reconcile(gemini, usdToNano(5), usage({ inputTokens: 1_000_000 }));
    expect(r.status).toBe('UNDER');
    expect(r.varianceNanoUsd).toBe(usdToNano(2) - usdToNano(5));
  });

  it('UNKNOWN when the provider reported no usage (INV-06: reconcile, not guess)', () => {
    const r = reconcile(gemini, usdToNano(2), null);
    expect(r.status).toBe('UNKNOWN');
    expect(r.actualNanoUsd).toBeNull();
    expect(r.varianceNanoUsd).toBeNull();
    expect(needsReconciliation(r)).toBe(true);
  });

  it('a known outcome does not need reconciliation', () => {
    expect(needsReconciliation(reconcile(gemini, usdToNano(2), usage({ inputTokens: 1_000_000 })))).toBe(false);
  });
});

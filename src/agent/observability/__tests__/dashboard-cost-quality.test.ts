import { describe, it, expect } from 'vitest';
import { buildCostQualityDashboard, type CostQualityRow } from '../dashboard-cost-quality';

const rows: CostQualityRow[] = [
  { dimension: 'model:gemini', nanoUsd: 300, succeeded: true, claimVerified: true },
  { dimension: 'model:gemini', nanoUsd: 200, succeeded: true, claimVerified: false },
  { dimension: 'model:deepseek', nanoUsd: 100, succeeded: false, claimVerified: false },
];

describe('cost & quality dashboard (SPEC-193)', () => {
  it('totals spend and computes per-dimension share sorted desc', () => {
    const d = buildCostQualityDashboard(rows);
    expect(d.totalNanoUsd).toBe(600);
    expect(d.byDimension[0]).toMatchObject({ dimension: 'model:gemini', nanoUsd: 500 });
    expect(d.byDimension[0].share).toBeCloseTo(500 / 600);
  });
  it('computes success and verified-claim rates', () => {
    const d = buildCostQualityDashboard(rows);
    expect(d.successRate).toBeCloseTo(2 / 3);
    expect(d.verifiedClaimRate).toBeCloseTo(1 / 3);
  });
  it('ignores malformed (float/negative) cost rows', () => {
    const d = buildCostQualityDashboard([{ dimension: 'x', nanoUsd: 1.5, succeeded: true, claimVerified: true }]);
    expect(d.rows).toBe(0);
    expect(d.totalNanoUsd).toBe(0);
  });
});

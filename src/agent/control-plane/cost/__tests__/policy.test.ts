import { describe, it, expect } from 'vitest';
import { DEFAULT_DENIAL_POLICY, resolveDenial, type DegradeOption } from '../policy';

const cheaper: DegradeOption = { model: 'or-deepseek-v4-flash', worstCaseNanoUsd: 50 };
const pricey: DegradeOption = { model: 'claude-opus-4-8', worstCaseNanoUsd: 5000 };

describe('resolveDenial', () => {
  it('default policy is deny (fail-closed)', () => {
    expect(DEFAULT_DENIAL_POLICY).toBe('deny');
  });

  it('DENIES under the deny policy even if cheaper options exist', () => {
    const r = resolveDenial('deny', { availableNanoUsd: 1000, degradeOptions: [cheaper] });
    expect(r.action).toBe('DENY');
  });

  it('DEGRADES to the cheapest affordable option under the degrade policy', () => {
    const r = resolveDenial('degrade', { availableNanoUsd: 100, degradeOptions: [pricey, cheaper] });
    expect(r.action).toBe('DEGRADE');
    if (r.action === 'DEGRADE') expect(r.option.model).toBe('or-deepseek-v4-flash');
  });

  it('DENIES under degrade when NO option fits the remaining budget (fail-closed)', () => {
    const r = resolveDenial('degrade', { availableNanoUsd: 10, degradeOptions: [pricey, cheaper] });
    expect(r.action).toBe('DENY');
  });

  it('DENIES under degrade when no options are supplied (never invents one)', () => {
    const r = resolveDenial('degrade', { availableNanoUsd: 1000 });
    expect(r.action).toBe('DENY');
  });
});

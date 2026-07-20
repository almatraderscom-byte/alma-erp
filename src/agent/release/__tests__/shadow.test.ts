import { describe, it, expect } from 'vitest';
import { compareShadow, shadowDivergenceRate } from '../shadow';

describe('shadow-traffic framework (SPEC-195)', () => {
  it('reports a full match', () => {
    const c = compareShadow({ status: 'COMPLETED', value: { x: 1 } }, { status: 'COMPLETED', value: { x: 1 } });
    expect(c.match).toBe(true);
    expect(c.divergences).toEqual([]);
  });
  it('records a status divergence', () => {
    const c = compareShadow({ status: 'COMPLETED' }, { status: 'FAILED_FINAL' });
    expect(c.match).toBe(false);
    expect(c.divergences.join()).toContain('status');
  });
  it('records a value divergence', () => {
    const c = compareShadow({ status: 'COMPLETED', value: { x: 1 } }, { status: 'COMPLETED', value: { x: 2 } });
    expect(c.valueMatch).toBe(false);
  });
  it('aggregates a divergence rate', () => {
    const cs = [
      compareShadow({ status: 'A' }, { status: 'A' }),
      compareShadow({ status: 'A' }, { status: 'B' }),
    ];
    expect(shadowDivergenceRate(cs).divergenceRate).toBe(0.5);
  });
});

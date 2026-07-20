import { describe, it, expect } from 'vitest';
import {
  NANO_PER_USD,
  PRICING_REGISTRY,
  getPrice,
  nanoToUsd,
  providerPriceSchema,
  usdToNano,
  validateRegistry,
} from '../../providers/pricing/registry';

describe('nano-USD units (no floats, no BDT)', () => {
  it('converts USD <-> nano-USD as integers', () => {
    expect(usdToNano(2)).toBe(2 * NANO_PER_USD);
    expect(Number.isInteger(usdToNano(0.006))).toBe(true);
    expect(nanoToUsd(usdToNano(2))).toBe(2);
  });

  it('keeps tiny fractional-USD prices non-zero (unlike whole-taka rounding)', () => {
    expect(usdToNano(0.0000004)).toBeGreaterThan(0); // 0.4 micro-USD per token-ish
  });
});

describe('PRICING_REGISTRY', () => {
  it('validates against the schema', () => {
    const { ok, errors } = validateRegistry();
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('every entry is an unverified, sourced, dated estimate', () => {
    for (const p of PRICING_REGISTRY) {
      expect(p.verified).toBe(false); // must be verified by SPEC-030
      expect(p.source.length).toBeGreaterThan(0);
      expect(p.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(providerPriceSchema.safeParse(p).success).toBe(true);
    }
  });

  it('includes the real head + worker + media models', () => {
    expect(getPrice('google', 'gemini-3.1-pro')).not.toBeNull();
    expect(getPrice('openrouter', 'or-deepseek-v4-flash')).not.toBeNull();
    expect(getPrice('openrouter', 'or-qwen3-max')).not.toBeNull();
    expect(getPrice('anthropic', 'claude-opus-4-8')).not.toBeNull();
    expect(getPrice('openai', 'whisper-1')?.unit).toBe('per_minute');
  });
});

describe('getPrice', () => {
  it('returns null for an unknown model', () => {
    expect(getPrice('google', 'no-such-model')).toBeNull();
  });
  it('returns the highest version by default', () => {
    const p = getPrice('google', 'gemini-3.1-pro');
    expect(p?.version).toBe(1);
  });
});

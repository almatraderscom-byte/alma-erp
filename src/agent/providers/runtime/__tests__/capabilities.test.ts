import { describe, it, expect } from 'vitest';
import { CAPABILITY_REGISTRY, discoverCapabilities, supportsCapability, createCapabilityGate, CAPABILITIES } from '../capabilities';

describe('SPEC-157 provider capability discovery', () => {
  it('every registry entry declares all known capabilities', () => {
    for (const c of CAPABILITY_REGISTRY) {
      for (const cap of CAPABILITIES) expect(typeof c[cap]).toBe('boolean');
      expect(c.maxInputTokens).toBeGreaterThan(0);
      expect(c.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('discovers a known model and returns null for an unknown one', () => {
    expect(discoverCapabilities('google', 'gemini-3.1-pro')?.vision).toBe(true);
    expect(discoverCapabilities('openrouter', 'or-deepseek-v4-flash')?.vision).toBe(false);
    expect(discoverCapabilities('nobody', 'nothing')).toBeNull();
  });

  it('supportsCapability is fail-closed for unknown capability names', () => {
    const caps = discoverCapabilities('anthropic', 'claude-opus-4-8')!;
    expect(supportsCapability(caps, 'vision')).toBe(true);
    expect(supportsCapability(caps, 'telepathy')).toBe(false);
  });

  it('gate returns missing capabilities, or null when all satisfied', () => {
    const gate = createCapabilityGate();
    expect(gate.check('google', 'gemini-3.1-pro', ['json', 'vision'])).toBeNull();
    expect(gate.check('openrouter', 'or-deepseek-v4-flash', ['vision'])).toEqual(['CAP:vision']);
    expect(gate.check('who', 'what', ['json'])).toEqual(['UNKNOWN_MODEL:who/what']);
  });
});

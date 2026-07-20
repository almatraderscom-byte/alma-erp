import { describe, it, expect } from 'vitest';
import { modelRequestSchema, modelInvocationPayloadSchema, MODEL_FABRIC_CONTRACT_VERSION } from '../contract';
import { makeRequest } from './_helpers';

describe('SPEC-151 model invocation contract', () => {
  it('accepts a well-formed request', () => {
    const req = makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'hello', responseFormat: 'text' });
    expect(modelRequestSchema.safeParse(req).success).toBe(true);
  });

  it('rejects an unknown tier', () => {
    const bad = { ...makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }), payload: { tier: 'T9', taskKind: 'reason', prompt: 'x', responseFormat: 'text' } };
    expect(modelRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing identity fields', () => {
    const req = makeRequest({ tier: 'T1', taskKind: 'classify', prompt: 'x', responseFormat: 'json' });
    const bad = { ...req, identity: { ...req.identity, tenantId: '' } };
    const parsed = modelRequestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'identity.tenantId')).toBe(true);
    }
  });

  it('rejects a non-positive maxOutputTokens', () => {
    const parsed = modelInvocationPayloadSchema.safeParse({ tier: 'T2', taskKind: 'specialist', prompt: 'x', responseFormat: 'text', maxOutputTokens: 0 });
    expect(parsed.success).toBe(false);
  });

  it('contract version is stable', () => {
    expect(MODEL_FABRIC_CONTRACT_VERSION).toBe('1.0.0');
  });
});

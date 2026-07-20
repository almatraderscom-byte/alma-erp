import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  COMPONENT_CONTRACT_VERSION,
  MAX_PAYLOAD_BYTES,
  REASON_CODES,
  allowed,
  completed,
  failure,
  isSuccess,
  validateRequest,
  type ComponentRequest,
} from '../component';

const payloadSchema = z.object({ action: z.string().min(1) });

function baseRequest(overrides: Record<string, unknown> = {}): unknown {
  const req: ComponentRequest<{ action: string }> = {
    identity: {
      tenantId: 'alma',
      actorId: 'maruf',
      workflowId: 'wf-1',
      stepId: 'step-1',
      correlationId: 'corr-1',
    },
    contractVersion: COMPONENT_CONTRACT_VERSION,
    payload: { action: 'ping' },
  };
  return { ...req, ...overrides };
}

describe('component contract — result constructors', () => {
  it('builds COMPLETED success', () => {
    const r = completed({ n: 1 }, ['ev-1'], { a: '1' });
    expect(r.status).toBe('COMPLETED');
    expect(isSuccess(r)).toBe(true);
  });

  it('builds ALLOWED success', () => {
    expect(allowed(true).status).toBe('ALLOWED');
  });

  it('builds typed failure with reason codes, never a boolean', () => {
    const r = failure('DENIED', [REASON_CODES.POLICY_DENIED], { retryAfterMs: 500 });
    expect(r.status).toBe('DENIED');
    expect(r.reasonCodes).toEqual([REASON_CODES.POLICY_DENIED]);
    expect(r.retryAfterMs).toBe(500);
    expect(isSuccess(r)).toBe(false);
  });
});

describe('component contract — validateRequest', () => {
  it('accepts a valid request', () => {
    const res = validateRequest(baseRequest(), payloadSchema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.identity.tenantId).toBe('alma');
  });

  it('rejects malformed payload with MALFORMED_INPUT', () => {
    const res = validateRequest(baseRequest({ payload: { action: '' } }), payloadSchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.reasonCodes).toContain(REASON_CODES.MALFORMED_INPUT);
  });

  it('rejects missing tenant with MISSING_TENANT', () => {
    const res = validateRequest(
      baseRequest({ identity: { actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' } }),
      payloadSchema,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.reasonCodes).toContain(REASON_CODES.MISSING_TENANT);
  });

  it('rejects missing actor with MISSING_ACTOR', () => {
    const res = validateRequest(
      baseRequest({ identity: { tenantId: 't', workflowId: 'w', stepId: 's', correlationId: 'c' } }),
      payloadSchema,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.reasonCodes).toContain(REASON_CODES.MISSING_ACTOR);
  });

  it('rejects a contract-version mismatch', () => {
    const res = validateRequest(baseRequest({ contractVersion: '0.0.1' }), payloadSchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.reasonCodes).toContain(REASON_CODES.CONTRACT_VERSION_MISMATCH);
  });

  it('rejects an oversized payload', () => {
    const big = { action: 'x'.repeat(MAX_PAYLOAD_BYTES + 10) };
    const res = validateRequest(baseRequest({ payload: big }), payloadSchema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.reasonCodes).toContain(REASON_CODES.OVERSIZED_INPUT);
  });
});

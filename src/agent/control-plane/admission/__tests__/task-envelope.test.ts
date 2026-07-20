import { describe, it, expect } from 'vitest';
import { buildEnvelope, taskEnvelopeSchema, TASK_ENVELOPE_VERSION } from '../task-envelope';
import type { AdmissionReceipt } from '../gateway';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 'admission', correlationId: 'c1' };

function receipt(overrides: Partial<AdmissionReceipt['annotations']> = {}): AdmissionReceipt {
  return {
    admitted: true,
    identity,
    input: { channel: 'telegram' },
    annotations: {
      normalized: { channel: 'telegram', text: 'hello boss', command: null, hasAttachments: false },
      fastPath: null,
      ...overrides,
    },
    stagesRun: ['normalize', 'fast-path'],
  };
}

describe('buildEnvelope', () => {
  it('projects an admitted receipt into a valid envelope', () => {
    const r = buildEnvelope(receipt());
    expect(r.status).toBe('COMPLETED');
    if (r.status === 'COMPLETED') {
      expect(r.value.channel).toBe('telegram');
      expect(r.value.text).toBe('hello boss');
      expect(r.value.contractVersion).toBe(TASK_ENVELOPE_VERSION);
      expect(taskEnvelopeSchema.safeParse(r.value).success).toBe(true);
    }
  });

  it('carries fast-path + classifications when present', () => {
    const r = buildEnvelope(
      receipt({
        fastPath: { handlerId: 'handler.status', command: 'status' },
        intent: 'status_check',
        complexity: 'SIMPLE',
        risk: 'LOW',
      }),
    );
    if (r.status === 'COMPLETED') {
      expect(r.value.fastPath?.handlerId).toBe('handler.status');
      expect(r.value.classifications).toMatchObject({ intent: 'status_check', complexity: 'SIMPLE', risk: 'LOW' });
    }
  });

  it('preserves the correlation id across the hand-off', () => {
    const r = buildEnvelope(receipt());
    if (r.status === 'COMPLETED') expect(r.value.identity.correlationId).toBe('c1');
  });

  it('fails closed when the receipt was never normalized', () => {
    const bad = receipt();
    delete (bad.annotations as Record<string, unknown>).normalized;
    const r = buildEnvelope(bad);
    expect(r.status).not.toBe('COMPLETED');
  });
});

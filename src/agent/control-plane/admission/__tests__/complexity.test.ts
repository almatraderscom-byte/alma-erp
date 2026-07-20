import { describe, it, expect } from 'vitest';
import { classifyComplexity, complexityStage } from '../complexity';
import type { NormalizedRequest } from '../normalize';

const nr = (over: Partial<NormalizedRequest>): NormalizedRequest => ({
  channel: 'telegram', text: '', command: null, hasAttachments: false, ...over,
});

describe('classifyComplexity', () => {
  it('SIMPLE for a short one-liner', () => {
    expect(classifyComplexity(nr({ text: 'hi boss' })).complexity).toBe('SIMPLE');
  });

  it('STANDARD for a medium request or one step marker', () => {
    expect(classifyComplexity(nr({ text: 'send the invoice then confirm' })).complexity).toBe('STANDARD');
    expect(classifyComplexity(nr({ text: 'x'.repeat(200) })).complexity).toBe('STANDARD');
  });

  it('COMPLEX for multi-step / long / attachment-heavy', () => {
    const r = classifyComplexity(nr({ text: 'first make the report and then email it and also update the sheet', hasAttachments: true }));
    expect(r.complexity).toBe('COMPLEX');
    expect(r.signals).toContain('multi-step');
  });

  it('counts attachments as a signal', () => {
    expect(classifyComplexity(nr({ text: 'process this', hasAttachments: true })).signals).toContain('attachments');
  });

  it('is deterministic (same input, same score)', () => {
    const t = 'make report and then send';
    expect(classifyComplexity(nr({ text: t })).score).toBe(classifyComplexity(nr({ text: t })).score);
  });
});

describe('complexityStage', () => {
  it('annotates complexity onto the context', () => {
    const r = complexityStage.run({
      identity: { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' },
      input: { channel: 'telegram' },
      annotations: { normalized: nr({ text: 'hi' }) },
      evidenceIds: [],
    });
    if (r.ok) expect(r.ctx.annotations.complexity).toBe('SIMPLE');
  });
});

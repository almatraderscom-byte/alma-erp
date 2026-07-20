import { describe, it, expect } from 'vitest';
import { REASON_CODES } from '@/agent/contracts';
import { MAX_TEXT_LEN, normalize, normalizeStage } from '../normalize';
import type { AdmissionContext } from '../gateway';

const ctx = (input: Record<string, unknown>): AdmissionContext => ({
  identity: { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' },
  input: input as never,
  annotations: {},
  evidenceIds: [],
});

describe('normalize', () => {
  it('normalizes telegram/assistant/cron to one shape', () => {
    for (const channel of ['telegram', 'assistant', 'cron']) {
      const r = normalize({ channel, text: 'hello' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.normalized.channel).toBe(channel);
    }
  });

  it('lower-cases channel and derives a leading /command', () => {
    const r = normalize({ channel: 'Telegram', text: '/Status now' });
    if (r.ok) {
      expect(r.normalized.channel).toBe('telegram');
      expect(r.normalized.command).toBe('status');
    }
  });

  it('honours an explicit command field', () => {
    const r = normalize({ channel: 'assistant', text: 'do it', command: '/Help' });
    if (r.ok) expect(r.normalized.command).toBe('help');
  });

  it('detects attachments in payload', () => {
    const r = normalize({ channel: 'telegram', text: 'x', payload: { attachments: [{}] } });
    if (r.ok) expect(r.normalized.hasAttachments).toBe(true);
  });

  it('rejects an unknown channel', () => {
    expect(normalize({ channel: 'sms', text: 'x' }).ok).toBe(false);
  });

  it('rejects oversized text', () => {
    expect(normalize({ channel: 'telegram', text: 'x'.repeat(MAX_TEXT_LEN + 1) }).ok).toBe(false);
  });
});

describe('normalizeStage', () => {
  it('annotates the context on success', () => {
    const r = normalizeStage.run(ctx({ channel: 'telegram', text: 'hi' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.ctx.annotations.normalized as { channel: string }).channel).toBe('telegram');
  });

  it('fails closed with OVERSIZED_INPUT on huge text', () => {
    const r = normalizeStage.run(ctx({ channel: 'telegram', text: 'x'.repeat(MAX_TEXT_LEN + 1) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reasonCodes).toContain(REASON_CODES.OVERSIZED_INPUT);
  });

  it('fails closed with MALFORMED_INPUT on unknown channel', () => {
    const r = normalizeStage.run(ctx({ channel: 'sms', text: 'x' }));
    if (!r.ok) expect(r.failure.reasonCodes).toContain(REASON_CODES.MALFORMED_INPUT);
    else throw new Error('expected failure');
  });
});

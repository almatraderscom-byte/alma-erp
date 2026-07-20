import { describe, it, expect } from 'vitest';
import { buildTrace, TRACE_REASON_CODES, type Span } from '../trace';

const span = (over: Partial<Span>): Span => ({ spanId: 's1', component: 'admission', correlationId: 'corr-1', status: 'ok', startMs: 0, endMs: 10, ...over });

describe('buildTrace (SPEC-191)', () => {
  it('assembles and orders spans by start time', () => {
    const r = buildTrace('corr-1', [
      span({ spanId: 'b', component: 'policy', startMs: 20, endMs: 30 }),
      span({ spanId: 'a', component: 'admission', startMs: 0, endMs: 10 }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trace.componentPath).toEqual(['admission', 'policy']);
      expect(r.trace.durationMs).toBe(30);
      expect(r.trace.status).toBe('ok');
    }
  });
  it('rolls up to the worst status', () => {
    const r = buildTrace('corr-1', [span({ status: 'ok' }), span({ spanId: 's2', status: 'denied', startMs: 11, endMs: 12 })]);
    if (r.ok) expect(r.trace.status).toBe('denied');
  });
  it('fails closed on mixed correlation ids', () => {
    const r = buildTrace('corr-1', [span({}), span({ spanId: 's2', correlationId: 'corr-2' })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCodes).toContain(TRACE_REASON_CODES.MIXED_CORRELATION);
  });
  it('fails closed on empty or malformed', () => {
    expect(buildTrace('corr-1', []).ok).toBe(false);
    const bad = buildTrace('corr-1', [span({ spanId: '' })]);
    expect(bad.ok).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { EpisodicMemory, type EpisodeRecord } from '../episodic';

const id = (t = 'alma') => ({ tenantId: t, actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' });
const ep = (over: Partial<EpisodeRecord> & { id: string }): EpisodeRecord => ({
  identity: id(), action: 'send_invoice', outcome: 'success', summary: 'ok', atMs: 1, ...over,
});

describe('EpisodicMemory (SPEC-056)', () => {
  it('records and recalls most-recent-first', () => {
    const m = new EpisodicMemory();
    m.record(ep({ id: 'a', atMs: 1 })); m.record(ep({ id: 'b', atMs: 2 }));
    expect(m.recall('alma').map((e) => e.id)).toEqual(['b', 'a']);
  });
  it('filters by action + outcome', () => {
    const m = new EpisodicMemory();
    m.record(ep({ id: 'a', outcome: 'failure' }));
    m.record(ep({ id: 'b', outcome: 'success' }));
    expect(m.recall('alma', { outcome: 'failure' }).map((e) => e.id)).toEqual(['a']);
  });
  it('isolates by tenant', () => {
    const m = new EpisodicMemory();
    m.record(ep({ id: 'a' }));
    m.record(ep({ id: 'b', identity: id('rival') }));
    expect(m.recall('alma').map((e) => e.id)).toEqual(['a']);
  });
  it('rejects invalid episode (fail-closed)', () => {
    expect(() => new EpisodicMemory().record(ep({ id: 'x', outcome: 'bad' as never }))).toThrow();
  });
});

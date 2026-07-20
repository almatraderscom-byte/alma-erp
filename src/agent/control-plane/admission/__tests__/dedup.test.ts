import { describe, it, expect } from 'vitest';
import { DEDUP_REASON_CODES, InMemoryDedupStore, dedupKey, makeDedupStage } from '../dedup';
import type { NormalizedRequest } from '../normalize';
import type { AdmissionContext } from '../gateway';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c1' };
const nr = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  channel: 'telegram', text: 'pay 500', command: null, hasAttachments: false, ...over,
});
const ctx = (n: NormalizedRequest): AdmissionContext => ({ identity, input: { channel: 'telegram' }, annotations: { normalized: n }, evidenceIds: [] });

describe('dedupKey', () => {
  it('is deterministic and content-sensitive', () => {
    expect(dedupKey(identity, nr())).toBe(dedupKey(identity, nr()));
    expect(dedupKey(identity, nr({ text: 'pay 600' }))).not.toBe(dedupKey(identity, nr()));
  });
  it('is scoped by tenant + correlation', () => {
    const other = { ...identity, tenantId: 'other' };
    expect(dedupKey(other, nr())).not.toBe(dedupKey(identity, nr()));
  });
});

describe('InMemoryDedupStore', () => {
  it('remembers and evicts past capacity', () => {
    const s = new InMemoryDedupStore(2);
    s.remember('a'); s.remember('b');
    expect(s.has('a')).toBe(true);
    s.remember('c'); // evicts 'a'
    expect(s.has('a')).toBe(false);
    expect(s.has('c')).toBe(true);
  });
});

describe('dedup stage — replay protection', () => {
  it('admits the first occurrence, rejects the duplicate', () => {
    const stage = makeDedupStage(new InMemoryDedupStore());
    const first = stage.run(ctx(nr()));
    expect(first.ok).toBe(true);
    const replay = stage.run(ctx(nr()));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.failure.reasonCodes).toContain(DEDUP_REASON_CODES.DUPLICATE_REQUEST);
  });

  it('does not blindly re-execute — duplicate returns a typed failure, not a pass', () => {
    const stage = makeDedupStage(new InMemoryDedupStore());
    stage.run(ctx(nr()));
    const replay = stage.run(ctx(nr()));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.failure.status).toBe('FAILED_FINAL');
  });

  it('treats different content as distinct (not a duplicate)', () => {
    const stage = makeDedupStage(new InMemoryDedupStore());
    expect(stage.run(ctx(nr({ text: 'a' }))).ok).toBe(true);
    expect(stage.run(ctx(nr({ text: 'b' }))).ok).toBe(true);
  });

  it('annotates the dedup key on first admission', () => {
    const stage = makeDedupStage(new InMemoryDedupStore());
    const r = stage.run(ctx(nr()));
    if (r.ok) expect(typeof r.ctx.annotations.dedupKey).toBe('string');
  });
});

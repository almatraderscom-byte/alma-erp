import { describe, it, expect } from 'vitest';
import { planCompaction } from '../compaction';
import type { TranscriptEntry } from '../transcript';

const id = { tenantId: 'alma', actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' };
const mk = (n: number, role: TranscriptEntry['role'] = 'owner'): TranscriptEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, role, content: `m${i}`, identity: id, atMs: i }));

describe('planCompaction (SPEC-054)', () => {
  it('does nothing below the trigger', () => {
    const p = planCompaction(mk(5), { triggerAt: 10, keepRecent: 3 });
    expect(p.needed).toBe(false);
    expect(p.compact).toEqual([]);
  });
  it('keeps recent, compacts older once over the trigger', () => {
    const p = planCompaction(mk(20), { triggerAt: 10, keepRecent: 5 });
    expect(p.needed).toBe(true);
    expect(p.keep.length).toBe(5);
    expect(p.compact.length).toBe(15);
    // kept are the most recent
    expect(p.keep.map((e) => e.id)).toEqual(['e15', 'e16', 'e17', 'e18', 'e19']);
  });
  it('always keeps system entries even when old', () => {
    const entries = [...mk(3, 'system'), ...mk(20)];
    const p = planCompaction(entries, { triggerAt: 5, keepRecent: 2 });
    expect(p.keep.filter((e) => e.role === 'system').length).toBe(3);
  });
  it('is deterministic', () => {
    const e = mk(15);
    expect(planCompaction(e, { triggerAt: 5, keepRecent: 3 }).compact.length)
      .toBe(planCompaction(e, { triggerAt: 5, keepRecent: 3 }).compact.length);
  });
});

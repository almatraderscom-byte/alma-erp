import { describe, it, expect } from 'vitest';
import { SessionStateStore, type SessionState } from '../session-state';

const id = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c1' };
const base = (): SessionState => ({ correlationId: 'c1', identity: id, status: 'active', currentStep: 'start', variables: { a: '1' }, updatedAtMs: 1 });

describe('SessionStateStore (SPEC-052)', () => {
  it('puts and gets a state (copy on read)', () => {
    const s = new SessionStateStore(); s.put(base());
    const got = s.get('c1')!; got.currentStep = 'TAMPER';
    expect(s.get('c1')!.currentStep).toBe('start');
  });
  it('rejects invalid state (fail-closed)', () => {
    const s = new SessionStateStore();
    expect(() => s.put({ ...base(), status: 'bogus' as never })).toThrow();
  });
  it('copy-on-write update returns a new snapshot + merges variables', () => {
    const s = new SessionStateStore(); s.put(base());
    const next = s.update('c1', { status: 'waiting_approval', variables: { b: '2' } }, 5)!;
    expect(next.status).toBe('waiting_approval');
    expect(next.variables).toEqual({ a: '1', b: '2' });
    expect(next.updatedAtMs).toBe(5);
  });
  it('update returns null for unknown session', () => {
    expect(new SessionStateStore().update('nope', { status: 'failed' }, 1)).toBeNull();
  });
});

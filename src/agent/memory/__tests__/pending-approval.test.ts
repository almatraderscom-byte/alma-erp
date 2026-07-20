import { describe, it, expect } from 'vitest';
import { ApprovalStore } from '../pending-approval';

const id = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };

describe('ApprovalStore (SPEC-053) — fail-closed', () => {
  it('a fresh request is pending and NOT actionable', () => {
    const s = new ApprovalStore();
    s.request('a1', id, 'pay supplier', 'HIGH', 1);
    expect(s.get('a1')!.status).toBe('pending');
    expect(s.isActionable('a1')).toBe(false);
  });
  it('becomes actionable only after explicit approval', () => {
    const s = new ApprovalStore();
    s.request('a1', id, 'pay', 'HIGH', 1);
    s.resolve('a1', 'approved', 2);
    expect(s.isActionable('a1')).toBe(true);
  });
  it('a rejected request is never actionable', () => {
    const s = new ApprovalStore();
    s.request('a1', id, 'pay', 'HIGH', 1);
    s.resolve('a1', 'rejected', 2);
    expect(s.isActionable('a1')).toBe(false);
  });
  it('unknown id is not actionable (fail-closed)', () => {
    expect(new ApprovalStore().isActionable('nope')).toBe(false);
  });
  it('cannot re-resolve an already-resolved request', () => {
    const s = new ApprovalStore();
    s.request('a1', id, 'pay', 'HIGH', 1);
    s.resolve('a1', 'approved', 2);
    expect(s.resolve('a1', 'rejected', 3)).toBeNull();
    expect(s.isActionable('a1')).toBe(true);
  });
});

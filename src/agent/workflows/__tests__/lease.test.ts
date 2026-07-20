import { describe, it, expect } from 'vitest';
import { acquireLease, heartbeat, isExpired, isHeldBy, assertLeaseHeld, LEASE_REASON_CODES, type StepLease } from '../lease';

const base = { instanceId: 'inst-1', stepId: 'a', nowMs: 1000, ttlMs: 5000 };
const acquire = (current: StepLease | null, workerId: string, nowMs = 1000) =>
  acquireLease(current, { ...base, workerId, nowMs });

describe('acquireLease (SPEC-134)', () => {
  it('acquires when there is no current lease', () => {
    const r = acquire(null, 'w1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lease).toMatchObject({ workerId: 'w1', expiresAtMs: 6000 });
  });
  it('refuses when another worker holds a live lease', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      const r = acquire(held.lease, 'w2', 2000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasonCodes).toContain(LEASE_REASON_CODES.HELD_BY_OTHER);
    }
  });
  it('lets another worker reclaim once the lease has expired', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      const r = acquire(held.lease, 'w2', 6000); // at/after expiry
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lease.workerId).toBe('w2');
    }
  });
  it('lets the same worker renew', () => {
    const held = acquire(null, 'w1');
    if (held.ok) expect(acquire(held.lease, 'w1', 3000).ok).toBe(true);
  });
  it('rejects malformed args (fail-closed)', () => {
    const r = acquireLease(null, { instanceId: '', stepId: 'a', workerId: 'w', nowMs: 1, ttlMs: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCodes).toContain(LEASE_REASON_CODES.MALFORMED);
  });
});

describe('heartbeat (SPEC-134)', () => {
  it('extends the expiry for the current holder', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      const r = heartbeat(held.lease, 'w1', 3000, 5000);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.lease.expiresAtMs).toBe(8000); expect(r.lease.heartbeatAtMs).toBe(3000); }
    }
  });
  it('rejects a heartbeat from a different worker', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      const r = heartbeat(held.lease, 'w2', 3000, 5000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasonCodes).toContain(LEASE_REASON_CODES.NOT_LEASE_HOLDER);
    }
  });
  it('refuses to resurrect an expired lease', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      const r = heartbeat(held.lease, 'w1', 6000, 5000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasonCodes).toContain(LEASE_REASON_CODES.LEASE_EXPIRED);
    }
  });
});

describe('helpers (SPEC-134)', () => {
  it('isExpired / isHeldBy', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      expect(isExpired(held.lease, 6000)).toBe(true);
      expect(isHeldBy(held.lease, 'w1', 2000)).toBe(true);
      expect(isHeldBy(held.lease, 'w1', 6000)).toBe(false);
      expect(isHeldBy(null, 'w1', 1)).toBe(false);
    }
  });
  it('assertLeaseHeld guards execution fail-closed', () => {
    const held = acquire(null, 'w1');
    if (held.ok) {
      expect(assertLeaseHeld(held.lease, 'w1', 2000)).toEqual([]);
      expect(assertLeaseHeld(held.lease, 'w2', 2000)).toContain(LEASE_REASON_CODES.NOT_LEASE_HOLDER);
      expect(assertLeaseHeld(held.lease, 'w1', 9000)).toContain(LEASE_REASON_CODES.LEASE_EXPIRED);
      expect(assertLeaseHeld(null, 'w1', 1)).toContain(LEASE_REASON_CODES.NOT_LEASE_HOLDER);
    }
  });
});

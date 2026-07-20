import { describe, it, expect } from 'vitest';
import { MemoryLifecycleIndex, isExpired } from '../lifecycle';

describe('isExpired (SPEC-059)', () => {
  it('respects TTL', () => {
    expect(isExpired(100, 99)).toBe(false);
    expect(isExpired(100, 100)).toBe(true);
    expect(isExpired(undefined, 999)).toBe(false); // no TTL = never expires
  });
});

describe('MemoryLifecycleIndex', () => {
  it('expired memories are inactive', () => {
    const idx = new MemoryLifecycleIndex();
    idx.setExpiry('a', 100);
    expect(idx.isActive('a', 50)).toBe(true);
    expect(idx.isActive('a', 100)).toBe(false);
  });
  it('superseded memories are inactive and chain to current', () => {
    const idx = new MemoryLifecycleIndex();
    idx.supersede('v1', 'v2'); idx.supersede('v2', 'v3');
    expect(idx.isActive('v1', 0)).toBe(false);
    expect(idx.currentId('v1')).toBe('v3');
  });
  it('rejects self-supersession', () => {
    expect(() => new MemoryLifecycleIndex().supersede('a', 'a')).toThrow();
  });
  it('filterActive drops expired + superseded', () => {
    const idx = new MemoryLifecycleIndex();
    idx.setExpiry('exp', 10); idx.supersede('old', 'new');
    const active = idx.filterActive([{ id: 'exp' }, { id: 'old' }, { id: 'live' }], 100);
    expect(active.map((r) => r.id)).toEqual(['live']);
  });
});

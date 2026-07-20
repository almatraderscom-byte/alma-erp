import { describe, it, expect } from 'vitest';
import { ToolResultCache } from '../tool-result-cache';

const entry = (over: Partial<{ key: string; result: string; storedAtMs: number; ttlMs: number }> = {}) =>
  ({ key: 'k', result: 'stock: 5', storedAtMs: 1000, ttlMs: 500, ...over });

describe('tool-result cache (SPEC-067)', () => {
  it('serves a fresh result within TTL', () => {
    const c = new ToolResultCache(); c.put(entry());
    expect(c.get('k', 1400)!.result).toBe('stock: 5');
  });
  it('does NOT serve a stale result (past TTL) — evicts it', () => {
    const c = new ToolResultCache(); c.put(entry());
    expect(c.get('k', 1600)).toBeNull();
    expect(c.get('k', 1400)).toBeNull(); // evicted on the stale read
  });
  it('never caches a ttl=0 (real-time / side-effecting) tool', () => {
    const c = new ToolResultCache(); c.put(entry({ ttlMs: 0 }));
    expect(c.get('k', 1000)).toBeNull();
  });
  it('miss for an unknown key', () => {
    expect(new ToolResultCache().get('nope', 1)).toBeNull();
  });
});

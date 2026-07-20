import { describe, it, expect } from 'vitest';
import { InMemoryResponseCache } from '../response-cache';
import { conversationCacheKey } from '../conversation-key';

const id = (t: string) => ({ tenantId: t, actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' });
const entry = (key: string) => ({ key, response: 'the answer', storedAtMs: 1, savedNanoUsd: 2_000_000_000 });

describe('exact response cache (SPEC-065)', () => {
  it('miss then hit for the identical request', () => {
    const c = new InMemoryResponseCache();
    const k = conversationCacheKey(id('alma'), 'pfx_1', 'what is the balance');
    expect(c.get(k)).toBeNull();
    c.put(entry(k));
    expect(c.get(k)!.response).toBe('the answer');
  });
  it('a different tenant cannot hit another tenant entry (key embeds tenant)', () => {
    const c = new InMemoryResponseCache();
    c.put(entry(conversationCacheKey(id('alma'), 'pfx_1', 'q')));
    expect(c.get(conversationCacheKey(id('rival'), 'pfx_1', 'q'))).toBeNull();
  });
  it('tracks hit/miss stats (for savings, SPEC-070)', () => {
    const c = new InMemoryResponseCache();
    const k = conversationCacheKey(id('alma'), 'pfx_1', 'q');
    c.get(k); c.put(entry(k)); c.get(k);
    expect(c.stats()).toEqual({ hits: 1, misses: 1 });
  });
  it('returns a copy (no external mutation)', () => {
    const c = new InMemoryResponseCache();
    const k = conversationCacheKey(id('alma'), 'pfx_1', 'q');
    c.put(entry(k));
    c.get(k)!.response = 'TAMPER';
    expect(c.get(k)!.response).toBe('the answer');
  });
});

import { describe, it, expect } from 'vitest';
import { InMemoryPromptCacheAdapter } from '../../providers/cache/prompt-cache-adapter';

describe('prompt-cache adapter (SPEC-062)', () => {
  it('first send misses, then hits with cached tokens', () => {
    const a = new InMemoryPromptCacheAdapter();
    expect(a.lookup('google', 'pfx_1').hit).toBe(false);
    a.store('google', 'pfx_1', 1200);
    const hit = a.lookup('google', 'pfx_1');
    expect(hit.hit).toBe(true);
    expect(hit.cachedTokens).toBe(1200);
  });
  it('is isolated per provider', () => {
    const a = new InMemoryPromptCacheAdapter();
    a.store('google', 'pfx_1', 100);
    expect(a.lookup('anthropic', 'pfx_1').hit).toBe(false);
  });
  it('makes no real call — deterministic fake', () => {
    expect(new InMemoryPromptCacheAdapter().id).toBe('in-memory-fake');
  });
});

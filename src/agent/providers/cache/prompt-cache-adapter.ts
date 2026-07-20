/**
 * Provider prompt-cache adapter (G07 / SPEC-062).
 *
 * Providers (Anthropic, Gemini) cache a stable prompt prefix and bill cached
 * input at a lower rate (G03). This is the ADAPTER seam: a deterministic
 * in-memory fake ships as the default; a real provider-backed adapter plugs in
 * later WITHOUT any real call from here. Records prefix hits/misses so savings
 * can be measured (SPEC-070). No network, no model call.
 */
export interface PromptCacheLookup {
  hit: boolean;
  cachedTokens: number; // tokens the provider would serve from cache
}

export interface PromptCacheAdapter {
  readonly id: string;
  /** Has this prefix been seen (and is still cached) for this provider? */
  lookup(provider: string, prefixKey: string): PromptCacheLookup;
  /** Record that a prefix of `tokens` size was sent (now cacheable next time). */
  store(provider: string, prefixKey: string, tokens: number): void;
}

/** Deterministic in-memory fake — first send is a miss, subsequent are hits. */
export class InMemoryPromptCacheAdapter implements PromptCacheAdapter {
  readonly id = 'in-memory-fake';
  private readonly seen = new Map<string, number>(); // `${provider}:${prefixKey}` -> tokens

  private key(provider: string, prefixKey: string): string {
    return `${provider}:${prefixKey}`;
  }

  lookup(provider: string, prefixKey: string): PromptCacheLookup {
    const tokens = this.seen.get(this.key(provider, prefixKey));
    return tokens === undefined ? { hit: false, cachedTokens: 0 } : { hit: true, cachedTokens: tokens };
  }

  store(provider: string, prefixKey: string, tokens: number): void {
    this.seen.set(this.key(provider, prefixKey), Math.max(0, tokens));
  }
}

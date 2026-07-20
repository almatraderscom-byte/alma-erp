/**
 * Exact deterministic response cache (G07 / SPEC-065).
 *
 * Caches a model/tool response under the exact conversation cache key (SPEC-064),
 * so an identical request (same tenant + prefix + request text) returns the
 * stored response WITHOUT a model call — saving money (measured in SPEC-070).
 * Only safe for deterministic, read-only requests (policy exclusions in SPEC-068).
 * In-memory default; durable store is a seam. Pure/deterministic.
 */
export interface CachedResponse {
  key: string;
  response: string;
  storedAtMs: number;
  savedNanoUsd: number; // cost avoided by a hit (from the original estimate)
}

export interface ResponseCache {
  get(key: string): CachedResponse | null;
  put(entry: CachedResponse): void;
  size(): number;
}

export class InMemoryResponseCache implements ResponseCache {
  private readonly store = new Map<string, CachedResponse>();
  private hits = 0;
  private misses = 0;

  get(key: string): CachedResponse | null {
    const e = self_get(this.store, key);
    if (e) this.hits++; else this.misses++;
    return e ? { ...e } : null;
  }

  put(entry: CachedResponse): void {
    this.store.set(entry.key, { ...entry });
  }

  size(): number {
    return this.store.size;
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}

function self_get(m: Map<string, CachedResponse>, key: string): CachedResponse | undefined {
  return m.get(key);
}

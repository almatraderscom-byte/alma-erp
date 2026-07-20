/**
 * Tool-result cache with freshness (G07 / SPEC-067).
 *
 * Caches tool results with a per-entry TTL so a stale result is never served —
 * critical for tools whose data changes (stock, balances). Tools that must never
 * be cached (real-time / side-effecting) declare ttlMs = 0. Deterministic
 * (caller supplies now). Tenant-scoped via the key (SPEC-064/069).
 */
export interface ToolResultEntry {
  key: string;
  result: string;
  storedAtMs: number;
  ttlMs: number; // 0 = never cache (real-time / side-effecting tool)
}

export class ToolResultCache {
  private readonly store = new Map<string, ToolResultEntry>();

  put(entry: ToolResultEntry): void {
    if (entry.ttlMs <= 0) return; // non-cacheable tools are simply not stored
    this.store.set(entry.key, { ...entry });
  }

  /** Fresh result or null. Expired entries are evicted on read. */
  get(key: string, nowMs: number): ToolResultEntry | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (nowMs >= e.storedAtMs + e.ttlMs) {
      this.store.delete(key); // stale -> evict, treat as miss
      return null;
    }
    return { ...e };
  }
}

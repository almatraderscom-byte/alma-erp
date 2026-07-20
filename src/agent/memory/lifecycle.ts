/**
 * Memory expiration and correction (G06 / SPEC-059).
 *
 * Memories are never mutated (SPEC-051 immutability). Instead they EXPIRE (TTL)
 * or are CORRECTED by superseding them with a newer record — the old one stays
 * for audit but is no longer "active". This index tracks expiry + supersession
 * without touching the stored records. Deterministic (caller supplies time).
 */
export function isExpired(expiresAtMs: number | undefined, nowMs: number): boolean {
  return expiresAtMs !== undefined && nowMs >= expiresAtMs;
}

export class MemoryLifecycleIndex {
  private readonly expiry = new Map<string, number>();
  private readonly superseded = new Map<string, string>(); // oldId -> newId

  setExpiry(id: string, expiresAtMs: number): void {
    this.expiry.set(id, expiresAtMs);
  }

  /** Correct a memory: mark `oldId` superseded by `newId`. */
  supersede(oldId: string, newId: string): void {
    if (oldId === newId) throw new Error('a memory cannot supersede itself');
    this.superseded.set(oldId, newId);
  }

  isSuperseded(id: string): boolean {
    return this.superseded.has(id);
  }

  /** Active = not expired AND not superseded. */
  isActive(id: string, nowMs: number): boolean {
    if (this.superseded.has(id)) return false;
    return !isExpired(this.expiry.get(id), nowMs);
  }

  /** Follow the correction chain to the current record id. */
  currentId(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (this.superseded.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.superseded.get(cur)!;
    }
    return cur;
  }

  filterActive<T extends { id: string }>(records: T[], nowMs: number): T[] {
    return records.filter((r) => this.isActive(r.id, nowMs));
  }
}

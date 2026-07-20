/**
 * Memory privacy and tenant isolation (G06 / SPEC-058).
 *
 * Wraps memory access with the canonical tenant guard (G05 guardResourceAccess)
 * so a caller can only ever read/write memory in their own tenant (and business,
 * when scoped) — fail-closed. Also provides a bounded, model-safe view (INV-07:
 * models get bounded views, full payloads stay in evidence). Deterministic.
 */
import { guardResourceAccess } from '@/agent/contracts/tenant-context';
import type { ComponentResult, ExecutionIdentity } from '@/agent/contracts';
import type { MemoryRecord, SearchHit } from './semantic-store';

/** Fail-closed scope check for a memory record against a caller identity. */
export function assertMemoryScope(identity: ExecutionIdentity, record: MemoryRecord): ComponentResult<MemoryRecord> {
  const guard = guardResourceAccess(identity, {
    tenantId: record.identity.tenantId,
    ...(record.identity.businessId ? { businessId: record.identity.businessId } : {}),
  });
  if (!guard.ok) return guard.failure;
  return { status: 'ALLOWED', value: record, evidenceIds: [], versions: {} };
}

/** Drop hits the caller may not see (cross-tenant/business). Fail-closed. */
export function filterAuthorized(identity: ExecutionIdentity, hits: SearchHit[]): SearchHit[] {
  return hits.filter((h) => assertMemoryScope(identity, h.record).status === 'ALLOWED');
}

/** Bounded, model-safe view of a memory (INV-07 — no raw embedding, no ids). */
export interface MemoryView {
  text: string;
  tags: string[];
  atMs: number;
}
export function toModelView(record: MemoryRecord): MemoryView {
  return { text: record.text, tags: [...record.tags], atMs: record.atMs };
}

import { describe, it, expect } from 'vitest';
import { assertMemoryScope, filterAuthorized, toModelView } from '../privacy';
import type { MemoryRecord, SearchHit } from '../semantic-store';

const idOf = (t: string, b?: string) => ({ tenantId: t, ...(b ? { businessId: b } : {}), actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' });
const rec = (t: string, b?: string): MemoryRecord => ({ id: 'r', identity: idOf(t, b), text: 'secret', embedding: [1, 2, 3], atMs: 1, tags: ['x'] });
const hit = (t: string): SearchHit => ({ record: rec(t), score: 1 });

describe('assertMemoryScope (SPEC-058) — fail-closed', () => {
  it('allows same-tenant access', () => {
    expect(assertMemoryScope(idOf('alma'), rec('alma')).status).toBe('ALLOWED');
  });
  it('denies cross-tenant access', () => {
    expect(assertMemoryScope(idOf('alma'), rec('rival')).status).toBe('DENIED');
  });
  it('denies cross-business within a tenant', () => {
    expect(assertMemoryScope(idOf('alma', 'lifestyle'), rec('alma', 'trading')).status).toBe('DENIED');
  });
});

describe('filterAuthorized', () => {
  it('drops cross-tenant hits', () => {
    const kept = filterAuthorized(idOf('alma'), [hit('alma'), hit('rival')]);
    expect(kept).toHaveLength(1);
    expect(kept[0].record.identity.tenantId).toBe('alma');
  });
});

describe('toModelView (INV-07 bounded view)', () => {
  it('exposes only text/tags/atMs — no embedding, no ids', () => {
    const v = toModelView(rec('alma')) as Record<string, unknown>;
    expect(v.text).toBe('secret');
    expect(v.embedding).toBeUndefined();
    expect(v.id).toBeUndefined();
  });
});

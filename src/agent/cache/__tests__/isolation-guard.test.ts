import { describe, it, expect } from 'vitest';
import { assertKeyTenant, authorizedKeys } from '../isolation-guard';
import { conversationCacheKey } from '../conversation-key';

const id = (t: string) => ({ tenantId: t, actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' });

describe('cross-tenant cache isolation (SPEC-069)', () => {
  it('allows the owning tenant', () => {
    const k = conversationCacheKey(id('alma'), 'pfx', 'q');
    expect(assertKeyTenant(k, 'alma').ok).toBe(true);
  });
  it('denies a different tenant', () => {
    const k = conversationCacheKey(id('alma'), 'pfx', 'q');
    expect(assertKeyTenant(k, 'rival').ok).toBe(false);
  });
  it('fails closed on an unrecoverable key', () => {
    expect(assertKeyTenant('garbage-key', 'alma').ok).toBe(false);
  });
  it('property: across many tenants, NO key is ever authorised for another tenant', () => {
    const tenants = ['alma', 'rival', 'third', 'fourth'];
    const keys = tenants.map((t) => conversationCacheKey(id(t), 'pfx', 'q'));
    for (const caller of tenants) {
      const allowed = authorizedKeys(keys, caller);
      // exactly one key (the caller's own) is authorised
      expect(allowed).toEqual([conversationCacheKey(id(caller), 'pfx', 'q')]);
    }
  });
});

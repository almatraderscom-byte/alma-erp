import { describe, it, expect } from 'vitest';
import { credentialPrincipal, humanPrincipal, principalKey, principalRoles } from '../principals';
const id = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
describe('credentialPrincipal + union (SPEC-104)', () => {
  it('builds a credential principal with scopes', () => {
    const p = credentialPrincipal('alma', 'svc-1', ['read:orders']);
    expect(p.kind).toBe('credential');
    expect(p.scopes).toEqual(['read:orders']);
  });
  it('principalKey is tenant-scoped and kind-specific', () => {
    expect(principalKey(humanPrincipal(id))).toBe('human:alma:maruf');
    expect(principalKey(credentialPrincipal('alma', 'svc-1'))).toBe('credential:alma:svc-1');
  });
  it('principalRoles returns roles for humans, scopes for credentials', () => {
    expect(principalRoles(humanPrincipal(id, ['owner']))).toEqual(['owner']);
    expect(principalRoles(credentialPrincipal('alma', 'svc-1', ['s1']))).toEqual(['s1']);
  });
  it('rejects invalid (fail-closed)', () => {
    expect(() => credentialPrincipal('', 'x')).toThrow();
  });
});

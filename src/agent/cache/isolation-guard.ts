/**
 * Cross-tenant cache isolation (G07 / SPEC-069).
 *
 * The hard security property of the whole cache layer: a cache entry created for
 * one tenant can NEVER be read by another. Every conversation key embeds the
 * tenant (SPEC-064); this guard enforces it at read time — fail-closed on any
 * key whose tenant can't be recovered or doesn't match the caller.
 */
import { tenantOfKey } from './conversation-key';

export interface IsolationCheck {
  ok: boolean;
  reason: string;
}

/** Fail-closed: the caller may read `key` only if its embedded tenant matches. */
export function assertKeyTenant(key: string, callerTenantId: string): IsolationCheck {
  const owner = tenantOfKey(key);
  if (owner === null) return { ok: false, reason: 'key has no recoverable tenant (fail-closed)' };
  if (owner !== callerTenantId) return { ok: false, reason: `key belongs to tenant '${owner}', caller is '${callerTenantId}'` };
  return { ok: true, reason: 'tenant matches' };
}

/** Filter a set of candidate keys to those the caller is allowed to read. */
export function authorizedKeys(keys: string[], callerTenantId: string): string[] {
  return keys.filter((k) => assertKeyTenant(k, callerTenantId).ok);
}

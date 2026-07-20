/**
 * Conversation cache-key strategy (G07 / SPEC-064).
 *
 * Builds the deterministic key under which a response/tool result is cached. The
 * key ALWAYS embeds the tenant (isolation, SPEC-069), the stable prefix key
 * (SPEC-061), and a hash of the dynamic request — so a cache entry can never be
 * served to a different tenant or a different request. Pure (local sha256).
 */
import { createHash } from 'node:crypto';
import type { ExecutionIdentity } from '@/agent/contracts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** Hash of the dynamic request text (the part that varies per turn). */
export function requestHash(text: string): string {
  return sha(text);
}

/**
 * Cache key = tenant : prefix : request. Tenant-first so isolation is structural.
 * Two turns hit the same entry ONLY when tenant + prefix + request all match.
 */
export function conversationCacheKey(identity: ExecutionIdentity, prefixKey: string, requestText: string): string {
  return `cc:${identity.tenantId}:${prefixKey}:${requestHash(requestText)}`;
}

/** Extract the tenant from a cache key (used by the isolation guard, SPEC-069). */
export function tenantOfKey(key: string): string | null {
  const parts = key.split(':');
  return parts[0] === 'cc' && parts.length >= 4 ? parts[1] : null;
}

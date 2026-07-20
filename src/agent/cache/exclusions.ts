/**
 * Policy and permission cache exclusions (G07 / SPEC-068).
 *
 * Decides what may be cached. FAIL-CLOSED: a response is cacheable ONLY when it
 * is a read-only intent, low/medium risk, has no side effect, and is not
 * permission-dependent. Anything money-moving, destructive, write-intent, or
 * permission-sensitive is NEVER cached (serving a stale "allowed" would be a
 * security bug). Deterministic.
 */
export interface CacheEligibility {
  intent: string; // from G02 admission
  risk: string; // LOW | MED | HIGH (G02)
  hasSideEffect: boolean;
  permissionDependent: boolean;
}

export interface EligibilityResult {
  cacheable: boolean;
  reason: string;
}

const READ_ONLY_INTENTS = new Set(['question', 'status', 'chitchat']);

export function isCacheable(e: CacheEligibility): EligibilityResult {
  if (e.hasSideEffect) return { cacheable: false, reason: 'has side effect' };
  if (e.permissionDependent) return { cacheable: false, reason: 'permission-dependent (stale allow would be unsafe)' };
  if (e.risk === 'HIGH') return { cacheable: false, reason: 'HIGH risk (money/destructive)' };
  if (!READ_ONLY_INTENTS.has(e.intent)) return { cacheable: false, reason: `intent '${e.intent}' is not read-only` };
  return { cacheable: true, reason: 'read-only, low/med risk, no side effect' };
}

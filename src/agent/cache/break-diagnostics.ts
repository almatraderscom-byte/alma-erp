/**
 * Cache-break diagnostics (G07 / SPEC-063).
 *
 * When a prefix cache misses unexpectedly, this explains WHY — which cacheable
 * bundle changed (added, removed, or version-bumped) between two compiles. Turns
 * silent cache waste into an actionable signal. Pure, deterministic.
 */
import type { BundleProvenance, CompiledContext } from '../context/compiler';
import { cacheablePrefixProvenance } from './prefix-hash';

export interface CacheBreakReason {
  bundleId: string;
  change: 'added' | 'removed' | 'version_changed';
  detail: string;
}

export function diagnoseBreak(prev: CompiledContext, cur: CompiledContext): CacheBreakReason[] {
  const p = new Map(cacheablePrefixProvenance(prev).map((b) => [b.id, b] as const));
  const c = new Map(cacheablePrefixProvenance(cur).map((b) => [b.id, b] as const));
  const reasons: CacheBreakReason[] = [];

  for (const [id, cur_] of c) {
    const prev_ = p.get(id);
    if (!prev_) reasons.push({ bundleId: id, change: 'added', detail: `${id} was added to the prefix` });
    else if (prev_.version !== cur_.version)
      reasons.push({ bundleId: id, change: 'version_changed', detail: `${id} ${prev_.version} -> ${cur_.version}` });
  }
  for (const [id] of p) {
    if (!c.has(id)) reasons.push({ bundleId: id, change: 'removed', detail: `${id} was removed from the prefix` });
  }
  return reasons.sort((a, b) => a.bundleId.localeCompare(b.bundleId));
}

/** Convenience: did the prefix break, and why? */
export function explainBreak(prev: CompiledContext, cur: CompiledContext): { broke: boolean; reasons: CacheBreakReason[] } {
  const reasons = diagnoseBreak(prev, cur);
  return { broke: reasons.length > 0, reasons };
}

/**
 * Stable-prefix hashing (G07 / SPEC-061).
 *
 * Prompt caching works because the cacheable prefix (constitution → skill →
 * policy, from G05) is STABLE across turns while the dynamic suffix changes. This
 * module derives a deterministic key for that prefix from its bundle provenance
 * (id + version), so the key changes iff a cacheable bundle changes — and is
 * unaffected by dynamic memory/request changes. Pure (local sha256).
 */
import { createHash } from 'node:crypto';
import type { BundleProvenance, CompiledContext } from '../context/compiler';

/** The leading contiguous run of cacheable bundles (the cacheable prefix). */
export function cacheablePrefixProvenance(compiled: CompiledContext): BundleProvenance[] {
  const out: BundleProvenance[] = [];
  for (const p of compiled.provenance) {
    if (!p.cacheable) break;
    out.push(p);
  }
  return out;
}

/**
 * Deterministic cache key for the stable prefix. Derived from the cacheable
 * bundles' (id, version, order) — NOT from the dynamic suffix — so two turns that
 * share a constitution/skill/policy set produce the same key and hit the cache.
 */
export function prefixCacheKey(compiled: CompiledContext): string {
  const prefix = cacheablePrefixProvenance(compiled);
  const material = prefix.map((p) => `${p.id}@${p.version}#${p.order}`).join('|');
  const hash = createHash('sha256').update(`${compiled.contractVersion}::${material}`).digest('hex');
  return `pfx_${hash.slice(0, 32)}`;
}

/** Number of tokens the prefix cache can amortise (from G05). */
export function prefixCacheableTokens(compiled: CompiledContext): number {
  return compiled.cacheablePrefixTokens;
}

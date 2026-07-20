/**
 * Context provenance and replay record (G05 / SPEC-050).
 *
 * Captures exactly which bundles (id, kind, version, order, tokens) produced a
 * compiled context, plus a content hash, so any prompt sent to a model can be
 * reproduced and audited later. `verifyReplay` confirms a recompiled context
 * matches the record — the basis for deterministic replay. Pure (hash is a
 * local sha256, no I/O).
 */
import { createHash } from 'node:crypto';
import type { BundleProvenance, CompiledContext } from './compiler';

export interface ContextReplayRecord {
  contractVersion: string;
  bundles: BundleProvenance[];
  totalTokens: number;
  cacheablePrefixTokens: number;
  contentHash: string; // sha256 of the compiled text
}

/** Deterministic sha256 of the compiled prompt text. */
export function hashContext(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function buildReplayRecord(compiled: CompiledContext): ContextReplayRecord {
  return {
    contractVersion: compiled.contractVersion,
    bundles: compiled.provenance,
    totalTokens: compiled.totalTokens,
    cacheablePrefixTokens: compiled.cacheablePrefixTokens,
    contentHash: hashContext(compiled.text),
  };
}

/** True iff a freshly compiled context reproduces the recorded one exactly. */
export function verifyReplay(record: ContextReplayRecord, recompiled: CompiledContext): boolean {
  if (record.contentHash !== hashContext(recompiled.text)) return false;
  if (record.totalTokens !== recompiled.totalTokens) return false;
  if (record.bundles.length !== recompiled.provenance.length) return false;
  return record.bundles.every((b, i) => {
    const r = recompiled.provenance[i];
    return b.id === r.id && b.kind === r.kind && b.version === r.version && b.order === r.order;
  });
}

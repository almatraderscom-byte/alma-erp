/**
 * Conversation compaction policy (G06 / SPEC-054).
 *
 * DECIDES (deterministically) which transcript entries to keep verbatim and which
 * to fold into a summary once the conversation grows past a bound. The summary
 * TEXT is produced later by a model call (a seam, pre-authorised by the Cost
 * Governor) — this module only computes the split, so it stays deterministic and
 * is the "far-off cost safety valve" per CLAUDE.md. No LLM here.
 */
import type { TranscriptEntry } from './transcript';

export interface CompactionPlan {
  needed: boolean;
  keep: TranscriptEntry[]; // recent, kept verbatim
  compact: TranscriptEntry[]; // older, to be summarised (by a later model call)
}

/**
 * Keep the most recent `keepRecent` entries verbatim; everything older is marked
 * for compaction — but only once the total exceeds `triggerAt`. System entries
 * are always kept (they carry durable instructions).
 */
export function planCompaction(
  entries: TranscriptEntry[],
  opts: { triggerAt: number; keepRecent: number },
): CompactionPlan {
  if (entries.length <= opts.triggerAt) {
    return { needed: false, keep: [...entries], compact: [] };
  }
  const keep: TranscriptEntry[] = [];
  const compact: TranscriptEntry[] = [];
  const cutoff = entries.length - opts.keepRecent;
  entries.forEach((e, i) => {
    if (i >= cutoff || e.role === 'system') keep.push(e);
    else compact.push(e);
  });
  return { needed: compact.length > 0, keep, compact };
}

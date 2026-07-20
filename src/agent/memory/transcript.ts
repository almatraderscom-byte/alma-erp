/**
 * Immutable conversation transcript (G06 / SPEC-051).
 *
 * An append-only, ordered log of conversation turns. Entries are frozen on
 * append and never mutated or deleted — corrections live as new entries
 * (SPEC-059), so the record stays auditable and replayable. Every entry carries
 * the canonical ExecutionIdentity (G01). Deterministic (caller supplies time).
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';

export const TRANSCRIPT_ROLES = ['owner', 'agent', 'staff', 'system'] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
  identity: ExecutionIdentity;
  atMs: number;
}

export const transcriptEntrySchema: z.ZodType<TranscriptEntry> = z.object({
  id: z.string().min(1),
  role: z.enum(TRANSCRIPT_ROLES),
  content: z.string(),
  identity: executionIdentitySchema,
  atMs: z.number().int().nonnegative(),
}) as z.ZodType<TranscriptEntry>;

/** Append-only transcript. Frozen entries; no update/delete. */
export class ConversationTranscript {
  private readonly log: TranscriptEntry[] = [];

  append(entry: TranscriptEntry): TranscriptEntry {
    const parsed = transcriptEntrySchema.safeParse(entry);
    if (!parsed.success) throw new Error(`invalid TranscriptEntry: ${parsed.error.issues[0]?.message}`);
    const frozen = Object.freeze({ ...(parsed.data as TranscriptEntry) });
    this.log.push(frozen);
    return frozen;
  }

  /** Ordered copy — callers cannot mutate the internal log. */
  entries(): TranscriptEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  size(): number {
    return this.log.length;
  }

  /** Entries for one tenant only (isolation helper; full guard in SPEC-058). */
  forTenant(tenantId: string): TranscriptEntry[] {
    return this.log.filter((e) => e.identity.tenantId === tenantId).map((e) => ({ ...e }));
  }
}

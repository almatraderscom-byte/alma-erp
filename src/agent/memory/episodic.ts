/**
 * Episodic execution memory (G06 / SPEC-056).
 *
 * Records what the agent actually DID — actions and their outcomes — so past
 * executions can be recalled (e.g. "last time this failed"). Append-only,
 * tenant-scoped, deterministic. No LLM, no I/O.
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';

export const EPISODE_OUTCOMES = ['success', 'failure', 'unknown'] as const;
export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number];

export interface EpisodeRecord {
  id: string;
  identity: ExecutionIdentity;
  action: string;
  outcome: EpisodeOutcome;
  summary: string;
  atMs: number;
}

export const episodeSchema: z.ZodType<EpisodeRecord> = z.object({
  id: z.string().min(1),
  identity: executionIdentitySchema,
  action: z.string().min(1),
  outcome: z.enum(EPISODE_OUTCOMES),
  summary: z.string(),
  atMs: z.number().int().nonnegative(),
}) as z.ZodType<EpisodeRecord>;

export class EpisodicMemory {
  private readonly episodes: EpisodeRecord[] = [];

  record(ep: EpisodeRecord): void {
    const parsed = episodeSchema.safeParse(ep);
    if (!parsed.success) throw new Error(`invalid EpisodeRecord: ${parsed.error.issues[0]?.message}`);
    this.episodes.push({ ...(parsed.data as EpisodeRecord) });
  }

  /** Most-recent-first episodes for a tenant, optionally filtered by action/outcome. */
  recall(tenantId: string, opts: { action?: string; outcome?: EpisodeOutcome; limit?: number } = {}): EpisodeRecord[] {
    return this.episodes
      .filter((e) => e.identity.tenantId === tenantId)
      .filter((e) => (opts.action === undefined || e.action === opts.action))
      .filter((e) => (opts.outcome === undefined || e.outcome === opts.outcome))
      .sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id))
      .slice(0, opts.limit ?? 50)
      .map((e) => ({ ...e }));
  }
}

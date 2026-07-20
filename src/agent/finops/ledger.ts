/**
 * Cost event ledger (G03 / SPEC-028).
 *
 * An append-only record of every priced call. Ships as a typed contract + store
 * interface with an in-memory default. Durable persistence is a documented seam:
 * a PROPOSED Prisma model lives under `prisma/agent-cost/` for the integration
 * session to apply — this group never touches the live `schema.prisma` or runs a
 * migration (owner decision, production safety). Amounts are integer nano-USD.
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';
import type { ReconcileStatus } from './reconciliation';

export interface CostEvent {
  /** deterministic id (caller-supplied, e.g. `${correlationId}:${stepId}`) */
  id: string;
  identity: ExecutionIdentity;
  provider: string;
  model: string;
  estimatedNanoUsd: number;
  actualNanoUsd: number | null;
  status: ReconcileStatus;
  priceVerified: boolean;
  /** epoch millis supplied by the caller (module stays deterministic) */
  observedAtMs: number;
}

export const costEventSchema: z.ZodType<CostEvent> = z.object({
  id: z.string().min(1),
  identity: executionIdentitySchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  estimatedNanoUsd: z.number().int().nonnegative(),
  actualNanoUsd: z.number().int().nonnegative().nullable(),
  status: z.enum(['RECONCILED', 'OVER', 'UNDER', 'UNKNOWN']),
  priceVerified: z.boolean(),
  observedAtMs: z.number().int().nonnegative(),
}) as z.ZodType<CostEvent>;

export interface CostLedgerFilter {
  tenantId?: string;
  correlationId?: string;
  provider?: string;
}

export interface CostLedger {
  record(event: CostEvent): void;
  all(): CostEvent[];
  query(filter: CostLedgerFilter): CostEvent[];
  /** sum of actual where known, else estimated (billing-safe upper view) */
  totalNanoUsd(filter?: CostLedgerFilter): number;
}

/** In-memory append-only ledger (durable Prisma-backed store = future seam). */
export class InMemoryCostLedger implements CostLedger {
  private readonly events: CostEvent[] = [];

  record(event: CostEvent): void {
    const parsed = costEventSchema.safeParse(event);
    if (!parsed.success) throw new Error(`invalid CostEvent: ${parsed.error.issues[0]?.message}`);
    this.events.push(parsed.data as CostEvent);
  }

  all(): CostEvent[] {
    return [...this.events];
  }

  query(filter: CostLedgerFilter): CostEvent[] {
    return this.events.filter(
      (e) =>
        (filter.tenantId === undefined || e.identity.tenantId === filter.tenantId) &&
        (filter.correlationId === undefined || e.identity.correlationId === filter.correlationId) &&
        (filter.provider === undefined || e.provider === filter.provider),
    );
  }

  totalNanoUsd(filter: CostLedgerFilter = {}): number {
    return this.query(filter).reduce((sum, e) => sum + (e.actualNanoUsd ?? e.estimatedNanoUsd), 0);
  }
}

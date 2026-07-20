/**
 * Cost attribution dimensions (G03 / SPEC-029).
 *
 * Rolls cost events up along the canonical identity dimensions (tenant, business,
 * actor, agent, workflow, provider, model) so spend can be answered per any of
 * them. Deterministic, pure, integer nano-USD.
 */
import type { CostEvent } from './ledger';

export const ATTRIBUTION_DIMENSIONS = [
  'tenantId',
  'businessId',
  'actorId',
  'agentId',
  'workflowId',
  'provider',
  'model',
] as const;

export type AttributionDimension = (typeof ATTRIBUTION_DIMENSIONS)[number];

export interface AttributionRow {
  key: string;
  nanoUsd: number;
  count: number;
}

/** The billing-safe amount for an event: actual where known, else estimated. */
export function eventAmount(e: CostEvent): number {
  return e.actualNanoUsd ?? e.estimatedNanoUsd;
}

function dimensionValue(e: CostEvent, dim: AttributionDimension): string {
  switch (dim) {
    case 'provider':
      return e.provider;
    case 'model':
      return e.model;
    default:
      return e.identity[dim] ?? '(none)';
  }
}

/** Group events by a dimension, summing amount + count. Sorted by spend desc. */
export function attributeBy(events: CostEvent[], dim: AttributionDimension): AttributionRow[] {
  const acc = new Map<string, AttributionRow>();
  for (const e of events) {
    const key = dimensionValue(e, dim);
    const row = acc.get(key) ?? { key, nanoUsd: 0, count: 0 };
    row.nanoUsd += eventAmount(e);
    row.count += 1;
    acc.set(key, row);
  }
  return [...acc.values()].sort((a, b) => b.nanoUsd - a.nanoUsd || a.key.localeCompare(b.key));
}

/** Multi-dimension breakdown: one AttributionRow[] per requested dimension. */
export function attributeAll(
  events: CostEvent[],
  dims: AttributionDimension[] = [...ATTRIBUTION_DIMENSIONS],
): Record<string, AttributionRow[]> {
  const out: Record<string, AttributionRow[]> = {};
  for (const d of dims) out[d] = attributeBy(events, d);
  return out;
}

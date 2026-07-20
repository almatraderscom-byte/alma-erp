/**
 * Measured model router (G17 / SPEC-164).
 *
 * Picks the model that has actually performed best for a task class, instead of a
 * static guess: it combines the SPEC-162 cost-quality score and the SPEC-163
 * latency-availability score over the SPEC-161 records, across the G16 tier's
 * candidate bindings, and selects the highest deterministically.
 *
 * FROZEN INVARIANT — *no frontier head model as a default route* (G17). The
 * default router refuses to route the frontier tier (T4) and the deterministic
 * tier (T0): `routeModel` accepts only the routable tiers T1..T3. Frontier is
 * reachable ONLY through the explicit escalation path (SPEC-165/166), never here.
 *
 * Fail-closed / fail-safe: missing identity or an unroutable tier is a typed
 * failure; when NO candidate has measured records, the router falls back to the
 * tier's registry PRIMARY (the cheapest safe default — never frontier), flagged
 * `default-primary`. Deterministic; consumes G03 cost inputs; makes no provider
 * call (INV-01).
 */
import { z } from 'zod';
import {
  completed,
  executionIdentitySchema,
  failure,
  type ComponentFailure,
  type ComponentRequest,
  type ComponentResult,
} from '@/agent/contracts';
import { MODEL_TIERS, isModelTier, type ModelTier } from '@/agent/models';
import { createTierModelRegistry, type ModelBinding, type TierModelRegistry } from '@/agent/models';
import { createCapabilityGate, type CapabilityGate } from '@/agent/providers/runtime/capabilities';
import { avgCostNanoUsd, avgLatencyMs, type PerformanceRecordStore, type PerfRecord } from './performance-records';
import { scoreRecordCostQuality } from './cost-quality-score';
import { scoreRecordLatencyAvailability } from './latency-availability-score';

export const ROUTE_REASON_CODES = {
  FRONTIER_FORBIDDEN: 'ROUTE_FRONTIER_FORBIDDEN',
  TIER_NOT_ROUTABLE: 'ROUTE_TIER_NOT_ROUTABLE',
  TIER_UNKNOWN: 'ROUTE_TIER_UNKNOWN',
  NO_CANDIDATES: 'ROUTE_NO_CANDIDATES',
  CAPABILITY_UNSUPPORTED: 'ROUTE_CAPABILITY_UNSUPPORTED',
} as const;

/** The tiers the default router may pick. T0 is code-only; T4 is escalation-only. */
export const ROUTABLE_TIERS: ModelTier[] = ['T1', 'T2', 'T3'];
export function isRoutableTier(t: ModelTier): boolean {
  return ROUTABLE_TIERS.includes(t);
}

/** The invariant, as a reusable guard (SPEC-170 asserts on it). */
export function isFrontierTier(t: ModelTier): boolean {
  return t === 'T4';
}

export interface RouteWeights {
  costQualityWeightMilli: number;
  latencyAvailabilityWeightMilli: number; // sum must be 1000
}
export const DEFAULT_ROUTE_WEIGHTS: RouteWeights = { costQualityWeightMilli: 600, latencyAvailabilityWeightMilli: 400 };

function assertRouteWeights(w: RouteWeights): void {
  if (w.costQualityWeightMilli < 0 || w.latencyAvailabilityWeightMilli < 0 || w.costQualityWeightMilli + w.latencyAvailabilityWeightMilli !== 1000) {
    throw new Error('route weights must be non-negative and sum to 1000');
  }
}

export interface RouteQuery {
  taskClass: string;
  tier: ModelTier;
  requiredCapabilities?: string[];
}

export interface RouteDecision {
  taskClass: string;
  tier: ModelTier;
  provider: string;
  model: string;
  score: number;
  basis: 'measured' | 'default-primary';
}

export const routeQuerySchema: z.ZodType<RouteQuery> = z.object({
  taskClass: z.string().min(1),
  tier: z.enum(MODEL_TIERS),
  requiredCapabilities: z.array(z.string().min(1)).optional(),
}) as z.ZodType<RouteQuery>;

export interface MeasuredRouterDeps {
  records: PerformanceRecordStore;
  registry?: TierModelRegistry;
  capabilities?: CapabilityGate;
  weights?: RouteWeights;
}

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

/** Reference = max finite measured value among candidates (≥1), for normalization. */
function references(records: PerfRecord[]): { refCost: number; refLat: number } {
  let refCost = 1;
  let refLat = 1;
  for (const r of records) {
    if (r.samples === 0) continue;
    refCost = Math.max(refCost, avgCostNanoUsd(r));
    refLat = Math.max(refLat, avgLatencyMs(r));
  }
  return { refCost, refLat };
}

export function routeModel(raw: unknown, deps: MeasuredRouterDeps): ComponentResult<RouteDecision> {
  const envelope = z.object({ identity: executionIdentitySchema, contractVersion: z.string().min(1), payload: routeQuerySchema }).safeParse(raw);
  if (!envelope.success) {
    const codes = new Set<string>();
    for (const issue of envelope.error.issues) {
      const p = issue.path.join('.');
      if (p === 'identity.tenantId') codes.add('MISSING_TENANT');
      else if (p === 'identity.actorId') codes.add('MISSING_ACTOR');
      else codes.add('MALFORMED_INPUT');
    }
    return fail('FAILED_FINAL', [...codes]);
  }
  const req = envelope.data as ComponentRequest<RouteQuery>;
  const { tier, taskClass } = req.payload;

  if (!isModelTier(tier)) return fail('FAILED_FINAL', [ROUTE_REASON_CODES.TIER_UNKNOWN]);
  // FROZEN INVARIANT: the frontier tier is never a default route.
  if (isFrontierTier(tier)) return fail('DENIED', [ROUTE_REASON_CODES.FRONTIER_FORBIDDEN]);
  if (!isRoutableTier(tier)) return fail('FAILED_FINAL', [ROUTE_REASON_CODES.TIER_NOT_ROUTABLE]); // T0 = code-only

  const registry = deps.registry ?? createTierModelRegistry();
  const weights = deps.weights ?? DEFAULT_ROUTE_WEIGHTS;
  assertRouteWeights(weights);

  let candidates = registry.candidates(tier);
  if (candidates.length === 0) return fail('FAILED_FINAL', [ROUTE_REASON_CODES.NO_CANDIDATES]);

  // capability filter (fail closed if it empties the set)
  if (req.payload.requiredCapabilities?.length) {
    const gate = deps.capabilities ?? createCapabilityGate();
    candidates = candidates.filter((c) => gate.check(c.provider, c.model, req.payload.requiredCapabilities!) === null);
    if (candidates.length === 0) return fail('FAILED_FINAL', [ROUTE_REASON_CODES.CAPABILITY_UNSUPPORTED]);
  }

  // gather records + references
  const recs = candidates.map((c) => deps.records.get(taskClass, c.provider, c.model));
  const measured = recs.filter((r): r is PerfRecord => r !== null && r.samples > 0);
  const { refCost, refLat } = references(measured);

  // score each candidate; unmeasured candidates score 0 (fail-safe)
  const scored = candidates.map((c, i) => {
    const rec = recs[i];
    if (!rec || rec.samples === 0) return { binding: c, score: 0 };
    const cq = scoreRecordCostQuality(rec, refCost);
    const la = scoreRecordLatencyAvailability(rec, refLat);
    const score = Math.floor((cq * weights.costQualityWeightMilli + la * weights.latencyAvailabilityWeightMilli) / 1000);
    return { binding: c, score };
  });

  const anyMeasured = measured.length > 0;
  if (!anyMeasured) {
    // fail-safe: no telemetry → cheapest safe default = registry primary (never frontier)
    const primary = registry.primary(tier) as ModelBinding;
    return decision(taskClass, tier, primary, 0, 'default-primary', req.identity.correlationId);
  }

  // deterministic pick: highest score, tiebreak by candidate order then model id
  let best = scored[0];
  for (let i = 1; i < scored.length; i++) {
    const s = scored[i];
    if (s.score > best.score || (s.score === best.score && s.binding.model.localeCompare(best.binding.model) < 0)) {
      best = s;
    }
  }
  return decision(taskClass, tier, best.binding, best.score, 'measured', req.identity.correlationId);
}

function decision(
  taskClass: string,
  tier: ModelTier,
  binding: ModelBinding,
  score: number,
  basis: RouteDecision['basis'],
  correlationId: string,
): ComponentResult<RouteDecision> {
  return completed<RouteDecision>(
    { taskClass, tier, provider: binding.provider, model: binding.model, score, basis },
    [`route:${correlationId}`, `pick:${binding.provider}/${binding.model}`],
    { routing: '1.0.0', tier },
  );
}

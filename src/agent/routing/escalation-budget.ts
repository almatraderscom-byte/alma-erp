/**
 * Escalation budget enforcement (G17 / SPEC-166).
 *
 * An explicit escalation (SPEC-165) is necessary but not sufficient: it must also
 * fit a per-actor, per-day budget, with a *stricter* cap on frontier (T4)
 * escalations. This is the G04-style hard cap applied at the routing layer — it
 * keeps a runaway loop from escalating without bound and keeps expensive frontier
 * calls rare, per the frozen "no frontier as default" posture.
 *
 * Deterministic: the day bucket comes from an INJECTED clock (never an ambient
 * clock read — INV-01). Fail-closed: over cap → `BUDGET_EXCEEDED`, and a frontier
 * escalation consumes BOTH the general and the frontier counter.
 */
import { completed, type ComponentFailure, type ComponentResult } from '@/agent/contracts';
import type { Clock } from '@/agent/models';
import { validateEscalation, type EscalationGrant, type EscalationRequest } from './escalation-reason';

const DAY_MS = 86_400_000;

export const ESCALATION_BUDGET_REASON_CODES = {
  DAILY_CAP_EXCEEDED: 'ESCALATION_DAILY_CAP_EXCEEDED',
  FRONTIER_DAILY_CAP_EXCEEDED: 'ESCALATION_FRONTIER_DAILY_CAP_EXCEEDED',
} as const;

export interface EscalationBudgetConfig {
  maxEscalationsPerDay: number;
  maxFrontierPerDay: number;
}
export const DEFAULT_ESCALATION_BUDGET: EscalationBudgetConfig = { maxEscalationsPerDay: 20, maxFrontierPerDay: 3 };

export type BudgetDecision = { ok: true } | { ok: false; reasonCode: string };

export interface EscalationBudgetStore {
  tryConsume(dayKey: string, actorKey: string, toFrontier: boolean): BudgetDecision;
}

/** Deterministic in-memory per-actor per-day escalation budget. */
export function createInMemoryEscalationBudget(config: EscalationBudgetConfig = DEFAULT_ESCALATION_BUDGET): EscalationBudgetStore {
  // key = `${dayKey}|${actorKey}` → { total, frontier }
  const counters = new Map<string, { total: number; frontier: number }>();
  return {
    tryConsume(dayKey: string, actorKey: string, toFrontier: boolean): BudgetDecision {
      const key = `${dayKey}|${actorKey}`;
      const cur = counters.get(key) ?? { total: 0, frontier: 0 };
      // stricter frontier cap checked first
      if (toFrontier && cur.frontier >= config.maxFrontierPerDay) {
        return { ok: false, reasonCode: ESCALATION_BUDGET_REASON_CODES.FRONTIER_DAILY_CAP_EXCEEDED };
      }
      if (cur.total >= config.maxEscalationsPerDay) {
        return { ok: false, reasonCode: ESCALATION_BUDGET_REASON_CODES.DAILY_CAP_EXCEEDED };
      }
      counters.set(key, { total: cur.total + 1, frontier: cur.frontier + (toFrontier ? 1 : 0) });
      return { ok: true };
    },
  };
}

export interface EscalationEnforcementDeps {
  budget: EscalationBudgetStore;
  clock: Clock;
}

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

/**
 * The full gate: validate the escalation reason (SPEC-165) AND consume the budget.
 * Only an escalation that is both legal and within budget is granted.
 */
export function enforceEscalation(req: EscalationRequest, deps: EscalationEnforcementDeps): ComponentResult<EscalationGrant> {
  const validated = validateEscalation(req);
  if (validated.status !== 'COMPLETED') return validated; // reason/tier/identity failure passes through

  const grant = validated.value;
  const dayKey = String(Math.floor(deps.clock.now() / DAY_MS));
  const decision = deps.budget.tryConsume(dayKey, req.identity.actorId, grant.toFrontier);
  if (!decision.ok) {
    return fail('BUDGET_EXCEEDED', [decision.reasonCode]);
  }
  return completed<EscalationGrant>(
    grant,
    [`escalation-budget:${req.identity.correlationId}`, `day:${dayKey}`],
    { escalation: '1.0.0', escalationBudget: '1.0.0' },
  );
}

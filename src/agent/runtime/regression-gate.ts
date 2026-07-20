/**
 * Routing and head-isolation regression gate (G17 / SPEC-170).
 *
 * The executable guardian of this group's frozen invariants. It exercises the
 * REAL group functions with synthetic inputs and asserts, deterministically:
 *
 *   1. the measured router refuses the frontier tier as a default (DENIED);
 *   2. every default route is non-frontier;
 *   3. escalation requires a reason, and frontier requires a frontier-eligible one;
 *   4. the escalation budget caps frontier escalations;
 *   5. de-escalation never yields a frontier execution tier;
 *   6. the head planner rejects a frontier-execution step;
 *   7. a head-class invocation may not run a tool loop.
 *
 * It returns a structured `RegressionReport` (never throws) so CI can gate on it.
 * Dependencies are injectable (defaulting to the real functions) so a test can
 * feed a deliberately-broken component and prove the gate CATCHES the regression.
 * No provider call, no clock read (a fixed clock is built internally) — INV-01.
 */
import { isSuccess, type ComponentResult, type ExecutionIdentity } from '@/agent/contracts';
import { fixedClock, type ModelTier } from '@/agent/models';
import {
  routeModel as realRouteModel,
  isFrontierTier,
  type RouteDecision,
  type MeasuredRouterDeps,
} from '@/agent/routing/measured-router';
import { validateEscalation as realValidateEscalation, type EscalationRequest, type EscalationGrant } from '@/agent/routing/escalation-reason';
import { enforceEscalation as realEnforceEscalation, createInMemoryEscalationBudget } from '@/agent/routing/escalation-budget';
import { InMemoryPerformanceRecordStore } from '@/agent/routing/performance-records';
import { deEscalatedExecutionTier as realDeEsc, assertDeEscalated as realAssertDeEsc } from './de-escalation';
import { runHeadPlanner as realRunHeadPlanner, type HeadPlannerFn } from './head-planner';
import { assertNoHeadToolLoop as realAssertNoHeadToolLoop } from './head-tool-loop-guard';

export interface RegressionCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface RegressionReport {
  passed: boolean;
  checks: RegressionCheck[];
}

export interface RegressionDeps {
  routeModel?: (raw: unknown, deps: MeasuredRouterDeps) => ComponentResult<RouteDecision>;
  validateEscalation?: (req: EscalationRequest) => ComponentResult<EscalationGrant>;
  enforceEscalation?: typeof realEnforceEscalation;
  deEscalatedExecutionTier?: (t: ModelTier) => ModelTier;
  assertDeEscalated?: typeof realAssertDeEsc;
  runHeadPlanner?: typeof realRunHeadPlanner;
  assertNoHeadToolLoop?: typeof realAssertNoHeadToolLoop;
}

const IDENTITY: ExecutionIdentity = { tenantId: 'gate', actorId: 'gate', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const ROUTABLE: ModelTier[] = ['T1', 'T2', 'T3'];

export function runRoutingHeadIsolationRegression(deps: RegressionDeps = {}): RegressionReport {
  const routeModel = deps.routeModel ?? realRouteModel;
  const validateEscalation = deps.validateEscalation ?? realValidateEscalation;
  const enforceEscalation = deps.enforceEscalation ?? realEnforceEscalation;
  const deEscalatedExecutionTier = deps.deEscalatedExecutionTier ?? realDeEsc;
  const assertDeEscalated = deps.assertDeEscalated ?? realAssertDeEsc;
  const runHeadPlanner = deps.runHeadPlanner ?? realRunHeadPlanner;
  const assertNoHeadToolLoop = deps.assertNoHeadToolLoop ?? realAssertNoHeadToolLoop;

  const checks: RegressionCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const records = new InMemoryPerformanceRecordStore();
  const req = (payload: unknown) => ({ identity: IDENTITY, contractVersion: '1.0.0', payload });

  // 1. router refuses frontier as a default
  {
    const r = routeModel(req({ taskClass: 't', tier: 'T4' }), { records });
    add('router-refuses-frontier-default', r.status === 'DENIED');
  }

  // 2. every default route is non-frontier
  {
    let allNonFrontier = true;
    for (const tier of ROUTABLE) {
      const r = routeModel(req({ taskClass: 't', tier }), { records });
      if (!isSuccess(r) || isFrontierTier(r.value.tier)) allNonFrontier = false;
    }
    add('router-default-routes-non-frontier', allNonFrontier);
  }

  // 3. escalation reason discipline
  {
    const noReason = validateEscalation({ identity: IDENTITY, fromTier: 'T2', toTier: 'T3', reason: 'BOGUS' as never });
    const casualFrontier = validateEscalation({ identity: IDENTITY, fromTier: 'T3', toTier: 'T4', reason: 'LOW_CONFIDENCE' });
    const okFrontier = validateEscalation({ identity: IDENTITY, fromTier: 'T3', toTier: 'T4', reason: 'BIG_MONEY' });
    add('escalation-needs-reason', noReason.status === 'DENIED');
    add('frontier-needs-eligible-reason', casualFrontier.status === 'DENIED' && isSuccess(okFrontier));
  }

  // 4. escalation budget caps frontier
  {
    const budget = createInMemoryEscalationBudget({ maxEscalationsPerDay: 100, maxFrontierPerDay: 1 });
    const clock = fixedClock(0);
    const mk = () => enforceEscalation({ identity: IDENTITY, fromTier: 'T3', toTier: 'T4', reason: 'BIG_MONEY' }, { budget, clock });
    const first = mk();
    const second = mk();
    add('escalation-budget-caps-frontier', isSuccess(first) && second.status === 'BUDGET_EXCEEDED');
  }

  // 5. de-escalation never frontier
  {
    let ok = true;
    for (const planning of ['T1', 'T2', 'T3', 'T4'] as ModelTier[]) {
      if (deEscalatedExecutionTier(planning) === 'T4') ok = false;
    }
    const frontierExec = assertDeEscalated('T4', 'T4');
    add('de-escalation-never-frontier', ok && frontierExec.status !== 'COMPLETED');
  }

  // 6. head planner rejects a frontier-execution step
  {
    const badPlanner: HeadPlannerFn = () => [{ stepId: 'x', taskClass: 't', executionTier: 'T4' }];
    const r = runHeadPlanner({ identity: IDENTITY, taskClass: 't', planningTier: 'T4' }, { planner: badPlanner });
    add('head-planner-rejects-frontier-exec', r.status !== 'COMPLETED');
  }

  // 7. head-class invocation may not run a tool loop
  {
    const headLoop = assertNoHeadToolLoop({ role: 'head', tier: 'T3', toolCalls: 2 });
    const frontierLoop = assertNoHeadToolLoop({ role: 'worker', tier: 'T4', toolCalls: 1 });
    const workerLoopOk = assertNoHeadToolLoop({ role: 'worker', tier: 'T2', toolCalls: 9 });
    add('head-no-tool-loop', headLoop.status !== 'COMPLETED' && frontierLoop.status !== 'COMPLETED' && isSuccess(workerLoopOk));
  }

  return { passed: checks.every((c) => c.ok), checks };
}

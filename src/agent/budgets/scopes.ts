/**
 * Budget scope key-builders (G04 / SPEC-032..038).
 *
 * Each scope produces a unique `Budget.key` so the store tracks spend per scope
 * instance. The Cost Governor authorises a call against the full set of scopes
 * that apply to it (org → business → user → workflow → turn → model-call →
 * tool-loop → browser-task). Default limits live in `config.ts` (owner-tunable).
 */
import type { Budget } from './budget';

/** SPEC-032 — per-business (Lifestyle / Trading / CDIT) monthly budget. */
export function businessBudget(tenantId: string, businessId: string, yearMonth: string, limitNanoUsd: number): Budget {
  return { scope: 'business', key: `business:${tenantId}:${businessId}:${yearMonth}`, limitNanoUsd };
}

/** SPEC-033 — per-user / service-account monthly budget. */
export function userBudget(tenantId: string, actorId: string, yearMonth: string, limitNanoUsd: number): Budget {
  return { scope: 'user', key: `user:${tenantId}:${actorId}:${yearMonth}`, limitNanoUsd };
}

/** SPEC-034 — per-workflow-run budget (whole multi-step task). */
export function workflowBudget(workflowId: string, limitNanoUsd: number): Budget {
  return { scope: 'workflow', key: `workflow:${workflowId}`, limitNanoUsd };
}

/** SPEC-035 — per-turn budget (one inbound request / correlation). */
export function turnBudget(correlationId: string, limitNanoUsd: number): Budget {
  return { scope: 'turn', key: `turn:${correlationId}`, limitNanoUsd };
}

/** SPEC-036 — per single model-call ceiling (one call/step). */
export function modelCallBudget(correlationId: string, stepId: string, limitNanoUsd: number): Budget {
  return { scope: 'model_call', key: `call:${correlationId}:${stepId}`, limitNanoUsd };
}

/** SPEC-037 — total budget across one tool/agent loop (bounds runaway loops). */
export function toolLoopBudget(workflowId: string, limitNanoUsd: number): Budget {
  return { scope: 'tool_loop', key: `toolloop:${workflowId}`, limitNanoUsd };
}

/** SPEC-038 — per browser-automation task budget (long/expensive tasks). */
export function browserTaskBudget(taskId: string, limitNanoUsd: number): Budget {
  return { scope: 'browser_task', key: `browser:${taskId}`, limitNanoUsd };
}

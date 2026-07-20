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

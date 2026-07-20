/**
 * Default budget limits (G04). Integer nano-USD, USD only.
 *
 * These are OWNER-TUNABLE PLACEHOLDERS, not authoritative numbers — the owner
 * sets real limits at runtime (per CLAUDE.md, via `agent_kv_settings`, no
 * redeploy). Every default is marked so nothing silently enforces a guessed cap.
 */
import { usdToNano } from '../providers/pricing/registry';
import type { BudgetScope } from './budget';

export interface BudgetDefault {
  scope: BudgetScope;
  limitNanoUsd: number;
  ownerTunable: true;
  note: string;
}

/** Conservative placeholder limits — replace with owner-set values at runtime. */
export const DEFAULT_BUDGET_LIMITS: Partial<Record<BudgetScope, BudgetDefault>> = {
  business: { scope: 'business', limitNanoUsd: usdToNano(100), ownerTunable: true, note: 'per business / month — placeholder' },
};

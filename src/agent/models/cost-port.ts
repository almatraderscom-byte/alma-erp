/**
 * Cost Governor–backed cost authorization port (G16 / SPEC-155).
 *
 * The concrete binding of the fabric's `CostAuthorizationPort` to the real G04
 * Cost Governor + G03 pricing/estimator. This is what makes INV-03 *real*: before
 * any provider call the fabric reserves the worst-case cost against the caller's
 * budgets; a call that cannot be afforded is denied and the provider is never
 * invoked; after the call the actual cost is settled (or released on failure).
 *
 * It performs NO network call — it is pure arithmetic over the in-memory budget
 * store and the pricing registry (both deterministic). Wiring the governor to a
 * durable budget store is a documented seam owned by G04.
 */
import { isSuccess } from '@/agent/contracts';
import { authorize as governorAuthorize, settle as governorSettle, cancel as governorCancel, type Authorization } from '@/agent/control-plane/cost/governor';
import { getPrice, type ProviderPrice } from '@/agent/providers/pricing/registry';
import { estimateWorstCaseCost, estimateNormalCost } from '@/agent/finops/estimator';
import type { Budget, BudgetStore } from '@/agent/budgets/budget';
import type { TokenUsage } from '@/agent/finops/tokens';
import type { CostAuthorization, CostAuthorizationInput, CostAuthorizationPort } from './ports';

/** Fail-closed reason when a model has no registered price (cannot be authorized). */
export const COST_PORT_REASON_CODES = {
  NO_PRICE: 'MODEL_NO_PRICE_UNAUTHORIZED',
} as const;

export interface GovernorCostPortDeps {
  store: BudgetStore;
  /** the ordered budget scopes this call must fit within (org → … → model_call) */
  budgetsFor(input: CostAuthorizationInput): Budget[];
}

export function createGovernorCostPort(deps: GovernorCostPortDeps): CostAuthorizationPort {
  const live = new Map<string, { auth: Authorization; price: ProviderPrice }>();
  let seq = 0;

  return {
    async authorize(input: CostAuthorizationInput): Promise<CostAuthorization> {
      const price = getPrice(input.provider, input.model);
      if (!price) {
        // no price → cannot compute worst case → fail closed (never call unpriced)
        return { status: 'DENIED', reasonCodes: [COST_PORT_REASON_CODES.NO_PRICE] };
      }
      const worst = estimateWorstCaseCost(price, {
        maxInputTokens: input.estInputTokens,
        maxOutputTokens: input.estMaxOutputTokens,
        maxReasoningTokens: input.estMaxOutputTokens,
      });
      const budgets = deps.budgetsFor(input);
      const result = governorAuthorize(worst.nanoUsd, budgets, deps.store);
      if (isSuccess(result)) {
        const id = `gov-${++seq}`;
        live.set(id, { auth: result.value, price });
        return { status: 'ALLOWED', authorizationId: id, evidenceIds: result.evidenceIds };
      }
      const status = result.status === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'DENIED';
      return { status, reasonCodes: result.reasonCodes, evidenceIds: result.evidenceIds };
    },

    async settle(authorizationId: string, usage: TokenUsage): Promise<void> {
      const entry = live.get(authorizationId);
      if (!entry) return;
      const actual = estimateNormalCost(entry.price, usage);
      governorSettle(entry.auth, actual.nanoUsd, deps.store);
      live.delete(authorizationId);
    },

    async release(authorizationId: string): Promise<void> {
      const entry = live.get(authorizationId);
      if (!entry) return;
      governorCancel(entry.auth, deps.store);
      live.delete(authorizationId);
    },
  };
}

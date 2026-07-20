/**
 * Shared deterministic test doubles for the model fabric (G16).
 * Not a test file — imported by the *.test.ts suites.
 */
import type { ExecutionIdentity } from '@/agent/contracts';
import type { TokenUsage } from '@/agent/finops/tokens';
import type { CostAuthorization, CostAuthorizationInput, CostAuthorizationPort } from '../ports';
import type { ModelInvocationPayload, ModelRequest } from '../contract';
import { MODEL_FABRIC_CONTRACT_VERSION } from '../contract';
import type { TierDefinition, ModelTier } from '../tiers';
import type { TierHandler, TierPrepared, TierPrepareContext } from '../tier-handler';

export const baseIdentity: ExecutionIdentity = {
  tenantId: 'alma',
  businessId: 'alma-lifestyle',
  actorId: 'owner:maruf',
  agentId: 'head',
  workflowId: 'wf-1',
  stepId: 'step-1',
  correlationId: 'corr-1',
};

export function makeRequest(payload: ModelInvocationPayload, identity: Partial<ExecutionIdentity> = {}): ModelRequest {
  return {
    identity: { ...baseIdentity, ...identity },
    contractVersion: MODEL_FABRIC_CONTRACT_VERSION,
    payload,
  };
}

export interface FakeCostPort extends CostAuthorizationPort {
  readonly authorizeCalls: CostAuthorizationInput[];
  readonly settled: Array<{ id: string; usage: TokenUsage }>;
  readonly released: string[];
}

export function createFakeCostPort(opts: { deny?: 'DENIED' | 'BUDGET_EXCEEDED'; reasonCodes?: string[] } = {}): FakeCostPort {
  const authorizeCalls: CostAuthorizationInput[] = [];
  const settled: Array<{ id: string; usage: TokenUsage }> = [];
  const released: string[] = [];
  let seq = 0;
  return {
    authorizeCalls,
    settled,
    released,
    async authorize(input: CostAuthorizationInput): Promise<CostAuthorization> {
      authorizeCalls.push(input);
      if (opts.deny) {
        return { status: opts.deny, reasonCodes: opts.reasonCodes ?? ['BUDGET_DENIED_TEST'] };
      }
      return { status: 'ALLOWED', authorizationId: `auth-${++seq}`, evidenceIds: [`cost:auth-${seq}`] };
    },
    async settle(id: string, usage: TokenUsage): Promise<void> {
      settled.push({ id, usage });
    },
    async release(id: string): Promise<void> {
      released.push(id);
    },
  };
}

/**
 * A permissive stub tier handler used by SPEC-151 fabric tests (before the real
 * tier handlers exist). It always emits INVOKE constraints from the tier's
 * primary binding and passes the raw text through.
 */
export function stubTierHandler(tier: ModelTier): TierHandler {
  return {
    tier,
    prepare(payload: ModelInvocationPayload, def: TierDefinition, ctx: TierPrepareContext): TierPrepared {
      const binding = ctx.registry.primary(tier, payload.role);
      if (!binding) return { kind: 'FAILURE', failure: { status: 'FAILED_FINAL', reasonCodes: ['MODEL_NOT_CONFIGURED'], evidenceIds: [] } };
      const requested = payload.maxOutputTokens ?? def.maxOutputTokens;
      return {
        kind: 'INVOKE',
        constraints: {
          provider: binding.provider,
          model: binding.model,
          role: binding.role,
          responseFormat: payload.responseFormat,
          maxOutputTokens: Math.min(requested, def.maxOutputTokens),
          timeoutMs: def.defaultTimeoutMs,
          maxRetries: def.maxRetries,
        },
      };
    },
    finalize(rawText: string): { kind: 'OK'; text: string } {
      return { kind: 'OK', text: rawText };
    },
  };
}

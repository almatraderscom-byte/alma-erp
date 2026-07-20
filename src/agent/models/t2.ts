/**
 * Cheap specialist T2 tier (G16 / SPEC-154).
 *
 * The everyday work tier: cheap, role-scoped specialists. Per the owner model
 * allocation (CLAUDE.md), most roles run on a cheap model (DeepSeek) while the
 * customer-facing `cs` role routes to a stronger Bangla model (Qwen) — the fabric
 * expresses this purely through the tier→model registry's role hint, so the
 * caller still asks only for tier + role, never a vendor model.
 *
 * Constraints:
 *  - task kind must be `specialist`;
 *  - a `role` from the closed T2 role set is required (fail closed otherwise);
 *  - output bounded to the T2 ceiling;
 *  - `json` output is validated; `text` passes through.
 */
import { REASON_CODES, type ComponentFailure } from '@/agent/contracts';
import { MODEL_REASON_CODES } from './reason-codes';
import type { ModelInvocationPayload } from './contract';
import type { TierDefinition } from './tiers';
import type { TierConstraints, TierFinalized, TierHandler, TierPrepareContext, TierPrepared } from './tier-handler';

/** Closed set of specialist roles the T2 tier serves. */
export const T2_ROLES = ['ops', 'orders', 'cs', 'marketing', 'research'] as const;
export type T2Role = (typeof T2_ROLES)[number];

export function isT2Role(x: unknown): x is T2Role {
  return typeof x === 'string' && (T2_ROLES as readonly string[]).includes(x);
}

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

export function createT2Handler(): TierHandler {
  return {
    tier: 'T2',
    prepare(payload: ModelInvocationPayload, def: TierDefinition, ctx: TierPrepareContext): TierPrepared {
      if (payload.taskKind !== 'specialist') {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      // a specialist tier requires an explicit, known role
      if (!isT2Role(payload.role)) {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      const binding = ctx.registry.primary('T2', payload.role);
      if (!binding) return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.MODEL_NOT_CONFIGURED]) };

      const requested = payload.maxOutputTokens ?? def.maxOutputTokens;
      const constraints: TierConstraints = {
        provider: binding.provider,
        model: binding.model,
        role: payload.role,
        responseFormat: payload.responseFormat,
        maxOutputTokens: Math.min(requested, def.maxOutputTokens),
        timeoutMs: def.defaultTimeoutMs,
        maxRetries: def.maxRetries,
      };
      return { kind: 'INVOKE', constraints };
    },
    finalize(rawText: string, constraints: TierConstraints): TierFinalized {
      if (constraints.responseFormat === 'json') {
        try {
          JSON.parse(rawText);
        } catch {
          return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.OUTPUT_MALFORMED]) };
        }
      }
      // NOTE: the customer-facing `cs` role's Bangla-quality gate
      // (bangla-output-gate) is a documented seam applied by the response gate,
      // not the model fabric. Kept out of the fabric by design.
      return { kind: 'OK', text: rawText };
    },
  };
}

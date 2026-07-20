/**
 * Standard reasoner T3 tier (G16 / SPEC-155).
 *
 * The owner-facing head class — a standard reasoner (Gemini 3.1 Pro by default).
 * This is the representative production tier: full reasoning allowed, large
 * context and output ceilings. It is a general reasoning tier, so it accepts
 * `reason` tasks in either `text` or `json` form; `json` output is validated.
 */
import { REASON_CODES, type ComponentFailure } from '@/agent/contracts';
import { MODEL_REASON_CODES } from './reason-codes';
import type { ModelInvocationPayload } from './contract';
import type { TierDefinition } from './tiers';
import type { TierConstraints, TierFinalized, TierHandler, TierPrepareContext, TierPrepared } from './tier-handler';

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

export function createT3Handler(): TierHandler {
  return {
    tier: 'T3',
    prepare(payload: ModelInvocationPayload, def: TierDefinition, ctx: TierPrepareContext): TierPrepared {
      if (payload.taskKind !== 'reason') {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      const binding = ctx.registry.primary('T3', payload.role);
      if (!binding) return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.MODEL_NOT_CONFIGURED]) };

      const requested = payload.maxOutputTokens ?? def.maxOutputTokens;
      const constraints: TierConstraints = {
        provider: binding.provider,
        model: binding.model,
        role: binding.role,
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
      return { kind: 'OK', text: rawText };
    },
  };
}

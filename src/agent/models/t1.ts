/**
 * Classifier & extractor T1 tier (G16 / SPEC-153).
 *
 * The cheapest LLM tier. It exists for one job: turn text into a small,
 * STRUCTURED result — a classification label or an extracted JSON object. It is
 * deliberately constrained so it can never be (mis)used as a general reasoner:
 *
 *  - task kind must be `classify` or `extract`;
 *  - response format must be `json` (structured only — no free-form prose);
 *  - output is bounded to the tier's tiny ceiling (`TIER_DEFINITIONS.T1`);
 *  - the provider text must parse as JSON, else `MODEL_OUTPUT_MALFORMED`;
 *  - for `classify` with a closed `labels` set, the returned `label` must be a
 *    member of that set, else `MODEL_OUTPUT_MALFORMED` (fail closed — no guessing).
 */
import { REASON_CODES, type ComponentFailure } from '@/agent/contracts';
import { MODEL_REASON_CODES } from './reason-codes';
import type { ModelInvocationPayload } from './contract';
import type { TierDefinition } from './tiers';
import type { TierConstraints, TierFinalized, TierHandler, TierPrepareContext, TierPrepared } from './tier-handler';

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

export function createT1Handler(): TierHandler {
  return {
    tier: 'T1',
    prepare(payload: ModelInvocationPayload, def: TierDefinition, ctx: TierPrepareContext): TierPrepared {
      if (payload.taskKind !== 'classify' && payload.taskKind !== 'extract') {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      if (payload.responseFormat !== 'json') {
        // T1 is structured-only; refuse free-form output requests
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      const binding = ctx.registry.primary('T1', payload.role);
      if (!binding) return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.MODEL_NOT_CONFIGURED]) };

      const requested = payload.maxOutputTokens ?? def.maxOutputTokens;
      const constraints: TierConstraints = {
        provider: binding.provider,
        model: binding.model,
        role: binding.role,
        responseFormat: 'json',
        maxOutputTokens: Math.min(requested, def.maxOutputTokens),
        timeoutMs: def.defaultTimeoutMs,
        maxRetries: def.maxRetries,
      };
      return { kind: 'INVOKE', constraints };
    },
    finalize(rawText: string, _c: TierConstraints, payload: ModelInvocationPayload): TierFinalized {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.OUTPUT_MALFORMED]) };
      }
      if (payload.taskKind === 'classify' && payload.labels && payload.labels.length > 0) {
        const label = (parsed as { label?: unknown }).label;
        if (typeof label !== 'string' || !payload.labels.includes(label)) {
          return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.OUTPUT_MALFORMED]) };
        }
      }
      return { kind: 'OK', text: rawText };
    },
  };
}

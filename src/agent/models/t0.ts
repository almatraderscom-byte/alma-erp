/**
 * Deterministic T0 path (G16 / SPEC-152).
 *
 * T0 is the tier that makes **no model call at all** — it realises INV-01: "do
 * not add an LLM call for deterministic validation, routing, permission, budget
 * arithmetic or postcondition checking." A T0 request is resolved by a pure,
 * registered template renderer and returns a `RESOLVED` value; the fabric returns
 * it as COMPLETED without ever touching an adapter or the Cost Governor.
 *
 * Templates are deterministic pure functions of their variables. An unknown
 * template key fails closed (never silently escalates to an LLM tier).
 */
import { EMPTY_USAGE } from '@/agent/finops/tokens';
import { REASON_CODES, type ComponentFailure } from '@/agent/contracts';
import { MODEL_REASON_CODES } from './reason-codes';
import type { ModelInvocationPayload, ModelInvocationValue } from './contract';
import type { TierDefinition } from './tiers';
import type { TierHandler, TierPrepared, TierFinalized, TierConstraints } from './tier-handler';

/** A deterministic template: pure function from variables to output text. */
export interface T0Template {
  key: string;
  render(vars: Record<string, string>): string;
}

export type T0TemplateTable = Record<string, T0Template>;

/** Built-in deterministic templates. Pure; no I/O; no randomness. */
export const DEFAULT_T0_TEMPLATES: T0TemplateTable = {
  // echo back a provided value verbatim (canonical deterministic passthrough)
  echo: { key: 'echo', render: (v) => v.text ?? '' },
  // fixed acknowledgement (owner-facing Bangla; addresses owner as "Boss")
  ack: { key: 'ack', render: () => 'Boss, কাজটি রেকর্ড করা হয়েছে।' },
  // deterministic key=value line rendering (stable order by key)
  kv: {
    key: 'kv',
    render: (v) =>
      Object.keys(v)
        .sort()
        .map((k) => `${k}=${v[k]}`)
        .join('\n'),
  },
};

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

/**
 * Create the T0 tier handler. `prepare` resolves the request deterministically;
 * `finalize` is never reached for T0 (there is no provider text to shape).
 */
export function createT0Handler(templates: T0TemplateTable = DEFAULT_T0_TEMPLATES): TierHandler {
  return {
    tier: 'T0',
    prepare(payload: ModelInvocationPayload, _def: TierDefinition): TierPrepared {
      // T0 is deterministic-only; a mismatched task kind is a malformed request.
      if (payload.taskKind !== 'deterministic') {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      const key = payload.deterministicKey;
      if (!key) {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.MODEL_NOT_CONFIGURED]) };
      }
      const template = templates[key];
      if (!template) {
        // fail closed — never silently promote a T0 miss to an LLM tier
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.T0_TEMPLATE_UNKNOWN]) };
      }
      const text = template.render(payload.deterministicVars ?? {});
      const value: ModelInvocationValue = {
        tier: 'T0',
        provider: 'deterministic',
        model: 't0',
        text,
        responseFormat: payload.responseFormat,
        usage: { ...EMPTY_USAGE },
        finishReason: 'stop',
        attempts: 0, // no provider attempt
        deterministic: true,
      };
      return { kind: 'RESOLVED', value };
    },
    finalize(rawText: string, _c: TierConstraints): TierFinalized {
      // Unreachable for T0 (resolved in prepare); pass through defensively.
      return { kind: 'OK', text: rawText };
    },
  };
}

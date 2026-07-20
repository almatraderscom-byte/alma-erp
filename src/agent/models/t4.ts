/**
 * Frontier escalation T4 tier (G16 / SPEC-156).
 *
 * The most capable and most expensive tier (Opus 4.8 by default), reserved for
 * rare high-risk / big-money decisions. It is gated twice, and fails closed:
 *
 *  1. **Approval** — the request must carry a valid `approvalToken`; without one,
 *     or with an invalid one, the tier returns `NEEDS_APPROVAL`. The default
 *     verifier rejects everything, so frontier is OFF until an approval authority
 *     is wired (fail closed — no accidental frontier spend).
 *  2. **Daily cap** — a per-actor per-day attempt cap; exceeding it returns
 *     `DENIED` with `MODEL_FRONTIER_DAILY_CAP_EXCEEDED`.
 *
 * The fabric NEVER auto-escalates into T4 — reaching this tier is always an
 * explicit, approved, caller-initiated request.
 */
import { REASON_CODES, type ComponentFailure } from '@/agent/contracts';
import { MODEL_REASON_CODES } from './reason-codes';
import type { ModelInvocationPayload } from './contract';
import type { TierDefinition } from './tiers';
import type { TierConstraints, TierFinalized, TierHandler, TierPrepareContext, TierPrepared } from './tier-handler';

/** Verifies a frontier approval token for an actor. Default rejects all. */
export interface FrontierApprovalVerifier {
  verify(token: string, actorId: string): boolean;
}

/** Per-actor per-day attempt cap. `tryConsume` returns false when exhausted. */
export interface FrontierDailyCap {
  tryConsume(dayKey: string, actorKey: string): boolean;
}

export interface T4HandlerDeps {
  approvals?: FrontierApprovalVerifier;
  dailyCap?: FrontierDailyCap;
}

const REJECT_ALL: FrontierApprovalVerifier = { verify: () => false };
const CAP_ZERO: FrontierDailyCap = { tryConsume: () => false };

/** Deterministic in-memory daily cap (no wall clock inside — day key is supplied). */
export function createInMemoryDailyCap(maxPerDay: number): FrontierDailyCap {
  const counts = new Map<string, number>();
  return {
    tryConsume(dayKey: string, actorKey: string): boolean {
      const key = `${dayKey}|${actorKey}`;
      const used = counts.get(key) ?? 0;
      if (used >= maxPerDay) return false;
      counts.set(key, used + 1);
      return true;
    },
  };
}

function fail(status: ComponentFailure['status'], codes: string[], opts: { approvalRequestId?: string } = {}): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [], ...(opts.approvalRequestId ? { approvalRequestId: opts.approvalRequestId } : {}) };
}

const DAY_MS = 86_400_000;

export function createT4Handler(deps: T4HandlerDeps = {}): TierHandler {
  const approvals = deps.approvals ?? REJECT_ALL;
  const dailyCap = deps.dailyCap ?? CAP_ZERO;

  return {
    tier: 'T4',
    prepare(payload: ModelInvocationPayload, def: TierDefinition, ctx: TierPrepareContext): TierPrepared {
      if (payload.taskKind !== 'frontier') {
        return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]) };
      }
      // gate 1: approval (fail closed)
      const token = payload.approvalToken;
      if (!token) {
        return { kind: 'FAILURE', failure: fail('NEEDS_APPROVAL', [MODEL_REASON_CODES.APPROVAL_REQUIRED_FRONTIER]) };
      }
      const binding = ctx.registry.primary('T4', payload.role);
      if (!binding) return { kind: 'FAILURE', failure: fail('FAILED_FINAL', [MODEL_REASON_CODES.MODEL_NOT_CONFIGURED]) };
      // gate 1b: approval is verified against the requesting actor
      const actorId = ctx.identity.actorId;
      if (!approvals.verify(token, actorId)) {
        return { kind: 'FAILURE', failure: fail('NEEDS_APPROVAL', [MODEL_REASON_CODES.APPROVAL_REQUIRED_FRONTIER]) };
      }
      // gate 2: per-actor daily cap (attempt-based; day derived from the injected clock)
      const dayKey = String(Math.floor(ctx.clock.now() / DAY_MS));
      if (!dailyCap.tryConsume(dayKey, actorId)) {
        return { kind: 'FAILURE', failure: fail('DENIED', [MODEL_REASON_CODES.DAILY_CAP_EXCEEDED]) };
      }

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

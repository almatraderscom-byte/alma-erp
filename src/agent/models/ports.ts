/**
 * Model fabric ports (G16 / SPEC-151).
 *
 * The fabric depends only on these injected ports — never on a concrete provider
 * SDK, the Cost Governor's internals, or the wall clock. This keeps the whole
 * fabric deterministic and testable with fakes, and keeps real wiring a
 * documented seam.
 */
import type { ExecutionIdentity } from '@/agent/contracts';
import type { TokenUsage } from '@/agent/finops/tokens';
import type { ModelTier } from './tiers';

/** Injectable clock (SPEC-158 timeouts/quota inject a fixed clock in tests). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  // wall clock — used only in production wiring, never in deterministic tests
  now: () => Date.now(),
};

/** Fixed clock for deterministic tests. */
export function fixedClock(startMs = 0): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ── Cost authorization port (INV-03) ────────────────────────────────────────
// Every model call is pre-authorized by the Cost Governor. The fabric requires a
// port; with none it fails closed (COST_AUTH_PORT_MISSING), never invoking a
// provider unauthorized. The real binding to the G04 governor is a documented
// seam; tests inject a deterministic fake.

export interface CostAuthorizationInput {
  identity: ExecutionIdentity;
  tier: ModelTier;
  provider: string;
  model: string;
  estInputTokens: number;
  estMaxOutputTokens: number;
}

export type CostAuthorization =
  | { status: 'ALLOWED'; authorizationId: string; evidenceIds?: string[] }
  | { status: 'DENIED' | 'BUDGET_EXCEEDED'; reasonCodes: string[]; evidenceIds?: string[] };

export interface CostAuthorizationPort {
  /** reserve worst-case cost before the call; fail-closed on any deny */
  authorize(input: CostAuthorizationInput): Promise<CostAuthorization>;
  /** commit actual usage after a successful call */
  settle(authorizationId: string, usage: TokenUsage): Promise<void>;
  /** release the reservation when the call did not spend (failed/aborted) */
  release(authorizationId: string): Promise<void>;
}

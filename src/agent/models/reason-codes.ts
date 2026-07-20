/**
 * Model fabric reason codes (G16 / SPEC-151).
 *
 * Finite, stable, append-only. These extend the canonical `REASON_CODES` from
 * `@/agent/contracts` with fabric-specific causes. `ComponentFailure.reasonCodes`
 * is `string[]`, so these live as plain string constants (same pattern the Cost
 * Governor uses for its local `NO_BUDGET_CONFIGURED`).
 */
export const MODEL_REASON_CODES = {
  // routing / configuration
  TIER_UNKNOWN: 'MODEL_TIER_UNKNOWN',
  TIER_NOT_IMPLEMENTED: 'MODEL_TIER_NOT_IMPLEMENTED',
  MODEL_NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  ADAPTER_MISSING: 'MODEL_ADAPTER_MISSING',
  CAPABILITY_UNSUPPORTED: 'MODEL_CAPABILITY_UNSUPPORTED',

  // cost governance seam (INV-03)
  COST_PORT_MISSING: 'COST_AUTH_PORT_MISSING',
  COST_NOT_AUTHORIZED: 'COST_NOT_AUTHORIZED',

  // input / output bounds
  INPUT_OVERSIZED: 'MODEL_INPUT_OVERSIZED',
  OUTPUT_OVERSIZED: 'MODEL_OUTPUT_OVERSIZED',
  OUTPUT_MALFORMED: 'MODEL_OUTPUT_MALFORMED',

  // tier discipline — never silently escalate to a stronger/costlier tier
  TIER_ESCALATION_FORBIDDEN: 'MODEL_TIER_ESCALATION_FORBIDDEN',

  // provider outcomes
  PROVIDER_TIMEOUT: 'MODEL_PROVIDER_TIMEOUT',
  PROVIDER_RETRYABLE: 'MODEL_PROVIDER_RETRYABLE',
  PROVIDER_FINAL: 'MODEL_PROVIDER_FINAL',
  PROVIDER_QUOTA_EXCEEDED: 'MODEL_PROVIDER_QUOTA_EXCEEDED',
  ALL_PROVIDERS_FAILED: 'MODEL_ALL_PROVIDERS_FAILED',

  // frontier (T4) escalation gate
  APPROVAL_REQUIRED_FRONTIER: 'MODEL_FRONTIER_APPROVAL_REQUIRED',
  DAILY_CAP_EXCEEDED: 'MODEL_FRONTIER_DAILY_CAP_EXCEEDED',
} as const;

export type ModelReasonCode = (typeof MODEL_REASON_CODES)[keyof typeof MODEL_REASON_CODES];

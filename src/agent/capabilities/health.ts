/**
 * G09 / SPEC-087 — Capability health model.
 *
 * A deterministic health state machine over a capability, plus a runtime override
 * store so operators can degrade / disable / kill-switch a capability WITHOUT
 * editing the generated catalog. Availability is FAIL-CLOSED: a capability is
 * available only when it is not disabled and not kill-switched; any unknown or
 * invalid state resolves to unavailable.
 *
 * Deterministic, no LLM/IO (INV-01). The override store is an interface with an
 * in-memory default (a durable table can implement it later, like the catalog).
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import {
  CAPABILITY_HEALTH_STATES,
  type Capability,
  type CapabilityHealth,
  type CapabilityHealthState,
} from './capability.schema'
import { capabilityStore } from './store'

export const HEALTH_CONTRACT_VERSION = '1.0.0' as const

export const HEALTH_SIGNALS = ['ok', 'degrade', 'disable', 'kill', 'restore'] as const
export type HealthSignal = (typeof HEALTH_SIGNALS)[number]

/** Deterministic transition: (current health, signal) → next health. */
export function nextHealth(current: CapabilityHealth, signal: HealthSignal, reason?: string): CapabilityHealth {
  switch (signal) {
    case 'ok':
      return { status: current.killSwitch ? current.status : 'healthy', killSwitch: current.killSwitch }
    case 'degrade':
      return { status: 'degraded', killSwitch: current.killSwitch, ...(reason ? { reason } : {}) }
    case 'disable':
      return { status: 'disabled', killSwitch: current.killSwitch, ...(reason ? { reason } : {}) }
    case 'kill':
      return { status: current.status, killSwitch: true, ...(reason ? { reason } : {}) }
    case 'restore':
      return { status: 'healthy', killSwitch: false }
    default:
      return current
  }
}

/**
 * FAIL-CLOSED availability. Available iff the state is a known health state, not
 * 'disabled', and the kill-switch is off. A degraded capability is still
 * available (degraded ≠ down).
 */
export function isAvailable(health: CapabilityHealth): boolean {
  if (!(CAPABILITY_HEALTH_STATES as readonly string[]).includes(health.status)) return false
  if (health.killSwitch) return false
  return health.status !== 'disabled'
}

// ── Override store ──────────────────────────────────────────────────────────

export interface HealthOverrideStore {
  get(key: string): CapabilityHealth | undefined
  set(key: string, health: CapabilityHealth): void
  clear(key: string): void
}

export class InMemoryHealthOverrideStore implements HealthOverrideStore {
  private readonly m = new Map<string, CapabilityHealth>()
  get(key: string): CapabilityHealth | undefined {
    return this.m.get(key)
  }
  set(key: string, health: CapabilityHealth): void {
    this.m.set(key, health)
  }
  clear(key: string): void {
    this.m.delete(key)
  }
}

/** Effective health = override if present, else the catalog's declared health. */
export function effectiveHealth(capability: Capability, overrides?: HealthOverrideStore): CapabilityHealth {
  return overrides?.get(capability.key) ?? capability.health
}

export interface HealthIssue {
  capability: string
  code: 'DISABLED_STATUS_MISMATCH' | 'UNKNOWN_STATE'
  detail: string
}

/** Catalog integrity: a disabled capability must report disabled health, etc. */
export function checkHealthMetadata(c: Capability): HealthIssue[] {
  const issues: HealthIssue[] = []
  if (!(CAPABILITY_HEALTH_STATES as readonly string[]).includes(c.health.status)) issues.push({ capability: c.key, code: 'UNKNOWN_STATE', detail: c.health.status })
  if (c.status === 'disabled' && c.health.status !== 'disabled') issues.push({ capability: c.key, code: 'DISABLED_STATUS_MISMATCH', detail: c.health.status })
  return issues
}
export function checkAllHealthMetadata(caps: readonly Capability[] = capabilityStore.list()): HealthIssue[] {
  return caps.flatMap(checkHealthMetadata)
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const healthRequestSchema = z.union([
  z.object({ kind: z.literal('isAvailable'), capabilityKey: z.string().min(1) }),
  z.object({ kind: z.literal('transition'), status: z.enum(CAPABILITY_HEALTH_STATES), killSwitch: z.boolean(), signal: z.enum(HEALTH_SIGNALS) }),
])
export type HealthRequest = z.infer<typeof healthRequestSchema>

export type HealthResultValue =
  | { kind: 'isAvailable'; available: boolean; status: CapabilityHealthState; killSwitch: boolean }
  | { kind: 'transition'; next: CapabilityHealth }

export function queryHealth(raw: unknown): ComponentResult<HealthResultValue> {
  const check = validateRequest(raw, healthRequestSchema, HEALTH_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { health: HEALTH_CONTRACT_VERSION }
  const q = check.request.payload
  if (q.kind === 'isAvailable') {
    const cap = capabilityStore.getByKey(q.capabilityKey)
    if (!cap) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
    const h = cap.health
    return completed({ kind: 'isAvailable', available: isAvailable(h), status: h.status, killSwitch: h.killSwitch }, [], versions)
  }
  const next = nextHealth({ status: q.status, killSwitch: q.killSwitch }, q.signal)
  return completed({ kind: 'transition', next }, [], versions)
}

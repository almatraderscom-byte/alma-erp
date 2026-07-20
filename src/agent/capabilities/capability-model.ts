/**
 * G09 / SPEC-081 — Capability data-model boundary.
 *
 * Identity-enforced read access to the capability catalog, returning the frozen
 * G01 `ComponentResult` union (never a bare boolean, never a throw). This is the
 * SPEC-081 authoritative surface; later specs add facet-specific boundaries.
 *
 * Deterministic, read-only: no side effect → no Cost Governor / Tool Gateway
 * authorization needed, but identity is still enforced fail-closed (INV-02/05).
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import { CAPABILITY_CONTRACT_VERSION, type Capability } from './capability.schema'
import { capabilityStore } from './store'

export type CapabilityQuery =
  | { kind: 'get'; id: string }
  | { kind: 'getByKey'; key: string }
  | { kind: 'list' }
  | { kind: 'count' }

const capabilityQuerySchema: z.ZodType<CapabilityQuery> = z.union([
  z.object({ kind: z.literal('get'), id: z.string().min(1) }),
  z.object({ kind: z.literal('getByKey'), key: z.string().min(1) }),
  z.object({ kind: z.literal('list') }),
  z.object({ kind: z.literal('count') }),
])

export type CapabilityResultValue =
  | { kind: 'get'; capability: Capability | null }
  | { kind: 'list'; capabilities: readonly Capability[] }
  | { kind: 'count'; count: number }

export function queryCapabilities(raw: unknown): ComponentResult<CapabilityResultValue> {
  const check = validateRequest(raw, capabilityQuerySchema, CAPABILITY_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const versions = { capability: CAPABILITY_CONTRACT_VERSION }
  const q = check.request.payload
  switch (q.kind) {
    case 'get':
      return completed({ kind: 'get', capability: capabilityStore.get(q.id) ?? null }, [], versions)
    case 'getByKey':
      return completed({ kind: 'get', capability: capabilityStore.getByKey(q.key) ?? null }, [], versions)
    case 'list':
      return completed({ kind: 'list', capabilities: capabilityStore.list() }, [], versions)
    case 'count':
      return completed({ kind: 'count', count: capabilityStore.list().length }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}

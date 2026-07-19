/**
 * Phase 56 — business-OS tools (adapter surface for the head).
 * Same wiring note as personal-os-tools.ts: defined + tested now, pool/group
 * promotion happens through the Phase 57 readiness ladder.
 */
import type { AgentTool } from './registry'
import { assertOpAllowed, getServiceAdapter } from '@/agent/lib/integrations/service-registry'
import { ensureServiceAdaptersBootstrapped } from '@/agent/lib/integrations/bootstrap'

export const business_os_read: AgentTool = {
  name: 'business_os_read',
  description:
    'Business OS read: query a connected business service adapter (e.g. erp-orders) — ' +
    'op examples: order_summary, get_order. Read-only; refuses ungranted ops.',
  input_schema: {
    type: 'object' as const,
    properties: {
      service: { type: 'string', description: "Adapter id, e.g. 'erp-orders'." },
      op: { type: 'string', description: 'Read op declared by the adapter.' },
      params: { type: 'object', description: 'Op parameters.', additionalProperties: true },
    },
    required: ['service', 'op'],
  },
  handler: async (input) => {
    const service = String(input.service ?? '')
    const op = String(input.op ?? '')
    await ensureServiceAdaptersBootstrapped()
    const adapter = getServiceAdapter(service)
    if (!adapter || adapter.scope !== 'business') return { success: false, error: `unknown business service: ${service}` }
    const gate = await assertOpAllowed(service, op)
    if (!gate.allowed) return { success: false, error: gate.reason, errorCode: 'service_not_ready', retryable: false }
    const cap = adapter.capabilities().find((c) => c.op === op)
    if (!cap || cap.mode !== 'read') return { success: false, error: `${op} is not a read op on ${service}` }
    const res = await adapter.read(op, (input.params as Record<string, unknown>) ?? {})
    return res.ok ? { success: true, data: res.data } : { success: false, error: res.error }
  },
}

export const business_os_stage: AgentTool = {
  name: 'business_os_stage',
  description:
    'Business OS stage: produce a PRIVATE draft via a connected business adapter ' +
    '(e.g. draft_customer_update). Nothing is sent — sending stays with the point-of-risk approval flow.',
  input_schema: {
    type: 'object' as const,
    properties: {
      service: { type: 'string', description: "Adapter id, e.g. 'erp-orders'." },
      op: { type: 'string', description: 'Stage op declared by the adapter (produces a private draft).' },
      params: { type: 'object', description: 'Op parameters.', additionalProperties: true },
    },
    required: ['service', 'op'],
  },
  handler: async (input) => {
    const service = String(input.service ?? '')
    const op = String(input.op ?? '')
    await ensureServiceAdaptersBootstrapped()
    const adapter = getServiceAdapter(service)
    if (!adapter || adapter.scope !== 'business') return { success: false, error: `unknown business service: ${service}` }
    const gate = await assertOpAllowed(service, op)
    if (!gate.allowed) return { success: false, error: gate.reason, errorCode: 'service_not_ready', retryable: false }
    const cap = adapter.capabilities().find((c) => c.op === op)
    if (!cap || cap.mode !== 'stage') return { success: false, error: `${op} is not a stage op on ${service}` }
    const res = await adapter.stage(op, (input.params as Record<string, unknown>) ?? {})
    return res.ok ? { success: true, data: res.draft } : { success: false, error: res.error }
  },
}

export const BUSINESS_OS_TOOLS: AgentTool[] = [business_os_read, business_os_stage]

/**
 * Phase 56 — personal-OS tools (adapter surface for the head).
 *
 * NOTE ON WIRING: these tools are defined + fully tested here but NOT yet
 * plugged into the head's tool pools/groups — per the staged-rollout doctrine,
 * the Phase 57 control centre exposes service connections to the OWNER first
 * (inspect/pause/revoke/sandbox), and only a readiness-gated promotion wires
 * the head-facing tools into a pool. This keeps Phase 56's exit gate honest:
 * private draft/sandbox workflows only.
 */
import type { AgentTool } from './registry'
import { getServiceAdapter } from '@/agent/lib/integrations/service-registry'
import { assertOpAllowed } from '@/agent/lib/integrations/service-registry'

export const personal_os_read: AgentTool = {
  name: 'personal_os_read',
  description:
    'Personal OS read: query a connected personal service adapter (e.g. personal-records) — ' +
    'op examples: list_bills, list_reminders. Read-only; refuses ops the owner has not granted.',
  input_schema: {
    type: 'object' as const,
    properties: {
      service: { type: 'string', description: "Adapter id, e.g. 'personal-records'." },
      op: { type: 'string', description: 'Read op declared by the adapter.' },
      params: { type: 'object', description: 'Op parameters.', additionalProperties: true },
    },
    required: ['service', 'op'],
  },
  handler: async (input) => {
    const service = String(input.service ?? '')
    const op = String(input.op ?? '')
    const adapter = getServiceAdapter(service)
    if (!adapter || adapter.scope !== 'personal') return { success: false, error: `unknown personal service: ${service}` }
    const gate = await assertOpAllowed(service, op)
    if (!gate.allowed) return { success: false, error: gate.reason, errorCode: 'service_not_ready', retryable: false }
    const cap = adapter.capabilities().find((c) => c.op === op)
    if (!cap || cap.mode !== 'read') return { success: false, error: `${op} is not a read op on ${service}` }
    const res = await adapter.read(op, (input.params as Record<string, unknown>) ?? {})
    return res.ok ? { success: true, data: res.data } : { success: false, error: res.error }
  },
}

export const personal_os_stage: AgentTool = {
  name: 'personal_os_stage',
  description:
    'Personal OS stage: produce a PRIVATE draft via a connected personal adapter (e.g. draft_reminder). ' +
    'Nothing external happens — the draft is returned for the owner to approve.',
  input_schema: {
    type: 'object' as const,
    properties: {
      service: { type: 'string' },
      op: { type: 'string' },
      params: { type: 'object', additionalProperties: true },
    },
    required: ['service', 'op'],
  },
  handler: async (input) => {
    const service = String(input.service ?? '')
    const op = String(input.op ?? '')
    const adapter = getServiceAdapter(service)
    if (!adapter || adapter.scope !== 'personal') return { success: false, error: `unknown personal service: ${service}` }
    const gate = await assertOpAllowed(service, op)
    if (!gate.allowed) return { success: false, error: gate.reason, errorCode: 'service_not_ready', retryable: false }
    const cap = adapter.capabilities().find((c) => c.op === op)
    if (!cap || cap.mode !== 'stage') return { success: false, error: `${op} is not a stage op on ${service}` }
    const res = await adapter.stage(op, (input.params as Record<string, unknown>) ?? {})
    return res.ok ? { success: true, data: res.draft } : { success: false, error: res.error }
  },
}

export const PERSONAL_OS_TOOLS: AgentTool[] = [personal_os_read, personal_os_stage]

/**
 * Orchestrator tool — lets the head agent delegate a focused sub-task to a
 * specialist sub-agent (Part D, Phase 2). The core loop special-cases this tool
 * so the owner sees a live delegation card (Cursor-style) while the sub-agent works.
 *
 * Keep top-level imports light (types + pure role data only). The sub-agent runner
 * is dynamically imported inside the handler to avoid a circular import with the
 * tool registry (registry → orchestrator-tools → subagent → registry).
 */
import type { AgentTool } from './registry'
import { SPECIALIST_ROLE_KEYS, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

const delegate_to_specialist: AgentTool = {
  name: 'delegate_to_specialist',
  description:
    'Delegate ONE focused sub-task to a specialist sub-agent that runs with a narrowed, role-appropriate tool set. ' +
    'Use this to break a larger job into pieces — e.g. send data-pulling to "analyst", market/competitor research to "researcher", ' +
    'Facebook/ads planning to "marketer", copy/creative drafting to "content", staff/operations checks to "ops". ' +
    'The sub-agent gathers real data with its tools and returns a concise Bangla summary you can build on. ' +
    'Prefer delegating discrete sub-tasks of multi-step work so each runs focused; keep simple single-step answers yourself.',
  input_schema: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string',
        enum: SPECIALIST_ROLE_KEYS,
        description: 'Which specialist to delegate to: researcher | analyst | marketer | content | ops',
      },
      task: {
        type: 'string',
        description: 'A clear, self-contained brief of exactly what the specialist should do and what to return.',
      },
    },
    required: ['role', 'task'],
  },
  handler: async (input) => {
    const role = String(input.role ?? '') as SpecialistRole
    const task = String(input.task ?? '').trim()
    if (!SPECIALIST_ROLE_KEYS.includes(role)) {
      return { success: false, error: `invalid role: ${role}. Valid: ${SPECIALIST_ROLE_KEYS.join(', ')}` }
    }
    if (!task) return { success: false, error: 'task is required' }

    const businessId = (input.businessId as AgentBusinessId | undefined) ?? 'ALMA_LIFESTYLE'
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : undefined
    const modelId = typeof input.modelId === 'string' ? input.modelId : undefined

    const { runSubAgent } = await import('@/agent/lib/models/subagent')
    const result = await runSubAgent({ role, task, businessId, conversationId, modelId })

    if (!result.success) {
      return { success: false, error: result.error ?? 'sub-agent failed' }
    }
    return {
      success: true,
      data: {
        role: result.role,
        roleLabel: result.roleLabel,
        summary: result.summary,
        toolsUsed: result.toolsUsed,
      },
    }
  },
}

export const ORCHESTRATOR_TOOLS: AgentTool[] = [delegate_to_specialist]

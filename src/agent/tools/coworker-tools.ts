/**
 * Connector "write" bridge tool for the external Claude co-worker.
 *
 * The MCP connector is read-only by design (default-deny). This is the ONE controlled
 * exception: `request_agent_action` lets the co-worker FILE A PROPOSAL — it does not act.
 * It writes a `coworker_request` row (status='pending') that the owner's internal agent
 * surfaces + chases for approval; only after the owner says yes does the internal agent
 * carry it out with its real business tools. See lib/coworker-request.ts for the safety model.
 */
import type { AgentTool } from './registry'
import { fileCoworkerRequest } from '@/agent/lib/coworker-request'

const request_agent_action: AgentTool = {
  name: 'request_agent_action',
  description:
    "Propose an ACTION for the owner's internal ALMA agent to perform. You (the read-only " +
    "co-worker) cannot edit or act on the business directly — this is your ONLY way to make " +
    "something happen. It does NOT execute anything: it files a proposal that the internal " +
    "agent surfaces to the owner (Sir) for approval, and only AFTER the owner approves does " +
    "the internal agent carry it out with its real business tools. Use this when the owner " +
    "asks you to DO something (place/edit an order, change inventory, run a marketing post, " +
    "assign staff, record finance, generate content) rather than just give information. " +
    "Be specific in `summary` so the owner can decide quickly.",
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'One-line, specific action to propose (what the internal agent should do).',
      },
      details: {
        type: 'string',
        description: 'Any extra context, numbers, or steps the internal agent needs to execute.',
      },
      category: {
        type: 'string',
        enum: ['order', 'inventory', 'marketing', 'staff', 'finance', 'content', 'other'],
        description: 'Which area of the business this action touches.',
      },
      urgency: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'How time-sensitive this is for the owner.',
      },
    },
    required: ['summary'],
  },
  handler: async (input) => {
    const summary = String(input.summary ?? '').trim()
    if (!summary) {
      return { success: false, error: 'summary required' }
    }
    try {
      const { id } = await fileCoworkerRequest({
        summary,
        details: input.details ? String(input.details) : undefined,
        category: input.category ? String(input.category) : undefined,
        urgency: input.urgency as 'low' | 'normal' | 'high' | undefined,
      })
      return {
        success: true,
        data: {
          filed: true,
          id,
          status: 'pending_owner_approval',
          message:
            'Proposal filed for the owner. The internal agent will surface it to Sir for ' +
            'approval and execute it only after he says yes — nothing has happened yet.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const COWORKER_TOOLS: AgentTool[] = [request_agent_action]

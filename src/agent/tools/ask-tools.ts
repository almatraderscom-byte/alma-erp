/**
 * Phase 10 — ask_user clarifying question buttons.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const ask_user: AgentTool = {
  name: 'ask_user',
  description:
    'When a request is ambiguous and the answer materially changes the work, ask ONE clarifying question with 2–4 specific tappable options. ' +
    'Never open-ended questions. At most one ask per request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: { type: 'string', description: 'The clarifying question in Bangla' },
      options: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 4,
        description: '2–4 specific answer options the owner can tap',
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['question', 'options'],
  },
  handler: async (input) => {
    const question = String(input.question ?? '').trim()
    const rawOptions = Array.isArray(input.options) ? input.options.map(String) : []
    const options = rawOptions.map((o) => o.trim()).filter(Boolean)

    if (!question) return { success: false, error: 'question is required' }
    if (options.length < 2 || options.length > 4) {
      return { success: false, error: 'options must have 2–4 items' }
    }

    const conversationId = input.conversationId ? String(input.conversationId) : null
    if (!conversationId) return { success: false, error: 'conversationId is required' }

    try {
      // Phase 5: bind the question to the conversation's single in-flight
      // workflow AT CREATION (both head paths run this handler), so the owner's
      // answer can move the template state machine (e.g. image preview confirm).
      // The turn-end stamping in run-owner-turn stays as a safety net.
      let workflowRunId: string | null = null
      try {
        const { listActiveWorkflowRuns } = await import('@/agent/lib/workflow-run')
        const active = await listActiveWorkflowRuns(conversationId, 2)
        if (active.length === 1) workflowRunId = active[0].id
      } catch { /* fail-open — the card just goes unbound */ }

      const card = await db.agentAskCard.create({
        data: {
          conversationId,
          question,
          options: JSON.stringify(options),
          status: 'pending',
          ...(workflowRunId ? { workflowRunId } : {}),
        },
      })

      return {
        success: true,
        data: {
          askCardId: card.id as string,
          question,
          options,
          message: 'Clarifying question shown to owner — wait for their choice.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ASK_TOOLS: AgentTool[] = [ask_user]

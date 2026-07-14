import type { AgentTool } from './registry'
import { listLearnedRules, forgetLearnedRule } from '@/agent/lib/learning/learned-rules'
import { normalizeBusinessId } from '@/lib/agent-api/business-context'

const list_learned: AgentTool = {
  name: 'list_learned',
  description:
    'Show active learned rules and high-importance owner preferences — playbook + pinned memory. ' +
    'Grouped by domain with timesApplied/access counts as proof rules are alive.',
  input_schema: {
    type: 'object' as const,
    properties: {
      businessId: { type: 'string', enum: ['ALMA_LIFESTYLE', 'ALMA_TRADING'], description: 'Business — omit; the server fills it from the conversation' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = normalizeBusinessId(input.businessId)
      const { rules, grouped } = await listLearnedRules(businessId)
      return {
        success: true,
        data: {
          count: rules.length,
          rules,
          grouped,
          message: rules.length
            ? `${rules.length}টি active rule/preference — timesApplied = কতবার prompt-এ apply হয়েছে।`
            : 'এখনো কোনো learned rule নেই — owner explicit instruction দিলে auto-save হবে।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const forget_rule: AgentTool = {
  name: 'forget_rule',
  description:
    'Retire a learned playbook rule or delete a high-importance preference memory. ' +
    'Use id + kind from list_learned.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Rule id from list_learned' },
      kind: { type: 'string', enum: ['playbook', 'memory'], description: 'What to forget: a playbook rule or a preference memory' },
    },
    required: ['id', 'kind'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '').trim()
    const kind = input.kind === 'memory' ? 'memory' : 'playbook'
    if (!id) return { success: false, error: 'id লাগবে' }

    const result = await forgetLearnedRule(id, kind)
    if (!result.ok) return { success: false, error: result.error ?? 'forget failed' }
    return { success: true, data: { id, kind, message: 'Rule retired/deleted.' } }
  },
}

export const LEARNING_TOOLS: AgentTool[] = [list_learned, forget_rule]

export const LEARNING_ROLE_PROMPT = `
## LEARNED RULES (File 14)
When owner teaches ("মনে রাখো", "এখন থেকে", preferences/corrections) — system auto-saves as active rule + confirms.
list_learned: visible proof of what you learned (timesApplied = applied count).
forget_rule: owner wants to remove a rule.
When applying an owner rule in a turn, occasionally note it naturally ("আপনার নিয়ম মেনে…") — not every turn.
`

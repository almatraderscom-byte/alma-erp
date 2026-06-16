/**
 * Sub-agent runner for the head→specialist orchestrator (Part D, Phase 2).
 *
 * Runs a focused, bounded specialist turn: same model (Claude Sonnet) but a narrowed
 * tool set + a role-specific brief. It is NON-streaming and capped at a few tool
 * iterations so a delegation can never run away or recurse (the delegate tool itself
 * is stripped from the sub-agent's tools). The head agent calls this via the
 * `delegate_to_specialist` tool; the core loop surfaces it to the UI as a live
 * delegation card and attributes the cost to the role in the CCTV "Agents" view.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import { assembleSelectedTools, toolsToDefinitions } from '@/agent/tools/select-tools'
import { executeTool } from '@/agent/tools/registry'
import { captureAgentError } from '@/agent/lib/sentry'
import { SPECIALIST_ROLES, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

const SUBAGENT_MAX_ITERATIONS = 4
const SUBAGENT_MAX_TOKENS = 2048

const globalForSub = globalThis as unknown as { subAnthropic: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForSub.subAnthropic) {
    globalForSub.subAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  }
  return globalForSub.subAnthropic
}

export interface RunSubAgentParams {
  role: SpecialistRole
  task: string
  businessId: AgentBusinessId
  conversationId?: string
  signal?: AbortSignal
}

export interface SubAgentResult {
  success: boolean
  role: SpecialistRole
  roleLabel: string
  summary: string
  toolsUsed: string[]
  costUsd: number
  error?: string
}

export async function runSubAgent(params: RunSubAgentParams): Promise<SubAgentResult> {
  const def = SPECIALIST_ROLES[params.role]
  if (!def) {
    return { success: false, role: params.role, roleLabel: params.role, summary: '', toolsUsed: [], costUsd: 0, error: `unknown role: ${params.role}` }
  }

  // Scope the tool set; never let a sub-agent delegate again (no recursion).
  const tools = assembleSelectedTools(def.toolGroups).filter((t) => t.name !== 'delegate_to_specialist')
  const toolDefs = toolsToDefinitions(tools)

  const system =
    `${def.instruction}\n\n` +
    `তুমি একজন বিশেষজ্ঞ সাব-এজেন্ট (${def.label})। হেড এজেন্ট তোমাকে একটি নির্দিষ্ট কাজ দিয়েছে। ` +
    `প্রয়োজনীয় tool ব্যবহার করে আসল ডেটা সংগ্রহ করো — অনুমান করবে না, verify করবে। ` +
    `শেষে সংক্ষিপ্ত, তথ্যভিত্তিক ফলাফল বাংলায় ফেরত দাও (৩-৬ লাইন)। কোনো অপ্রয়োজনীয় ভূমিকা নয়।`

  let messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: params.task }]
  const toolsUsed: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let finalText = ''

  try {
    for (let i = 0; i < SUBAGENT_MAX_ITERATIONS; i++) {
      if (params.signal?.aborted) break

      const resp = await getClient().messages.create(
        {
          model: AGENT_MODEL,
          max_tokens: SUBAGENT_MAX_TOKENS,
          system,
          tools: toolDefs,
          messages,
        },
        { signal: params.signal },
      )

      inputTokens += resp.usage.input_tokens
      outputTokens += resp.usage.output_tokens

      const textPieces = resp.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (textPieces) finalText = textPieces

      const toolUses = resp.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      )
      if (toolUses.length === 0) break

      messages = [...messages, { role: 'assistant', content: resp.content }]

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        toolsUsed.push(tu.name)
        const result = await executeTool(tu.name, tu.input as Record<string, unknown>, {
          conversationId: params.conversationId,
          businessId: params.businessId,
        })
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) })
      }
      messages = [...messages, { role: 'user', content: toolResults }]
    }

    const model = getModel('claude-sonnet-4-6')
    const costUsd = calcModelTurnCostUsd(model, { inputTokens, outputTokens })

    void logCost({
      provider: 'anthropic',
      kind: 'chat',
      units: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        model: model.id,
        apiModel: model.apiModel,
        provider: 'anthropic',
        subagent: params.role,
      },
      costUsd,
      conversationId: params.conversationId ?? null,
      dedupKey: `subagent:${params.conversationId ?? 'na'}:${params.role}:${Date.now()}`,
    })

    return {
      success: true,
      role: params.role,
      roleLabel: def.label,
      summary: finalText || '(সাব-এজেন্ট কোনো সারাংশ দেয়নি)',
      toolsUsed: Array.from(new Set(toolsUsed)),
      costUsd,
    }
  } catch (err) {
    await captureAgentError(err, 'agent.subagent.error', { tool: `subagent:${params.role}`, conversationId: params.conversationId })
    return {
      success: false,
      role: params.role,
      roleLabel: def.label,
      summary: '',
      toolsUsed: Array.from(new Set(toolsUsed)),
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

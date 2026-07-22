/**
 * Sub-agent runner for the head→specialist orchestrator (Part D, Phase 2 + Phase H tiers).
 *
 * Claude (head) delegates via `delegate_to_specialist`. Tier routing:
 * - CRITICAL (analyst): Claude only — finance / data analysis
 * - HEAVY (researcher/marketer/content): OpenRouter mid-tier
 * - LIGHT (ops + tuktak): OpenRouter cheap tier — ops → DeepSeek (staff dispatch/coordination)
 *
 * OpenRouter failures fall back to Claude; critical paths never use cheap models.
 */
import Anthropic from '@anthropic-ai/sdk'
import { getModel, DEFAULT_MODEL_ID, type ModelEntry } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { roundUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import { assembleSelectedTools, toolsToDefinitions } from '@/agent/tools/select-tools'
import { executeTool } from '@/agent/tools/registry'
import { annotateEmptyResult } from '@/agent/lib/tool-result-note'
import { captureAgentError } from '@/agent/lib/sentry'
import { SPECIALIST_ROLES, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import {
  resolveSubagentModel,
  fallbackModelForTier,
  isOpenRouterProvider,
  type TaskTier,
} from '@/agent/lib/models/tier-router'
import { runAdapterToolLoop } from '@/agent/lib/models/adapter-turn'
import {
  gateCheapModelBanglaOutput,
  needsCustomerFacingBanglaGate,
} from '@/agent/lib/models/bangla-output-gate'
import { anthropicToolsToNeutral } from '@/agent/lib/models/neutral'

const SUBAGENT_MAX_ITERATIONS = 4
const SUBAGENT_MAX_TOKENS = 2048

class SubAgentIncompleteError extends Error {
  constructor(role: SpecialistRole) {
    super(`SUBAGENT_INCOMPLETE: ${role} exhausted its tool budget without a tool-free final result`)
    this.name = 'SubAgentIncompleteError'
  }
}

const globalForSub = globalThis as unknown as { subAnthropic: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForSub.subAnthropic) {
    // Match the head client: ride out transient 529/429 overloads before failing.
    globalForSub.subAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', maxRetries: 4 })
  }
  return globalForSub.subAnthropic
}

export interface RunSubAgentParams {
  role: SpecialistRole
  task: string
  businessId: AgentBusinessId
  conversationId?: string
  /** Ignored for tier routing — critical roles always Claude. Head model kept for logs only. */
  modelId?: string | null
  signal?: AbortSignal
  /**
   * Phase 35: PARALLEL fan-out branches run read-only by construction — the
   * tool list is filtered to reads and every memory/effect writer is dropped,
   * so concurrent specialists can never write memory or owner-facing effects.
   * Writes stay on the sequential path behind the safety kernel.
   */
  readOnly?: boolean
}

/** Read-safe tool-name shapes + hard excludes (memory + effect writers). */
const READ_ONLY_TOOL_RE = /^(get_|list_|search_|check_|analyze_|audit_|research_|fetch_|read_|compare_|recall_|simulate_|diagnose_|run_health|marketing_report|advisor_|web_research)/
const NEVER_PARALLEL_TOOLS = new Set(['save_memory', 'track_open_task', 'resolve_open_task', 'save_task_checkpoint', 'ask_user'])

export function filterToolsReadOnly<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => READ_ONLY_TOOL_RE.test(t.name) && !NEVER_PARALLEL_TOOLS.has(t.name))
}

export interface SubAgentResult {
  success: boolean
  role: SpecialistRole
  roleLabel: string
  modelId: string
  modelLabel: string
  tier: TaskTier
  summary: string
  toolsUsed: string[]
  costUsd: number
  fallbackUsed?: boolean
  error?: string
}

function buildSystemPrompt(def: (typeof SPECIALIST_ROLES)[SpecialistRole]): string {
  return (
    `${def.instruction}\n\n` +
    `তুমি একজন বিশেষজ্ঞ সাব-এজেন্ট (${def.label})। হেড এজেন্ট তোমাকে একটি নির্দিষ্ট কাজ দিয়েছে। ` +
    `প্রয়োজনীয় tool ব্যবহার করে আসল ডেটা সংগ্রহ করো — অনুমান করবে না, verify করবে। ` +
    `শেষে সংক্ষিপ্ত, তথ্যভিত্তিক ফলাফল বাংলায় ফেরত দাও (৩-৬ লাইন)। কোনো অপ্রয়োজনীয় ভূমিকা নয়।`
  )
}

function costProviderForModel(model: ModelEntry): 'anthropic' | 'openai' | 'gemini' {
  if (model.provider === 'google') return 'gemini'
  if (model.provider === 'openrouter' || model.provider === 'openai') return 'openai'
  return 'anthropic'
}

async function runAnthropicSubAgent(args: {
  model: ModelEntry
  system: string
  task: string
  tools: ReturnType<typeof toolsToDefinitions>
  role: SpecialistRole
  businessId: AgentBusinessId
  conversationId?: string
  signal?: AbortSignal
}): Promise<{ summary: string; completed: boolean; toolsUsed: string[]; inputTokens: number; outputTokens: number }> {
  let messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: args.task }]
  const toolsUsed: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let finalText = ''
  let completed = false

  for (let i = 0; i < SUBAGENT_MAX_ITERATIONS; i++) {
    if (args.signal?.aborted) break

    const resp = await getClient().messages.create(
      {
        model: args.model.apiModel,
        max_tokens: SUBAGENT_MAX_TOKENS,
        system: args.system,
        tools: args.tools,
        messages,
      },
      { signal: args.signal },
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
    if (toolUses.length === 0) {
      completed = Boolean(textPieces)
      break
    }

    messages = [...messages, { role: 'assistant', content: resp.content }]

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      toolsUsed.push(tu.name)
      const result = await executeTool(tu.name, tu.input as Record<string, unknown>, {
        conversationId: args.conversationId,
        businessId: args.businessId,
      })
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(annotateEmptyResult(result)) })
    }
    messages = [...messages, { role: 'user', content: toolResults }]
  }

  if (!completed && !args.signal?.aborted) {
    messages = [
      ...messages,
      {
        role: 'user',
        content:
          '[INTERNAL CONTROL] Tool budget is exhausted. Do not call tools, promise future work, or claim an action that did not complete. ' +
          'Return a concise final status based only on the tool results above; clearly state anything still incomplete.',
      },
    ]
    const wrapup = await getClient().messages.create(
      {
        model: args.model.apiModel,
        max_tokens: SUBAGENT_MAX_TOKENS,
        system: args.system,
        messages,
      },
      { signal: args.signal },
    )
    inputTokens += wrapup.usage.input_tokens
    outputTokens += wrapup.usage.output_tokens
    const wrapupText = wrapup.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (wrapupText) {
      finalText = wrapupText
      completed = true
    }
  }

  return {
    summary: finalText,
    completed,
    toolsUsed: Array.from(new Set(toolsUsed)),
    inputTokens,
    outputTokens,
  }
}

async function runWithModel(
  model: ModelEntry,
  tier: TaskTier,
  params: RunSubAgentParams,
  def: (typeof SPECIALIST_ROLES)[SpecialistRole],
): Promise<{
  summary: string
  completed: boolean
  toolsUsed: string[]
  inputTokens: number
  outputTokens: number
  /** Cached-prompt tokens (adapter path reports inputTokens as uncached-only). */
  cacheRead: number
  cacheWrite: number
  /** OpenRouter's actual billed cost (USD), or null when not reported (native
   *  Anthropic / a provider that omits it) — caller then estimates from tokens. */
  actualCostUsd: number | null
}> {
  const system = buildSystemPrompt(def)
  let rawTools = assembleSelectedTools(def.toolGroups).filter((t) => t.name !== 'delegate_to_specialist')
  if (params.readOnly) rawTools = filterToolsReadOnly(rawTools)

  if (model.provider === 'anthropic') {
    // The native sub-agent loop sends no cache_control breakpoint, so its cache
    // token counts are genuinely zero — not merely unreported.
    return runAnthropicSubAgent({
      model,
      system,
      task: params.task,
      tools: toolsToDefinitions(rawTools),
      role: params.role,
      businessId: params.businessId,
      conversationId: params.conversationId,
      signal: params.signal,
    }).then((r) => ({ ...r, cacheRead: 0, cacheWrite: 0, actualCostUsd: null }))
  }

  if (!model.supportsTools) {
    throw new Error(`model ${model.id} does not support sub-agent tools`)
  }

  const neutralTools = anthropicToolsToNeutral(rawTools)
  return runAdapterToolLoop({
    model,
    system,
    userTask: params.task,
    tools: neutralTools,
    maxIterations: SUBAGENT_MAX_ITERATIONS,
    conversationId: params.conversationId,
    businessId: params.businessId,
    signal: params.signal,
  }).then((r) => ({
    summary: r.text,
    completed: r.completed,
    toolsUsed: r.toolsUsed,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    actualCostUsd: r.actualCostUsd,
  }))
}

export async function runSubAgent(params: RunSubAgentParams): Promise<SubAgentResult> {
  const def = SPECIALIST_ROLES[params.role]
  const fail = (error: string, model: ModelEntry, tier: TaskTier): SubAgentResult => ({
    success: false,
    role: params.role,
    roleLabel: def?.label ?? params.role,
    modelId: model.id,
    modelLabel: model.label,
    tier,
    summary: '',
    toolsUsed: [],
    costUsd: 0,
    error,
  })

  if (!def) {
    return fail(`unknown role: ${params.role}`, getModel(DEFAULT_MODEL_ID), 'light')
  }

  let tier: TaskTier
  let model: ModelEntry
  try {
    ;({ tier, model } = await resolveSubagentModel(params.role))
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), getModel(DEFAULT_MODEL_ID), 'critical')
  }

  // Owner's Monitor per-model kill-switch applies to specialists too: an OFF
  // model is swapped for the enabled fallback (Gemini → DeepSeek preference).
  try {
    const { resolveEnabledFallback } = await import('@/agent/lib/models/model-enabled')
    const fallbackId = await resolveEnabledFallback(model.id)
    if (fallbackId) model = getModel(fallbackId)
  } catch { /* fail-open */ }

  let fallbackUsed = false

  try {
    let result = await runWithModel(model, tier, params, def)
    if (!result.completed) throw new SubAgentIncompleteError(params.role)

    let summary = result.summary || '(সাব-এজেন্ট কোনো সারাংশ দেয়নি)'
    if (isOpenRouterProvider(model.provider) && needsCustomerFacingBanglaGate(params.role, tier)) {
      summary = gateCheapModelBanglaOutput(summary, { customerFacing: true })
    }

    const costUsd = result.actualCostUsd != null
      ? roundUsd(result.actualCostUsd)
      : calcModelTurnCostUsd(model, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheRead: result.cacheRead,
          cacheWrite: result.cacheWrite,
        })

    void logCost({
      provider: costProviderForModel(model),
      kind: 'chat',
      units: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_read_input_tokens: result.cacheRead,
        model: model.id,
        model_label: model.label,
        apiModel: model.apiModel,
        provider: model.provider,
        subagent: params.role,
        task_tier: tier,
        via: model.provider === 'openrouter' ? 'openrouter' : model.provider,
        task_snippet: params.task.slice(0, 160),
        fallback: fallbackUsed ? '1' : '0',
        cost_source: result.actualCostUsd != null ? 'openrouter_actual' : 'estimate',
      },
      costUsd,
      conversationId: params.conversationId ?? null,
      dedupKey: `subagent:${params.conversationId ?? 'na'}:${params.role}:${Date.now()}`,
    })

    return {
      success: true,
      role: params.role,
      roleLabel: def.label,
      modelId: model.id,
      modelLabel: model.label,
      tier,
      summary,
      toolsUsed: result.toolsUsed,
      costUsd,
      fallbackUsed,
    }
  } catch (err) {
    // A worker may already have executed tool calls before exhausting its loop.
    // Retrying the whole task on another model could duplicate those effects.
    if (err instanceof SubAgentIncompleteError) {
      await captureAgentError(err, 'agent.subagent.incomplete', {
        tool: `subagent:${params.role}`,
        conversationId: params.conversationId,
      })
      return fail(err.message, model, tier)
    }
    const fb = fallbackModelForTier(tier, model.id)
    if (fb && fb.id !== model.id) {
      console.warn(
        `[subagent] ${model.id} failed (${err instanceof Error ? err.message : err}) — fallback ${fb.id}`,
      )
      fallbackUsed = true
      model = fb
      tier = fb.provider === 'anthropic' ? 'critical' : tier
      try {
        const result = await runWithModel(model, tier, params, def)
        if (!result.completed) throw new SubAgentIncompleteError(params.role)
        // Same customer-facing Bangla gate as the primary path — the fallback
        // reply reaches the customer through the exact same pipe.
        let fbSummary = result.summary || '(fallback সারাংশ)'
        if (isOpenRouterProvider(model.provider) && needsCustomerFacingBanglaGate(params.role, tier)) {
          fbSummary = gateCheapModelBanglaOutput(fbSummary, { customerFacing: true })
        }
        const costUsd = result.actualCostUsd != null
          ? roundUsd(result.actualCostUsd)
          : calcModelTurnCostUsd(model, {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheRead: result.cacheRead,
              cacheWrite: result.cacheWrite,
            })
        void logCost({
          provider: costProviderForModel(model),
          kind: 'chat',
          units: {
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            cache_read_input_tokens: result.cacheRead,
            model: model.id,
            subagent: params.role,
            task_tier: tier,
            via:
              model.provider === 'google'
                ? 'fallback-gemini'
                : model.provider === 'anthropic'
                  ? 'fallback-claude'
                  : 'fallback',
            task_snippet: params.task.slice(0, 160),
            cost_source: result.actualCostUsd != null ? 'openrouter_actual' : 'estimate',
          },
          costUsd,
          conversationId: params.conversationId ?? null,
          dedupKey: `subagent:fb:${params.conversationId ?? 'na'}:${params.role}:${Date.now()}`,
        })
        return {
          success: true,
          role: params.role,
          roleLabel: def.label,
          modelId: model.id,
          modelLabel: model.label,
          tier,
          summary: fbSummary,
          toolsUsed: result.toolsUsed,
          costUsd,
          fallbackUsed: true,
        }
      } catch (fbErr) {
        await captureAgentError(fbErr, 'agent.subagent.fallback.error', {
          tool: `subagent:${params.role}`,
          conversationId: params.conversationId,
        })
        return fail(
          fbErr instanceof Error ? fbErr.message : String(fbErr),
          model,
          tier,
        )
      }
    }

    await captureAgentError(err, 'agent.subagent.error', {
      tool: `subagent:${params.role}`,
      conversationId: params.conversationId,
    })
    return fail(err instanceof Error ? err.message : String(err), model, tier)
  }
}

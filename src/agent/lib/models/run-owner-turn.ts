/**
 * Owner /agent chat dispatcher — ONLY entry point for per-session model selection.
 * Anthropic models delegate to runAgentTurn (native Claude path).
 * Other providers use normalized adapters with the same tool handlers + claim-verifier.
 */
import { prisma } from '@/lib/prisma'
import { MAX_TOOL_ITERATIONS } from '@/agent/config'
import { runAgentTurn, type AgentEvent, type RunAgentTurnOptions } from '@/agent/lib/core'
import { buildSystemPromptBlocks, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectToolsForTurnAsync } from '@/agent/tools/select-tools'
import { executeTool, executePersonalTool } from '@/agent/tools/registry'
import { normalizeBusinessId, type AgentBusinessId } from '@/lib/agent-api/business-context'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { bumpPlaybookForTool, getActivePlaybook } from '@/agent/lib/playbook'
import { captureAgentError } from '@/agent/lib/sentry'
import { logCost } from '@/agent/lib/cost-events'
import { looksLikeDurableFact, MEMORY_SAVE_NUDGE } from '@/agent/lib/memory-fact-detect'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import {
  detectClaimViolations,
  buildVerificationReminder,
  MAX_VERIFY_RETRIES,
} from '@/agent/lib/claim-verifier'
import { getModel } from '@/agent/lib/models/registry'
import { adapterFor } from '@/agent/lib/models/adapters'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import {
  anthropicToolsToNeutral,
  appendToolExchange,
  dbRowsToNeutral,
  systemBlocksToText,
} from '@/agent/lib/models/neutral'
import type { NeutralMsg } from '@/agent/lib/models/types'
import type { CostProvider } from '@/agent/lib/pricing'

export interface RunOwnerTurnOptions extends RunAgentTurnOptions {
  /** Registry model id from AgentConversation.modelId */
  modelId?: string | null
}

function providerToCostProvider(provider: string): CostProvider {
  if (provider === 'google') return 'gemini'
  if (provider === 'openai') return 'openai'
  return 'anthropic'
}

async function loadPinnedMemories(
  personalMode: boolean,
  businessId: AgentBusinessId,
): Promise<PinnedMemory[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<{ id: string; content: string; scope: string; metadata: unknown }> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).agentMemory.findMany({
        where: personalMode
          ? { pinned: true, scope: 'personal' }
          : { pinned: true, scope: { not: 'personal' } },
        orderBy: { createdAt: 'desc' },
        take: 60,
        select: { id: true, content: true, scope: true, metadata: true },
      })

    const filtered = personalMode
      ? rows
      : rows.filter((r) => {
          const tag = (r.metadata && typeof r.metadata === 'object'
            ? (r.metadata as Record<string, unknown>).businessId
            : undefined) as string | undefined
          if (businessId === 'ALMA_TRADING') return tag === 'ALMA_TRADING'
          return !tag || tag === 'ALMA_LIFESTYLE'
        })

    return filtered.slice(0, 30).map((r) => ({ id: r.id, content: r.content, scope: r.scope })) as PinnedMemory[]
  } catch (err) {
    console.warn('[run-owner-turn] loadPinnedMemories failed:', err instanceof Error ? err.message : err)
    return []
  }
}

async function loadOwnerDecisions(businessId: AgentBusinessId): Promise<OwnerDecision[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).agentMemory.findMany({
      where: { scope: 'business' },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { content: true, metadata: true, createdAt: true },
    }) as Array<{ content: string; metadata: Record<string, unknown> | null; createdAt: Date }>

    return rows
      .filter((r) => {
        const meta = r.metadata
        if (!meta || meta.type !== 'owner_decision') return false
        const tag = meta.businessId as string | undefined
        if (businessId === 'ALMA_TRADING') return tag === 'ALMA_TRADING'
        return !tag || tag === 'ALMA_LIFESTYLE'
      })
      .slice(0, 5)
      .map((r) => ({ content: r.content, createdAt: r.createdAt }))
  } catch (err) {
    console.warn('[run-owner-turn] loadOwnerDecisions failed:', err instanceof Error ? err.message : err)
    return []
  }
}

async function* runAlternateProviderTurn(
  conversationId: string,
  modelId: string,
  options: RunOwnerTurnOptions,
): AsyncGenerator<AgentEvent> {
  const model = getModel(modelId)
  const { projectSystemInstructions, personalMode = false, signal, telegramFastPath = false } = options
  const businessId: AgentBusinessId = personalMode
    ? 'ALMA_LIFESTYLE'
    : normalizeBusinessId(options.businessId)

  let totalInputTokens = 0
  let totalOutputTokens = 0

  const rows = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  })
  let messages: NeutralMsg[] = dbRowsToNeutral(rows)

  const recentUserTexts: string[] = []
  for (let i = messages.length - 1; i >= 0 && recentUserTexts.length < 12; i--) {
    const m = messages[i]
    if (m.role !== 'user' || !('content' in m)) continue
    if (typeof m.content === 'string' && m.content.trim()) recentUserTexts.unshift(m.content.trim())
  }
  const lastUserText = recentUserTexts[recentUserTexts.length - 1] ?? ''

  const now = new Date()
  if (!personalMode) {
    await applySalahAutoMarkFromUserTexts(lastUserText ? [lastUserText] : [], now)
  }

  const [pinnedMemories, relevantMemories, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext] = await Promise.all([
    loadPinnedMemories(personalMode, businessId),
    lastUserText ? retrieveRelevantMemories(lastUserText, personalMode, businessId) : Promise.resolve([]),
    personalMode ? Promise.resolve(null) : loadSalahAccountabilityContext(now, lastUserText),
    personalMode || telegramFastPath
      ? Promise.resolve([])
      : loadRecentOtherConversations(conversationId, 5),
    personalMode ? Promise.resolve([]) : getActivePlaybook(businessId),
    personalMode ? Promise.resolve([] as OutcomeLearning[]) : getRecentOutcomeLearnings({ limit: 5 }).catch(() => [] as OutcomeLearning[]),
    personalMode ? Promise.resolve([] as OwnerDecision[]) : loadOwnerDecisions(businessId),
    (personalMode || !lastUserText) ? Promise.resolve([]) : detectInstructionConflicts(lastUserText, businessId).catch(() => []),
    personalMode ? Promise.resolve('') : buildBusinessContext(businessId).catch(() => ''),
  ])

  const promptArgs = {
    projectInstructions: projectSystemInstructions,
    pinnedMemories,
    relevantMemories,
    salahContext: salahContext ?? undefined,
    prayerTimeOnlyTurn: personalMode
      ? false
      : !isSalahStatusInquiry(lastUserText) && isPrayerTimeInquiry(lastUserText),
    staffTaskPlanningTurn: personalMode ? false : isStaffTaskPlanningInquiry(lastUserText),
    staffTaskStatusTurn: personalMode ? false : isStaffTaskStatusInquiry(lastUserText),
    crossSurface,
    salahStatusTurn: personalMode ? false : isSalahStatusInquiry(lastUserText),
    personalMode,
    businessId,
    activePlaybook,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
  }

  const { stable, volatile } = buildSystemPromptBlocks(promptArgs)
  const systemText = systemBlocksToText([...stable, ...volatile])
  const selectedTools = await selectToolsForTurnAsync(lastUserText, { personalMode, businessId })
  const neutralTools = anthropicToolsToNeutral(selectedTools)
  const adapter = adapterFor(model.provider)

  type ToolRecord = {
    id: string; toolName: string; input: Record<string, unknown>
    output: Record<string, unknown> | null; status: 'success' | 'error'
    durationMs: number; error: string | null
  }
  const toolRecords: ToolRecord[] = []
  let verifyRetries = 0
  let memoryNudgeSent = false
  let finalText = ''

  let approvalReminderPrefix = ''
  if (!personalMode && lastUserText) {
    try {
      const { buildPendingApprovalReminderPrefix } = await import('@/agent/lib/pending-approval-reminder')
      approvalReminderPrefix = await buildPendingApprovalReminderPrefix()
      if (approvalReminderPrefix) {
        yield { type: 'text_delta', delta: approvalReminderPrefix }
      }
    } catch (err) {
      console.warn('[run-owner-turn] pending approval reminder failed:', err instanceof Error ? err.message : err)
    }
  }

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (signal?.aborted) break

      const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      const toolNames = new Map<string, string>()
      let iterationText = ''

      for await (const ev of adapter.streamTurn({
        apiModel: model.apiModel,
        system: systemText,
        messages,
        tools: neutralTools,
        thinking: model.thinking,
        signal,
      })) {
        if (ev.type === 'text_delta') {
          iterationText += ev.text
          finalText += ev.text
          yield { type: 'text_delta', delta: ev.text }
        } else if (ev.type === 'tool_start') {
          toolNames.set(ev.id, ev.name)
          yield { type: 'tool_start', id: ev.id, name: ev.name }
        } else if (ev.type === 'tool_input') {
          calls.push({ id: ev.id, name: toolNames.get(ev.id) ?? '', input: ev.input })
        } else if (ev.type === 'usage') {
          totalInputTokens += ev.inputTokens
          totalOutputTokens += ev.outputTokens
        }
      }

      if (calls.length === 0 || signal?.aborted) {
        if (!signal?.aborted && verifyRetries < MAX_VERIFY_RETRIES && iterationText.trim()) {
          const calledTools = toolRecords.map((r) => r.toolName)
          const violations = detectClaimViolations(iterationText.trim(), calledTools)
          if (violations.length > 0) {
            verifyRetries++
            yield {
              type: 'verification_retry',
              attempt: verifyRetries,
              maxAttempts: MAX_VERIFY_RETRIES,
              categories: Array.from(new Set(violations.map((v) => v.category))),
              snippets: violations.map((v) => v.matchedSnippet),
            }
            finalText = ''
            messages = [
              ...messages,
              { role: 'assistant', content: iterationText },
              { role: 'user', content: buildVerificationReminder(violations) },
            ]
            continue
          }
        }

        if (
          !signal?.aborted
          && !memoryNudgeSent
          && lastUserText
          && looksLikeDurableFact(lastUserText)
          && !toolRecords.some((r) => r.toolName === 'save_memory')
        ) {
          memoryNudgeSent = true
          messages = [...messages, { role: 'user', content: MEMORY_SAVE_NUDGE }]
          continue
        }
        break
      }

      const toolResults: Array<{ id: string; name: string; result: unknown }> = []
      for (const call of calls) {
        const started = Date.now()
        const result = personalMode
          ? await executePersonalTool(call.name, call.input, { conversationId, businessId })
          : await executeTool(call.name, call.input, { conversationId, businessId, modelId: model.id })
        const durationMs = Date.now() - started

        if (!result.success) {
          await captureAgentError(new Error(result.error ?? 'tool_failed'), 'agent.tool.failed', {
            tool: call.name,
            conversationId,
          })
        }

        toolRecords.push({
          id: call.id,
          toolName: call.name,
          input: call.input,
          output: result.data !== undefined ? { data: result.data } : null,
          status: result.success ? 'success' : 'error',
          durationMs,
          error: result.error ?? null,
        })

        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          success: result.success,
          error: result.error,
        }

        if (result.success && !personalMode) {
          void bumpPlaybookForTool(call.name, businessId).catch(() => {})
        }

        if (result.success && result.data != null && typeof result.data === 'object') {
          const d = result.data as Record<string, unknown>
          if (typeof d.pendingActionId === 'string') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const row = await (prisma as any).agentPendingAction.findUnique({
              where: { id: d.pendingActionId },
              select: { status: true, summary: true, costEstimate: true },
            })
            if (row?.status === 'pending') {
              yield {
                type: 'confirm_card',
                pendingActionId: d.pendingActionId,
                summary: typeof d.summary === 'string' && d.summary ? d.summary : (row.summary ?? ''),
                costEstimate: typeof d.costEstimate === 'number' ? d.costEstimate : (row.costEstimate ?? undefined),
                actionType: typeof d.actionType === 'string' ? d.actionType : undefined,
                entryCount: typeof d.entryCount === 'number' ? d.entryCount : undefined,
                isFinance: d.isFinance === true,
                isBatch: d.isBatch === true,
              }
            }
          }
          if (typeof d.askCardId === 'string' && Array.isArray(d.options)) {
            yield {
              type: 'ask_card',
              askCardId: d.askCardId,
              question: typeof d.question === 'string' ? d.question : '',
              options: d.options as string[],
            }
          }
        }

        toolResults.push({ id: call.id, name: call.name, result })
      }

      messages = appendToolExchange(messages, calls, toolResults)
    }

    const costUsd = calcModelTurnCostUsd(model, {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const savedMsg = await db.agentMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: [{ type: 'text', text: approvalReminderPrefix + finalText }],
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        costUsd,
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, model: model.id, apiModel: model.apiModel, provider: model.provider },
      },
    })

    if (toolRecords.length > 0) {
      await db.agentToolCall.createMany({
        data: toolRecords.map((r) => ({
          messageId: savedMsg.id,
          toolName: r.toolName,
          input: r.input,
          output: r.output,
          status: r.status,
          durationMs: r.durationMs,
          error: r.error,
        })),
      })
    }

    await touchConversationActivity(conversationId)

    void logCost({
      provider: providerToCostProvider(model.provider),
      kind: 'chat',
      units: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        model: model.id,
        apiModel: model.apiModel,
        provider: model.provider,
      },
      costUsd,
      conversationId,
      jobId: savedMsg.id,
      dedupKey: `chat:msg:${savedMsg.id}`,
    })

    yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, costUsd }
  } catch (err) {
    if (signal?.aborted) return
    await captureAgentError(err, 'agent.provider.error', { conversationId })
    const msg = err instanceof Error ? err.message : String(err)
    yield { type: 'error', message: `Model error (${model.label}): ${msg}` }
  }
}

export async function* runOwnerTurn(
  conversationId: string,
  options: RunOwnerTurnOptions = {},
): AsyncGenerator<AgentEvent> {
  const model = getModel(options.modelId)

  if (model.provider === 'anthropic') {
    yield* runAgentTurn(conversationId, {
      ...options,
      modelId: model.id,
    })
    return
  }

  yield* runAlternateProviderTurn(conversationId, model.id, options)
}

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS } from '@/agent/config'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { buildSystemPromptBlocks, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectToolsForTurnAsync } from '@/agent/tools/select-tools'
import { executeTool, executePersonalTool } from '@/agent/tools/registry'
import { normalizeBusinessId, type AgentBusinessId } from '@/lib/agent-api/business-context'
import { agentStorageDownload } from '@/agent/lib/storage'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { bumpPlaybookForTool, getActivePlaybook } from '@/agent/lib/playbook'
import { bumpPlaybookRulesForDomains } from '@/agent/lib/learning/learned-rules'
import { detectTeachingIntent } from '@/agent/lib/learning/teaching-intent'
import { applyOwnerTeaching, buildTeachingTurnPromptBlock } from '@/agent/lib/learning/apply-teaching'
import { banglaAnthropicError, extractAnthropicRequestId, isAnthropicQuotaExhausted } from '@/agent/lib/anthropic-errors'
import { captureAgentError } from '@/agent/lib/sentry'
import { specialistLabel } from '@/agent/lib/models/specialist-roles'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { logCost } from '@/agent/lib/cost-events'
import { looksLikeDurableFact, MEMORY_SAVE_NUDGE } from '@/agent/lib/memory-fact-detect'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import {
  detectClaimViolations,
  buildVerificationReminder,
  MAX_VERIFY_RETRIES,
  type ClaimViolation,
} from '@/agent/lib/claim-verifier'

// ── Event types ────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; name: string; success: boolean; error?: string }
  | { type: 'subagent_start'; id: string; role: string; roleLabel: string; task: string }
  | { type: 'subagent_end'; id: string; role: string; success: boolean; summary?: string; toolsUsed?: string[]; error?: string }
  | { type: 'confirm_card'; pendingActionId: string; summary: string; costEstimate?: number; actionType?: string; entryCount?: number; isFinance?: boolean; isBatch?: boolean }
  | { type: 'ask_card'; askCardId: string; question: string; options: string[] }
  | {
      type: 'verification_retry'
      attempt: number
      maxAttempts: number
      categories: string[]
      snippets: string[]
    }
  | { type: 'done'; messageId: string; tokensIn: number; tokensOut: number; costUsd: number }
  | { type: 'error'; message: string }

// ── Anthropic client ────────────────────────────────────────────────────────

const globalForAnthropic = globalThis as unknown as { anthropic: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForAnthropic.anthropic) {
    globalForAnthropic.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  }
  return globalForAnthropic.anthropic
}

// ── Types ──────────────────────────────────────────────────────────────────

type ApiMessage = Anthropic.Messages.MessageParam

// Locally collected block after streaming (avoids SDK response/param mismatch).
type CollectedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

// Stored in DB user messages to reference uploaded files.
interface FileRefBlock {
  type: 'file_ref'
  bucket: string
  path: string
  mediaType: string
}

type StoredContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | FileRefBlock

// ── History loading with file reconstruction ───────────────────────────────

async function resolveFileRef(ref: FileRefBlock): Promise<Anthropic.Messages.ContentBlockParam> {
  const buffer = await agentStorageDownload(ref.path)
  const b64 = buffer.toString('base64')
  if (ref.mediaType === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64 },
    } as unknown as Anthropic.Messages.ContentBlockParam
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: ref.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
      data: b64,
    },
  }
}

/**
 * Loads conversation history and converts to Anthropic MessageParam[].
 * File refs in user messages are resolved to base64 for the 5 most-recent
 * file-containing messages; older ones get a text placeholder instead.
 */
async function loadHistory(conversationId: string): Promise<ApiMessage[]> {
  const rows = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  })

  // Identify indices of user messages that contain file_ref blocks (most-recent first).
  const fileMessageIndices: number[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const content = rows[i].content as unknown as StoredContentBlock[]
    if (Array.isArray(content) && content.some((b) => b.type === 'file_ref')) {
      fileMessageIndices.push(i)
    }
  }
  const recentFileSet = new Set(fileMessageIndices.slice(0, 5))

  const result: ApiMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const stored = row.content as unknown as StoredContentBlock[]

    if (!Array.isArray(stored)) {
      result.push({ role: row.role as 'user' | 'assistant', content: String(stored) })
      continue
    }

    const apiBlocks: Anthropic.Messages.ContentBlockParam[] = []
    for (const block of stored) {
      if (block.type === 'file_ref') {
        if (recentFileSet.has(i)) {
          apiBlocks.push({
            type: 'text',
            text: `[Uploaded file path for tools: ${block.path}]`,
          })
          try {
            apiBlocks.push(await resolveFileRef(block))
          } catch {
            apiBlocks.push({ type: 'text', text: '[ফাইল লোড করা যায়নি]' })
          }
        } else {
          apiBlocks.push({
            type: 'text',
            text: `[পূর্ববর্তী ফাইল সংযুক্তি: ${block.path}]`,
          })
        }
      } else {
        apiBlocks.push(block as unknown as Anthropic.Messages.ContentBlockParam)
      }
    }

    result.push({ role: row.role as 'user' | 'assistant', content: apiBlocks })
  }

  return result
}

/** Marks the last user turn with cache_control for prompt caching. */
function applyCacheControl(messages: ApiMessage[]): ApiMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const msg = messages[i]
    const rawContent = msg.content
    const blocks: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
      ? [...rawContent]
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : []
    if (blocks.length === 0) break
    const last = blocks[blocks.length - 1]
    blocks[blocks.length - 1] = {
      ...last,
      cache_control: { type: 'ephemeral' },
    } as Anthropic.Messages.ContentBlockParam
    return [
      ...messages.slice(0, i),
      { role: 'user' as const, content: blocks },
      ...messages.slice(i + 1),
    ]
  }
  return messages
}

// ── Memory helpers ─────────────────────────────────────────────────────────

async function loadPinnedMemories(
  personalMode: boolean,
  businessId: AgentBusinessId,
): Promise<PinnedMemory[]> {
  try {
    // Filter business-scoped memories by current business; untagged legacy
    // rows are treated as Lifestyle. Personal scope is cross-business.
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
  } catch {
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
  } catch {
    return []
  }
}


// ── Options ────────────────────────────────────────────────────────────────

export interface RunAgentTurnOptions {
  /** System instructions from the conversation's project (appended to base system prompt). */
  projectSystemInstructions?: string | null
  /** Personal Advisor mode — separate brain, personal tools + memory only. */
  personalMode?: boolean
  /** Telegram owner path — skip expensive cross-surface context loads. */
  telegramFastPath?: boolean
  /** AbortSignal from the HTTP request — cancels the stream early if client disconnects. */
  signal?: AbortSignal
  /** Business scope — drives prompt operations rule, tool registry, staff/dispatch filters. */
  businessId?: AgentBusinessId | null
  /** Registry model id — owner /agent only; default claude-sonnet-4-6 when absent. */
  modelId?: string | null
}

// ── Main agent turn ────────────────────────────────────────────────────────

export async function* runAgentTurn(
  conversationId: string,
  options: RunAgentTurnOptions = {},
): AsyncGenerator<AgentEvent> {
  const client = getClient()
  const { projectSystemInstructions, personalMode = false, signal, telegramFastPath = false } = options
  const chatModel = getModel(options.modelId)
  const apiModel = chatModel.provider === 'anthropic' ? chatModel.apiModel : AGENT_MODEL
  // Resolve business scope: personal mode is always cross-business; otherwise default to Lifestyle.
  const businessId: AgentBusinessId = personalMode
    ? 'ALMA_LIFESTYLE'
    : normalizeBusinessId(options.businessId)

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0

  let messages: ApiMessage[] = await loadHistory(conversationId)

  // If this conversation was seeded from a compaction, prepend the context summary
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = await (prisma as any).agentConversation.findUnique({
      where: { id: conversationId },
      select: { contextSummary: true },
    })
    if (conv?.contextSummary && messages.length <= 2) {
      messages = [
        { role: 'user', content: `[পূর্ববর্তী কথোপকথনের সারাংশ]\n${conv.contextSummary}` },
        { role: 'assistant', content: 'বুঝেছি, আগের কথোপকথনের সব প্রসঙ্গ মনে আছে। বলুন স্যার।' },
        ...messages,
      ]
    }
  } catch { /* contextSummary column might not exist yet */ }

  const assistantTurns: CollectedBlock[][] = []

  // Extract recent owner messages for salah auto-mark + RAG
  const recentUserTexts: string[] = []
  for (let i = messages.length - 1; i >= 0 && recentUserTexts.length < 12; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = Array.isArray(m.content)
      ? m.content
          .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
      : String(m.content)
    if (text.trim()) recentUserTexts.unshift(text.trim())
  }
  const lastUserText = recentUserTexts[recentUserTexts.length - 1] ?? ''

  const now = new Date()
  let teachingBlock: string | undefined
  if (!personalMode && lastUserText) {
    const teaching = detectTeachingIntent(lastUserText)
    if (teaching) {
      try {
        const applied = await applyOwnerTeaching({ intent: teaching, businessId })
        teachingBlock = buildTeachingTurnPromptBlock(applied)
      } catch (err) {
        console.error('[core] applyOwnerTeaching failed:', err)
      }
    }
  }

  if (!personalMode) {
    await applySalahAutoMarkFromUserTexts(lastUserText ? [lastUserText] : [], now)
  }

  // Load pinned memories, relevant memories, and tool selection in parallel
  const [pinnedMemories, relevantMemories, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext, selectedTools] = await Promise.all([
    loadPinnedMemories(personalMode, businessId),
    lastUserText ? retrieveRelevantMemories(lastUserText, personalMode, businessId) : Promise.resolve([]),
    personalMode ? Promise.resolve(null) : loadSalahAccountabilityContext(now, lastUserText),
    personalMode || telegramFastPath
      ? Promise.resolve([])
      : loadRecentOtherConversations(conversationId, 5),
    personalMode ? Promise.resolve([]) : getActivePlaybook(businessId),
    personalMode ? Promise.resolve([] as OutcomeLearning[]) : getRecentOutcomeLearnings({ limit: 5 }).catch(() => [] as OutcomeLearning[]),
    personalMode ? Promise.resolve([] as OwnerDecision[]) : loadOwnerDecisions(businessId),
    personalMode ? Promise.resolve([]) : detectInstructionConflicts(lastUserText, businessId).catch(() => []),
    personalMode ? Promise.resolve('') : buildBusinessContext(businessId).catch(() => ''),
    selectToolsForTurnAsync(lastUserText, { personalMode, businessId }),
  ])

  type ToolRecord = {
    id: string; toolName: string; input: Record<string, unknown>
    output: Record<string, unknown> | null; status: 'success' | 'error'
    durationMs: number; error: string | null
  }
  const toolRecords: ToolRecord[] = []
  let memoryNudgeSent = false
  let verifyRetries = 0

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
    teachingBlock,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
  }
  const { stable: stableSystem, volatile: volatileSystem } = buildSystemPromptBlocks(promptArgs)
  const systemBlocks = [...stableSystem, ...volatileSystem]

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (signal?.aborted) break

      const apiMessages = applyCacheControl(messages)

      const stream = client.messages.stream(
        {
          model: apiModel,
          max_tokens: 8192,
          thinking: { type: 'adaptive' },
          system: systemBlocks,
          tools: selectedTools,
          messages: apiMessages,
        },
        { signal: signal ?? undefined },
      )

      const currentBlocks: CollectedBlock[] = []
      let activeBlockType: string | null = null
      let activeBlockText = ''
      let activeBlockId = ''
      let activeBlockName = ''
      let activeBlockInputJson = ''

      for await (const event of stream) {
        if (signal?.aborted) break

        if (event.type === 'message_start') {
          const u = event.message.usage
          totalInputTokens += u.input_tokens
          totalOutputTokens += u.output_tokens
          totalCacheCreationTokens += (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
          totalCacheReadTokens += (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
        } else if (event.type === 'message_delta') {
          if (event.usage) totalOutputTokens += event.usage.output_tokens
        } else if (event.type === 'content_block_start') {
          const block = event.content_block
          activeBlockType = block.type
          if (block.type === 'text') {
            activeBlockText = ''
          } else if (block.type === 'tool_use') {
            activeBlockId = block.id
            activeBlockName = block.name
            activeBlockInputJson = ''
            // Delegation gets a richer live "delegation card" emitted from the
            // execution loop (once the role/task input is parsed), not a generic chip.
            if (block.name !== 'delegate_to_specialist') {
              yield { type: 'tool_start', id: block.id, name: block.name }
            }
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            activeBlockText += delta.text
            yield { type: 'text_delta', delta: delta.text }
          } else if (delta.type === 'thinking_delta') {
            // Surface the model's extended-thinking stream so the UI can show a
            // live "Thought for Ns" block — how the agent is reasoning about the
            // owner's message before it answers. Not persisted to history here.
            yield { type: 'thinking_delta', delta: delta.thinking }
          } else if (delta.type === 'input_json_delta') {
            activeBlockInputJson += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          if (activeBlockType === 'text') {
            currentBlocks.push({ type: 'text', text: activeBlockText })
          } else if (activeBlockType === 'tool_use') {
            let parsedInput: Record<string, unknown> = {}
            try { parsedInput = JSON.parse(activeBlockInputJson || '{}') } catch { parsedInput = { _raw: activeBlockInputJson } }
            currentBlocks.push({ type: 'tool_use', id: activeBlockId, name: activeBlockName, input: parsedInput })
          }
        }
      }

      assistantTurns.push(currentBlocks)

      const toolUseBlocks = currentBlocks.filter(
        (b): b is Extract<CollectedBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )

      if (toolUseBlocks.length === 0 || signal?.aborted) {
        if (!signal?.aborted && verifyRetries < MAX_VERIFY_RETRIES) {
          const finalText = currentBlocks
            .filter((b): b is Extract<CollectedBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim()
          const calledTools = toolRecords.map((r) => r.toolName)
          const violations: ClaimViolation[] = finalText
            ? detectClaimViolations(finalText, calledTools)
            : []
          if (violations.length > 0) {
            verifyRetries++
            yield {
              type: 'verification_retry',
              attempt: verifyRetries,
              maxAttempts: MAX_VERIFY_RETRIES,
              categories: Array.from(new Set(violations.map((v) => v.category))),
              snippets: violations.map((v) => v.matchedSnippet),
            }
            assistantTurns.pop()
            const reminder = buildVerificationReminder(violations)
            messages = [
              ...messages,
              {
                role: 'assistant',
                content: currentBlocks as unknown as Anthropic.Messages.ContentBlockParam[],
              },
              { role: 'user', content: [{ type: 'text', text: reminder }] },
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
          messages = [
            ...messages,
            { role: 'user', content: [{ type: 'text', text: MEMORY_SAVE_NUDGE }] },
          ]
          continue
        }
        break
      }

      messages = [
        ...messages,
        { role: 'assistant', content: currentBlocks as unknown as Anthropic.Messages.ContentBlockParam[] },
      ]

      const toolResultContent: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
        const isDelegate = tb.name === 'delegate_to_specialist'
        // Emit the live delegation card the moment we know which specialist + task.
        if (isDelegate) {
          const role = String((tb.input as Record<string, unknown>).role ?? '')
          const task = String((tb.input as Record<string, unknown>).task ?? '')
          yield { type: 'subagent_start', id: tb.id, role, roleLabel: specialistLabel(role), task }
        }

        const started = Date.now()
        const result = personalMode
          ? await executePersonalTool(tb.name, tb.input, { conversationId, businessId })
          : await executeTool(tb.name, tb.input, { conversationId, businessId, modelId: chatModel.id })
        const durationMs = Date.now() - started

        if (!result.success) {
          await captureAgentError(new Error(result.error ?? 'tool_failed'), 'agent.tool.failed', {
            tool: tb.name,
            conversationId,
          })
        }

        toolRecords.push({
          id: tb.id, toolName: tb.name, input: tb.input,
          output: result.data !== undefined ? { data: result.data } : null,
          status: result.success ? 'success' : 'error',
          durationMs, error: result.error ?? null,
        })

        if (isDelegate) {
          const d = (result.data ?? {}) as Record<string, unknown>
          const role = String((tb.input as Record<string, unknown>).role ?? '')
          yield {
            type: 'subagent_end',
            id: tb.id,
            role,
            success: result.success,
            summary: typeof d.summary === 'string' ? d.summary : undefined,
            toolsUsed: Array.isArray(d.toolsUsed) ? (d.toolsUsed as string[]) : undefined,
            error: result.error,
          }
        } else {
          yield { type: 'tool_end', id: tb.id, name: tb.name, success: result.success, error: result.error }
        }

        if (result.success && !personalMode) {
          void bumpPlaybookForTool(tb.name, businessId).catch(() => {})
          const designTools = /make_ad_creatives|run_content_post|make_product_reel|generate_on_model|content/i
          if (designTools.test(tb.name)) {
            void bumpPlaybookRulesForDomains(['design', 'content'], businessId).catch(() => {})
          }
        }

        // Emit confirm_card only when the pending action is still awaiting owner approval
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
                summary: typeof d.summary === 'string' && d.summary
                  ? d.summary
                  : (row.summary ?? ''),
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

        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: JSON.stringify(result),
        })
      }

      messages = [...messages, { role: 'user', content: toolResultContent }]
    }

    // Persist assistant message.
    const textContent = assistantTurns.flat().filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    const storedContent = textContent.length > 0 ? textContent : [{ type: 'text', text: '' }]
    const costUsd = calcModelTurnCostUsd(chatModel, {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheWrite: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const savedMsg = await db.agentMessage.create({
      data: {
        conversationId, role: 'assistant', content: storedContent,
        tokensIn: totalInputTokens, tokensOut: totalOutputTokens, costUsd,
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens },
      },
    })

    if (toolRecords.length > 0) {
      await db.agentToolCall.createMany({
        data: toolRecords.map((r: ToolRecord) => ({
          messageId: savedMsg.id, toolName: r.toolName, input: r.input,
          output: r.output, status: r.status, durationMs: r.durationMs, error: r.error,
        })),
      })
    }

    await touchConversationActivity(conversationId)

    void logCost({
      provider: 'anthropic',
      kind: 'chat',
      units: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cache_creation_input_tokens: totalCacheCreationTokens,
        cache_read_input_tokens: totalCacheReadTokens,
        model: chatModel.id,
        apiModel,
        provider: chatModel.provider,
      },
      costUsd,
      conversationId,
      jobId: savedMsg.id,
      dedupKey: `chat:msg:${savedMsg.id}`,
    })

    yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, costUsd }
  } catch (err) {
    if (signal?.aborted) return
    const requestId = extractAnthropicRequestId(err)
    await captureAgentError(err, 'agent.anthropic.error', { conversationId, requestId })

    if (isAnthropicQuotaExhausted(err)) {
      void notifyOwner({
        tier: 1,
        category: 'urgent',
        title: 'Anthropic quota exhausted',
        message: `Agent chat failed — API quota/credits exhausted. requestId=${requestId ?? 'n/a'}`,
      })
    }

    yield { type: 'error', message: banglaAnthropicError(err) }
  }
}

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS } from '@/agent/config'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { buildSystemPromptBlocks, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { buildOwnerActiveTasksContextBlock } from '@/agent/lib/owner-active-tasks-context'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectToolsAndGroupsForTurnAsync, selectToolGroupsSync, applyToolSearchDeferral, TOOL_SEARCH_ENABLED } from '@/agent/tools/select-tools'
import { getAgentControls, filterToolDefsByControls, controlsPromptNote } from '@/agent/lib/agent-controls'
import { executeTool, executePersonalTool } from '@/agent/tools/registry'
import { logRefusalEvent } from '@/agent/lib/tool-telemetry'
import { normalizeBusinessId, type AgentBusinessId } from '@/lib/agent-api/business-context'
import { agentStorageDownload } from '@/agent/lib/storage'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { getBusinessSnapshot } from '@/agent/lib/business-snapshot'
import { annotateEmptyResult } from '@/agent/lib/tool-result-note'
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
  buildVerificationReminder,
  MAX_VERIFY_RETRIES,
  type ClaimViolation,
  type ToolLedgerEntry,
  verifyClaimsAgainstLedger,
} from '@/agent/lib/claim-verifier'

// ── Event types ────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
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
  | { type: 'done'; messageId: string; tokensIn: number; tokensOut: number; cacheCreation: number; cacheRead: number; costUsd: number }
  | { type: 'error'; message: string }

// ── Mutating tools (conservative: unknown = treat as mutating) ──────────────
export const MUTATING_TOOLS = new Set([
  'add_family_contact', 'add_owner_todo', 'add_product_asset', 'add_staff_task_now',
  'add_subscription', 'approve_and_dispatch_tasks', 'approve_pending_dispatch',
  'approve_pending_staff_message', 'approve_playbook', 'cancel_reminder',
  'confirm_oxylabs_spend', 'correct_and_redispatch_staff_tasks', 'create_order_draft',
  'delete_finance_entry', 'delete_memory', 'duplicate_campaign', 'edit_finance_entry',
  'forget_reference', 'forget_rule', 'log_expense', 'log_expenses_batch',
  'log_ledger_entries_batch', 'log_ledger_entry', 'manage_competitor_watchlist',
  'manage_model_library', 'manage_work_todos', 'mark_salah', 'merge_into_proposal',
  'outbound_phone_call', 'pause_campaign', 'pause_content_engine', 'post_to_facebook',
  'publish_product', 'reject_playbook', 'resume_content_engine', 'retire_playbook',
  'run_content_post', 'save_brand_asset', 'save_memory', 'send_customer_message',
  'send_dispatch_correction_notice', 'send_product_image', 'send_staff_announcement',
  'send_urgent_alert', 'set_api_credit', 'set_product_featured', 'set_qc_level',
  'set_reminder', 'set_salah_override', 'set_salah_time', 'set_staff_leave',
  'snooze_reminder', 'unpublish_product', 'update_campaign_budget', 'update_memory',
  'update_owner_todo', 'update_product_web', 'update_setting', 'update_staff_task_profile',
  'update_staff_task_status', 'delegate_to_specialist', 'call_family_member',
  'prepare_staff_task_proposal', 'propose_staff_tasks', 'request_salah_delay',
  'run_health_scan', 'web_research', 'generate_image', 'generate_on_model_image', 'generate_on_model_batch',
  'make_ad_creatives', 'make_product_reel',
  'make_plan', 'execute_plan',
])

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
  } catch (err) {
    console.warn('[core] loadPinnedMemories failed:', err instanceof Error ? err.message : err)
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
    console.warn('[core] loadOwnerDecisions failed:', err instanceof Error ? err.message : err)
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
  const { projectSystemInstructions, signal, telegramFastPath = false } = options
  let personalMode = options.personalMode ?? false
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
  } catch (err) {
    console.warn('[core] contextSummary load failed (column may not exist):', err instanceof Error ? err.message : String(err))
  }

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
  let intakeContextBlock: string | undefined
  let intakeAutoReply: string | undefined

  if (!personalMode && lastUserText) {
    try {
      const { processOwnerIntakeReply } = await import('@/agent/lib/owner-task-intake')
      const intake = await processOwnerIntakeReply(lastUserText, conversationId)
      if (intake?.autoReply) intakeAutoReply = intake.autoReply
      if (intake?.contextBlock) intakeContextBlock = intake.contextBlock
      if (intake?.forcePersonalMode) personalMode = true
    } catch (err) {
      console.warn('[core] owner intake reply failed:', err instanceof Error ? err.message : err)
    }
  }

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
  const [pinnedMemories, relevantMemories, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext, ownerActiveTasksBlock, toolSelection, businessSnapshot] = await Promise.all([
    loadPinnedMemories(personalMode, businessId),
    lastUserText ? retrieveRelevantMemories(lastUserText, personalMode, businessId) : Promise.resolve([]),
    personalMode ? Promise.resolve(null) : loadSalahAccountabilityContext(now, lastUserText),
    personalMode || telegramFastPath
      ? Promise.resolve([])
      : loadRecentOtherConversations(conversationId, 5),
    personalMode ? Promise.resolve([]) : getActivePlaybook(businessId),
    personalMode ? Promise.resolve([] as OutcomeLearning[]) : getRecentOutcomeLearnings({ limit: 5 }).catch((err) => {
      console.warn('[core] outcomeLearnings fetch failed:', err instanceof Error ? err.message : String(err))
      return [] as OutcomeLearning[]
    }),
    personalMode ? Promise.resolve([] as OwnerDecision[]) : loadOwnerDecisions(businessId),
    personalMode ? Promise.resolve([]) : detectInstructionConflicts(lastUserText, businessId).catch((err) => {
      console.warn('[core] conflictSignals fetch failed:', err instanceof Error ? err.message : String(err))
      return []
    }),
    personalMode ? Promise.resolve('') : buildBusinessContext(businessId).catch((err) => {
      console.warn('[core] businessContext build failed:', err instanceof Error ? err.message : String(err))
      return ''
    }),
    personalMode ? Promise.resolve('') : buildOwnerActiveTasksContextBlock(businessId).catch((err) => {
      console.warn('[core] ownerActiveTasksBlock failed:', err instanceof Error ? err.message : String(err))
      return ''
    }),
    selectToolsAndGroupsForTurnAsync(lastUserText, { personalMode, businessId }),
    personalMode || businessId === 'ALMA_TRADING' ? Promise.resolve(null) : getBusinessSnapshot(),
  ])
  const selectedTools = toolSelection.tools
  const activeGroups = toolSelection.groups

  type ToolRecord = {
    id: string; toolName: string; input: Record<string, unknown>
    output: Record<string, unknown> | null; status: 'success' | 'error'
    durationMs: number; error: string | null
  }
  const toolRecords: ToolRecord[] = []
  let memoryNudgeSent = false
  let verifyRetries = 0

  let approvalReminderPrefix = ''
  if (!personalMode && lastUserText) {
    try {
      const { buildPendingApprovalReminderPrefix } = await import('@/agent/lib/pending-approval-reminder')
      approvalReminderPrefix = await buildPendingApprovalReminderPrefix()
      if (approvalReminderPrefix) {
        yield { type: 'text_delta', delta: approvalReminderPrefix }
      }
    } catch (err) {
      console.warn('[core] pending approval reminder failed:', err instanceof Error ? err.message : err)
    }
  }

  if (intakeAutoReply) {
    const replyText = approvalReminderPrefix + intakeAutoReply
    yield { type: 'text_delta', delta: intakeAutoReply }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const savedMsg = await db.agentMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: [{ type: 'text', text: replyText }],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        usage: { input_tokens: 0, output_tokens: 0, model: chatModel.id, intake_auto: true },
      },
    })
    await touchConversationActivity(conversationId)
    yield { type: 'done', messageId: savedMsg.id, tokensIn: 0, tokensOut: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 }
    return
  }

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
    intakeContextBlock,
    ownerActiveTasksBlock: ownerActiveTasksBlock || undefined,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
    activeGroups,
    businessSnapshot,
  }
  const { stable: stableSystem, volatile: volatileSystem } = buildSystemPromptBlocks(promptArgs)
  const systemBlocks = [...stableSystem, ...volatileSystem]

  // Owner Control Center: drop OFF-capability tools and tell the agent (in the
  // prompt) to ask the owner to enable instead of improvising. Fail-open.
  const agentControls = await getAgentControls()
  const gatedTools = filterToolDefsByControls(selectedTools, agentControls)
  const controlsNote = controlsPromptNote(agentControls)
  if (controlsNote) systemBlocks.push({ type: 'text', text: controlsNote })

  // Tool Search (opt-in via AGENT_TOOL_SEARCH): defer the specialised long-tail
  // tool schemas so they aren't shipped every turn — the model pulls them on
  // demand. Owner business chat only; personal/trading keep their narrow sets.
  const toolsForModel: Anthropic.Messages.ToolUnion[] =
    TOOL_SEARCH_ENABLED && !personalMode && businessId !== 'ALMA_TRADING'
      ? applyToolSearchDeferral(gatedTools)
      : gatedTools

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
          tools: toolsForModel,
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
          const ledger: ToolLedgerEntry[] = toolRecords.map((r) => ({
            toolName: r.toolName,
            success: r.status === 'success',
            error: r.error ?? undefined,
          }))
          const violations: ClaimViolation[] = finalText
            ? verifyClaimsAgainstLedger(finalText, ledger)
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

        // Wrong-refusal detection: agent said "can't" but relevant tool group wasn't loaded
        if (!signal?.aborted && !personalMode && lastUserText) {
          const finalTextForRefusal = currentBlocks
            .filter((b): b is Extract<CollectedBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
          const REFUSAL_RE = /পারব\s*না|পারি\s*না|পারছি\s*না|parbo\s*na|pari\s*na|সেই\s*সুবিধা\s*নেই|available\s*নেই|এটা\s*করতে\s*পারি?\s*না/i
          if (REFUSAL_RE.test(finalTextForRefusal)) {
            const { groups: loadedGroups } = selectToolGroupsSync(lastUserText, { personalMode, businessId })
            if (loadedGroups.length <= 3 && loadedGroups.every(g => g === 'base' || g === 'erp' || g === 'staff')) {
              void logRefusalEvent({ conversationId, businessId })
            }
          }
        }

        break
      }

      messages = [
        ...messages,
        { role: 'assistant', content: currentBlocks as unknown as Anthropic.Messages.ContentBlockParam[] },
      ]

      // ── Parallel read / sequential write tool execution ──────────────
      type ToolBlock = Extract<CollectedBlock, { type: 'tool_use' }>
      type ToolExecResult = {
        tb: ToolBlock
        result: { success: boolean; data?: unknown; error?: string }
        durationMs: number
      }

      const execOneTool = async (tb: ToolBlock): Promise<ToolExecResult> => {
        const started = Date.now()
        const result = personalMode
          ? await executePersonalTool(tb.name, tb.input, { conversationId, businessId })
          : await executeTool(tb.name, tb.input, { conversationId, businessId, modelId: chatModel.id })
        return { tb, result, durationMs: Date.now() - started }
      }

      const reads: ToolBlock[] = []
      const writes: ToolBlock[] = []
      for (const tb of toolUseBlocks) {
        // Emit pre-execution events
        const isDelegate = tb.name === 'delegate_to_specialist'
        if (isDelegate) {
          const role = String((tb.input as Record<string, unknown>).role ?? '')
          const task = String((tb.input as Record<string, unknown>).task ?? '')
          yield { type: 'subagent_start', id: tb.id, role, roleLabel: specialistLabel(role), task }
        } else {
          // Re-emit with the parsed input (now known) so the UI can show the
          // real target — e.g. "order #1234", searching "winter jackets".
          yield { type: 'tool_start', id: tb.id, name: tb.name, input: tb.input }
        }

        if (MUTATING_TOOLS.has(tb.name)) {
          writes.push(tb)
        } else {
          reads.push(tb)
        }
      }

      // Execute reads in parallel, writes sequentially after
      const resultMap = new Map<string, ToolExecResult>()

      if (reads.length > 1) {
        const readResults = await Promise.all(reads.map(execOneTool))
        for (const r of readResults) resultMap.set(r.tb.id, r)
      } else if (reads.length === 1) {
        const r = await execOneTool(reads[0])
        resultMap.set(r.tb.id, r)
      }

      for (const tb of writes) {
        const r = await execOneTool(tb)
        resultMap.set(r.tb.id, r)
      }

      // Emit events and build toolResultContent in ORIGINAL order
      const toolResultContent: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
        const exec = resultMap.get(tb.id)!
        const { result, durationMs } = exec

        const isDelegate = tb.name === 'delegate_to_specialist'

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
          content: JSON.stringify(annotateEmptyResult(result)),
        })
      }

      messages = [...messages, { role: 'user', content: toolResultContent }]
    }

    // Persist assistant message.
    // NOTE: the pending-approval reminder prefix is shown live (yielded as a
    // text_delta above) but intentionally NOT persisted into the stored message.
    // It is a transient, per-turn nudge regenerated each turn from current DB
    // state; baking it into history made every past assistant message carry a
    // stale reminder that was re-sent to the model every turn (token bloat).
    const textContent = assistantTurns.flat().filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    const joinedText = textContent.map((b) => b.text).join('\n')
    const storedContent = joinedText
      ? [{ type: 'text' as const, text: joinedText }]
      : [{ type: 'text' as const, text: '' }]
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

    yield {
      type: 'done',
      messageId: savedMsg.id,
      tokensIn: totalInputTokens,
      tokensOut: totalOutputTokens,
      cacheCreation: totalCacheCreationTokens,
      cacheRead: totalCacheReadTokens,
      costUsd,
    }
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

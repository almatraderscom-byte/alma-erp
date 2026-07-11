/**
 * Owner /agent chat dispatcher — ONLY entry point for per-session model selection.
 * Anthropic models delegate to runAgentTurn (native Claude path).
 * Other providers use normalized adapters with the same tool handlers + claim-verifier.
 */
import { prisma } from '@/lib/prisma'
import { MAX_TOOL_ITERATIONS, MARKETING_HEAD_TOOL_BUDGET } from '@/agent/config'
import { runAgentTurn, type AgentEvent, type RunAgentTurnOptions } from '@/agent/lib/core'
import { buildSystemPromptBlocks, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { getOfficePulse } from '@/agent/lib/office-pulse'
import { buildOwnerActiveTasksContextBlock, buildStaffActiveTasksContextBlock } from '@/agent/lib/owner-active-tasks-context'
import { applyTailCompaction } from '@/agent/lib/tail-compact'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectToolsAndGroupsForTurnAsync } from '@/agent/tools/select-tools'
import { getAgentControls, filterToolDefsByControls, controlsPromptNote } from '@/agent/lib/agent-controls'
import { executeTool, executePersonalTool } from '@/agent/tools/registry'
import { normalizeBusinessId, type AgentBusinessId } from '@/lib/agent-api/business-context'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { embedMessageInBackground, retrieveRelevantOldTurns } from '@/agent/lib/message-recall'
import { getBusinessSnapshot } from '@/agent/lib/business-snapshot'
import { annotateEmptyResult } from '@/agent/lib/tool-result-note'
import { toolResultPreview } from '@/agent/lib/tool-labels'
import { bumpPlaybookForTool, getActivePlaybook } from '@/agent/lib/playbook'
import { captureAgentError } from '@/agent/lib/sentry'
import { logCost } from '@/agent/lib/cost-events'
import { looksLikeDurableFact, MEMORY_SAVE_NUDGE } from '@/agent/lib/memory-fact-detect'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { isTurnCancelRequested } from '@/agent/lib/turn-status'
import {
  verifyClaimsAgainstLedger,
  buildVerificationReminder,
  MAX_VERIFY_RETRIES,
  type ToolLedgerEntry,
} from '@/agent/lib/claim-verifier'
import { getModel, isKnownModelId } from '@/agent/lib/models/registry'
import { resolveHeadModelId, loadStickyHeadModelId, type HeadTier } from '@/agent/lib/models/head-router'
import { specialistLabel } from '@/agent/lib/models/specialist-roles'
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
  /**
   * Owner already approved upgrading this turn to a premium model (Sonnet/Opus).
   * Set by the model-switch resume call — skips the approval gate.
   */
  approveModelSwitch?: boolean
}

/**
 * Owner-tunable kill switch for the model-upgrade approval gate. Default ON (the
 * owner asked for it). `cs`-style kv setting so it can be flipped without a deploy.
 */
async function modelSwitchGateEnabled(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({ where: { key: 'model_switch_gate' } })
    const v = (row?.value ?? '').trim().toLowerCase()
    return v !== 'off' && v !== 'false' && v !== '0'
  } catch {
    return true
  }
}

/** Per-conversation "always allow upgrades" — set when the owner taps "ask no more". */
async function conversationAutoApprovesUpgrade(conversationId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({
      where: { key: `model_switch_ok:${conversationId}` },
    })
    return Boolean(row?.value)
  } catch {
    return false
  }
}

function providerToCostProvider(provider: string): CostProvider {
  if (provider === 'google') return 'gemini'
  if (provider === 'openrouter') return 'openrouter'
  if (provider === 'openai') return 'openai'
  return 'anthropic'
}

// One-time message injected when the Qwen MARKETING head exhausts its (larger)
// tool-round budget. Marketing is Qwen's own specialty — it must NOT hand the job
// to a cheap DeepSeek worker. So it is told to wrap up and answer now with what it
// already gathered. No delegation: marketing quality stays on Qwen.
const MARKETING_HEAD_WRAPUP_NUDGE =
  'টুল ব্যবহারের বাজেট শেষ। এখন আর নতুন টুল কল কোরো না। ' +
  'হাতে যা তথ্য আছে তা দিয়েই মার্কেটিং কাজটা নিজে শেষ করো এবং সংক্ষেপে চূড়ান্ত উত্তর দাও। ' +
  'মার্কেটিং তোমার নিজের বিশেষত্ব — এটা অন্য কাউকে দিয়ো না।'

async function loadPinnedMemories(
  personalMode: boolean,
  businessId: AgentBusinessId,
): Promise<PinnedMemory[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<{ id: string; content: string; scope: string; metadata: unknown }> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).agentMemory.findMany({
        where: {
          ...(personalMode
            ? { pinned: true, scope: 'personal' }
            : { pinned: true, scope: { not: 'personal' } }),
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
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
  headTier?: HeadTier,
): AsyncGenerator<AgentEvent> {
  const model = getModel(modelId)
  const { projectSystemInstructions, personalMode = false, signal, turnId, telegramFastPath = false } = options
  const businessId: AgentBusinessId = personalMode
    ? 'ALMA_LIFESTYLE'
    : normalizeBusinessId(options.businessId)

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0

  const allRows = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  })

  // B3 tail compaction — the PRIMARY cost lever on this path. This used to run
  // only on the native Claude head (core.ts); the alternate path shipped the
  // FULL history every turn. That was ruinous for the OpenRouter heads: Qwen
  // (Alibaba) ignores our cache_control breakpoint, so cacheRead is always 0 and
  // the whole ~100k-token prefix was re-billed as uncached input on EVERY
  // message (~$0.14/turn on a "cheap" model). Fold the old turns into the
  // running summary and keep only the recent window. Row order is createdAt asc,
  // so dropOldest lines up with rows.slice(). Fail-open keeps everything.
  let tailSummary: string | undefined
  let rows = allRows
  try {
    const tail = await applyTailCompaction(conversationId)
    if (tail.dropOldest > 0) rows = allRows.slice(tail.dropOldest)
    if (tail.tailSummary) tailSummary = tail.tailSummary
  } catch (err) {
    console.warn('[run-owner-turn] tail compaction failed:', err instanceof Error ? err.message : String(err))
  }

  let messages: NeutralMsg[] = dbRowsToNeutral(rows)

  const recentUserTexts: string[] = []
  for (let i = messages.length - 1; i >= 0 && recentUserTexts.length < 12; i--) {
    const m = messages[i]
    if (m.role !== 'user' || !('content' in m)) continue
    if (typeof m.content === 'string' && m.content.trim()) recentUserTexts.unshift(m.content.trim())
  }
  const lastUserText = recentUserTexts[recentUserTexts.length - 1] ?? ''

  const now = new Date()
  // Salah conscience-nudge + nightly muhasaba must work on this cheap-head path too
  // (short salah replies like "porechi" can be triaged here, not only to the Claude head).
  let intakeContextBlock: string | undefined
  if (!personalMode) {
    const autoMark = await applySalahAutoMarkFromUserTexts(lastUserText ? [lastUserText] : [], now)
    if (autoMark.marked.length) {
      const fresh = autoMark.marked[autoMark.marked.length - 1]
      if (fresh.status === 'prayed_on_time' || fresh.status === 'prayed_late') {
        intakeContextBlock =
          `[SALAH CONFIRMED — CONSCIENCE NUDGE]\n` +
          `Boss just told you he prayed ${fresh.waqt} (${fresh.date}); it is ALREADY saved — do NOT call mark_salah for it. ` +
          `Reply in warm Bangla, addressing him ONLY as Boss (never Sir/স্যার — owner rule 2026-07-07): (1) a short Alhamdulillah / du'a that Allah accepts it, ` +
          `(2) then ONE gentle conscience question — ask softly whether he prayed in jamaat or alone ("জামাতে পড়লেন নাকি একা, Boss?"), ` +
          `framed with love and trust, never accusing. Keep it to 2 lines. This gentle question is intentional and owner-requested.`
      } else if (fresh.status === 'qaza' || fresh.status === 'missed') {
        intakeContextBlock =
          `[SALAH ${fresh.status.toUpperCase()} — HONESTY HONOURED]\n` +
          `Sir honestly told you ${fresh.waqt} (${fresh.date}) was ${fresh.status === 'qaza' ? 'prayed as qaza (made up late)' : 'missed'}; it is ALREADY saved — do NOT call mark_salah for it. ` +
          `Reply in warm Bangla as Sir: (1) sincerely thank/encourage him for telling the truth instead of a false "porechi", ` +
          `(2) absolutely NO blame, (3) gently encourage tawba and catching the next waqt on time in jamaat. Keep it to 2-3 lines.`
      }
    }
    if (!intakeContextBlock && lastUserText) {
      try {
        const { processMuhasabaReply } = await import('@/agent/lib/salah-muhasaba')
        const mh = await processMuhasabaReply(lastUserText, conversationId, now)
        if (mh?.contextBlock) intakeContextBlock = mh.contextBlock
      } catch (err) {
        console.warn('[run-owner-turn] salah muhasaba reply failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  const [pinnedMemories, relevantMemories, recalledTurns, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext, ownerActiveTasksBlock, staffActiveTasksBlock, toolSelection, businessSnapshot, officePulse] = await Promise.all([
    loadPinnedMemories(personalMode, businessId),
    lastUserText ? retrieveRelevantMemories(lastUserText, personalMode, businessId) : Promise.resolve([]),
    lastUserText ? retrieveRelevantOldTurns(conversationId, lastUserText) : Promise.resolve([]),
    personalMode ? Promise.resolve(null) : loadSalahAccountabilityContext(now, lastUserText),
    personalMode || telegramFastPath
      ? Promise.resolve([])
      : loadRecentOtherConversations(conversationId, 5),
    personalMode ? Promise.resolve([]) : getActivePlaybook(businessId),
    personalMode ? Promise.resolve([] as OutcomeLearning[]) : getRecentOutcomeLearnings({ limit: 5 }).catch(() => [] as OutcomeLearning[]),
    personalMode ? Promise.resolve([] as OwnerDecision[]) : loadOwnerDecisions(businessId),
    (personalMode || !lastUserText) ? Promise.resolve([]) : detectInstructionConflicts(lastUserText, businessId).catch(() => []),
    personalMode ? Promise.resolve('') : buildBusinessContext(businessId).catch(() => ''),
    personalMode ? Promise.resolve('') : buildOwnerActiveTasksContextBlock(businessId).catch(() => ''),
    personalMode ? Promise.resolve('') : buildStaffActiveTasksContextBlock(businessId).catch(() => ''),
    selectToolsAndGroupsForTurnAsync(lastUserText, { personalMode, businessId, headTier }),
    personalMode || businessId === 'ALMA_TRADING' ? Promise.resolve(null) : getBusinessSnapshot(),
    // LIVE office pulse (owner decision 2026-07-08) — shared rolling summary of
    // today's office/staff/agent-work state, delta-refreshed ≤10 min. Lets
    // office questions and autonomous wakes answer in ONE round instead of
    // paying tool round-trips that re-bill the whole context.
    personalMode || businessId === 'ALMA_TRADING'
      ? Promise.resolve(null)
      : getOfficePulse().catch(() => null),
  ])

  const promptArgs = {
    projectInstructions: projectSystemInstructions,
    pinnedMemories,
    relevantMemories,
    recalledTurns,
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
    intakeContextBlock,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
    ownerActiveTasksBlock: ownerActiveTasksBlock || undefined,
    staffActiveTasksBlock: staffActiveTasksBlock || undefined,
    activeGroups: toolSelection.groups,
    businessSnapshot,
    officePulse,
    headTier,
    tailSummary,
  }

  const { stable, volatile } = buildSystemPromptBlocks(promptArgs)
  // Volatile per-turn context goes INTO the current owner user turn, not the
  // system text — same rationale as the native Claude path (core.ts): a stable
  // system prefix is what prefix-caching (native + Gemini/OpenRouter implicit)
  // can actually reuse, and it keeps web/Telegram prefixes identical for a
  // conversation. The injection is transient (only the assistant reply is
  // persisted), so replayed history stays clean.
  let volatileText = systemBlocksToText(volatile)
  // P0 resume fast-path: unresolved checkpoints ride the same transient per-turn
  // injection — the head resumes stalled work from the exact step with ZERO
  // history re-reading (the note is self-contained by contract). Fail-open.
  try {
    const { listUnresolvedCheckpoints, buildCheckpointSystemNote } = await import('@/agent/lib/checkpoint')
    const cps = await listUnresolvedCheckpoints(conversationId)
    const note = buildCheckpointSystemNote(cps)
    if (note) volatileText = volatileText ? `${volatileText}\n\n${note}` : note
  } catch { /* fail-open — never block the turn */ }
  if (volatileText) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && 'content' in m && typeof m.content === 'string') {
        messages[i] = { role: 'user', content: `[Per-turn context]\n${volatileText}\n\n${m.content}` }
        break
      }
    }
  }
  // Owner Control Center: gate OFF-capability tools + add the "ask owner to
  // enable, don't improvise" note and autonomy preference. Fail-open.
  const agentControls = await getAgentControls()
  const controlsNote = controlsPromptNote(agentControls)
  const systemText = systemBlocksToText(stable) + (controlsNote ? `\n\n${controlsNote}` : '')
  const selectedTools = filterToolDefsByControls(
    toolSelection.tools,
    agentControls,
  )
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
  let delegationAwaiting = false
  let delegationRoleLabel = ''
  // Ask-user question cards emitted this turn — persisted as breadcrumbs in the
  // saved assistant message (mirrors the confirm-card pattern in core.ts) so the
  // card survives the message poll / page reload, not just the live SSE stream.
  const emittedAskCards: Array<{ type: 'ask_card'; askCardId: string; question: string; options: string[] }> = []
  // Accumulate the extended-thinking trace so it persists (in usage.reasoning) as a
  // "Thought for Ns" block instead of vanishing when the live stream ends. Stored in
  // usage metadata (display-only) so it survives reload on the cheap-head path too.
  let thinkingText = ''
  let thinkingStartedAt = 0
  let thinkingMs: number | undefined
  // Ordered, DISPLAY-ONLY activity timeline (reasoning ↔ tool, in execution order)
  // so the UI renders ONE unified Claude-style stream that survives reload. Stored
  // in usage.timeline; never replayed to the model, so it adds zero token cost.
  type TimelineEntry =
    | { t: 'think'; text: string }
    | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string }
  const timeline: TimelineEntry[] = []
  const compactTimelineInput = (input: unknown): unknown => {
    try {
      const json = JSON.stringify(input)
      if (json && json.length > 800) return { _truncated: `${json.slice(0, 800)}…` }
    } catch { return undefined }
    return input
  }

  // ── HARD tool-round budget (Qwen marketing head) ───────────────────────────
  // Only the EXPENSIVE Qwen marketing head is capped here — the cheap DeepSeek
  // light head is the worker itself, so it stays uncapped. Marketing is Qwen's
  // OWN specialty (FB + website), so it gets a LARGER budget and does NOT hand
  // off to DeepSeek. After MARKETING_HEAD_TOOL_BUDGET tool ROUNDS it may no longer
  // call any tools (iterationTools = []) — it must wrap up and answer itself.
  const isMarketingHead = headTier === 'marketing'
  let headToolRounds = 0
  let budgetNudgeSent = false
  let canceled = false

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (signal?.aborted) break
      // Owner hit Stop — cross-instance cancel flag (see core.ts for rationale).
      if (await isTurnCancelRequested(turnId)) { canceled = true; break }

      const calls: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }> = []
      const toolNames = new Map<string, string>()
      let iterationText = ''
      // Reasoning produced in THIS round only — one timeline segment before this
      // round's tool calls, keeping cross-round order faithful.
      let iterThinking = ''

      // Over budget → strip ALL tools so the marketing head physically cannot
      // spree more; it must finish the marketing job itself and answer now.
      // No delegate hand-off: marketing quality stays on Qwen, not DeepSeek.
      const overBudget = isMarketingHead && headToolRounds >= MARKETING_HEAD_TOOL_BUDGET
      const iterationTools = overBudget ? [] : neutralTools
      if (overBudget && !budgetNudgeSent) {
        budgetNudgeSent = true
        messages = [...messages, { role: 'user', content: MARKETING_HEAD_WRAPUP_NUDGE }]
      }

      for await (const ev of adapter.streamTurn({
        apiModel: model.apiModel,
        system: systemText,
        messages,
        tools: iterationTools,
        thinking: model.thinking,
        signal,
      })) {
        if (ev.type === 'text_delta') {
          if (thinkingText && thinkingMs == null && thinkingStartedAt) {
            thinkingMs = Date.now() - thinkingStartedAt
          }
          iterationText += ev.text
          finalText += ev.text
          yield { type: 'text_delta', delta: ev.text }
        } else if (ev.type === 'thinking_delta') {
          // Surface DeepSeek/Qwen reasoning as the same live "Thought for Ns" block
          // the native Claude head produces — the UI (AgentApp) already handles this.
          if (!thinkingStartedAt) thinkingStartedAt = Date.now()
          thinkingText += ev.text
          iterThinking += ev.text
          yield { type: 'thinking_delta', delta: ev.text }
        } else if (ev.type === 'tool_start') {
          toolNames.set(ev.id, ev.name)
          yield { type: 'tool_start', id: ev.id, name: ev.name }
        } else if (ev.type === 'tool_input') {
          calls.push({ id: ev.id, name: toolNames.get(ev.id) ?? '', input: ev.input, thoughtSignature: ev.thoughtSignature })
        } else if (ev.type === 'usage') {
          totalInputTokens += ev.inputTokens
          totalOutputTokens += ev.outputTokens
          totalCacheCreationTokens += ev.cacheWrite ?? 0
          totalCacheReadTokens += ev.cacheRead ?? 0
        }
      }

      // Record this round's reasoning as a timeline segment BEFORE its tool calls.
      if (iterThinking.trim()) timeline.push({ t: 'think', text: iterThinking.trim().slice(0, 4000) })

      if (calls.length === 0 || signal?.aborted) {
        if (!signal?.aborted && verifyRetries < MAX_VERIFY_RETRIES && iterationText.trim()) {
          // Build a ledger that carries each tool's success/error — not just its
          // name — so the verifier catches "done!" claims made after a tool that
          // actually FAILED (audit #6). The cheap-head path previously passed only
          // names, so a failed write still looked like a satisfied claim.
          const ledger: ToolLedgerEntry[] = toolRecords.map((r) => ({
            toolName: r.toolName,
            success: r.status === 'success',
            error: r.error ?? undefined,
          }))
          const violations = verifyClaimsAgainstLedger(iterationText.trim(), ledger)
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

      // This turn requested tools → count it against the head's tool-round budget.
      headToolRounds++

      const toolResults: Array<{ id: string; name: string; result: unknown }> = []
      for (const call of calls) {
        // Re-emit tool_start with the parsed input so the UI shows the real target.
        yield { type: 'tool_start', id: call.id, name: call.name, input: call.input }
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

        timeline.push({
          t: 'tool', name: call.name, ok: result.success,
          input: compactTimelineInput(call.input),
          result: toolResultPreview(result),
        })

        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          success: result.success,
          error: result.error,
          resultPreview: toolResultPreview(result),
        }

        if (result.success && !personalMode) {
          void bumpPlaybookForTool(call.name, businessId).catch(() => {})
        }

        if (result.success && result.data != null && typeof result.data === 'object') {
          const d = result.data as Record<string, unknown>
          // Delegation WAIT-gate: when a specialist hand-off is pending owner
          // approval, the head must STOP this turn (do not also write the answer
          // — that doubles cost). The confirm card decides Worker vs Sonnet.
          if (d.awaitingApproval === true && d.actionType === 'delegation') {
            delegationAwaiting = true
            const role = typeof call.input.role === 'string' ? call.input.role : ''
            delegationRoleLabel = role ? specialistLabel(role) : 'specialist'
          }
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
            // Breadcrumb so the question card re-renders after reload / poll (the
            // durable agent_ask_cards row supplies live status at read time).
            emittedAskCards.push({
              type: 'ask_card',
              askCardId: d.askCardId,
              question: typeof d.question === 'string' ? d.question : '',
              options: d.options.map(String),
            })
          }
        }

        toolResults.push({ id: call.id, name: call.name, result: annotateEmptyResult(result) })
      }

      messages = appendToolExchange(messages, calls, toolResults)

      // Delegation pending approval → end the head's turn now. The owner picks
      // Worker (cheap) or Sonnet (direct) on the card; we must not generate the
      // answer here or the cost doubles. Mirrors the native-path gate in core.ts.
      if (delegationAwaiting) {
        const waitNote = `🤝 কাজটা ${delegationRoleLabel}-কে দিচ্ছি। উপরের কার্ডে বেছে নিন — **Worker করুক** (সস্তা মডেল, কম খরচ) নাকি **Sonnet বলুক** (আমি নিজেই এখনই উত্তর দেব)। সিদ্ধান্ত পেলেই এগোব।`
        const sep = finalText ? '\n\n' : ''
        finalText += sep + waitNote
        yield { type: 'text_delta', delta: sep + waitNote }
        break
      }
    }

    // Owner canceled mid-turn: do not persist a partial reply or emit 'done'.
    if (canceled) return

    const costUsd = calcModelTurnCostUsd(model, {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheRead: totalCacheReadTokens,
      cacheWrite: totalCacheCreationTokens,
    })

    // Ask-card breadcrumbs are appended after the text block — same reload-survival
    // pattern as the confirm-card breadcrumbs on the native Claude path (core.ts).
    const storedContent: Array<Record<string, unknown>> = [
      { type: 'text', text: finalText },
      ...emittedAskCards,
    ]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const savedMsg = await db.agentMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: storedContent,
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        costUsd,
        // Persist the reasoning trace in usage metadata (display-only) so the
        // "Thought for Ns" block survives reload. The GET messages route surfaces
        // it as `thinking`/`thinkingMs`; history replay never sees it.
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens, model: model.id, apiModel: model.apiModel, provider: model.provider, reasoning: thinkingText.trim() ? thinkingText.trim().slice(0, 12000) : undefined, reasoningMs: thinkingMs ?? undefined, timeline: timeline.length > 0 ? timeline.slice(0, 60) : undefined },
      },
    })
    embedMessageInBackground(savedMsg.id, [{ type: 'text', text: finalText }])

    // Answer-Gate write path (owner decision 2026-07-08): a tool-free, card-free
    // answer from an EXPENSIVE head may be cacheable. All hard rules + a cheap
    // classifier confirm live in maybeCacheQaPair — fire-and-forget, never blocks.
    if (finalText.trim() && lastUserText) {
      void import('@/agent/lib/answer-gate')
        .then(({ maybeCacheQaPair }) =>
          maybeCacheQaPair({
            question: lastUserText,
            answer: finalText,
            scope: personalMode ? 'personal' : 'business',
            sourceModelId: model.id,
            usedTools: toolRecords.length > 0,
            // Confirm cards are always staged BY a tool call, so usedTools already
            // covers them; ask-cards are the only card type reachable tool-free.
            hadCards: emittedAskCards.length > 0,
            conversationId,
          }),
        )
        .catch(() => {})
    }

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

    yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, cacheCreation: totalCacheCreationTokens, cacheRead: totalCacheReadTokens, costUsd }
  } catch (err) {
    if (signal?.aborted) return
    // Rule 3 — head fallback: if a non-cheap head (e.g. Qwen) crashes BEFORE
    // producing any answer text, retry once on the cheap head (DeepSeek) instead of
    // surfacing an error — a surfaced error makes the owner's NEXT message triage UP
    // to Sonnet (the expensive rescue that spiked cost). Guards: only when no answer
    // was streamed yet, and not already on the cheap head (prevents recursion loop).
    const cheapId = process.env.CHEAP_HEAD_MODEL_ID?.trim() || 'or-deepseek-v4-flash'
    if (!finalText.trim() && model.id !== cheapId && isKnownModelId(cheapId)) {
      const cheap = getModel(cheapId)
      if (cheap.provider !== 'anthropic' && cheap.supportsTools) {
        console.warn(
          `[run-owner-turn] head ${model.id} failed pre-answer → falling back to ${cheapId}:`,
          err instanceof Error ? err.message : err,
        )
        // Persist the REAL head error before we swallow it into the fallback —
        // otherwise the only trace is this console.warn in runtime logs, and the
        // final cost event shows DeepSeek, hiding that Gemini threw. Diagnosing
        // multi-round head failures (e.g. Gemini thought-signature 400s) needs the
        // actual message in Sentry/agent errors, not just "answer served by cheap".
        await captureAgentError(err, 'agent.head.fallback', { conversationId, modelId: model.id })
        yield {
          type: 'model_info',
          modelId: cheap.id,
          label: cheap.label,
          variant: modelVariant(cheap),
          tier: 'light',
        }
        yield* runAlternateProviderTurn(conversationId, cheapId, options, 'light')
        return
      }
    }
    await captureAgentError(err, 'agent.provider.error', { conversationId })
    const msg = err instanceof Error ? err.message : String(err)
    yield { type: 'error', message: `Model error (${model.label}): ${msg}` }
  }
}

/** Last owner (user) message text for this conversation — needed to triage the head. */
async function loadLastUserTextForTriage(conversationId: string): Promise<string> {
  try {
    const row = await prisma.agentMessage.findFirst({
      where: { conversationId, role: 'user' },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    })
    if (!row) return ''
    const c = row.content as unknown
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) {
      return c
        .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
        .join(' ')
        .trim()
    }
    return ''
  } catch {
    return ''
  }
}

/** Map a registry model to the loading-animation identity shown in the UI. */
function modelVariant(model: ReturnType<typeof getModel>): 'claude' | 'qwen' | 'deepseek' | 'default' {
  if (model.provider === 'anthropic') return 'claude'
  const id = `${model.id} ${model.apiModel}`.toLowerCase()
  if (id.includes('deepseek')) return 'deepseek'
  if (id.includes('qwen')) return 'qwen'
  return 'default'
}

export async function* runOwnerTurn(
  conversationId: string,
  options: RunOwnerTurnOptions = {},
): AsyncGenerator<AgentEvent> {
  // Cheap triage head: decide per-turn whether a routine message can be handled
  // by a cheap model (DeepSeek) instead of Sonnet. Fails safe to Sonnet.
  const personalMode = options.personalMode ?? false
  const businessId: AgentBusinessId = personalMode
    ? 'ALMA_LIFESTYLE'
    : normalizeBusinessId(options.businessId)
  const lastUserText = await loadLastUserTextForTriage(conversationId)
  const decision = await resolveHeadModelId({
    requestedModelId: options.modelId,
    lastUserText,
    personalMode,
    businessId,
    conversationId,
  })

  // Owner's Monitor kill-switch per model: a model toggled OFF is unusable even
  // when this chat has it pinned — swap to the enabled fallback IN this same
  // session and tell the owner why in one visible line (never a silent switch,
  // never a manual re-pick).
  let disabledSwitchNote: string | null = null
  try {
    const { resolveEnabledFallback } = await import('@/agent/lib/models/model-enabled')
    const fallbackId = await resolveEnabledFallback(decision.modelId)
    if (fallbackId) {
      const offModel = getModel(decision.modelId)
      const onModel = getModel(fallbackId)
      disabledSwitchNote = `⚙️ Sir, **${offModel.label}** Monitor-এ OFF করা আছে — এই মেসেজটা **${onModel.label}** দিয়ে চালাচ্ছি।\n\n`
      decision.modelId = fallbackId
      decision.via = `${decision.via}+disabled_fallback`
    }
  } catch { /* fail-open: enabled-map glitch must never block the turn */ }

  const model = getModel(decision.modelId)

  // ── Answer Gate (owner decision 2026-07-08): EXPENSIVE heads only ──────────
  // Before paying a Gemini/Opus-class turn (~60k input), check the verified Q&A
  // cache. Hard rules live in answer-gate.ts (deny-list, standalone-question,
  // sim ≥ 0.95, TTL) — any doubt falls through to the normal agent. Cheap heads
  // (DeepSeek-class) and explicit owner pins bypass entirely; a miss costs one
  // embedding (~$0.000002).
  if (!options.approveModelSwitch && decision.tier !== 'explicit' && lastUserText) {
    try {
      const { ANSWER_GATE_ENABLED, isExpensiveHead, tryAnswerGate, recordGateServe } = await import('@/agent/lib/answer-gate')
      if (ANSWER_GATE_ENABLED && isExpensiveHead(model)) {
        const hit = await tryAnswerGate(lastUserText, personalMode ? 'personal' : 'business')
        if (hit) {
          const savedDate = new Date(hit.verifiedAt ?? hit.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
          const answerText = `${hit.answer}\n\n💾 _সেভ করা verified উত্তর (${savedDate}) — নতুন করে যাচাই চাইলে বলুন "fresh করে দেখো"।_`
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = prisma as any
          const savedMsg = await db.agentMessage.create({
            data: {
              conversationId,
              role: 'assistant',
              content: [{ type: 'text', text: answerText }],
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
              usage: { input_tokens: 0, output_tokens: 0, model: 'answer-gate', provider: 'gate', similarity: hit.similarity, qaId: hit.id },
            },
          })
          await touchConversationActivity(conversationId)
          void recordGateServe(hit, conversationId)
          yield { type: 'text_delta', delta: answerText }
          yield { type: 'done', messageId: savedMsg.id, tokensIn: 0, tokensOut: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 }
          return
        }
      }
    } catch (err) {
      // Gate problems must NEVER block a turn — fall through to the real head.
      console.warn('[run-owner-turn] answer gate failed open:', err instanceof Error ? err.message : err)
    }
  }

  // ── Model-upgrade approval gate ───────────────────────────────────────────
  // The owner asked to APPROVE before a thread jumps UP to a premium model
  // (Sonnet/Opus). Only fires on an AUTO upgrade: the thread was previously on a
  // cheap head (DeepSeek/Qwen) and the router now wants a premium Anthropic model.
  // Explicit owner picks ('explicit'), first-turns (no prior head), and turns that
  // were already cheap are untouched. The owner can turn it off (model_switch_gate
  // = off) or silence it per-conversation ("ask no more").
  const isPremiumUpgradeCandidate =
    model.provider === 'anthropic' && decision.via !== 'explicit' && !options.approveModelSwitch
  if (isPremiumUpgradeCandidate && (await modelSwitchGateEnabled())) {
    const stickyId = await loadStickyHeadModelId(conversationId)
    const prev = stickyId && isKnownModelId(stickyId) ? getModel(stickyId) : null
    const wasCheapHead = Boolean(prev && prev.provider !== 'anthropic')
    if (wasCheapHead && prev && !(await conversationAutoApprovesUpgrade(conversationId))) {
      yield {
        type: 'model_switch_required',
        conversationId,
        toModelId: model.id,
        toLabel: model.label,
        fromModelId: prev.id,
        fromLabel: prev.label,
        // If the owner declines, answer on the thread's current cheap head instead.
        fallbackModelId: prev.id,
      }
      return
    }
  }

  // Tell the UI which model is answering so it can show the matching loading
  // animation + label ("🧠 Sonnet ভাবছে" / "⚡ DeepSeek উত্তর দিচ্ছে").
  yield {
    type: 'model_info',
    modelId: model.id,
    label: model.label,
    variant: modelVariant(model),
    tier: decision.tier,
  }

  if (disabledSwitchNote) {
    yield { type: 'text_delta', delta: disabledSwitchNote }
  }

  if (model.provider === 'anthropic') {
    yield* runAgentTurn(conversationId, {
      ...options,
      modelId: model.id,
    })
    return
  }

  yield* runAlternateProviderTurn(conversationId, model.id, options, decision.tier)
}

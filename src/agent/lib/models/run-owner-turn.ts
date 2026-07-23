/**
 * Owner /agent chat dispatcher — ONLY entry point for per-session model selection.
 * Anthropic models delegate to runAgentTurn (native Claude path).
 * Other providers use normalized adapters with the same tool handlers + claim-verifier.
 */
import { prisma } from '@/lib/prisma'
import { MAX_TOOL_ITERATIONS, BROWSER_TURN_MAX_ITERATIONS, MARKETING_HEAD_TOOL_BUDGET, HEAD_TOOL_BUDGET, AGENT_CONSTITUTION, CONSTITUTION_REINJECT_EVERY, AGENT_STYLE } from '@/agent/config'
import { computeHeadToolCap } from '@/agent/lib/models/head-tool-cap'
import { runAgentTurn, type AgentEvent, type RunAgentTurnOptions } from '@/agent/lib/core'
import { buildSystemPromptBlocks, CONSTITUTION_REMINDER, STYLE_REMINDER, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { buildActiveSkillsBlock } from '@/agent/lib/skill-engine/runtime'
import { getOfficePulse } from '@/agent/lib/office-pulse'
import { buildOwnerActiveTasksContextBlock, buildStaffActiveTasksContextBlock } from '@/agent/lib/owner-active-tasks-context'
import { applyTailCompaction } from '@/agent/lib/tail-compact'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { detectOutboundCallIntent, buildOutboundCallIntakeBlock } from '@/agent/lib/outbound-call-intent'
import { buildReminderTimeHintBlock } from '@/agent/lib/bangla-time'
import { detectVoiceProviderRequest } from '@/agent/lib/voice-provider-intent'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectOwnerHeadTools, packsForPendingActionType, isContinuationText, matchIntentPacks } from '@/agent/tools/state-router'
import { workflowToolBinding } from '@/agent/lib/workflow-templates'
import {
  reconcileConversationWorkflows,
  buildWorkflowSnapshotNote,
  ensureWorkflowRunForPendingAction,
  listActiveWorkflowRuns,
  transitionWorkflowRun,
  WorkflowVersionConflictError,
  type WorkflowRunView,
} from '@/agent/lib/workflow-run'
import { getAgentControls, filterToolDefsByControls, controlsPromptNote } from '@/agent/lib/agent-controls'
import { executeTool, executePersonalTool } from '@/agent/tools/registry'
import { enforcementEnabled, guardToolCall, stageEnforcedToolApproval } from '@/agent/enforcement/enforced-tool-runner'
import { runPreToolHooks, runPostToolHooks } from '@/agent/lib/turn-hooks'
import { applyOwnerHookRules } from '@/agent/lib/hook-rules'
import { buildSelfCorrectionNudge } from '@/agent/lib/self-correct'
import { FIND_TOOL_NAME, resolveToolsByName, MAX_DYNAMIC_TOOLS_PER_TURN } from '@/agent/tools/find-tool'
import { filterToolsForOwnerIntent, validateToolCallAgainstOwnerIntent } from '@/agent/lib/owner-intent-contract'
import { normalizeBusinessId, type AgentBusinessId } from '@/lib/agent-api/business-context'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { embedMessageInBackground, retrieveRelevantOldTurns } from '@/agent/lib/message-recall'
import { getBusinessSnapshot } from '@/agent/lib/business-snapshot'
import { annotateEmptyResult } from '@/agent/lib/tool-result-note'
import { toolResultPreview, extractScreenshotUrl } from '@/agent/lib/tool-labels'
import { bumpPlaybookForTool, getActivePlaybook } from '@/agent/lib/playbook'
import { captureAgentError } from '@/agent/lib/sentry'
import { logCost } from '@/agent/lib/cost-events'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { isTurnCancelRequested } from '@/agent/lib/turn-status'
import { claimTurnSteeringMessages } from '@/agent/lib/turn-steering'
import { shouldAutoContinueTurn } from '@/agent/lib/continuation-policy'
import {
  shouldNudgeAdapterIntent,
  shouldRestartHeadAfterFailure,
} from '@/agent/lib/turn-loop-policy'
import {
  deriveOwnerTurnAuthorization,
  filterToolsForOwnerTurn,
  ownerTurnAuthorizationNote,
} from '@/agent/lib/turn-authorization'
import {
  verifyClaimsAgainstLedger,
  buildVerificationReminder,
  detectExplicitInstructionViolations,
  detectMissingCardViolation,
  detectProseChoiceViolation,
  detectFabricatedStatViolations,
  detectRoboticStyleViolations,
  MAX_VERIFY_RETRIES,
  type ToolLedgerEntry,
} from '@/agent/lib/claim-verifier'
import { getModel, isKnownModelId } from '@/agent/lib/models/registry'
import { resolveHeadModelId, loadStickyHeadModelId, type HeadTier } from '@/agent/lib/models/head-router'
import { buildModelIdentityNote, loadPreviousTurnModelId } from '@/agent/lib/models/turn-identity'
import { specialistLabel, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import { AUTO_RUN_ROLES } from '@/agent/tools/orchestrator-tools'
import { adapterFor } from '@/agent/lib/models/adapters'
import { logRouteSpan } from '@/agent/lib/tool-telemetry'
import { AGENT_VERSIONS } from '@/agent/lib/agent-versions'
import { isRoutineGraphEnabled, runRoutineTurnGraph, type RoutineGraphResult } from '@/agent/lib/graph/routine-turn-graph'
import { isActionGraphEnabled, stageExpenseActionGraph, type StageExpenseResult } from '@/agent/lib/graph/action-turn-graph'
import { runTurnGraphShadow } from '@/agent/lib/graph/turn-graph-shadow'
import { resolveConversationContinuity } from '@/agent/lib/continuity-resolver'
import { buildOwnerRequirementNote, deriveOwnerTurnRequirements } from '@/agent/lib/owner-turn-requirements'
import { contractToolFailureText, findContractToolFailure } from '@/agent/lib/contract-tool-failure'
import {
  clientSeoBatchProgressText,
  ensureClientSeoBatchWorkflow,
  getClientSeoBatchRequiredTool,
  getClientSeoBatchStatus,
} from '@/agent/lib/client-seo-batch'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { roundUsd } from '@/agent/lib/pricing'
import {
  anthropicToolsToNeutral,
  appendToolExchange,
  dbRowsToNeutral,
  systemBlocksToText,
} from '@/agent/lib/models/neutral'
import type { NeutralMsg, NeutralTool } from '@/agent/lib/models/types'
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
  // xAI direct is OpenAI-compatible and priced from the same registry rates —
  // tag its spend under 'openai' (CostProvider has no xai bucket; adding one
  // would ripple through the cost dashboards for no accounting gain).
  if (provider === 'openai' || provider === 'xai') return 'openai'
  return 'anthropic'
}

// One-time message injected when the Qwen MARKETING head exhausts its (larger)
// tool-round budget. Marketing is Qwen's own specialty — it must NOT hand the job
// to a cheap DeepSeek worker. So it is told to wrap up and answer now with what it
// already gathered. No delegation: marketing quality stays on Qwen.
// After staging an approval card, the head must WAIT — the owner watched it
// (2026-07-16 late) chain save_memory sprees and more tools BELOW its own
// pending card, burning tokens on work that may be rejected. One card ⇒ the
// decision is now the owner's; the turn wraps in one line and stops.
const CARD_STAGED_WRAPUP_NUDGE =
  'অনুমোদন কার্ড এখন Boss-এর সামনে। এই টার্নে আর কোনো টুল কল বা নতুন কাজ নয় — ' +
  'এক লাইনে জানাও যে অনুমোদনের অপেক্ষায় আছ, তারপর থামো। ' +
  'Boss সিদ্ধান্ত দিলে পরের টার্নে বাকিটা হবে।'

const MARKETING_HEAD_WRAPUP_NUDGE =
  'টুল ব্যবহারের বাজেট শেষ। এখন আর নতুন টুল কল কোরো না। ' +
  'হাতে যা তথ্য আছে তা দিয়েই মার্কেটিং কাজটা নিজে শেষ করো এবং সংক্ষেপে চূড়ান্ত উত্তর দাও। ' +
  'মার্কেটিং তোমার নিজের বিশেষত্ব — এটা অন্য কাউকে দিয়ো না।'

// ── Announced-intent-but-no-action (adapter heads) ───────────────────────────
// Flash-tier heads (Gemini Flash, DeepSeek…) constantly END a turn mid-task by
// ANNOUNCING the next step ("এখন Manual destination সিলেক্ট করা হবে…") without
// doing it — the owner had to say "continue" after every round (2026-07-12
// Ads Manager incident). core.ts has this net only for zero-tool Claude turns;
// here we check the TAIL of the final text so a turn that already ran tools but
// signs off with a future promise gets pushed to actually act. Bounded once.
const ADAPTER_ACT_NOW_NUDGE =
  'তুমি বললে পরের ধাপটা করবে, কিন্তু না করেই টার্ন শেষ করে দিয়েছ। ঘোষণা নয় — কাজ। ' +
  'এখনই, এই একই টার্নে, যে ধাপটার কথা বললে সেটা live_browser_act/দরকারি টুল দিয়ে আসলে করো, ' +
  'তারপর ফলাফল নিজের চোখে দেখে Boss-কে জানাও। Boss-কে যেন আবার তাগাদা দিতে না হয়।'

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

// Injected at the FRONT of a listen-mode turn (router tier 'personal'). It reframes
// the turn as pure emotional support and explicitly cancels the system prompt's
// "always act / never just announce / finish the task" pressure for this one message.
const LISTEN_MODE_NOTE =
  '[LISTEN MODE — Boss তার নিজের মনের কথা / ব্যক্তিগত অনুভূতি শেয়ার করছেন, এটা কোনো কাজের নির্দেশ নয়।]\n' +
  'এই টার্নে তোমার একমাত্র কাজ: মন দিয়ে শোনা আর সত্যিকারের সহানুভূতি দেখানো — যেন একজন কাছের বন্ধু।\n' +
  '- আগে তার অনুভূতিটা কোমলভাবে স্বীকার করো ("বুঝতে পারছি", "খারাপ লাগছে শুনে")। ঠিক করার তাড়া নয়, আগে শোনো।\n' +
  '- ব্যবসা / অর্ডার / মার্কেটিং / ছবি / অ্যাড / স্টাফ / todo / কোনো কাজের কথা এই মেসেজে একদম তুলবে না।\n' +
  '- কোনো tool চালাবে না, কোনো কাজ resume করবে না, তাকে কিছু করতে বলবে না, "Chrome খুলুন" জাতীয় তাগাদা নয়।\n' +
  '- "একই টার্নে action করো / শুধু ঘোষণা নয় / কাজ শেষ করো / proactive হও" — এই সব নিয়ম এই মেসেজের জন্য প্রযোজ্য নয়; এখানে কোনো task নেই।\n' +
  '- ছোট, আন্তরিক, উষ্ণ বাংলায় উত্তর দাও। সম্বোধন শুধু "Boss" (কখনো Sir/স্যার নয়)। চাইলে আলতো করে জিজ্ঞেস করো কী হয়েছে — শুধু শুনতে চাও।\n' +
  'পরে Boss স্পষ্টভাবে কোনো কাজ চাইলে তখন স্বাভাবিক কাজের mode-এ ফিরে যেও।'

async function* runAlternateProviderTurn(
  conversationId: string,
  modelId: string,
  options: RunOwnerTurnOptions,
  headTier?: HeadTier,
  /** Phase 3: same-model retry counter for owner-PINNED heads (never recurses past 1). */
  sameModelAttempt = 0,
  /** LG-4 shadow: the live HeadDecision's `via` — scored against the shadow graph. */
  headVia = 'unknown',
): AsyncGenerator<AgentEvent> {
  const model = getModel(modelId)
  const { projectSystemInstructions, personalMode = false, signal, turnId, telegramFastPath = false, deadlineAt = null } = options
  const businessId: AgentBusinessId = personalMode
    ? 'ALMA_LIFESTYLE'
    : normalizeBusinessId(options.businessId)

  // LISTEN MODE — the owner just shared his OWN feelings in a work chat (router
  // tier 'personal'). Deterministically withhold ALL business tools + work-pull
  // context and inject an empathy override, so the head listens instead of running
  // generate_image/ads/todos (the 2026-07-14 incident). Prompt rules alone don't
  // hold the cheap heads back — withholding the tools does.
  const listenMode = headTier === 'personal'
  // Suppress the work-pulling context blocks on a listen turn exactly like the
  // personal project already does — reusing the same gates keeps behaviour proven.
  const suppressWork = personalMode || listenMode

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0
  // OpenRouter's ACTUAL billed cost, summed across every tool-loop turn. Stays
  // null for providers that don't report it (native Gemini/Anthropic) — those
  // keep the local token×rate estimate, which is accurate since we control the
  // exact model+rate. When non-null it overrides the estimate so the per-message
  // cost matches the OpenRouter dashboard.
  let totalActualCostUsd: number | null = null
  // One reply = several provider API calls (one per tool round), which appear as
  // SEPARATE rows on the OpenRouter Logs page. Count the rounds and keep each
  // round's billed cost so the badge can show "$0.0787 · ৫ ধাপ" with a per-step
  // breakdown — reconciling one-badge-vs-many-dashboard-rows at a glance
  // (owner ask 2026-07-14).
  let apiRounds = 0
  const roundCostsUsd: number[] = []

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

  // Durable ask-card answers — joined into the history notes so every question
  // card in context carries its options AND the owner's exact recorded choice
  // (misbinding guard, owner bug 2026-07-12). Fail-open to plain notes.
  let askAnswers: Map<string, { status: string; selectedOption: string | null }> | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const askRows: Array<{ id: string; status: string; selectedOption: string | null }> =
      await (prisma as any).agentAskCard.findMany({
        where: { conversationId },
        select: { id: true, status: true, selectedOption: true },
      })
    askAnswers = new Map(askRows.map((r) => [r.id, { status: r.status, selectedOption: r.selectedOption }]))
  } catch { /* fail-open */ }

  let messages: NeutralMsg[] = dbRowsToNeutral(rows, askAnswers)

  const recentUserTexts: string[] = []
  for (let i = messages.length - 1; i >= 0 && recentUserTexts.length < 12; i--) {
    const m = messages[i]
    if (m.role !== 'user' || !('content' in m)) continue
    if (typeof m.content === 'string' && m.content.trim()) recentUserTexts.unshift(m.content.trim())
  }
  const lastUserText = recentUserTexts[recentUserTexts.length - 1] ?? ''
  let currentOwnerInstructions = lastUserText
  let turnAuthorization = deriveOwnerTurnAuthorization(lastUserText)
  const ownerRequirements = deriveOwnerTurnRequirements(lastUserText)
  // Harness round 2 — refresh the owner's kv-configured hook rules (block/notify)
  // for this turn. Fail-open inside; a broken rules JSON registers nothing.
  await applyOwnerHookRules()
  // Which call voice Boss asked for — resolved from his OWN words and handed to the
  // call tool through server context (server wins over model args). Scans the last 3
  // messages because the call flow is routinely split ("ElevenLabs ভয়েসে…" → number).
  const ownerVoicePref = detectVoiceProviderRequest(recentUserTexts.slice(-3))

  const now = new Date()
  // Salah conscience-nudge + nightly muhasaba must work on this cheap-head path too
  // (short salah replies like "porechi" can be triaged here, not only to the Claude head).
  let intakeContextBlock: string | undefined
  if (!suppressWork) {
    const autoMark = await applySalahAutoMarkFromUserTexts(lastUserText ? [lastUserText] : [], now)
    if (autoMark.marked.length) {
      const fresh = autoMark.marked[autoMark.marked.length - 1]
      if (fresh.status === 'prayed_on_time' || fresh.status === 'prayed_late') {
        intakeContextBlock =
          `[SALAH CONFIRMED — CONSCIENCE NUDGE]\n` +
          `Boss just told you he prayed ${fresh.waqt} (${fresh.date}); it is ALREADY saved — do NOT call mark_salah for it. ` +
          `Reply in warm Bangla, addressing him ONLY as Boss (never Boss/বস — owner rule 2026-07-07): (1) a short Alhamdulillah / du'a that Allah accepts it, ` +
          `(2) then ONE gentle conscience question — ask softly whether he prayed in jamaat or alone ("জামাতে পড়লেন নাকি একা, Boss?"), ` +
          `framed with love and trust, never accusing. Keep it to 2 lines. This gentle question is intentional and owner-requested.`
      } else if (fresh.status === 'qaza' || fresh.status === 'missed') {
        intakeContextBlock =
          `[SALAH ${fresh.status.toUpperCase()} — HONESTY HONOURED]\n` +
          `Boss honestly told you ${fresh.waqt} (${fresh.date}) was ${fresh.status === 'qaza' ? 'prayed as qaza (made up late)' : 'missed'}; it is ALREADY saved — do NOT call mark_salah for it. ` +
          `Reply in warm Bangla as Boss: (1) sincerely thank/encourage him for telling the truth instead of a false "porechi", ` +
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
    // Outbound-call directive (parity with core.ts): "oi nambare call kore bolo…"
    // must route to the right call tool — never a reminder/todo. This path is the
    // one production actually runs (Gemini head), so the directive must live here too.
    if (!intakeContextBlock && lastUserText) {
      const callIntent = detectOutboundCallIntent(lastUserText)
      if (callIntent.isCall) {
        intakeContextBlock = buildOutboundCallIntakeBlock(callIntent.hasNumber, callIntent.mode)
      }
    }
  }

  // Reminder-to-Boss with a spoken time ("amake 4 tay call dio", "বিকাল ৫টায় মনে
  // করিয়ে দিও"): resolve the time DETERMINISTICALLY so the head never misreads
  // "4 tay" as "4 calls" (live-hit 2026-07-17 — happened on THIS path in personal
  // mode, which suppressWork skips, so this step runs for personal turns too).
  if (!listenMode && !intakeContextBlock && lastUserText) {
    try {
      const hint = buildReminderTimeHintBlock(lastUserText)
      if (hint) intakeContextBlock = hint
    } catch (err) {
      console.warn('[run-owner-turn] reminder time hint failed:', err instanceof Error ? err.message : err)
    }
  }

  // Phase 4 — resolve the CANONICAL workflow state BEFORE model routing:
  // reconcile every non-terminal run against its pending action's real status
  // (approvals executed via the per-type route branches close their runs here),
  // then hand the surviving runs to the router + the snapshot note below.
  // Fail-open: workflow bookkeeping must never block a turn.
  let workflowRuns: WorkflowRunView[] = []
  if (!suppressWork) {
    try {
      if (turnAuthorization.allowMutations && ownerRequirements.clientSeo) {
        await ensureClientSeoBatchWorkflow({
          conversationId,
          businessId,
          ownerText: lastUserText,
          requirements: ownerRequirements,
        })
      }
      workflowRuns = await reconcileConversationWorkflows(conversationId)
    } catch (err) {
      console.warn('[run-owner-turn] workflow reconcile failed open:', err instanceof Error ? err.message : err)
    }
  }

  // Ask-card answer matching — MOVED BEFORE routing (Phase 5): when the owner's
  // message is the tapped option of a recent ask card, we must know it now, so
  // (a) a card bound to a workflow run advances the template step BEFORE tool
  // selection (else the turn Boss confirms the image still can't see the post
  // tool), and (b) the answer-anchoring note below reuses the same match.
  // Match by OPTION TEXT across recent cards, never "latest answered by
  // createdAt" (2026-07-12: the head bound the reply to the wrong question).
  type MatchedAskCard = { id: string; question: string; status: string; selectedOption: string | null; options: unknown; workflowRunId?: string | null }
  let matchedAskCard: MatchedAskCard | undefined
  // AGENT-IOS-001 (client side): an option tap ships the tapped card's id as an
  // `ask_card_ref` marker block on the user message row — bind to that EXACT card
  // first, no text-match guessing (two recent cards can share an option like "হ্যাঁ").
  let explicitAskCardId: string | null = null
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as { role?: string; content?: unknown }
    if (r.role !== 'user') continue
    if (Array.isArray(r.content)) {
      const ref = (r.content as Array<{ type?: string; askCardId?: unknown }>)
        .find((b) => b?.type === 'ask_card_ref' && typeof b.askCardId === 'string')
      explicitAskCardId = (ref?.askCardId as string | undefined) ?? null
    }
    break
  }
  if (!suppressWork && !listenMode && lastUserText) {
    try {
      if (explicitAskCardId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const exact: (MatchedAskCard & { conversationId?: string }) | null =
          await (prisma as any).agentAskCard.findUnique({
            where: { id: explicitAskCardId },
            select: { id: true, question: true, status: true, selectedOption: true, options: true, workflowRunId: true, conversationId: true },
          })
        if (exact && exact.conversationId === conversationId) {
          if (!exact.selectedOption) {
            // The answer-endpoint write raced/failed — record the tapped answer
            // ourselves so the durable row and the anchoring note agree.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (prisma as any).agentAskCard.update({
              where: { id: exact.id },
              data: { status: 'answered', selectedOption: lastUserText.slice(0, 500) },
            }).catch(() => {})
            exact.status = 'answered'
            exact.selectedOption = lastUserText.slice(0, 500)
          }
          matchedAskCard = exact
        }
      }
      const recentCards: MatchedAskCard[] = matchedAskCard
        ? []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : await (prisma as any).agentAskCard.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, question: true, status: true, selectedOption: true, options: true, workflowRunId: true },
        })
      const matchesText = (opt: unknown): boolean =>
        typeof opt === 'string' && !!opt.trim() && lastUserText.startsWith(opt.trim().slice(0, 40))
      if (!matchedAskCard) matchedAskCard = recentCards.find((c) => matchesText(c.selectedOption))
      if (!matchedAskCard) {
        // Race self-heal: the tapped option arrived as the message but the answer
        // write hasn't landed (or failed) — the card is still pending. Record it
        // ourselves so the durable row and the anchoring note agree.
        const pendingHit = recentCards.find(
          (c) => c.status === 'pending' && Array.isArray(c.options) && (c.options as unknown[]).some(matchesText),
        )
        if (pendingHit) {
          const chosen = (pendingHit.options as unknown[]).find(matchesText) as string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (prisma as any).agentAskCard.update({
            where: { id: pendingHit.id },
            data: { status: 'answered', selectedOption: chosen },
          }).catch(() => {})
          matchedAskCard = { ...pendingHit, status: 'answered', selectedOption: chosen }
        }
      }
      // Phase 5: a bound answer moves the template state machine NOW (e.g. image
      // preview confirm unlocks the post step) — then re-read the runs so the
      // router, snapshot note and tool_choice binding all see the NEW step.
      if (matchedAskCard?.workflowRunId && matchedAskCard.selectedOption) {
        const { advanceWorkflowOnAskAnswer, listActiveWorkflowRuns: relist } = await import('@/agent/lib/workflow-run')
        await advanceWorkflowOnAskAnswer(matchedAskCard.workflowRunId, matchedAskCard.selectedOption, 'turn')
        workflowRuns = await relist(conversationId)
      }
    } catch { /* fail-open — the note/advance are aids, never blockers */ }
  }

  // ── Roadmap 1 Phase 32: deterministic continuity resolver ─────────────────
  // ONE conflict rule for "which work does this message belong to": explicit
  // card reply > pending card decision > checkpoint retry > clear new task
  // (parks the active focus) > continuation binds the active focus > clarify.
  // Gate: AGENT_CONTINUITY_RESOLVER off|shadow|on (unset → preview on, prod
  // shadow). Fail-open: null → exactly the legacy behaviour below.
  let continuity: Awaited<ReturnType<typeof resolveConversationContinuity>> = null
  if (lastUserText) {
    continuity = await resolveConversationContinuity({
      conversationId,
      text: lastUserText,
      listenMode,
      replyToCardId: explicitAskCardId ?? matchedAskCard?.id ?? null,
    })
  }
  const continuityLive = continuity?.mode === 'on'
  // ── Phase 62: UNIVERSAL task intake ──────────────────────────────────────
  // On a clear NEW task, create a durable focus for it — whether or not it is a
  // templated workflow (closes GAP-02: ordinary advisory/research/marketing
  // tasks previously got no task cursor). ensureFocusForOwnerTask parks any
  // prior active focus internally and is idempotent per turn (turnId key), so a
  // worker re-run never forks a duplicate. Gated on continuityLive so shadow/off
  // keep pure legacy behaviour; fail-open.
  if (continuityLive && lastUserText && continuity!.decision.binding === 'new_task') {
    try {
      const { ensureFocusForOwnerTask } = await import('@/agent/lib/conversation-focus')
      const kind = matchIntentPacks(lastUserText)[0] ?? 'generic'
      await ensureFocusForOwnerTask({
        conversationId,
        businessId,
        goal: lastUserText,
        kind,
        surface: telegramFastPath ? 'telegram' : 'web',
        intakeTurnId: turnId ?? '',
        cause: 'resolver',
      })
    } catch (err) {
      console.warn('[run-owner-turn] focus intake failed open:', err instanceof Error ? err.message : err)
    }
  }

  // ── Roadmap 1 Phase 36: interaction state + policy (behaviour as code) ────
  // Deterministic mode ladder (crisis > listen > teaching > decision/coaching
  // > concise status > work), emotion read, correction/repair detection.
  // Gate AGENT_INTERACTION_LAYER: off | shadow (derive+record) | on (directive
  // injected + commitment ledger enforced). Unset → preview on, prod shadow.
  const interactionFlag = process.env.AGENT_INTERACTION_LAYER
  const interactionMode2: 'off' | 'shadow' | 'on' =
    interactionFlag === 'off' || interactionFlag === 'false' ? 'off'
    : interactionFlag === 'on' || interactionFlag === 'true' ? 'on'
    : interactionFlag === 'shadow' ? 'shadow'
    : process.env.VERCEL_ENV === 'preview' ? 'on' : 'shadow'
  let interaction: {
    state: import('@/agent/lib/interaction-state').InteractionState
    policy: import('@/agent/lib/interaction-policy').InteractionPolicy
    plan: import('@/agent/lib/response-planner').ResponsePlan
  } | null = null
  if (interactionMode2 !== 'off' && lastUserText) {
    try {
      const [{ deriveInteractionState }, { policyForState }, { planResponse }] = await Promise.all([
        import('@/agent/lib/interaction-state'),
        import('@/agent/lib/interaction-policy'),
        import('@/agent/lib/response-planner'),
      ])
      const state = deriveInteractionState({
        text: lastUserText,
        headTier,
        statusQuery: continuity?.decision.action === 'explain_stop' || continuity?.decision.reason.includes('status'),
      })
      const policy = policyForState(state)
      const plan = planResponse(state, policy, {
        turnCount: rows.length,
        hasEvidence: !listenMode,
        willCommit: workflowRuns.length > 0,
      })
      interaction = { state, policy, plan }
    } catch (err) {
      console.warn('[run-owner-turn] interaction derive failed open:', err instanceof Error ? err.message : err)
    }
  }

  // Owner-approved gate fix (2026-07-14, layer 3): STRUCTURED STATE upgrades a
  // text-guessed read-only turn. An ask-card answer, or a continuation reply
  // ("হ্যাঁ/ok") while canonical runs are in flight, continues work the owner
  // already authorized — the intent regex must not strand it tool-less.
  // Phase 32: the resolver's wider continuation net ("তারপর?", "baki ta koro",
  // "যেখানে ছিলে সেখান থেকে করো") counts the same as the narrow CONTINUE_RE.
  if (!turnAuthorization.allowMutations) {
    const resolverContinues =
      continuityLive
      && continuity!.decision.binding === 'active_focus'
      && continuity!.decision.action === 'resume'
    const continuesInFlightWork =
      Boolean(matchedAskCard?.selectedOption)
      || (workflowRuns.length > 0 && (isContinuationText(lastUserText) || resolverContinues))
    if (continuesInFlightWork) {
      turnAuthorization = { allowMutations: true, reason: 'workflow_continuation' }
    }
  }
  // An old in-flight job must never hijack a fresh, unrelated owner message.
  // Drive the batch only on its original request, an explicit continuation, or
  // the worker's private result-resume control note.
  const driveClientSeoBatch =
    !listenMode
    && workflowRuns.some((r) => r.kind === 'client_seo_batch')
    && (
      ownerRequirements.clientSeo
      || isContinuationText(lastUserText)
      || Boolean(projectSystemInstructions?.includes('[INTERNAL SEO JOB RESULT]'))
    )

  const [pinnedMemories, relevantMemories, recalledTurns, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext, ownerActiveTasksBlock, staffActiveTasksBlock, toolSelection, businessSnapshot, officePulse] = await Promise.all([
    loadPinnedMemories(personalMode, businessId),
    lastUserText ? retrieveRelevantMemories(lastUserText, personalMode, businessId) : Promise.resolve([]),
    lastUserText ? retrieveRelevantOldTurns(conversationId, lastUserText) : Promise.resolve([]),
    suppressWork ? Promise.resolve(null) : loadSalahAccountabilityContext(now, lastUserText),
    suppressWork || telegramFastPath
      ? Promise.resolve([])
      : loadRecentOtherConversations(conversationId, 5),
    suppressWork ? Promise.resolve([]) : getActivePlaybook(businessId),
    suppressWork ? Promise.resolve([] as OutcomeLearning[]) : getRecentOutcomeLearnings({ limit: 5 }).catch(() => [] as OutcomeLearning[]),
    suppressWork ? Promise.resolve([] as OwnerDecision[]) : loadOwnerDecisions(businessId),
    (suppressWork || !lastUserText) ? Promise.resolve([]) : detectInstructionConflicts(lastUserText, businessId).catch(() => []),
    suppressWork ? Promise.resolve('') : buildBusinessContext(businessId).catch(() => ''),
    suppressWork ? Promise.resolve('') : buildOwnerActiveTasksContextBlock(businessId).catch(() => ''),
    suppressWork ? Promise.resolve('') : buildStaffActiveTasksContextBlock(businessId).catch(() => ''),
    // Phase 3: state-aware router first (pending cards / checkpoints / plans
    // precede text routing, ≤24 tools) — falls back to the legacy selector when
    // the flag is off or no confident signal exists.
    selectOwnerHeadTools({ conversationId, text: lastUserText, personalMode, businessId, headTier }),
    suppressWork || businessId === 'ALMA_TRADING' ? Promise.resolve(null) : getBusinessSnapshot(),
    // LIVE office pulse (owner decision 2026-07-08) — shared rolling summary of
    // today's office/staff/agent-work state, delta-refreshed ≤10 min. Lets
    // office questions and autonomous wakes answer in ONE round instead of
    // paying tool round-trips that re-bill the whole context.
    suppressWork || businessId === 'ALMA_TRADING'
      ? Promise.resolve(null)
      : getOfficePulse().catch(() => null),
  ])

  // Skill Engine V2 (gated OFF by default) — pick ≤3 on-demand skill procedures for
  // this turn from the message text; '' when disabled or nothing matches (fail-open).
  const activeSkillsBlock = suppressWork ? '' : await buildActiveSkillsBlock(lastUserText)
  const ownerIntentTools = filterToolsForOwnerIntent(lastUserText, toolSelection.tools)

  const promptArgs = {
    projectInstructions: projectSystemInstructions,
    pinnedMemories,
    relevantMemories,
    recalledTurns,
    salahContext: salahContext ?? undefined,
    prayerTimeOnlyTurn: suppressWork
      ? false
      : !isSalahStatusInquiry(lastUserText) && isPrayerTimeInquiry(lastUserText),
    staffTaskPlanningTurn: suppressWork ? false : isStaffTaskPlanningInquiry(lastUserText),
    staffTaskStatusTurn: suppressWork ? false : isStaffTaskStatusInquiry(lastUserText),
    crossSurface,
    salahStatusTurn: suppressWork ? false : isSalahStatusInquiry(lastUserText),
    personalMode,
    businessId,
    activePlaybook,
    activeSkillsBlock,
    intakeContextBlock,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
    ownerActiveTasksBlock: ownerActiveTasksBlock || undefined,
    staffActiveTasksBlock: staffActiveTasksBlock || undefined,
    activeGroups: listenMode ? [] : toolSelection.groups,
    activeToolNames: listenMode ? [] : ownerIntentTools.map((t) => t.name),
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
  // Phase 6 — DETERMINISTIC per-turn context assembly (roadmap: core →
  // workflow snapshot → scoped memory/context → compact history → latest turn).
  // The canonical job state leads; memory/context blocks follow; the listen
  // note, when present, overrides everything at the very top.
  const volatileSections: string[] = []
  // LISTEN MODE override — the empathy instruction leads and CANCELs the system
  // prompt's action-pressure for this one turn. There are no business tools on
  // a listen turn (assembled empty below), so the head physically cannot pivot
  // to work; this note shapes the tone.
  if (listenMode) volatileSections.push(LISTEN_MODE_NOTE)
  // Model identity (fixes the "I am Claude Sonnet" hallucination): pin the REAL
  // running model, and — when the owner switched models mid-chat — say so truthfully.
  // Rides high so the head always knows who it is; best-effort, never blocks the turn.
  const prevTurnModelId = await loadPreviousTurnModelId(conversationId)
  volatileSections.push(buildModelIdentityNote(model.id, prevTurnModelId))
  // Phase 36: the behaviour contract for THIS turn (mode/tone/structure/
  // repair/uncertainty/commitment rules) — live only when the layer is ON;
  // shadow derives + records without steering. Rides right after the listen
  // override so listen keeps top priority.
  if (interaction && interactionMode2 === 'on') {
    try {
      const { buildResponseDirective } = await import('@/agent/lib/response-planner')
      volatileSections.push(buildResponseDirective(interaction.state, interaction.policy, interaction.plan))
    } catch (err) {
      console.warn('[run-owner-turn] interaction directive failed open:', err instanceof Error ? err.message : err)
    }
  }
  // Owner-intent mutation gate note (origin/main "gate mutations by owner
  // intent"): tells the head which mutation authorization this turn carries.
  // Rides right after the listen override, before the job state.
  const authorizationNote =
    process.env.AGENT_OWNER_INTENT_GATE !== 'false' ? ownerTurnAuthorizationNote(turnAuthorization) : ''
  if (authorizationNote) volatileSections.push(authorizationNote)
  const requirementNote = !listenMode ? buildOwnerRequirementNote(ownerRequirements) : ''
  if (requirementNote) volatileSections.push(requirementNote)
  // Phase 32 — the conversation-focus block leads the job state: the durable
  // "where we are / what's next / what is already verified-done" record, plus
  // this turn's resolver binding so the head knows THIS message continues that
  // exact work (or deliberately parks it). Skipped in listen mode.
  if (!listenMode) try {
    const { getFocusStack, buildFocusSystemNote } = await import('@/agent/lib/conversation-focus')
    const stack = await getFocusStack(conversationId)
    let focusNote = buildFocusSystemNote(stack)
    if (focusNote && continuityLive && continuity) {
      const d = continuity.decision
      if (d.binding === 'active_focus' && d.action === 'resume') {
        focusNote += '\n⤷ এই বার্তাটা সক্রিয় কাজটারই ধারাবাহিকতা — নতুন করে শুরু কোরো না, ঠিক পরের বৈধ ধাপ থেকে এগোও।'
      } else if (d.binding === 'new_task' && d.action === 'park_and_start') {
        focusNote += '\n⤷ Boss নতুন একটা কাজ দিয়েছেন — আগের কাজটা পার্ক করা হয়েছে (হারায়নি); নতুনটা পরিষ্কারভাবে শুরু করো।'
      } else if (d.binding === 'checkpoint') {
        focusNote += '\n⤷ এই বার্তাটা আটকে-থাকা কাজটার resume/ব্যাখ্যা — checkpoint নোট অনুযায়ী ঠিক ওই ধাপ থেকে চালাও।'
      }
    }
    if (focusNote) volatileSections.push(focusNote)
  } catch (err) {
    console.warn('[run-owner-turn] focus note failed open:', err instanceof Error ? err.message : err)
  }
  // Phase 4 — the canonical WorkflowRun snapshot precedes everything else in the
  // per-turn context: the head reads the EXACT in-flight job state (status, step,
  // legal next tools) so "হ্যাঁ/continue" resumes the blocked step instead of
  // restarting from zero. Skipped in listen mode like the checkpoint note.
  if (!listenMode && workflowRuns.length > 0) {
    const wfNote = buildWorkflowSnapshotNote(workflowRuns)
    if (wfNote) volatileSections.push(wfNote)
  }
  // Resume brief (owner ask 2026-07-16: "কয়েক দিন পরেও ঠিক ওই জায়গা থেকে") —
  // after a 6h+ gap the head gets the structured যেখানে-ছিলাম state (active
  // runs, waiting cards, unanswered asks, open tasks, its own last promise)
  // instead of having to reconstruct it from raw history. Fail-open, and only
  // on gapped turns so rapid back-and-forth never pays the tokens.
  if (!listenMode) try {
    const { shouldInjectResumeBrief, buildResumeBrief } = await import('@/agent/lib/resume-brief')
    // Second-newest message = the state BEFORE the just-persisted user turn.
    const prev = await prisma.agentMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { createdAt: true },
    })
    const lastBefore = prev[1]?.createdAt ?? null
    if (lastBefore && shouldInjectResumeBrief(lastBefore, now)) {
      const brief = await buildResumeBrief(conversationId, lastBefore, now)
      if (brief) volatileSections.push(brief)
    }
  } catch { /* fail-open — never block the turn */ }
  // P0 resume fast-path: unresolved checkpoints ride the same transient per-turn
  // injection — the head resumes stalled work from the exact step with ZERO
  // history re-reading (the note is self-contained by contract). Fail-open.
  // Skipped in listen mode: a personal/emotional message must NOT drag a stalled
  // ads/browser task back into context (a top cause of the work-pivot incident).
  if (!listenMode) try {
    const { listUnresolvedCheckpoints, buildCheckpointSystemNote } = await import('@/agent/lib/checkpoint')
    const cps = await listUnresolvedCheckpoints(conversationId)
    const note = buildCheckpointSystemNote(cps)
    if (note) volatileSections.push(note)
  } catch { /* fail-open — never block the turn */ }
  // Ask-card answer framing: when the owner just tapped an option, the raw option
  // text arrives as a bare user message with zero context — heads treated it as a
  // brand-new request and RESTARTED the task from scratch (2026-07-12 carousel
  // incident). Anchor it: this is the ANSWER to your own question — resume, don't
  // re-derive. The matching itself moved BEFORE routing (Phase 5) — this block
  // only builds the note from that match. Skipped in listen mode (a feelings
  // message is never a card answer, and we must not pull prior work into it).
  if (!listenMode && matchedAskCard?.selectedOption) {
    const matched = matchedAskCard
    const others = Array.isArray(matched.options)
      ? (matched.options as unknown[]).filter((o): o is string => typeof o === 'string' && o !== matched.selectedOption)
      : []
    // Phase 4 (AGENT-IOS-001, server-side): the matched card carries its
    // workflowRunId — the owner's answer binds to the EXACT run, not prose.
    // workflowRuns was re-read after the Phase 5 advance, so the step shown
    // here is the run's CURRENT step (e.g. post_draft after a confirmed image).
    const wfRef = matched.workflowRunId
      ? workflowRuns.find((r) => r.id === matched.workflowRunId)
      : undefined
    const wfLine = wfRef
      ? ` এই উত্তরটা চলমান কাজ [${wfRef.kind}] "${wfRef.goal.slice(0, 80)}" (ধাপ: ${wfRef.state})-এর — ঠিক ওই ধাপ থেকেই এগোও।`
      : ''
    const answerNote =
      `[ASK-CARD উত্তর] Boss-এর এই বার্তাটা তোমারই প্রশ্নের উত্তর — প্রশ্ন ছিল: "${matched.question}"। ` +
      `Boss বেছে নিয়েছেন: "${matched.selectedOption}"।` + wfLine +
      (others.length ? ` তিনি এগুলো বেছে নেননি: ${others.map((o) => `"${o}"`).join(', ')} — সেগুলোর অর্থ ধরে কাজ করবে না।` : '') +
      ' এটা নতুন কাজ নয়: আগের চলমান কাজটা ঠিক যেখানে ছিলে সেখান থেকে চালিয়ে যাও (চেকপয়েন্ট নোট দেখো)। ' +
      'ব্রাউজার-কাজ চললে আগে live_browser_look দিয়ে এখনকার পেজ দেখো — গোড়া থেকে navigate করা বা main view-এ ফেরত যাওয়া নিষেধ।'
    volatileSections.push(answerNote)
  }
  // Scoped memory / business context (buildSystemPromptBlocks volatile) comes
  // AFTER the canonical job state — deterministic order, cheap to reason about.
  const systemVolatile = systemBlocksToText(volatile)
  if (systemVolatile) volatileSections.push(systemVolatile)
  const volatileText = volatileSections.filter(Boolean).join('\n\n').trim()
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
  // Phase 7 kill switch: AGENT_OWNER_INTENT_GATE=false disables the owner-intent
  // mutation filter (and its note) without a deploy.
  const intentGateOn = process.env.AGENT_OWNER_INTENT_GATE !== 'false'
  const selectedTools = filterToolDefsByControls(
    intentGateOn ? filterToolsForOwnerTurn(ownerIntentTools, turnAuthorization) : [...ownerIntentTools],
    agentControls,
  )
  // xAI hard-caps tool definitions at 200 per request — the owner head carries 201,
  // so EVERY Grok-4.20 turn 400'd ("Maximum tools limit reached") and silently fell
  // back to DeepSeek (2026-07-13 outage, diagnosed via error.metadata.raw). Keep the
  // earliest tools (core ERP + confirm/ask flows sit at the front of the registry)
  // and drop the tail with a visible note.
  // P10 — the 200-tool cap must also cover the xAI-DIRECT head (provider 'xai',
  // slug 'grok-4.20', which does NOT start with 'x-ai/'). Pure helper so parity
  // is unit-testable (see head-tool-cap.ts).
  const toolCap = computeHeadToolCap(model)
  let cappedTools = selectedTools
  if (selectedTools.length > toolCap) {
    const dropped = selectedTools.slice(toolCap).map((t) => t.name)
    console.warn(
      `[run-owner-turn] ${model.apiModel} caps tools at ${toolCap} — dropping ${dropped.length}: ${dropped.join(', ')}`,
    )
    cappedTools = selectedTools.slice(0, toolCap)
  }
  // Listen mode: withhold ALL business tools. This is the deterministic guarantee
  // (prompt rules alone don't hold the cheap heads back) that a feelings message
  // can't be answered with generate_image / ads / list_owner_todos etc. — the head
  // has nothing to call, so it must simply respond in words.
  const neutralTools = listenMode ? [] : anthropicToolsToNeutral(cappedTools)
  // Harness Gap 5 — schemas dynamically loaded by find_tool for the rest of this
  // turn (appended after the base list; execution guards unchanged).
  const dynamicNeutralTools: NeutralTool[] = []
  // Phase 3 request controller: parallel tool calls are legal ONLY when the whole
  // pack is pure reads (capability manifest). Any stage/write tool in the pack →
  // sequential, so the provider can never emit two confirm cards / writes chosen
  // blind to each other (the multi-card and tool-spree incident class).
  const { packAllowsParallelToolCalls } = await import('@/agent/tools/capability-manifest')
  const packParallelToolCalls = packAllowsParallelToolCalls(neutralTools.map((t) => t.name))
  // Phase 5 (roadmap §D): a deterministic mutating step binds the head's FIRST
  // round to the template step's expected tool — exactly one active template
  // run, its required facts present, and a continuation reply ("হ্যাঁ/করো") that
  // carries no new intent. Later rounds return to auto so the model can speak.
  // Guarded to tools actually present in this turn's pack (a bound name the
  // provider can't see would 400 the request).
  const stepBinding = !listenMode && workflowRuns.length > 0
    ? workflowToolBinding(workflowRuns, {
        // An ask-card answer bound to a run is as deterministic as "হ্যাঁ" — the
        // owner just resolved THIS job's question (e.g. confirmed the preview).
        // Phase 32: the resolver's wider continuation verdict counts too.
        continuation:
          isContinuationText(lastUserText)
          || Boolean(matchedAskCard?.workflowRunId)
          || (continuityLive && continuity?.decision.binding === 'active_focus' && continuity.decision.action === 'resume'),
      })
    : null
  const boundToolName =
    stepBinding && neutralTools.some((t) => t.name === stepBinding.toolName)
      ? stepBinding.toolName
      : null
  // ── LangGraph deterministic routine path (owner decision 2026-07-15) ────────
  // The owner's fixed daily lookups run as a graph: CODE picks and executes the
  // read tool (the model gets zero tool-choice freedom — the "wrong tool /
  // invented numbers" class can't happen), the model only words the Bangla
  // answer. Any miss or failure falls open to the normal loop below untouched.
  // Runs BEFORE the route span (LG-1) so the span records the graph outcome —
  // the cost dashboard reads graph-handled share + saved tokens from it.
  // Rollout: AGENT_LANGGRAPH_ROUTINE=true/false; default ON in preview only.
  // Internal/continuation turns (approval continuation, auto-continue, job
  // results) carry a server directive in projectSystemInstructions and persist
  // NO new owner message — lastUserText is the PREVIOUS owner message. The
  // deterministic graphs must never re-detect on that stale text: 2026-07-16
  // preview incident — approve → continuation turn re-staged the SAME expense
  // card the owner had just approved. The model loop reads the directive and
  // knows not to redo the work; the graphs are blind to it, so they sit out.
  const internalTurn = Boolean(
    projectSystemInstructions
      && /\[(INTERNAL WORKFLOW CONTINUATION|SYSTEM CONTINUATION|INTERNAL SEO JOB RESULT)/.test(projectSystemInstructions),
  )

  // ── LG-3: fixed WRITE intents stage their card as a paused graph thread ────
  // (interrupt pilot: log_expense only). Runs BEFORE the routine READ graph so
  // "500 taka khoroch holo" stages a card instead of reading today's summary.
  // Any miss falls through to the routine graph, then the normal loop.
  const actionGraphOn = isActionGraphEnabled()
  let actionGraph: StageExpenseResult | null = null
  if (!listenMode && headTier === 'light' && actionGraphOn && !internalTurn) {
    actionGraph = await stageExpenseActionGraph(lastUserText, { conversationId, turnId })
  }

  const routineGraphOn = isRoutineGraphEnabled()
  let routineGraph: RoutineGraphResult | null = null
  if (!listenMode && headTier === 'light' && !actionGraph?.staged && !internalTurn) {
    // One line per light turn so "why didn't the graph run?" is answerable from
    // runtime logs instead of guesswork (2026-07-15 preview debugging session:
    // VERCEL_ENV visibility couldn't be confirmed any other way).
    console.log(
      `[routine-graph] gate: enabled=${routineGraphOn} flag=${process.env.AGENT_LANGGRAPH_ROUTINE ?? 'unset'} vercelEnv=${process.env.VERCEL_ENV ?? 'unset'} textLen=${lastUserText.length}`,
    )
    if (routineGraphOn) {
      routineGraph = await runRoutineTurnGraph(lastUserText, {
        model,
        businessId,
        conversationId,
        turnId,
        turnAuthorization,
        signal,
      })
    }
  }

  // ── LG-4 shadow: the turn's decision pipeline replayed as a graph ──────────
  // Pure over values already computed above (fast-path regexes, live head
  // decision, tool selection, loop cap) — zero extra spend. The record lands on
  // the route span; disagreements warn. Legacy executes regardless (roadmap:
  // shadow → canary → on).
  const turnGraphShadow = await runTurnGraphShadow({
    lastUserText,
    headTier: headTier ?? 'heavy',
    headVia,
    listenMode,
    toolGroups: listenMode ? [] : toolSelection.groups,
    toolCount: neutralTools.length,
    toolRouter: toolSelection.router ?? null,
    // The PLANNED loop cap — the graph paths may still zero it later this turn.
    maxIterations: MAX_TOOL_ITERATIONS,
    // Phase 33: full 12-node owner-turn graph in shadow — graph decides,
    // legacy executes. State loader mirrors the resolver's reads (preview-only
    // cost; the gate keeps production off until the Phase 37 ladder).
    conversationId,
    turnId,
    businessId,
    boundToolName,
    continuityBinding: continuity?.decision.binding ?? null,
    allowMutations: turnAuthorization.allowMutations,
    loadState: async () => {
      const [{ getFocusStack }, { listUnresolvedCheckpoints }] = await Promise.all([
        import('@/agent/lib/conversation-focus'),
        import('@/agent/lib/checkpoint'),
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const [stack, cps, pendingActions, askCards] = await Promise.all([
        getFocusStack(conversationId),
        listUnresolvedCheckpoints(conversationId),
        db.agentPendingAction.findMany({
          where: { conversationId, status: 'pending' },
          orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, type: true },
        }),
        db.agentAskCard.findMany({
          where: { conversationId, status: 'pending' },
          orderBy: { createdAt: 'desc' }, take: 3, select: { id: true },
        }),
      ])
      return {
        activeFocus: stack.active
          ? { id: stack.active.id, goal: stack.active.goal, kind: stack.active.kind, status: 'active' as const, currentStep: stack.active.currentStep, completedSteps: stack.active.completedSteps }
          : null,
        parkedFocuses: stack.parked.map((f) => ({ id: f.id, goal: f.goal, kind: f.kind, status: 'parked' as const })),
        pendingCards: [
          ...(askCards as Array<{ id: string }>).map((c) => ({ id: c.id, kind: 'ask_card' as const })),
          ...(pendingActions as Array<{ id: string; type: string }>).map((c) => ({ id: c.id, kind: 'approval' as const, actionType: c.type })),
        ],
        checkpoints: (cps as Array<{ checkpoint: { taskRef: string; taskType: string; currentStep?: string } }>).map((c) => ({
          taskRef: c.checkpoint.taskRef, taskType: c.checkpoint.taskType, step: c.checkpoint.currentStep ?? 'unknown',
        })),
      }
    },
  })

  // Phase 1 route span: what this turn's head was actually given — groups, final
  // tool count (after controls gating, provider cap and listen mode), model and
  // behavior-artifact versions. The tool events say what the model CALLED; this
  // span says what it had to CHOOSE from — the missing half of every wrong-tool
  // investigation.
  void logRouteSpan({
    conversationId,
    turnId,
    businessId,
    groups: listenMode ? [] : toolSelection.groups,
    toolCount: neutralTools.length,
    modelId: model.id,
    headTier,
    versions: AGENT_VERSIONS,
    extras: {
      // Phase 36: this turn's interaction contract (mode/emotion/correction)
      // — behaviour becomes measurable per turn, not a prompt hope.
      interaction: interaction
        ? {
            layer: interactionMode2,
            mode: interaction.state.mode,
            emotion: interaction.state.emotion,
            correction: interaction.state.correction,
            tone: interaction.policy.tone,
          }
        : null,
      // Phase 32: this turn's continuity decision — every trace shows which
      // work the message was bound to and why (audit + shadow measurement).
      continuity: continuity
        ? {
            mode: continuity.mode,
            binding: continuity.decision.binding,
            action: continuity.decision.action,
            reason: continuity.decision.reason,
          }
        : null,
      router: toolSelection.router,
      packs: toolSelection.packs ?? null,
      signals: toolSelection.signals ?? null,
      trimmed: toolSelection.trimmed?.length ? toolSelection.trimmed : null,
      parallelToolCalls: packParallelToolCalls,
      boundTool: boundToolName,
      turnAuthorization: turnAuthorization.reason,
      // Phase 7 shadow: the router's prediction on legacy-executed turns —
      // prod traffic scores recall/precision before any canary turns on.
      shadow: toolSelection.shadow ?? null,
      // LG-1: routine-graph outcome on EVERY turn — 'off' (gate off / not a
      // light turn), 'handled' or 'miss'. Dashboard: handled share + the tiny
      // graph token usage vs the loop's normal spend = saved tokens.
      // LG-3: same for the action (interrupt) graph.
      // LG-4: shadow decision-graph record (fastPath, agree, legacy via/tier).
      turnGraph: turnGraphShadow ?? null,
      actionGraph: actionGraph ? (actionGraph.staged ? 'staged' : 'miss') : 'off',
      routineGraph: routineGraph ? (routineGraph.handled ? 'handled' : 'miss') : 'off',
      routineIntent: routineGraph?.intent ?? null,
      routineMissReason: routineGraph?.missReason ?? null,
      routineUsage: routineGraph?.handled
        ? { inputTokens: routineGraph.usage.inputTokens, outputTokens: routineGraph.usage.outputTokens }
        : null,
    },
  })
  const adapter = adapterFor(model.provider)

  type ToolRecord = {
    id: string; toolName: string; input: Record<string, unknown>
    output: Record<string, unknown> | null; status: 'success' | 'error'
    durationMs: number; error: string | null
  }
  const toolRecords: ToolRecord[] = []
  // Dead-path guard state (2026-07-16): consecutive-failure streaks per tool
  // and per exact tool+args signature within THIS turn; a success clears the
  // tool's streak. One nudge per tool per turn — the point is a change of
  // strategy, not a scolding loop.
  const deadPathStreaks = new Map<string, number>()
  const deadPathNudged = new Set<string>()
  let verifyRetries = 0
  // Guard against a fully EMPTY model round (no text, no tool calls) mid-task —
  // Gemini does this occasionally and ending the turn there strands the owner
  // with a blank reply (2026-07-12: WhatsApp-fix turn died after one navigate).
  let emptyRoundRetries = 0
  // Announced-intent guard (global terminal/failure rules live in turn-loop-policy).
  let intentNudges = 0
  let requirementRetries = 0
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
    | { t: 'text'; text: string; state?: 'superseded' }
    | { t: 'verify'; attempt: number; max: number }
    | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; shot?: string }
    | { t: 'file'; id: string; name: string; kind?: string }
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
  // Phase 6 (one engine): the PREMIUM Claude head keeps its core.ts "Option A"
  // cost guard here too — after HEAD_TOOL_BUDGET rounds only delegate remains,
  // so an expensive head hands the spree to a cheap worker instead of billing on.
  const isPremiumHead = model.provider === 'anthropic'
  const delegateOnlyNeutral = neutralTools.filter((t) => t.name === 'delegate_to_specialist')
  let headToolRounds = 0
  let budgetNudgeSent = false
  let cardStagedNudgeSent = false
  let deadlineNudgeSent = false
  let canceled = false
  /// Confirm cards yielded this turn — precondition for the card-shape
  /// verifiers (an emitted card legitimately carries the ask).
  let confirmCardsEmitted = 0
  // Live-browser turns raise this cap (see BROWSER_TURN_MAX_ITERATIONS) — a real
  // UI task is 15–30 look→act rounds and must not die silently at the default cap.
  let maxIterations = MAX_TOOL_ITERATIONS
  const claimedSteeringIds = new Set<string>()

  // LG-3: the action graph staged a card (thread paused at its interrupt) —
  // emit the ordinary confirm-card event + a fixed Bangla staging line; the
  // model loop never runs. Approve/reject resumes the thread server-side.
  if (actionGraph?.staged && actionGraph.pendingActionId) {
    maxIterations = 0
    timeline.push({ t: 'tool', name: 'log_expense', ok: true, input: { via: 'action_graph' }, result: actionGraph.summary })
    confirmCardsEmitted++
    yield {
      type: 'confirm_card',
      pendingActionId: actionGraph.pendingActionId,
      summary: actionGraph.summary,
      actionType: 'log_expense',
      isFinance: true,
    }
    finalText = actionGraph.replyText
    timeline.push({ t: 'text', text: finalText })
    yield { type: 'text_delta', delta: finalText }
  }

  // Routine graph handled the turn (invoked above, before the route span) —
  // emit its tool + reply as a perfectly ordinary turn; the model loop never runs.
  if (routineGraph?.handled && routineGraph.toolRecord) {
    const g = routineGraph
    maxIterations = 0
    apiRounds += 1
    totalInputTokens += g.usage.inputTokens
    totalOutputTokens += g.usage.outputTokens
    const record = g.toolRecord!
    const preview = toolResultPreview(record.output ?? {})
    toolRecords.push(record)
    timeline.push({ t: 'tool', name: record.toolName, ok: true, input: record.input, result: preview })
    yield { type: 'tool_start', id: record.id, name: record.toolName, input: record.input }
    yield { type: 'tool_end', id: record.id, name: record.toolName, success: true, resultPreview: preview }
    finalText = g.replyText
    timeline.push({ t: 'text', text: finalText })
    yield { type: 'text_delta', delta: finalText }
  }

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) break
      // Owner hit Stop — cross-instance cancel flag (see core.ts for rationale).
      if (await isTurnCancelRequested(turnId)) { canceled = true; break }

      // Pull durable owner follow-ups before every model round so a running job
      // adapts in place instead of waiting for a second turn.
      const steering = await claimTurnSteeringMessages(turnId, conversationId, claimedSteeringIds)
      for (const item of steering) claimedSteeringIds.add(item.id)
      if (steering.length > 0) {
        currentOwnerInstructions = [currentOwnerInstructions, ...steering.map((item) => item.prompt)]
          .filter(Boolean)
          .join('\n')
        messages = [
          ...messages,
          ...steering.map((item) => ({ role: 'user' as const, content: item.prompt })),
        ]
      }

      const calls: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }> = []
      const toolNames = new Map<string, string>()
      let iterationText = ''
      // Reasoning produced in THIS round only — one timeline segment before this
      // round's tool calls, keeping cross-round order faithful.
      let iterThinking = ''

      // Serverless deadline close → no more tools; force a Bangla progress
      // wrap-up instead of the function dying mid-task with a blank reply.
      const nearDeadline = typeof deadlineAt === 'number' && Date.now() > deadlineAt - 45_000
      if (nearDeadline && !deadlineNudgeSent) {
        deadlineNudgeSent = true
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              'এই টার্নের সময়সীমা প্রায় শেষ (সার্ভার লিমিট) — এখন আর টুল চালানো যাবে না। ' +
              'এ পর্যন্ত কী কী করেছ আর ঠিক কোথায় আছ তা বসকে বাংলায় সংক্ষেপে জানাও, ' +
              'আর কাজ অসমাপ্ত থাকলে শেষে লেখো: "Boss, “continue” বললে ঠিক এখান থেকে কাজ চালিয়ে যাব।" — চুপচাপ থেমো না।',
          },
        ]
      }

      // Over budget → strip ALL tools so the marketing head physically cannot
      // spree more; it must finish the marketing job itself and answer now.
      // No delegate hand-off: marketing quality stays on Qwen, not DeepSeek.
      // Second empty-round retry also goes text-only: Gemini sometimes wedges
      // trying to emit another tool call — with no tools it must speak.
      const overBudget = isMarketingHead && headToolRounds >= MARKETING_HEAD_TOOL_BUDGET
      // Premium Claude head over its (smaller) budget → delegate-only, per the
      // core.ts Option A guard this loop now owns (Phase 6). Inert when the
      // pack carries no delegate tool (narrow modes) — the normal caps apply.
      const premiumOverBudget =
        isPremiumHead && delegateOnlyNeutral.length > 0 && headToolRounds >= HEAD_TOOL_BUDGET
      // Models whose provider offers no tool-calling (e.g. Qwen 2.5 VL 72B on
      // OpenRouter) get a chat/vision-only turn — sending tool defs would 4xx
      // the request and bounce the owner to the cheap-head fallback.
      // A staged approval card ends the working part of the turn: everything
      // past it is spend on work the owner may reject (and it buries the card).
      const cardStaged = confirmCardsEmitted > 0 || emittedAskCards.length > 0
      const iterationTools =
        nearDeadline || overBudget || cardStaged || emptyRoundRetries >= 2 || !model.supportsTools
          ? []
          : premiumOverBudget
            ? delegateOnlyNeutral
            : dynamicNeutralTools.length > 0
              ? [...neutralTools, ...dynamicNeutralTools]
              : neutralTools
      const batchRequiredTool = driveClientSeoBatch ? await getClientSeoBatchRequiredTool(conversationId) : null
      const memoryRequiredTool = ownerRequirements.remember
        && !toolRecords.some((r) => r.toolName === 'save_memory' && r.status === 'success')
        ? 'save_memory'
        : null
      const requestedContractTool = memoryRequiredTool ?? batchRequiredTool
      const contractFailure = requestedContractTool
        ? [...toolRecords].reverse().find((r) => r.toolName === requestedContractTool && r.status === 'error')
        : undefined
      // A real tool failure is a blocker, not permission to hammer the same
      // browser/action 20 more times. Stop and surface the exact error.
      const contractToolName = contractFailure ? null : requestedContractTool
      // P3 — plan-first: bind make_plan on round 0 for clearly multi-step work,
      // but never over an explicit contract/workflow bind, and only when make_plan
      // is loaded and hasn't already run this turn.
      const planBoundTool =
        ownerRequirements.planFirst && iteration === 0
          && iterationTools.some((t) => t.name === 'make_plan')
          && !toolRecords.some((r) => r.toolName === 'make_plan')
          ? 'make_plan'
          : null
      const roundBoundToolName =
        contractToolName && iterationTools.some((t) => t.name === contractToolName)
          ? contractToolName
          : iteration === 0 ? (boundToolName ?? planBoundTool) : null
      // P2 — ground-before-answer: when nothing else is bound, force ANY tool on
      // round 0 of a live-data question so the head cannot answer from memory.
      const groundingRequiredThisRound =
        ownerRequirements.groundingRequired && iteration === 0 && !roundBoundToolName
          && iterationTools.length > 0
          && !toolRecords.some((r) => r.status === 'success')
      if (!nearDeadline && overBudget && !budgetNudgeSent) {
        budgetNudgeSent = true
        messages = [...messages, { role: 'user', content: MARKETING_HEAD_WRAPUP_NUDGE }]
      }
      if (cardStaged && !cardStagedNudgeSent) {
        cardStagedNudgeSent = true
        messages = [...messages, { role: 'user', content: CARD_STAGED_WRAPUP_NUDGE }]
      }
      if (!nearDeadline && premiumOverBudget && !budgetNudgeSent) {
        budgetNudgeSent = true
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              'তুমি এই টার্নে যথেষ্ট টুল-রাউন্ড ব্যবহার করেছ (দামি মডেল)। এখন হয় জানা তথ্য দিয়েই উত্তর শেষ করো, ' +
              'নয়তো বাকি কাজটা delegate_to_specialist দিয়ে specialist worker-কে দাও — নিজে আর টুল spree কোরো না।',
          },
        ]
      }

      // P5 — re-inject the compact constitution reminder every N tool rounds so
      // a long tool-heavy turn (browser/agentic) doesn't drift from the core
      // rules while the system prompt scrolls far up the context (context rot).
      if (AGENT_CONSTITUTION && iteration > 0 && iteration % CONSTITUTION_REINJECT_EVERY === 0) {
        // BP6 — the style line rides the same anti-drift injection (tone drifts too).
        messages = [...messages, { role: 'user', content: AGENT_STYLE ? `${CONSTITUTION_REMINDER}\n${STYLE_REMINDER}` : CONSTITUTION_REMINDER }]
      }

      for await (const ev of adapter.streamTurn({
        apiModel: model.apiModel,
        system: systemText,
        messages,
        tools: iterationTools,
        thinking: model.thinking,
        signal,
        parallelToolCalls: iterationTools.length > 0 ? packParallelToolCalls : undefined,
        // Phase 5 §D: bind the FIRST round of a deterministic mutating step to
        // its named tool (sequential by policy above); every later round is
        // auto so the model can verify, summarize, or ask.
        toolChoice:
          roundBoundToolName && iterationTools.length > 0
            ? { name: roundBoundToolName }
            : groundingRequiredThisRound
              ? 'required'
              : undefined,
      })) {
        if (ev.type === 'text_delta') {
          if (thinkingText && thinkingMs == null && thinkingStartedAt) {
            thinkingMs = Date.now() - thinkingStartedAt
          }
          iterationText += ev.text
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
          apiRounds++
          if (ev.costUsd != null) {
            totalActualCostUsd = (totalActualCostUsd ?? 0) + ev.costUsd
            roundCostsUsd.push(roundUsd(ev.costUsd))
          }
        }
      }

      // Record this round's reasoning as a timeline segment BEFORE its tool calls.
      if (iterThinking.trim()) timeline.push({ t: 'think', text: iterThinking.trim().slice(0, 4000) })
      // Round's visible text joins the timeline too, so the persisted stream keeps
      // the true text↔step order after reload (ChronoFlow) — same as core.ts.
      if (iterationText.trim()) timeline.push({ t: 'text', text: iterationText.slice(0, 6000) })
      // Tool-round prose streams right away so the live view and reload both keep
      // the narration between steps; final-round text is emitted AFTER the
      // requirement-contract checks below (which may replace it).
      if (iterationText.trim() && calls.length > 0) {
        const sep = finalText && !finalText.endsWith('\n') ? '\n\n' : ''
        finalText += sep + iterationText
        yield { type: 'text_delta', delta: sep + iterationText }
      }

      if (calls.length === 0 || signal?.aborted) {
        // A follow-up can land while the provider is producing its final draft.
        // Claim once more before committing it; the same turn then re-runs with
        // Boss's latest instruction and the stale draft stays audit-only.
        const lateSteering = await claimTurnSteeringMessages(turnId, conversationId, claimedSteeringIds)
        if (lateSteering.length > 0 && !signal?.aborted) {
          for (const item of lateSteering) claimedSteeringIds.add(item.id)
          currentOwnerInstructions = [currentOwnerInstructions, ...lateSteering.map((item) => item.prompt)]
            .filter(Boolean)
            .join('\n')
          for (let ti = timeline.length - 1; ti >= 0; ti--) {
            const te = timeline[ti]
            if (te.t === 'text') { te.state = 'superseded'; break }
          }
          messages = [
            ...messages,
            ...(iterationText.trim() ? [{ role: 'assistant' as const, content: iterationText }] : []),
            ...lateSteering.map((item) => ({ role: 'user' as const, content: item.prompt })),
          ]
          continue
        }
        // Fully empty round → nudge the model to continue instead of silently
        // ending the turn with a blank message. Bounded to 2 retries. Applies to
        // the FIRST round too (2026-07-12: gemini-2.5-flash answered the very
        // first round with 0 output tokens — no prior tools existed, so the old
        // `toolRecords.length > 0` guard let a blank reply through).
        if (
          !signal?.aborted
          && !iterationText.trim()
          && !finalText.trim()
          && emptyRoundRetries < 2
        ) {
          emptyRoundRetries++
          messages = [
            ...messages,
            {
              role: 'user',
              content:
                'তোমার আগের রাউন্ডটা ফাঁকা ছিল — কোনো টেক্সট বা টুল কল আসেনি। কাজটা এখনো শেষ হয়নি: ' +
                'হয় পরের টুল স্টেপটা চালাও, নয়তো এ পর্যন্ত কী হলো বসকে বাংলায় জানাও। চুপ করে থেমো না।',
            },
          ]
          continue
        }
        // The model signed off by PROMISING the next step instead of doing it —
        // push it to act now, in this same turn (flash-tier heads do this a lot).
        // NOT near the deadline: the wrap-up is SUPPOSED to promise future work
        // ("continue বললে চালিয়ে যাব") — firing here wiped finalText right before
        // the 280s abort and saved an EMPTY message (2026-07-12 carousel incident).
        if (
          !signal?.aborted
          && !deadlineNudgeSent
          && intentNudges < 1
          && iterationText.trim()
          && shouldNudgeAdapterIntent({
            text: iterationText,
            toolRecords,
            hasAskCard: emittedAskCards.length > 0,
            ownerRequestedAction: turnAuthorization.allowMutations,
          })
        ) {
          intentNudges++
          messages = [
            ...messages,
            { role: 'assistant', content: iterationText },
            { role: 'user', content: ADAPTER_ACT_NOW_NUDGE },
          ]
          finalText = ''
          continue
        }
        // Verify-retry also skips near the deadline: a rewrite round costs 20-60s
        // the turn no longer has, and its finalText reset is what strands an empty
        // message when the abort lands mid-rewrite.
        if (!signal?.aborted && !deadlineNudgeSent && verifyRetries < MAX_VERIFY_RETRIES && iterationText.trim()) {
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
          // Card-shape checks (parity with core.ts — the cheap-head path never
          // ran them, which is exactly where weak models break the HARD RULE):
          // a promised-but-unemitted card, and the owner-hit 2026-07-16 case of
          // an Option-A/B choice asked in prose with nothing to tap.
          if (violations.length === 0 && emittedAskCards.length === 0 && confirmCardsEmitted === 0) {
            violations.push(...detectMissingCardViolation(iterationText.trim()))
            violations.push(...detectProseChoiceViolation(iterationText.trim()))
          }
          // P1 — fabricated-stat gate (flag-gated inside → no-op when off).
          if (violations.length === 0) {
            violations.push(...detectFabricatedStatViolations(iterationText.trim(), ledger))
          }
          // BP6 — robotic-style gate (flag-gated inside → no-op when off).
          if (violations.length === 0) {
            violations.push(...detectRoboticStyleViolations(iterationText.trim()))
          }
          if (violations.length === 0) {
            violations.push(...detectExplicitInstructionViolations(iterationText.trim(), currentOwnerInstructions))
          }
          if (violations.length > 0) {
            verifyRetries++
            yield {
              type: 'verification_retry',
              attempt: verifyRetries,
              maxAttempts: MAX_VERIFY_RETRIES,
              categories: Array.from(new Set(violations.map((v) => v.category))),
              snippets: violations.map((v) => v.matchedSnippet),
            }
            // Keep the rejected draft in the raw audit timeline, truthfully marked
            // superseded, and persist the verification event. Owner-facing clients
            // project only the verified replacement as prose.
            for (let ti = timeline.length - 1; ti >= 0; ti--) {
              const te = timeline[ti]
              if (te.t === 'text') { te.state = 'superseded'; break }
            }
            timeline.push({ t: 'verify', attempt: verifyRetries, max: MAX_VERIFY_RETRIES })
            finalText = ''
            messages = [
              ...messages,
              { role: 'assistant', content: iterationText },
              { role: 'user', content: buildVerificationReminder(violations) },
            ]
            continue
          }
        }

        const preContractText = iterationText
        const batchStatus = driveClientSeoBatch ? await getClientSeoBatchStatus(conversationId) : null
        const explicitMemoryMissing = ownerRequirements.remember
          && !toolRecords.some((r) => r.toolName === 'save_memory' && r.status === 'success')
        const blockedRequirement = [...toolRecords].reverse().find((r) =>
          r.status === 'error'
          && r.toolName === (explicitMemoryMissing ? 'save_memory' : batchStatus?.requiredTool),
        )
        if (blockedRequirement) {
          iterationText =
            `⚠️ বাধ্যতামূলক ধাপ ${blockedRequirement.toolName} সফল হয়নি, তাই কাজ সম্পন্ন বলছি না। ` +
            `কারণ: ${blockedRequirement.error ?? 'unknown error'}`
        } else if (!signal?.aborted && !deadlineNudgeSent && (batchStatus?.requiredTool || explicitMemoryMissing)) {
          const needed = explicitMemoryMissing ? 'save_memory' : batchStatus?.requiredTool
          if (needed && neutralTools.some((t) => t.name === needed) && requirementRetries < 2) {
            requirementRetries++
            messages = [
              ...messages,
              ...(iterationText.trim() ? [{ role: 'assistant' as const, content: iterationText }] : []),
              {
                role: 'user',
                content:
                  `[INTERNAL CONTROL — this is NOT a new Boss message and must never be shown as one] ` +
                  `The server requirement contract is incomplete. Call ${needed} now; do not write another owner-facing answer first.`,
              },
            ]
            continue
          }
          iterationText = batchStatus
            ? clientSeoBatchProgressText(batchStatus.facts)
            : '⚠️ Boss-এর explicit memory request এখনো save হয়নি; তাই সম্পন্ন বলছি না।'
        } else if (batchStatus && !batchStatus.requiredTool && !batchStatus.facts.packCompleted) {
          // No legal tool means the VPS worker owns the current step. Never let
          // the model fill that wait with unrelated prose.
          iterationText = clientSeoBatchProgressText(batchStatus.facts)
        }
        // The contract replaced the model's draft → keep the persisted timeline
        // truthful too: mark the draft superseded (same presentation as verify
        // retries) and record what was actually said instead.
        if (iterationText !== preContractText) {
          if (preContractText.trim()) {
            for (let ti = timeline.length - 1; ti >= 0; ti--) {
              const te = timeline[ti]
              if (te.t === 'text') { te.state = 'superseded'; break }
            }
          }
          if (iterationText.trim()) timeline.push({ t: 'text', text: iterationText.slice(0, 6000) })
        }
        if (iterationText) {
          finalText += iterationText
          yield { type: 'text_delta', delta: iterationText }
        }
        break
      }

      // This turn requested tools → count it against the head's tool-round budget.
      // EXCEPT live-browser-only rounds: driving the owner's Chrome is inherently
      // many small owner-supervised steps that no cheap worker can take over, so
      // they neither burn the budget nor stay confined to the default cap.
      const browserRound = calls.length > 0 && calls.every((c) => c.name.startsWith('live_browser_'))
      if (browserRound) maxIterations = BROWSER_TURN_MAX_ITERATIONS
      else headToolRounds++

      const toolResults: Array<{ id: string; name: string; result: unknown }> = []
      let roundContractFailure: ToolRecord | undefined
      const autoRanDelegationSummaries: string[] = []
      for (const call of calls) {
        // A required-tool failure already happened in this same model round.
        // Do not execute any queued follow-up calls: the failure is terminal for
        // this owner turn, and a fresh owner message may retry it later.
        if (roundContractFailure) {
          const skipped = {
            success: false,
            error: `আগের বাধ্যতামূলক ধাপ ${roundContractFailure.toolName} ব্যর্থ হয়েছে — এই turn-এর বাকি tool call চালানো হয়নি।`,
          }
          toolRecords.push({
            id: call.id, toolName: call.name, input: call.input,
            output: null, status: 'error', durationMs: 0, error: skipped.error,
          })
          toolResults.push({ id: call.id, name: call.name, result: skipped })
          yield {
            type: 'tool_end', id: call.id, name: call.name,
            success: false, error: skipped.error, resultPreview: skipped.error,
          }
          continue
        }
        // Deadline check PER CALL, not just per round: one DeepSeek round can queue
        // 5-6 browser calls (~90s) that straddle the 45s wrap-up window, so the
        // wrap-up nudge never got a round to run in and the 280s abort killed the
        // turn silently (2026-07-12 carousel incident). Skip the remaining calls —
        // each still gets a tool_result (API contract) marking it deferred.
        if (typeof deadlineAt === 'number' && Date.now() > deadlineAt - 45_000) {
          const skipped = { success: false, error: 'সময়সীমা শেষ — এই ধাপটা এখন হয়নি; পরের টার্নে ঠিক এখান থেকে করবে।' }
          toolRecords.push({
            id: call.id, toolName: call.name, input: call.input,
            output: null, status: 'error', durationMs: 0, error: skipped.error,
          })
          toolResults.push({ id: call.id, name: call.name, result: skipped })
          continue
        }
        // Re-emit tool_start with the parsed input so the UI shows the real target.
        yield { type: 'tool_start', id: call.id, name: call.name, input: call.input }
        const started = Date.now()
        const ownerIntentViolation = personalMode
          ? null
          : validateToolCallAgainstOwnerIntent({
              ownerInstructions: currentOwnerInstructions,
              toolName: call.name,
            })
        // AIOS mandatory enforcement (ON by default; AIOS_ENFORCE=off opts out): force EVERY model's
        // tool call through policy + autonomy/approval before it can run. A
        // sensitive action (money/publish/HR/export) is held for owner approval;
        // routine/read tools run. Identical decision for every model.
        const aiosGuard = !ownerIntentViolation && enforcementEnabled()
          ? guardToolCall({
              identity: {
                tenantId: String(businessId ?? 'ALMA_LIFESTYLE'),
                actorId: 'owner',
                agentId: model.id,
                workflowId: String(conversationId ?? 'conversation'),
                stepId: String(call.id ?? 'step'),
                correlationId: String(turnId ?? conversationId ?? 'turn'),
              },
              model: model.id,
              toolName: call.name,
              attributes: call.input as Record<string, unknown>,
            })
          : null
        // Harness Gap 2 — generic pre-tool hooks (deterministic, fail-open),
        // identical decision to the native Claude path.
        const preHookDecision = !ownerIntentViolation
          ? runPreToolHooks({
              toolName: call.name,
              input: call.input as Record<string, unknown>,
              model: model.id,
              personalMode,
              businessId: String(businessId ?? ''),
            })
          : null
        const hookBlocked = preHookDecision && preHookDecision.action === 'block' ? preHookDecision : null
        const result = ownerIntentViolation
          ? { success: false as const, error: ownerIntentViolation.message }
          : hookBlocked
          ? { success: false as const, error: hookBlocked.message }
          : aiosGuard && !aiosGuard.allow
          ? aiosGuard.status === 'NEEDS_APPROVAL'
            ? await stageEnforcedToolApproval({
                conversationId,
                businessId,
                turnId,
                toolCallId: call.id,
                toolName: call.name,
                toolInput: call.input,
                model: model.id,
                klass: aiosGuard.klass as Exclude<typeof aiosGuard.klass, 'routine'>,
              })
            : { success: false as const, error: aiosGuard.message }
          : personalMode
          ? await executePersonalTool(call.name, call.input, { conversationId, businessId, turnAuthorization, ownerVoicePref })
          : await executeTool(call.name, call.input, {
            conversationId,
            businessId,
            modelId: model.id,
            turnId,
            turnAuthorization,
            driveClientSeoBatch,
            ownerVoicePref,
          })
        const durationMs = Date.now() - started
        // Harness Gap 2 — observational post-tool hooks (errors swallowed inside).
        runPostToolHooks({
          toolName: call.name,
          input: call.input as Record<string, unknown>,
          model: model.id,
          success: result.success,
          error: result.error,
          durationMs,
        })

        if (!result.success) {
          await captureAgentError(new Error(result.error ?? 'tool_failed'), 'agent.tool.failed', {
            tool: call.name,
            conversationId,
          })
        }

        const toolRecord: ToolRecord = {
          id: call.id,
          toolName: call.name,
          input: call.input,
          output: result.data !== undefined ? { data: result.data } : null,
          status: result.success ? 'success' : 'error',
          durationMs,
          error: result.error ?? null,
        }
        toolRecords.push(toolRecord)
        if (call.name === contractToolName && !result.success) roundContractFailure = toolRecord

        timeline.push({
          t: 'tool', name: call.name, ok: result.success,
          input: compactTimelineInput(call.input),
          result: toolResultPreview(result),
          shot: extractScreenshotUrl(result),
        })

        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          success: result.success,
          error: result.error,
          resultPreview: toolResultPreview(result),
          screenshot: extractScreenshotUrl(result),
        }

        // A tool filed a document as a conversation artifact (save_artifact, SEO
        // report…) → surface it as a FILE CARD in the reply flow, Claude-style.
        const cardRaw = result.success ? (result.data as Record<string, unknown> | undefined)?.artifactCard : undefined
        if (cardRaw && typeof cardRaw === 'object') {
          const card = cardRaw as { id?: unknown; title?: unknown; type?: unknown }
          if (typeof card.id === 'string' && typeof card.title === 'string') {
            timeline.push({ t: 'file', id: card.id, name: card.title, kind: typeof card.type === 'string' ? card.type : 'markdown' })
            yield { type: 'artifact_saved', id: card.id, title: card.title, artifactType: typeof card.type === 'string' ? card.type : 'markdown' }
          }
        }

        if (result.success && !personalMode) {
          void bumpPlaybookForTool(call.name, businessId).catch(() => {})
        }

        if (result.success && result.data != null && typeof result.data === 'object') {
          const d = result.data as Record<string, unknown>
          if (call.name === 'delegate_to_specialist') {
            const role = typeof call.input.role === 'string' ? call.input.role : ''
            if (
              d.awaitingApproval !== true
              && AUTO_RUN_ROLES.has(role as SpecialistRole)
              && typeof d.summary === 'string'
              && d.summary.trim()
            ) {
              autoRanDelegationSummaries.push(d.summary.trim())
            }
          }
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
              select: { status: true, summary: true, costEstimate: true, type: true },
            })
            // Phase 4 — every staged card gets a canonical WorkflowRun (status
            // waiting_owner) the moment it exists, idempotent on the card id.
            // Never relies on the model tracking its own work. Fail-open.
            // Phase 5: actionType drives the workflow-template mapping (an fb_post
            // card joins the conversation's in-flight product_post run at its
            // post_approval step instead of spawning a disconnected run).
            if (row) {
              const kind = packsForPendingActionType(String(row.type ?? ''))[0] ?? 'generic'
              void ensureWorkflowRunForPendingAction({
                pendingActionId: d.pendingActionId,
                conversationId,
                businessId,
                actionType: String(row.type ?? ''),
                kind,
                goal: String(row.summary ?? lastUserText ?? '').slice(0, 500) || `${row.type} card`,
              }).catch(() => {})
            }
            if (row?.status === 'pending') {
              confirmCardsEmitted++
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
            if (!emittedAskCards.some((card) => card.askCardId === d.askCardId)) {
              yield {
                type: 'ask_card',
                askCardId: d.askCardId,
                question: typeof d.question === 'string' ? d.question : '',
                options: d.options as string[],
              }
              emittedAskCards.push({
                type: 'ask_card',
                askCardId: d.askCardId,
                question: typeof d.question === 'string' ? d.question : '',
                options: d.options.map(String),
              })
            }
          }
        }

        // ── Dead-path guard (owner escalation 2026-07-16: "এভাবে না হলে অন্যভাবে") ──
        // Transient retries and the browser oscillation guard handle small slips;
        // this catches STRATEGY-level dead ends: the 3rd failure of the same tool
        // this turn forces an explicit change of approach — the model must not
        // keep grinding the same wall.
        let deadPathNote: string | null = null
        if (!result.success) {
          const sig = `${call.name}:${JSON.stringify(call.input ?? {}).slice(0, 160)}`
          const exactStreak = (deadPathStreaks.get(sig) ?? 0) + 1
          deadPathStreaks.set(sig, exactStreak)
          const toolStreak = (deadPathStreaks.get(call.name) ?? 0) + 1
          deadPathStreaks.set(call.name, toolStreak)
          if ((exactStreak === 2 || toolStreak === 3) && !deadPathNudged.has(call.name)) {
            deadPathNudged.add(call.name)
            deadPathNote =
              `🛑 DEAD PATH: ${call.name} এই টার্নে ${Math.max(exactStreak, toolStreak)} বার ব্যর্থ — এই approach মৃত, আর repeat করা নিষেধ। ` +
              'এখন বাধ্যতামূলক ভিন্ন কৌশল: (ক) সম্পূর্ণ ভিন্ন tool/সূত্রে একই লক্ষ্য, (খ) ক্রম বদলাও (আগে অন্য তথ্য জোগাড়), ' +
              '(গ) কোনোটাই সম্ভব না হলে ask_user card দিয়ে Boss-কে ব্যর্থতার কারণসহ জিজ্ঞেস করো। ' +
              'নতুন কৌশল নেওয়ার আগে এক লাইনে লেখো আগের approach কেন ব্যর্থ হলো।'
          }
        } else {
          deadPathStreaks.delete(call.name)
        }
        const annotated = annotateEmptyResult(result)
        toolResults.push({
          id: call.id,
          name: call.name,
          result: deadPathNote
            ? { ...annotated, deadPath: deadPathNote }
            : annotated,
        })
      }

      messages = appendToolExchange(messages, calls, toolResults)

      // Harness Gap 5 — after a find_tool round, expose the matched tools'
      // schemas for the remaining rounds of THIS turn (any head model).
      // Execution authority unchanged: loaded tools still pass every guard.
      for (const call of calls) {
        if (call.name !== FIND_TOOL_NAME) continue
        const res = toolResults.find((r) => r.id === call.id)?.result as
          | { data?: { matches?: Array<{ name?: unknown }> } }
          | undefined
        const matchNames = (res?.data?.matches ?? [])
          .map((m) => String(m?.name ?? ''))
          .filter(Boolean)
        if (matchNames.length === 0) continue
        const already = new Set<string>([
          ...neutralTools.map((t) => t.name),
          ...dynamicNeutralTools.map((t) => t.name),
        ])
        for (const tool of await resolveToolsByName(matchNames.filter((n) => !already.has(n)))) {
          if (dynamicNeutralTools.length >= MAX_DYNAMIC_TOOLS_PER_TURN) break
          dynamicNeutralTools.push({
            name: tool.name,
            description: tool.description,
            schema: tool.input_schema as object,
          })
        }
      }

      // Harness Gap 1 — one compact recovery instruction after a round with
      // failed tool calls, so the head reasons about the error instead of
      // repeating the identical call or apologising vaguely.
      const failedThisRound = toolRecords
        .slice(-calls.length)
        .filter((r) => r.status === 'error')
        .map((r) => ({ toolName: r.toolName, error: String(r.error ?? '') }))
      const selfCorrectionNudge = buildSelfCorrectionNudge(failedThisRound)
      if (selfCorrectionNudge) {
        messages = [...messages, { role: 'user', content: selfCorrectionNudge }]
      }

      // Never spend another expensive head round after a mandatory step failed.
      // The previous code noticed the failure only AFTER letting the model run
      // again; in the live SEO proof that extra round tried target #2 and wrote a
      // checkpoint, adding cost and visible "same work again" behaviour.
      const terminalContractFailure = roundContractFailure
        ?? findContractToolFailure(contractToolName, toolRecords.slice(-calls.length))
      if (terminalContractFailure) {
        const note = contractToolFailureText(terminalContractFailure)
        const sep = finalText ? '\n\n' : ''
        finalText += sep + note
        timeline.push({ t: 'text', text: note.slice(0, 6000) })
        yield { type: 'text_delta', delta: sep + note }
        break
      }

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

      // Parity with core.ts: a direct-run marketer/content worker already owns
      // the answer. Re-running the head after it returns doubles model work and
      // can mutate the request into a second, contradictory response.
      if (
        autoRanDelegationSummaries.length > 0
        && autoRanDelegationSummaries.length === calls.length
      ) {
        const combined = autoRanDelegationSummaries.join('\n\n')
        const sep = finalText && !finalText.endsWith('\n') ? '\n\n' : ''
        finalText += sep + combined
        timeline.push({ t: 'text', text: combined.slice(0, 6000) })
        yield { type: 'text_delta', delta: sep + combined }
        break
      }
    }

    // Owner canceled mid-turn: do not persist a partial reply or emit 'done'.
    if (canceled) return

    // ── Phase 4 turn-end bookkeeping (all fail-open) ─────────────────────────
    if (!personalMode) {
      // Ask cards join the conversation's single in-flight workflow when that
      // link is unambiguous — the structured reply resolution (server-side
      // AGENT-IOS-001) then binds the owner's answer to the exact run.
      if (emittedAskCards.length > 0) {
        try {
          const active = await listActiveWorkflowRuns(conversationId, 2)
          if (active.length === 1) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (prisma as any).agentAskCard.updateMany({
              where: { id: { in: emittedAskCards.map((c) => c.askCardId) } },
              data: { workflowRunId: active[0].id },
            })
          }
        } catch { /* fail-open */ }
      }
      // AUTO-CHECKPOINT (exit gate "restart-from-zero <1%"): a turn cut off by
      // the serverless deadline mid-work freezes its state itself — never relies
      // on the model calling save_task_checkpoint. One checkpoint per run/turn
      // (writeCheckpoint dedupes on taskRef).
      if (deadlineNudgeSent && toolRecords.length > 0) {
        try {
          const active = await listActiveWorkflowRuns(conversationId, 1)
          const run = active[0]
          const toolsUsed = [...new Set(toolRecords.map((r) => r.toolName))]
          const { writeCheckpoint } = await import('@/agent/lib/checkpoint')
          await writeCheckpoint({
            taskRef: run?.id ?? turnId ?? `turn_${Date.now()}`,
            taskType: run?.kind ?? 'long_agent_task',
            state: 'waiting_for_owner',
            goal: run?.goal ?? lastUserText.slice(0, 200),
            summaryBn: 'সার্ভার সময়সীমায় টার্নটা থেমেছে — কাজ যেখানে ছিল সেখান থেকে resume হবে।',
            doneSteps: toolsUsed.slice(0, 10),
            currentStep: `deadline_paused (last: ${toolRecords[toolRecords.length - 1]?.toolName ?? '?'})`,
            artifacts: [],
            nextActions: ['Boss "continue" বললে ঠিক এখান থেকে চালিয়ে যাও'],
            resumeHint: `শেষ টুল: ${toolRecords[toolRecords.length - 1]?.toolName ?? '?'}। ${lastUserText.slice(0, 300)}`,
            question: 'Continue করব?',
            conversationId,
            businessId,
            workflowRunId: run?.id ?? null,
          })
          if (run) {
            await transitionWorkflowRun({
              runId: run.id, expectedVersion: run.stateVersion,
              toState: 'deadline_paused', cause: 'auto',
              detail: { turnId, tools: toolsUsed.slice(0, 10) },
            }).catch((err: unknown) => {
              if (!(err instanceof WorkflowVersionConflictError)) throw err
            })
          }
        } catch { /* fail-open */ }
      }
    }

    // A turn that produced NOTHING (no text, no tool calls, no cards) must never
    // be saved as a blank owner reply — throw so the cheap-head fallback below
    // answers instead (2026-07-12: gemini-2.5-flash 60k-in/0-out empty turn).
    if (!finalText.trim() && toolRecords.length === 0 && emittedAskCards.length === 0) {
      throw new Error(`empty_head_turn: ${model.id} produced no text, tools or cards`)
    }

    // ── Deadline/abort salvage (2026-07-12 carousel incident) ────────────────
    // A long browser task dies at the 280s serverless cap. Three linked fixes:
    // never save an EMPTY message (context hole → next turn restarts the task),
    // persist a compact progress footer into replayed history, and auto-write a
    // resume checkpoint + signal the client to auto-continue.
    const deadlineHit = Boolean(signal?.aborted) || deadlineNudgeSent
    const taskUnfinished = shouldAutoContinueTurn({
      deadlineHit,
      hasAskCard: emittedAskCards.length > 0,
      tools: toolRecords,
    })
    const browserSteps = toolRecords
      .filter((r) => r.toolName.startsWith('live_browser_') && r.status === 'success')
      .map((r) => {
        const action = typeof r.input?.action === 'string' ? r.input.action : r.toolName.replace('live_browser_', '')
        const target = [r.input?.text, r.input?.option, r.input?.url]
          .filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
          .map((v) => v.slice(0, 60))
          .join(' → ')
        return target ? `${action} "${target}"` : action
      })
    if (!finalText.trim()) {
      const lastTexts = timeline.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text)
      finalText = [
        lastTexts.length ? lastTexts[lastTexts.length - 1].slice(0, 600) : '',
        browserSteps.length
          ? `এই টার্নে ${browserSteps.length}টা ব্রাউজার ধাপ হয়েছে, তারপর সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে।`
          : 'সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে।',
        taskUnfinished ? 'Boss, “continue” বললে ঠিক এখান থেকে কাজ চালিয়ে যাব।' : '',
      ].filter(Boolean).join('\n\n')
      yield { type: 'text_delta', delta: finalText }
    }
    if (taskUnfinished && browserSteps.length > 0) {
      const footer =
        `\n\n📌 কাজের অগ্রগতি (এই টার্নে): ${browserSteps.slice(-8).join(' · ')}` +
        ' — পরের টার্নে এগুলো আবার কোরো না, ঠিক পরের ধাপ থেকে ধরো।'
      finalText += footer
      yield { type: 'text_delta', delta: footer }
    }
    if (taskUnfinished && !toolRecords.some((r) => r.toolName === 'save_task_checkpoint')) {
      try {
        const { writeCheckpoint } = await import('@/agent/lib/checkpoint')
        await writeCheckpoint({
          taskRef: `chat-${conversationId}-auto`,
          taskType: 'browser',
          state: 'waiting_for_owner',
          goal: (lastUserText || 'চলমান ব্রাউজার কাজ').slice(0, 120),
          summaryBn: `টার্নটা সার্ভার-সময়সীমায় থেমেছে — ${browserSteps.length}টা ধাপ হয়ে গেছে; continue পেলেই বাকিটা এগোবে।`,
          doneSteps: browserSteps.slice(-8),
          currentStep: 'ব্রাউজারের সর্বশেষ পেজ — resume-এ আগে live_browser_look দিয়ে নিজের চোখে দেখো',
          artifacts: [],
          nextActions: [
            'live_browser_look দিয়ে এখনকার পেজ দেখো',
            'doneSteps-এ যা আছে তা আবার কোরো না — ঠিক পরের ধাপ থেকে চালাও',
            'main view / campaign list-এ ফেরত যেও না',
          ],
          resumeHint:
            `মূল কাজ: ${(lastUserText || '').slice(0, 300)}। ` +
            `শেষ ধাপগুলো: ${browserSteps.slice(-5).join('; ') || '—'}। একই ট্যাবে state আগের মতোই আছে।`,
          question: 'কাজ চলমান — continue বললে (বা অটো-continue হলে) ঠিক এখান থেকে শেষ করব।',
          conversationId,
        })
      } catch { /* best-effort — the saved reply already carries the progress */ }
    }

    // Prefer OpenRouter's actual billed cost; fall back to the local estimate only
    // when the provider didn't report one (native Gemini/Anthropic).
    const costUsd = totalActualCostUsd != null
      ? roundUsd(totalActualCostUsd)
      : calcModelTurnCostUsd(model, {
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
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens, model: model.id, apiModel: model.apiModel, provider: model.provider, api_rounds: apiRounds > 0 ? apiRounds : undefined, round_costs_usd: roundCostsUsd.length > 0 ? roundCostsUsd : undefined, reasoning: thinkingText.trim() ? thinkingText.trim().slice(0, 12000) : undefined, reasoningMs: thinkingMs ?? undefined, timeline: timeline.length > 0 ? timeline.slice(0, 60) : undefined },
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

    // ── Phase 36: commitment ledger ─────────────────────────────────────────
    // A promised FUTURE action must be backed by durable state created this
    // turn (open task / card / reminder / checkpoint / active run). Shadow:
    // violations are recorded on the trace. Live: the missing focus is
    // CREATED so the promise becomes structurally true — the roadmap's "no
    // announced action without a durable commitment". Fail-open.
    if (interaction && finalText.trim()) {
      try {
        const { checkCommitmentLedger, violatesAddressContract } = await import('@/agent/lib/interaction-policy')
        const durableToolHit = toolRecords.some(
          (r) =>
            r.status === 'success'
            && /^(track_open_task|save_task_checkpoint|set_reminder|log_|post_|propose_|prepare_|dispatch|launch_|publish_|send_|make_plan|run_)/.test(r.toolName),
        )
        const verdict = checkCommitmentLedger(finalText, {
          openTaskTracked: durableToolHit,
          cardStaged: Boolean(actionGraph?.staged) || emittedAskCards.length > 0,
          focusCreatedOrUpdated: workflowRuns.length > 0,
        })
        const badAddress = violatesAddressContract(finalText)
        if (!verdict.ok || badAddress) {
          console.warn(
            `[interaction-ledger] ${!verdict.ok ? `unbacked promise "${verdict.phrase}"` : ''}${badAddress ? ' banned-address' : ''} conv=${conversationId} layer=${interactionMode2}`,
          )
        }
        if (!verdict.ok && interactionMode2 === 'on') {
          const { createFocus, getFocusStack } = await import('@/agent/lib/conversation-focus')
          // Phase 62: if universal intake already created a task focus this turn,
          // the promise is already backed — don't fork a second 'commitment' focus.
          const stack = await getFocusStack(conversationId)
          if (!stack.active) {
            await createFocus({
              conversationId,
              businessId,
              goal: `প্রতিশ্রুতি: ${finalText.slice(0, 160)}`,
              kind: 'commitment',
              completionCriteria: 'Boss-কে জানানো হয়েছে এবং কাজটা প্রমাণসহ শেষ',
              cause: 'commitment_ledger',
            })
          }
        }
        void import('@/agent/lib/tool-telemetry').then((m) =>
          m.logToolEvent({
            toolName: '__interaction__',
            phase: 'proof',
            success: verdict.ok && !badAddress,
            conversationId,
            businessId,
            detail: {
              mode: interaction!.state.mode,
              promised: verdict.promised,
              durable: verdict.durable,
              phrase: verdict.phrase,
              badAddress,
              layer: interactionMode2,
            },
          }),
        ).catch(() => {})
      } catch (err) {
        console.warn('[run-owner-turn] commitment ledger failed open:', err instanceof Error ? err.message : err)
      }
    }

    // ── Phase 62: score the binding outcome + advance the task focus cursor ───
    // recordBindingOutcome writes durable real-production evidence (the ≥98%
    // correct-binding gate is measured on THIS stream, not synthetic fixtures).
    // advanceOwnerTaskFocus moves the non-templated focus's step/blocker so a
    // later "আগের কাজটা চালাও / ৭ দিন পরে" resumes the exact next action. Both
    // fail-open and never block the turn.
    if (continuity && lastUserText) {
      try {
        const { recordBindingOutcome } = await import('@/agent/lib/continuity-outcome')
        await recordBindingOutcome({
          conversationId,
          businessId,
          turnId,
          observation: {
            binding: continuity.decision.binding,
            action: continuity.decision.action,
            ownerCorrectedPrior: interaction?.state.correction ?? false,
          },
          reason: continuity.decision.reason,
        })
      } catch (err) {
        console.warn('[run-owner-turn] binding-outcome record failed open:', err instanceof Error ? err.message : err)
      }
    }
    if (continuityLive) {
      try {
        const { advanceOwnerTaskFocus } = await import('@/agent/lib/conversation-focus')
        const lastDurable = [...toolRecords].reverse().find(
          (r) => r.status === 'success'
            && /^(track_open_task|save_task_checkpoint|set_reminder|post_|propose_|prepare_|dispatch|launch_|publish_|send_|make_plan|run_)/.test(r.toolName),
        )
        const awaitingOwner = emittedAskCards.length > 0 || Boolean(actionGraph?.staged)
        await advanceOwnerTaskFocus({
          conversationId,
          currentStep: lastDurable ? lastDurable.toolName : undefined,
          addCompletedStep: lastDurable ? lastDurable.toolName : null,
          awaitingOwner,
          blocker: awaitingOwner ? 'owner' : null,
          cause: 'turn',
        })
      } catch (err) {
        console.warn('[run-owner-turn] focus advance failed open:', err instanceof Error ? err.message : err)
      }
    }

    void logCost({
      provider: providerToCostProvider(model.provider),
      kind: 'chat',
      units: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        model: model.id,
        apiModel: model.apiModel,
        provider: model.provider,
        cost_source: totalActualCostUsd != null ? 'openrouter_actual' : 'estimate',
      },
      costUsd,
      conversationId,
      jobId: savedMsg.id,
      dedupKey: `chat:msg:${savedMsg.id}`,
    })

    yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, cacheCreation: totalCacheCreationTokens, cacheRead: totalCacheReadTokens, costUsd, needContinue: taskUnfinished, apiRounds: apiRounds > 0 ? apiRounds : undefined, roundCostsUsd: roundCostsUsd.length > 0 ? roundCostsUsd : undefined }
  } catch (err) {
    if (signal?.aborted) {
      // The 280s cap aborted mid-round (the adapter stream throws). Salvage what
      // the turn achieved instead of vanishing: persist the progress so the reply
      // isn't blank, history keeps the context, and the client can auto-continue.
      // Vercel gives ~20s after the abort before killing the function.
      if (!canceled && (finalText.trim() || toolRecords.length > 0)) {
        try {
          const okSteps = toolRecords.filter((r) => r.status === 'success').length
          const salvageSuffix = [
            `⏱️ সার্ভারের সময়সীমায় টার্ন থেমেছে${okSteps > 0 ? ` — ${okSteps}টা ধাপ হয়ে গেছে` : ''}।`,
            'Boss, “continue” বললে ঠিক এখান থেকে কাজ চালিয়ে যাব।',
          ].join('\n')
          const salvageText = [finalText.trim(), salvageSuffix].filter(Boolean).join('\n\n')
          yield { type: 'text_delta', delta: finalText.trim() ? `\n\n${salvageSuffix}` : salvageSuffix }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const savedMsg = await (prisma as any).agentMessage.create({
            data: {
              conversationId, role: 'assistant',
              content: [{ type: 'text', text: salvageText }, ...emittedAskCards],
              tokensIn: totalInputTokens, tokensOut: totalOutputTokens,
              costUsd: totalActualCostUsd != null
                ? roundUsd(totalActualCostUsd)
                : calcModelTurnCostUsd(model, { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheRead: totalCacheReadTokens, cacheWrite: totalCacheCreationTokens }),
              usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, model: model.id, api_rounds: apiRounds > 0 ? apiRounds : undefined, round_costs_usd: roundCostsUsd.length > 0 ? roundCostsUsd : undefined, timeline: timeline.length > 0 ? timeline.slice(0, 60) : undefined },
            },
          })
          const abortedBrowserTurn = toolRecords.some((r) => r.toolName.startsWith('live_browser_'))
          yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, cacheCreation: totalCacheCreationTokens, cacheRead: totalCacheReadTokens, costUsd: 0, needContinue: abortedBrowserTurn && emittedAskCards.length === 0 }
        } catch { /* best-effort — worst case matches the old silent return */ }
      }
      return
    }
    // Model-error salvage (owner report 2026-07-15: an Alibaba content-filter
    // error at minute 6 threw away 44 steps of live-browser work because ONLY
    // the deadline-abort path persisted partial progress). If real work already
    // streamed, persist it BEFORE surfacing a terminal error — a provider error
    // makes the work no less real. Fail-open: worst case matches old behavior.
    const salvagePartialWorkOnError = async (): Promise<void> => {
      if (canceled || (!finalText.trim() && toolRecords.length === 0)) return
      try {
        const okSteps = toolRecords.filter((r) => r.status === 'success').length
        const suffix =
          `⚠️ মডেল-প্রোভাইডারের error-এ টার্নটা থেমেছে${okSteps > 0 ? ` — ${okSteps}টা ধাপের অগ্রগতি সেভ করা আছে` : ''}। ` +
          'Boss, "continue" বললে ঠিক এখান থেকে চালিয়ে যাব।'
        const text = [finalText.trim(), suffix].filter(Boolean).join('\n\n')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const savedMsg = await (prisma as any).agentMessage.create({
          data: {
            conversationId, role: 'assistant',
            content: [{ type: 'text', text }, ...emittedAskCards],
            tokensIn: totalInputTokens, tokensOut: totalOutputTokens,
            costUsd: totalActualCostUsd != null
              ? roundUsd(totalActualCostUsd)
              : calcModelTurnCostUsd(model, { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheRead: totalCacheReadTokens, cacheWrite: totalCacheCreationTokens }),
            usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, model: model.id, api_rounds: apiRounds > 0 ? apiRounds : undefined, round_costs_usd: roundCostsUsd.length > 0 ? roundCostsUsd : undefined, timeline: timeline.length > 0 ? timeline.slice(0, 60) : undefined },
          },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (toolRecords.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (prisma as any).agentToolCall.createMany({
            data: toolRecords.map((r) => ({
              messageId: savedMsg.id, toolName: r.toolName, input: r.input,
              output: r.output, status: r.status, durationMs: r.durationMs, error: r.error,
            })),
          })
        }
      } catch { /* best-effort */ }
    }
    // Phase 3 — PINNED-head identity guard (roadmap: "Grok identity never changes
    // silently"): when the owner explicitly pinned this model on the conversation
    // (tier 'explicit'), a pre-answer crash must NEVER silently switch models.
    // Retry the SAME model once (transient provider blips — the adapter's request
    // ladder already handles shape rejections), then surface a clear incident so
    // the owner knows his pinned model is down and chooses what to do.
    const canRestartHead = shouldRestartHeadAfterFailure({
      text: finalText,
      toolRecords,
      hasAskCard: emittedAskCards.length > 0,
    })
    if (headTier === 'explicit' && canRestartHead) {
      if (sameModelAttempt === 0) {
        console.warn(
          `[run-owner-turn] pinned head ${model.id} failed pre-answer → same-model retry:`,
          err instanceof Error ? err.message : err,
        )
        yield* runAlternateProviderTurn(conversationId, model.id, options, headTier, 1, headVia)
        return
      }
      await captureAgentError(err, 'agent.head.pinned_down', { conversationId, modelId: model.id })
      await salvagePartialWorkOnError()
      const msg = err instanceof Error ? err.message : String(err)
      yield {
        type: 'error',
        message:
          `⚠️ Boss, এই চ্যাটটা **${model.label}**-এ পিন করা, কিন্তু মডেলটা এখন সাড়া দিচ্ছে না — ` +
          `২ বার চেষ্টা করেছি, আর আপনার অনুমতি ছাড়া চুপচাপ অন্য মডেলে যাইনি। ` +
          `একটু পরে আবার মেসেজ করুন, অথবা মডেল-পিকার থেকে অন্য মডেল বেছে নিন। (${msg.slice(0, 200)})`,
      }
      return
    }
    // Rule 3 — head fallback: if a non-cheap head (e.g. Qwen) crashes BEFORE
    // producing any answer text, retry once on the cheap head (DeepSeek) instead of
    // surfacing an error — a surfaced error makes the owner's NEXT message triage UP
    // to Sonnet (the expensive rescue that spiked cost). Guards: only when no answer
    // was streamed yet, and not already on the cheap head (prevents recursion loop).
    const cheapId = process.env.CHEAP_HEAD_MODEL_ID?.trim() || 'or-deepseek-v4-flash'
    // When the CHEAP head is the one that died (owner-hit 2026-07-16: OpenRouter
    // credits ran out → DeepSeek 402 → raw English error on screen, because the
    // only ladder went expensive→cheap), climb the other way instead: the native
    // Gemini head rides a DIFFERENT billing account than every or-* model, so a
    // provider-credit outage on OpenRouter still gets an answer.
    const rescueId = model.id === cheapId
      ? (process.env.HEAVY_HEAD_MODEL_ID?.trim() || 'gemini-3.1-pro')
      : cheapId
    if (canRestartHead && model.id !== rescueId && isKnownModelId(rescueId)) {
      const cheap = getModel(rescueId)
      if (cheap.provider !== 'anthropic' && cheap.supportsTools) {
        console.warn(
          `[run-owner-turn] head ${model.id} failed pre-answer → falling back to ${rescueId}:`,
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
        yield* runAlternateProviderTurn(conversationId, rescueId, options, 'light', 0, 'cheap_fallback')
        return
      }
    }
    await captureAgentError(err, 'agent.provider.error', { conversationId })
    await salvagePartialWorkOnError()
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

  // Worker-only guard (2026-07-12 salah incident): a conversation still PINNED to
  // a headPickable:false model (e.g. Gemini 2.5 Flash LITE, picked from the old
  // picker) must not keep running a head that ignores tools and invents answers.
  // Swap to the heavy head with a visible one-line note — never a silent switch.
  let disabledSwitchNote: string | null = null
  if (getModel(decision.modelId).headPickable === false) {
    const off = getModel(decision.modelId)
    const { heavyHeadModelId } = await import('@/agent/lib/models/head-router')
    const on = getModel(heavyHeadModelId())
    disabledSwitchNote =
      `⚙️ Boss, **${off.label}** এখন শুধু ভেতরের ছোট কাজের worker মডেল — head হিসেবে ` +
      `আর চলে না (টুল ব্যবহার না করে ভুল উত্তর দিত)। এই চ্যাটটা **${on.label}** দিয়ে চালাচ্ছি।\n\n`
    decision.modelId = on.id
    decision.via = `${decision.via}+worker_only_redirect`
  }

  // Owner's Monitor kill-switch per model: a model toggled OFF is unusable even
  // when this chat has it pinned — swap to the enabled fallback IN this same
  // session and tell the owner why in one visible line (never a silent switch,
  // never a manual re-pick).
  try {
    const { resolveEnabledFallback } = await import('@/agent/lib/models/model-enabled')
    const fallbackId = await resolveEnabledFallback(decision.modelId)
    if (fallbackId) {
      const offModel = getModel(decision.modelId)
      const onModel = getModel(fallbackId)
      disabledSwitchNote = `⚙️ Boss, **${offModel.label}** Monitor-এ OFF করা আছে — এই মেসেজটা **${onModel.label}** দিয়ে চালাচ্ছি।\n\n`
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
  if (!options.approveModelSwitch && decision.tier !== 'explicit' && decision.tier !== 'personal' && lastUserText) {
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

  // Phase 6 — ONE turn engine: Anthropic heads run through the SAME neutral
  // orchestrator as every other provider (adapters/anthropic.ts owns the
  // request shaping). The old parallel native loop (core.ts) had to be patched
  // twice for every behavior fix — Phase 4's missing WorkflowRun hooks were
  // found exactly there. Kill switch: AGENT_NATIVE_ANTHROPIC_LOOP=true restores
  // the native loop instantly (no deploy semantics change for other providers).
  if (model.provider === 'anthropic' && process.env.AGENT_NATIVE_ANTHROPIC_LOOP === 'true') {
    yield* runAgentTurn(conversationId, {
      ...options,
      modelId: model.id,
    })
    return
  }

  yield* runAlternateProviderTurn(conversationId, model.id, options, decision.tier, 0, decision.via)
}

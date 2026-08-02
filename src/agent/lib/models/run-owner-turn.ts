/**
 * Owner /agent chat dispatcher — ONLY entry point for per-session model selection.
 * Anthropic models delegate to runAgentTurn (native Claude path).
 * Other providers use normalized adapters with the same tool handlers + claim-verifier.
 */
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { MAX_TOOL_ITERATIONS, BROWSER_TURN_MAX_ITERATIONS, DEEP_TURN_MAX_ITERATIONS, LONG_RUN_TURN_MAX_ITERATIONS, MARKETING_HEAD_TOOL_BUDGET, HEAD_TOOL_BUDGET, AGENT_CONSTITUTION, CONSTITUTION_REINJECT_EVERY, AGENT_STYLE, promptToolTruthEnabled, universalToolPipelineEnabled, speakFirstEnabled, toolMembershipGateMode, STANDARD_HEAD_TOOL_BUDGET, PROGRESS_UPDATE_EVERY, MAX_PROGRESS_NUDGES, headToolBudgetFor, maxIntentNudgesFor, type TurnWorkClass } from '@/agent/config'
import { computeHeadToolCap, narrowToolsToCap } from '@/agent/lib/models/head-tool-cap'
import { runAgentTurn, type AgentEvent, type RunAgentTurnOptions } from '@/agent/lib/core'
import { buildSystemPromptBlocks, CONSTITUTION_REMINDER, STYLE_REMINDER, PROMPT_MODULES, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { findPromptLeaks } from '@/agent/lib/skill-engine/isolation'
import { countTypedToolCalls, dropRepeatedBlocks, stripToolCallMarkup, typedToolCallsInsteadOfCalling } from '@/agent/lib/model-output-sanitize'
import { buildActiveSkills } from '@/agent/lib/skill-engine/runtime'
import {
  claimsCompletion,
  dependencyBlockMessage,
  doneGateMessage,
  filterToolsForSkill,
  skillAllowlist,
  skillDependencyGaps,
  skillDoneMisses,
} from '@/agent/lib/skill-engine/enforcement'
import { getOfficePulse } from '@/agent/lib/office-pulse'
import { buildOwnerActiveTasksContextBlock, buildStaffActiveTasksContextBlock } from '@/agent/lib/owner-active-tasks-context'
import { applyTailCompaction } from '@/agent/lib/tail-compact'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { detectOutboundCallIntent, buildOutboundCallIntakeBlock } from '@/agent/lib/outbound-call-intent'
import { buildReminderTimeHintBlock } from '@/agent/lib/bangla-time'
import { isVoiceInstructionText, ownerRequestedCallback } from '@/agent/lib/voice-instruction'
import { detectVoiceProviderRequest } from '@/agent/lib/voice-provider-intent'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectOwnerHeadTools, packsForPendingActionType, isContinuationText, matchIntentPacks, CORE_PACK, DOMAIN_PACKS } from '@/agent/tools/state-router'
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
import { buildOwnerCorrectionNudge } from '@/agent/lib/owner-correction'
import { newTurnProgressState, nextTurnProgress } from '@/agent/lib/turn-progress'
import { insertControlNote } from '@/agent/lib/control-note-order'
import { cleanVisibleThinking, createThinkingStreamFilter } from '@/agent/lib/visible-thinking'
import { buildPlanProgress, planProgressSignature } from '@/agent/lib/plan-progress'
import { loadLatestPlanProgress } from '@/agent/lib/planner'
import { buildCardStateNote, readPendingCards } from '@/agent/lib/card-state'
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
import { isTurnCancelRequested, getTurnInstructionOrigin } from '@/agent/lib/turn-status'
import { SELF_CONTINUE_DELAY_MS } from '@/agent/lib/self-continue'
import { estimateChars, trimHistoryBySize, SELF_CONTINUE_KEEP_MESSAGES, lastUserTextPeek } from '@/agent/lib/history-trim'
import { chatModeDirective, filterToolsForMode, normalizeChatMode } from '@/agent/lib/chat-mode'
import { adviseForAction, filterToolsForPermissionMode, isFamilyGrantLive, modeVerdict, normalizePermissionMode, permissionModeNote } from '@/agent/lib/permission-mode'
import { effectiveWorkClass, loadRememberedWorkClass, rememberWorkClass } from '@/agent/lib/turn-work-class'
import { capabilityPreflightBlock } from '@/agent/lib/capability-preflight'
import { filterToolsForPlanTurn, isPlanFirstTurn, planFirstNote } from '@/agent/lib/plan-first'
import { buildModelSwitchNote } from '@/agent/lib/model-switch'
import { claimTurnSteeringMessages } from '@/agent/lib/turn-steering'
import { shouldAutoContinueTurn } from '@/agent/lib/continuation-policy'
import {
  isRepeatedOpener,
  shouldNudgeAdapterIntent,
  shouldRestartHeadAfterFailure,
} from '@/agent/lib/turn-loop-policy'
import {
  deriveOwnerTurnAuthorization,
  filterToolsForOwnerTurn,
  ownerTurnAuthorizationNote,
  upgradeAuthorizationForDeliverable,
} from '@/agent/lib/turn-authorization'
import {
  verifyClaimsAgainstLedger,
  buildVerificationReminder,
  detectExplicitInstructionViolations,
  countStagedCards,
  detectMissingCardViolation,
  detectProseChoiceViolation,
  detectRedundantQuestionAfterAnswer,
  detectUncorrectedOpeningPromise,
  detectPhantomApprovalWait,
  detectFabricatedStatViolations,
  detectRoboticStyleViolations,
  detectAsyncCompletionViolation,
  detectToolExecutionClaims,
  summarizeAsyncJobEvidence,
  MAX_VERIFY_RETRIES,
  type ToolLedgerEntry,
} from '@/agent/lib/claim-verifier'
import { getModel, isKnownModelId, resolveHeadCostTier, modelDisplayName } from '@/agent/lib/models/registry'
import { resolveHeadModelId, loadStickyHeadModelId, type HeadTier } from '@/agent/lib/models/head-router'
import { rememberHeadPin } from '@/agent/lib/models/head-pin'
import { DEFAULT_HEAD_MODEL_ID } from '@/agent/lib/models/routing-config'
import { buildModelIdentityNote, loadPreviousTurnModelId } from '@/agent/lib/models/turn-identity'
import { specialistLabel, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import { AUTO_RUN_ROLES } from '@/agent/tools/orchestrator-tools'
import { adapterFor } from '@/agent/lib/models/adapters'
import { logRouteSpan, logToolEvent } from '@/agent/lib/tool-telemetry'
import { AGENT_VERSIONS } from '@/agent/lib/agent-versions'
import { isRoutineGraphEnabled, runRoutineTurnGraph, type RoutineGraphResult } from '@/agent/lib/graph/routine-turn-graph'
import { isActionGraphEnabled, stageExpenseActionGraph, type StageExpenseResult } from '@/agent/lib/graph/action-turn-graph'
import { runTurnGraphShadow } from '@/agent/lib/graph/turn-graph-shadow'
import { resolveConversationContinuity } from '@/agent/lib/continuity-resolver'
import { buildOwnerRequirementNote, deriveOwnerTurnRequirements } from '@/agent/lib/owner-turn-requirements'
import { isJobDeliveryDirective } from '@/agent/lib/job-delivery'
import { contractToolFailureText, findContractToolFailure } from '@/agent/lib/contract-tool-failure'
import {
  contractStatusOrDraft,
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
import { modelProviderToCostProvider } from '@/agent/lib/cost-provider'

export interface RunOwnerTurnOptions extends RunAgentTurnOptions {
  /** Registry model id from AgentConversation.modelId */
  modelId?: string | null
  /**
   * Owner already approved upgrading this turn to a premium model (Sonnet/Opus).
   * Set by the model-switch resume call — skips the approval gate.
   */
  approveModelSwitch?: boolean
  /**
   * P0-1: this turn continues work already in flight (approval resume / internal
   * workflow control). It resumes on the job's pinned head instead of being
   * routed again — see head-pin.ts.
   */
  continuation?: boolean
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

/**
 * Cost audit Phase 8d — should this turn ship the FULL prompt (every module)?
 *
 * Prompt gating trims modules to the turn's tool selection. That saves tokens per
 * turn but moves the cached prefix whenever the selection shifts: two turns of one
 * conversation measured 65 vs 62 sections, so the provider cache missed and the
 * whole ~46k prefix was re-billed at the FULL input rate. On Grok a cached token
 * is $0.20/Mtok vs $1.25 uncached — 6.25x cheaper — so a bigger constant prompt
 * can be far cheaper than a smaller shifting one.
 *
 * Owner-tunable at runtime (KV `prompt.forceFullPrompt`), matching every other
 * owner setting in this repo, so both modes can be A/B measured without a
 * redeploy. Default OFF = today's behaviour, unchanged. Fails open to OFF.
 */
async function promptGatingForceFull(): Promise<boolean> {
  if (process.env.AGENT_FORCE_FULL_PROMPT === 'true') return true
  try {
    // Lives on the model-routing config so the owner flips it from the same
    // Model Control surface as every other routing lever (KV, no redeploy).
    const { getModelRoutingConfig } = await import('@/agent/lib/models/routing-config')
    return (await getModelRoutingConfig()).forceFullPrompt === true
  } catch {
    return false
  }
}

/** Short content fingerprint for the prefix-stability probe (Phase 8b). */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 10)
}

/**
 * Phase 8c — "heading:hash" per markdown section of the cached system prefix.
 *
 * The whole stable prefix is one joined block, so a single hash only says THAT it
 * changed, never WHERE. Splitting on `## ` headings and hashing each section makes
 * the unstable one self-identify when two turns are diffed. Truncated hard so a
 * long prompt can't bloat the cost row.
 */
function sectionFingerprints(systemText: string): string {
  return systemText
    .split(/\n(?=#{2,3} )/)
    .map((section, i) => {
      const heading = (section.match(/^#{2,3} (.+)$/m)?.[1] ?? `part${i}`).slice(0, 40)
      return `${heading}=${shortHash(section)}`
    })
    .join('|')
    .slice(0, 4000)
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

// Speak-first (owner rule 2026-07-25): the ONLY job of the preamble round. It
// runs with no tools and no thinking, so the instruction has to be narrow — one
// line, no numbers, no answer — or a strong head will try to do the whole task
// from memory here, which is exactly the fabrication we gate against everywhere.
const SPEAK_FIRST_INSTRUCTION =
  '[প্রথম লাইন — শুধু এইটুকু] Boss-কে এখনই এক লাইনে বলো তুমি তাঁর কথাটা কী বুঝেছ আর এখন কোথায়/কী দেখতে যাচ্ছ। ' +
  'নিয়ম: ঠিক এক লাইন, "বস," দিয়ে শুরু; কোনো সংখ্যা, উত্তর, তালিকা বা প্রতিশ্রুতি নয় (ডেটা এখনো দেখোনি); ' +
  '"ঠিক আছে/অবশ্যই/নিশ্চয়ই" দিয়ে শুরু নয়। ' +
  // This line reaches his screen before a single tool runs and survives every
  // rewrite — so anything asserted here is unfalsifiable by construction.
  'বিশেষ করে: কার্ড/approval তৈরি বা পাঠানোর কথা এখানে লিখবে না ("card বানাচ্ছি/পাঠাচ্ছি" নয়) — ' +
  'কার্ড আদৌ হবে কিনা এখনো জানো না, আর এই লাইনটা পরে আর বদলানো যায় না। ' +
  'কাজটা এর পরেই করবে — এখন শুধু ওই এক লাইন লেখো।'

const MARKETING_HEAD_WRAPUP_NUDGE =
  '[INTERNAL CONTROL — this is NOT a message from Boss. Never quote it or answer it as one.] '
  + 'টুল ব্যবহারের বাজেট শেষ। এখন আর নতুন টুল কল কোরো না। ' +
  'হাতে যা তথ্য আছে তা দিয়েই মার্কেটিং কাজটা নিজে শেষ করো এবং সংক্ষেপে চূড়ান্ত উত্তর দাও। ' +
  'মার্কেটিং তোমার নিজের বিশেষত্ব — এটা অন্য কাউকে দিয়ো না।'

// ── Announced-intent-but-no-action (adapter heads) ───────────────────────────
// Flash-tier heads (Gemini Flash, DeepSeek…) constantly END a turn mid-task by
// ANNOUNCING the next step ("এখন Manual destination সিলেক্ট করা হবে…") without
// doing it — the owner had to say "continue" after every round (2026-07-12
// Ads Manager incident). core.ts has this net only for zero-tool Claude turns;
// here we check the TAIL of the final text so a turn that already ran tools but
// signs off with a future promise gets pushed to actually act. Bounded once.
const INTERNAL_NUDGE_MARKER =
  // Live 2026-07-27: without this marker the head rendered the nudge as "The
  // Boss's message is: …" and answered it as a scolding from him. A server nudge
  // that reads as Boss talking makes the head thrash — same lesson as the
  // card-state note earlier the same day.
  '[INTERNAL CONTROL — this is NOT a message from Boss. Never quote it or answer it as one.] '

/**
 * The push, and how it ESCALATES.
 *
 * Raising the per-turn push limit for work turns — so a job is not abandoned
 * after a single nudge — produced a loop the same day: the identical sentence
 * arrived again and again, the head noticed it ("the system is repeating the
 * note every time, creating a loop") and thrashed on save_memory instead of
 * doing the step. A repeated instruction is not a stronger instruction. The
 * second push names the repetition and offers the honest exit; the third stops
 * asking altogether.
 */
/**
 * Tools that record what happened rather than move the job forward. A push is
 * never "earned" by one of these.
 */
const BOOKKEEPING_TOOLS = new Set([
  'save_memory', 'update_memory', 'delete_memory', 'graph_remember',
  'save_task_checkpoint', 'track_open_task', 'add_owner_todo', 'manage_work_todos',
])

function adapterActNowNudge(attempt: number): string {
  if (attempt <= 1) {
    return INTERNAL_NUDGE_MARKER
      + 'তুমি বললে পরের ধাপটা করবে, কিন্তু না করেই টার্ন শেষ করে দিয়েছ। ঘোষণা নয় — কাজ। '
      + 'এখনই, এই একই টার্নে, যে ধাপটার কথা বললে সেটা live_browser_act/দরকারি টুল দিয়ে আসলে করো, '
      + 'তারপর ফলাফল নিজের চোখে দেখে Boss-কে জানাও। Boss-কে যেন আবার তাগাদা দিতে না হয়।'
  }
  if (attempt === 2) {
    return INTERNAL_NUDGE_MARKER
      + 'এটা দ্বিতীয়বার — আগেরবারও তুমি ধাপটার কথা বলে থেমে গিয়েছিলে। একই কথা আবার লিখো না। '
      + 'হয় ঠিক ওই ধাপের টুলটা এখনই কল করো, নয়তো সোজা লেখো কেন পারছ না (কোন টুল/তথ্য/অনুমতি নেই) '
      + 'এবং সেখানেই থামো। অপ্রাসঙ্গিক টুল (যেমন save_memory) দিয়ে সময় নষ্ট কোরো না।'
  }
  return INTERNAL_NUDGE_MARKER
    + 'শেষ তাগাদা। আর ঠেলা দেওয়া হবে না। এই টার্নে যা করেছ তার সৎ হিসাব দুই লাইনে দাও — '
    + 'কী হয়েছে, কী বাকি, আর কী দরকার — তারপর থামো।'
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
  const chatMode = normalizeChatMode(options.chatMode)
  // PM-1 — the permission axis, read from the conversation row by the caller.
  // SHADOW in this phase: the head is told, the turn echoes it and every tool
  // event records it, but nothing is withheld or blocked until PM-2.
  const permissionMode = normalizePermissionMode(options.permissionMode)
  let elevationGrant = options.elevationGrant ?? null
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
  // Context occupancy is the provider-reported prompt size for the LAST API
  // round, not the sum billed across every tool round. Cached prompt portions
  // are reported separately by Anthropic/OpenRouter, so add them back.
  let lastContextTokens: number | null = null
  // Reasoning tokens (cost audit Phase 7) — observability only; recorded in units
  // to diagnose the xai under-estimate, does not change billing.
  let totalReasoningTokens = 0
  // Phase 8b: the tool set sent on this turn's FIRST round, fingerprinted into the
  // cost event so prefix drift between turns is measurable rather than inferred.
  let turnToolNames: string[] = []
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
  // Owner ask 2026-07-26: he wants the working TIME on screen the way my own
  // badge shows it ("24m 20s · 9.8k tokens") — live while it works, and kept
  // beside the tokens once the reply lands.
  const turnStartedAtMs = Date.now()

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

  // A SELF-CONTINUE hop resumes from its CHECKPOINT, not from the transcript
  // (owner ruling 2026-07-26): "তুমি নিজেও তো এভাবে কাজ করো না — একটি session শেষ
  // হওয়ার পর পুরো history নতুন করে পড়ো না, আগের notes/progress/checkpoint থেকে শুরু
  // করো"। He is right: the resume directive already carries what was achieved and
  // what is next, so replaying the whole thread only re-bills tokens for context
  // the hop does not need.
  const isSelfContinueHop = /^\[SELF-CONTINUE/m.test(lastUserTextPeek(allRows))
  if (isSelfContinueHop && rows.length > SELF_CONTINUE_KEEP_MESSAGES) {
    rows = rows.slice(-SELF_CONTINUE_KEEP_MESSAGES)
  }

  // Size trim on top of turn-count compaction (owner cost analysis 2026-07-26).
  // Keeping "the last 6 turns" is meaningless when one tool result is a whole
  // audit JSON — his meter showed ~300k tokens re-sent per turn at $0.17 each.
  // Oversized OLDER blocks keep their head and tail with an honest marker; the
  // newest messages stay verbatim.
  const rowsBefore = estimateChars(rows)
  rows = trimHistoryBySize(rows)
  const rowsAfter = estimateChars(rows)
  if (rowsBefore - rowsAfter > 20_000) {
    console.log(`[history-trim] ${Math.round((rowsBefore - rowsAfter) / 1000)}k chars trimmed from replayed history`)
  }

  let messages: NeutralMsg[] = dbRowsToNeutral(rows, askAnswers)

  const recentUserTexts: string[] = []
  for (let i = messages.length - 1; i >= 0 && recentUserTexts.length < 12; i--) {
    const m = messages[i]
    if (m.role !== 'user' || !('content' in m)) continue
    if (typeof m.content === 'string' && m.content.trim()) recentUserTexts.unshift(m.content.trim())
  }
  const lastUserText = recentUserTexts[recentUserTexts.length - 1] ?? ''
  let currentOwnerInstructions = lastUserText
  // Boss just pointed out a fault. One block, this turn only, telling the head
  // how to answer a correction — concede first, rank the complaints himself,
  // name the failure, then go VERIFY instead of arguing. Appended after the
  // cached prefix, so the prompt cache is untouched (self-correct.ts pattern).
  // Status-line state for this turn (see turn-progress.ts). Declared here so the
  // speak-first line before the loop also counts as the model having spoken.
  let progressState = newTurnProgressState()
  let spokeSinceProgress = false
  let lastPlanSignature = ''
  const turnStartedMs = Date.now()
  const ownerCorrectionNudge = buildOwnerCorrectionNudge(lastUserText)
  if (ownerCorrectionNudge) {
    messages = insertControlNote(messages, { role: 'user', content: ownerCorrectionNudge })
  }
  const ownerRequirements = deriveOwnerTurnRequirements(lastUserText)
  // A derived deliverable requirement (client SEO batch / live-browser walk) is
  // itself an action order — the gate must not mark such a message
  // information_only and disarm the very contract it just built (2026-07-25).
  let turnAuthorization = upgradeAuthorizationForDeliverable(
    deriveOwnerTurnAuthorization(lastUserText),
    ownerRequirements.clientSeo || ownerRequirements.liveBrowser,
  )
  // Harness round 2 — refresh the owner's kv-configured hook rules (block/notify)
  // for this turn. Fail-open inside; a broken rules JSON registers nothing.
  await applyOwnerHookRules()
  // Which call voice Boss asked for — resolved from his OWN words and handed to the
  // call tool through server context (server wins over model args). Scans the last 3
  // messages because the call flow is routinely split ("ElevenLabs ভয়েসে…" → number).
  const ownerVoicePref = detectVoiceProviderRequest(recentUserTexts.slice(-3))
  // PA-5R: the boss gave this instruction VERBALLY on a live owner-verified call
  // (🎙️ marker). Server-derived, always set (true/false) so a model-spoofed
  // input field can never win the {...input, ...serverContext} merge.
  const voiceCallInstruction = isVoiceInstructionText(lastUserText)
  // PA-5R precision: a report CALL needs the boss's own call-words in his recent
  // messages. Always-set boolean — a model-spoofed input field can never win.
  const callbackRequested = ownerRequestedCallback(recentUserTexts)

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
        deepWork: ownerRequirements.deepWork,
        deliveryTurn: isJobDeliveryDirective(projectSystemInstructions),
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
      || isJobDeliveryDirective(projectSystemInstructions)
    )

  const [pinnedMemories, relevantMemories, recalledTurns, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext, ownerActiveTasksBlock, staffActiveTasksBlock, toolSelection, businessSnapshot, officePulse, agentControls] = await Promise.all([
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
    // Universal pipeline Phase 2: the Owner Control Center gating must be known
    // BEFORE the prompt is built (the prompt is now derived from the FINAL tool
    // list). Batched here so moving it up costs no extra latency.
    getAgentControls(),
  ])

  // Skill Engine V2 (gated OFF by default) — pick ≤3 on-demand skill procedures for
  // this turn from the message text; '' when disabled or nothing matches (fail-open).
  const activeSkills = suppressWork
    ? { block: '', pinned: null, manifest: null, isolated: null, heldBack: null }
    : await buildActiveSkills(lastUserText, { conversationId })
  // SK-7: when the pinned skill runs isolated, its procedure becomes the STABLE
  // system prompt instead of a volatile add-on. Sending both would ship it twice.
  const activeSkillsBlock = activeSkills.isolated ? '' : activeSkills.block
  // SK-4: a skill that declared what it needs gets checked BEFORE step 0, so a
  // dead connection is one honest sentence rather than a paid tour of the
  // failure (15 steps / 1m36s, watched live 2026-07-26).
  // A head that changed mid-chat must be told it is CONTINUING, not starting.
  // The history is already there; without this the new model reads the transcript
  // as its own and re-introduces itself or redoes a finished step.
  const modelSwitchBlock = suppressWork ? '' : await buildModelSwitchNote(conversationId, model.id)
  const skillDependencyBlock = activeSkills.manifest
    ? dependencyBlockMessage(
        activeSkills.pinned?.skill ?? activeSkills.manifest.name,
        skillDependencyGaps(activeSkills.manifest),
      )
    : ''
  // SK-3: tell the client which skill is pinned, so Boss can see it and change
  // it. Emitted before any work starts — the point is that he knows up front.
  if (activeSkills.pinned) {
    yield {
      type: 'skill_pinned',
      skill: activeSkills.pinned.skill,
      source: activeSkills.pinned.source,
      layer: activeSkills.pinned.layer,
      reason: activeSkills.pinned.reason,
      // SK-7 — say on the wire whether the skill actually got its own prompt.
      isolated: Boolean(activeSkills.isolated),
    }
  } else if (activeSkills.heldBack) {
    // SK-8 — the gate refused it. Boss must be told, because from his side a
    // withheld skill and a broken one look identical, and one of them is
    // waiting on a decision only he can make.
    yield {
      type: 'skill_held_back',
      skill: activeSkills.heldBack.skill,
      state: activeSkills.heldBack.state,
      reason: activeSkills.heldBack.reason,
    }
  }
  // SK-8 — a skill matched and the approval gate refused it. Proven necessary on
  // the first live revoke test (2026-07-27): the skill correctly did not run and
  // the head said nothing, because "explain yourself" lived only in the prompt.
  // On the wire it is drawn whether or not the model cooperates.
  if (activeSkills.heldBack) {
    yield {
      type: 'skill_held_back',
      skill: activeSkills.heldBack.skill,
      state: activeSkills.heldBack.state,
      reason: activeSkills.heldBack.reason,
    }
  }
  let ownerIntentTools = filterToolsForOwnerIntent(lastUserText, toolSelection.tools)
  // Plan-before-work on a big job (owner ask 2026-07-26). The FIRST deep-work
  // turn of a conversation plans and asks everything at once; the staging/write
  // tools are withheld so it cannot half-start the job while "planning".
  const planTurn = suppressWork
    ? false
    : await isPlanFirstTurn({ conversationId, deepWork: ownerRequirements.deepWork })
  if (planTurn) {
    const gated = filterToolsForPlanTurn(ownerIntentTools)
    if (gated.removed.length > 0) {
      console.info('[plan-first] withheld', { conversationId, removed: gated.removed.length })
    }
    ownerIntentTools = gated.tools
  }

  // SK-4: the pinned skill's allowlist. This is the enforcement that actually
  // holds — a read-only audit skill is handed no write tool, so it cannot write
  // whatever it decides. A skill with no declared capabilities does not narrow.
  if (activeSkills.manifest) {
    const gated = filterToolsForSkill(ownerIntentTools, activeSkills.manifest)
    if (gated.removed.length > 0) {
      console.info('[skill-allowlist] withheld', {
        skill: activeSkills.manifest.name,
        removed: gated.removed.length,
      })
    }
    ownerIntentTools = gated.tools
    // SK-7 (found on the first live isolated run, 2026-07-27): the allowlist
    // FILTERS, it never ADDS — so a skill was narrowed to tools the router had
    // not selected in the first place. Watched live: `seo-fixing-own-site` was
    // pinned, `audit_product_seo` and `draft_seo_fixes` were absent, and the
    // head spent a whole round on find_tool to reach its OWN declared tools.
    //
    // A skill declaring a capability is a statement that the job needs it. Same
    // principle as the requirement-contract rule below — whatever the selector
    // decides, a declared requirement brings its own tools. It cannot widen
    // anything: every name added is one the allowlist already permits.
    const missing = (activeSkills.manifest.requiredCapabilities ?? []).filter(
      (n) => !ownerIntentTools.some((t) => t.name === n),
    )
    if (missing.length) {
      try {
        const extra = await resolveToolsByName(missing)
        ownerIntentTools = [
          ...ownerIntentTools,
          ...extra.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        ]
        console.info('[skill-allowlist] supplied', {
          skill: activeSkills.manifest.name,
          added: extra.map((t) => t.name),
        })
      } catch (err) {
        console.warn('[skill-allowlist] tool supply failed:', err instanceof Error ? err.message : err)
      }
    }
  }
  // ── The restrictions this turn must keep, even against find_tool ──────────
  //
  // FOUND 2026-07-27 while wiring the ask_user withholding below. `find_tool`
  // resolves ANY tool in the registry by name and pushes it into the live tool
  // list mid-turn. Every list-time restriction — the skill allowlist included —
  // was therefore a suggestion: a read-only audit skill could search its way to
  // a write tool, and the claim "an absent tool is a guarantee" was not true of
  // this path. I had repeated that claim to Boss; it needed to become true.
  //
  // `turnAllowlist` is the pinned skill's allowlist (null = does not narrow);
  // `turnDenylist` is what this specific turn withheld for a reason of its own.
  // Both are enforced at the dynamic-load site, so the guarantee survives a
  // search. find_tool itself is never denied — a skill must never be trapped.
  const turnAllowlist = activeSkills.manifest ? skillAllowlist(activeSkills.manifest) : null
  const turnDenylist = new Set<string>()

  // ANSWERING A QUESTION IS NOT THE MOMENT TO ASK ANOTHER ONE (owner report
  // 2026-07-27). He answered a card — "এখন কোনো SEO fix কাজ করার দরকার নেই" —
  // and the very next thing he got was a SECOND card, with the work no further
  // along. That is the drip of questions he has objected to from the start
  // ("ask everything ONCE, then work").
  //
  // Withholding the tool is the only version of this that holds. `ask_user` is
  // in ALWAYS_ALLOWED precisely so a skill can never be trapped, so a prompt
  // rule here would be a request the head could decline. It still has every
  // honest way out: say plainly what it needs and stop, or stage a card. And it
  // is one turn only — the next message can ask again if the fork is real.
  if (!listenMode && explicitAskCardId) {
    turnDenylist.add('ask_user')
    const before = ownerIntentTools.length
    ownerIntentTools = ownerIntentTools.filter((t) => t.name !== 'ask_user')
    if (ownerIntentTools.length < before) {
      console.info('[ask-card] withheld ask_user on the answering turn', { conversationId })
    }
  }
  // A CONTRACT MUST NEVER DEMAND A TOOL THE HEAD DOES NOT HAVE (live prod run
  // 2026-07-25). The state router is only shadow-logging in production, so the
  // legacy selector picked the tools — and for "Do a Deep SEO Audit -
  // almatraders.com" it loads no SEO audit tools at all. The contract then
  // demanded run_website_seo_audit, the head could not call it, and Boss got a
  // progress line instead of an audit. Whatever the selector decides, a derived
  // requirement brings its own tools.
  // SK-6: with a skill pinned, its `requiredCapabilities` ARE the tool list —
  // that is the allowlist enforcement, and a hardcoded SEO injection here would
  // hand back tools the pinned skill deliberately does not have (a read-only
  // audit skill being handed the crawl tools is exactly the failure SK-4 exists
  // to prevent). `seo-fixing-client-site` already declares all three.
  if (!listenMode && !activeSkills.pinned && (ownerRequirements.clientSeo || driveClientSeoBatch)) {
    const present = new Set(ownerIntentTools.map((t) => t.name))
    const needed = ['run_website_seo_audit', 'check_website_seo_audit', 'save_artifact'].filter((n) => !present.has(n))
    if (needed.length) {
      try {
        const extra = await resolveToolsByName(needed)
        ownerIntentTools = [
          ...ownerIntentTools,
          ...extra.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        ]
      } catch (err) {
        console.warn('[run-owner-turn] requirement tool injection failed:', err instanceof Error ? err.message : err)
      }
    }
  }
  const forceFullPrompt = await promptGatingForceFull()

  // ── Universal pipeline Phase 2 — ONE tool list, decided before the prompt ───
  // Bug A: the prompt's `activeToolNames` used to be the PRE-filter list while
  // the model received the post-filter/post-cap list, so prompt modules taught
  // tools that were never shipped → the head called them → `unknown_tool`.
  // The whole filter → controls-gate → provider-cap pipeline now runs HERE, and
  // both the prompt and the model read the SAME final list.
  // Phase 7 kill switch: AGENT_OWNER_INTENT_GATE=false disables the owner-intent
  // mutation filter (and its note) without a deploy.
  const intentGateOn = process.env.AGENT_OWNER_INTENT_GATE !== 'false'
  const selectedTools = filterToolDefsByControls(
    intentGateOn ? filterToolsForOwnerTurn(ownerIntentTools, turnAuthorization) : [...ownerIntentTools],
    agentControls,
  )
  // xAI hard-caps tool definitions at 200 per request — the owner head carried 201,
  // so EVERY Grok-4.20 turn 400'd ("Maximum tools limit reached") and silently fell
  // back to DeepSeek (2026-07-13 outage, diagnosed via error.metadata.raw).
  // P10 — the cap must also cover the xAI-DIRECT head (provider 'xai', slug
  // 'grok-4.20', which does NOT start with 'x-ai/'). Pure helper so parity is
  // unit-testable (see head-tool-cap.ts).
  // Phase 4 — the trim is RELEVANCE-aware (core + find_tool + this turn's routed
  // packs survive first, never a blind tail slice) and reserves headroom for the
  // schemas find_tool may load later in the turn (Bug B).
  const toolCap = computeHeadToolCap(model)
  const capKeepNames = [...CORE_PACK, FIND_TOOL_NAME]
  const capRelevantNames = toolSelection.router === 'state'
    ? toolSelection.tools.map((t) => t.name)
    : matchIntentPacks(lastUserText).flatMap((p) => [...DOMAIN_PACKS[p]])
  const narrowed = narrowToolsToCap(selectedTools, toolCap, {
    keepNames: capKeepNames,
    relevantNames: capRelevantNames,
    dynamicHeadroom: MAX_DYNAMIC_TOOLS_PER_TURN,
  })
  const cappedTools = narrowed.tools
  if (narrowed.trimmed.length > 0) {
    console.warn(
      `[run-owner-turn] ${model.apiModel} caps tools at ${toolCap} (static budget ${narrowed.effectiveCap}) — dropping ${narrowed.trimmed.length}: ${narrowed.trimmed.join(', ')}`,
    )
  }
  /** The EXACT names shipped to the model this turn (before find_tool loads). */
  const shippedToolNames = listenMode ? [] : cappedTools.map((t) => t.name)
  // Phase 0 baseline telemetry: what the PROMPT was told about vs what the model
  // actually got. With AGENT_PROMPT_TOOL_TRUTH on this is empty by construction;
  // with the kill switch flipped it measures the real Bug-A drift in production.
  const promptToolNames = promptToolTruthEnabled()
    ? shippedToolNames
    : (listenMode ? [] : ownerIntentTools.map((t) => t.name))
  const promptToolMismatch = promptToolNames.filter((n) => !shippedToolNames.includes(n))

  // The mode's own rules ride with the project instructions. The words explain
  // the mode to the head; the tool filter above is what actually enforces it.
  const modeDirective = chatModeDirective(chatMode)
  // A broken tool is announced at step 0, not discovered at step 15 (owner watched
  // the head spend 1m36s and three tools finding out the website DB was unreachable).
  const deadCapabilityBlock = capabilityPreflightBlock(shippedToolNames)
  const promptArgs = {
    projectInstructions:
      [
        modeDirective,
        deadCapabilityBlock,
        skillDependencyBlock,
        modelSwitchBlock,
        planTurn ? planFirstNote() : '',
        projectSystemInstructions,
      ]
        .filter(Boolean).join('\n\n') || null,
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
    isolatedSkill: activeSkills.isolated ?? undefined,
    // SK-6: with a skill pinned, global modules that narrate a JOB step aside.
    skillPinned: Boolean(activeSkills.pinned),
    intakeContextBlock,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
    ownerActiveTasksBlock: ownerActiveTasksBlock || undefined,
    staffActiveTasksBlock: staffActiveTasksBlock || undefined,
    activeGroups: listenMode ? [] : toolSelection.groups,
    // Phase 2 (Bug A): the prompt is gated on the FINAL shipped list, so a
    // module can never teach a tool the model does not have.
    activeToolNames: promptToolNames,
    // Phase 8d: when on, ship every prompt module so the cached prefix is
    // byte-identical turn to turn (see promptGatingForceFull).
    forceFullPrompt: forceFullPrompt || undefined,
    businessSnapshot,
    officePulse,
    headTier,
    tailSummary,
  }

  const { stable, volatile } = buildSystemPromptBlocks(promptArgs)
  // SK-7 enforcement — the isolation claim is MEASURED on the prompt that was
  // actually built, not asserted. A leak means the swap silently did not happen
  // (a caller passing both, a module pushed outside the branch), and the owner
  // would be paying for the pollution he asked to remove without any sign of it.
  if (activeSkills.isolated) {
    const stableText = stable.map((b) => b.text).join('')
    const leaks = findPromptLeaks(stableText, PROMPT_MODULES)
    console.info('[skill-isolation]', {
      conversationId,
      skill: activeSkills.isolated.skillName,
      promptChars: stableText.length,
      leaks: leaks.length ? leaks : undefined,
    })
  }
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
  // Universal pipeline Phase 6: a tool-incapable model (e.g. Qwen 2.5 VL 72B)
  // gets ZERO tools by necessity. That used to be silent, so the head answered
  // work questions from memory as if it had checked. Make it honest instead.
  if (!listenMode && !model.supportsTools) {
    volatileSections.push(
      `[সীমাবদ্ধতা] এই মডেলটা (${model.label}) টুল চালাতে পারে না — এই টার্নে তোমার কোনো টুল নেই। ` +
      'লাইভ ডেটা লাগলে বানিয়ে বোলো না; Boss-কে সোজাসুজি বলো যে এই মডেলে টুল চলে না, ' +
      'অন্য মডেল বেছে নিলে আসল তথ্য এনে দিতে পারবে।',
    )
  }
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
  // SK-6: a pinned skill owns its own procedure, so the SEO-specific contract
  // lines are not repeated here (see buildOwnerRequirementNote).
  const requirementNote = !listenMode
    ? buildOwnerRequirementNote(ownerRequirements, { skillPinned: Boolean(activeSkills.pinned) })
    : ''
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
  // Owner Control Center: gate OFF-capability tools + add the "ask owner to
  // enable, don't improvise" note and autonomy preference. Fail-open.
  // Cost audit 2026-07-24: the controls note goes into the VOLATILE per-turn
  // block, NOT the system prompt — appended to system it made the cached stable
  // prefix change whenever the owner toggled a capability, busting the provider
  // prompt cache for every conversation at once. Same text, cache-safe placement.
  const controlsNote = controlsPromptNote(agentControls)
  if (controlsNote) volatileSections.push(controlsNote)
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
  const systemText = systemBlocksToText(stable)
  // P1-1 context-compiler SHADOW: run the SPEC-041 compiler over the exact
  // segments this turn uses and record provenance + token-budget verdicts into
  // the per-turn span spine (route.context_compile). Observe-only — the model
  // input above is untouched. Fire-and-forget; a shadow failure never blocks.
  void (async () => {
    const { contextCompilerMode, shadowCompileOwnerContext } = await import('@/agent/lib/context-compile-shadow')
    if (contextCompilerMode() === 'off') return
    const shadow = shadowCompileOwnerContext({
      stableBlocks: stable.map((b) => b.text),
      volatileText: systemBlocksToText(volatile),
      requestText: lastUserText ?? '',
    })
    const { logToolEvent } = await import('@/agent/lib/tool-telemetry')
    await logToolEvent({
      surface: 'owner',
      toolName: 'context_compile',
      success: shadow.stableWithinBudget && shadow.initialWithinBudget,
      latencyMs: 0,
      conversationId,
      turnId: turnId ?? undefined,
      phase: 'route',
      detail: {
        mode: 'shadow',
        contractVersion: shadow.compiled.contractVersion,
        stableTokens: shadow.stableTokens,
        initialRequestTokens: shadow.initialRequestTokens,
        stableWithinBudget: shadow.stableWithinBudget,
        initialWithinBudget: shadow.initialWithinBudget,
        cacheablePrefixTokens: shadow.compiled.cacheablePrefixTokens,
        bundles: shadow.compiled.provenance.map((p) => ({ id: p.id, kind: p.kind, tokens: p.tokens })),
      },
    })
  })().catch((err) => console.warn('[context-compile-shadow] failed:', err instanceof Error ? err.message : err))
  // Listen mode: withhold ALL business tools. This is the deterministic guarantee
  // (prompt rules alone don't hold the cheap heads back) that a feelings message
  // can't be answered with generate_image / ads / list_owner_todos etc. — the head
  // has nothing to call, so it must simply respond in words.
  // Chat mode is enforced HERE, by withholding tools — a prompt rule is a
  // request, an absent tool is a guarantee (same lesson as listen mode above).
  // 'সরাসরি' loses the planning tools; 'প্ল্যান' loses everything that changes
  // the world, so it can research and propose but not act.
  const { getCapability } = await import('@/agent/tools/capability-manifest')
  const isReadOnlyTool = (name: string) => getCapability(name)?.mode === 'read'
  // "নিজে থেকে কাজ চালিয়ে যাও — আমাকে জিজ্ঞেস করতে হবে না" is an instruction, not
  // a preference (owner bug 2026-07-26: told exactly that, the head still stopped
  // on an ask card and did nothing). Withhold ask_user for the turn — the same
  // deterministic technique as listen mode, because a prompt rule alone does not
  // hold. Approval CARDS for money/publish are untouched: those are safety, not
  // question-asking.
  const noQuestionsTurn = /(?:জিজ্ঞেস\s*কর(?:তে|ার)?\s*(?:হবে\s*না|দরকার\s*নেই|লাগবে\s*না)|নিজে\s*থেকে(?:ই)?\s*(?:কাজ\s*)?(?:চালিয়ে|শেষ|কর)|do\s+not\s+ask|don'?t\s+ask|without\s+asking)/i
    .test(lastUserText)
  const modeFiltered = filterToolsForMode(chatMode, anthropicToolsToNeutral(cappedTools), isReadOnlyTool)
  // PM-2 — the permission mode becomes a GUARANTEE here. Plan mode promises that
  // nothing changes, and the only way to keep that promise is for the changing
  // tools not to be in the model's hands at all. (Careful does not withhold: its
  // answer to a write is a card, and a tool that was never offered cannot be
  // staged into one.)
  const permissionFiltered = filterToolsForPermissionMode(permissionMode, modeFiltered, isReadOnlyTool)
  if (permissionFiltered.removed.length > 0) {
    console.info('[run-owner-turn] permission mode withheld tools:', {
      permissionMode,
      count: permissionFiltered.removed.length,
    })
  }
  const neutralTools = listenMode
    ? []
    : noQuestionsTurn
      ? permissionFiltered.tools.filter((t) => t.name !== 'ask_user')
      : permissionFiltered.tools
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
  // Head tool diet safety (cost audit Phase 2): if an active workflow's bound
  // tool was dieted out of the static pack, load its schema dynamically (same
  // cache-safe append as a find_tool hit) instead of silently skipping the
  // binding — deterministic template flows must not change under the diet.
  if (stepBinding && !neutralTools.some((t) => t.name === stepBinding.toolName)) {
    const [missing] = await resolveToolsByName([stepBinding.toolName])
    if (missing) {
      dynamicNeutralTools.push({
        name: missing.name,
        description: missing.description,
        schema: missing.input_schema as object,
      })
    }
  }
  const boundToolName =
    stepBinding
      && [...neutralTools, ...dynamicNeutralTools].some((t) => t.name === stepBinding.toolName)
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
      // Universal pipeline Phase 0 — the measurement Bug A never had: what the
      // PROMPT was told about vs what the model was actually SHIPPED. Any name
      // in `promptToolMismatch` is a tool the prompt taught but the payload
      // lacks — the exact recipe for an `unknown_tool` call.
      promptToolCount: promptToolNames.length,
      shippedToolCount: shippedToolNames.length,
      promptToolMismatch: promptToolMismatch.length ? promptToolMismatch : null,
      // Phase 4 — a provider-cap trim is now visible and relevance-ordered.
      capTrimmed: narrowed.trimmed.length ? narrowed.trimmed : null,
      capStaticBudget: Number.isFinite(narrowed.effectiveCap) ? narrowed.effectiveCap : null,
      // Phase 6 — which universal-pipeline behaviours were live this turn.
      universalPipeline: universalToolPipelineEnabled(),
      membershipGate: toolMembershipGateMode(),
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
    /** Stable envelope code — lets the loop tell a broken call from a mis-argued one. */
    errorCode?: string
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
  // First-line contract (owner rule 2026-07-25): did the head SAY something to
  // Boss before it started running tools? One backstop nudge per turn.
  let preambleSpoken = false
  // Bounded once per turn: a model that types its calls gets one plain correction.
  let typedToolCallRetries = 0
  let preambleNudgeSent = false
  // The spoken first line, kept as a FLOOR for finalText: a verification or
  // act-now retry resets the draft, and without this the line Boss already saw
  // would vanish from the persisted message on reload.
  let preambleText = ''
  // …and its timeline slot, which must survive every supersede walk-back. The
  // owner-facing client projects prose from the LAST non-superseded text entry,
  // so when a verify retry marked the most recent text (the preamble, since no
  // tool-round prose existed yet) the line vanished from the finished message
  // even though Boss had already watched it stream (live-verified 2026-07-25).
  let preambleTimelineIndex = -1
  /**
   * finalText MINUS the spoken first line — i.e. "did this turn actually produce
   * work output?". Every did-we-produce-anything guard must ask THIS, not
   * finalText: seeding the preamble into finalText silently blinded them, and a
   * round that returned only reasoning then ended the turn with the first line
   * as the whole reply (owner hit it live 2026-07-25 on "creative-এ best idea দাও").
   */
  const answerBody = (): string => {
    const t = finalText.trim()
    const p = preambleText.trim()
    if (!p) return t
    return t.startsWith(p) ? t.slice(p.length).trim() : t
  }
  // Speak-first: the ground-before-answer guarantee now runs AFTER round 0
  // instead of forcing a tool call that silences it. One retry per turn.
  let groundingNudgeSent = false
  // Announced-intent guard (global terminal/failure rules live in turn-loop-policy).
  let intentNudges = 0
  /** Successful tool count when the last act-now push was sent — a push is only
   *  earned again once the head has actually moved since. */
  let successCountAtLastIntentNudge = -1
  // OWNER ASK 2026-07-26: "ekta part er jnne koyek ta dhap sesh kore amk age
  // update daw, erpor abr onno kaje jaw." Today the head can run seven tool
  // rounds and speak once at the end. Asking politely in the prompt is a
  // request; counting rounds is a guarantee. These track how many tool rounds
  // have passed with nothing said to Boss, and cap how often we intervene.
  let roundsSinceOwnerUpdate = 0
  let progressNudges = 0
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
    // `lead: true` marks the spoken FIRST line (speak-first, owner rule
    // 2026-07-25). Position is not a safe signal — a progress draft can also be
    // the first text entry — so the flag is what the presentation builder reads.
    | { t: 'text'; text: string; state?: 'superseded'; lead?: true }
    | { t: 'verify'; attempt: number; max: number }
    | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; shot?: string }
    | { t: 'file'; id: string; name: string; kind?: string }
  const timeline: TimelineEntry[] = []
  /** Mark the most recent DRAFT as superseded — never the spoken first line. */
  const supersedeLastDraft = () => {
    for (let ti = timeline.length - 1; ti >= 0; ti--) {
      if (ti === preambleTimelineIndex) continue
      const te = timeline[ti]
      if (te.t === 'text') { te.state = 'superseded'; break }
    }
  }
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
  // Universal pipeline Phase 6: the class comes from the REGISTRY, not a
  // `provider === 'anthropic'` check — a Grok/DeepSeek head used to run with no
  // round budget at all purely because it wasn't Claude.
  const headCostTier = resolveHeadCostTier(model)
  const isPremiumHead = headCostTier === 'premium'
  // 'standard' heads get a budget only under the universal-pipeline flag, so
  // production behaviour is unchanged until the owner turns it on.
  const standardBudgetLive = universalToolPipelineEnabled() && headCostTier === 'standard' && !isMarketingHead
  const delegateOnlyNeutral = neutralTools.filter((t) => t.name === 'delegate_to_specialist')
  let headToolRounds = 0
  // Phase 3 — resolved once per turn so the mode is stable across rounds and
  // appears verbatim in the route span.
  const membershipGateMode = toolMembershipGateMode()
  let budgetNudgeSent = false
  let cardStagedNudgeSent = false
  let deadlineNudgeSent = false
  // S0 — whose instruction this turn executes. An unattended Plan-Driver step
  // stamps 'owner_policy' on its turn row, so every tool call in this loop meets
  // the autonomy ladder + money cap instead of inheriting Boss's own authority.
  // One read per turn; null (the normal chat case) changes nothing.
  const turnInstructionOrigin = await getTurnInstructionOrigin(turnId)
  let canceled = false
  /// Confirm cards yielded this turn — precondition for the card-shape
  /// verifiers (an emitted card legitimately carries the ask).
  let confirmCardsEmitted = 0
  // Live-browser turns raise this cap (see BROWSER_TURN_MAX_ITERATIONS) — a real
  // UI task is 15–30 look→act rounds and must not die silently at the default cap.
  // Deep/full work and server-driven delivery turns get the same treatment: the
  // crawl → poll → report → links → present chain does not fit in 8 rounds.
  // A turn Boss put in a working mode (প্ল্যান-ড্রাইভ) is a WORK SESSION, not a
  // chat reply: it gets the long-run budget so it can grind a real job to the
  // end in one visible session instead of being chopped into engine steps.
  const rememberedWorkClass = await loadRememberedWorkClass(conversationId)
  const rememberedLongRun = rememberedWorkClass?.workClass === 'long_run'
  // The প্ল্যান-ড্রাইভ chip used to be the only way to reach the long-run budget,
  // and that chip is gone (one mode chip, owner 2026-07-28). A durable plan is
  // not something he should have to declare in advance anyway — the chat BECOMES
  // a work session the moment a plan is actually enrolled, which is what the
  // remembered work class carries forward from the turn that ran execute_plan.
  const longRunTurn = rememberedLongRun
  const deepTurn = ownerRequirements.deepWork || driveClientSeoBatch || isJobDeliveryDirective(projectSystemInstructions)
  // The turn's work class drives BOTH how many rounds it may take and how big
  // the head's tool budget is. They used to disagree — 60 rounds allowed, tools
  // confiscated at 8 — and the head budget always won (owner: "non-stop kaj
  // ekhono hoy na", 2026-07-26).
  const derivedWorkClass: TurnWorkClass = longRunTurn ? 'long_run' : deepTurn ? 'deep' : 'chat'
  // A job keeps its size (owner, live 2026-07-27): a two-word answer to the
  // agent's own card used to shrink a 60-round job back to an 8-round chat reply
  // at exactly the moment the work began. Inheritance can only WIDEN, and the
  // memory expires.

  const workClass: TurnWorkClass = effectiveWorkClass(derivedWorkClass, rememberedWorkClass)
  if (derivedWorkClass !== 'chat') void rememberWorkClass(conversationId, derivedWorkClass)
  let maxIterations =
    workClass === 'long_run'
      ? LONG_RUN_TURN_MAX_ITERATIONS
      : workClass === 'deep'
        ? DEEP_TURN_MAX_ITERATIONS
        : MAX_TOOL_ITERATIONS
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
    lastContextTokens = g.usage.inputTokens
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

  // ── SPEAK FIRST, THEN WORK (owner rule 2026-07-25) ─────────────────────────
  // Boss wants the Claude-app shape: read the message, SAY what you understood,
  // then work step by step. Two rounds of preview testing proved a prompt rule
  // cannot deliver it — with a tool obviously needed, every head (Grok, DeepSeek,
  // Qwen, Sonnet) goes straight to the tool call and speaks only afterwards, so
  // Boss watches a spinner and has no idea whether his message landed.
  // So the harness guarantees it instead of hoping for it: one short tool-free
  // round whose ONLY job is that line. Thinking is off and no tools are offered,
  // so it is a few dozen output tokens against an already-cached prefix; the
  // line is streamed instantly and seeded into the transcript, so the model does
  // not repeat it. Same behaviour on every model — the harness, not the model.
  // Skipped for listen mode, tool-free turns, internal continuations and short
  // acknowledgements, which answer instantly anyway.
  if (
    speakFirstEnabled()
    && !listenMode
    && model.supportsTools
    && neutralTools.length > 0
    && maxIterations > 0
    && !internalTurn
    && lastUserText.trim().length >= 12
    && !isContinuationText(lastUserText)
    && !signal?.aborted
  ) {
    try {
      let line = ''
      for await (const ev of adapter.streamTurn({
        apiModel: model.apiModel,
        system: systemText,
        messages: [...messages, { role: 'user', content: SPEAK_FIRST_INSTRUCTION }],
        tools: [],
        thinking: 'none',
        signal,
        cacheKey: conversationId,
      })) {
        if (ev.type === 'text_delta') {
          line += ev.text
          // The model is narrating — the status line stays quiet while it does.
          if (ev.text.trim()) spokeSinceProgress = true
          yield { type: 'text_delta', delta: ev.text }
        } else if (ev.type === 'usage') {
          totalInputTokens += ev.inputTokens
          totalOutputTokens += ev.outputTokens
          totalCacheCreationTokens += ev.cacheWrite ?? 0
          totalCacheReadTokens += ev.cacheRead ?? 0
          apiRounds++
        }
      }
      // The opening line is a whole round of its own, so it can carry the same
      // leaked markup — clean it before it becomes the first thing Boss reads.
      line = stripToolCallMarkup(line).trim()
      if (line) {
        preambleSpoken = true
        preambleText = line
        finalText = line
        preambleTimelineIndex = timeline.length
        timeline.push({ t: 'text', text: line, lead: true })
        // Explicit marker so a client never has to GUESS which prose was the
        // opening line (iOS clears narration on tool_start and on a verify
        // rewrite — this line must survive both).
        yield { type: 'preamble', text: line }
        // In the transcript as the assistant's own words — it continues from
        // here instead of greeting Boss a second time.
        messages = [...messages, { role: 'assistant', content: line }]
      }
    } catch (err) {
      // A preamble failure must never cost Boss the actual answer.
      console.warn('[run-owner-turn] speak-first failed open:', err instanceof Error ? err.message : err)
    }
  }

  // ── What is ACTUALLY in front of Boss (owner incident 2026-07-26) ──────────
  // The head used to assert card state from memory — "কার্ড অনুমোদনের অপেক্ষায়
  // আছি" with no card in existence, or for work already applied. It now reads
  // the answer instead. Appended at the END of messages (the self-correct
  // pattern) so the cached prompt prefix is untouched — this is a per-turn
  // volatile fact and must never sit in the cached bytes.
  const pendingCardsAtStart = await readPendingCards(conversationId)
  messages = insertControlNote(messages, { role: 'user', content: buildCardStateNote(pendingCardsAtStart) })

  // PM-1 — the agent must never be unaware of the mode it is in (owner
  // requirement 2026-07-27: if he takes a plan and then asks for the work
  // without switching, it has to say which mode it is in and which one would do
  // it, instead of answering vaguely). Same slot as the card-state note: after
  // the cached prefix, marked INTERNAL CONTROL.
  messages = insertControlNote(messages, { role: 'user', content: permissionModeNote(permissionMode, elevationGrant) })

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
      // Set below, after the round's calls are known: the model wrote tool calls
      // as prose and made none.
      let typedToolCallsThisRound = false
      // Reasoning produced in THIS round only — one timeline segment before this
      // round's tool calls, keeping cross-round order faithful.
      let iterThinking = ''
      // Thinking streams token by token, so markup in it needs a filter that
      // survives a call split across deltas. One per round: what it holds back
      // belongs to this round and is released when the round ends.
      const thinkingStream = createThinkingStreamFilter()

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
      const overBudget = isMarketingHead && headToolRounds >= headToolBudgetFor(MARKETING_HEAD_TOOL_BUDGET, workClass)
      // Premium Claude head over its (smaller) budget → delegate-only, per the
      // core.ts Option A guard this loop now owns (Phase 6). Inert when the
      // pack carries no delegate tool (narrow modes) — the normal caps apply.
      const premiumOverBudget =
        isPremiumHead && delegateOnlyNeutral.length > 0 && headToolRounds >= headToolBudgetFor(HEAD_TOOL_BUDGET, workClass)
      // Phase 6 — the same discipline for cheap 'standard' heads (Grok/DeepSeek),
      // which previously ran unbounded. Delegate-only when a delegate tool is in
      // the pack, otherwise tools are stripped and it must answer (same shape as
      // the marketing wrap-up).
      const standardOverBudget =
        standardBudgetLive && headToolRounds >= headToolBudgetFor(STANDARD_HEAD_TOOL_BUDGET, workClass)
      // Models whose provider offers no tool-calling (e.g. Qwen 2.5 VL 72B on
      // OpenRouter) get a chat/vision-only turn — sending tool defs would 4xx
      // the request and bounce the owner to the cheap-head fallback.
      // A staged approval card ends the working part of the turn: everything
      // past it is spend on work the owner may reject (and it buries the card).
      const cardStaged = confirmCardsEmitted > 0 || emittedAskCards.length > 0
      const budgetedTools =
        nearDeadline || overBudget || cardStaged || emptyRoundRetries >= 2 || !model.supportsTools
        || (standardOverBudget && delegateOnlyNeutral.length === 0)
          ? []
          : premiumOverBudget || standardOverBudget
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

      // A contract may never demand a tool this round did not ship (owner watched
      // it happen 2026-07-26: the head spent its tool budget, the budget strip
      // above emptied the list, it then called the contract's run_website_seo_audit
      // and the membership gate refused it — "বাধ্যতামূলক ধাপ সফল হয়নি" over a tool
      // the server itself had taken away). The demand and the means travel together.
      const contractToolMissing = Boolean(
        requestedContractTool && !budgetedTools.some((t) => t.name === requestedContractTool),
      )
      const iterationTools = contractToolMissing
        ? [
            ...budgetedTools,
            ...(await resolveToolsByName([requestedContractTool as string])).map((t) => ({
              name: t.name,
              description: t.description,
              schema: t.input_schema as object,
            })),
          ]
        : budgetedTools
      if (iteration === 0) turnToolNames = iterationTools.map((t) => t.name)
      // Phase 3 — the EXACT set the provider was given this round; the
      // membership gate below refuses anything outside it.
      const roundToolNames = new Set(iterationTools.map((t) => t.name))
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
      // Speak-first note: `tool_choice: 'required'` is what MECHANICALLY silences
      // round 0 — a forced tool call leaves the provider no room for text. The
      // first attempt at this fix dropped the force so the head could speak, and
      // that REGRESSED the turn loop: a text-only round 0 means calls.length === 0,
      // which ENDS the turn, so the head announced "… চালাচ্ছি" and stopped
      // (owner hit it live in the preview minutes after deploy).
      // The preamble now has its own dedicated round BEFORE this loop, so Boss
      // already has his line and the force can stay exactly as it was.
      const forceGroundingToolChoice = groundingRequiredThisRound
      if (!nearDeadline && overBudget && !budgetNudgeSent) {
        budgetNudgeSent = true
        messages = [...messages, { role: 'user', content: MARKETING_HEAD_WRAPUP_NUDGE }]
      }
      if (cardStaged && !cardStagedNudgeSent) {
        cardStagedNudgeSent = true
        messages = [...messages, { role: 'user', content: CARD_STAGED_WRAPUP_NUDGE }]
      }
      if (!nearDeadline && standardOverBudget && !premiumOverBudget && !budgetNudgeSent) {
        budgetNudgeSent = true
        messages = [...messages, { role: 'user', content: MARKETING_HEAD_WRAPUP_NUDGE }]
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
        // Marked internal: this arrives as a `user` message every few rounds, and
        // unmarked the head read it as Boss speaking again — live 2026-07-27 its
        // own thinking said "The latest message is the reminder of the
        // constitution and style rule", mid-loop.
        messages = [...messages, {
          role: 'user',
          content: INTERNAL_NUDGE_MARKER
            + (AGENT_STYLE ? `${CONSTITUTION_REMINDER}\n${STYLE_REMINDER}` : CONSTITUTION_REMINDER),
        }]
      }

      for await (const ev of adapter.streamTurn({
        apiModel: model.apiModel,
        system: systemText,
        messages,
        tools: iterationTools,
        thinking: model.thinking,
        signal,
        // Sticky prompt-cache routing (Phase 8): keep every round of THIS
        // conversation on the server that already holds its cached prefix.
        // Ignored by adapters that don't do sticky routing.
        cacheKey: conversationId,
        parallelToolCalls: iterationTools.length > 0 ? packParallelToolCalls : undefined,
        // Phase 5 §D: bind the FIRST round of a deterministic mutating step to
        // its named tool (sequential by policy above); every later round is
        // auto so the model can verify, summarize, or ask.
        toolChoice:
          roundBoundToolName && iterationTools.length > 0
            ? { name: roundBoundToolName }
            : forceGroundingToolChoice
              ? 'required'
              : undefined,
      })) {
        if (ev.type === 'text_delta') {
          if (thinkingText && thinkingMs == null && thinkingStartedAt) {
            thinkingMs = Date.now() - thinkingStartedAt
          }
          iterationText += ev.text
          // NOTE: sanitising happens once on the finished round below, not here.
          // A tool-call fragment arrives split across deltas, so a per-delta
          // strip would miss it — and the whole round's prose is emitted as one
          // block, so waiting costs Boss nothing.
        } else if (ev.type === 'thinking_delta') {
          // Surface DeepSeek/Qwen reasoning as the same live "Thought for Ns" block
          // the native Claude head produces — the UI (AgentApp) already handles this.
          if (!thinkingStartedAt) thinkingStartedAt = Date.now()
          thinkingText += ev.text
          iterThinking += ev.text
          // …but never RAW. Unlike the round's prose, thinking is yielded token by
          // token, so the once-per-round cleanup below can only fix what gets
          // stored — and on 2026-07-28 his screen filled live with hundreds of
          // `<parameter name="fullScanAll…">` while the turn was still running.
          // The filter holds back an opener until it resolves, so a call split
          // across deltas cannot slip through in pieces.
          const safeThinking = thinkingStream.push(ev.text)
          if (safeThinking) yield { type: 'thinking_delta', delta: safeThinking }
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
          const roundContextTokens = ev.inputTokens + (ev.cacheRead ?? 0) + (ev.cacheWrite ?? 0)
          // Anthropic emits a second output-only usage event at message_delta.
          // Never let that zero-input event erase the message_start measurement.
          if (roundContextTokens > 0) lastContextTokens = roundContextTokens
          totalReasoningTokens += ev.reasoningTokens ?? 0
          apiRounds++
          if (ev.costUsd != null) {
            totalActualCostUsd = (totalActualCostUsd ?? 0) + ev.costUsd
            roundCostsUsd.push(roundUsd(ev.costUsd))
          }
        }
      }

      // RAW TOOL-CALL MARKUP MUST NEVER REACH BOSS (seen live 2026-07-27 on the
      // Qwen head: "<get_website_catalog> <arg_key>scope</arg_key> …</tool_call>"
      // sitting inside a Bangla sentence). The model wrote its call as text
      // instead of emitting a structured one; the work recovered on the next
      // round, but he was shown machine syntax and no reply should ever contain
      // it. Cleaned ONCE here, on the finished round, before it reaches the
      // timeline or either emission path — a fragment spans several deltas, so
      // this is the only place it can be done completely.
      const rawIterationText = iterationText
      // Same repair pass, second failure mode: the model answering twice in one
      // round. Third sighting, and the style rule against it shipped before the
      // last one — so it is repaired, not requested.
      iterationText = dropRepeatedBlocks(stripToolCallMarkup(iterationText))
      if (iterationText !== rawIterationText) {
        console.info('[model-output] stripped tool-call markup from visible text', {
          conversationId,
          model: model.id,
        })
      }
      // Qwen, on the owner's marketing turn 2026-07-27: seven calls TYPED as
      // ```tool call fences and two actually made. Stripping the markup fixes
      // what he sees and hides what went wrong — a round that narrates its calls
      // does no work, which is exactly the missing think → tool → update rhythm
      // he reported. Remembered here, acted on where the turn would otherwise end.
      // Live on 2026-07-28, minutes after the first fix shipped: Qwen made ONE
      // real call and TYPED three more in the same round. The boolean form reads
      // that as "it called, fine" — so the count is what decides. More typed than
      // called means most of the work was narrated, and the turn must not settle.
      typedToolCallsThisRound =
        typedToolCallsInsteadOfCalling({ rawText: rawIterationText, realToolCallCount: calls.length })
        || countTypedToolCalls(rawIterationText) > calls.length
      if (typedToolCallsThisRound) {
        console.info('[model-output] model TYPED its tool calls instead of calling them', {
          conversationId,
          model: model.id,
        })
      }
      // Record this round's reasoning as a timeline segment BEFORE its tool calls.
      // Plumbing out of the thought before it is shown or stored: he asked to
      // watch the reasoning, not to read our control banners and verifier
      // notes back to himself (visible-thinking.ts).
      // Release anything the live filter was still holding, then clean the
      // stored copy the same way: markup out first, harness-chatter out second.
      const heldThinking = thinkingStream.flush()
      if (heldThinking) yield { type: 'thinking_delta', delta: heldThinking }
      const shownThinking = cleanVisibleThinking(stripToolCallMarkup(iterThinking))
      if (shownThinking) timeline.push({ t: 'think', text: shownThinking.slice(0, 4000) })
      // Round's visible text joins the timeline too, so the persisted stream keeps
      // the true text↔step order after reload (ChronoFlow) — same as core.ts.
      if (iterationText.trim()) timeline.push({ t: 'text', text: iterationText.slice(0, 6000) })
      // Tool-round prose streams right away so the live view and reload both keep
      // the narration between steps; final-round text is emitted AFTER the
      // requirement-contract checks below (which may replace it).
      // The model sometimes restates the spoken opening line in its first tool
      // round — close paraphrase, not an exact copy, so seeding the transcript
      // did not stop it and no equality check could catch it. Dropped here,
      // before Boss sees it: the tool-round prose arrives as ONE block, so there
      // is nothing half-streamed to take back. Only ever the first prose after
      // the preamble; every later progress line is left alone.
      if (
        iterationText.trim()
        && calls.length > 0
        && preambleText.trim()
        && !answerBody()
        && isRepeatedOpener(preambleText, iterationText)
      ) {
        console.info('[speak-first] dropped a restated opening line', { conversationId })
        iterationText = ''
      }
      if (iterationText.trim() && calls.length > 0) {
        const sep = finalText && !finalText.endsWith('\n') ? '\n\n' : ''
        finalText += sep + iterationText
        yield { type: 'text_delta', delta: sep + iterationText }
        // Boss heard something this round — the progress clock starts over.
        roundsSinceOwnerUpdate = 0
        // First-line contract: the model spoke to Boss BEFORE running tools —
        // exactly the Claude-app shape he asked for. Recorded so the backstop
        // below stays quiet and telemetry can score compliance per model.
        preambleSpoken = true
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
          supersedeLastDraft()
          messages = [
            ...messages,
            ...(iterationText.trim() ? [{ role: 'assistant' as const, content: iterationText }] : []),
            ...lateSteering.map((item) => ({ role: 'user' as const, content: item.prompt })),
          ]
          continue
        }
        // The model TYPED its tool calls. It did no work this round, and the
        // markup has already been stripped, so without this the turn ends on a
        // confident paragraph about work that never happened — the exact pair of
        // symptoms the owner reported on 2026-07-27 (machine syntax on screen,
        // and the missing think → tool → update rhythm).
        //
        // Sent back ONCE, with the interface named plainly. `toolChoice: required`
        // is not used: it would force a call even when the right move is to
        // answer, and the aim is a model that uses the interface, not one that is
        // cornered into it.
        if (
          !signal?.aborted
          && typedToolCallsThisRound
          && typedToolCallRetries < 1
          && iteration < maxIterations - 1
        ) {
          typedToolCallRetries++
          messages = [
            ...messages,
            { role: 'assistant', content: rawIterationText },
            {
              role: 'user',
              content:
                INTERNAL_NUDGE_MARKER
                + 'তুমি টুল কলগুলো টেক্সট হিসেবে লিখে ফেলেছ — ওভাবে কিছুই চলে না, Boss শুধু কোড দেখেন। '
                + 'টুল ব্যবহার করতে হলে tool-call ইন্টারফেস দিয়েই ডাকো (মেসেজে ```tool call বা JSON লিখবে না)। '
                + 'এখন সত্যিই দরকারি টুলগুলো ডাকো, নয়তো টুল ছাড়াই সোজা উত্তর দাও।',
            },
          ]
          finalText = preambleText
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
          && !answerBody()
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
        // A push is only earned by PROGRESS. Without this a head that answers
        // every push with text alone gets pushed again immediately, notices the
        // repetition, and thrashes — exactly what happened live on 2026-07-27
        // once work turns were allowed more than one push.
        // Bookkeeping does not count as moving. In the 2026-07-27 loop the head
        // answered every push by saving memory — a tool that succeeds, changes
        // nothing about the job, and would otherwise buy it another push forever.
        const successfulToolCount = toolRecords
          .filter((r) => r.status === 'success' && !BOOKKEEPING_TOOLS.has(r.toolName))
          .length
        if (
          !signal?.aborted
          && !deadlineNudgeSent
          && intentNudges < maxIntentNudgesFor(workClass)
          && (intentNudges === 0 || successfulToolCount > successCountAtLastIntentNudge)
          && iterationText.trim()
          && shouldNudgeAdapterIntent({
            text: iterationText,
            toolRecords: toolRecords.map((r) => ({ status: r.status, toolName: r.toolName, errorCode: r.errorCode })),
            hasAskCard: emittedAskCards.length > 0,
            ownerRequestedAction: turnAuthorization.allowMutations,
            // "ফল এলে জানাব" is honest when a crawl or worker job really is
            // queued — the hop system comes back for it. With nothing queued it
            // is a promise the ending turn can never keep, so the policy needs
            // the evidence, not the sentence (owner, live 2026-07-28).
            hasPendingAsyncJob: summarizeAsyncJobEvidence(toolRecords).pendingJobSeen,
          })
        ) {
          intentNudges++
          successCountAtLastIntentNudge = successfulToolCount
          messages = [
            ...messages,
            { role: 'assistant', content: iterationText },
            { role: 'user', content: adapterActNowNudge(intentNudges) },
          ]
          finalText = preambleText
          continue
        }
        // Speak-first grounding retry (owner rule 2026-07-25): round 0 is no
        // longer forced to call a tool (that is what silenced it), so the
        // ground-before-answer guarantee is enforced HERE instead. The head spoke
        // its understanding but read nothing — send it straight back to read,
        // once. Net shape: speak → read → answer, with the guarantee intact.
        if (
          !signal?.aborted
          && !nearDeadline
          && groundingRequiredThisRound
          && !groundingNudgeSent
          && iterationTools.length > 0
        ) {
          groundingNudgeSent = true
          if (iterationText.trim()) {
            // Keep the spoken line in the transcript — it is the reply Boss already saw.
            messages = [...messages, { role: 'assistant', content: iterationText }]
          }
          messages = [
            ...messages,
            {
              role: 'user',
              content:
                '[লাইভ ডেটা বাধ্যতামূলক] এটা লাইভ-ডেটার প্রশ্ন — স্মৃতি থেকে সংখ্যা/অবস্থা বলা নিষেধ। '
                + 'এখনই relevant read tool (get_/list_/check_/recommend_…) চালিয়ে আসল মানটা আনো, তারপর উত্তর দাও।',
            },
          ]
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
          // A staging tool's pending action is a real card too — count it, or a
          // truthful "approval card বানালাম" after a SUCCESSFUL draft_seo_fixes
          // is punished as an unbacked promise.
          const stagedCards = countStagedCards(toolRecords)
          if (violations.length === 0 && emittedAskCards.length === 0 && confirmCardsEmitted === 0 && stagedCards === 0) {
            violations.push(...detectMissingCardViolation(iterationText.trim()))
            // On a turn that ANSWERS one of his cards, a prose question must not
            // be promoted into ANOTHER card — that safety rule was manufacturing
            // the very drip he objects to. Same detection, opposite remedy.
            violations.push(...(matchedAskCard
              ? detectRedundantQuestionAfterAnswer(iterationText.trim())
              : detectProseChoiceViolation(iterationText.trim())))
            // The speak-first line is streamed before any tool runs and survives
            // every rewrite (finalText resets to it below), so a promise made
            // there can never be corrected by a rewrite — the reply must own it.
            violations.push(...detectUncorrectedOpeningPromise(preambleText, iterationText.trim()))
          }
          // The mirror case: parking Boss on a card that does not exist. Counted
          // from the server, plus anything staged during this turn.
          if (violations.length === 0) {
            violations.push(...detectPhantomApprovalWait(
              iterationText.trim(),
              pendingCardsAtStart.length + stagedCards + emittedAskCards.length + confirmCardsEmitted,
            ))
          }
          // Queued work is not finished work: block "অডিট সম্পন্ন" while the only
          // evidence is a 200 ms queue insert (owner incident 2026-07-25).
          if (violations.length === 0) {
            violations.push(
              ...detectAsyncCompletionViolation(
                iterationText.trim(),
                summarizeAsyncJobEvidence(toolRecords),
              ),
            )
          }
          // A reply that NAMES a tool and says it ran must have that tool in the
          // ledger (owner incident 2026-07-26: "start_fix_campaign executed।
          // Campaign ID: seo-fix-almatraders-20260726" — only find_tool had run).
          if (violations.length === 0) {
            violations.push(
              ...detectToolExecutionClaims(
                iterationText.trim(),
                toolRecords.map((r) => r.toolName),
                (name) => Boolean(getCapability(name)),
              ),
            )
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
            supersedeLastDraft()
            timeline.push({ t: 'verify', attempt: verifyRetries, max: MAX_VERIFY_RETRIES })
            finalText = preambleText
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
            ? contractStatusOrDraft(batchStatus.facts, iterationText)
            : '⚠️ Boss-এর explicit memory request এখনো save হয়নি; তাই সম্পন্ন বলছি না।'
        } else if (batchStatus && !batchStatus.requiredTool && !batchStatus.facts.packCompleted) {
          // No legal tool means the VPS worker owns the current step. Never let
          // the model fill that wait with unrelated prose.
          iterationText = contractStatusOrDraft(batchStatus.facts, iterationText)
        }
        // The contract replaced the model's draft → keep the persisted timeline
        // truthful too: mark the draft superseded (same presentation as verify
        // retries) and record what was actually said instead.
        if (iterationText !== preContractText) {
          if (preContractText.trim()) {
            supersedeLastDraft()
          }
          if (iterationText.trim()) timeline.push({ t: 'text', text: iterationText.slice(0, 6000) })
        }
        if (iterationText) {
          const sep = finalText && !finalText.endsWith('\n') ? '\n\n' : ''
          finalText += sep + iterationText
          yield { type: 'text_delta', delta: sep + iterationText }
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
        // ── Universal pipeline Phase 3 — membership gate (Bug D) ──────────────
        // Nothing between the provider response and executeTool ever checked
        // that the model called a tool it was actually GIVEN. A hallucinated or
        // stale name reached the registry and came back as a bare failure the
        // head then reported to Boss as "this capability doesn't exist".
        // Now: a name outside this round's shipped set is refused with a
        // find_tool redirect — the whole registry is one hop away, so the honest
        // answer is "let me look it up", never "we can't".
        // find_tool itself always passes (it is the escape hatch).
        if (
          membershipGateMode !== 'off'
          && roundToolNames.size > 0
          && call.name !== FIND_TOOL_NAME
          && !roundToolNames.has(call.name)
        ) {
          void logToolEvent({
            surface: 'owner', toolName: call.name, success: false,
            errorClass: 'membership_gate', errorCode: 'tool_not_shipped',
            conversationId, turnId: turnId ?? undefined, phase: 'route',
            detail: {
              reason: 'membership_gate', mode: membershipGateMode,
              modelId: model.id, headTier: headTier ?? null,
              shippedCount: roundToolNames.size,
            },
          })
          if (membershipGateMode === 'on') {
            const blocked = {
              success: false as const,
              error:
                `"${call.name}" এই টার্নে তোমার টুল-লিস্টে নেই। ` +
                `আগে find_tool দিয়ে খুঁজে নাও (পুরো রেজিস্ট্রি এক হপ দূরে) — ` +
                `Boss-কে "এই সক্ষমতা নেই" বলবে না।`,
            }
            toolRecords.push({
              id: call.id, toolName: call.name, input: call.input,
              output: null, status: 'error', durationMs: 0, error: blocked.error,
            })
            toolResults.push({ id: call.id, name: call.name, result: blocked })
            yield {
              type: 'tool_end', id: call.id, name: call.name,
              success: false, error: blocked.error, resultPreview: blocked.error,
            }
            continue
          }
          // 'shadow' — logged above, execution proceeds unchanged.
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
        // ── PM-2: the permission mode decides, before anything runs ─────────
        // Plan mode already has no effect tools, so reaching here means the head
        // guessed a name — refuse it with the remedy attached, never a bare
        // "cannot". Careful mode turns an ordinary write into a real card,
        // through the same staging machinery AIOS uses, so Boss gets something
        // to tap instead of a lecture.
        const permissionTier = (await import('@/agent/lib/autonomy-task-catalog'))
          .taskClassForTool(call.name, {
            mode: getCapability(call.name)?.mode ?? 'write',
            risk: getCapability(call.name)?.risk ?? 'medium',
            domain: getCapability(call.name)?.domain ?? 'unclassified',
          })
        const permissionVerdict = modeVerdict({
          mode: permissionMode,
          tier: permissionTier.tier,
          taskClass: permissionTier.taskClass,
          // Only an EXPLICIT tool→family mapping may be lifted by a grant. A
          // fallback class is a risk floor, so passing the grant here would let a
          // reminders grant clear the Careful-mode card for an unmapped write
          // like delete_memory (review bot, #667).
          grant: permissionTier.explicit ? elevationGrant : null,
          now: Date.now(),
        })
        if (permissionVerdict === 'blocked') {
          const advice = adviseForAction({
            mode: permissionMode,
            tier: permissionTier.tier,
            taskClass: permissionTier.taskClass,
            grant: elevationGrant,
            now: Date.now(),
            whatBn: `\`${call.name}\` দিয়ে যা করতে চাইছ`,
          })
          const blocked = { success: false as const, error: advice.reasonBn }
          toolRecords.push({
            id: call.id, toolName: call.name, input: call.input,
            output: null, status: 'error', durationMs: 0, error: blocked.error,
            errorCode: 'permission_mode_blocked',
          })
          toolResults.push({ id: call.id, name: call.name, result: blocked })
          yield {
            type: 'tool_end', id: call.id, name: call.name,
            success: false, error: blocked.error, resultPreview: blocked.error,
          }
          continue
        }
        // Re-emit tool_start with the parsed input so the UI shows the real target.
        yield { type: 'tool_start', id: call.id, name: call.name, input: call.input }
        const started = Date.now()
        // Careful mode: an R1/R2 write that would normally just run gets staged
        // as a card instead. Stage-mode tools already make their own card, and
        // R3/R4 are handled by the ladder above — this only covers the everyday
        // writes that Standard lets through silently.
        // The verdict above used the TURN's snapshot of the grant. If the row no
        // longer confirms it — Boss revoked from another request mid-turn — the
        // `auto` it produced is stale, and Careful must go back to staging a card
        // instead of letting the registry refuse the call (review bot, #667).
        const verdictAfterConfirmation = permissionVerdict === 'auto'
          && permissionTier.explicit
          && elevationGrant
          && permissionMode !== 'plan'
          && !(await (await import('@/agent/lib/standing-grant'))
            .confirmGrantStillCovers(conversationId, permissionTier.taskClass))
          ? modeVerdict({
              mode: permissionMode,
              tier: permissionTier.tier,
              taskClass: permissionTier.taskClass,
              grant: null,
              now: Date.now(),
            })
          : permissionVerdict
        const carefulNeedsCard =
          verdictAfterConfirmation === 'card'
          // Cancelling a permission is never staged — that would trap Boss inside
          // the grant he just asked to end (the registry exempts it too).
          && call.name !== 'revoke_standing_permission'
          && permissionMode === 'careful'
          // Any tier whose verdict is `card` gets one. Gating on R1/R2 sent an
          // explicitly mapped R3 write (`set_staff_task_due`) to the registry's
          // flat refusal instead of a card (review bot, #667).
          && getCapability(call.name)?.mode === 'write'
          && conversationId
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
        // B6 — a LIVE, family-scoped grant is the owner's own standing yes for
        // this exact family, so the enforcement layer must not stage a card he
        // has already signed. Without this the grant changed the verdict and
        // nothing else: the card still appeared, and the promise on the grant
        // card ("this runs without a card for 15 minutes") was false.
        // Everything the grant does NOT name still goes through the guard, and
        // R4 is never granted in the first place.
        // EXPLICIT mapping only. A fallback task class is a risk floor, not a
        // statement of what the tool does: `camera_speak` falls back to
        // `internal-reminders`, so a reminders grant would otherwise have let it
        // speak over the office camera with no card (review bot, #667).
        const grantCoversThisCall =
          permissionVerdict === 'auto'
          && permissionTier.explicit
          && isFamilyGrantLive(elevationGrant, permissionTier.taskClass, Date.now())
          // …and still true in the DATABASE. A turn runs for a while; Boss can
          // revoke from the app or another chat meanwhile, and the in-memory
          // snapshot would keep authorising work he already cancelled.
          && await (await import('@/agent/lib/standing-grant'))
            .confirmGrantStillCovers(conversationId, permissionTier.taskClass)
        const aiosGuard = !ownerIntentViolation && !grantCoversThisCall && enforcementEnabled()
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
              ...(turnInstructionOrigin ? { instructionOrigin: turnInstructionOrigin } : {}),
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
          : carefulNeedsCard
          ? await stageEnforcedToolApproval({
              conversationId: conversationId!,
              businessId: String(businessId ?? 'ALMA_LIFESTYLE'),
              turnId,
              toolCallId: call.id,
              toolName: call.name,
              toolInput: call.input as Record<string, unknown>,
              model: model.id,
              klass: 'unknown',
            })
          : personalMode
          ? await executePersonalTool(call.name, call.input, { conversationId, businessId, turnAuthorization, ownerVoicePref, voiceCallInstruction, callbackRequested, permissionMode: permissionMode, elevationGrant: elevationGrant })
          : await executeTool(call.name, call.input, {
            conversationId,
            businessId,
            modelId: model.id,
            turnId,
            // PM-1: recorded on every tool event so "why did this run / why did
            // this ask" has an answer later. Not enforced until PM-2.
            permissionMode,
            // The registry recomputes the verdict; without the grant it would
            // block a Careful-mode call the grant had just authorised.
            elevationGrant,
            turnAuthorization,
            driveClientSeoBatch,
            ownerVoicePref,
            voiceCallInstruction,
            callbackRequested,
            // Unattended Plan-Driver step → 'owner_policy', so the autonomy
            // ladder and the money cap apply to work Boss is not watching.
            ...(turnInstructionOrigin ? { instructionOrigin: turnInstructionOrigin } : {}),
          })
        // A revoked grant must stop covering calls immediately — the row is
        // cleared, but this turn holds the grant in memory and would keep
        // bypassing for every later call in the same turn.
        if (call.name === 'revoke_standing_permission' && result.success) {
          const cleared = (result.data as { cleared?: string[]; remaining?: string[] } | undefined)
          const remaining = cleared?.remaining ?? []
          elevationGrant = remaining.length && elevationGrant
            ? { ...elevationGrant, families: remaining }
            : null
        }
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
          errorCode: 'errorCode' in result ? result.errorCode : undefined,
        }
        toolRecords.push(toolRecord)
        // A durable plan just started running: from here this chat IS a work
        // session, and it gets the long-run budget the retired প্ল্যান-ড্রাইভ chip
        // used to grant — earned by the plan actually being enrolled rather than
        // declared in advance (one mode chip, owner 2026-07-28).
        if (call.name === 'execute_plan' && result.success) {
          void rememberWorkClass(conversationId, 'long_run')
        }
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

      // ── Progress updates between phases (owner ask 2026-07-26) ─────────────
      // "ekta part er jnne koyek ta dhap sesh kore amk age update daw, erpor abr
      // onno kaje jaw." Today the head can run seven tool rounds and speak once,
      // at the end — Boss watches a spinner and learns nothing until it is over.
      //
      // Counting rounds is the guarantee; asking in the prompt was the request
      // that never held. After PROGRESS_UPDATE_EVERY silent tool rounds the head
      // is told to write two lines and carry on. Bounded, so a long job gets a
      // handful of updates rather than a running commentary, and the ask is
      // explicitly NOT a stop: it must keep working in the same turn.
      roundsSinceOwnerUpdate++
      if (
        !signal?.aborted
        && !nearDeadline
        && roundsSinceOwnerUpdate >= PROGRESS_UPDATE_EVERY
        && progressNudges < MAX_PROGRESS_NUDGES
      ) {
        progressNudges++
        roundsSinceOwnerUpdate = 0
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              `[সিস্টেম নোট] Boss ${PROGRESS_UPDATE_EVERY}টা ধাপ ধরে তোমার কাছ থেকে কিছু শোনেননি — `
              + 'এখন দুই লাইনে বলো: এ পর্যন্ত কী পেলে/করলে, আর এরপর কী করছ। '
              + 'সংখ্যা থাকলে সংখ্যা দাও। এটা থামার সংকেত নয় — বলেই কাজ চালিয়ে যাও, '
              + 'আর অনুমতি চাইতে হবে না।',
          },
        ]
        continue
      }

      // ── First-line contract (owner rule 2026-07-25) ────────────────────────
      // Boss wants what the Claude app does: understand the message, SAY the
      // understanding in one line, THEN work step by step. Reasoning models put
      // that line inside their hidden thinking (Boss never sees it) and jumped
      // straight to tools, so all he saw was a spinner. The prompt now demands a
      // spoken first line; this is the deterministic backstop — one nudge per
      // turn when a model still went silent, so the reply it finally writes
      // leads with the understanding instead of dumping raw output.
      if (!preambleSpoken && !preambleNudgeSent) {
        preambleNudgeSent = true
        void logToolEvent({
          surface: 'owner', toolName: '__preamble__', success: false,
          errorClass: 'preamble_missing', conversationId,
          turnId: turnId ?? undefined, phase: 'route',
          detail: { modelId: model.id, headTier: headTier ?? null, round: iteration },
        })
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              '[স্টাইল সংশোধন] তুমি টুল চালানোর আগে Boss-কে এক লাইনও বলোনি — তিনি শুধু স্পিনার দেখেছেন। '
              + 'এখনকার উত্তরটা শুরু করো এক লাইনে তুমি তাঁর কথা কী বুঝেছ ও কী দেখেছ তা দিয়ে ("বস, … চাইছেন — … দেখে নিলাম"), '
              + 'তারপর ফলাফল। "ঠিক আছে/অবশ্যই" দিয়ে শুরু কোরো না। পরের ধাপগুলোতে টুল চালানোর আগে ওই এক লাইন আগে লিখবে।',
          },
        ]
      }

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
        // A SEARCH MUST NOT WIDEN WHAT THIS TURN IS ALLOWED TO DO. Without this
        // the skill allowlist was list-time only: a read-only audit skill could
        // find_tool its way to a write tool, and "an absent tool is a guarantee"
        // was untrue exactly where it was quoted most.
        const permitted = matchNames.filter((n) => {
          if (already.has(n)) return false
          if (turnDenylist.has(n)) return false
          if (turnAllowlist && !turnAllowlist.has(n)) return false
          return true
        })
        const refused = matchNames.filter((n) => !already.has(n) && !permitted.includes(n))
        if (refused.length > 0) {
          console.info('[find-tool] refused outside this turn’s permissions', { conversationId, refused })
        }
        for (const tool of await resolveToolsByName(permitted)) {
          if (dynamicNeutralTools.length >= MAX_DYNAMIC_TOOLS_PER_TURN) break
          dynamicNeutralTools.push({
            name: tool.name,
            description: tool.description,
            schema: tool.input_schema as object,
          })
        }
        // Phase 4 (Bug B) — the provider cap was computed over the STATIC list
        // only, so dynamic loads could push a capped head (xAI: 200) back over
        // the limit and 400 the very next round. The static budget already
        // reserves MAX_DYNAMIC_TOOLS_PER_TURN slots; this is the belt-and-braces
        // re-check — drop the OLDEST dynamic entries if we somehow exceed.
        if (Number.isFinite(toolCap)) {
          while (neutralTools.length + dynamicNeutralTools.length > toolCap && dynamicNeutralTools.length > 0) {
            const dropped = dynamicNeutralTools.shift()
            console.warn(`[run-owner-turn] dynamic tool over provider cap — dropped ${dropped?.name}`)
          }
        }
      }

      // Harness Gap 1 — one compact recovery instruction after a round with
      // failed tool calls, so the head reasons about the error instead of
      // repeating the identical call or apologising vaguely.
      const failedThisRound = toolRecords
        .slice(-calls.length)
        .filter((r) => r.status === 'error')
        .map((r) => ({ toolName: r.toolName, error: String(r.error ?? '') }))
      // The live checklist. Re-read after each tool round and emitted ONLY when a
      // step actually changed state — an identical checklist re-sent every round
      // is how a live element turns into wallpaper.
      try {
        const planRows = await loadLatestPlanProgress(conversationId)
        const planProgress = planRows
          ? buildPlanProgress(planRows.planId, planRows.goal, planRows.rows)
          : null
        const sig = planProgressSignature(planProgress)
        if (planProgress && sig !== lastPlanSignature) {
          lastPlanSignature = sig
          yield {
            type: 'plan_progress',
            planId: planProgress.planId,
            goal: planProgress.goal,
            headline: planProgress.headline,
            doneCount: planProgress.doneCount,
            total: planProgress.total,
            steps: planProgress.steps,
          }
        }
      } catch { /* a checklist must never break a turn */ }

      // "কী হচ্ছে এখন" — deterministic, server-side, and silent while the model
      // is talking. Owner ask 2026-07-27: never leave him watching a spinner.
      const progressTick = nextTurnProgress(progressState, {
        round: iteration + 1,
        spokeSinceLast: spokeSinceProgress,
        elapsedMs: Date.now() - turnStartedMs,
        lastToolLabel: calls[calls.length - 1]?.name ?? null,
        nowMs: Date.now(),
      })
      if (progressTick) {
        progressState = progressTick.state
        spokeSinceProgress = false
        yield { type: 'turn_progress', ...progressTick.progress }
      }

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

      // A QUESTION ENDS THE TURN (owner rule 2026-07-25). Staging an ask card
      // used to only strip the tools for the remaining rounds — the model still
      // got one more text round and wrote a closing answer under its own
      // unanswered question, so the owner saw the agent "finish" without him.
      // The question IS the turn's output; anything after it is the agent
      // talking past Boss. Work resumes when he taps an option.
      if (emittedAskCards.length > 0) break

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
    if (!answerBody() && toolRecords.length === 0 && emittedAskCards.length === 0) {
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
    if (!answerBody()) {
      const lastTexts = timeline
        .filter((e) => e.t === 'text')
        .map((e) => (e as { text: string }).text)
        .filter((t) => t.trim() !== preambleText.trim())
      // HONEST REASON (owner bug 2026-07-26): this used to print "সার্ভারের
      // সময়সীমায় টার্ন শেষ হয়েছে" for ANY turn that ended without a final answer.
      // Boss watched a turn stop after FORTY SECONDS and be told the server ran
      // out of time — a plain untruth, and it hid the real reason (the head had
      // asked a question and stopped). Only claim the deadline when the deadline
      // actually fired.
      const endReason = deadlineHit
        ? (browserSteps.length
            ? `এই টার্নে ${browserSteps.length}টা ব্রাউজার ধাপ হয়েছে, তারপর সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে।`
            : 'সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে।')
        : emittedAskCards.length > 0
          ? 'উপরের প্রশ্নটার উত্তর পেলে বাকিটা করব।'
          : confirmCardsEmitted > 0
            ? 'অনুমোদনের কার্ড দিয়েছি — আপনি Approve করলেই কাজটা করব।'
            : 'এই টার্নে আর কিছু লেখা হয়নি — কাজটা এখান থেকেই ধরব।'
      finalText = [
        preambleText.trim(),
        lastTexts.length ? lastTexts[lastTexts.length - 1].slice(0, 600) : '',
        endReason,
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
    // SK-4 — the pinned skill's `done:` list, checked against what the turn
    // ACTUALLY did. A skill that declares its finish line makes "হয়ে গেছে" a
    // claim that can be false, instead of a sentence the model may emit at will.
    // It appends rather than rewrites: Boss keeps the work, and gains the truth
    // about what is still outstanding.
    if (activeSkills.manifest?.done?.length && claimsCompletion(finalText)) {
      const misses = skillDoneMisses(
        activeSkills.manifest,
        toolRecords.map((r) => ({ toolName: r.toolName, status: r.status })),
      )
      if (misses.length > 0) {
        const gate = `\n\n${doneGateMessage(activeSkills.pinned?.skill ?? activeSkills.manifest.name, misses)}`
        finalText += gate
        yield { type: 'text_delta', delta: gate }
      }
    }
    // OWNER RULING 2026-07-26 — the agent sets its OWN wake-up. Hitting the
    // hosting deadline is the agent's problem to handle, not a reason to sit and
    // wait for Boss to type "continue": save where you are, schedule the next
    // hop, carry on. Scheduled SERVER-side (worker queue) so it continues whether
    // or not his app is open. Bounded by the hop counter + the cost caps; an
    // unanswered ask card still stops everything (checked inside).
    if (taskUnfinished) {
      const doneWork = toolRecords
        .filter((r) => r.status === 'success')
        .slice(-8)
        .map((r) => r.toolName)
      const { scheduleSelfContinue } = await import('@/agent/lib/self-continue')
      const wake = await scheduleSelfContinue({
        conversationId,
        summary:
          `মূল কাজ: ${(lastUserText || '').slice(0, 300)}\n`
          + `এই টার্নে যা হয়েছে: ${doneWork.join(' · ') || 'কিছু না'}\n`
          + `শেষ অবস্থা: ${finalText.slice(-400)}`,
      })
      if (wake.scheduled) {
        const note = `\n\n_(কাজ শেষ হয়নি — নিজে থেকেই ${Math.round(SELF_CONTINUE_DELAY_MS / 1000)} সেকেন্ড পরে বাকিটা চালিয়ে যাব, hop ${wake.hops}. আপনাকে কিছু বলতে হবে না।)_`
        finalText += note
        yield { type: 'text_delta', delta: note }
      }
    } else {
      // Finished cleanly — the chain resets so the next long job starts fresh.
      const { clearHops } = await import('@/agent/lib/self-continue')
      await clearHops(conversationId).catch(() => {})
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
    // Bill reasoning tokens ONLY for xai-direct, where a live turn proved they
    // are reported separately from completion_tokens (Phase 7). Other providers
    // either return an actual cost (OpenRouter) or fold reasoning into
    // completion_tokens, so adding it there would double-count.
    const billedReasoningTokens = model.provider === 'xai' ? totalReasoningTokens : 0
    const costUsd = totalActualCostUsd != null
      ? roundUsd(totalActualCostUsd)
      : calcModelTurnCostUsd(model, {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheRead: totalCacheReadTokens,
          cacheWrite: totalCacheCreationTokens,
          reasoningTokens: billedReasoningTokens,
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
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens, context_tokens: lastContextTokens ?? undefined, context_source: lastContextTokens != null ? 'provider_last_round' : undefined, context_measured_at: lastContextTokens != null ? new Date().toISOString() : undefined, model: model.id, apiModel: model.apiModel, provider: model.provider, packs: toolSelection.packs ?? undefined, api_rounds: apiRounds > 0 ? apiRounds : undefined, round_costs_usd: roundCostsUsd.length > 0 ? roundCostsUsd : undefined, reasoning: thinkingText.trim() ? thinkingText.trim().slice(0, 12000) : undefined, reasoningMs: thinkingMs ?? undefined, duration_ms: Date.now() - turnStartedAtMs, timeline: timeline.length > 0 ? timeline.slice(0, 60) : undefined },
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
      provider: modelProviderToCostProvider(model.provider),
      kind: 'chat',
      units: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        // Prompt-cache effectiveness (cost audit 2026-07-24): without these the
        // dashboard cannot tell "cache is working" from "cache not reported" —
        // the head's biggest cost lever was invisible.
        cache_read_input_tokens: totalCacheReadTokens,
        cache_creation_input_tokens: totalCacheCreationTokens,
        ...(lastContextTokens != null ? {
          context_tokens: lastContextTokens,
          context_source: 'provider_last_round',
        } : {}),
        // Phase 7 observability: reasoning tokens the provider reported separately.
        // Non-zero here on xai/Grok would mean completion_tokens excludes reasoning
        // and we under-bill output — the diagnosis for the xai drift.
        ...(totalReasoningTokens > 0 ? { reasoning_tokens: totalReasoningTokens } : {}),
        model: model.id,
        apiModel: model.apiModel,
        provider: model.provider,
        cost_source: totalActualCostUsd != null ? 'openrouter_actual' : 'estimate',
        // Phase 8b PREFIX-STABILITY probe (observe-only). A provider prompt cache
        // only pays off when the leading bytes are IDENTICAL turn to turn. Live
        // A/B after the sticky-routing fix showed ~0% reuse even for the same
        // question in two fresh chats seconds apart, so something in the "stable"
        // prefix is moving. These fingerprints make it visible instead of guessed:
        // compare two turns and whichever hash differs is the culprit (the system
        // text is built from activeToolNames + tail summary, both suspects).
        // Cheap: two short hashes per turn, no extra queries.
        prefix_system_chars: systemText.length,
        prefix_system_sha: shortHash(systemText),
        // Phase 8c: per-SECTION fingerprints. The 8b probe proved the system text
        // changes between turns at IDENTICAL length (69,044 chars both times) with
        // an identical tool set — so the earlier "active tool names rewrite the
        // core prompt" theory was wrong. Equal length + different bytes means
        // either an embedded clock or the same items emitted in a different order.
        //
        // buildSystemPromptBlocks joins everything into ONE cached block, so a
        // per-block hash would just restate prefix_system_sha. Split the text on
        // its markdown section headings instead and hash each: diffing two turns
        // then names the exact section that moved, with no change to the builder.
        prefix_section_shas: sectionFingerprints(systemText),
        // Which prompt mode produced this row, so the A/B can be split later.
        prefix_mode: forceFullPrompt ? 'full' : 'gated',
        prefix_tool_count: turnToolNames.length,
        prefix_tools_sha: shortHash(turnToolNames.join(',')),
      },
      costUsd,
      conversationId,
      jobId: savedMsg.id,
      dedupKey: `chat:msg:${savedMsg.id}`,
    })

    yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, cacheCreation: totalCacheCreationTokens, cacheRead: totalCacheReadTokens, costUsd, needContinue: taskUnfinished, apiRounds: apiRounds > 0 ? apiRounds : undefined, roundCostsUsd: roundCostsUsd.length > 0 ? roundCostsUsd : undefined, durationMs: Date.now() - turnStartedAtMs, permissionMode }
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
                : calcModelTurnCostUsd(model, { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheRead: totalCacheReadTokens, cacheWrite: totalCacheCreationTokens, reasoningTokens: model.provider === 'xai' ? totalReasoningTokens : 0 }),
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
              : calcModelTurnCostUsd(model, { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheRead: totalCacheReadTokens, cacheWrite: totalCacheCreationTokens, reasoningTokens: model.provider === 'xai' ? totalReasoningTokens : 0 }),
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
    // only ladder went expensive→cheap), climb the other way instead: the default
    // head (GPT-5.6 Luna, direct OpenAI) rides a DIFFERENT billing account than
    // every or-* model, so a provider-credit outage on OpenRouter still gets an
    // answer.
    const rescueId = model.id === cheapId
      ? (process.env.HEAVY_HEAD_MODEL_ID?.trim() || DEFAULT_HEAD_MODEL_ID)
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
          displayName: modelDisplayName(cheap.id),
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
    continuation: options.continuation === true,
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

  // P0-1: the head this job runs on, written AFTER both redirects above so the
  // pin always names a model that actually ran. Fire-and-forget — a failed write
  // costs one re-routed turn, never a wrong one. A continuation re-writes the
  // same pin, which slides its window over a long approval round-trip.
  void rememberHeadPin(conversationId, decision).catch(() => {})

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
    // Owner 2026-07-28: he wants to see WHO answered, whichever model it is.
    // `variant` only ever knew three families, so Grok/Gemini/GPT showed a bare
    // "ALMA"; this is the readable name for every model in the registry.
    displayName: modelDisplayName(model.id),
    variant: modelVariant(model),
    tier: decision.tier,
  }

  if (disabledSwitchNote) {
    yield { type: 'text_delta', delta: disabledSwitchNote }
  }

  // The chat route reads the mode and the grant off the conversation row and
  // passes them in. Every OTHER entry point — the plan driver, the approval
  // continuation — calls this with a conversation id and nothing else, so a turn
  // Boss had already granted arrived with `elevationGrant: null` and was staged
  // or blocked anyway (review bot, #667). The row is the source of truth, so
  // read it here when the caller did not supply it.
  if (options.elevationGrant === undefined || options.permissionMode === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = await (prisma as any).agentConversation.findUnique({
        where: { id: conversationId },
        select: { permissionMode: true, elevationGrant: true },
      })
      const { parseElevationGrant } = await import('@/agent/lib/permission-mode')
      options = {
        ...options,
        permissionMode: options.permissionMode ?? conv?.permissionMode ?? undefined,
        elevationGrant: options.elevationGrant ?? parseElevationGrant(conv?.elevationGrant),
      }
    } catch (err) {
      // A read failure must not widen anything: no grant is the safe answer, and
      // the mode falls back to the caller's default exactly as before.
      console.warn('[run-owner-turn] permission row read failed:', err instanceof Error ? err.message : err)
    }
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

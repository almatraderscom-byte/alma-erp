import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS, BROWSER_TURN_MAX_ITERATIONS, HEAD_TOOL_BUDGET } from '@/agent/config'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { buildSystemPromptBlocks, type PinnedMemory, type OutcomeLearning, type OwnerDecision } from '@/agent/lib/system-prompt'
import { buildOwnerActiveTasksContextBlock, buildStaffActiveTasksContextBlock } from '@/agent/lib/owner-active-tasks-context'
import { buildBusinessContext } from '@/agent/lib/business-brain'
import { getRecentOutcomeLearnings } from '@/lib/outcome-loop'
import { detectInstructionConflicts } from '@/agent/lib/intelligence/counter-propose'
import { loadSalahAccountabilityContext } from '@/agent/lib/salah-context'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { detectOutboundCallIntent, buildOutboundCallIntakeBlock } from '@/agent/lib/outbound-call-intent'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isStaffTaskPlanningInquiry, isStaffTaskStatusInquiry } from '@/agent/lib/staff-task-intent'
import { loadRecentOtherConversations } from '@/agent/lib/cross-surface'
import { selectToolsAndGroupsForTurnAsync, selectToolGroupsSync, applyToolSearchDeferral, TOOL_SEARCH_ENABLED, SLIM_ROUTER_ENABLED } from '@/agent/tools/select-tools'
import { getAgentControls, filterToolDefsByControls, controlsPromptNote } from '@/agent/lib/agent-controls'
import { executeTool, executePersonalTool, type ToolResult } from '@/agent/tools/registry'
import { AUTO_RUN_ROLES } from '@/agent/tools/orchestrator-tools'
import { logRefusalEvent } from '@/agent/lib/tool-telemetry'
import { normalizeBusinessId, type AgentBusinessId } from '@/lib/agent-api/business-context'
import { agentStorageDownload } from '@/agent/lib/storage'
import { VISION_NOTE_PREFIX } from '@/agent/lib/attachment-vision'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { embedMessageInBackground, retrieveRelevantOldTurns } from '@/agent/lib/message-recall'
import { getBusinessSnapshot } from '@/agent/lib/business-snapshot'
import { annotateEmptyResult } from '@/agent/lib/tool-result-note'
import { toolResultPreview, extractScreenshotUrl } from '@/agent/lib/tool-labels'
import { decodeUnicodeEscapes } from '@/agent/lib/decode-unicode-escapes'
import { bumpPlaybookForTool, getActivePlaybook } from '@/agent/lib/playbook'
import { bumpPlaybookRulesForDomains } from '@/agent/lib/learning/learned-rules'
import { detectTeachingIntent } from '@/agent/lib/learning/teaching-intent'
import { applyOwnerTeaching, buildTeachingTurnPromptBlock } from '@/agent/lib/learning/apply-teaching'
import { banglaAnthropicError, extractAnthropicRequestId, isAnthropicQuotaExhausted } from '@/agent/lib/anthropic-errors'
import { captureAgentError } from '@/agent/lib/sentry'
import { specialistLabel, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { isTurnCancelRequested } from '@/agent/lib/turn-status'
import { logCost } from '@/agent/lib/cost-events'
import { looksLikeDurableFact, MEMORY_SAVE_NUDGE } from '@/agent/lib/memory-fact-detect'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { applyTailCompaction } from '@/agent/lib/tail-compact'
import { shouldAutoContinueTurn } from '@/agent/lib/continuation-policy'
import { shouldNudgeZeroToolIntent } from '@/agent/lib/turn-loop-policy'
import {
  buildVerificationReminder,
  detectMissingCardViolation,
  MAX_VERIFY_RETRIES,
  type ClaimViolation,
  type ToolLedgerEntry,
  verifyClaimsAgainstLedger,
} from '@/agent/lib/claim-verifier'

// ── Event types ────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  // Emitted once at turn start so the UI can show a per-model loading identity
  // (Sonnet = Claude sparkle, DeepSeek = blue dots, Qwen = orb) + a label.
  | { type: 'model_info'; modelId: string; label: string; variant: 'claude' | 'qwen' | 'deepseek' | 'default'; tier: string }
  // Owner-gated model UPGRADE: the thread was on a cheap head but this turn needs a
  // premium model (Sonnet/Opus). The turn pauses here and the UI shows an approval
  // card; on "yes" the client resumes the same turn on the premium model.
  | {
      type: 'model_switch_required'
      conversationId: string
      toModelId: string
      toLabel: string
      fromModelId: string
      fromLabel: string
      fallbackModelId: string
    }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | { type: 'tool_end'; id: string; name: string; success: boolean; error?: string; resultPreview?: string; screenshot?: string }
  | { type: 'subagent_start'; id: string; role: string; roleLabel: string; task: string }
  | { type: 'subagent_end'; id: string; role: string; success: boolean; summary?: string; toolsUsed?: string[]; error?: string }
  | { type: 'confirm_card'; pendingActionId: string; summary: string; costEstimate?: number; actionType?: string; entryCount?: number; isFinance?: boolean; isBatch?: boolean }
  // A tool filed a document as a conversation artifact — the UI drops a file
  // card into the reply flow and opens the artifacts panel on it.
  | { type: 'artifact_saved'; id: string; title: string; artifactType: string }
  | { type: 'ask_card'; askCardId: string; question: string; options: string[] }
  | {
      type: 'verification_retry'
      attempt: number
      maxAttempts: number
      categories: string[]
      snippets: string[]
    }
  // needContinue: the turn hit the serverless deadline mid-task (browser work
  // unfinished) — the web client auto-sends a bounded "continue" so a long task
  // finishes end-to-end without the owner typing it every ~4.5 minutes.
  | { type: 'done'; messageId: string; tokensIn: number; tokensOut: number; cacheCreation: number; cacheRead: number; costUsd: number; needContinue?: boolean; apiRounds?: number; roundCostsUsd?: number[] }
  | { type: 'error'; message: string }

// ── Mutating tools (conservative: unknown = treat as mutating) ──────────────
export const MUTATING_TOOLS = new Set([
  'add_family_contact', 'add_owner_todo', 'add_product_asset', 'add_staff_task_now',
  'add_subscription', 'approve_and_dispatch_tasks', 'approve_pending_dispatch',
  'approve_pending_staff_message', 'approve_playbook', 'cancel_reminder',
  'confirm_oxylabs_spend', 'correct_and_redispatch_staff_tasks', 'create_order_draft',
  'delete_finance_entry', 'delete_memory', 'duplicate_campaign', 'launch_campaign', 'edit_finance_entry',
  'forget_reference', 'forget_rule', 'log_expense', 'log_expenses_batch',
  'log_ledger_entries_batch', 'log_ledger_entry', 'manage_competitor_watchlist',
  'manage_model_library', 'manage_work_todos', 'mark_salah', 'merge_into_proposal',
  'outbound_phone_call', 'pause_campaign', 'pause_content_engine', 'post_to_facebook',
  'publish_product', 'reject_playbook', 'resume_content_engine', 'retire_playbook',
  'run_content_post', 'save_brand_asset', 'save_memory', 'send_customer_message', 'reply_to_comment',
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
  'track_open_task', 'resolve_open_task',
])

// One-time message injected when the expensive head exhausts its tool-round
// budget. It must now either answer with what it already has, or hand the rest
// to a cheap specialist worker — it can no longer call read/write tools itself.
const HEAD_TOOL_BUDGET_NUDGE =
  'টুল ব্যবহারের বাজেট শেষ। এখন আর নিজে নতুন টুল কল কোরো না। ' +
  'হাতে যা তথ্য আছে তা দিয়ে সংক্ষেপে চূড়ান্ত উত্তর দাও, ' +
  'অথবা বাকি কাজটা delegate_to_specialist দিয়ে একজন সস্তা worker-কে দিয়ে দাও। ' +
  'খরচ কমানোই উদ্দেশ্য — অযথা নিজে অনেক টুল চালিও না।'

// ── Announced-intent-but-no-action safety net ────────────────────────────────
// Bug: the head sometimes SAYS it will run a tool ("আগে recommend_ad_actions দিয়ে
// দেখি", "let me check") and then ends the turn WITHOUT calling any tool — the
// owner has to nudge it before it acts. claim-verifier catches false "I DID X"
// claims, but not future-intent "I WILL do X" with zero tool calls. This regex
// detects that announced intent (Bangla + Banglish + English) so we can re-prompt
// the head to actually run the tool in the SAME turn instead of stopping.
// One-time message injected when the head announces it will use a tool but ends
// its turn without calling any. Force it to act NOW, in this same turn.
const ACT_NOW_NUDGE =
  'তুমি বললে যে একটা টুল/চেক চালাবে কিন্তু আসলে কোনো টুল কল করোনি — এই টার্নেই থেমে গেছ। ' +
  'শুধু "দেখি/চেক করি" বলে থেমো না। এখনই, এই একই টার্নে, দরকারি টুলটা আসলে কল করো ' +
  'এবং ফলাফল দেখে তারপর Boss-কে উত্তর দাও। মালিককে আবার তাগাদা দিতে হবে না।'

// ── Anthropic client ────────────────────────────────────────────────────────

const globalForAnthropic = globalThis as unknown as { anthropic: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForAnthropic.anthropic) {
    globalForAnthropic.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      // Anthropic 529 "overloaded" / 429 spikes are usually transient (seconds).
      // The SDK default (2) gave up too fast and the owner saw a raw
      // "সার্ভার ব্যস্ত" instead of an answer. Retry the stream-start with
      // exponential backoff before surfacing an error to the owner.
      maxRetries: 4,
    })
  }
  return globalForAnthropic.anthropic
}

// ── Defensive: strip lone UTF-16 surrogates before sending to Anthropic ───────
// Surrogate-unsafe string truncation upstream (e.g. `.slice(0, N)` landing between
// a surrogate pair while trimming injected memory/context) can leave a lone high
// or low surrogate in the request. JSON.stringify then emits an unpaired `\udXXX`
// escape, which Anthropic's strict JSON parser rejects ("no low surrogate in
// string") and 400s the entire turn. Replace any lone surrogate with U+FFFD so the
// outgoing body is always well-formed regardless of which upstream field split an
// emoji. This is a safety net at the single send site, not a substitute for
// surrogate-aware truncation upstream.
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
function stripLoneSurrogates(s: string): string {
  if (!/[\uD800-\uDFFF]/.test(s)) return s
  return s.replace(LONE_HIGH_SURROGATE, '�').replace(LONE_LOW_SURROGATE, '�')
}
function sanitizeSurrogatesDeep<T>(value: T): T {
  if (typeof value === 'string') return stripLoneSurrogates(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => sanitizeSurrogatesDeep(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeSurrogatesDeep(v)
    }
    return out as unknown as T
  }
  return value
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
  | { type: 'confirm_card'; pendingActionId: string; summary: string; costEstimate?: number; actionType?: string }
  | { type: 'ask_card'; askCardId: string; question: string; options: string[] }
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

  // Durable ask-card answers, joined into the ask-card history notes below so the
  // model always sees which option the owner actually chose for each question —
  // the bare tapped-option text arrives as a detached user message and used to get
  // bound to the wrong question in long contexts (owner bug 2026-07-12). Fail-open.
  let askAnswers: Map<string, { status: string; selectedOption: string | null }> | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const askRows: Array<{ id: string; status: string; selectedOption: string | null }> =
      await (prisma as any).agentAskCard.findMany({
        where: { conversationId },
        select: { id: true, status: true, selectedOption: true },
      })
    askAnswers = new Map(askRows.map((r) => [r.id, { status: r.status, selectedOption: r.selectedOption }]))
  } catch { /* fail-open — plain notes */ }

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

    // When the message already carries a Gemini vision transcription (added at
    // persist time), the attachment has been read cheaply — do NOT re-embed the raw
    // base64 image into a Claude turn, which would pay for vision a second time. The
    // path text still goes through (for tools); the model reads the image from the
    // transcription text block. Older messages (no note) keep the native-image path.
    const hasVisionNote = stored.some(
      (b) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(VISION_NOTE_PREFIX),
    )

    const apiBlocks: Anthropic.Messages.ContentBlockParam[] = []
    for (const block of stored) {
      if (block.type === 'file_ref') {
        if (recentFileSet.has(i) && !hasVisionNote) {
          apiBlocks.push({
            type: 'text',
            text: `[Uploaded file path for tools: ${block.path}]`,
          })
          try {
            apiBlocks.push(await resolveFileRef(block))
          } catch (err) {
            // Image/file download still failed after retries. Do NOT stay silent —
            // a blank "[couldn't load]" used to make the agent quietly act as if no
            // screenshot was attached. Tell the model exactly what happened so it
            // honestly tells the owner the image didn't load and asks for a resend.
            console.error('[core.loadHistory] file load failed:', block.path, err)
            apiBlocks.push({
              type: 'text',
              text:
                '[সংযুক্ত ছবি/ফাইলটি লোড করা যায়নি — storage থেকে আনা যায়নি। ' +
                'এটা পড়তে পারোনি বলে বসকে স্পষ্ট জানাও এবং ছবিটা আবার পাঠাতে বলো। ' +
                'ছবি দেখতে পেয়েছ ভান কোরো না।]',
            })
          }
        } else if (hasVisionNote) {
          // Transcribed by Gemini already — keep the path (so vision tools can still
          // re-open the file if needed) but don't embed the raw image.
          apiBlocks.push({
            type: 'text',
            text: `[Uploaded file path for tools: ${block.path}]`,
          })
        } else {
          apiBlocks.push({
            type: 'text',
            text: `[পূর্ববর্তী ফাইল সংযুক্তি: ${block.path}]`,
          })
        }
      } else if (block.type === 'confirm_card') {
        // A confirm card is a UI breadcrumb persisted in the assistant turn so it
        // survives a page reload. It is NOT a valid Anthropic content block, so it
        // must never be sent verbatim to the model — collapse it to a short note.
        const cc = block as Extract<StoredContentBlock, { type: 'confirm_card' }>
        apiBlocks.push({ type: 'text', text: `[অনুমোদনের কার্ড দেখানো হয়েছিল: ${cc.summary}]` })
      } else if (block.type === 'ask_card') {
        // Ask-card breadcrumb — same rule as confirm cards: a UI-only block that
        // must never reach the API verbatim; collapse it to a note carrying the
        // options and the owner's recorded answer (misbinding guard, 2026-07-12).
        const ac = block as Extract<StoredContentBlock, { type: 'ask_card' }>
        const opts = Array.isArray(ac.options) && ac.options.length
          ? ` | অপশন: ${ac.options.join(' / ')}`
          : ''
        const ans = askAnswers?.get(ac.askCardId)
        const answered = ans?.status === 'answered' && ans.selectedOption
          ? ` | Boss-এর নির্বাচিত উত্তর: "${ans.selectedOption}" — এটাই এই প্রশ্নের চূড়ান্ত উত্তর, অন্য কোনো বার্তাকে এই প্রশ্নের উত্তর ধরবে না`
          : ' | (এখনও উত্তর দেননি)'
        apiBlocks.push({ type: 'text', text: `[প্রশ্ন কার্ড দেখানো হয়েছিল: ${ac.question}${opts}${answered}]` })
      } else {
        apiBlocks.push(block as unknown as Anthropic.Messages.ContentBlockParam)
      }
    }

    // Guard: never send an empty-content message to the API.
    if (apiBlocks.length === 0) apiBlocks.push({ type: 'text', text: '' })

    result.push({ role: row.role as 'user' | 'assistant', content: apiBlocks })
  }

  return result
}

function blocksOf(msg: ApiMessage): Anthropic.Messages.ContentBlockParam[] {
  const raw = msg.content
  return Array.isArray(raw)
    ? [...raw]
    : typeof raw === 'string'
      ? [{ type: 'text', text: raw }]
      : []
}

/** Returns a copy of `msg` with cache_control on its last content block. */
function withCacheControlOnLastBlock(msg: ApiMessage): ApiMessage {
  const blocks = blocksOf(msg)
  if (blocks.length === 0) return msg
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: 'ephemeral', ttl: '1h' },
  } as Anthropic.Messages.ContentBlockParam
  return { role: msg.role, content: blocks }
}

/**
 * Builds the per-iteration API message array with prompt-cache breakpoints.
 *
 * The volatile per-turn context (salah hints, business snapshot, relevant
 * memories, conflict signals, "this turn" nudges, etc.) is injected into the
 * CURRENT owner user turn rather than the system block. That keeps the system
 * block and ALL prior history byte-stable across turns, so the conversation
 * history finally cache-hits instead of being re-billed at full input price
 * every turn. The API allows at most 4 cache_control breakpoints per request,
 * and the system stable block (1) + the tool list (1) already consume two of
 * them — so this function must place AT MOST 2 message breakpoints, never 3.
 * (Placing 3 here triggered "A maximum of 4 blocks with cache_control may be
 * provided. Found 5." → a 400 that failed every multi-tool-round turn, e.g. an
 * outbound-call request.) The two message breakpoints are:
 *   - last prior assistant message  → caches the conversation-history prefix
 *     (byte-stable across turns; this is the cross-turn win)
 *   - the LAST message → caches the within-turn tool-iteration prefix so repeated
 *     tool rounds don't re-bill prior rounds. On the first iteration the last
 *     message IS the owner turn, so its volatile context is cached too.
 *
 * The volatile per-turn context is always injected into the owner turn, but that
 * turn only carries a breakpoint when it is also the last message — otherwise a
 * mid-loop turn would produce the 3rd (over-budget) message breakpoint.
 *
 * `messages` itself is never mutated — volatile lives only in this transient
 * copy and is never persisted, so replayed history stays clean.
 */
export function buildTurnApiMessages(
  messages: ApiMessage[],
  ownerTurnIndex: number,
  volatileText: string,
): ApiMessage[] {
  if (ownerTurnIndex < 0 || ownerTurnIndex >= messages.length) {
    // No identifiable owner turn — fall back to marking the last message.
    if (messages.length === 0) return messages
    return [
      ...messages.slice(0, messages.length - 1),
      withCacheControlOnLastBlock(messages[messages.length - 1]),
    ]
  }

  let priorAssistantIdx = -1
  for (let i = ownerTurnIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { priorAssistantIdx = i; break }
  }
  const lastIdx = messages.length - 1

  return messages.map((msg, i) => {
    // Inject volatile per-turn context into the owner turn (no breakpoint here
    // on its own — the breakpoint is only added when this turn is also the last
    // message, via the lastIdx branch below; see the budget note above).
    let out = msg
    if (i === ownerTurnIndex && volatileText) {
      out = {
        role: 'user' as const,
        content: [
          { type: 'text', text: `[Per-turn context]\n${volatileText}` } as Anthropic.Messages.ContentBlockParam,
          ...blocksOf(msg),
        ],
      }
    }
    // At most 2 message breakpoints: the prior assistant (cross-turn prefix) and
    // the last message (within-turn tool-loop prefix). These two are always
    // distinct (priorAssistantIdx < ownerTurnIndex ≤ lastIdx), so the total with
    // system + tools never exceeds the API's max of 4.
    if (i === priorAssistantIdx || i === lastIdx) {
      return withCacheControlOnLastBlock(out)
    }
    return out
  })
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
        where: {
          ...(personalMode
            ? { pinned: true, scope: 'personal' }
            // Business mode: include pinned PERSONAL owner-identity facts too (wife's
            // name, hafez, standing preferences) — pinning means "always know this",
            // so these must cross over into business chat, not just personal mode.
            : { pinned: true }),
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: 'desc' },
        take: 60,
        select: { id: true, content: true, scope: true, metadata: true },
      })

    const filtered = personalMode
      ? rows
      : rows.filter((r) => {
          // Pinned personal memories are cross-cutting owner identity — always
          // available, regardless of which business the chat is scoped to.
          if (r.scope === 'personal') return true
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
  /** AgentTurn row id — polled each iteration for an owner-requested server-side cancel. */
  turnId?: string | null
  /**
   * Epoch ms when the hosting serverless function will hard-abort (Vercel 300s
   * cap → route sets ~280s). Near this deadline the loop stops offering tools
   * and forces a Bangla progress wrap-up + checkpoint instead of dying silently
   * mid-task with a blank reply (2026-07-12 long browser-task incident).
   * Absent/null = no deadline (VPS worker turns are uncapped).
   */
  deadlineAt?: number | null
}

/** One-time nudge injected when the serverless deadline is close. */
const DEADLINE_WRAPUP_NUDGE =
  'এই টার্নের সময়সীমা প্রায় শেষ (সার্ভার লিমিট) — এখন আর টুল চালানো যাবে না। ' +
  'এ পর্যন্ত কী কী করেছ আর ঠিক কোথায় আছ তা বসকে বাংলায় সংক্ষেপে জানাও, ' +
  'আর কাজ অসমাপ্ত থাকলে শেষে লেখো: "Boss, “continue” বললে ঠিক এখান থেকে কাজ চালিয়ে যাব।" — চুপচাপ থেমো না।'

// ── Main agent turn ────────────────────────────────────────────────────────

export async function* runAgentTurn(
  conversationId: string,
  options: RunAgentTurnOptions = {},
): AsyncGenerator<AgentEvent> {
  const client = getClient()
  const { projectSystemInstructions, signal, turnId, telegramFastPath = false, deadlineAt = null } = options
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

  // B3 tail compaction (primary cost lever): fold the oldest turns into a running
  // summary that rides the STABLE/cached system block, dropping them from the live
  // window. Row order from loadHistory is 1:1 with DB createdAt asc, so dropOldest
  // lines up with messages.slice(). Fail-open returns dropOldest 0.
  let tailSummary: string | undefined
  try {
    const tail = await applyTailCompaction(conversationId)
    if (tail.dropOldest > 0) messages = messages.slice(tail.dropOldest)
    if (tail.tailSummary) tailSummary = tail.tailSummary
  } catch (err) {
    console.warn('[core] tail compaction failed:', err instanceof Error ? err.message : String(err))
  }

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
        { role: 'assistant', content: 'বুঝেছি, আগের কথোপকথনের সব প্রসঙ্গ মনে আছে। বলুন বস।' },
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

  // HIGHEST PRIORITY — owner is instructing an OUTBOUND CALL ("oi nambare call kore bolo …").
  // Recognised deterministically so neither the evening task-intake (below) nor any
  // reminder path can mistake it for a todo/reminder (the exact bug the owner hit). The
  // head-router has already forced Sonnet for this; here we inject the routing directive.
  const callIntent =
    !personalMode && lastUserText
      ? detectOutboundCallIntent(lastUserText)
      : { isCall: false, hasNumber: false }
  if (callIntent.isCall) {
    intakeContextBlock = buildOutboundCallIntakeBlock(callIntent.hasNumber)
  }

  // Point 3 (Part A) — owner office on/off toggle. Highest priority owner-initiated
  // signal: declaring "no office today" suspends duties + asks the reason; replies while
  // the off-question is pending are captured here (short-circuits the LLM turn).
  if (!personalMode && lastUserText) {
    try {
      const { processOfficeToggleReply } = await import('@/agent/lib/office-toggle')
      const toggle = await processOfficeToggleReply(lastUserText, conversationId)
      if (toggle?.autoReply) intakeAutoReply = toggle.autoReply
    } catch (err) {
      console.warn('[core] office toggle reply failed:', err instanceof Error ? err.message : err)
    }
  }

  // Owner approves / rejects a proposal filed by the external Claude co-worker. Only fires
  // when such a request is pending AND recent (so it never hijacks unrelated chat). Approve →
  // hand the head an EXECUTE-NOW context block; reject → short-circuit with a confirmation.
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { processCoworkerRequestReply } = await import('@/agent/lib/coworker-request')
      const cw = await processCoworkerRequestReply(lastUserText, conversationId)
      if (cw?.autoReply) intakeAutoReply = cw.autoReply
      if (cw?.contextBlock) intakeContextBlock = cw.contextBlock
    } catch (err) {
      console.warn('[core] coworker request reply failed:', err instanceof Error ? err.message : err)
    }
  }

  // Part 1.5 — SALAH-aware snooze. If the owner asks for time ("আমাকে ৩০ মিনিট দাও",
  // "30 min por") WHILE a namaz waqt is in its duty window, actually pause reminders
  // + calls (per-waqt override + global owner-call-lock) instead of the generic nag
  // snooze below — which only paused business chases and left the salah call ringing.
  // Runs BEFORE the pace-reply so a live prayer window wins, and only fires inside the
  // 45-min moral window (outside it → falls through, we never fake a lock).
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { parseSnoozeMs } = await import('@/agent/lib/pending-followup')
      const ms = parseSnoozeMs(lastUserText)
      if (ms != null) {
        const { resolveActiveSalahWaqt, applySalahDelay } = await import('@/agent/lib/salah-delay')
        const active = await resolveActiveSalahWaqt()
        if (active) {
          const res = await applySalahDelay({
            waqt: active.waqt,
            minutes: Math.round(ms / 60_000),
            reason: 'owner typed snooze',
          })
          if (res) {
            intakeAutoReply =
              `ঠিক আছে বস — ${res.grantedMin} মিনিটের জন্য নামাজের কল ও রিমাইন্ডার বন্ধ রাখলাম ` +
              `(${res.resumeAtLabel}-এ আবার মনে করিয়ে দেব)। নিশ্চিন্তে সেরে নিন। 🤝`
          }
        }
      }
    } catch (err) {
      console.warn('[core] salah snooze intercept failed:', err instanceof Error ? err.message : err)
    }
  }

  // Part 2 — owner replies "busy / 30 min por / driving" to a pending-approval reminder:
  // snooze the chase by exactly that long. Guarded (only when a reminder went out recently)
  // so it never hijacks unrelated chat.
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { processFollowupPaceReply } = await import('@/agent/lib/pending-followup')
      const pace = await processFollowupPaceReply(lastUserText, conversationId)
      if (pace?.autoReply) intakeAutoReply = pace.autoReply
    } catch (err) {
      console.warn('[core] followup pace reply failed:', err instanceof Error ? err.message : err)
    }
  }

  if (!personalMode && lastUserText && !intakeAutoReply && !callIntent.isCall) {
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

  // Point 2 — capture owner's reply to the yesterday-accounting question (reason for
  // missed office work). Saved to memory inside; contextBlock makes the head give a
  // suggestion. Only fires while accounting is pending and intake didn't already handle.
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { processOwnerAccountingReply } = await import('@/agent/lib/yesterday-accounting')
      const acc = await processOwnerAccountingReply(lastUserText, conversationId)
      if (acc?.contextBlock) intakeContextBlock = acc.contextBlock
    } catch (err) {
      console.warn('[core] yesterday accounting reply failed:', err instanceof Error ? err.message : err)
    }
  }

  // Point 3 (Part B) — capture owner's reply to the carried-todo follow-up question.
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { processOwnerFollowupReply } = await import('@/agent/lib/followup-carryover')
      const fu = await processOwnerFollowupReply(lastUserText, conversationId)
      if (fu?.autoReply) intakeAutoReply = fu.autoReply
      if (fu?.contextBlock) intakeContextBlock = fu.contextBlock
    } catch (err) {
      console.warn('[core] followup reply failed:', err instanceof Error ? err.message : err)
    }
  }

  // Nightly salah muhasaba — capture the owner's reflection reply while muhasaba is
  // pending and turn it into warm encouragement (the soft companion to escalation).
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { processMuhasabaReply } = await import('@/agent/lib/salah-muhasaba')
      const mh = await processMuhasabaReply(lastUserText, conversationId, now)
      if (mh?.contextBlock) intakeContextBlock = mh.contextBlock
    } catch (err) {
      console.warn('[core] salah muhasaba reply failed:', err instanceof Error ? err.message : err)
    }
  }

  // Salah jamaat/alone answer — when the owner replies to the conscience-nudge's
  // "জামাতে নাকি একা?" question, capture it as a conversational answer (saved to
  // memory) and FORBID turning it into a todo/reminder. Permanent fix for the bug
  // where "eka poreci" became "কালকের জন্য 1টি কাজ".
  if (!personalMode && lastUserText && !intakeAutoReply && !intakeContextBlock) {
    try {
      const { processJamaatReply } = await import('@/agent/lib/salah-jamaat')
      const jm = await processJamaatReply(lastUserText, conversationId, now)
      if (jm?.contextBlock) intakeContextBlock = jm.contextBlock
    } catch (err) {
      console.warn('[core] salah jamaat reply failed:', err instanceof Error ? err.message : err)
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
    const autoMark = await applySalahAutoMarkFromUserTexts(lastUserText ? [lastUserText] : [], now)
    // When the owner's message itself confirmed a waqt, nudge his conscience (prayed) or
    // honour his honesty (qaza/missed). Only when no other intake handler claimed the turn.
    if (autoMark.marked.length && !intakeAutoReply && !intakeContextBlock) {
      const fresh = autoMark.marked[autoMark.marked.length - 1]
      if (fresh.status === 'prayed_on_time' || fresh.status === 'prayed_late') {
        intakeContextBlock =
          `[SALAH CONFIRMED — CONSCIENCE NUDGE]\n` +
          `Boss just told you he prayed ${fresh.waqt} (${fresh.date}); it is ALREADY saved — do NOT call mark_salah for it. ` +
          `Reply in warm Bangla, addressing him as Boss: (1) a short Alhamdulillah / du'a that Allah accepts it, ` +
          `(2) then ONE gentle conscience question — ask softly whether he prayed in jamaat or alone ("জামাতে পড়লেন নাকি একা, Boss?"), ` +
          `framed with love and trust, never accusing. Keep it to 2 lines. This gentle question is intentional and owner-requested — it helps his conscience stay honest before Allah.`
        // Mark a one-shot pending so the owner's next reply ("eka"/"jamaate") is
        // captured as a conversational answer, never turned into a todo/reminder.
        try {
          const { markJamaatPending } = await import('@/agent/lib/salah-jamaat')
          await markJamaatPending(fresh.waqt, fresh.date, now)
        } catch (err) {
          console.warn('[core] markJamaatPending failed:', err instanceof Error ? err.message : err)
        }
      } else if (fresh.status === 'qaza' || fresh.status === 'missed') {
        intakeContextBlock =
          `[SALAH ${fresh.status.toUpperCase()} — HONESTY HONOURED]\n` +
          `Boss honestly told you ${fresh.waqt} (${fresh.date}) was ${fresh.status === 'qaza' ? 'prayed as qaza (made up late)' : 'missed'}; it is ALREADY saved — do NOT call mark_salah for it. ` +
          `Reply in warm Bangla as Boss: (1) sincerely thank/encourage him for telling the truth instead of a false "porechi" — this honesty pleases Allah, ` +
          `(2) absolutely NO blame or guilt-tripping, ` +
          `(3) gently encourage tawba and catching the next waqt on time in jamaat. Keep it to 2-3 lines.`
      }
    }
  }

  // Load pinned memories, relevant memories, and tool selection in parallel
  const [pinnedMemories, relevantMemories, recalledTurns, salahContext, crossSurface, activePlaybook, outcomeLearnings, ownerDecisions, conflictSignals, businessContext, ownerActiveTasksBlock, staffActiveTasksBlock, toolSelection, businessSnapshot] = await Promise.all([
    loadPinnedMemories(personalMode, businessId),
    lastUserText ? retrieveRelevantMemories(lastUserText, personalMode, businessId) : Promise.resolve([]),
    lastUserText ? retrieveRelevantOldTurns(conversationId, lastUserText) : Promise.resolve([]),
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
    personalMode ? Promise.resolve('') : buildStaffActiveTasksContextBlock(businessId).catch((err) => {
      console.warn('[core] staffActiveTasksBlock failed:', err instanceof Error ? err.message : String(err))
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
  // Confirm cards emitted this turn — persisted into the assistant message so the
  // card (and later its approved/rejected outcome) survives a page reload.
  const emittedConfirmCards: Array<{ type: 'confirm_card'; pendingActionId: string; summary: string; costEstimate?: number; actionType?: string }> = []
  // Ask-user question cards emitted this turn — persisted as breadcrumbs (same
  // pattern as confirm cards) so the card survives the message poll / reload
  // instead of living only in the SSE stream.
  const emittedAskCards: Array<{ type: 'ask_card'; askCardId: string; question: string; options: string[] }> = []
  // Interactive question cards surfaced this turn (owner-facing yes/no / choice).
  // Tracked alongside confirm cards so the card-detection rule knows whether ANY
  // card actually reached the owner before the head claimed one did.
  let askCardsEmitted = 0
  let memoryNudgeSent = false
  let intentNudgeSent = false
  let verifyRetries = 0

  if (intakeAutoReply) {
    const replyText = intakeAutoReply
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
    embedMessageInBackground(savedMsg.id, [{ type: 'text', text: replyText }])
    await touchConversationActivity(conversationId)
    yield { type: 'done', messageId: savedMsg.id, tokensIn: 0, tokensOut: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 }
    return
  }

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
    teachingBlock,
    intakeContextBlock,
    ownerActiveTasksBlock: ownerActiveTasksBlock || undefined,
    staffActiveTasksBlock: staffActiveTasksBlock || undefined,
    outcomeLearnings,
    ownerDecisions,
    conflictSignals,
    businessContext,
    activeGroups,
    businessSnapshot,
    tailSummary,
  }
  const { stable: stableSystem, volatile: volatileSystem } = buildSystemPromptBlocks(promptArgs)
  // Volatile per-turn context is NOT shipped in the system block — that would
  // change the cached prefix every turn and bust the conversation-history cache.
  // It is injected into the current owner user turn instead (see
  // buildTurnApiMessages), keeping the system block byte-stable across turns.
  const systemBlocks = [...stableSystem]
  let volatileText = volatileSystem.map((b) => b.text).join('\n')
  // Phase 4 parity with the alternate-provider path: reconcile the conversation's
  // canonical WorkflowRuns against their cards' live status, then put the exact
  // in-flight state in front of the head — "হ্যাঁ/continue" resumes THE step.
  // Fail-open; skipped in personal mode.
  if (!personalMode) {
    try {
      const wf = await import('@/agent/lib/workflow-run')
      const runs = await wf.reconcileConversationWorkflows(conversationId)
      const note = wf.buildWorkflowSnapshotNote(runs)
      if (note) volatileText = volatileText ? `${volatileText}\n\n${note}` : note
    } catch (err) {
      console.warn('[core] workflow reconcile failed open:', err instanceof Error ? err.message : err)
    }
  }

  // The current owner turn is the last user message at this point (history +
  // optional compaction summary; tool-loop reminders/nudges are appended AFTER
  // this index, so it stays valid for the whole turn).
  let ownerTurnIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { ownerTurnIndex = i; break }
  }

  // Owner Control Center: drop OFF-capability tools and tell the agent (in the
  // prompt) to ask the owner to enable instead of improvising. Fail-open.
  const agentControls = await getAgentControls()
  const gatedTools = filterToolDefsByControls(selectedTools, agentControls)
  const controlsNote = controlsPromptNote(agentControls)
  if (controlsNote) systemBlocks.push({ type: 'text', text: controlsNote })

  // Tool Search (opt-in via AGENT_TOOL_SEARCH): defer the specialised long-tail
  // tool schemas so they aren't shipped every turn — the model pulls them on
  // demand. Owner business chat only; personal/trading keep their narrow sets.
  // Skipped when the Slim Head Router is on — the head is already lean, so the two
  // would just stack; the slim profile (select-tools) takes precedence.
  const toolsForModel: Anthropic.Messages.ToolUnion[] =
    TOOL_SEARCH_ENABLED && !SLIM_ROUTER_ENABLED && !personalMode && businessId !== 'ALMA_TRADING'
      ? applyToolSearchDeferral(gatedTools)
      : gatedTools

  // ── HARD tool-round budget (Option A) ────────────────────────────────────
  // This is the Sonnet head — always an EXPENSIVE Claude head. After
  // HEAD_TOOL_BUDGET tool ROUNDS it may NO LONGER spree read/write tools on its
  // own (costly) dime. The only tool left is delegate_to_specialist, which hands
  // the remaining work to a cheap DeepSeek worker. Enforced in CODE, not by a
  // prompt the model can ignore. If the head has no delegate tool (narrow modes),
  // the cap is inert and the normal MAX_TOOL_ITERATIONS guard still applies.
  const delegateOnlyTools = toolsForModel.filter(
    (t): t is Anthropic.Messages.Tool => 'name' in t && t.name === 'delegate_to_specialist',
  )
  const headCanDelegate = delegateOnlyTools.length > 0
  let headToolRounds = 0
  let budgetNudgeSent = false
  let deadlineNudgeSent = false
  let canceled = false
  // Accumulate the extended-thinking trace so it persists (in usage.reasoning) as a
  // "Thought for Ns" block instead of vanishing when the live stream ends. Stored in
  // the message's `usage` metadata — NEVER in `content` — so it is display-only and
  // can never be replayed into an API request as a (signature-less) thinking block.
  let thinkingText = ''
  let thinkingStartedAt = 0
  let thinkingMs: number | undefined
  // Ordered, DISPLAY-ONLY activity timeline: thinking segments interleaved with tool
  // calls in true execution order, so the UI can render ONE unified Claude-style
  // stream (reasoning → tool → reasoning → tool → answer) that survives reload.
  // Stored in usage.timeline; NEVER replayed to the model, so it costs zero tokens.
  type TimelineEntry =
    | { t: 'think'; text: string }
    | { t: 'text'; text: string }
    | { t: 'tool'; name: string; ok: boolean; input?: unknown; result?: string; shot?: string }
    | { t: 'file'; id: string; name: string; kind?: string }
  const timeline: TimelineEntry[] = []
  const compactTimelineInput = (input: unknown): unknown => {
    try {
      const json = JSON.stringify(input)
      if (json && json.length > 800) return { _truncated: `${json.slice(0, 800)}…` }
    } catch { /* non-serialisable → drop */ return undefined }
    return input
  }

  // Live-browser turns raise this cap (see BROWSER_TURN_MAX_ITERATIONS) — a real
  // UI task is 15–30 look→act rounds and must not die silently at the default cap.
  let maxIterations = MAX_TOOL_ITERATIONS

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) break
      // Owner hit Stop — a cross-instance cancel flag flipped in the DB. The
      // running turn lives in a different serverless instance than the cancel
      // POST, so we poll the flag here each round rather than via an in-memory
      // signal. Stop persisting/answering and exit silently; the cancel endpoint
      // already set the terminal status.
      if (await isTurnCancelRequested(turnId)) { canceled = true; break }

      // Serverless deadline close → no more tools; force a Bangla progress
      // wrap-up instead of the function dying mid-task with a blank reply.
      const nearDeadline = typeof deadlineAt === 'number' && Date.now() > deadlineAt - 45_000
      if (nearDeadline && !deadlineNudgeSent) {
        deadlineNudgeSent = true
        messages = [
          ...messages,
          { role: 'user', content: [{ type: 'text', text: DEADLINE_WRAPUP_NUDGE }] },
        ]
      }

      // Once over budget, restrict this turn's tools to delegate-only so the
      // expensive head physically cannot call another read/write tool — it must
      // either answer now or hand off to the cheap worker.
      const overBudget = headCanDelegate && headToolRounds >= HEAD_TOOL_BUDGET
      const iterationTools = nearDeadline ? [] : overBudget ? delegateOnlyTools : toolsForModel
      if (!nearDeadline && overBudget && !budgetNudgeSent) {
        budgetNudgeSent = true
        messages = [
          ...messages,
          { role: 'user', content: [{ type: 'text', text: HEAD_TOOL_BUDGET_NUDGE }] },
        ]
      }

      const apiMessages = buildTurnApiMessages(messages, ownerTurnIndex, volatileText)

      const stream = client.messages.stream(
        {
          model: apiModel,
          max_tokens: 8192,
          thinking: { type: 'adaptive' },
          system: sanitizeSurrogatesDeep(systemBlocks),
          tools: sanitizeSurrogatesDeep(iterationTools),
          messages: sanitizeSurrogatesDeep(apiMessages),
        },
        { signal: signal ?? undefined },
      )

      const currentBlocks: CollectedBlock[] = []
      let activeBlockType: string | null = null
      let activeBlockText = ''
      let activeBlockId = ''
      let activeBlockName = ''
      let activeBlockInputJson = ''
      // Thinking produced in THIS round only — pushed as one timeline segment
      // before this round's tool calls, so order across rounds stays faithful.
      let iterThinking = ''

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
            if (thinkingText && thinkingMs == null && thinkingStartedAt) {
              thinkingMs = Date.now() - thinkingStartedAt
            }
            activeBlockText += delta.text
            yield { type: 'text_delta', delta: delta.text }
          } else if (delta.type === 'thinking_delta') {
            // Surface the model's extended-thinking stream so the UI can show a
            // live "Thought for Ns" block — how the agent is reasoning about the
            // owner's message before it answers. Captured (display-only, in usage
            // metadata) so the block survives a reload; never replayed to the API.
            if (!thinkingStartedAt) thinkingStartedAt = Date.now()
            thinkingText += delta.thinking
            iterThinking += delta.thinking
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

      // Record this round's reasoning as a timeline segment BEFORE its tool calls.
      if (iterThinking.trim()) timeline.push({ t: 'think', text: iterThinking.trim().slice(0, 4000) })
      // And the round's VISIBLE text (Claude emits thinking → text → tool_use), so
      // the persisted timeline preserves the true text↔step order — the thread
      // renders steps BELOW the message that preceded them (owner ask 2026-07-11),
      // matching the native app, instead of piling every step above the reply.
      {
        const roundText = currentBlocks
          .filter((b): b is Extract<CollectedBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim()
        if (roundText) timeline.push({ t: 'text', text: roundText.slice(0, 6000) })
      }

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
          // Card-detection: reply promises an owner-facing approval/question card
          // but NO interactive card surfaced this turn (head forgot to call the
          // approval tool, or a sub-agent made a DB-only pending action). Force the
          // head to actually surface it or admit it couldn't.
          if (finalText && violations.length === 0 && emittedConfirmCards.length === 0 && askCardsEmitted === 0) {
            violations.push(...detectMissingCardViolation(finalText))
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

        // Announced-intent-but-no-action safety net: the head said it would run a
        // tool ("দিয়ে দেখি" / "let me check") but ended the turn with ZERO tool
        // calls. Re-prompt it once to actually act in this same turn, so the owner
        // doesn't have to nudge. Guarded: one-shot, never over budget, and only
        // when no tool ran at all this whole turn (toolRecords empty).
        if (
          !signal?.aborted
          && !intentNudgeSent
          && !overBudget
          && toolRecords.length === 0
        ) {
          const finalIntentText = currentBlocks
            .filter((b): b is Extract<CollectedBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim()
          if (shouldNudgeZeroToolIntent({
            text: finalIntentText,
            hasAskCard: emittedAskCards.length > 0,
          })) {
            intentNudgeSent = true
            assistantTurns.pop()
            messages = [
              ...messages,
              {
                role: 'assistant',
                content: currentBlocks as unknown as Anthropic.Messages.ContentBlockParam[],
              },
              { role: 'user', content: [{ type: 'text', text: ACT_NOW_NUDGE }] },
            ]
            continue
          }
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

      // This turn requested tools → it counts against the head's tool-round
      // budget. (Counts ROUNDS, i.e. model re-invocations, not parallel calls —
      // re-invoking the expensive model with the growing transcript is the cost.)
      // EXCEPT live-browser-only rounds: driving the owner's Chrome is inherently
      // many small owner-supervised steps that no cheap worker can take over, so
      // they neither burn the delegate budget nor stay confined to the default
      // iteration cap (see BROWSER_TURN_MAX_ITERATIONS).
      const roundToolNames = currentBlocks
        .filter((b): b is Extract<CollectedBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => b.name)
      const browserRound =
        roundToolNames.length > 0 && roundToolNames.every((n) => n.startsWith('live_browser_'))
      if (browserRound) maxIterations = BROWSER_TURN_MAX_ITERATIONS
      else headToolRounds++

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
        // Deadline check PER CALL: one round can queue several slow calls that
        // straddle the 45s wrap-up window, so the wrap-up round never happens and
        // the 280s abort kills the turn silently. Skipped calls still return a
        // tool_result (API contract) marking the step deferred.
        if (typeof deadlineAt === 'number' && Date.now() > deadlineAt - 45_000) {
          return {
            tb,
            result: { success: false, error: 'সময়সীমা শেষ — এই ধাপটা এখন হয়নি; পরের টার্নে ঠিক এখান থেকে করবে।' },
            durationMs: 0,
          }
        }
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
      let delegationAwaiting = false
      let delegationRoleLabel = ''
      // Summaries from auto-run (marketer/content) delegations that actually ran.
      // Used to skip the head's second turn when the worker output IS the answer.
      const autoRanDelegationSummaries: string[] = []
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

        timeline.push({
          t: 'tool', name: tb.name, ok: result.success,
          input: compactTimelineInput(tb.input),
          result: toolResultPreview(result),
          shot: extractScreenshotUrl(result),
        })

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

        if (isDelegate) {
          const d = (result.data ?? {}) as Record<string, unknown>
          const role = String((tb.input as Record<string, unknown>).role ?? '')
          // Approval-gated delegation: the worker has NOT run yet — a confirm card
          // was created. The head must STOP here and wait for the owner's decision,
          // not generate its own answer (which would double the cost).
          if (result.success && d.awaitingApproval === true) {
            delegationAwaiting = true
            delegationRoleLabel = specialistLabel(role)
          } else if (
            result.success
            && AUTO_RUN_ROLES.has(role as SpecialistRole)
            && typeof d.summary === 'string'
            && d.summary.trim()
          ) {
            autoRanDelegationSummaries.push(d.summary.trim())
          }
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
          yield { type: 'tool_end', id: tb.id, name: tb.name, success: result.success, error: result.error, resultPreview: toolResultPreview(result), screenshot: extractScreenshotUrl(result) }
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
              select: { status: true, summary: true, costEstimate: true, type: true },
            })
            // Phase 4 (parity with run-owner-turn): every staged card gets a
            // canonical WorkflowRun the moment it exists — idempotent, fail-open.
            if (row && !personalMode) {
              void import('@/agent/lib/workflow-run')
                .then(async (wf) => {
                  const { packsForPendingActionType } = await import('@/agent/tools/state-router')
                  const kind = packsForPendingActionType(String(row.type ?? ''))[0] ?? 'generic'
                  await wf.ensureWorkflowRunForPendingAction({
                    pendingActionId: d.pendingActionId as string,
                    conversationId,
                    businessId,
                    kind,
                    goal: String(row.summary ?? '').slice(0, 500) || `${row.type} card`,
                  })
                })
                .catch(() => {})
            }
            if (row?.status === 'pending') {
              const cardSummary = decodeUnicodeEscapes(
                typeof d.summary === 'string' && d.summary ? d.summary : (row.summary ?? ''),
              )
              const cardCost = typeof d.costEstimate === 'number' ? d.costEstimate : (row.costEstimate ?? undefined)
              const cardActionType = typeof d.actionType === 'string' ? d.actionType : undefined
              yield {
                type: 'confirm_card',
                pendingActionId: d.pendingActionId,
                summary: cardSummary,
                costEstimate: cardCost,
                actionType: cardActionType,
                entryCount: typeof d.entryCount === 'number' ? d.entryCount : undefined,
                isFinance: d.isFinance === true,
                isBatch: d.isBatch === true,
              }
              // Persist a breadcrumb so the card re-renders after a page reload
              // (the live SSE event alone is lost on refresh). Batch/finance edit
              // metadata is intentionally NOT stored — a reloaded card is a record,
              // not a re-editable draft; its current status drives what's shown.
              emittedConfirmCards.push({
                type: 'confirm_card',
                pendingActionId: d.pendingActionId,
                summary: cardSummary,
                ...(cardCost != null ? { costEstimate: cardCost } : {}),
                ...(cardActionType ? { actionType: cardActionType } : {}),
              })
            }
          }
          if (typeof d.askCardId === 'string' && Array.isArray(d.options)) {
            askCardsEmitted++
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

        // Vision: if a tool returned a screenshot (live browser), hand the head
        // model a REAL image block so it SEES the page — not a URL string it can't
        // open. Strip the raw base64 out of the JSON text first (else it bloats the
        // context by ~100KB per shot); the image travels only as the image block.
        const img = (result as ToolResult).image
        if (img && typeof img.data === 'string' && img.data.length > 0) {
          const { image: _omitImg, ...resultNoImg } = result as ToolResult
          toolResultContent.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.data },
              },
              { type: 'text', text: JSON.stringify(annotateEmptyResult(resultNoImg)) },
            ],
          })
        } else {
          toolResultContent.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: JSON.stringify(annotateEmptyResult(result)),
          })
        }
      }

      messages = [...messages, { role: 'user', content: toolResultContent }]

      // Head→specialist WAIT gate: a delegation confirm card is pending. Do not
      // loop back into the model for another (substantive) turn — that is exactly
      // the "Sonnet answers anyway, cost doubles" bug. Emit a short transient note
      // and end the turn; the owner's Approve/Reject drives what happens next.
      if (delegationAwaiting) {
        const waitNote =
          `🤝 কাজটা ${delegationRoleLabel}-কে দিচ্ছি। উপরের কার্ডে বেছে নিন — ` +
          `**Worker করুক** (সস্তা মডেল, কম খরচ) নাকি **Sonnet বলুক** (আমি নিজেই এখনই উত্তর দেব)। ` +
          `সিদ্ধান্ত পেলেই এগোব।`
        yield { type: 'text_delta', delta: waitNote }
        assistantTurns.push([{ type: 'text', text: waitNote }])
        break
      }

      // Auto-run specialist short-circuit: if EVERY tool call this turn was a
      // successful direct-run marketer/content delegation, the worker's Bangla
      // output IS the answer. Emit it and end the turn — do NOT loop back for a
      // second full-cost Sonnet turn just to re-wrap what Qwen already produced.
      // (Same rationale as the approval-gate break above: avoids doubling cost.)
      if (
        !delegationAwaiting
        && autoRanDelegationSummaries.length > 0
        && autoRanDelegationSummaries.length === toolUseBlocks.length
      ) {
        const combined = autoRanDelegationSummaries.join('\n\n')
        yield { type: 'text_delta', delta: combined }
        assistantTurns.push([{ type: 'text', text: combined }])
        break
      }
    }

    // Owner canceled mid-turn: do not persist a partial assistant reply or emit
    // 'done'. The cancel endpoint already marked the turn canceled.
    if (canceled) return

    // Persist assistant message.
    const textContent = assistantTurns.flat().filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    let joinedText = textContent.map((b) => b.text).join('\n')
    // Deadline/abort salvage — mirrors run-owner-turn.ts: never persist an EMPTY
    // reply (strands the owner mid-task AND leaves a context hole in replayed
    // history so the next turn restarts the task from scratch).
    const coreDeadlineHit = Boolean(signal?.aborted) || deadlineNudgeSent
    const coreTaskUnfinished = shouldAutoContinueTurn({
      deadlineHit: coreDeadlineHit,
      hasAskCard: emittedAskCards.length > 0,
      tools: toolRecords,
    })
    if (!joinedText.trim()) {
      const okSteps = toolRecords.filter((r: ToolRecord) => r.status === 'success').length
      joinedText = [
        okSteps > 0
          ? `এই টার্নে ${okSteps}টা ধাপ সম্পন্ন হয়েছে, তারপর সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে।`
          : 'সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে।',
        coreTaskUnfinished ? 'Boss, “continue” বললে ঠিক এখান থেকে কাজ চালিয়ে যাব।' : '',
      ].filter(Boolean).join('\n\n')
      yield { type: 'text_delta', delta: joinedText }
    }
    const storedContent: StoredContentBlock[] = [{ type: 'text', text: joinedText }]
    // Append confirm-card breadcrumbs so the approval card (and its eventual
    // approved/rejected outcome) survives a page reload — issue: cards vanished
    // on refresh because only text blocks were persisted.
    for (const card of emittedConfirmCards) storedContent.push(card)
    // Ask-card breadcrumbs — same reload-survival rationale as confirm cards.
    for (const card of emittedAskCards) storedContent.push(card)
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
        // Persist the reasoning trace in usage metadata (display-only) so the
        // "Thought for Ns" block survives reload; the GET route surfaces it as
        // `thinking`/`thinkingMs` and history replay never sees it.
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens, reasoning: thinkingText.trim() ? thinkingText.trim().slice(0, 12000) : undefined, reasoningMs: thinkingMs ?? undefined, timeline: timeline.length > 0 ? timeline.slice(0, 60) : undefined },
      },
    })

    embedMessageInBackground(savedMsg.id, storedContent)

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
      needContinue: coreTaskUnfinished,
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

/**
 * LangGraph.js deterministic routine-turn graph (owner decision 2026-07-15).
 *
 * The owner's highest-frequency questions (today's sales, who is in the office,
 * stock, pending orders) don't need a model to CHOOSE tools — the task is fixed.
 * Improvising it every turn is where cheap heads make their "dumb mistakes"
 * (wrong tool, invented numbers, zero tool calls). This graph removes the
 * model's freedom exactly where the task is known:
 *
 *   detect_intent (pure regex) ──▶ run_tool (CODE executes the mapped read
 *   tool via the normal validated executor) ──▶ format_reply (the cheap model
 *   only words the Bangla answer from the fresh JSON — its native strength).
 *
 * Contract with the caller (run-owner-turn):
 *  - handled=false on ANY miss/failure (unknown intent, tool error, empty model
 *    reply) → the normal head loop runs exactly as before. Fail-open, always.
 *  - handled=true returns replyText + a toolRecord shaped like the loop's own
 *    ledger entries, so persistence, claim-verifier, timeline and cost math see
 *    a perfectly ordinary turn.
 *
 * Scope: read-only intents only (zero approval risk). LG-0 shipped 4; LG-1
 * (2026-07-15) widened to 9 from real usage — expense today, staff task status,
 * salah times, pending approvals, order status by number (single slot-fill).
 * Rollout mirrors the state-router discipline: AGENT_LANGGRAPH_ROUTINE=true
 * force-on / =false kill switch; default ON in Vercel preview, OFF in
 * production until the owner canaries it (LG-1 gate: 1-week preview soak,
 * then the owner sets AGENT_LANGGRAPH_ROUTINE=true in production — env flip,
 * no redeploy of code paths).
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { executeTool } from '@/agent/tools/registry'
import { isRetryableErrorCode } from '@/agent/tools/tool-contract'
import { adapterFor } from '@/agent/lib/models/adapters'
import type { ModelEntry } from '@/agent/lib/models/registry'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { OwnerTurnAuthorization } from '@/agent/lib/turn-authorization'

export type RoutineIntent =
  | 'sales_today'
  | 'attendance'
  | 'stock'
  | 'orders_pending'
  | 'expense_today'
  | 'staff_tasks'
  | 'salah_today'
  | 'approvals_pending'
  | 'order_status'

/** YYYY-MM-DD in Asia/Dhaka (same helper shape as staff-tools). */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/**
 * Order/invoice number in the owner's message — "#1234", "order 1234",
 * "অর্ডার ALM-1234". Latin digits only (the sheet's invoice numbers are Latin);
 * a Bangla-digit number simply stays with the model loop.
 */
export function extractOrderNumber(text: string): string | null {
  const m = /(?:#|\b(?:order|invoice)\s*(?:no\.?|number|id)?\s*#?|অর্ডার\s*(?:নং|নাম্বার)?\s*#?)\s*([A-Za-z]{0,6}-?\d{3,12})\b/i.exec(text)
  return m ? m[1] : null
}

/**
 * intent → the ONE read tool + exact args that answer it. Args must satisfy each
 * tool's strict schema — get_sales_summary REQUIRES from/to (2026-07-15 preview
 * incident: the graph sent {} for it, Ajv rejected, and every sales lookup
 * silently fell open to the normal loop; the others genuinely default).
 * Returns null when a required slot is missing (order_status without a number) —
 * the caller treats that as a miss and the normal loop answers.
 */
export function routineIntentCall(
  intent: RoutineIntent,
  userText: string,
): { toolName: string; args: Record<string, unknown> } | null {
  switch (intent) {
    case 'sales_today': {
      const today = dhakaToday()
      return { toolName: 'get_sales_summary', args: { from: today, to: today } }
    }
    case 'attendance':
      return { toolName: 'get_attendance', args: {} }
    case 'stock':
      return { toolName: 'get_inventory_status', args: {} }
    case 'orders_pending':
      return { toolName: 'get_dashboard_snapshot', args: {} }
    case 'expense_today':
      // Personal expense ledger, today window; grouped so the model can word
      // "কোথায় কত গেল" without doing arithmetic itself.
      return { toolName: 'get_expense_summary', args: { period: 'today', groupBy: 'category' } }
    case 'staff_tasks':
      // Whole-office today view (2-5 staff — small JSON). No fuzzy staffName arg:
      // name matching is a judgement call, and a wrong fuzzy hit would answer
      // about the WRONG person. The format model quotes the asked-about staff
      // from the full grouped list instead.
      return { toolName: 'get_staff_tasks', args: {} }
    case 'salah_today':
      return { toolName: 'get_prayer_times', args: {} }
    case 'approvals_pending':
      return { toolName: 'get_pending_approvals', args: {} }
    case 'order_status': {
      const orderNumber = extractOrderNumber(userText)
      if (!orderNumber) return null
      // orderNumber filter searches the most recent 100 orders (get_orders LG-1
      // param). Older/unknown numbers return an empty list → intent-level miss
      // below → normal loop (which can search wider), never a bluffed "নেই".
      return { toolName: 'get_orders', args: { orderNumber, limit: 100 } }
    }
  }
}

/** intent → tool name (kept for tests/telemetry). */
export const ROUTINE_INTENT_TOOL: Record<RoutineIntent, string> = {
  sales_today: 'get_sales_summary',
  attendance: 'get_attendance',
  stock: 'get_inventory_status',
  orders_pending: 'get_dashboard_snapshot',
  expense_today: 'get_expense_summary',
  staff_tasks: 'get_staff_tasks',
  salah_today: 'get_prayer_times',
  approvals_pending: 'get_pending_approvals',
  order_status: 'get_orders',
}

/**
 * Intent-level miss: the tool succeeded but the data can't answer THIS question
 * deterministically — fall open so the full loop (wider search, judgement) takes
 * over instead of the graph asserting a wrong "পাওয়া যায়নি".
 * Today only order_status needs it: the number filter only sees the most recent
 * 100 orders, so "not in the list" ≠ "doesn't exist".
 */
export function isIntentLevelMiss(intent: RoutineIntent, toolOutput: Record<string, unknown> | null): boolean {
  if (intent !== 'order_status') return false
  const data = (toolOutput?.data ?? null) as { orders?: unknown } | null
  return !data || !Array.isArray(data.orders) || data.orders.length === 0
}

// Narrower than head-router's ROUTINE_RE on purpose: each pattern must map to
// exactly ONE tool with high precision — anything fuzzier stays on the normal
// model loop. Same word-boundary discipline as the 2026-07-14 ROUTINE_RE fix.
// ORDER MATTERS: first hit wins, so the more specific intents (order_status
// with a number, expense with a today-word) sit ABOVE their fuzzier cousins.
const INTENT_RES: Array<{ intent: RoutineIntent; re: RegExp }> = [
  {
    intent: 'sales_today',
    re: /((aj|ajk|ajke|আজ|আজকে)[^\n]{0,20}(sell|sale|sales|bikri|বিক্রি|বিক্রয়|সেল|revenue|আয়))|((koto|কত)[^\n]{0,12}(sell|sale|bikri|বিক্রি|সেল))/i,
  },
  {
    // LG-1. TODAY-word required in either order — "ei mash e koto khoroch"
    // (month) must NOT hit a today-window tool call; period questions stay
    // with the model loop, which can pick the right period argument.
    intent: 'expense_today',
    re: /((\baj\b|\bajk\b|\bajke\b|\bajker\b|আজ|আজকে|আজকের|\btoday\b)[^\n]{0,24}(khoroch|kharoch|খরচ|expense))|((khoroch|kharoch|খরচ|expense)[^\n]{0,24}(\baj\b|\bajke\b|\bajker\b|আজ|আজকে|আজকের|\btoday\b))/i,
  },
  {
    intent: 'attendance',
    re: /((\bke\b|কে(?![ঀ-ৼ])|\bkara\b|কারা)[^\n]{0,20}(office|অফিস|\base\b|আছে|present|উপস্থিত|hajir|হাজির))|attendance|হাজিরা|উপস্থিতি/i,
  },
  {
    // LG-1: "Eyafi ke ki task dise", "task gulo r status ki", "notun task ase?"
    // Status-lookup phrasings only — assignment commands ("task dao/koro") must
    // stay with the model loop (they end in an approval card, never the graph).
    intent: 'staff_tasks',
    re: /((ki|কি|কী|kon|কোন)\s*(task|টাস্ক))|((task|টাস্ক)[^\n]{0,14}(dise|dice|দিছে|দিয়েছে|dewa|দেওয়া|status|স্ট্যাটাস|hoise|হয়েছে|\base\b|আছে|koto|কত))/i,
  },
  {
    // LG-1: waqt time questions only ("namaz koyta y", "asr kokhon") — a time
    // word is REQUIRED so salah-log talk ("namaz porsi") never hits this.
    intent: 'salah_today',
    re: /((namaz|namaj|নামাজ|নামায|salah|salat|সালাত|ছালাত)[^\n]{0,16}(somoy|সময়|time|টাইম|schedule|সূচি|waqt|ওয়াক্ত|kokhon|কখন|koyta|কয়টা|কটায়))|((\bfajr\b|\bfojor\b|\bzuhr\b|\bjohor\b|\basr\b|\basor\b|\bmaghrib\b|\bisha\b|ফজর|জোহর|যোহর|আসর|মাগরিব|এশা)[^\n]{0,12}(somoy|সময়|time|টাইম|kokhon|কখন|koyta|কয়টা|কটায়))/i,
  },
  {
    // LG-1: pending-approvals count/list. An approval word is REQUIRED —
    // bare "ki ki baki" is ambiguous (orders? tasks?) and stays with the model.
    intent: 'approvals_pending',
    re: /((approval|অ্যাপ্রুভাল|এপ্রুভাল|onumodon|অনুমোদন)[^\n]{0,14}(pending|পেন্ডিং|baki|বাকি|koto|কত|ache|আছে|\base\b))|((pending|পেন্ডিং)[^\n]{0,12}(approval|অ্যাপ্রুভাল|এপ্রুভাল|অনুমোদন|card|কার্ড))|((koto|কত|ki\s*ki|কী\s*কী|কি\s*কি)[^\n]{0,10}(approval|অ্যাপ্রুভাল|এপ্রুভাল|অনুমোদন))/i,
  },
  {
    // LG-1: order status by number — sits ABOVE orders_pending so
    // "order 1234 koto dur" resolves to the single order, not the count.
    // detectRoutineIntent additionally requires an extractable number.
    intent: 'order_status',
    re: /((order|অর্ডার|invoice|#)\s*#?\s*[A-Za-z]{0,6}-?\d{3,12})[^\n]{0,24}(status|স্ট্যাটাস|obostha|অবস্থা|kothay|কোথায়|koi|কই|update|আপডেট|\bki\b|কি(?![ঀ-ৼ])|কী|hoise|হয়েছে|deliver|ডেলিভার|ship|koto\s*dur|কতদূর|কত\s*দূর)/i,
  },
  {
    intent: 'orders_pending',
    re: /((koto|কত|how\s*many)[^\n]{0,12}(order|অর্ডার|pending|পেন্ডিং))|((order|অর্ডার|pending|পেন্ডিং)[^\n]{0,12}(koto|কত|count|সংখ্যা))/i,
  },
  {
    intent: 'stock',
    re: /\bstock\b|স্টক|মজুদ|\binventory\b/i,
  },
]

/** Pure + exported for tests: the graph handles a message only on a confident hit. */
export function detectRoutineIntent(userText: string): RoutineIntent | null {
  const text = (userText ?? '').trim()
  // Real routine lookups are short ("aj koto sale holo"). Anything longer
  // almost always carries EXTRA intent (a task, a follow-up instruction) that a
  // fixed read tool can't serve — that stays with the model loop.
  if (!text || text.length > 80) return null
  for (const { intent, re } of INTENT_RES) {
    if (!re.test(text)) continue
    // order_status is only confident WITH an extractable number — "order status
    // ki" (no number) needs the model loop's judgement about which orders.
    if (intent === 'order_status' && !extractOrderNumber(text)) continue
    return intent
  }
  return null
}

// English rules, Bangla output — cheap models follow English instructions far
// more reliably while the OWNER-facing answer stays pure Bangla (project rule).
const FORMAT_SYSTEM =
  'You are ALMA ERP\'s assistant answering the business owner. You are given the ' +
  'owner\'s question and fresh JSON just fetched from the ERP — it is the single ' +
  'source of truth. Write ONLY the answer in warm, concise Bangla (2–6 short lines). ' +
  'Address the owner as "Boss" — NEVER "Sir"/"স্যার". Use the numbers from the JSON ' +
  'exactly as they are; never invent, estimate or extrapolate. Money is Taka (৳). ' +
  'No JSON, no code blocks, no tables. If the JSON clearly contains no data for the ' +
  'question, say so honestly in one line.'

/** Why the graph declined a turn — logged on the route span (LG-1 telemetry). */
export type RoutineGraphMissReason =
  | 'no_intent' // no confident pattern hit — the vast majority of turns
  | 'slot' // intent hit but a required slot was missing (order number)
  | 'tool_failed' // mapped tool errored (after retries, where retryable)
  | 'intent_miss' // tool ok but data can't answer THIS question (order not in window)
  | 'empty_reply' // format model returned nothing
  | 'graph_error' // unexpected throw — failed open

export interface RoutineGraphResult {
  handled: boolean
  intent: RoutineIntent | null
  missReason: RoutineGraphMissReason | null
  replyText: string
  usage: { inputTokens: number; outputTokens: number }
  toolRecord: {
    id: string
    toolName: string
    input: Record<string, unknown>
    output: Record<string, unknown> | null
    status: 'success' | 'error'
    durationMs: number
    error: string | null
  } | null
}

/**
 * LG-1: transient tool failure (timeout / rate-limit / network / provider 5xx)
 * thrown as a distinct class so the run_tool node's LangGraph retryPolicy
 * retries EXACTLY this and nothing else — a deterministic bad_args or not_found
 * would fail identically on every attempt and must fall open immediately.
 */
export class RetryableRoutineToolError extends Error {
  constructor(toolName: string, errorCode: string, message: string) {
    super(`[${toolName}] ${errorCode}: ${message}`)
    this.name = 'RetryableRoutineToolError'
  }
}

const RoutineState = Annotation.Root({
  userText: Annotation<string>,
  intent: Annotation<RoutineIntent | null>({ reducer: (_a, b) => b, default: () => null }),
  /** LG-1: required slot missing (order number) — miss without running any tool. */
  slotMiss: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  /** LG-1: tool ok but data can't answer this question — fall open, never bluff. */
  intentMiss: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  toolName: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  toolArgs: Annotation<Record<string, unknown>>({ reducer: (_a, b) => b, default: () => ({}) }),
  toolOutput: Annotation<Record<string, unknown> | null>({ reducer: (_a, b) => b, default: () => null }),
  toolSuccess: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  toolError: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  toolDurationMs: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  replyText: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  inputTokens: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  outputTokens: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
})

export interface RoutineGraphDeps {
  model: ModelEntry
  businessId: AgentBusinessId
  conversationId?: string
  turnId?: string | null
  turnAuthorization?: OwnerTurnAuthorization
  signal?: AbortSignal
}

/**
 * Run the routine graph for one owner message. Never throws — any internal
 * failure resolves to { handled: false } so the caller's normal loop answers.
 */
export async function runRoutineTurnGraph(
  userText: string,
  deps: RoutineGraphDeps,
): Promise<RoutineGraphResult> {
  const miss = (reason: RoutineGraphMissReason, intent: RoutineIntent | null = null): RoutineGraphResult => ({
    handled: false,
    intent,
    missReason: reason,
    replyText: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    toolRecord: null,
  })
  try {
    const graph = new StateGraph(RoutineState)
      .addNode('detect_intent', (s) => ({ intent: detectRoutineIntent(s.userText) }))
      .addNode(
        'run_tool',
        async (s) => {
          const call = routineIntentCall(s.intent as RoutineIntent, s.userText)
          if (!call) return { slotMiss: true }
          const { toolName, args } = call
          const started = Date.now()
          const result = await executeTool(toolName, args, {
            conversationId: deps.conversationId,
            businessId: deps.businessId,
            modelId: deps.model.id,
            turnId: deps.turnId ?? undefined,
            turnAuthorization: deps.turnAuthorization,
          })
          const out = (result ?? {}) as unknown as Record<string, unknown>
          const failed = out.success === false
          // Transient failure → throw the retryable class; the node's
          // retryPolicy re-runs THIS node only (LG-1). Deterministic failures
          // return through the normal miss path immediately. Gate on the error
          // CODE, not the envelope's `retryable` flag: `malformed_args` sets
          // retryable=true to tell the MODEL to fix its args — our args are
          // code-built constants, so retrying them verbatim can never help.
          if (
            failed &&
            typeof out.errorCode === 'string' &&
            isRetryableErrorCode(out.errorCode)
          ) {
            throw new RetryableRoutineToolError(
              toolName,
              typeof out.errorCode === 'string' ? out.errorCode : 'unknown',
              typeof out.error === 'string' ? out.error : 'transient failure',
            )
          }
          return {
            toolName,
            toolArgs: args,
            toolOutput: out,
            toolSuccess: !failed,
            toolError: typeof out.error === 'string' ? out.error : null,
            toolDurationMs: Date.now() - started,
            intentMiss: !failed && isIntentLevelMiss(s.intent as RoutineIntent, out),
          }
        },
        {
          // Bounded + fast: routine turns are interactive, so at most 2 retries
          // with sub-second backoff — a still-down provider falls open to the
          // normal loop (which explains) instead of hanging the owner's chat.
          retryPolicy: {
            maxAttempts: 3,
            initialInterval: 250,
            backoffFactor: 2,
            maxInterval: 1_000,
            retryOn: (e: unknown) => e instanceof RetryableRoutineToolError,
          },
        },
      )
      .addNode('format_reply', async (s) => {
        const adapter = adapterFor(deps.model.provider)
        // Strip bulky/irrelevant fields before showing the model the data.
        const json = JSON.stringify(s.toolOutput ?? {}).slice(0, 12_000)
        let text = ''
        let inputTokens = 0
        let outputTokens = 0
        for await (const ev of adapter.streamTurn({
          apiModel: deps.model.apiModel,
          system: FORMAT_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Owner's question: ${s.userText}\n\nERP data from ${s.toolName} (JSON):\n${json}`,
            },
          ],
          tools: [],
          thinking: 'none',
          signal: deps.signal,
        })) {
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'usage') {
            inputTokens += ev.inputTokens
            outputTokens += ev.outputTokens
          }
        }
        return { replyText: text.trim(), inputTokens, outputTokens }
      })
      .addEdge(START, 'detect_intent')
      .addConditionalEdges('detect_intent', (s) => (s.intent ? 'run_tool' : END), ['run_tool', END])
      // A failed read (DB down, wrong business…), a missing slot or an
      // intent-level miss falls back to the full model loop, which knows how
      // to explain/diagnose/search wider — the graph never bluffs.
      .addConditionalEdges(
        'run_tool',
        (s) => (s.toolSuccess && !s.slotMiss && !s.intentMiss ? 'format_reply' : END),
        ['format_reply', END],
      )
      .addEdge('format_reply', END)
      .compile()

    const s = await graph.invoke(
      { userText },
      { signal: deps.signal, recursionLimit: 8 },
    )

    console.log(
      `[routine-graph] intent=${s.intent ?? 'none'} tool=${s.toolName || '-'} toolOk=${s.toolSuccess} slotMiss=${s.slotMiss} intentMiss=${s.intentMiss} replyLen=${s.replyText.length}`,
    )
    if (!s.intent) return miss('no_intent')
    if (s.slotMiss) return miss('slot', s.intent)
    if (!s.toolSuccess) return miss('tool_failed', s.intent)
    if (s.intentMiss) return miss('intent_miss', s.intent)
    if (!s.replyText) return miss('empty_reply', s.intent)

    return {
      handled: true,
      intent: s.intent,
      missReason: null,
      replyText: s.replyText,
      usage: { inputTokens: s.inputTokens, outputTokens: s.outputTokens },
      toolRecord: {
        id: `graph_${s.toolName}_${Date.now()}`,
        toolName: s.toolName,
        input: s.toolArgs,
        output: s.toolOutput,
        status: 'success',
        durationMs: s.toolDurationMs,
        error: null,
      },
    }
  } catch (err) {
    console.warn('[routine-graph] failed open → normal loop:', err instanceof Error ? err.message : err)
    return miss('graph_error')
  }
}

/**
 * Rollout gate (state-router discipline): force with AGENT_LANGGRAPH_ROUTINE=
 * true/false; otherwise ON in Vercel preview only — production stays on the
 * proven loop until the owner canaries this.
 */
export function isRoutineGraphEnabled(
  flag = process.env.AGENT_LANGGRAPH_ROUTINE,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  if (flag === 'true') return true
  if (flag === 'false') return false
  return vercelEnv === 'preview'
}

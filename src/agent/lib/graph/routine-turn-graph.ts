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
 * Scope: intentionally 4 read-only intents (zero approval risk). Widen only
 * after the owner has lived with it. Rollout mirrors the state-router
 * discipline: AGENT_LANGGRAPH_ROUTINE=true force-on / =false kill switch;
 * default ON in Vercel preview, OFF in production until the owner canaries it.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { executeTool } from '@/agent/tools/registry'
import { adapterFor } from '@/agent/lib/models/adapters'
import type { ModelEntry } from '@/agent/lib/models/registry'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { OwnerTurnAuthorization } from '@/agent/lib/turn-authorization'

export type RoutineIntent = 'sales_today' | 'attendance' | 'stock' | 'orders_pending'

/** YYYY-MM-DD in Asia/Dhaka (same helper shape as staff-tools). */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/**
 * intent → the ONE read tool + exact args that answer it. Args must satisfy each
 * tool's strict schema — get_sales_summary REQUIRES from/to (2026-07-15 preview
 * incident: the graph sent {} for it, Ajv rejected, and every sales lookup
 * silently fell open to the normal loop; the other three genuinely default).
 */
export function routineIntentCall(intent: RoutineIntent): { toolName: string; args: Record<string, unknown> } {
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
  }
}

/** intent → tool name (kept for tests/telemetry). */
export const ROUTINE_INTENT_TOOL: Record<RoutineIntent, string> = {
  sales_today: 'get_sales_summary',
  attendance: 'get_attendance',
  stock: 'get_inventory_status',
  orders_pending: 'get_dashboard_snapshot',
}

// Narrower than head-router's ROUTINE_RE on purpose: each pattern must map to
// exactly ONE tool with high precision — anything fuzzier stays on the normal
// model loop. Same word-boundary discipline as the 2026-07-14 ROUTINE_RE fix.
const INTENT_RES: Array<{ intent: RoutineIntent; re: RegExp }> = [
  {
    intent: 'sales_today',
    re: /((aj|ajk|ajke|আজ|আজকে)[^\n]{0,20}(sell|sale|sales|bikri|বিক্রি|বিক্রয়|সেল|revenue|আয়))|((koto|কত)[^\n]{0,12}(sell|sale|bikri|বিক্রি|সেল))/i,
  },
  {
    intent: 'attendance',
    re: /((\bke\b|কে(?![ঀ-ৼ])|\bkara\b|কারা)[^\n]{0,20}(office|অফিস|\base\b|আছে|present|উপস্থিত|hajir|হাজির))|attendance|হাজিরা|উপস্থিতি/i,
  },
  {
    intent: 'stock',
    re: /\bstock\b|স্টক|মজুদ|\binventory\b/i,
  },
  {
    intent: 'orders_pending',
    re: /((koto|কত|how\s*many)[^\n]{0,12}(order|অর্ডার|pending|পেন্ডিং))|((order|অর্ডার|pending|পেন্ডিং)[^\n]{0,12}(koto|কত|count|সংখ্যা))/i,
  },
]

/** Pure + exported for tests: the graph handles a message only on a confident hit. */
export function detectRoutineIntent(userText: string): RoutineIntent | null {
  const text = (userText ?? '').trim()
  // Real routine lookups are short ("aj koto sale holo"). Anything longer
  // almost always carries EXTRA intent (a task, a follow-up instruction) that a
  // fixed read tool can't serve — that stays with the model loop.
  if (!text || text.length > 80) return null
  for (const { intent, re } of INTENT_RES) if (re.test(text)) return intent
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

export interface RoutineGraphResult {
  handled: boolean
  intent: RoutineIntent | null
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

const RoutineState = Annotation.Root({
  userText: Annotation<string>,
  intent: Annotation<RoutineIntent | null>({ reducer: (_a, b) => b, default: () => null }),
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
  const miss: RoutineGraphResult = {
    handled: false,
    intent: null,
    replyText: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    toolRecord: null,
  }
  try {
    const graph = new StateGraph(RoutineState)
      .addNode('detect_intent', (s) => ({ intent: detectRoutineIntent(s.userText) }))
      .addNode('run_tool', async (s) => {
        const { toolName, args } = routineIntentCall(s.intent as RoutineIntent)
        const started = Date.now()
        const result = await executeTool(toolName, args, {
          conversationId: deps.conversationId,
          businessId: deps.businessId,
          modelId: deps.model.id,
          turnId: deps.turnId ?? undefined,
          turnAuthorization: deps.turnAuthorization,
        })
        const out = (result ?? {}) as unknown as Record<string, unknown>
        return {
          toolName,
          toolArgs: args,
          toolOutput: out,
          toolSuccess: out.success !== false,
          toolError: typeof out.error === 'string' ? out.error : null,
          toolDurationMs: Date.now() - started,
        }
      })
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
      // A failed read (DB down, wrong business…) falls back to the full model
      // loop, which knows how to explain/diagnose — the graph never bluffs.
      .addConditionalEdges('run_tool', (s) => (s.toolSuccess ? 'format_reply' : END), ['format_reply', END])
      .addEdge('format_reply', END)
      .compile()

    const s = await graph.invoke(
      { userText },
      { signal: deps.signal, recursionLimit: 8 },
    )

    console.log(
      `[routine-graph] intent=${s.intent ?? 'none'} tool=${s.toolName || '-'} toolOk=${s.toolSuccess} replyLen=${s.replyText.length}`,
    )
    if (!s.intent || !s.toolSuccess || !s.replyText) return { ...miss, intent: s.intent ?? null }

    return {
      handled: true,
      intent: s.intent,
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
    return miss
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

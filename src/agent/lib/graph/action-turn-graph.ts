/**
 * LG-3 — human-in-the-loop pilot: ONE approval card type (log_expense) runs as
 * a LangGraph interrupt (docs/langgraph-adoption-roadmap.md, phase LG-3).
 *
 * Flow ("graph pauses at the exact step → owner taps card → graph resumes at
 * that step"):
 *
 *   1. Owner turn: detectExpenseAction() (pure regex + slots — the task is
 *      fixed, the model gets zero freedom) → the caller creates the ORDINARY
 *      agentPendingAction row (existing card UI, zero UI change) with a
 *      graphThread bridge in its payload → the graph runs to `stage_action`,
 *      whose interrupt() pauses it with the LG-2 checkpointer persisting the
 *      exact position. The turn replies with a fixed Bangla staging line.
 *   2. Approve route: AFTER its own guards (owner auth, status==='pending',
 *      expiry) it resumes the thread with Command({resume}) — the interrupt is
 *      TRANSPORT, never authorization (roadmap invariant). The `execute`
 *      node claims the row atomically and writes the expense.
 *   3. Reject: legacy route only — the paused thread is simply abandoned and
 *      the LG-2 TTL cleanup deletes it later. No resume needed to say no.
 *
 * Fail-open, always: any miss/failure while STAGING → {staged:false} and the
 * proven model loop handles the message; any failure while RESUMING → the
 * approve route falls back to its legacy inline execution. Both executors go
 * through ONE claim-guarded helper, so the fallback can never double-write.
 *
 * Rollout: AGENT_LANGGRAPH_INTERRUPT=true force-on / =false kill switch;
 * default ON in Vercel preview, OFF in production (state-router discipline).
 * Also requires the LG-2 checkpointer — interrupts don't exist without it.
 */
import { StateGraph, Annotation, START, END, interrupt, Command } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { prisma } from '@/lib/prisma'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const EXPENSE_ACTION_NS = 'expense_action'

/** Rollout gate — same shape as LG-0/1/2 gates. */
export function isActionGraphEnabled(
  flag = process.env.AGENT_LANGGRAPH_INTERRUPT,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  if (flag === 'true') return true
  if (flag === 'false') return false
  return vercelEnv === 'preview'
}

// ── Detection + slots (pure, exported for tests) ─────────────────────────────

export interface ExpenseSlots {
  amount: number
  currency: 'BDT' | 'AED'
  note: string
}

const BN_DIGITS: Record<string, string> = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' }
function latinDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => BN_DIGITS[d] ?? d)
}

const AMOUNT_CURRENCY_RE = /([০-৯\d][০-৯\d,]*)\s*(taka|tk|টাকা|৳|aed|dirham|দিরহাম)/i
// Log-intent verb near "khoroch": হলো/করলাম/hoise/gelo/add koro — NOT the
// question forms (koto/কত), which belong to the routine READ intent.
const EXPENSE_LOG_RE = /(khoroch|kharoch|খরচ)[^\n]{0,24}(holo|hoise|hoyeche|korlam|korsi|gelo|gese|হলো|হয়েছে|করলাম|করেছি|গেল|গেছে|add|লিখে?\s*রাখো|likh)|((add|log|likho|লিখো|লিখে\s*রাখো)[^\n]{0,16}(khoroch|খরচ))/i
// History words → the model loop (which can ask/choose the date) keeps it.
const NOT_TODAY_RE = /(gotokal|কাল(?:কে)?র?\s|গতকাল|last\s*(week|month)|আগের|goto\s*(mash|shoptaho))/i
// Question forms are reads, never logs.
const QUESTION_RE = /(koto|কত|কি\s*পরিমাণ)[^\n]{0,12}(khoroch|খরচ)|(khoroch|খরচ)[^\n]{0,12}(koto|কত)/i

/**
 * Confident log_expense hit + slots, or null. Precision-first: requires an
 * explicit amount+currency token AND a log-verb near "khoroch"; refuses
 * questions, history dates and long multi-intent messages.
 */
export function detectExpenseAction(userText: string): ExpenseSlots | null {
  const text = (userText ?? '').trim()
  if (!text || text.length > 100) return null
  if (QUESTION_RE.test(text) || NOT_TODAY_RE.test(text)) return null
  if (!EXPENSE_LOG_RE.test(text)) return null
  const m = AMOUNT_CURRENCY_RE.exec(text)
  if (!m) return null
  const amount = Math.round(Number(latinDigits(m[1]).replace(/,/g, '')))
  if (!Number.isFinite(amount) || amount <= 0) return null
  const currency: 'BDT' | 'AED' = /aed|dirham|দিরহাম/i.test(m[2]) ? 'AED' : 'BDT'
  // The note is the message minus the amount token — the message IS the
  // description; if stripping leaves nothing useful, keep the whole message.
  const stripped = text.replace(AMOUNT_CURRENCY_RE, ' ').replace(/\s+/g, ' ').trim()
  const note = stripped.length >= 3 ? stripped : text
  return { amount, currency, note }
}

// ── The graph ────────────────────────────────────────────────────────────────

type ResumeDecision = { approved: boolean; pendingActionId: string }

const ActionState = Annotation.Root({
  pendingActionId: Annotation<string>,
  summary: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  decision: Annotation<ResumeDecision | null>({ reducer: (_a, b) => b, default: () => null }),
  executed: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  expenseId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  executeError: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
})

/**
 * Claim-guarded executor — the ONE write path both the graph node and the
 * approve route's legacy fallback use. Atomically flips the row
 * pending → executed and inserts the expense in the SAME transaction, so a
 * double call (graph resume + legacy fallback, double-tap, retry) can never
 * double-log money: the second caller's claim matches 0 rows and it stops.
 */
export async function claimAndExecuteLogExpense(pendingActionId: string): Promise<{
  executed: boolean
  expenseId: string | null
  reason?: 'not_claimable' | 'bad_payload'
}> {
  return db.$transaction(async (tx: typeof db) => {
    const claimed = await tx.agentPendingAction.updateMany({
      where: { id: pendingActionId, status: { in: ['pending', 'approved'] } },
      data: { status: 'executed', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return { executed: false, expenseId: null, reason: 'not_claimable' as const }
    const row = await tx.agentPendingAction.findUnique({
      where: { id: pendingActionId },
      select: { payload: true },
    })
    const p = (row?.payload ?? {}) as { amount?: number; currency?: string; category?: string | null; note?: string; occurredAt?: string }
    const amount = Math.round(Number(p.amount))
    if (!Number.isFinite(amount) || amount <= 0 || !p.note) {
      // Bad payload aborts the transaction → the claim rolls back too.
      throw Object.assign(new Error('log_expense payload invalid'), { code: 'bad_payload' })
    }
    const expense = await tx.agentFinanceExpense.create({
      data: {
        amount,
        currency: p.currency ?? 'BDT',
        category: p.category ?? null,
        note: String(p.note),
        occurredAt: p.occurredAt ? new Date(p.occurredAt) : new Date(),
      },
      select: { id: true },
    })
    await tx.agentPendingAction.update({
      where: { id: pendingActionId },
      data: { result: { expenseId: expense.id } },
    })
    return { executed: true, expenseId: expense.id as string }
  })
}

function buildExpenseActionGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ActionState)
    .addNode('stage_action', (s) => {
      // First run pauses HERE (LG-2 checkpointer persists the position); the
      // approve route's Command({resume}) re-enters with the owner's decision.
      const decision = interrupt<{ kind: string; pendingActionId: string; summary: string }, ResumeDecision>({
        kind: 'log_expense',
        pendingActionId: s.pendingActionId,
        summary: s.summary,
      })
      return { decision }
    })
    .addNode('execute', async (s) => {
      if (!s.decision?.approved) return { executed: false }
      try {
        const r = await claimAndExecuteLogExpense(s.decision.pendingActionId)
        return { executed: r.executed, expenseId: r.expenseId, executeError: r.executed ? null : (r.reason ?? 'not_claimable') }
      } catch (err) {
        return { executed: false, executeError: err instanceof Error ? err.message : String(err) }
      }
    })
    .addEdge(START, 'stage_action')
    .addEdge('stage_action', 'execute')
    .addEdge('execute', END)
    .compile({ checkpointer })
}

// ── Staging (owner turn) ─────────────────────────────────────────────────────

export interface StageExpenseResult {
  staged: boolean
  pendingActionId: string | null
  summary: string
  replyText: string
}

/**
 * Detect + stage one expense card as a paused graph thread. Never throws.
 * The pendingAction row is created FIRST (its id names the thread —
 * thread_id `action:<id>`, so every card is its own resumable thread), then
 * the graph runs until interrupt() parks it at stage_action.
 */
export async function stageExpenseActionGraph(
  userText: string,
  deps: { conversationId?: string | null; turnId?: string | null },
): Promise<StageExpenseResult> {
  const miss: StageExpenseResult = { staged: false, pendingActionId: null, summary: '', replyText: '' }
  try {
    if (!isActionGraphEnabled()) return miss
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) {
      console.log('[action-graph] gate on but checkpointer unavailable → normal loop')
      return miss
    }
    const slots = detectExpenseAction(userText)
    if (!slots) return miss

    const occurredAt = new Date()
    const money = slots.currency === 'BDT' ? `৳${slots.amount}` : `${slots.amount} AED`
    const summary = `খরচ: ${money}${slots.note ? ` — ${slots.note}` : ''}`.slice(0, 200)
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: deps.conversationId ?? null,
        type: 'log_expense',
        payload: {
          amount: slots.amount,
          currency: slots.currency,
          category: null,
          note: slots.note,
          occurredAt: occurredAt.toISOString(),
          // LG-3 bridge: pendingActionId ↔ (thread_id, checkpoint_ns). Kept in
          // the payload the approve route already loads — no extra table/join.
          graphThread: { threadId: `action:pending`, ns: EXPENSE_ACTION_NS },
        },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
      select: { id: true },
    })
    const pendingActionId = action.id as string
    const threadId = `action:${pendingActionId}`
    await db.agentPendingAction.update({
      where: { id: pendingActionId },
      data: {
        payload: {
          amount: slots.amount,
          currency: slots.currency,
          category: null,
          note: slots.note,
          occurredAt: occurredAt.toISOString(),
          graphThread: { threadId, ns: EXPENSE_ACTION_NS },
        },
      },
    })

    const graph = buildExpenseActionGraph(checkpointer)
    const cfg = checkpointConfigFor({ conversationId: threadId, turnId: deps.turnId, namespace: EXPENSE_ACTION_NS })
    const out = await graph.invoke({ pendingActionId, summary }, cfg)
    const interrupted = Array.isArray((out as Record<string, unknown>).__interrupt__) &&
      ((out as Record<string, unknown>).__interrupt__ as unknown[]).length > 0
    if (!interrupted) {
      // The graph somehow ran through without pausing — do NOT hand the owner
      // a card wired to a thread that can't resume; void it and fall open.
      await db.agentPendingAction.update({
        where: { id: pendingActionId },
        data: { status: 'cancelled', resolvedAt: new Date(), result: { error: 'graph_did_not_interrupt' } },
      }).catch(() => {})
      console.warn('[action-graph] staged graph did not interrupt → voided card, normal loop')
      return miss
    }
    console.log(`[action-graph] staged log_expense card ${pendingActionId} thread=${threadId} amount=${slots.amount}${slots.currency}`)
    return {
      staged: true,
      pendingActionId,
      summary,
      replyText: `Boss, খরচের কার্ড পাঠালাম — ${summary}। Approve করলেই লিখে রাখব।`,
    }
  } catch (err) {
    console.warn('[action-graph] staging failed open → normal loop:', err instanceof Error ? err.message : err)
    return miss
  }
}

// ── Resume (approve route) ───────────────────────────────────────────────────

export interface ResumeExpenseResult {
  resumed: boolean
  executed: boolean
  expenseId: string | null
  error: string | null
}

/**
 * Resume a paused expense thread with the owner's decision. Called by the
 * approve route AFTER its own auth/status/expiry guards — transport, not
 * authorization. Never throws; {resumed:false} tells the route to run its
 * legacy inline path (which shares the same claim-guarded executor, so the
 * fallback can never double-write).
 */
export async function resumeExpenseActionGraph(opts: {
  pendingActionId: string
  threadId: string
}): Promise<ResumeExpenseResult> {
  const fail = (error: string): ResumeExpenseResult => ({ resumed: false, executed: false, expenseId: null, error })
  try {
    if (!isActionGraphEnabled()) return fail('gate_off')
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return fail('no_checkpointer')
    const graph = buildExpenseActionGraph(checkpointer)
    const cfg = checkpointConfigFor({ conversationId: opts.threadId, turnId: null, namespace: EXPENSE_ACTION_NS })
    const out = await graph.invoke(
      new Command({ resume: { approved: true, pendingActionId: opts.pendingActionId } satisfies ResumeDecision }),
      cfg,
    )
    const s = out as { executed?: boolean; expenseId?: string | null; executeError?: string | null }
    console.log(
      `[action-graph] resumed ${opts.pendingActionId} thread=${opts.threadId} executed=${s.executed === true} error=${s.executeError ?? '-'}`,
    )
    return { resumed: true, executed: s.executed === true, expenseId: s.expenseId ?? null, error: s.executeError ?? null }
  } catch (err) {
    console.warn('[action-graph] resume failed open → legacy execute:', err instanceof Error ? err.message : err)
    return fail(err instanceof Error ? err.message : String(err))
  }
}

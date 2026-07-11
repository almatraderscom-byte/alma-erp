/**
 * Answer Gate — serve a VERIFIED saved answer instead of paying an expensive
 * head turn (owner decision 2026-07-08).
 *
 * Owner's constraints, encoded as hard rules:
 *  - EXPENSIVE HEADS ONLY (Gemini Pro / Qwen Max / any Anthropic). DeepSeek-class
 *    turns are already pennies — they bypass the gate entirely, zero risk there.
 *  - VERY HIGH CONFIDENCE ONLY. The owner has been burned by "clever" shortcuts
 *    answering wrong. Every layer fails toward "no gate → normal agent":
 *      1. deny-list: anything data-fresh (sales/orders/stock/attendance/আজ/এখন),
 *         money amounts, actions (বানাও/পাঠাও/call), salah — NEVER gated;
 *      2. standalone-question heuristic — follow-ups/continuations never gated
 *         (they need conversation context the gate doesn't have);
 *      3. pgvector similarity ≥ 0.95 (kv-tunable) against SAVED, ACTIVE,
 *         UNEXPIRED pairs in the SAME scope;
 *      4. served answers carry a visible 💾 provenance line + "fresh চাইলে বলুন"
 *         so a stale hit is one message away from a real turn.
 *  - WRITES are conservative: only tool-free, card-free answers from expensive
 *    heads pass the heuristics, then a cheap classifier must confirm the pair is
 *    stable for ≥30 days. No classifier key → no save (fail-closed on writes).
 *
 * Rollout mirrors the other cost levers: ON in Vercel preview, prod OFF until
 * AGENT_ANSWER_GATE=true. Kill switch: AGENT_ANSWER_GATE=false.
 */
import OpenAI from 'openai'
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { getModel } from '@/agent/lib/models/registry'
import { logCost } from '@/agent/lib/cost-events'

export const ANSWER_GATE_ENABLED = (() => {
  const flag = process.env.AGENT_ANSWER_GATE
  if (flag === 'true') return true
  if (flag === 'false') return false
  return process.env.VERCEL_ENV === 'preview'
})()

/** Expensive = the gate is worth its risk. DeepSeek/flash-lite class bypasses. */
export function isExpensiveHead(model: ReturnType<typeof getModel>): boolean {
  return model.provider === 'anthropic' || model.inPerM >= 1
}

const DEFAULT_MIN_SIM = 0.95
const SAVE_TTL_DAYS = 30
const MAX_ANSWER_CHARS = 1500
const MIN_ANSWER_CHARS = 40

/**
 * HARD deny-list — anything matching here is NEVER gated (read) and NEVER
 * cached (write). Three families:
 *  - live/fresh data: sales, orders, stock, attendance, balances, dates-relative
 *  - actions/tasks: make/send/post/call/delete — the agent must actually work
 *  - salah + money figures: owner-sensitive, always a real turn
 */
export const GATE_DENY_RE = new RegExp(
  [
    // live-data intents
    'sale|sell|বিক্রি|সেল|revenue|আয়|order|অর্ডার|stock|স্টক|মজুদ|inventory|pending|পেন্ডিং',
    'attendance|হাজিরা|উপস্থিত|check\\s*in|অফিসে|office\\s*(e|te)|টাস্ক|task|balance|ব্যালেন্স',
    // time-relative freshness
    '\\b(aj|ajke|ajk)\\b|আজ|গতকাল|kal\\b|কাল|ekhon|এখন|এই\\s*মুহূর্ত|live|fresh|নতুন\\s*করে|আপডেট|update|সর্বশেষ|latest',
    // money figures / quantities
    '৳|\\btk\\b|টাকা|koto\\b|কত',
    // actions the agent must actually perform
    'banaw|banao|বানাও|lekho|লেখ|likhe|kore\\s*dao|করে\\s*দাও|পাঠাও|pathao|send|post|পোস্ট|ছবি|image|ক্যাম্পেইন|campaign|call|কল|delete|মুছ|ডিলিট|approve|reject',
    // salah — always a real turn (auto-mark, conscience nudges live there)
    'নামাজ|নামায|namaz|salah|সালাত|ফজর|যোহর|জোহর|আসর|মাগরিব|এশা|ইশা',
  ].join('|'),
  'i',
)

/** Continuation/follow-up starts — these need conversation context, never gate. */
const FOLLOWUP_RE =
  /^\s*(ok|okay|accha|আচ্ছা|hmm+|ji|জি|ha|হ্যাঁ|na\b|না\b|tarpor|তারপর|then|erpor|এরপর|oita|ওইটা|oitar|আগের|ager|r\b|আর\b|\?+\s*$)/i

/** Question-ish signal (Bangla + Banglish + English). */
const QUESTION_RE = /\?|(\b(ki|kivabe|kothay|kar|kader|keno|kobe|konta|which|what|how|where|who|why|when)\b)|কি\b|কী\b|কিভাবে|কোথায়|কার|কেন|কবে|কোনটা/i

/**
 * Standalone knowledge-question check — ALL gate reads and writes require this.
 * Exported for tests.
 */
export function isGateableQuestion(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < 10 || t.length > 220) return false
  if (FOLLOWUP_RE.test(t)) return false
  if (GATE_DENY_RE.test(t)) return false
  return QUESTION_RE.test(t)
}

async function minSimilarity(): Promise<number> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: 'agent.answer_gate.minSim' } })
    const v = parseFloat(row?.value ?? '')
    return Number.isFinite(v) && v >= 0.85 && v <= 0.999 ? v : DEFAULT_MIN_SIM
  } catch {
    return DEFAULT_MIN_SIM
  }
}

export type GateHit = {
  id: string
  answer: string
  similarity: number
  verifiedAt: Date | null
  createdAt: Date
}

/**
 * Try to answer from the cache. Returns null on ANY doubt — a miss just means
 * the normal agent runs, so every failure mode here is safe.
 */
export async function tryAnswerGate(
  text: string,
  scope: 'business' | 'personal',
): Promise<GateHit | null> {
  try {
    if (!ANSWER_GATE_ENABLED) return null
    if (!isGateableQuestion(text)) return null

    const embedResult = await embed(text)
    if (!embedResult.success) return null
    const vec = vectorLiteral(embedResult.data)

    const rows: Array<{
      id: string
      answer: string
      score: number
      verified_at: Date | null
      createdAt: Date
    }> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$queryRawUnsafe(
        `SELECT id, answer, verified_at, "createdAt",
                1 - (embedding <=> $1::vector) AS score
         FROM agent_qa_cache
         WHERE active = true AND scope = $2 AND embedding IS NOT NULL
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY embedding <=> $1::vector
         LIMIT 1`,
        vec,
        scope,
      )
    const top = rows[0]
    if (!top) return null
    const minSim = await minSimilarity()
    if (top.score < minSim) return null
    return {
      id: top.id,
      answer: top.answer,
      similarity: Math.round(top.score * 1000) / 1000,
      verifiedAt: top.verified_at,
      createdAt: top.createdAt,
    }
  } catch (err) {
    console.warn('[answer-gate] lookup failed (falling through to agent):', err instanceof Error ? err.message : err)
    return null
  }
}

/** Bump serve counters + emit a zero-ish cost event so hit-rate is measurable. */
export async function recordGateServe(hit: GateHit, conversationId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).agentQaCache.update({
      where: { id: hit.id },
      data: { hits: { increment: 1 }, lastServedAt: new Date() },
    })
  } catch {
    /* counter loss is fine */
  }
  void logCost({
    provider: 'openai',
    kind: 'chat',
    units: { model: 'answer-gate', via: 'answer_gate', qaId: hit.id, similarity: hit.similarity },
    costUsd: 0,
    conversationId,
    dedupKey: `gate:${hit.id}:${Date.now()}`,
  }).catch(() => {})
}

// ── Write path ────────────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM =
  'You judge whether a Q&A pair from a Bangla business assistant is SAFE to cache and replay for 30 days. ' +
  'Answer "yes" ONLY if ALL hold: the answer states stable facts (contacts, policies, standing rules, how-things-work); ' +
  'it contains NO live/derived numbers (sales, stock, counts, balances), NO dates-relative claims (today/now/yesterday), ' +
  'NO promises to do something, and would still be correct a month from now. If in ANY doubt answer "no". ' +
  'Reply with exactly one word: yes or no.'

function classifierClient(): OpenAI | null {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) return null
  const referer = process.env.APP_URL?.replace(/\/$/, '') ?? 'https://alma-erp-six.vercel.app'
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: { 'HTTP-Referer': referer, 'X-Title': 'ALMA ERP Agent (qa-cache classify)' },
  })
}

/**
 * Conservative post-turn save: heuristics first, then a cheap DeepSeek classifier
 * must say "yes". Fail-CLOSED on writes (no key / any error → nothing cached).
 * Fire-and-forget from the turn — never blocks or throws.
 */
export async function maybeCacheQaPair(opts: {
  question: string
  answer: string
  scope: 'business' | 'personal'
  sourceModelId: string
  usedTools: boolean
  hadCards: boolean
  conversationId?: string
}): Promise<void> {
  try {
    if (!ANSWER_GATE_ENABLED) return
    const model = getModel(opts.sourceModelId)
    if (!isExpensiveHead(model)) return // cheap-head answers are cheap to recompute
    if (opts.usedTools || opts.hadCards) return // tool/card turns are never static facts
    const q = opts.question.trim()
    const a = opts.answer.trim()
    if (!isGateableQuestion(q)) return
    if (a.length < MIN_ANSWER_CHARS || a.length > MAX_ANSWER_CHARS) return
    if (GATE_DENY_RE.test(a)) return // answer itself references live data/actions

    // Cheap classifier confirm (~$0.0001). No key → conservative skip.
    const client = classifierClient()
    if (!client) return
    const clsModel = getModel(process.env.CHEAP_HEAD_TRIAGE_MODEL_ID?.trim() || 'or-deepseek-v4-flash')
    const resp = await client.chat.completions.create(
      {
        model: clsModel.apiModel,
        max_tokens: 3,
        temperature: 0,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: `Q: ${q.slice(0, 500)}\nA: ${a.slice(0, 1200)}` },
        ],
      },
      { signal: AbortSignal.timeout(8000) },
    )
    const verdict = (resp.choices[0]?.message?.content ?? '').toLowerCase()
    if (!verdict.includes('yes')) return

    const embedResult = await embed(q)
    if (!embedResult.success) return
    const vec = vectorLiteral(embedResult.data)

    // Near-duplicate → refresh that row instead of inserting a twin.
    const dupes: Array<{ id: string; score: number }> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$queryRawUnsafe(
        `SELECT id, 1 - (embedding <=> $1::vector) AS score
         FROM agent_qa_cache
         WHERE active = true AND scope = $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 1`,
        vec,
        opts.scope,
      )
    const expiresAt = new Date(Date.now() + SAVE_TTL_DAYS * 24 * 3600_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    if (dupes[0] && dupes[0].score >= DEFAULT_MIN_SIM) {
      await db.agentQaCache.update({
        where: { id: dupes[0].id },
        data: { answer: a, verifiedAt: new Date(), expiresAt, sourceModel: model.id, active: true },
      })
      return
    }
    const row = await db.agentQaCache.create({
      data: {
        scope: opts.scope,
        question: q,
        answer: a,
        sourceModel: model.id,
        verifiedAt: new Date(),
        expiresAt,
      },
      select: { id: true },
    })
    await db.$executeRawUnsafe(
      `UPDATE agent_qa_cache SET embedding = $1::vector, "updatedAt" = NOW() WHERE id = $2`,
      vec,
      row.id,
    )
  } catch (err) {
    console.warn('[answer-gate] cache write skipped:', err instanceof Error ? err.message : err)
  }
}

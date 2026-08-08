import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { blendedScore } from '@/agent/lib/memory-rerank'
import {
  BOTH_ARMS_BONUS,
  NO_LEXEME_TSQUERY,
  buildLikePatterns,
  buildOrTsQuery,
  extractQueryTokens,
  fuseRrf,
  keywordSimilarityProxy,
  rawPhrasePatterns,
  type RankedArmHit,
} from '@/agent/lib/memory-hybrid'
import {
  MEMORY_MAX_ITEMS,
  MEMORY_RETRIEVAL_TIMEOUT_MS,
  applyMemoryBudget,
  withMemoryTimeout,
} from '@/agent/lib/memory-budget'
import { retrieveMemoryDigests } from '@/agent/lib/memory-digest'
import type { RelevantMemory } from '@/agent/lib/system-prompt'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

const HIGH_IMPORTANCE = /(পছন্দ|না করবে|ভুল হয়েছিল|flop|late|deadline|promise|কথা দিয়েছ|target|loss)/i

const SIMILARITY_THRESHOLD = 0.45
const VECTOR_FETCH_LIMIT = 20
/** Keyword arm depth — matched to the vector arm so neither dominates the fusion. */
const KEYWORD_FETCH_LIMIT = 20
/** Fused candidates carried into the reranker before the budget trims to final size. */
const FUSED_POOL = 15

function resolveImportance(content: string, explicit?: number | null): number {
  if (explicit != null && explicit >= 1 && explicit <= 5) return explicit
  return HIGH_IMPORTANCE.test(content) ? 4 : 2
}

// ── Ephemeral hard rules (owner rule 2026-07-08) ──────────────────────────────
// Day-scoped facts ("আজ অফিস ছুটি", "৮ জুলাই ছুটি দিয়েছেন", daily salah logs)
// kept piling up as PERMANENT memories, polluting retrieval and paying context
// cost forever. The model is asked to classify duration when saving, but the
// server enforces a floor: an obviously day-scoped fact gets an expiry EVEN IF
// the model forgot to set one. Pinned facts are exempt (pinned = owner-standing).

/** Day-scoped signals: today/that-date events that stop mattering afterwards. */
const EPHEMERAL_DAY_RE = new RegExp(
  [
    // "আজ/আজকে … ছুটি/বন্ধ/অফ" — today-only office state
    '(aj|ajk|ajke|আজ|আজকে)[^\\n]{0,40}(ছুটি|বন্ধ|off|holiday|chuti)',
    '(ছুটি|বন্ধ|holiday|chuti)[^\\n]{0,40}(aj|ajk|ajke|আজ|আজকে)',
    // dated one-day events: "8 July 2026 … ছুটি / বন্ধ / সফরে"
    '\\d{1,2}\\s*(জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*\\d{2,4}[^\\n]{0,60}(ছুটি|বন্ধ|সফর|off|holiday|leave)',
    // daily salah logs: "2026-07-05 তারিখে মাগরিব নামাজ … পড়েছেন"
    'তারিখে[^\\n]{0,30}(নামাজ|সালাত|salah)[^\\n]{0,30}(পড়েছেন|পড়া হয়নি|মিস)',
    '(নামাজ|সালাত)[^\\n]{0,30}(পড়েছেন|আদায়)[^\\n]{0,20}\\d{4}-\\d{2}-\\d{2}',
    // nightly muhasaba reflections are per-day journal entries, not standing facts
    'সালাহ মুহাসাবা',
  ].join('|'),
  'i',
)

/** End of the CURRENT Dhaka day plus a small grace window (so "আজ" survives the day). */
function endOfDhakaDayPlus(days: number): Date {
  const now = new Date()
  // Dhaka = UTC+6, no DST. End of Dhaka day = 17:59:59 UTC of the same Dhaka date.
  const dhakaNow = new Date(now.getTime() + 6 * 3600_000)
  const endOfDayUtcMs = Date.UTC(
    dhakaNow.getUTCFullYear(), dhakaNow.getUTCMonth(), dhakaNow.getUTCDate(), 23, 59, 59,
  ) - 6 * 3600_000
  return new Date(endOfDayUtcMs + days * 24 * 3600_000)
}

/** Exposed for the weekly revision: does this content read as a day-scoped fact? */
export function isEphemeralDayFact(content: string): boolean {
  return EPHEMERAL_DAY_RE.test(content)
}

/**
 * Server-side expiry floor. An explicit expiry DATE always wins. But a caller
 * claiming "permanent" (explicit null) does NOT override the day-scope regex —
 * HARD RULE: an unpinned, obviously day-scoped fact gets end-of-day+2 no matter
 * what the model said (grace so "কালকে কি বলেছিলাম?" still finds it, then it
 * ages out). Pinned facts are owner-standing and stay exempt.
 */
export function resolveMemoryExpiry(
  content: string,
  opts: { pinned: boolean; explicit?: Date | null },
): Date | null {
  if (opts.explicit instanceof Date) return opts.explicit
  if (opts.pinned) return null
  if (EPHEMERAL_DAY_RE.test(content)) return endOfDhakaDayPlus(2)
  return null
}

/**
 * Builds the scope/business WHERE fragment for owner-facing memory retrieval.
 *
 * Personal mode → personal memories only (a personal chat must not pull business
 * facts). Business mode → business/staff memories scoped to the active business,
 * PLUS all personal memories. The owner is the same person across every chat, so
 * a personal fact ("বসের স্ত্রীর নাম: Mim, নম্বর …") must still surface when
 * asked inside a business thread. Previously business mode used `scope != 'personal'`,
 * which hard-excluded personal memories — so the agent truthfully said it couldn't
 * find a number that was actually saved. Personal memories are cross-business and
 * only ever reach the owner-facing head, so including them leaks nothing to staff.
 * Semantic threshold + rerank still gate them, so irrelevant personal facts don't
 * pollute a business turn.
 */
function buildMemoryAccessClause(personalMode: boolean, businessId: AgentBusinessId): string {
  if (personalMode) return `AND scope = 'personal'`
  const businessFilter =
    businessId === 'ALMA_TRADING'
      ? `metadata->>'businessId' = 'ALMA_TRADING'`
      : `(metadata->>'businessId' IS NULL OR metadata->>'businessId' = 'ALMA_LIFESTYLE')`
  return `AND (scope = 'personal' OR (scope != 'personal' AND ${businessFilter}))`
}

export async function attachMemoryEmbedding(
  memoryId: string,
  content: string,
): Promise<{ embedded: boolean; error?: string }> {
  const embedResult = await embed(content)
  if (!embedResult.success) {
    return { embedded: false, error: embedResult.error }
  }
  try {
    const vec = vectorLiteral(embedResult.data)
    // Prisma Unsupported(vector) — attach embedding via raw SQL.
    await (prisma as unknown as { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> })
      .$executeRawUnsafe(
        `UPDATE agent_memory SET embedding = $1::vector, "updatedAt" = NOW() WHERE id = $2`,
        vec,
        memoryId,
      )
    return { embedded: true }
  } catch (err) {
    return { embedded: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function createOrUpdateAgentMemory(opts: {
  scope: string
  key?: string | null
  content: string
  pinned?: boolean
  metadata?: Record<string, unknown> | null
  importance?: number | null
  /** Explicit expiry (temporary fact). undefined → server hard-rule decides; null → permanent. */
  expiresAt?: Date | null
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const content = opts.content.trim()
  const scope = opts.scope
  const key = opts.key?.trim() || null
  const pinned = opts.pinned === true
  const metadata = opts.metadata ?? undefined
  const importance = resolveImportance(content, opts.importance)
  const expiresAt = resolveMemoryExpiry(content, { pinned, explicit: opts.expiresAt })

  let row: {
    id: string
    scope: string
    key: string | null
    content: string
    pinned: boolean
    createdAt: Date
  }

  if (key) {
    const existing = await db.agentMemory.findFirst({
      where: { scope, key },
      select: { id: true },
    })
    if (existing) {
      row = await db.agentMemory.update({
        where: { id: existing.id },
        data: { content, pinned, importance, expiresAt, ...(metadata !== undefined ? { metadata } : {}) },
        select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true },
      })
      const embedStatus = await attachMemoryEmbedding(row.id, content)
      return { ...row, embedStatus }
    }
  }

  // Duplicate hard rule (owner rule 2026-07-08): the head kept re-saving the SAME
  // observation day after day ("cost price নেই…" ×4 in 4 days) — each a new row,
  // each polluting retrieval. A keyless save whose content matches an existing
  // unpinned row in the same scope UPDATES that row (refreshes recency/expiry)
  // instead of inserting another copy.
  const dupe = await db.agentMemory.findFirst({
    where: { scope, pinned: false, content },
    select: { id: true },
  })
  if (dupe) {
    row = await db.agentMemory.update({
      where: { id: dupe.id },
      data: { importance, expiresAt, ...(metadata !== undefined ? { metadata } : {}) },
      select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true },
    })
    return { ...row, embedStatus: { embedded: true } as { embedded: boolean; error?: string } }
  }

  row = await db.agentMemory.create({
    data: { scope, key, content, pinned, importance, expiresAt, ...(metadata !== undefined ? { metadata } : {}) },
    select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true },
  })
  const embedStatus = await attachMemoryEmbedding(row.id, content)
  return { ...row, embedStatus }
}

async function reinforceMemoriesOnUse(selectedIds: string[]): Promise<void> {
  if (selectedIds.length === 0) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).$executeRawUnsafe(
    `UPDATE agent_memory
     SET access_count = access_count + 1, last_used_at = NOW()
     WHERE id = ANY($1::text[])`,
    selectedIds,
  )
}

/** One fact row as returned by either retrieval arm. */
interface FactRow {
  id: string
  content: string
  scope: string
  importance: number
  createdAt: Date
  last_used_at: Date | null
  score?: number
  /** True when the row matched an ILIKE pattern, not merely a shared lexeme. */
  literal_match?: boolean
}

/** Vector arm: semantic match. Returns [] when embeddings are unavailable. */
async function vectorArm(vec: string, accessClause: string): Promise<FactRow[]> {
  const rows: FactRow[] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).$queryRawUnsafe(
      `SELECT id, content, scope, importance, "createdAt", last_used_at,
              1 - (embedding <=> $1::vector) AS score
       FROM agent_memory
       WHERE embedding IS NOT NULL AND pinned = false ${accessClause}
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY embedding <=> $1::vector
       LIMIT ${VECTOR_FETCH_LIMIT}`,
      vec,
    )
  return rows.filter((r) => (r.score ?? 0) >= SIMILARITY_THRESHOLD)
}

/**
 * Keyword arm: exact-token match, the half embeddings are bad at (order ids,
 * phone numbers, names, product codes). 'simple' config = no stemming, which is
 * what makes it work for Bangla; pg_trgm ILIKE catches partial/inflected forms.
 *
 * A query that yields no tokens (all stopwords, or a word shorter than three
 * letters like "মা") falls back to searching the raw phrase — otherwise, when
 * the embedding is also unavailable, BOTH arms would go silent and the turn
 * would lose memory it used to find (Codex P2, PR #711).
 */
async function keywordArm(tokens: string[], rawQuery: string, accessClause: string): Promise<FactRow[]> {
  const tsQuery = tokens.length > 0 ? buildOrTsQuery(tokens) : NO_LEXEME_TSQUERY
  const likePatterns = tokens.length > 0 ? buildLikePatterns(tokens) : rawPhrasePatterns(rawQuery)
  // Nothing to match on at all — an empty ILIKE array would be a no-op anyway,
  // and a bare '%%' pattern would match every row.
  if (tokens.length === 0 && likePatterns.length === 0) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Literal matches sort FIRST (Codex P2, PR #711). A row found only through
  // ILIKE — an inflected Bangla word, an identifier Postgres tokenises its own
  // way — has ts_rank 0, so ordering by rank alone let twenty ordinary full-text
  // matches push the exact hit past the LIMIT. That row is the entire reason
  // this arm exists, so it must never be the one that gets cut.
  return (prisma as any).$queryRawUnsafe(
    `SELECT id, content, scope, importance, "createdAt", last_used_at,
            (content ILIKE ANY($2::text[])) AS literal_match,
            ts_rank(to_tsvector('simple', content), to_tsquery('simple', $1)) AS score
     FROM agent_memory
     WHERE pinned = false ${accessClause}
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (to_tsvector('simple', content) @@ to_tsquery('simple', $1)
            OR content ILIKE ANY($2::text[]))
     ORDER BY literal_match DESC, score DESC, COALESCE(last_used_at, "createdAt") DESC
     LIMIT ${KEYWORD_FETCH_LIMIT}`,
    tsQuery,
    likePatterns,
  )
}

/**
 * Hybrid recall for one turn: digest layers first, then facts fused from the
 * vector and keyword arms.
 *
 * Both arms run in parallel and are merged with Reciprocal Rank Fusion, so a
 * fact that only one arm can see still surfaces while the ones both arms agree
 * on rank highest. The final list passes through the retrieval budget, and the
 * whole thing is time-boxed — a slow database costs the turn its memory, never
 * the owner's reply.
 */
/** What one retrieval pass produced: what to inject, and what to mark as used. */
interface RetrievalOutcome {
  memories: RelevantMemory[]
  /** Fact rows that actually made it into the prompt — never digest blocks. */
  factIds: string[]
}

export async function retrieveRelevantMemories(
  userMessage: string,
  personalMode: boolean,
  businessId: AgentBusinessId,
): Promise<RelevantMemory[]> {
  // Reinforcement lives OUTSIDE the raced work on purpose (Codex P2, PR #711).
  // Marking a memory "used" lifts its future ranking, so it must happen only for
  // memories the turn actually received. An abort check inside the race is not
  // enough — the deadline can pass while the UPDATE itself is in flight, and the
  // statement cannot be cancelled. Running it after the race removes the window
  // entirely instead of narrowing it.
  //
  // `null` distinguishes "lost the race or failed" from "won, found nothing".
  const outcome = await withMemoryTimeout<RetrievalOutcome | null>(
    retrieveRelevantMemoriesUnbounded(userMessage, personalMode, businessId),
    null,
    MEMORY_RETRIEVAL_TIMEOUT_MS,
    'agent-memory',
  )
  if (!outcome) return []

  if (outcome.factIds.length > 0) {
    // Dispatched, not awaited (Codex P2, PR #711). The timeout above promises
    // that a slow database costs the turn its memory and not the owner's reply —
    // awaiting an unbounded UPDATE right after it would hand that latency back.
    // Bookkeeping does not belong on the response path; the request stays alive
    // for the model call that follows, which is far longer than this statement.
    void reinforceMemoriesOnUse(outcome.factIds).catch((err) => {
      console.warn('[agent-memory] reinforceMemoriesOnUse failed:', err instanceof Error ? err.message : err)
    })
  }
  return outcome.memories
}

async function retrieveRelevantMemoriesUnbounded(
  userMessage: string,
  personalMode: boolean,
  businessId: AgentBusinessId,
): Promise<RetrievalOutcome> {
  try {
    const accessClause = buildMemoryAccessClause(personalMode, businessId)
    const tokens = extractQueryTokens(userMessage)

    const embedResult = await embed(userMessage)
    const vec = embedResult.success ? vectorLiteral(embedResult.data) : null

    const [vectorRows, keywordRows, digests] = await Promise.all([
      vec ? vectorArm(vec, accessClause) : Promise.resolve<FactRow[]>([]),
      keywordArm(tokens, userMessage, accessClause),
      retrieveMemoryDigests({ queryVector: vec ?? undefined, personalMode, businessId }),
    ])

    const byId = new Map<string, FactRow>()
    const vectorSimilarity = new Map<string, number>()
    const keywordRank = new Map<string, number>()

    const vectorHits: RankedArmHit[] = vectorRows.map((row, rank) => {
      byId.set(row.id, row)
      vectorSimilarity.set(row.id, row.score ?? 0)
      return { id: row.id, rank }
    })
    const keywordHits: RankedArmHit[] = keywordRows.map((row, rank) => {
      if (!byId.has(row.id)) byId.set(row.id, row)
      keywordRank.set(row.id, rank)
      // `exact` breaks ties in the fusion, so it must mean a LITERAL match —
      // not merely "found by the keyword arm" (Codex P2, PR #711). A row that
      // shares only a generic lexeme ("ord" out of "ORD-123") has earned no
      // priority over a semantic hit.
      return { id: row.id, rank, exact: row.literal_match === true }
    })

    const now = new Date()
    const fused = fuseRrf([vectorHits, keywordHits]).slice(0, FUSED_POOL)

    const scored = fused
      .map((hit) => {
        const row = byId.get(hit.id)
        if (!row) return null
        const similarity =
          vectorSimilarity.get(hit.id) ?? keywordSimilarityProxy(keywordRank.get(hit.id) ?? KEYWORD_FETCH_LIMIT)
        const rankable = {
          id: row.id,
          content: row.content,
          similarity,
          importance: row.importance,
          createdAt: row.createdAt,
          lastUsedAt: row.last_used_at,
        }
        // Agreement between the two arms is the one signal a hybrid setup adds
        // that neither arm produces alone — worth a small, explicit nudge.
        const score = blendedScore(rankable, now) + (hit.arms > 1 ? BOTH_ARMS_BONUS : 0)
        return { id: row.id, content: row.content, scope: row.scope, score }
      })
      .filter((x): x is { id: string; content: string; scope: string; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)

    const budgeted = applyMemoryBudget(scored, { maxItems: MEMORY_MAX_ITEMS })

    return {
      memories: [
        // Digest blocks lead: they are the compressed picture the facts belong to.
        ...digests.map((d) => ({
          id: d.id,
          content: d.content,
          scope: 'digest',
          score: Math.round(d.score * 100) / 100,
        })),
        ...budgeted.kept.map((m) => ({
          id: m.id,
          content: m.content,
          scope: m.scope,
          score: Math.round(m.score * 100) / 100,
        })),
      ],
      factIds: budgeted.kept.map((m) => m.id),
    }
  } catch (err) {
    console.warn('[agent-memory] retrieveRelevantMemories failed:', err instanceof Error ? err.message : err)
    return { memories: [], factIds: [] }
  }
}

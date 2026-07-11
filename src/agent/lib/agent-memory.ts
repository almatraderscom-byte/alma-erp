import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { blendedScore, rerankMemories } from '@/agent/lib/memory-rerank'
import type { RelevantMemory } from '@/agent/lib/system-prompt'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

const HIGH_IMPORTANCE = /(পছন্দ|না করবে|ভুল হয়েছিল|flop|late|deadline|promise|কথা দিয়েছ|target|loss)/i

const SIMILARITY_THRESHOLD = 0.45
const VECTOR_FETCH_LIMIT = 20
const RERANK_TAKE = 6

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
 * a personal fact ("স্যারের স্ত্রীর নাম: Mim, নম্বর …") must still surface when
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

export async function retrieveRelevantMemories(
  userMessage: string,
  personalMode: boolean,
  businessId: AgentBusinessId,
): Promise<RelevantMemory[]> {
  try {
    const accessClause = buildMemoryAccessClause(personalMode, businessId)
    const embedResult = await embed(userMessage)
    if (!embedResult.success) {
      // ILIKE fallback when embedding is unavailable
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fbRows: Array<{ id: string; content: string; scope: string }> = await (prisma as any).$queryRawUnsafe(
        `SELECT id, content, scope FROM agent_memory
         WHERE pinned = false AND content ILIKE $1 ${accessClause}
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY "createdAt" DESC LIMIT 6`,
        `%${userMessage.slice(0, 100)}%`,
      )
      return fbRows.map((r) => ({ id: r.id, content: r.content, scope: r.scope, score: 0.5 }))
    }

    const vec = vectorLiteral(embedResult.data)

    const rows: Array<{
      id: string
      content: string
      scope: string
      score: number
      importance: number
      createdAt: Date
      last_used_at: Date | null
    }> =
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

    const now = new Date()
    const candidates = rows
      .filter((r) => r.score >= SIMILARITY_THRESHOLD)
      .map((r) => ({
        id: r.id,
        content: r.content,
        scope: r.scope,
        similarity: r.score,
        importance: r.importance,
        createdAt: r.createdAt,
        lastUsedAt: r.last_used_at,
      }))

    const ranked = rerankMemories(candidates, RERANK_TAKE, now)
    const selectedIds = ranked.map((m) => m.id)

    try {
      await reinforceMemoriesOnUse(selectedIds)
    } catch (err) {
      console.warn('[agent-memory] reinforceMemoriesOnUse failed:', err instanceof Error ? err.message : err)
    }

    return ranked.map((m) => ({
      id: m.id,
      content: m.content,
      scope: m.scope,
      score: Math.round(blendedScore(m, now) * 100) / 100,
    }))
  } catch (err) {
    console.warn('[agent-memory] retrieveRelevantMemories failed:', err instanceof Error ? err.message : err)
    return []
  }
}

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
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const content = opts.content.trim()
  const scope = opts.scope
  const key = opts.key?.trim() || null
  const pinned = opts.pinned === true
  const metadata = opts.metadata ?? undefined
  const importance = resolveImportance(content, opts.importance)

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
        data: { content, pinned, importance, ...(metadata !== undefined ? { metadata } : {}) },
        select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true },
      })
      const embedStatus = await attachMemoryEmbedding(row.id, content)
      return { ...row, embedStatus }
    }
  }

  row = await db.agentMemory.create({
    data: { scope, key, content, pinned, importance, ...(metadata !== undefined ? { metadata } : {}) },
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

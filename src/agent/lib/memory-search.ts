import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'

export type AgentMemoryHit = {
  id: string
  scope: string
  key: string | null
  content: string
  pinned: boolean
  metadata: Record<string, unknown> | null
  score: number | null
}

export async function searchAgentMemory(opts: {
  query: string
  scope?: string
  limit?: number
  metadataType?: string
}): Promise<AgentMemoryHit[]> {
  const query = opts.query.trim()
  if (!query) return []

  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20)
  const scope = opts.scope?.trim() || undefined
  const metadataType = opts.metadataType?.trim() || undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const embedResult = await embed(query)
  if (!embedResult.success) {
    const rows = await db.agentMemory.findMany({
      where: {
        ...(scope ? { scope } : {}),
        content: { contains: query, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 3,
      select: { id: true, scope: true, key: true, content: true, pinned: true, metadata: true },
    })
    return rows
      .filter((r: { metadata: unknown }) => {
        if (!metadataType) return true
        const meta = r.metadata as { type?: string } | null
        return meta?.type === metadataType
      })
      .slice(0, limit)
      .map((r: { id: string; scope: string; key: string | null; content: string; pinned: boolean; metadata: unknown }) => ({
        id: r.id,
        scope: r.scope,
        key: r.key,
        content: r.content,
        pinned: r.pinned,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        score: null,
      }))
  }

  const vec = vectorLiteral(embedResult.data)
  const scopeClause = scope ? `AND scope = '${scope.replace(/'/g, "''")}'` : ''
  const metaClause = metadataType
    ? `AND metadata->>'type' = '${metadataType.replace(/'/g, "''")}'`
    : ''

  const rows: Array<{
    id: string
    scope: string
    key: string | null
    content: string
    pinned: boolean
    metadata: Record<string, unknown> | null
    score: number
  }> = await db.$queryRawUnsafe(
    `SELECT id, scope, key, content, pinned, metadata,
            1 - (embedding <=> $1::vector) AS score
     FROM agent_memory
     WHERE embedding IS NOT NULL ${scopeClause} ${metaClause}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    vec,
    limit,
  )

  return rows
    .filter((r) => r.score >= 0.35)
    .map((r) => ({
      id: r.id,
      scope: r.scope,
      key: r.key,
      content: r.content,
      pinned: r.pinned,
      metadata: r.metadata ?? null,
      score: Math.round(r.score * 100) / 100,
    }))
}

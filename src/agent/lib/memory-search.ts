/**
 * The agent's explicit memory-search tool ("আগে কী বলেছিলাম?").
 *
 * Hybrid since 2026-08-03: a vector arm for meaning and a keyword arm for exact
 * tokens, merged with Reciprocal Rank Fusion. This is the path the head uses
 * when it is deliberately looking something up, and it is exactly where
 * vector-only recall hurt most — an order id or a person's name is a string, not
 * a concept, and the embedding kept losing it.
 */
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import {
  NO_LEXEME_TSQUERY,
  buildLikePatterns,
  buildOrTsQuery,
  extractQueryTokens,
  fuseRrf,
  rawPhrasePatterns,
  type RankedArmHit,
} from '@/agent/lib/memory-hybrid'

export type AgentMemoryHit = {
  id: string
  scope: string
  key: string | null
  content: string
  pinned: boolean
  metadata: Record<string, unknown> | null
  score: number | null
}

/** Semantic floor for the vector arm (unchanged). */
const VECTOR_THRESHOLD = 0.35
/** Fetch depth per arm before fusion — deeper than `limit` so fusion has room. */
const ARM_FETCH_MULTIPLIER = 3
/**
 * Expired facts must not come back through search (Codex P2, PR #711).
 *
 * A day-scoped fact ("আজ অফিস ছুটি") stops being true after its expiry, and the
 * per-turn retrieval path has always filtered on this. This search path did NOT
 * — not on the new keyword arm and, as it turns out, not on the pre-existing
 * vector arm either. Both are filtered now, so an old daily event cannot
 * resurface as if it were still standing.
 */
const LIVE_FACTS_ONLY = `AND (expires_at IS NULL OR expires_at > NOW())`

type Row = {
  id: string
  scope: string
  key: string | null
  content: string
  pinned: boolean
  metadata: Record<string, unknown> | null
  score: number
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
  const fetchDepth = limit * ARM_FETCH_MULTIPLIER
  const scope = opts.scope?.trim() || undefined
  const metadataType = opts.metadataType?.trim() || undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const scopeClause = scope ? `AND scope = '${scope.replace(/'/g, "''")}'` : ''
  const metaClause = metadataType
    ? `AND metadata->>'type' = '${metadataType.replace(/'/g, "''")}'`
    : ''

  const tokens = extractQueryTokens(query)
  const embedResult = await embed(query)
  const vec = embedResult.success ? vectorLiteral(embedResult.data) : null

  const [vectorRows, keywordRows] = await Promise.all([
    vec
      ? (db.$queryRawUnsafe(
          `SELECT id, scope, key, content, pinned, metadata,
                  1 - (embedding <=> $1::vector) AS score
           FROM agent_memory
           WHERE embedding IS NOT NULL ${LIVE_FACTS_ONLY} ${scopeClause} ${metaClause}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          vec,
          fetchDepth,
        ) as Promise<Row[]>)
      : Promise.resolve<Row[]>([]),
    db.$queryRawUnsafe(
      // literal_match first — see the note in agent-memory.ts: an ILIKE-only hit
      // scores 0 on ts_rank and would otherwise be the row the LIMIT drops.
      `SELECT id, scope, key, content, pinned, metadata,
              (content ILIKE ANY($2::text[])) AS literal_match,
              ts_rank(to_tsvector('simple', content), to_tsquery('simple', $1)) AS score
       FROM agent_memory
       WHERE (to_tsvector('simple', content) @@ to_tsquery('simple', $1)
              OR content ILIKE ANY($2::text[]))
         ${LIVE_FACTS_ONLY} ${scopeClause} ${metaClause}
       ORDER BY literal_match DESC, score DESC, "createdAt" DESC
       LIMIT $3`,
      tokens.length > 0 ? buildOrTsQuery(tokens) : NO_LEXEME_TSQUERY,
      // No usable tokens → search the raw phrase, which is what the old
      // embedding-failure fallback did for exactly these short queries.
      tokens.length > 0 ? buildLikePatterns(tokens) : rawPhrasePatterns(query),
      fetchDepth,
    ) as Promise<Row[]>,
  ])

  const byId = new Map<string, Row>()
  const vectorScore = new Map<string, number>()

  const vectorHits: RankedArmHit[] = vectorRows
    .filter((r) => r.score >= VECTOR_THRESHOLD)
    .map((row, rank) => {
      byId.set(row.id, row)
      vectorScore.set(row.id, row.score)
      return { id: row.id, rank }
    })
  const keywordHits: RankedArmHit[] = keywordRows.map((row, rank) => {
    if (!byId.has(row.id)) byId.set(row.id, row)
    // `exact` breaks a tie against the vector arm's top hit — matters most at
    // limit: 1, where the identifier lookup would otherwise lose (Codex P2).
    return { id: row.id, rank, exact: true }
  })

  return fuseRrf([vectorHits, keywordHits])
    .slice(0, limit)
    .map((hit) => {
      const row = byId.get(hit.id)
      if (!row) return null
      const semantic = vectorScore.get(hit.id)
      return {
        id: row.id,
        scope: row.scope,
        key: row.key,
        content: row.content,
        pinned: row.pinned,
        metadata: row.metadata ?? null,
        // Semantic similarity stays the reported score when we have it (callers
        // read it as "how close is this"); keyword-only hits report null, same
        // as the old text fallback did.
        score: semantic != null ? Math.round(semantic * 100) / 100 : null,
      }
    })
    .filter((hit): hit is AgentMemoryHit => hit !== null)
}

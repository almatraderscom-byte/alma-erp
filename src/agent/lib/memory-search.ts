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
  buildLikePatterns,
  buildOrTsQuery,
  extractQueryTokens,
  fuseRrf,
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
 * Stand-in tsquery for a search whose words are all too short or all stopwords
 * ("মা", "the"). `to_tsquery('')` raises, so a term that matches nothing keeps
 * the SQL and its parameters identical while the raw-substring ILIKE below does
 * the actual work — that short-query path used to be the old text fallback and
 * must not silently disappear now that recall is hybrid.
 */
const NO_LEXEME_TSQUERY = 'zzz_no_lexeme_zzz'

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
           WHERE embedding IS NOT NULL ${scopeClause} ${metaClause}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          vec,
          fetchDepth,
        ) as Promise<Row[]>)
      : Promise.resolve<Row[]>([]),
    db.$queryRawUnsafe(
      `SELECT id, scope, key, content, pinned, metadata,
              ts_rank(to_tsvector('simple', content), to_tsquery('simple', $1)) AS score
       FROM agent_memory
       WHERE (to_tsvector('simple', content) @@ to_tsquery('simple', $1)
              OR content ILIKE ANY($2::text[]))
         ${scopeClause} ${metaClause}
       ORDER BY score DESC, "createdAt" DESC
       LIMIT $3`,
      tokens.length > 0 ? buildOrTsQuery(tokens) : NO_LEXEME_TSQUERY,
      // No usable tokens → search the raw phrase, which is what the old
      // embedding-failure fallback did for exactly these short queries.
      tokens.length > 0 ? buildLikePatterns(tokens) : [`%${query.slice(0, 60)}%`],
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
    return { id: row.id, rank }
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

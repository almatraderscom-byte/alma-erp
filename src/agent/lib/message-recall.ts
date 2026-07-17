import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'

/**
 * B2 — per-message embeddings + true RAG recall.
 *
 * Every owner/assistant message is embedded (best-effort, async) so the head can
 * pull back turns that have scrolled out of the verbatim history window. Recall
 * deliberately EXCLUDES the most recent turns (they're already in context) and
 * is scoped to the current conversation.
 */

const RECALL_EXCLUDE_RECENT = 30
const RECALL_SIMILARITY_THRESHOLD = 0.5
const RECALL_TAKE = 4

export type RecalledTurn = {
  id: string
  role: string
  content: string
  score: number
}

/** Joins the text blocks of a stored agent_message `content` JSON into plain text. */
export function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
        return (block as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Embeds a stored message and attaches the vector via raw SQL (Prisma can't bind
 * the Unsupported(vector) column). Fire-and-forget friendly: never throws.
 */
export async function attachMessageEmbedding(
  messageId: string,
  content: unknown,
): Promise<{ embedded: boolean; error?: string }> {
  const text = messageContentToText(content)
  if (!text) return { embedded: false, error: 'empty_message' }
  const embedResult = await embed(text)
  if (!embedResult.success) return { embedded: false, error: embedResult.error }
  try {
    const vec = vectorLiteral(embedResult.data)
    await (prisma as unknown as { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> })
      .$executeRawUnsafe(
        `UPDATE agent_messages SET embedding = $1::vector WHERE id = $2`,
        vec,
        messageId,
      )
    return { embedded: true }
  } catch (err) {
    return { embedded: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Fire-and-forget wrapper: embeds without blocking the turn and swallows errors. */
export function embedMessageInBackground(messageId: string, content: unknown): void {
  void attachMessageEmbedding(messageId, content).then((r) => {
    if (!r.embedded && r.error && r.error !== 'empty_message') {
      console.warn('[message-recall] embed failed:', r.error)
    }
  })
}

/**
 * Semantically recalls older turns of THIS conversation relevant to the current
 * user message, excluding the most recent `excludeRecent` turns (already in the
 * verbatim window). Fail-open: returns [] on any error or when embeddings are
 * unavailable — recall is an enhancement, never a hard dependency.
 */
/**
 * Phase 32 contract: recall is ADVISORY ONLY. It may enrich the per-turn
 * brief, but the continuity resolver (continuity-resolver.ts) takes no recall
 * input by construction — semantic similarity can never select or mutate a
 * high-risk binding (card/checkpoint/focus). Do not add recall inputs there.
 */
export async function retrieveRelevantOldTurns(
  conversationId: string,
  userMessage: string,
  opts?: { excludeRecent?: number; take?: number; threshold?: number },
): Promise<RecalledTurn[]> {
  const excludeRecent = opts?.excludeRecent ?? RECALL_EXCLUDE_RECENT
  const take = opts?.take ?? RECALL_TAKE
  const threshold = opts?.threshold ?? RECALL_SIMILARITY_THRESHOLD
  if (!conversationId || !userMessage.trim()) return []

  try {
    const embedResult = await embed(userMessage)
    if (!embedResult.success) return []
    const vec = vectorLiteral(embedResult.data)

    const rows: Array<{ id: string; role: string; content: unknown; score: number }> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$queryRawUnsafe(
        `SELECT id, role, content, 1 - (embedding <=> $1::vector) AS score
         FROM agent_messages
         WHERE "conversationId" = $2
           AND embedding IS NOT NULL
           AND id NOT IN (
             SELECT id FROM agent_messages
             WHERE "conversationId" = $2
             ORDER BY "createdAt" DESC
             LIMIT ${excludeRecent}
           )
         ORDER BY embedding <=> $1::vector
         LIMIT ${take}`,
        vec,
        conversationId,
      )

    return rows
      .filter((r) => r.score >= threshold)
      .map((r) => ({
        id: r.id,
        role: r.role,
        content: messageContentToText(r.content),
        score: Math.round(r.score * 100) / 100,
      }))
      .filter((r) => r.content.length > 0)
  } catch (err) {
    console.warn('[message-recall] retrieveRelevantOldTurns failed:', err instanceof Error ? err.message : err)
    return []
  }
}

import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'

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
        `UPDATE agent_memory SET embedding = $1::vector, updated_at = NOW() WHERE id = $2::uuid`,
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
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const content = opts.content.trim()
  const scope = opts.scope
  const key = opts.key?.trim() || null
  const pinned = opts.pinned === true
  const metadata = opts.metadata ?? undefined

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
        data: { content, pinned, ...(metadata !== undefined ? { metadata } : {}) },
        select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true },
      })
      const embedStatus = await attachMemoryEmbedding(row.id, content)
      return { ...row, embedStatus }
    }
  }

  row = await db.agentMemory.create({
    data: { scope, key, content, pinned, ...(metadata !== undefined ? { metadata } : {}) },
    select: { id: true, scope: true, key: true, content: true, pinned: true, createdAt: true },
  })
  const embedStatus = await attachMemoryEmbedding(row.id, content)
  return { ...row, embedStatus }
}

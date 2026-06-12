import { normalizeFbImageRef } from '@/agent/lib/meta'

const GENERATED_PATH_RE = /`(generated\/[^`\s]+)`|(generated\/[a-zA-Z0-9._-]+\.(?:png|jpg|jpeg|webp|gif))/i

type AgentDb = {
  agentPendingAction: {
    findFirst: (args: Record<string, unknown>) => Promise<{
      id: string
      resolvedAt?: Date | string | null
      result?: unknown
    } | null>
  }
  agentMessage: {
    findMany: (args: Record<string, unknown>) => Promise<Array<{ content: unknown }>>
  }
}

function storagePathFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as { storagePath?: string }
  return normalizeFbImageRef(r.storagePath)
}

export async function resolveImageFromConversationMessages(
  db: AgentDb,
  conversationId: string,
): Promise<string | undefined> {
  const messages = await db.agentMessage.findMany({
    where: { conversationId, role: 'assistant' },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { content: true },
  })

  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const text = String((block as { text?: string }).text ?? '')
      const match = text.match(GENERATED_PATH_RE)
      if (!match) continue
      const path = normalizeFbImageRef(match[1] ?? match[2])
      if (path) return path
    }
  }

  return undefined
}

/** Latest executed image_gen storage path for this conversation (within maxAgeMs). */
export async function resolveConversationImagePath(
  db: AgentDb,
  conversationId: string | null | undefined,
  opts?: { maxAgeMs?: number },
): Promise<string | undefined> {
  if (!conversationId) return undefined
  const maxAgeMs = opts?.maxAgeMs ?? 24 * 60 * 60 * 1000

  const imageAction = await db.agentPendingAction.findFirst({
    where: {
      conversationId,
      type: 'image_gen',
      status: 'executed',
    },
    orderBy: { resolvedAt: 'desc' },
    select: { id: true, resolvedAt: true, result: true },
  })

  if (!imageAction) {
    return resolveImageFromConversationMessages(db, conversationId)
  }

  if (imageAction.resolvedAt) {
    const age = Date.now() - new Date(imageAction.resolvedAt).getTime()
    if (age > maxAgeMs) return undefined
  }

  const fromResult = storagePathFromResult(imageAction.result)
  if (fromResult) return fromResult

  return normalizeFbImageRef(`generated/${imageAction.id}.png`)
}

export async function hasRecentImageGen(
  db: AgentDb,
  conversationId: string | null | undefined,
  maxAgeMs = 6 * 60 * 60 * 1000,
): Promise<boolean> {
  if (!conversationId) return false
  const path = await resolveConversationImagePath(db, conversationId, { maxAgeMs })
  return Boolean(path)
}

export async function resolveFbPostImageRef(
  db: AgentDb,
  opts: {
    conversationId?: string | null
    imageUrl?: unknown
    imageArtifactOrFileId?: unknown
    textOnly?: boolean
  },
): Promise<{ imageRef?: string; hadRecentImageGen: boolean }> {
  if (opts.textOnly) {
    return { imageRef: undefined, hadRecentImageGen: false }
  }

  let imageRef =
    normalizeFbImageRef(opts.imageUrl) ??
    normalizeFbImageRef(opts.imageArtifactOrFileId)

  const conversationId = opts.conversationId ? String(opts.conversationId) : null
  const hadRecentImageGen = conversationId
    ? await hasRecentImageGen(db, conversationId)
    : false

  if (!imageRef && conversationId) {
    imageRef = await resolveConversationImagePath(db, conversationId)
  }

  return { imageRef, hadRecentImageGen }
}

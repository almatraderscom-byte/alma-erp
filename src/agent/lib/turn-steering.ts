import { prisma } from '@/lib/prisma'

export const OWNER_STEERING_NOTE =
  '[BOSS LIVE UPDATE — this arrived while the current task was running. ' +
  'Treat it as the newest owner instruction, adapt the current work now, and do not start a duplicate turn.]\n'

type StoredBlock = {
  type?: unknown
  text?: unknown
  bucket?: unknown
  path?: unknown
  mediaType?: unknown
}
export interface ClaimedSteeringMessage {
  id: string
  clientMessageId: string | null
  prompt: string
}

/**
 * Claim owner follow-ups persisted by /turn/:id/steer.
 *
 * AgentMessage is the durable queue: no new table/migration and no in-memory
 * delivery dependency. The running turn keeps a local claimed-id set while the
 * persisted consumed marker makes crash/retry behaviour observable. Unknown or
 * malformed usage metadata is ignored (fail-open for the normal turn).
 */
export async function claimTurnSteeringMessages(
  turnId: string | null | undefined,
  conversationId: string,
  alreadyClaimed: ReadonlySet<string>,
): Promise<ClaimedSteeringMessage[]> {
  if (!turnId) return []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: Array<{ id: string; clientRequestId: string | null; content: unknown; usage: unknown }> =
      await (prisma as any).agentMessage.findMany({
        where: {
          conversationId,
          role: 'user',
          usage: { path: ['steering', 'targetTurnId'], equals: turnId },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, clientRequestId: true, content: true, usage: true },
      })

    const claimed: ClaimedSteeringMessage[] = []
    for (const row of rows) {
      if (alreadyClaimed.has(row.id)) continue
      const usage = row.usage && typeof row.usage === 'object'
        ? row.usage as Record<string, unknown>
        : {}
      const steering = usage.steering && typeof usage.steering === 'object'
        ? usage.steering as Record<string, unknown>
        : {}
      if (steering.targetTurnId !== turnId || steering.status === 'consumed') continue

      const blocks = Array.isArray(row.content) ? row.content as StoredBlock[] : []
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => String(b.text).trim())
        .filter(Boolean)
        .join('\n')
      const files = blocks
        .filter((b) => b.type === 'file_ref' && typeof b.path === 'string')
        .map((b) => `- attachment: ${String(b.path)} (${String(b.mediaType ?? 'file')})`)
      const ownerContent = [text, ...files].filter(Boolean).join('\n')
      if (!ownerContent) continue

      claimed.push({
        id: row.id,
        clientMessageId: row.clientRequestId,
        prompt: `${OWNER_STEERING_NOTE}${ownerContent}`,
      })

      // Best-effort audit marker. The in-process claimed set remains the hard
      // duplicate guard if this advisory update loses a database race.
      void (prisma as any).agentMessage.updateMany({
        where: { id: row.id },
        data: {
          usage: {
            ...usage,
            steering: { ...steering, status: 'consumed', consumedAt: new Date().toISOString() },
          },
        },
      }).catch(() => {})
    }
    return claimed
  } catch (err) {
    console.warn('[turn-steering] claim failed:', err instanceof Error ? err.message : err)
    return []
  }
}

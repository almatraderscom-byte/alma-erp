import { prisma } from '@/lib/prisma'

/**
 * Unified owner "session" pointer — the ONE conversation the owner is currently
 * in, shared across every surface (web app + Telegram). Both surfaces read this
 * pointer so a message on Telegram and a message in the app land in the SAME
 * thread, and a refresh in the app resumes where the owner left off.
 *
 * Stored in agent_kv_settings under `owner_telegram_state` (the key the Telegram
 * worker already maintained) so there is a single source of truth — no second
 * pointer to drift. Value shape: { conversationId, personalConversationId,
 * updatedAt }. `conversationId` = main business chat; `personalConversationId` =
 * personal/advisor chat.
 */

const KV_KEY = 'owner_telegram_state'

export type OwnerSessionPointer = {
  conversationId: string | null
  personalConversationId: string | null
}

export async function getOwnerSessionPointer(): Promise<OwnerSessionPointer> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_KEY } })
    if (!row?.value) return { conversationId: null, personalConversationId: null }
    const parsed = JSON.parse(row.value) as Partial<OwnerSessionPointer>
    return {
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : null,
      personalConversationId:
        typeof parsed.personalConversationId === 'string' ? parsed.personalConversationId : null,
    }
  } catch {
    return { conversationId: null, personalConversationId: null }
  }
}

/**
 * Point the relevant surface field at `conversationId`. Read-modify-write so the
 * other field (and the Telegram worker's view) is preserved. Never throws.
 */
export async function setOwnerSessionConversation(opts: {
  conversationId: string
  personalMode: boolean
}): Promise<void> {
  try {
    const current = await getOwnerSessionPointer()
    const next: OwnerSessionPointer = {
      conversationId: opts.personalMode ? current.conversationId : opts.conversationId,
      personalConversationId: opts.personalMode
        ? opts.conversationId
        : current.personalConversationId,
    }
    if (
      next.conversationId === current.conversationId &&
      next.personalConversationId === current.personalConversationId
    ) {
      return
    }
    const value = JSON.stringify({ ...next, updatedAt: new Date().toISOString() })
    await prisma.agentKvSetting.upsert({
      where: { key: KV_KEY },
      create: { key: KV_KEY, value },
      update: { value },
    })
  } catch (err) {
    console.warn('[owner-session] set failed:', err instanceof Error ? err.message : err)
  }
}

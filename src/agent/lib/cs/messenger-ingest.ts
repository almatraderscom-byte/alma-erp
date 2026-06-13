/**
 * Shared inbound Messenger ingest — used by webhook POST and VPS inbox poll sync.
 */
import { pageAccessToken } from '@/agent/lib/cs/meta-messenger'
import { findOrCreateCsConversation, appendCsMessage } from '@/agent/lib/cs/conversations'
import { csReplyPermitted } from '@/agent/lib/cs/modes'
import { downloadMessengerAttachment } from '@/agent/lib/cs/meta-messenger'
import { agentStorageUpload } from '@/agent/lib/storage'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const POLL_MAX_AGE_MS = Number(process.env.CS_POLL_MAX_AGE_HOURS ?? 4) * 60 * 60 * 1000

export type InboundMessengerMessage = {
  pageId: string
  psid: string
  mid: string
  text?: string
  imageUrls?: string[]
  customerName?: string
  messageCreatedAt?: string
  source?: 'webhook' | 'poll'
}

export type IngestResult =
  | { ingested: false; reason: 'skip_echo' | 'duplicate' | 'not_permitted' | 'empty' | 'already_replied' | 'too_old' }
  | { ingested: true; conversationId: string; messageId: string; jobQueued: boolean }

async function ensureCustomerName(
  conv: { id: string; customerName?: string | null },
  pageId: string,
  psid: string,
  pageToken: string | null,
  hint?: string,
) {
  if (conv.customerName) return conv.customerName
  const name = hint?.trim()
  if (name) {
    await db.csConversation.update({ where: { id: conv.id }, data: { customerName: name } })
    await db.csCustomer.upsert({
      where: { pageId_psid: { pageId, psid } },
      create: { pageId, psid, name },
      update: { name },
    })
    return name
  }
  if (!pageToken) return null
  try {
    const profileRes = await fetch(
      `https://graph.facebook.com/v21.0/${psid}?fields=first_name,last_name&access_token=${pageToken}`,
    )
    if (!profileRes.ok) return null
    const profile = await profileRes.json() as { first_name?: string; last_name?: string }
    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    if (!fullName) return null
    await db.csConversation.update({ where: { id: conv.id }, data: { customerName: fullName } })
    await db.csCustomer.upsert({
      where: { pageId_psid: { pageId, psid } },
      create: { pageId, psid, name: fullName },
      update: { name: fullName },
    })
    return fullName
  } catch {
    return null
  }
}

const CS_PAGE_NAMES: Record<string, string> = {
  '1044848232034171': 'Alma Lifestyle',
  '827260860637393': 'Alma Online Shop',
}

async function notifyOwnerNewMessage(
  pageId: string,
  psid: string,
  text: string | undefined,
  customerName: string | null | undefined,
) {
  const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
  const TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!APP_URL || !TOKEN) return

  const pageName = CS_PAGE_NAMES[pageId] ?? pageId
  const name = customerName || psid
  const preview = text?.slice(0, 100) ?? '(ছবি/মিডিয়া)'

  await fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      tier: 1,
      title: `📨 ${pageName}: নতুন কাস্টমার মেসেজ`,
      message: `${name}: "${preview}"\n\nCS mode বন্ধ আছে — reply হবে না।`,
      category: 'urgent',
    }),
  })
}

export async function ingestInboundMessengerMessage(
  input: InboundMessengerMessage,
): Promise<IngestResult> {
  const { pageId, psid, mid } = input
  if (!pageId || !psid || !mid) return { ingested: false, reason: 'empty' }
  if (psid === pageId) return { ingested: false, reason: 'skip_echo' }

  const existing = await db.csMessage.findFirst({
    where: { metaMessageId: mid },
    select: { id: true },
  })
  if (existing) return { ingested: false, reason: 'duplicate' }

  if (input.source === 'poll' && input.messageCreatedAt) {
    const msgAt = new Date(input.messageCreatedAt)
    if (!Number.isFinite(msgAt.getTime())) {
      return { ingested: false, reason: 'empty' }
    }
    if (Date.now() - msgAt.getTime() > POLL_MAX_AGE_MS) {
      return { ingested: false, reason: 'too_old' }
    }
  }

  const pageToken = pageAccessToken(pageId)
  const conv = await findOrCreateCsConversation({ pageId, psid, customerName: input.customerName })

  const fresh = await db.csConversation.findUnique({
    where: { id: conv.id },
    select: { lastCsReplyAt: true, mode: true, status: true },
  })
  if (fresh?.mode === 'human' || fresh?.status === 'human') {
    return { ingested: false, reason: 'not_permitted' }
  }
  if (input.messageCreatedAt && fresh?.lastCsReplyAt) {
    const msgAt = new Date(input.messageCreatedAt)
    if (msgAt <= new Date(fresh.lastCsReplyAt)) {
      return { ingested: false, reason: 'already_replied' }
    }
  }

  await ensureCustomerName(conv, pageId, psid, pageToken, input.customerName)

  const content: unknown[] = []
  if (input.text?.trim()) content.push({ type: 'text', text: input.text.trim() })

  for (const [i, url] of (input.imageUrls ?? []).entries()) {
    if (!url) continue
    try {
      const { buffer, mimeType } = await downloadMessengerAttachment(url)
      const path = `cs-inbound/${conv.id}/${mid}-${i}.jpg`
      await agentStorageUpload(path, buffer, mimeType)
      content.push({ type: 'image_ref', path, mimeType })
    } catch {
      content.push({ type: 'image_url', url })
    }
  }

  if (!content.length) return { ingested: false, reason: 'empty' }

  const stored = await appendCsMessage(conv.id, 'user', content, mid)
  console.log(`[messenger-ingest] page=${pageId} psid=${psid} mid=${mid}`)

  const { permitted, effectiveMode } = await csReplyPermitted(conv)
  if (!permitted) {
    if (effectiveMode === 'off') {
      void notifyOwnerNewMessage(pageId, psid, input.text, conv.customerName).catch(() => {})
    }
    return { ingested: true, conversationId: conv.id, messageId: stored.id, jobQueued: false }
  }

  await db.csReplyJob.upsert({
    where: { messageId: stored.id },
    create: { conversationId: conv.id, messageId: stored.id, status: 'pending' },
    update: { status: 'pending', attempts: 0, lastError: null },
  })

  return { ingested: true, conversationId: conv.id, messageId: stored.id, jobQueued: true }
}

/**
 * WhatsApp inbound ingest — mirrors messenger-ingest, feeds the same CS brain.
 * Coexistence: skips business-app echoes and conversations marked human/handled-in-app.
 */
import { findOrCreateCsConversation, appendCsMessage } from '@/agent/lib/cs/conversations'
import { csReplyPermitted } from '@/agent/lib/cs/modes'
import { waPageId } from '@/agent/lib/wa/constants'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type WaInboundMessage = {
  phoneNumberId: string
  waId: string
  messageId: string
  text?: string
  customerName?: string
  timestamp?: string
  /** True when Meta marks this as sent from WhatsApp Business App (coexistence). */
  fromBusinessApp?: boolean
}

export type WaIngestResult =
  | { ingested: false; reason: 'duplicate' | 'empty' | 'echo' | 'coexistence' | 'not_permitted' }
  | { ingested: true; conversationId: string; messageId: string; jobQueued: boolean }

function mergeMetadata(existing: unknown, patch: Record<string, unknown>) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  return { ...base, ...patch, channel: 'whatsapp' }
}

async function notifyOwnerWaOff(waId: string, text: string | undefined, name: string | null) {
  const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
  const TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!APP_URL || !TOKEN) return
  const preview = text?.slice(0, 100) ?? '(মিডিয়া)'
  await fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      tier: 1,
      title: '📱 WhatsApp: নতুন মেসেজ',
      message: `${name ?? waId}: "${preview}"\n\nCS mode বন্ধ — auto-reply হবে না।`,
      category: 'urgent',
    }),
  }).catch(() => {})
}

export async function ingestWaInboundMessage(input: WaInboundMessage): Promise<WaIngestResult> {
  const { phoneNumberId, waId, messageId } = input
  if (!phoneNumberId || !waId || !messageId) return { ingested: false, reason: 'empty' }
  if (input.fromBusinessApp) return { ingested: false, reason: 'coexistence' }

  const existing = await db.csMessage.findFirst({
    where: { metaMessageId: messageId },
    select: { id: true },
  })
  if (existing) return { ingested: false, reason: 'duplicate' }

  const pageId = waPageId(phoneNumberId)
  const conv = await findOrCreateCsConversation({
    pageId,
    psid: waId,
    customerName: input.customerName,
  })

  await db.csConversation.update({
    where: { id: conv.id },
    data: {
      metadata: mergeMetadata(conv.metadata, { channel: 'whatsapp', waPhoneNumberId: phoneNumberId }),
    },
  })

  const fresh = await db.csConversation.findUnique({
    where: { id: conv.id },
    select: { mode: true, status: true, metadata: true },
  })
  if (fresh?.mode === 'human' || fresh?.status === 'human') {
    return { ingested: false, reason: 'not_permitted' }
  }

  const meta = (fresh?.metadata ?? {}) as Record<string, unknown>
  if (meta.handledInAppAt) {
    const handledAt = new Date(String(meta.handledInAppAt))
    if (Number.isFinite(handledAt.getTime()) && Date.now() - handledAt.getTime() < 30 * 60 * 1000) {
      return { ingested: false, reason: 'coexistence' }
    }
  }

  const content: unknown[] = []
  if (input.text?.trim()) content.push({ type: 'text', text: input.text.trim() })
  if (!content.length) return { ingested: false, reason: 'empty' }

  const stored = await appendCsMessage(conv.id, 'user', content, messageId)
  console.log(`[wa-ingest] phone=${phoneNumberId} wa=${waId} mid=${messageId}`)

  const { permitted, effectiveMode } = await csReplyPermitted(conv)
  if (!permitted) {
    if (effectiveMode === 'off') {
      void notifyOwnerWaOff(waId, input.text, conv.customerName ?? null).catch(() => {})
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

/** Mark conversation as recently handled in WhatsApp Business App (coexistence gate). */
export async function markWaHandledInApp(pageId: string, waId: string): Promise<void> {
  const conv = await db.csConversation.findUnique({
    where: { pageId_psid: { pageId, psid: waId } },
    select: { id: true, metadata: true },
  })
  if (!conv) return
  await db.csConversation.update({
    where: { id: conv.id },
    data: {
      metadata: mergeMetadata(conv.metadata, { handledInAppAt: new Date().toISOString() }),
    },
  })
}

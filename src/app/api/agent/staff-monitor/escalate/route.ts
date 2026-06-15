import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { prisma } from '@/lib/prisma'
import { enqueueTelegramNotification } from '@/lib/telegram-notification/queue'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null)
  if (!body?.staffName || !body?.messageType) {
    return Response.json({ error: 'staffName and messageType required' }, { status: 400 })
  }

  const { staffName, messageType, outboxId } = body as {
    staffName: string
    messageType: string
    outboxId?: string
  }

  const actions: string[] = []

  // 1) Re-send original message to staff via Telegram
  if (outboxId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outbox = await (prisma as any).agentOutbox.findUnique({
        where: { id: outboxId },
        select: { content: true, staffId: true, businessId: true },
      }) as { content: string; staffId: string | null; businessId: string | null } | null

      if (outbox?.staffId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const staff = await (prisma as any).agentStaff.findUnique({
          where: { id: outbox.staffId },
          select: { telegramChatId: true },
        }) as { telegramChatId: string | null } | null

        if (staff?.telegramChatId && outbox.content) {
          const resendMsg = `🔔 *রিমাইন্ডার — অনুগ্রহ করে নিচের মেসেজটি দেখুন:*\n\n${outbox.content.slice(0, 1000)}`
          await enqueueTelegramNotification({
            businessId: outbox.businessId ?? 'ALMA_LIFESTYLE',
            eventType: 'ATTENDANCE_FACE_VERIFIED_CHECK_IN',
            message: resendMsg,
            chatIds: [staff.telegramChatId],
            dedupeKey: `escalate_resend:${outboxId}:${Date.now()}`,
            metadata: { force: true, escalation: true },
          })
          actions.push('resent_to_staff')
        }
      }
    } catch (err) {
      console.error('[escalate] resend failed:', err)
      actions.push('resend_failed')
    }
  }

  // 2) Notify owner via critical NTFY
  try {
    await notifyOwner({
      tier: 2,
      title: `⚠️ ${staffName} — মেসেজ দেখেননি`,
      message: `${staffName} ১০+ মিনিট ধরে "${messageType}" মেসেজ দেখেননি। Message re-sent to staff.\n\nOutbox: ${outboxId ?? 'N/A'}`,
      category: 'urgent',
    })
    actions.push('owner_ntfy_sent')
  } catch (err) {
    console.error('[escalate] owner notify failed:', err)
    actions.push('owner_ntfy_failed')
  }

  return Response.json({ ok: true, actions })
}

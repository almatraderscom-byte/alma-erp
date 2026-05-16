import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createNotification, reminderCandidates } from '@/lib/notifications'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'

export const dynamic = 'force-dynamic'

function cronAuthorized(req: NextRequest) {
  const auth = req.headers.get('authorization') || ''
  const expected = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET
  return expected && auth === `Bearer ${expected}`
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    const ctx = await getWalletContext(req)
    if ('error' in ctx) return ctx.error
    if (!ctx.isAdmin) return forbidden('Only admins can resend notification reminders.')
  }

  const body = (await req.json().catch(() => ({}))) as { minutes?: number }
  const candidates = await reminderCandidates(body.minutes || 30)
  const notifications = await prisma.notification.findMany({
    where: { id: { in: candidates.map(c => c.notificationId) }, priority: { in: ['HIGH', 'CRITICAL'] } },
  })
  const byId = new Map(notifications.map(n => [n.id, n]))
  let sent = 0
  for (const row of candidates) {
    const original = byId.get(row.notificationId)
    if (!original) continue
    await createNotification({
      userId: row.userId,
      businessId: row.businessId,
      type: original.type,
      priority: original.priority,
      title: `Reminder: ${original.title}`.slice(0, 160),
      message: original.message,
      actionUrl: original.actionUrl,
      pinned: original.pinned,
      metadata: { reminderFor: original.id },
    })
    await prisma.notificationRecipient.update({
      where: { id: row.id },
      data: { lastRemindedAt: new Date() },
    })
    sent += 1
  }
  return NextResponse.json({ ok: true, sent })
}

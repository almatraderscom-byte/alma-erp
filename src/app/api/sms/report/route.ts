import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireRoles } from '@/lib/api-guards'
import { fetchSmsReport } from '@/lib/sms/provider'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { id?: string }
  const log = await prisma.smsLog.findUnique({ where: { id: String(body.id || '') } })
  if (!log?.requestId) return NextResponse.json({ error: 'SMS request ID not found.' }, { status: 404 })
  const report = await fetchSmsReport(log.requestId)
  const status = report.status === 'Sent' ? 'DELIVERED' : report.status === 'Failed' ? 'FAILED' : 'PENDING'
  const updated = await prisma.smsLog.update({
    where: { id: log.id },
    data: {
      status,
      errorCode: report.errorCode || null,
      errorMessage: report.errorMessage || null,
      deliveredAt: status === 'DELIVERED' ? new Date() : log.deliveredAt,
    },
  })
  return NextResponse.json({ ok: true, report, log: updated })
}

import { type NextRequest } from 'next/server'
import { reconcileExpiredOfficeCalls } from '@/agent/lib/office-call-domain'
import { processOfficeCallOutbox } from '@/agent/lib/office-call-outbox'
import {
  monitorOfficeCallHealth,
  officeCallMaintenanceSchedule,
  purgeOfficeCallRetention,
} from '@/agent/lib/office-call-reliability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const now = new Date()
  const schedule = officeCallMaintenanceSchedule(now)
  const [expiry, outbox, health, retention] = await Promise.all([
    reconcileExpiredOfficeCalls(),
    processOfficeCallOutbox(),
    schedule.health ? monitorOfficeCallHealth(now) : Promise.resolve(null),
    schedule.retention ? purgeOfficeCallRetention(now) : Promise.resolve(null),
  ])
  return Response.json({ ok: true, expiry, outbox, health, retention })
}

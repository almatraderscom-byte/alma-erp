import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  getSalahTimeConfig,
  setSalahTimeConfig,
  setSalahWaqtTimes,
  isValidHm,
  WAQT_ORDER,
  type SalahTimeConfig,
  type WaqtKey,
} from '@/lib/salah/time-config'
import { buildDhakaSchedule } from '@/lib/salah/build-schedule'
import { todayYmdDhaka, dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const }
}

export async function GET(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) {
    if (auth.error instanceof Response) return auth.error
    return auth.error
  }

  try {
    const cfg = await getSalahTimeConfig()
    return Response.json({ config: cfg })
  } catch (err) {
    console.error('[agent/salah-times]', err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

/**
 * After saving new salah times, reconcile today's DB records so escalation
 * doesn't fire on stale window timestamps. Past waqts that were never confirmed
 * get marked 'skipped' to prevent false "missed" alerts.
 */
async function reconcileTodaySalahRecords(cfg: SalahTimeConfig) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const today = todayYmdDhaka()
  const date = dhakaMidnightUtc(today)
  const now = new Date()
  const isFriday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'short' }).format(now) === 'Fri'
  const schedule = buildDhakaSchedule(today, cfg, isFriday)

  const records = await db.agentSalahRecord.findMany({
    where: { date },
  }) as Array<{ waqt: string; status: string; confirmedAt: Date | null }>

  for (const waqt of WAQT_ORDER) {
    const sched = schedule[waqt]
    const record = records.find((r: { waqt: string }) => r.waqt === waqt)
    if (!record) continue

    const confirmed = record.confirmedAt != null
    if (confirmed) continue

    if (now > sched.end) {
      // Waqt already ended under new schedule — skip to prevent false missed
      if (record.status === 'pending' || record.status === 'missed') {
        await db.agentSalahRecord.updateMany({
          where: { date, waqt },
          data: {
            status: 'skipped',
            windowStart: sched.start,
            windowEnd: sched.end,
          },
        })
      }
    } else {
      // Waqt still active — update window timestamps
      await db.agentSalahRecord.updateMany({
        where: { date, waqt },
        data: {
          windowStart: sched.start,
          windowEnd: sched.end,
          remindersSent: 0,
        },
      })
    }
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) {
    if (auth.error instanceof Response) return auth.error
    return auth.error
  }

  try {
    const body = await req.json() as {
      config?: SalahTimeConfig
      waqt?: WaqtKey
      azan?: string
      prayer?: string
      end?: string
    }

    if (body.config) {
      for (const waqt of WAQT_ORDER) {
        const row = body.config[waqt]
        if (!row) continue
        for (const k of ['azan', 'prayer', 'end'] as const) {
          if (row[k] && !isValidHm(row[k])) {
            return Response.json({ error: `${waqt}.${k} — HH:MM ফরম্যাট লাগবে` }, { status: 400 })
          }
        }
      }
      const saved = await setSalahTimeConfig(body.config)
      await reconcileTodaySalahRecords(saved).catch(e =>
        console.error('[salah-times] reconcile failed:', e)
      )
      return Response.json({ ok: true, config: saved })
    }

    if (body.waqt) {
      const patch: Partial<SalahTimeConfig[WaqtKey]> = {}
      for (const k of ['azan', 'prayer', 'end'] as const) {
        const v = body[k]
        if (v != null) {
          if (!isValidHm(String(v))) {
            return Response.json({ error: `${k} — HH:MM ফরম্যাট লাগবে` }, { status: 400 })
          }
          patch[k] = String(v)
        }
      }
      if (!Object.keys(patch).length) {
        return Response.json({ error: 'কমপক্ষে একটি সময় দিন' }, { status: 400 })
      }
      const saved = await setSalahWaqtTimes(body.waqt, patch)
      await reconcileTodaySalahRecords(saved).catch(e =>
        console.error('[salah-times] reconcile failed:', e)
      )
      return Response.json({ ok: true, config: saved })
    }

    return Response.json({ error: 'config বা waqt+times পাঠান' }, { status: 400 })
  } catch (err) {
    console.error('[agent/salah-times POST]', err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

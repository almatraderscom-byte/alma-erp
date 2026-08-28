/**
 * Salah history for the calendar view (iOS নামাজ section + any future web use).
 *
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (location-calendar days; both optional)
 *   → { today, offsetMin, days: [{ date, waqts: [{waqt, status, confirmedAt,
 *      windowStart, windowEnd}] }] }
 *
 * Defaults: to = today (owner's location clock), from = to − 41 days.
 * Range is capped at 190 days. Statuses come straight from salah_records:
 * prayed_on_time | prayed_late | qaza | missed | pending.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OFFSET_KEY = 'salah_utc_offset_min'
const WAQT_ORDER = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const }
}

function isYmd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

/** YYYY-MM-DD for "now" on the owner's location clock. */
function locationToday(offsetMin: number): string {
  return new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 10)
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  const offsetRow = await prisma.agentKvSetting.findUnique({
    where: { key: OFFSET_KEY }, select: { value: true },
  })
  const parsedOffset = Number(offsetRow?.value)
  const offsetMin = Number.isFinite(parsedOffset) && parsedOffset >= -720 && parsedOffset <= 840
    ? Math.round(parsedOffset) : 360
  const today = locationToday(offsetMin)

  const sp = req.nextUrl.searchParams
  const to = isYmd(sp.get('to')) ? (sp.get('to') as string) : today
  let from = isYmd(sp.get('from')) ? (sp.get('from') as string) : addDaysYmd(to, -41)
  if (from > to) from = to
  if (addDaysYmd(from, 190) < to) from = addDaysYmd(to, -190)

  const rows = await prisma.agentSalahRecord.findMany({
    where: { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
    orderBy: [{ date: 'asc' }, { windowStart: 'asc' }],
    select: {
      date: true, waqt: true, status: true, confirmedAt: true,
      windowStart: true, windowEnd: true,
    },
  })

  const byDay = new Map<string, Array<{
    waqt: string; status: string; confirmedAt: string | null
    windowStart: string; windowEnd: string
  }>>()
  for (const r of rows) {
    const ymd = r.date.toISOString().slice(0, 10)
    const list = byDay.get(ymd) ?? []
    list.push({
      waqt: r.waqt,
      status: r.status,
      confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
    })
    byDay.set(ymd, list)
  }

  const days = [...byDay.entries()].map(([date, waqts]) => ({
    date,
    waqts: waqts.sort(
      (a, b) => WAQT_ORDER.indexOf(a.waqt as typeof WAQT_ORDER[number])
              - WAQT_ORDER.indexOf(b.waqt as typeof WAQT_ORDER[number]),
    ),
  }))

  return Response.json({ today, offsetMin, from, to, days })
}

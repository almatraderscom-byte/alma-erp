/**
 * Phase 6D — Salah accountability tools.
 * The agent uses these to check, confirm, and report on prayer status.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

const WAQTS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const

// ── get_salah_status ──────────────────────────────────────────────────────────

const get_salah_status: AgentTool = {
  name: 'get_salah_status',
  description:
    'Returns today\'s salah record for all 5 waqts. ' +
    'CALL THIS at the start of every conversation turn to check for pending/missed prayers before answering.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today in Asia/Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const records = await db.agentSalahRecord.findMany({
        where: { date: new Date(date) },
        orderBy: { windowStart: 'asc' },
      })

      const now = new Date()
      const summary = WAQTS.map(waqt => {
        const r = records.find((x: { waqt: string }) => x.waqt === waqt)
        if (!r) return { waqt, status: 'not_scheduled' }
        const pastWindowStart = now > new Date(r.windowStart)
        const pastWindowEnd   = now > new Date(r.windowEnd)
        return {
          waqt:          r.waqt,
          status:        r.status,
          windowStart:   r.windowStart,
          windowEnd:     r.windowEnd,
          remindersSent: r.remindersSent,
          confirmedAt:   r.confirmedAt,
          isOverdue:     pastWindowStart && r.status === 'pending',
          isMissed:      pastWindowEnd   && r.status === 'pending',
        }
      })

      const pendingOrMissed = summary.filter(
        s => s.status === 'pending' || s.status === 'missed',
      )

      return {
        success: true,
        data: {
          date,
          waqts: summary,
          pendingOrMissed,
          requiresAccountability: pendingOrMissed.length > 0,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── mark_salah ────────────────────────────────────────────────────────────────

const mark_salah: AgentTool = {
  name: 'mark_salah',
  description:
    'Marks a specific waqt with its final status. ' +
    'Use when the owner confirms ("পড়েছি") → prayed_on_time or prayed_late; ' +
    'or acknowledges a missed prayer as qaza/missed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date:   { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      waqt:   { type: 'string', enum: ['fajr','dhuhr','asr','maghrib','isha'] },
      status: { type: 'string', enum: ['prayed_on_time','prayed_late','qaza','missed'] },
    },
    required: ['waqt', 'status'],
  },
  handler: async (input) => {
    try {
      const date   = (input.date as string) || dhakaToday()
      const waqt   = String(input.waqt)
      const status = String(input.status)
      const now    = new Date()

      const record = await db.agentSalahRecord.upsert({
        where: { date_waqt: { date: new Date(date), waqt } },
        update: { status, confirmedAt: now },
        create: {
          date:        new Date(date),
          waqt,
          windowStart: now,
          windowEnd:   now,
          status,
          confirmedAt: now,
        },
        select: { id: true, waqt: true, status: true, confirmedAt: true },
      })

      const responseMap: Record<string, string> = {
        prayed_on_time: 'আলহামদুলিল্লাহ! সময়মতো নামাজ আদায় হয়েছে।',
        prayed_late:    'আলহামদুলিল্লাহ। পরে হলেও পড়েছেন — পরের ওয়াক্ত সময়মতো পড়ার চেষ্টা করুন।',
        qaza:           'কাযা পড়া হয়েছে — আল্লাহ কবুল করুন।',
        missed:         'ইন্নালিল্লাহ। আল্লাহ মাফ করুন এবং কাযা আদায় করুন।',
      }

      return {
        success: true,
        data: {
          ...record,
          message: responseMap[status] || 'রেকর্ড আপডেট হয়েছে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_salah_weekly_summary ──────────────────────────────────────────────────

const get_salah_weekly_summary: AgentTool = {
  name: 'get_salah_weekly_summary',
  description:
    'Returns a 35-waqt weekly salah summary (last 7 days). ' +
    'Used in Friday weekly review.',
  input_schema: {
    type: 'object' as const,
    properties: {
      endDate: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
    },
  },
  handler: async (input) => {
    try {
      const end   = new Date((input.endDate as string) || dhakaToday())
      const start = new Date(end)
      start.setDate(start.getDate() - 6)

      const records = await db.agentSalahRecord.findMany({
        where: { date: { gte: start, lte: end } },
        orderBy: [{ date: 'asc' }, { windowStart: 'asc' }],
      })

      const counts = { prayed_on_time: 0, prayed_late: 0, qaza: 0, missed: 0, pending: 0 }
      for (const r of records) {
        const s = r.status as keyof typeof counts
        if (s in counts) counts[s]++
      }

      const total = records.length
      const rows  = records.map((r: {
        date: Date; waqt: string; status: string; confirmedAt: Date|null; remindersSent: number
      }) => ({
        date:          r.date.toISOString().slice(0, 10),
        waqt:          r.waqt,
        status:        r.status,
        confirmedAt:   r.confirmedAt,
        remindersSent: r.remindersSent,
      }))

      return {
        success: true,
        data: {
          period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
          totalRecorded: total,
          counts,
          rows,
          onTimeRate: total ? Math.round((counts.prayed_on_time / total) * 100) : 0,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const SALAH_TOOLS: AgentTool[] = [
  get_salah_status,
  mark_salah,
  get_salah_weekly_summary,
]

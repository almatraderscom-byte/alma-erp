/**
 * Phase 6D — Salah accountability tools.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import {
  WAQTS,
  summarizeWaqts,
  pickAccountableWaqts,
} from '@/agent/lib/salah-context'
import { buildSalahStatusAnswer } from '@/agent/lib/salah-status-answer'
import { getDhakaPrayerTimes } from '@/agent/lib/salah-times'
import { isPhantomSalahConfirmation } from '@/agent/lib/salah-resolve'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// ── get_prayer_times ──────────────────────────────────────────────────────────

const get_prayer_times: AgentTool = {
  name: 'get_prayer_times',
  description:
    'Returns today\'s 5 waqt prayer START/END times for Dhaka (informational only). ' +
    'Use when the owner asks for namaz times / schedule — do NOT use get_salah_status for that.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const dateYmd = (input.date as string) || todayYmdDhaka()
      const times = await getDhakaPrayerTimes(dateYmd)
      const now = new Date()
      return {
        success: true,
        data: {
          date: dateYmd,
          timezone: 'Asia/Dhaka',
          waqts: times.map((w) => ({
            ...w,
            state: now < new Date(w.start) ? 'upcoming' : now > new Date(w.end) ? 'ended' : 'active',
          })),
          note: 'এটি শুধু সময়সূচি — জবাবদিহিতা বা মিসড মেসেজ পাঠাবেন না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_salah_status ──────────────────────────────────────────────────────────

const get_salah_status: AgentTool = {
  name: 'get_salah_status',
  description:
    'Returns today\'s salah record for all 5 waqts plus accountable carryover from yesterday. ' +
    'Only waqts whose window has STARTED (or yesterday still pending) require accountability. ' +
    'CALL at the start of every turn before answering.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today in Asia/Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const todayYmd = (input.date as string) || todayYmdDhaka()
      const yesterdayYmd = addDaysYmd(todayYmd, -1)
      const now = new Date()

      const [todayRows, yesterdayRecords] = await Promise.all([
        db.agentSalahRecord.findMany({
          where: { date: dhakaMidnightUtc(todayYmd) },
          orderBy: { windowStart: 'asc' },
        }),
        db.agentSalahRecord.findMany({
          where: { date: dhakaMidnightUtc(yesterdayYmd) },
          orderBy: { windowStart: 'asc' },
        }),
      ])

      const todayRecords = [...todayRows]
      for (const r of todayRecords) {
        if (isPhantomSalahConfirmation(r, r.windowStart)) {
          await db.agentSalahRecord.update({
            where: { date_waqt: { date: dhakaMidnightUtc(todayYmd), waqt: r.waqt } },
            data: { status: 'pending', confirmedAt: null },
          })
          r.status = 'pending'
          r.confirmedAt = null
        }
      }

      const todaySummary = summarizeWaqts(todayYmd, todayRecords, now)
      const yesterdaySummary = summarizeWaqts(yesterdayYmd, yesterdayRecords, now)
      const accountableWaqts = pickAccountableWaqts(todaySummary, yesterdaySummary)
      const notYetDueToday = todaySummary.filter((s) => s.notYetDue)
      const statusAnswer = buildSalahStatusAnswer(todaySummary)

      return {
        success: true,
        data: {
          date: todayYmd,
          yesterday: yesterdayYmd,
          todayWaqts: todaySummary,
          yesterdayWaqts: yesterdaySummary,
          accountableWaqts,
          notYetDueToday,
          doneToday: todaySummary.filter((s) => s.effectivelyDone).map((s) => s.waqt),
          upcomingToday: notYetDueToday.map((s) => s.waqt),
          ...statusAnswer,
          waqts: todaySummary,
          pendingOrMissed: accountableWaqts,
          requiresAccountability: accountableWaqts.length > 0,
          guidance:
            'উত্তরে অবশ্যই answerBangla ব্যবহার করুন। notYetDueToday = সময় হয়নি — "আদায় হয়েছে" বলবেন না। allDone=false হলে কখনো "সব ৫ ওয়াক্ত শেষ" বলবেন না।',
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
      const dateYmd = (input.date as string) || todayYmdDhaka()
      const waqt   = String(input.waqt)
      const status = String(input.status)
      const now    = new Date()
      const dateObj = dhakaMidnightUtc(dateYmd)

      const existing = await db.agentSalahRecord.findUnique({
        where: { date_waqt: { date: dateObj, waqt } },
      })

      if (
        existing
        && now < new Date(existing.windowStart)
        && (status === 'prayed_on_time' || status === 'prayed_late')
      ) {
        return {
          success: false,
          error: `${waqt} ওয়াক্তের সময় এখনো শুরু হয়নি — ভবিষ্যতের নামাজ মার্ক করা যাবে না।`,
        }
      }

      const record = await db.agentSalahRecord.upsert({
        where: { date_waqt: { date: dateObj, waqt } },
        update: { status, confirmedAt: now },
        create: {
          date: dateObj,
          waqt,
          windowStart: existing?.windowStart ?? now,
          windowEnd:   existing?.windowEnd ?? now,
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
      const endYmd = (input.endDate as string) || todayYmdDhaka()
      const startYmd = addDaysYmd(endYmd, -6)

      const records = await db.agentSalahRecord.findMany({
        where: {
          date: {
            gte: dhakaMidnightUtc(startYmd),
            lte: dhakaMidnightUtc(endYmd),
          },
        },
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
          period: { start: startYmd, end: endYmd },
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
  get_prayer_times,
  get_salah_status,
  mark_salah,
  get_salah_weekly_summary,
]

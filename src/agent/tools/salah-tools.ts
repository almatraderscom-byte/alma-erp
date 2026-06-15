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
import { getDhakaSchedule } from '@/agent/lib/dhaka-schedule'
import { isPhantomSalahConfirmation } from '@/agent/lib/salah-resolve'
import { computeLockUntil, MAX_DELAY_MIN } from '@/lib/salah/duty-window'
import { setOwnerCallLockUntil } from '@/lib/owner-call-lock'
import {
  getSalahTimeConfig,
  setSalahWaqtTimes,
  isValidHm,
  type WaqtKey,
} from '@/lib/salah/time-config'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function resolvePrayerStartIso(waqt: string, dateYmd?: string): Promise<string | null> {
  const ymd = dateYmd || todayYmdDhaka()
  const schedule = await getDhakaSchedule(ymd)
  const w = schedule[waqt as WaqtKey]
  if (!w?.prayerStart) return null
  return w.prayerStart.toISOString()
}

async function upsertSalahDelayOverride(args: {
  dateYmd: string
  waqt: string
  delayUntil: Date
  grantedMin: number
}) {
  const dateObj = dhakaMidnightUtc(args.dateYmd)
  await db.agentSalahOverride.deleteMany({ where: { date: dateObj, waqt: args.waqt } })
  await db.agentSalahOverride.create({
    data: {
      date: dateObj,
      waqt: args.waqt,
      delayUntil: args.delayUntil,
      overrideTime: null,
      skip: false,
      reason: `owner requested ${args.grantedMin}min`,
    },
  })
}

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
    'Returns today\'s salah for 5 waqts + yesterday carryover. Follow answerBangla and allDone — never invent "all 5 done". ' +
    'notYetDue/upcomingToday ≠ prayed. Only accountable waqts (window started or missed) need "পড়েছেন কি?" — carryover first. ' +
    'CALL before business answers each turn (except pure prayer-time schedule asks → get_prayer_times).',
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
    'Mark waqt status after owner confirms. MANDATORY before saying "পড়েছেন/আলহামদুলিল্লাহ" — without this DB stays pending. ' +
    'Confirmed "পড়েছি" → prayed_on_time or prayed_late; missed → qaza/missed. Cannot mark future waqt before windowStart.',
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

// ── request_salah_delay ───────────────────────────────────────────────────────

const request_salah_delay: AgentTool = {
  name: 'request_salah_delay',
  description:
    'When the owner asks for extra time before salah reminder/calls resume ("আমাকে ২০ মিনিট সময় দাও", ' +
    '"১৫ মিনিট পর কল করো"). MANDATORY — NEVER claim lock/reminder-off/call-blocked without calling this tool ' +
    'and reading success:true + resumeAt/resumeAtLabel from the result. Chat text does NOT lock anything. ' +
    'ONLY valid within moral-duty window (15 min before jamat to 30 min after = 45 min). ' +
    'Outside window → tool returns error; encourage prayer, do NOT pretend lock. ' +
    'After success, confirm using tool resumeAtLabel only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      waqt: {
        type: 'string',
        enum: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'],
        description: 'Which prayer — infer from current time if owner does not say',
      },
      minutes: {
        type: 'number',
        description: `Requested delay in minutes (capped at ${MAX_DELAY_MIN} and window end)`,
      },
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
    required: ['waqt', 'minutes'],
  },
  handler: async (input) => {
    try {
      const waqt = String(input.waqt ?? '').trim()
      const minutes = Number(input.minutes ?? 0)
      const dateYmd = (input.date as string) || todayYmdDhaka()
      if (!waqt || !Number.isFinite(minutes) || minutes < 1) {
        return { success: false, error: 'waqt এবং minutes (১+) লাগবে।' }
      }

      const prayerStartIso = await resolvePrayerStartIso(waqt, dateYmd)
      if (!prayerStartIso) {
        return { success: false, error: 'নামাজের সময় পাওয়া যায়নি।' }
      }

      const lock = computeLockUntil(prayerStartIso, minutes)
      if (!lock) {
        return {
          success: false,
          error:
            'এখন duty-window-এর বাইরে — এই মুহূর্তে সময় lock করা যাবে না। নামাজের সময়ের ১৫ মিনিট আগে থেকে ৩০ মিনিট পর পর্যন্ত (মোট ৪৫ মিনিট) এর মধ্যে অনুরোধ করুন। উইন্ডো শেষ হলে নামাজ পড়ার জন্য উৎসাহ দিন — delay দেবেন না।',
        }
      }

      await upsertSalahDelayOverride({
        dateYmd,
        waqt,
        delayUntil: lock.lockUntil,
        grantedMin: lock.grantedMin,
      })
      await setOwnerCallLockUntil(lock.lockUntil)

      const resumeLabel = lock.lockUntil.toLocaleTimeString('bn-BD', {
        timeZone: 'Asia/Dhaka',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })

      return {
        success: true,
        data: {
          waqt,
          grantedMinutes: lock.grantedMin,
          resumeAt: lock.lockUntil.toISOString(),
          resumeAtLabel: resumeLabel,
          message:
            `ঠিক আছে স্যার — ${lock.grantedMin} মিনিটের জন্য নামাজের কল বন্ধ রাখলাম (${resumeLabel} পর আবার মনে করিয়ে দেব)। ` +
            `সর্বোচ্চ ${MAX_DELAY_MIN} মিনিট; নামাজের সময় + ৩০ মিনিটের পর আর delay হবে না।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── set_salah_time / get_salah_time_config ───────────────────────────────────

const set_salah_time: AgentTool = {
  name: 'set_salah_time',
  description:
    'Update configurable salah times for a waqt — azan (wakto start), prayer (jamat), and/or wakto end. ' +
    'Use when owner says e.g. "Dhuhr jamat 1:45 koro" or "Asr azan 4:15". Times HH:MM 24h Dhaka. ' +
    'Only change what owner specifies. Duty-window reads the new jamat time automatically.',
  input_schema: {
    type: 'object' as const,
    properties: {
      waqt: { type: 'string', enum: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] },
      azan: { type: 'string', description: 'HH:MM 24h — wakto start (optional)' },
      prayer: { type: 'string', description: 'HH:MM 24h — jamat (optional)' },
      end: { type: 'string', description: 'HH:MM 24h — wakto end (optional)' },
    },
    required: ['waqt'],
  },
  handler: async (input) => {
    try {
      const waqt = String(input.waqt ?? '') as WaqtKey
      const patch: Partial<Record<'azan' | 'prayer' | 'end', string>> = {}
      for (const k of ['azan', 'prayer', 'end'] as const) {
        if (input[k] != null) {
          const v = String(input[k])
          if (!isValidHm(v)) {
            return { success: false, error: `${k} সময় HH:MM ফরম্যাটে দিন (যেমন 13:45)।` }
          }
          patch[k] = v
        }
      }
      if (!Object.keys(patch).length) {
        return { success: false, error: 'কমপক্ষে একটি সময় (azan/prayer/end) দিন।' }
      }
      const cfg = await setSalahWaqtTimes(waqt, patch)
      return {
        success: true,
        data: {
          waqt,
          updated: patch,
          current: cfg[waqt],
          message: `${waqt}-এর সময় আপডেট হয়েছে।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_salah_time_config: AgentTool = {
  name: 'get_salah_time_config',
  description: 'Show current configurable salah times (azan/prayer/end for all 5 waqts).',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const cfg = await getSalahTimeConfig()
      return { success: true, data: cfg }
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
  request_salah_delay,
  set_salah_time,
  get_salah_time_config,
]

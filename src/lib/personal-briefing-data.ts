import { prisma } from '@/lib/prisma'
import {
  todayYmdDhaka,
  dhakaMidnightUtc,
  dhakaDayBounds,
  dhakaMonthBounds,
} from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type PersonalBriefing = {
  generatedAt: string
  todayYmd: string
  salah: { done: number; total: number; missed: number } | null
  remindersToday: Array<{ title: string; dueAt: string }>
  billsDue: Array<{ name: string; amount: number; currency: string; nextDueAt: string; daysUntil: number; overdue: boolean }>
  importantDates: Array<{ title: string; type: string; nextOccurrence: string; daysUntil: number }>
  expenses: { monthToDate: number; today: number } | null
  openTodos: Array<{ title: string; priority: string; ageDays: number }>
}

function nextOccurrenceYmd(eventYmd: string, recurring: boolean, calendar: string, todayYmd: string): string {
  if (!recurring || calendar !== 'gregorian') return eventYmd
  const [, m, d] = eventYmd.split('-').map(Number)
  const [ty] = todayYmd.split('-').map(Number)
  const buildYmd = (yy: number) => {
    const lastDay = new Date(Date.UTC(yy, m!, 0)).getUTCDate()
    const day = Math.min(d!, lastDay)
    return `${yy}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const thisYear = buildYmd(ty!)
  if (thisYear >= todayYmd) return thisYear
  return buildYmd(ty! + 1)
}

/**
 * One-shot gather of the owner's personal day: salah, today's reminders, bills due
 * soon / overdue, upcoming important dates, expense burn, open todos. Every section
 * is independently try/caught so one missing table never blanks the whole briefing.
 * Used by the on-demand get_personal_briefing tool (Prisma side). The VPS worker has
 * its own supabase-js builder for the scheduled morning push.
 */
export async function buildPersonalBriefing(opts: { billWindowDays?: number; dateWindowDays?: number } = {}): Promise<PersonalBriefing> {
  const billWindow = opts.billWindowDays ?? 5
  const dateWindow = opts.dateWindowDays ?? 14
  const today = todayYmdDhaka()
  const todayUtc = dhakaMidnightUtc(today).getTime()

  let salah: PersonalBriefing['salah'] = null
  try {
    const rows = await db.agentSalahRecord.findMany({ where: { date: dhakaMidnightUtc(today) } })
    if (rows.length) {
      const DONE = ['completed', 'done', 'prayed', 'confirmed']
      const MISSED = ['missed', 'qaza']
      const done = rows.filter((r: { status: string }) => DONE.includes(r.status)).length
      const missed = rows.filter((r: { status: string }) => MISSED.includes(r.status)).length
      salah = { done, total: rows.length, missed }
    }
  } catch {
    /* salah optional */
  }

  let remindersToday: PersonalBriefing['remindersToday'] = []
  try {
    const { start, end } = dhakaDayBounds(today)
    const rows = await db.agentReminder.findMany({
      where: { status: { in: ['pending', 'scheduled', 'active'] }, dueAt: { gte: start, lt: end } },
      orderBy: { dueAt: 'asc' },
      take: 20,
    })
    remindersToday = rows.map((r: { title?: string; text?: string; message?: string; dueAt: Date }) => ({
      title: String(r.title ?? r.text ?? r.message ?? 'রিমাইন্ডার'),
      dueAt: new Date(r.dueAt).toISOString(),
    }))
  } catch {
    /* reminders optional */
  }

  let billsDue: PersonalBriefing['billsDue'] = []
  try {
    const horizon = dhakaMidnightUtc(today)
    horizon.setUTCDate(horizon.getUTCDate() + billWindow)
    const rows = await db.agentBill.findMany({
      where: { active: true, nextDueAt: { not: null, lte: horizon } },
      orderBy: { nextDueAt: 'asc' },
      take: 50,
    })
    billsDue = rows.map(
      (b: { name: string; amount: number; currency: string; nextDueAt: Date }) => {
        const ymd = new Date(b.nextDueAt).toISOString().slice(0, 10)
        const daysUntil = Math.round((dhakaMidnightUtc(ymd).getTime() - todayUtc) / 86400000)
        return { name: b.name, amount: b.amount, currency: b.currency, nextDueAt: ymd, daysUntil, overdue: daysUntil < 0 }
      },
    )
  } catch {
    /* bills optional */
  }

  let importantDates: PersonalBriefing['importantDates'] = []
  try {
    const rows = await db.agentImportantDate.findMany({ where: { active: true }, take: 200 })
    importantDates = rows
      .map((r: { title: string; type: string; eventDate: Date; recurring: boolean; calendar: string }) => {
        const eventYmd = new Date(r.eventDate).toISOString().slice(0, 10)
        const nextYmd = nextOccurrenceYmd(eventYmd, r.recurring, r.calendar, today)
        const daysUntil = Math.round((dhakaMidnightUtc(nextYmd).getTime() - todayUtc) / 86400000)
        return { title: r.title, type: r.type, nextOccurrence: nextYmd, daysUntil }
      })
      .filter((x: { daysUntil: number }) => x.daysUntil >= 0 && x.daysUntil <= dateWindow)
      .sort((a: { daysUntil: number }, b: { daysUntil: number }) => a.daysUntil - b.daysUntil)
  } catch {
    /* dates optional */
  }

  let expenses: PersonalBriefing['expenses'] = null
  try {
    const month = dhakaMonthBounds(today)
    const dayB = dhakaDayBounds(today)
    const [mtd, todayAgg] = await Promise.all([
      db.agentFinanceExpense.aggregate({
        _sum: { amount: true },
        where: { deleted: false, occurredAt: { gte: month.start, lt: month.end } },
      }),
      db.agentFinanceExpense.aggregate({
        _sum: { amount: true },
        where: { deleted: false, occurredAt: { gte: dayB.start, lt: dayB.end } },
      }),
    ])
    expenses = { monthToDate: Number(mtd?._sum?.amount ?? 0), today: Number(todayAgg?._sum?.amount ?? 0) }
  } catch {
    /* expenses optional */
  }

  let openTodos: PersonalBriefing['openTodos'] = []
  try {
    const todos = await db.agentTodo.findMany({
      where: { businessId: 'ALMA_LIFESTYLE', source: 'owner', status: { in: ['pending', 'in_progress', 'running'] } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 20,
    })
    const now = Date.now()
    openTodos = todos.map((t: { title: string; priority: string; createdAt: Date }) => ({
      title: t.title,
      priority: t.priority,
      ageDays: Math.floor((now - new Date(t.createdAt).getTime()) / 86400000),
    }))
  } catch {
    /* todos optional */
  }

  return {
    generatedAt: new Date().toISOString(),
    todayYmd: today,
    salah,
    remindersToday,
    billsDue,
    importantDates,
    expenses,
    openTodos,
  }
}

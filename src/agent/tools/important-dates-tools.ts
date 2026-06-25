import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DATE_TYPES = ['birthday', 'anniversary', 'islamic', 'deadline', 'holiday', 'custom']

/**
 * For a recurring GREGORIAN date, return the next yyyy-MM-dd occurrence (this year
 * if still upcoming, else next year). Non-recurring dates return the stored date
 * as-is. Islamic-calendar dates are returned as stored (no Hijri math here — the
 * owner sets the Gregorian date for the current year; honest, not guessed).
 */
function nextOccurrenceYmd(eventYmd: string, recurring: boolean, calendar: string, todayYmd: string): string {
  if (!recurring || calendar !== 'gregorian') return eventYmd
  const [, m, d] = eventYmd.split('-').map(Number)
  const [ty] = todayYmd.split('-').map(Number)
  const buildYmd = (yy: number) => {
    const lastDay = new Date(Date.UTC(yy, m!, 0)).getUTCDate()
    const day = Math.min(d!, lastDay) // clamp Feb-29 etc.
    return `${yy}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const thisYear = buildYmd(ty!)
  if (thisYear >= todayYmd) return thisYear
  return buildYmd(ty! + 1)
}

const add_important_date: AgentTool = {
  name: 'add_important_date',
  description:
    'Remember an important date — a birthday, anniversary, Islamic event, deadline or holiday — and remind Sir ' +
    'before it in the daily briefing. Use when the owner says "X er birthday mone rakho", "amader anniversary ' +
    'X tarikh", "oi deadline ta note koro". Provide eventDate as yyyy-MM-dd. Recurring (birthdays/anniversaries) ' +
    'roll forward each year automatically.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'e.g. "আম্মুর জন্মদিন", "Wedding Anniversary", "পাসপোর্ট রিনিউ ডেডলাইন"' },
      eventDate: { type: 'string', description: 'Date yyyy-MM-dd. For recurring, any year is fine (month-day used).' },
      type: { type: 'string', enum: DATE_TYPES, description: 'Default custom' },
      recurring: { type: 'boolean', description: 'Default true (yearly). Set false for one-off deadlines.' },
      calendar: { type: 'string', enum: ['gregorian', 'islamic'], description: 'Default gregorian' },
      relatedName: { type: 'string', description: 'Optional person this date relates to' },
      remindDaysBefore: { type: 'number', description: 'Days before to start reminding (default 1)' },
      notes: { type: 'string' },
    },
    required: ['title', 'eventDate'],
  },
  handler: async (input) => {
    const title = String(input.title ?? '').trim()
    const eventDate = String(input.eventDate ?? '').trim()
    if (!title) return { success: false, error: 'title is required' }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { success: false, error: 'eventDate must be yyyy-MM-dd' }
    try {
      const created = await db.agentImportantDate.create({
        data: {
          title,
          eventDate: dhakaMidnightUtc(eventDate),
          type: DATE_TYPES.includes(String(input.type)) ? String(input.type) : 'custom',
          recurring: typeof input.recurring === 'boolean' ? input.recurring : true,
          calendar: String(input.calendar) === 'islamic' ? 'islamic' : 'gregorian',
          relatedName: input.relatedName ? String(input.relatedName) : null,
          remindDaysBefore: input.remindDaysBefore != null ? Math.max(0, Math.trunc(Number(input.remindDaysBefore))) : 1,
          notes: input.notes ? String(input.notes) : null,
        },
      })
      return {
        success: true,
        data: { id: created.id, title: created.title, message: `"${title}" তারিখটি মনে রাখা হলো।` },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_important_dates: AgentTool = {
  name: 'list_important_dates',
  description:
    'List remembered important dates (birthdays, anniversaries, Islamic events, deadlines), sorted by the next ' +
    'upcoming occurrence with days-until. Use when the owner asks "ki ki important date ache", "samner kon ' +
    'birthday gula", "deadline gula dekhao".',
  input_schema: {
    type: 'object' as const,
    properties: {
      includeInactive: { type: 'boolean', description: 'Default false' },
      withinDays: { type: 'number', description: 'Optional: only dates whose next occurrence is within N days' },
    },
  },
  handler: async (input) => {
    try {
      const where = input.includeInactive ? {} : { active: true }
      const rows = await db.agentImportantDate.findMany({ where, take: 200 })
      const today = todayYmdDhaka()
      const todayUtc = dhakaMidnightUtc(today).getTime()
      const withinDays = input.withinDays != null ? Number(input.withinDays) : null

      const mapped = rows
        .map(
          (r: {
            id: string
            title: string
            type: string
            eventDate: Date
            recurring: boolean
            calendar: string
            relatedName: string | null
            notes: string | null
          }) => {
            const eventYmd = new Date(r.eventDate).toISOString().slice(0, 10)
            const nextYmd = nextOccurrenceYmd(eventYmd, r.recurring, r.calendar, today)
            const daysUntil = Math.round((dhakaMidnightUtc(nextYmd).getTime() - todayUtc) / 86400000)
            return {
              id: r.id,
              title: r.title,
              type: r.type,
              calendar: r.calendar,
              recurring: r.recurring,
              relatedName: r.relatedName,
              nextOccurrence: nextYmd,
              daysUntil,
              notes: r.notes,
            }
          },
        )
        .filter((x: { daysUntil: number }) => withinDays == null || (x.daysUntil >= 0 && x.daysUntil <= withinDays))
        .sort((a: { daysUntil: number }, b: { daysUntil: number }) => a.daysUntil - b.daysUntil)

      return { success: true, data: { count: mapped.length, dates: mapped } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const delete_important_date: AgentTool = {
  name: 'delete_important_date',
  description:
    'Stop reminding about an important date (soft-deactivate). Use when the owner says "oi date ta baad dao", ' +
    '"X er birthday ar lagbe na".',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' },
      titleMatch: { type: 'string', description: 'Alternative to id — match by partial title' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.titleMatch) {
        const match = await db.agentImportantDate.findFirst({
          where: { active: true, title: { contains: String(input.titleMatch), mode: 'insensitive' } },
        })
        if (!match) return { success: false, error: `"${input.titleMatch}" নামে কোনো তারিখ পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or titleMatch required' }
      const updated = await db.agentImportantDate.update({ where: { id }, data: { active: false } })
      return { success: true, data: { id: updated.id, title: updated.title, message: `"${updated.title}" আর মনে করানো হবে না।` } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const IMPORTANT_DATE_TOOLS: AgentTool[] = [add_important_date, list_important_dates, delete_important_date]

export const IMPORTANT_DATE_ROLE_PROMPT = `
## গুরুত্বপূর্ণ তারিখ ও ইসলামিক ক্যালেন্ডার
জন্মদিন, বিবাহবার্ষিকী, ইসলামিক ইভেন্ট, ডেডলাইন — owner-এর গুরুত্বপূর্ণ তারিখ মনে রাখুন; ব্রিফিং-এ আগেভাগে মনে করিয়ে দিন।
- "X er birthday / anniversary / deadline mone rakho" → add_important_date (eventDate yyyy-MM-dd; recurring হলে প্রতি বছর নিজে এগোয়)।
- "ki ki important date ache / samner birthday gula" → list_important_dates (withinDays দিলে শুধু কাছের গুলো)।
- আর না লাগলে → delete_important_date।
- ইসলামিক তারিখ হলে calendar=islamic দিন; Hijri রূপান্তর অনুমান করবেন না — Sir যে Gregorian তারিখ দেন সেটাই রাখুন।
`

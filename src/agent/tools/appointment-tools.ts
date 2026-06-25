import { prisma } from '@/lib/prisma'
import { dhakaDayBounds } from '@/lib/agent-api/dhaka-date'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const APPT_TYPES = ['meeting', 'call', 'visit', 'medical', 'personal', 'event', 'other']

/** Format a Date as Dhaka "DD MMM, hh:mm AM/PM". */
function fmtDhaka(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

/** yyyy-MM-dd of a Date in Dhaka. */
function ymdDhaka(d: Date): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/**
 * Check whether an instant collides with any salah window on that day.
 * Returns the conflicting waqt name (Bangla-friendly) or null.
 */
async function salahConflict(startAt: Date): Promise<string | null> {
  try {
    const ymd = ymdDhaka(startAt)
    const { start, end } = dhakaDayBounds(ymd)
    const rows: { waqt: string; windowStart: Date; windowEnd: Date }[] = await db.agentSalahRecord.findMany({
      where: { date: { gte: start, lte: end } },
      select: { waqt: true, windowStart: true, windowEnd: true },
    })
    const t = startAt.getTime()
    const hit = rows.find((r) => t >= new Date(r.windowStart).getTime() && t < new Date(r.windowEnd).getTime())
    return hit ? hit.waqt : null
  } catch {
    return null
  }
}

/** Parse a "yyyy-MM-dd HH:mm" or ISO string into a Dhaka-anchored Date. */
function parseDhakaDateTime(input: string): Date | null {
  const s = String(input).trim()
  // ISO with timezone → trust as-is.
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  // "yyyy-MM-dd HH:mm" or "yyyy-MM-ddTHH:mm" (no tz) → treat as Dhaka (+06:00).
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/)
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00+06:00`)
    return isNaN(d.getTime()) ? null : d
  }
  // date-only → 09:00 Dhaka default
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T09:00:00+06:00`)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

const add_appointment: AgentTool = {
  name: 'add_appointment',
  description:
    'Schedule a personal/business appointment, meeting, or event on the owner\'s calendar — and set a reminder ' +
    'before it. Use when the owner says "X tarikh e meeting ache", "kal 4 tay doctor er appointment", ' +
    '"Friday e supplier er sathe call". The agent auto-creates a reminder (default 60 min before) and WARNS if ' +
    'the time clashes with a salah window. startAt accepts "yyyy-MM-dd HH:mm" (Dhaka time) or full ISO.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'What the appointment is, e.g. "ডাক্তার appointment", "supplier meeting"' },
      startAt: { type: 'string', description: 'Start time — "yyyy-MM-dd HH:mm" (Dhaka) or ISO. Required.' },
      endAt: { type: 'string', description: 'Optional end time, same format.' },
      location: { type: 'string' },
      type: { type: 'string', enum: APPT_TYPES, description: 'Default meeting' },
      remindMinutesBefore: { type: 'number', description: 'Minutes before to remind (default 60). 0 = no reminder.' },
      notes: { type: 'string' },
    },
    required: ['title', 'startAt'],
  },
  handler: async (input) => {
    const title = String(input.title ?? '').trim()
    if (!title) return { success: false, error: 'title is required' }
    const startAt = parseDhakaDateTime(String(input.startAt ?? ''))
    if (!startAt) return { success: false, error: 'startAt বুঝতে পারিনি — "yyyy-MM-dd HH:mm" বা ISO দিন।' }
    const endAt = input.endAt ? parseDhakaDateTime(String(input.endAt)) : null
    const type = APPT_TYPES.includes(String(input.type)) ? String(input.type) : 'meeting'
    const remindMin =
      input.remindMinutesBefore != null ? Math.max(0, Math.trunc(Number(input.remindMinutesBefore))) : 60

    try {
      const conflictWaqt = await salahConflict(startAt)

      let reminderId: string | null = null
      if (remindMin > 0) {
        const dueAt = new Date(startAt.getTime() - remindMin * 60_000)
        // Only create a future reminder.
        if (dueAt.getTime() > Date.now()) {
          const reminder = await db.agentReminder.create({
            data: {
              title: `📅 ${title}`,
              body: `${fmtDhaka(startAt)}${input.location ? ` @ ${String(input.location)}` : ''}`,
              dueAt,
              tier: 2,
              voice: false,
              status: 'pending',
            },
          })
          reminderId = reminder.id
        }
      }

      const appt = await db.agentAppointment.create({
        data: {
          title,
          location: input.location ? String(input.location) : null,
          startAt,
          endAt,
          type,
          status: 'scheduled',
          remindMinutesBefore: remindMin,
          reminderId,
          notes: input.notes ? String(input.notes) : null,
        },
      })

      const warning = conflictWaqt
        ? ` ⚠️ সতর্কতা: এই সময়টা ${conflictWaqt} নামাজের ওয়াক্তের সাথে মিলে যাচ্ছে — অন্য সময় ভাবতে পারেন।`
        : ''
      return {
        success: true,
        data: {
          id: appt.id,
          title: appt.title,
          startAt: startAt.toISOString(),
          salahConflict: conflictWaqt,
          reminderSet: !!reminderId,
          message: `"${title}" ক্যালেন্ডারে যোগ হয়েছে — ${fmtDhaka(startAt)}${reminderId ? `, ${remindMin} মিনিট আগে রিমাইন্ডার দেওয়া হবে` : ''}।${warning}`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_appointments: AgentTool = {
  name: 'list_appointments',
  description:
    'List upcoming (or a given day\'s) appointments. Use when the owner asks "ki ki appointment ache", ' +
    '"kal er schedule ki", "ei soptaher meeting gulo". Default returns scheduled appointments from now forward.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'Specific day yyyy-MM-dd (Dhaka). Omit for all upcoming.' },
      days: { type: 'number', description: 'Look-ahead window in days from today (default 30, ignored if date given)' },
      includeDone: { type: 'boolean', description: 'Include past/cancelled (default false)' },
    },
  },
  handler: async (input) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {}
      if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) {
        const { start, end } = dhakaDayBounds(String(input.date))
        where.startAt = { gte: start, lte: end }
      } else {
        const days = input.days != null ? Math.max(1, Math.trunc(Number(input.days))) : 30
        const from = new Date()
        const to = new Date(Date.now() + days * 86_400_000)
        where.startAt = { gte: from, lte: to }
      }
      if (!input.includeDone) where.status = 'scheduled'

      const rows = await db.agentAppointment.findMany({
        where,
        orderBy: { startAt: 'asc' },
        take: 100,
      })
      return {
        success: true,
        data: {
          count: rows.length,
          appointments: rows.map(
            (a: {
              id: string
              title: string
              location: string | null
              startAt: Date
              endAt: Date | null
              type: string
              status: string
              notes: string | null
            }) => ({
              id: a.id,
              title: a.title,
              location: a.location,
              startAt: new Date(a.startAt).toISOString(),
              when: fmtDhaka(new Date(a.startAt)),
              endAt: a.endAt ? new Date(a.endAt).toISOString() : null,
              type: a.type,
              status: a.status,
              notes: a.notes,
            }),
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const update_appointment: AgentTool = {
  name: 'update_appointment',
  description:
    'Reschedule, cancel, or mark an appointment done. Use when the owner says "meeting ta cancel koro", ' +
    '"oita 5 tay shift koro", "appointment ta hoye geche". Rescheduling also moves its reminder. Re-checks ' +
    'salah conflict on a new time.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' },
      titleMatch: { type: 'string', description: 'Alternative to id — match an upcoming appointment by partial title' },
      startAt: { type: 'string', description: 'New start time to reschedule to' },
      status: { type: 'string', enum: ['scheduled', 'done', 'cancelled'], description: 'Set done/cancelled' },
      location: { type: 'string' },
      notes: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.titleMatch) {
        const match = await db.agentAppointment.findFirst({
          where: { status: 'scheduled', title: { contains: String(input.titleMatch), mode: 'insensitive' } },
          orderBy: { startAt: 'asc' },
        })
        if (!match) return { success: false, error: `"${input.titleMatch}" নামে কোনো appointment পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or titleMatch required' }

      const existing = await db.agentAppointment.findUnique({ where: { id } })
      if (!existing) return { success: false, error: 'appointment not found' }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = {}
      let conflictWaqt: string | null = null
      let newStart: Date | null = null
      if (input.startAt) {
        newStart = parseDhakaDateTime(String(input.startAt))
        if (!newStart) return { success: false, error: 'startAt বুঝতে পারিনি।' }
        data.startAt = newStart
        conflictWaqt = await salahConflict(newStart)
        // Move the linked reminder too.
        if (existing.reminderId && existing.remindMinutesBefore > 0) {
          const dueAt = new Date(newStart.getTime() - existing.remindMinutesBefore * 60_000)
          try {
            await db.agentReminder.update({
              where: { id: existing.reminderId },
              data: { dueAt, status: dueAt.getTime() > Date.now() ? 'pending' : 'done', lastSentAt: null },
            })
          } catch {
            /* reminder may have been consumed already */
          }
        }
      }
      if (input.location != null) data.location = String(input.location)
      if (input.notes != null) data.notes = String(input.notes)
      if (input.status && ['scheduled', 'done', 'cancelled'].includes(String(input.status))) {
        data.status = String(input.status)
        // Cancel the reminder if the appointment is no longer active.
        if ((data.status === 'cancelled' || data.status === 'done') && existing.reminderId) {
          try {
            await db.agentReminder.update({ where: { id: existing.reminderId }, data: { status: 'cancelled' } })
          } catch {
            /* ignore */
          }
        }
      }
      if (!Object.keys(data).length) return { success: false, error: 'কিছু পরিবর্তন দিন।' }

      const updated = await db.agentAppointment.update({ where: { id }, data })
      const warning = conflictWaqt
        ? ` ⚠️ নতুন সময়টা ${conflictWaqt} নামাজের ওয়াক্তের সাথে মিলছে।`
        : ''
      return {
        success: true,
        data: {
          id: updated.id,
          title: updated.title,
          status: updated.status,
          salahConflict: conflictWaqt,
          message: `"${updated.title}" আপডেট হয়েছে${newStart ? ` — নতুন সময় ${fmtDhaka(newStart)}` : ''}।${warning}`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const APPOINTMENT_TOOLS: AgentTool[] = [add_appointment, list_appointments, update_appointment]

export const APPOINTMENT_ROLE_PROMPT = `
## ক্যালেন্ডার ও অ্যাপয়েন্টমেন্ট
owner-এর মিটিং/অ্যাপয়েন্টমেন্ট/ইভেন্ট ম্যানেজ করুন। নির্ধারিত সময়ের আগে রিমাইন্ডার নিজে সেট হয়।
- "X tarikh e meeting / doctor appointment ache" → add_appointment (startAt = "yyyy-MM-dd HH:mm", Dhaka সময়)। সময়টা নামাজের ওয়াক্তের সাথে মিললে নিজে থেকেই Sir-কে সতর্ক করুন।
- "ki ki appointment ache / kal er schedule" → list_appointments।
- "cancel / reschedule / hoye geche" → update_appointment (reschedule করলে রিমাইন্ডারও সরে যায়)।
- ব্রিফিং-এ আজকের appointment গুলো দেখানো হয়।
`

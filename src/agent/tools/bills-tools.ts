import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const CYCLES = ['monthly', 'quarterly', 'yearly', 'weekly', 'one_time']

/**
 * Compute the next due date (yyyy-MM-dd, Dhaka) for a recurring bill.
 *  - monthly  : next occurrence of dueDay in this or next month
 *  - weekly   : 7 days out
 *  - quarterly: ~3 months
 *  - yearly   : ~12 months on dueDay
 * Clamps dueDay to the month length so day 31 never overflows.
 */
function computeNextDueYmd(cycle: string, dueDay: number | null, fromYmd: string): string | null {
  const today = fromYmd
  if (cycle === 'weekly') return addDaysYmd(today, 7)
  if (!dueDay || dueDay < 1 || dueDay > 31) return null

  const [y, m] = today.split('-').map(Number)
  const buildYmd = (yy: number, mm: number) => {
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate() // mm is 1-based → day 0 of next = last of mm
    const day = Math.min(dueDay, lastDay)
    return `${yy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  if (cycle === 'monthly') {
    const thisMonth = buildYmd(y!, m!)
    if (thisMonth >= today) return thisMonth
    const nm = m! === 12 ? [y! + 1, 1] : [y!, m! + 1]
    return buildYmd(nm[0]!, nm[1]!)
  }
  if (cycle === 'quarterly') {
    let yy = y!
    let mm = m!
    for (let i = 0; i < 5; i++) {
      const candidate = buildYmd(yy, mm)
      if (candidate >= today) return candidate
      mm += 3
      while (mm > 12) { mm -= 12; yy += 1 }
    }
    return buildYmd(yy, mm)
  }
  if (cycle === 'yearly') {
    const thisYear = buildYmd(y!, m!)
    if (thisYear >= today) return thisYear
    return buildYmd(y! + 1, m!)
  }
  // one_time: caller must provide an explicit date elsewhere
  return null
}

const add_bill: AgentTool = {
  name: 'add_bill',
  description:
    'Track a recurring personal/business bill or subscription the owner pays — rent, electricity, internet, ' +
    'loan EMI, SaaS, insurance, etc. The agent will remind Sir before each due date in the daily briefing. ' +
    'Use when the owner says "X bill ta track koro", "bidyut bill mone koraio", "Netflix subscription add koro". ' +
    'amount is whole taka (BDT default). For monthly bills give dueDay (1-31) and the next due date is computed ' +
    'automatically.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Bill name, e.g. "বিদ্যুৎ বিল", "বাসা ভাড়া", "Netflix"' },
      amount: { type: 'number', description: 'Amount in whole taka (BDT). Optional if unknown.' },
      currency: { type: 'string', description: 'Default BDT' },
      category: { type: 'string', description: 'Optional: utility, rent, loan, subscription, insurance…' },
      cycle: { type: 'string', enum: CYCLES, description: 'Default monthly' },
      dueDay: { type: 'number', description: 'Day of month it is due (1-31), for monthly/quarterly/yearly bills' },
      nextDueAt: { type: 'string', description: 'Explicit next due date yyyy-MM-dd (use for one_time or if known)' },
      remindDaysBefore: { type: 'number', description: 'How many days before due to start reminding (default 3)' },
      notes: { type: 'string' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const name = String(input.name ?? '').trim()
    if (!name) return { success: false, error: 'name is required' }
    const cycle = CYCLES.includes(String(input.cycle)) ? String(input.cycle) : 'monthly'
    const dueDay = input.dueDay != null ? Math.trunc(Number(input.dueDay)) : null
    const today = todayYmdDhaka()
    let nextDueYmd =
      input.nextDueAt && /^\d{4}-\d{2}-\d{2}$/.test(String(input.nextDueAt))
        ? String(input.nextDueAt)
        : computeNextDueYmd(cycle, dueDay, today)

    try {
      const bill = await db.agentBill.create({
        data: {
          name,
          amount: input.amount != null ? roundMoney(Number(input.amount)) : 0,
          currency: input.currency ? String(input.currency).toUpperCase() : 'BDT',
          category: input.category ? String(input.category) : null,
          cycle,
          dueDay: dueDay && dueDay >= 1 && dueDay <= 31 ? dueDay : null,
          nextDueAt: nextDueYmd ? dhakaMidnightUtc(nextDueYmd) : null,
          remindDaysBefore:
            input.remindDaysBefore != null ? Math.max(0, Math.trunc(Number(input.remindDaysBefore))) : 3,
          notes: input.notes ? String(input.notes) : null,
        },
      })
      return {
        success: true,
        data: {
          id: bill.id,
          name: bill.name,
          nextDueAt: nextDueYmd,
          message: `"${name}" বিল ট্র্যাকে যোগ হয়েছে${nextDueYmd ? ` — পরের তারিখ ${nextDueYmd}` : ''}।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_bills: AgentTool = {
  name: 'list_bills',
  description:
    'List tracked bills/subscriptions. Use when the owner asks "amar bill gulo dekhao", "konta koto", "ki ki ' +
    'subscription ache". Returns each bill with amount, cycle and next due date (sorted by soonest due).',
  input_schema: {
    type: 'object' as const,
    properties: {
      includeInactive: { type: 'boolean', description: 'Default false (only active bills)' },
    },
  },
  handler: async (input) => {
    try {
      const where = input.includeInactive ? {} : { active: true }
      const bills = await db.agentBill.findMany({
        where,
        orderBy: [{ nextDueAt: 'asc' }, { name: 'asc' }],
        take: 100,
      })
      const today = todayYmdDhaka()
      return {
        success: true,
        data: {
          count: bills.length,
          bills: bills.map(
            (b: {
              id: string
              name: string
              amount: number
              currency: string
              category: string | null
              cycle: string
              nextDueAt: Date | null
              remindDaysBefore: number
              active: boolean
              notes: string | null
            }) => {
              const dueYmd = b.nextDueAt ? new Date(b.nextDueAt).toISOString().slice(0, 10) : null
              const daysUntil = dueYmd
                ? Math.round((dhakaMidnightUtc(dueYmd).getTime() - dhakaMidnightUtc(today).getTime()) / 86400000)
                : null
              return {
                id: b.id,
                name: b.name,
                amount: b.amount,
                currency: b.currency,
                category: b.category,
                cycle: b.cycle,
                nextDueAt: dueYmd,
                daysUntil,
                overdue: daysUntil != null && daysUntil < 0,
                active: b.active,
                notes: b.notes,
              }
            },
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const mark_bill_paid: AgentTool = {
  name: 'mark_bill_paid',
  description:
    'Mark a bill as paid for this cycle. Records the payment time and rolls the next due date forward to the ' +
    'next cycle automatically. Use when the owner says "bidyut bill dia disi", "X bill paid", "oita pay hoye geche".',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Bill id' },
      nameMatch: { type: 'string', description: 'Alternative to id — match an active bill by partial name' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.nameMatch) {
        const match = await db.agentBill.findFirst({
          where: { active: true, name: { contains: String(input.nameMatch), mode: 'insensitive' } },
          orderBy: { nextDueAt: 'asc' },
        })
        if (!match) return { success: false, error: `"${input.nameMatch}" নামে কোনো active বিল পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or nameMatch required' }

      const bill = await db.agentBill.findUnique({ where: { id } })
      if (!bill) return { success: false, error: 'bill not found' }

      // Roll forward from the day AFTER the current due (or today) so we land on the next cycle.
      const baseYmd = bill.nextDueAt
        ? addDaysYmd(new Date(bill.nextDueAt).toISOString().slice(0, 10), 1)
        : addDaysYmd(todayYmdDhaka(), 1)
      const nextYmd = bill.cycle === 'one_time' ? null : computeNextDueYmd(bill.cycle, bill.dueDay, baseYmd)

      const updated = await db.agentBill.update({
        where: { id },
        data: {
          lastPaidAt: new Date(),
          lastRemindedAt: null,
          nextDueAt: nextYmd ? dhakaMidnightUtc(nextYmd) : null,
          active: bill.cycle === 'one_time' ? false : bill.active,
        },
      })
      return {
        success: true,
        data: {
          id: updated.id,
          name: updated.name,
          nextDueAt: nextYmd,
          message:
            bill.cycle === 'one_time'
              ? `"${updated.name}" paid হিসেবে মার্ক হয়েছে।`
              : `"${updated.name}" paid — পরের তারিখ ${nextYmd}।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const update_bill: AgentTool = {
  name: 'update_bill',
  description:
    'Update a tracked bill — change amount, due day, cycle, reminder lead time, or deactivate it. ' +
    'Use when the owner says "X bill er amount change koro", "due day 5 e koro", "oitar reminder bondho koro".',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' },
      nameMatch: { type: 'string', description: 'Alternative to id — match an active bill by partial name' },
      name: { type: 'string' },
      amount: { type: 'number' },
      category: { type: 'string' },
      cycle: { type: 'string', enum: CYCLES },
      dueDay: { type: 'number' },
      remindDaysBefore: { type: 'number' },
      active: { type: 'boolean', description: 'Set false to stop tracking/reminding' },
      notes: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.nameMatch) {
        const match = await db.agentBill.findFirst({
          where: { name: { contains: String(input.nameMatch), mode: 'insensitive' } },
          orderBy: { nextDueAt: 'asc' },
        })
        if (!match) return { success: false, error: `"${input.nameMatch}" নামে কোনো বিল পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or nameMatch required' }

      const existing = await db.agentBill.findUnique({ where: { id } })
      if (!existing) return { success: false, error: 'bill not found' }

      const data: Record<string, unknown> = {}
      if (input.name != null) data.name = String(input.name)
      if (input.amount != null) data.amount = roundMoney(Number(input.amount))
      if (input.category != null) data.category = String(input.category)
      if (input.notes != null) data.notes = String(input.notes)
      if (input.remindDaysBefore != null) data.remindDaysBefore = Math.max(0, Math.trunc(Number(input.remindDaysBefore)))
      if (typeof input.active === 'boolean') data.active = input.active

      const newCycle = input.cycle && CYCLES.includes(String(input.cycle)) ? String(input.cycle) : existing.cycle
      const newDueDay = input.dueDay != null ? Math.trunc(Number(input.dueDay)) : existing.dueDay
      if (input.cycle != null) data.cycle = newCycle
      if (input.dueDay != null) data.dueDay = newDueDay && newDueDay >= 1 && newDueDay <= 31 ? newDueDay : null
      // Recompute the next due date if cycle or dueDay changed.
      if (input.cycle != null || input.dueDay != null) {
        const nextYmd = computeNextDueYmd(newCycle, newDueDay, todayYmdDhaka())
        data.nextDueAt = nextYmd ? dhakaMidnightUtc(nextYmd) : null
      }

      if (!Object.keys(data).length) return { success: false, error: 'কিছু পরিবর্তন দিন।' }

      const updated = await db.agentBill.update({ where: { id }, data })
      return {
        success: true,
        data: { id: updated.id, name: updated.name, message: `"${updated.name}" আপডেট হয়েছে।` },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const delete_bill: AgentTool = {
  name: 'delete_bill',
  description:
    'Stop tracking a bill entirely (soft-deactivate). Use when the owner says "X bill ar track kora lagbe na", ' +
    '"oita baad dao", "subscription cancel hoye geche". Prefer this over leaving stale bills active.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' },
      nameMatch: { type: 'string', description: 'Alternative to id — match a bill by partial name' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.nameMatch) {
        const match = await db.agentBill.findFirst({
          where: { name: { contains: String(input.nameMatch), mode: 'insensitive' } },
          orderBy: { nextDueAt: 'asc' },
        })
        if (!match) return { success: false, error: `"${input.nameMatch}" নামে কোনো বিল পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or nameMatch required' }
      const updated = await db.agentBill.update({ where: { id }, data: { active: false } })
      return { success: true, data: { id: updated.id, name: updated.name, message: `"${updated.name}" ট্র্যাক থেকে সরানো হয়েছে।` } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const BILLS_TOOLS: AgentTool[] = [add_bill, list_bills, mark_bill_paid, update_bill, delete_bill]

export const BILLS_ROLE_PROMPT = `
## বিল ও সাবস্ক্রিপশন ট্র্যাকার
owner-এর নিয়মিত বিল/সাবস্ক্রিপশন (বাসা ভাড়া, বিদ্যুৎ, ইন্টারনেট, লোন EMI, Netflix ইত্যাদি) ট্র্যাক করুন। প্রতিদিনের ব্রিফিং-এ due-এর আগে Sir-কে মনে করিয়ে দেওয়া হয়।
- "X বিল track koro / mone koraio" → add_bill (amount পূর্ণ টাকায়, monthly হলে dueDay 1-31 দিন — পরের তারিখ নিজে হিসাব হবে)।
- "amar bill gulo dekhao / konta koto baki" → list_bills।
- "oita dia disi / paid" → mark_bill_paid (পরের cycle-এ তারিখ নিজে এগিয়ে যায়)।
- amount/dueDay/cycle বদলাতে → update_bill। আর track না করলে → delete_bill।
- টাকা সবসময় পূর্ণ টাকা (BDT), roundMoney মেনে।
`

/**
 * Phase 6E — Personal finance tools.
 *
 * FINANCE INTENT RULE (from Phase 6 spec):
 * Finance intent REQUIRES an explicit money signal:
 *   - currency word: tk/taka/টাকা/BDT/AED/dirham
 *   - OR money verb: disi/dilam/nilam/dhar/pawna/khoroch/ferot/dena
 * Bare numbers are NEVER amounts. The model enforces this; tools accept explicit calls only.
 *
 * Direction mapping:
 *   "Karim k 5000 disi"           → lent
 *   "Nahid theke 2000 nilam"      → borrowed
 *   "Hasib 1000 ferot dilo"       → repaid_to_me
 *   "Nahid ke 500 diye disi..."   → repaid_by_me
 *
 * EVERY log → confirm card before save.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

// ── log_expense ───────────────────────────────────────────────────────────────

const log_expense: AgentTool = {
  name: 'log_expense',
  description:
    'Logs a personal expense. REQUIRES an explicit money signal in the owner\'s message (currency word OR money verb). ' +
    'Creates a PENDING ACTION (confirm card) — owner must approve before saving. ' +
    'NEVER call for: percentages, ordinal numbers, durations, quantities without a currency signal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      amount:         { type: 'number', description: 'Amount in whole units (no decimals)' },
      currency:       { type: 'string', enum: ['BDT','AED'], description: 'Currency (default BDT)' },
      category:       { type: 'string', description: 'Expense category (food, transport, utilities, etc.)' },
      note:           { type: 'string', description: 'Description of the expense' },
      occurredAt:     { type: 'string', description: 'ISO date/datetime when expense occurred (default: now)' },
      conversationId: { type: 'string' },
    },
    required: ['amount', 'note'],
  },
  handler: async (input) => {
    try {
      const amount   = Math.round(Number(input.amount))
      if (amount <= 0) return { success: false, error: 'amount must be positive' }
      const currency = (input.currency as string) || 'BDT'
      const note     = String(input.note)
      const category = input.category ? String(input.category) : null
      const occurredAt = input.occurredAt ? new Date(String(input.occurredAt)) : new Date()

      const currencySymbol = currency === 'AED' ? 'AED ' : '৳'
      const summary = `খরচ লগ: ${currencySymbol}${amount.toLocaleString('bn-BD')} — ${note}${category ? ` (${category})` : ''}`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'log_expense',
          payload:  { amount, currency, category, note, occurredAt: occurredAt.toISOString() },
          summary,
          costEstimate: 0,
          status:   'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, message: 'Pending your confirmation.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── log_ledger_entry ──────────────────────────────────────────────────────────

const log_ledger_entry: AgentTool = {
  name: 'log_ledger_entry',
  description:
    'Logs a debt/lending entry. Creates a PENDING ACTION (confirm card). ' +
    'Directions: lent (আপনি দিলেন), borrowed (আপনি নিলেন), repaid_to_me (কেউ ফেরত দিল), repaid_by_me (আপনি ফেরত দিলেন). ' +
    'REQUIRES explicit money signal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      personName:     { type: 'string', description: 'The other person\'s name' },
      direction:      { type: 'string', enum: ['lent','borrowed','repaid_to_me','repaid_by_me'] },
      amount:         { type: 'number', description: 'Amount in whole units' },
      currency:       { type: 'string', enum: ['BDT','AED'] },
      note:           { type: 'string', description: 'Context/reason' },
      occurredAt:     { type: 'string', description: 'ISO date/datetime (default: now)' },
      conversationId: { type: 'string' },
    },
    required: ['personName', 'direction', 'amount'],
  },
  handler: async (input) => {
    try {
      const amount   = Math.round(Number(input.amount))
      if (amount <= 0) return { success: false, error: 'amount must be positive' }
      const personName = String(input.personName)
      const direction  = String(input.direction)
      const currency   = (input.currency as string) || 'BDT'
      const note       = input.note ? String(input.note) : null
      const occurredAt = input.occurredAt ? new Date(String(input.occurredAt)) : new Date()

      const currencySymbol = currency === 'AED' ? 'AED ' : '৳'
      const directionBn: Record<string, string> = {
        lent:          `${personName}-কে ধার দিলেন`,
        borrowed:      `${personName}-এর কাছ থেকে ধার নিলেন`,
        repaid_to_me:  `${personName} ফেরত দিল`,
        repaid_by_me:  `${personName}-কে ফেরত দিলেন`,
      }
      const summary = `লেজার: ${currencySymbol}${amount.toLocaleString('bn-BD')} — ${directionBn[direction] || direction}${note ? ` (${note})` : ''}`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'log_ledger_entry',
          payload:  { personName, direction, amount, currency, note, occurredAt: occurredAt.toISOString() },
          summary,
          costEstimate: 0,
          status:   'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, message: 'Pending your confirmation.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_expense_summary ───────────────────────────────────────────────────────

const get_expense_summary: AgentTool = {
  name: 'get_expense_summary',
  description: 'Returns personal expense summary for a period, optionally grouped by category.',
  input_schema: {
    type: 'object' as const,
    properties: {
      period:  { type: 'string', enum: ['today','week','month','all'], description: 'Time range' },
      groupBy: { type: 'string', enum: ['category','currency','day'], description: 'Aggregation dimension' },
      currency: { type: 'string', enum: ['BDT','AED'], description: 'Filter currency (optional)' },
    },
  },
  handler: async (input) => {
    try {
      const period   = (input.period as string) || 'month'
      const currency = input.currency ? String(input.currency) : null

      let startDate: Date | null = null
      const now = new Date()
      if (period === 'today') {
        startDate = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }))
      } else if (period === 'week') {
        startDate = new Date(now.getTime() - 7 * 86400 * 1000)
      } else if (period === 'month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1)
      }

      const where: Record<string, unknown> = {}
      if (startDate) where.occurredAt = { gte: startDate }
      if (currency)  where.currency   = currency

      const rows = await db.agentFinanceExpense.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: 200,
      })

      // Aggregate
      const totals: Record<string, number> = {}
      const grouped: Record<string, number> = {}
      for (const r of rows) {
        const key = `${r.currency}`
        totals[key] = (totals[key] || 0) + r.amount

        const gKey = input.groupBy === 'category' ? `${r.currency}:${r.category || 'অন্যান্য'}`
                   : input.groupBy === 'day'      ? `${r.currency}:${r.occurredAt.toISOString().slice(0, 10)}`
                   : key
        grouped[gKey] = (grouped[gKey] || 0) + r.amount
      }

      return { success: true, data: { period, totals, grouped, recentCount: rows.length } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_ledger_balances ───────────────────────────────────────────────────────

const get_ledger_balances: AgentTool = {
  name: 'get_ledger_balances',
  description:
    'Returns net balances per person, per currency. ' +
    'Positive balance = they owe you; negative = you owe them. ' +
    'Optionally filter by person name.',
  input_schema: {
    type: 'object' as const,
    properties: {
      person:   { type: 'string', description: 'Filter by person name (optional)' },
      currency: { type: 'string', enum: ['BDT','AED'], description: 'Filter currency (optional)' },
    },
  },
  handler: async (input) => {
    try {
      const where: Record<string, unknown> = {}
      if (input.person)   where.personName = { contains: String(input.person), mode: 'insensitive' }
      if (input.currency) where.currency   = String(input.currency)

      const rows = await db.agentFinanceLedger.findMany({
        where,
        orderBy: [{ personName: 'asc' }, { occurredAt: 'desc' }],
        take: 500,
      })

      // Net balance: lent/repaid_to_me = positive (they owe me); borrowed/repaid_by_me = negative (I owe them)
      const balances: Record<string, Record<string, number>> = {}
      const histories: Record<string, Array<{
        id: string; direction: string; amount: number; currency: string; note: string|null; occurredAt: Date
      }>> = {}

      for (const r of rows) {
        const key = r.personName.toLowerCase()
        if (!balances[key]) balances[key] = {}
        if (!histories[key]) histories[key] = []

        const sign = (r.direction === 'lent' || r.direction === 'repaid_to_me') ? 1 : -1
        balances[key][r.currency] = (balances[key][r.currency] || 0) + sign * r.amount

        histories[key].push({
          id: r.id, direction: r.direction, amount: r.amount,
          currency: r.currency, note: r.note, occurredAt: r.occurredAt,
        })
      }

      const result = Object.entries(balances).map(([person, bals]) => ({
        person,
        balances: bals,
        recentEntries: (histories[person] || []).slice(0, 5),
      }))

      return { success: true, data: { balances: result } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const FINANCE_TOOLS: AgentTool[] = [
  log_expense,
  log_ledger_entry,
  get_expense_summary,
  get_ledger_balances,
]

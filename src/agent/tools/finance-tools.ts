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
import { formatDateTimeDhaka } from '@/lib/agent-api/dhaka-date'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

const DIRECTION_BN: Record<string, string> = {
  lent: 'ধার দিলেন',
  borrowed: 'ধার নিলেন',
  repaid_to_me: 'ফেরত পেলেন',
  repaid_by_me: 'ফেরত দিলেন',
}

type LedgerEntryInput = {
  personName: string
  direction: string
  amount: number
  currency?: string
  note?: string | null
  occurredAt?: string
}

type ExpenseEntryInput = {
  amount: number
  currency?: string
  category?: string | null
  note?: string
  occurredAt?: string
}

function formatLedgerBatchSummary(title: string, entries: LedgerEntryInput[]): string {
  const totals: Record<string, number> = { BDT: 0, AED: 0 }
  const lines = entries.map((e, i) => {
    const currency = (e.currency as string) || 'BDT'
    const amount = Math.round(Number(e.amount))
    totals[currency] = (totals[currency] || 0) + amount
    const sym = currency === 'AED' ? 'AED ' : '৳'
    const dir = DIRECTION_BN[e.direction] || e.direction
    const note = e.note ? ` — ${e.note}` : ''
    return `${i + 1}. ${e.personName}: ${sym}${amount.toLocaleString('bn-BD')} (${dir})${note}`
  })
  const totalLines = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([c, v]) => (c === 'AED' ? `মোট AED: ${v.toLocaleString('bn-BD')}` : `মোট BDT: ৳${v.toLocaleString('bn-BD')}`))
  return (
    `📋 ${title} (${entries.length}টি এন্ট্রি)\n\n` +
    lines.join('\n') +
    (totalLines.length ? `\n\n${totalLines.join('\n')}` : '') +
    '\n\n✅ একবার Approve করলে সব সেভ হবে।'
  )
}

function formatExpenseBatchSummary(title: string, entries: ExpenseEntryInput[]): string {
  const totals: Record<string, number> = { BDT: 0, AED: 0 }
  const lines = entries.map((e, i) => {
    const currency = (e.currency as string) || 'BDT'
    const amount = Math.round(Number(e.amount))
    totals[currency] = (totals[currency] || 0) + amount
    const sym = currency === 'AED' ? 'AED ' : '৳'
    const cat = e.category ? ` (${e.category})` : ''
    return `${i + 1}. ${sym}${amount.toLocaleString('bn-BD')} — ${e.note ?? 'খরচ'}${cat}`
  })
  const totalLines = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([c, v]) => (c === 'AED' ? `মোট AED: ${v.toLocaleString('bn-BD')}` : `মোট BDT: ৳${v.toLocaleString('bn-BD')}`))
  return (
    `📋 ${title} (${entries.length}টি খরচ)\n\n` +
    lines.join('\n') +
    (totalLines.length ? `\n\n${totalLines.join('\n')}` : '') +
    '\n\n✅ একবার Approve করলে সব সেভ হবে।'
  )
}

// ── log_expense ───────────────────────────────────────────────────────────────

const log_expense: AgentTool = {
  name: 'log_expense',
  description:
    'Logs a SINGLE personal expense (confirm card). For 2+ expenses use log_expenses_batch. ' +
    'REQUIRES an explicit money signal (currency word OR money verb). ' +
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
    'Logs a SINGLE debt/lending entry (confirm card). For 2+ entries use log_ledger_entries_batch instead. ' +
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

function ledgerEntrySign(direction: string): number {
  return (direction === 'lent' || direction === 'repaid_to_me') ? 1 : -1
}

type LedgerRow = {
  id: string
  direction: string
  amount: number
  currency: string
  note: string | null
  occurredAt: Date
}

function serializeLedgerEntries(
  rows: LedgerRow[],
  opts: { oldestFirst: boolean; maxEntries: number },
) {
  const chronological = [...rows].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  )
  const totalCount = chronological.length
  const capped = totalCount > opts.maxEntries
    ? chronological.slice(totalCount - opts.maxEntries)
    : chronological

  const runningByCurrency: Record<string, number> = {}
  const withRunning = capped.map((r) => {
    const sign = ledgerEntrySign(r.direction)
    runningByCurrency[r.currency] = (runningByCurrency[r.currency] || 0) + sign * r.amount
    return {
      id: r.id,
      direction: r.direction,
      directionLabel: DIRECTION_BN[r.direction] ?? r.direction,
      amount: r.amount,
      currency: r.currency,
      note: r.note,
      occurredAt: r.occurredAt.toISOString(),
      occurredAtDhaka: formatDateTimeDhaka(r.occurredAt),
      signedAmount: sign * r.amount,
      runningBalance: runningByCurrency[r.currency],
    }
  })

  const display = opts.oldestFirst ? withRunning : [...withRunning].reverse()
  const entries = display.map((r, index) => ({
    serial: index + 1,
    ...r,
  }))

  const byCurrency: Record<string, typeof entries> = {}
  for (const e of entries) {
    if (!byCurrency[e.currency]) byCurrency[e.currency] = []
    byCurrency[e.currency].push(e)
  }

  return { entries, entriesByCurrency: byCurrency, totalCount, truncated: totalCount > opts.maxEntries }
}

const get_ledger_balances: AgentTool = {
  name: 'get_ledger_balances',
  description:
    'Returns net balances per person and ledger transaction history. ' +
    'When person is set, returns ALL matching entries in serial order (not just recent 5). ' +
    'Positive balance = they owe you; negative = you owe them.',
  input_schema: {
    type: 'object' as const,
    properties: {
      person: {
        type: 'string',
        description: 'Filter by person name — returns full transaction list for that person',
      },
      currency: { type: 'string', enum: ['BDT', 'AED'], description: 'Filter currency (optional)' },
      order: {
        type: 'string',
        enum: ['oldest_first', 'newest_first'],
        description: 'Serial order (default oldest_first)',
      },
      maxEntries: {
        type: 'number',
        description: 'Max entries per person (default 500 when person set, else 5 for overview)',
      },
    },
  },
  handler: async (input) => {
    try {
      const personFilter = input.person ? String(input.person).trim() : ''
      const oldestFirst = input.order !== 'newest_first'
      const maxPerPerson = personFilter
        ? Math.min(Math.max(Number(input.maxEntries ?? 500), 1), 2000)
        : Math.min(Math.max(Number(input.maxEntries ?? 5), 1), 50)

      const where: Record<string, unknown> = {}
      if (personFilter) where.personName = { contains: personFilter, mode: 'insensitive' }
      if (input.currency) where.currency = String(input.currency)

      const rows = await db.agentFinanceLedger.findMany({
        where,
        orderBy: [{ personName: 'asc' }, { occurredAt: 'asc' }],
        take: personFilter ? 2000 : 500,
      })

      const balances: Record<string, Record<string, number>> = {}
      const histories: Record<string, LedgerRow[]> = {}
      const displayNames: Record<string, string> = {}

      for (const r of rows) {
        const key = r.personName.toLowerCase()
        displayNames[key] = r.personName
        if (!balances[key]) balances[key] = {}
        if (!histories[key]) histories[key] = []

        const sign = ledgerEntrySign(r.direction)
        balances[key][r.currency] = (balances[key][r.currency] || 0) + sign * r.amount

        histories[key].push({
          id: r.id,
          direction: r.direction,
          amount: r.amount,
          currency: r.currency,
          note: r.note,
          occurredAt: r.occurredAt,
        })
      }

      const result = Object.entries(balances).map(([personKey, bals]) => {
        const history = histories[personKey] || []
        const serialized = serializeLedgerEntries(history, {
          oldestFirst,
          maxEntries: maxPerPerson,
        })
        return {
          person: displayNames[personKey] ?? personKey,
          balances: bals,
          entryCount: serialized.totalCount,
          truncated: serialized.truncated,
          entries: serialized.entries,
          entriesByCurrency: serialized.entriesByCurrency,
          // Back-compat alias — now same as full list when person filter used
          recentEntries: serialized.entries.slice(-5),
        }
      })

      return {
        success: true,
        data: {
          balances: result,
          personFilter: personFilter || null,
          includesAllEntries: Boolean(personFilter),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── log_ledger_entries_batch ──────────────────────────────────────────────────

const log_ledger_entries_batch: AgentTool = {
  name: 'log_ledger_entries_batch',
  description:
    'Logs MULTIPLE ledger entries in ONE confirm card. ' +
    'REQUIRED when owner lists 2+ transactions at once (same or mixed persons). ' +
    'NEVER call log_ledger_entry repeatedly for a batch — use this tool instead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Batch label e.g. "Hossain mama — ধার এন্ট্রি"' },
      entries: {
        type: 'array',
        minItems: 2,
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            personName: { type: 'string' },
            direction: { type: 'string', enum: ['lent', 'borrowed', 'repaid_to_me', 'repaid_by_me'] },
            amount: { type: 'number' },
            currency: { type: 'string', enum: ['BDT', 'AED'] },
            note: { type: 'string' },
            occurredAt: { type: 'string' },
          },
          required: ['personName', 'direction', 'amount'],
        },
      },
      conversationId: { type: 'string' },
    },
    required: ['entries'],
  },
  handler: async (input) => {
    try {
      const raw = Array.isArray(input.entries) ? input.entries : []
      if (raw.length < 2) return { success: false, error: 'entries must have at least 2 items' }

      const entries: LedgerEntryInput[] = raw.map((e) => {
        const row = e as Record<string, unknown>
        const amount = Math.round(Number(row.amount))
        if (amount <= 0) throw new Error('each amount must be positive')
        return {
          personName: String(row.personName),
          direction: String(row.direction),
          amount,
          currency: (row.currency as string) || 'BDT',
          note: row.note ? String(row.note) : null,
          occurredAt: row.occurredAt ? String(row.occurredAt) : new Date().toISOString(),
        }
      })

      const title = input.title ? String(input.title) : 'লেজার ব্যাচ'
      const summary = formatLedgerBatchSummary(title, entries)

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'log_ledger_entries_batch',
          payload: { title, entries },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, count: entries.length, message: 'One confirm card for all entries.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── log_expenses_batch ────────────────────────────────────────────────────────

const log_expenses_batch: AgentTool = {
  name: 'log_expenses_batch',
  description:
    'Logs MULTIPLE expenses in ONE confirm card. Use for 2+ expenses in one owner message. ' +
    'NEVER call log_expense repeatedly for a batch.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      entries: {
        type: 'array',
        minItems: 2,
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            currency: { type: 'string', enum: ['BDT', 'AED'] },
            category: { type: 'string' },
            note: { type: 'string' },
            occurredAt: { type: 'string' },
          },
          required: ['amount', 'note'],
        },
      },
      conversationId: { type: 'string' },
    },
    required: ['entries'],
  },
  handler: async (input) => {
    try {
      const raw = Array.isArray(input.entries) ? input.entries : []
      if (raw.length < 2) return { success: false, error: 'entries must have at least 2 items' }

      const entries: ExpenseEntryInput[] = raw.map((e) => {
        const row = e as Record<string, unknown>
        const amount = Math.round(Number(row.amount))
        if (amount <= 0) throw new Error('each amount must be positive')
        return {
          amount,
          currency: (row.currency as string) || 'BDT',
          category: row.category ? String(row.category) : null,
          note: String(row.note ?? 'খরচ'),
          occurredAt: row.occurredAt ? String(row.occurredAt) : new Date().toISOString(),
        }
      })

      const title = input.title ? String(input.title) : `খরচ — ${dhakaToday()}`
      const summary = formatExpenseBatchSummary(title, entries)

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'log_expenses_batch',
          payload: { title, entries },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, count: entries.length, message: 'One confirm card for all expenses.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const FINANCE_TOOLS: AgentTool[] = [
  log_expense,
  log_expenses_batch,
  log_ledger_entry,
  log_ledger_entries_batch,
  get_expense_summary,
  get_ledger_balances,
]

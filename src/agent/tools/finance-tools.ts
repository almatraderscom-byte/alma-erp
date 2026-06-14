/**
 * Phase 6E — Personal finance tools (+ delete/edit/list).
 */
import type { AgentTool } from './registry'
import {
  ACTIVE_FINANCE_FILTER,
  DIRECTION_BN,
  type ExpenseEntryInput,
  type LedgerEntryInput,
  financeDb,
  formatDhakaShort,
  formatEditSummary,
  formatExpenseBatchSummary,
  formatExpenseDeleteSummary,
  formatExpenseLineSummary,
  formatLedgerBatchSummary,
  formatLedgerDeleteSummary,
  formatLedgerLineSummary,
  formatAmount,
  ledgerEntrySign,
  formatDateTimeDhaka,
} from '@/agent/lib/finance-shared'

function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function pendingMeta(type: string, extra: Record<string, unknown> = {}) {
  const isBatch = type === 'log_ledger_entries_batch' || type === 'log_expenses_batch'
  return {
    actionType: type,
    isFinance: true,
    isBatch,
    entryCount: typeof extra.entryCount === 'number' ? extra.entryCount : undefined,
    ...extra,
  }
}

// ── log_expense ───────────────────────────────────────────────────────────────

const log_expense: AgentTool = {
  name: 'log_expense',
  description:
    'Logs a SINGLE personal expense (confirm card). For 2+ expenses use log_expenses_batch. ' +
    'REQUIRES explicit money signal (tk/টাকা/BDT/AED or দিসি/খরচ/ধার verbs) — NOT percentages, counts, or durations. ' +
    'Ambiguous currency → ask_user before calling. Fixes: list_recent_transactions → delete/edit_finance_entry.',
  input_schema: {
    type: 'object' as const,
    properties: {
      amount: { type: 'number' },
      currency: { type: 'string', enum: ['BDT', 'AED'] },
      category: { type: 'string' },
      note: { type: 'string' },
      occurredAt: { type: 'string' },
      conversationId: { type: 'string' },
    },
    required: ['amount', 'note'],
  },
  handler: async (input) => {
    try {
      const amount = Math.round(Number(input.amount))
      if (amount <= 0) return { success: false, error: 'amount must be positive' }
      const currency = (input.currency as string) || 'BDT'
      const note = String(input.note)
      const category = input.category ? String(input.category) : null
      const occurredAt = input.occurredAt ? new Date(String(input.occurredAt)) : new Date()
      const summary = formatExpenseLineSummary(amount, currency, note, category)

      const action = await financeDb.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'log_expense',
          payload: { amount, currency, category, note, occurredAt: occurredAt.toISOString() },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, ...pendingMeta('log_expense') },
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
    'Logs a SINGLE debt/lending entry (confirm card). For 2+ entries use log_ledger_entries_batch.',
  input_schema: {
    type: 'object' as const,
    properties: {
      personName: { type: 'string' },
      direction: { type: 'string', enum: ['lent', 'borrowed', 'repaid_to_me', 'repaid_by_me'] },
      amount: { type: 'number' },
      currency: { type: 'string', enum: ['BDT', 'AED'] },
      note: { type: 'string' },
      occurredAt: { type: 'string' },
      conversationId: { type: 'string' },
    },
    required: ['personName', 'direction', 'amount'],
  },
  handler: async (input) => {
    try {
      const amount = Math.round(Number(input.amount))
      if (amount <= 0) return { success: false, error: 'amount must be positive' }
      const personName = String(input.personName)
      const direction = String(input.direction)
      const currency = (input.currency as string) || 'BDT'
      const note = input.note ? String(input.note) : null
      const occurredAt = input.occurredAt ? new Date(String(input.occurredAt)) : new Date()
      const summary = formatLedgerLineSummary(personName, direction, amount, currency, note)

      const action = await financeDb.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'log_ledger_entry',
          payload: { personName, direction, amount, currency, note, occurredAt: occurredAt.toISOString() },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, ...pendingMeta('log_ledger_entry') },
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
      period: { type: 'string', enum: ['today', 'week', 'month', 'all'] },
      groupBy: { type: 'string', enum: ['category', 'currency', 'day'] },
      currency: { type: 'string', enum: ['BDT', 'AED'] },
    },
  },
  handler: async (input) => {
    try {
      const period = (input.period as string) || 'month'
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

      const where: Record<string, unknown> = { ...ACTIVE_FINANCE_FILTER }
      if (startDate) where.occurredAt = { gte: startDate }
      if (currency) where.currency = currency

      const rows = await financeDb.agentFinanceExpense.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: 200,
      })

      const totals: Record<string, number> = {}
      const grouped: Record<string, number> = {}
      for (const r of rows) {
        totals[r.currency] = (totals[r.currency] || 0) + r.amount
        const gKey = input.groupBy === 'category' ? `${r.currency}:${r.category || 'অন্যান্য'}`
          : input.groupBy === 'day' ? `${r.currency}:${r.occurredAt.toISOString().slice(0, 10)}`
            : r.currency
        grouped[gKey] = (grouped[gKey] || 0) + r.amount
      }

      return { success: true, data: { period, totals, grouped, recentCount: rows.length } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_ledger_balances ───────────────────────────────────────────────────────

type LedgerRow = {
  id: string
  direction: string
  amount: number
  currency: string
  note: string | null
  occurredAt: Date
}

function serializeLedgerEntries(rows: LedgerRow[], opts: { oldestFirst: boolean; maxEntries: number }) {
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
  const entries = display.map((r, index) => ({ serial: index + 1, ...r }))
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
    'Returns net balances per person and ledger transaction history. Positive = they owe you.',
  input_schema: {
    type: 'object' as const,
    properties: {
      person: { type: 'string' },
      currency: { type: 'string', enum: ['BDT', 'AED'] },
      order: { type: 'string', enum: ['oldest_first', 'newest_first'] },
      maxEntries: { type: 'number' },
    },
  },
  handler: async (input) => {
    try {
      const personFilter = input.person ? String(input.person).trim() : ''
      const oldestFirst = input.order !== 'newest_first'
      const maxPerPerson = personFilter
        ? Math.min(Math.max(Number(input.maxEntries ?? 500), 1), 2000)
        : Math.min(Math.max(Number(input.maxEntries ?? 5), 1), 50)

      const where: Record<string, unknown> = { ...ACTIVE_FINANCE_FILTER }
      if (personFilter) where.personName = { contains: personFilter, mode: 'insensitive' }
      if (input.currency) where.currency = String(input.currency)

      const rows = await financeDb.agentFinanceLedger.findMany({
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
        const serialized = serializeLedgerEntries(histories[personKey] || [], {
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
          recentEntries: serialized.entries.slice(-5),
        }
      })

      return {
        success: true,
        data: { balances: result, personFilter: personFilter || null, includesAllEntries: Boolean(personFilter) },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── batch tools ───────────────────────────────────────────────────────────────

const log_ledger_entries_batch: AgentTool = {
  name: 'log_ledger_entries_batch',
  description: 'Logs MULTIPLE ledger entries in ONE confirm card (2+ entries).',
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

      const action = await financeDb.agentPendingAction.create({
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
        data: {
          pendingActionId: action.id as string,
          summary,
          count: entries.length,
          ...pendingMeta('log_ledger_entries_batch', { entryCount: entries.length }),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const log_expenses_batch: AgentTool = {
  name: 'log_expenses_batch',
  description: 'Logs MULTIPLE expenses in ONE confirm card (2+ expenses).',
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

      const action = await financeDb.agentPendingAction.create({
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
        data: {
          pendingActionId: action.id as string,
          summary,
          count: entries.length,
          ...pendingMeta('log_expenses_batch', { entryCount: entries.length }),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── list_recent_transactions ──────────────────────────────────────────────────

const list_recent_transactions: AgentTool = {
  name: 'list_recent_transactions',
  description:
    'Lists recent finance transactions with numbers and IDs so owner can reference "5 নম্বরটা delete করো". ' +
    'Call this FIRST when owner wants to delete/fix/double-entry.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', enum: ['expense', 'ledger', 'all'], description: 'Filter type (default all)' },
      limit: { type: 'number', description: 'Max rows (default 10)' },
      person: { type: 'string', description: 'Filter ledger by person name' },
    },
  },
  handler: async (input) => {
    try {
      const filterType = (input.type as string) || 'all'
      const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 50)
      const person = input.person ? String(input.person).trim() : ''

      type Tx = {
        occurredAt: Date
        type: 'expense' | 'ledger'
        id: string
        label: string
        amount: number
        currency: string
        direction?: string
      }

      const txs: Tx[] = []

      if (filterType === 'all' || filterType === 'expense') {
        const expenses = await financeDb.agentFinanceExpense.findMany({
          where: ACTIVE_FINANCE_FILTER,
          orderBy: { occurredAt: 'desc' },
          take: limit,
        })
        for (const e of expenses) {
          txs.push({
            occurredAt: e.occurredAt,
            type: 'expense',
            id: e.id,
            label: e.note || e.category || 'খরচ',
            amount: e.amount,
            currency: e.currency,
          })
        }
      }

      if (filterType === 'all' || filterType === 'ledger') {
        const ledgerWhere: Record<string, unknown> = { ...ACTIVE_FINANCE_FILTER }
        if (person) ledgerWhere.personName = { contains: person, mode: 'insensitive' }
        const ledgers = await financeDb.agentFinanceLedger.findMany({
          where: ledgerWhere,
          orderBy: { occurredAt: 'desc' },
          take: limit,
        })
        for (const l of ledgers) {
          txs.push({
            occurredAt: l.occurredAt,
            type: 'ledger',
            id: l.id,
            label: l.personName,
            amount: l.amount,
            currency: l.currency,
            direction: l.direction,
          })
        }
      }

      txs.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      const sliced = txs.slice(0, limit)

      const transactions = sliced.map((t, i) => ({
        number: i + 1,
        type: t.type,
        id: t.id,
        date: t.occurredAt.toISOString().slice(0, 10),
        dateDhaka: formatDhakaShort(t.occurredAt),
        personOrCategory: t.label,
        amount: t.amount,
        currency: t.currency,
        direction: t.direction ?? null,
        directionLabel: t.direction ? (DIRECTION_BN[t.direction] ?? t.direction) : null,
        display: t.type === 'ledger'
          ? `#${i + 1} [ledger] ${t.id.slice(0, 8)} — ${formatDhakaShort(t.occurredAt)} — ${t.label} — ${formatAmount(t.amount, t.currency)} (${DIRECTION_BN[t.direction!]})`
          : `#${i + 1} [expense] ${t.id.slice(0, 8)} — ${formatDhakaShort(t.occurredAt)} — ${t.label} — ${formatAmount(t.amount, t.currency)}`,
      }))

      return { success: true, data: { transactions, count: transactions.length } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── delete_finance_entry ──────────────────────────────────────────────────────

const delete_finance_entry: AgentTool = {
  name: 'delete_finance_entry',
  description:
    'Soft-deletes a finance record (confirm card required). Use list_recent_transactions first to get id/number.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', enum: ['expense', 'ledger'] },
      id: { type: 'string', description: 'Record UUID from list_recent_transactions' },
      conversationId: { type: 'string' },
    },
    required: ['type', 'id'],
  },
  handler: async (input) => {
    try {
      const entryType = String(input.type) as 'expense' | 'ledger'
      const id = String(input.id)

      if (entryType === 'expense') {
        const row = await financeDb.agentFinanceExpense.findUnique({ where: { id } })
        if (!row || row.deleted) return { success: false, error: 'expense not found' }
        const summary = formatExpenseDeleteSummary(row)
        const action = await financeDb.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'delete_finance_entry',
            payload: { type: 'expense', id, snapshot: row },
            summary,
            costEstimate: 0,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: { pendingActionId: action.id as string, summary, ...pendingMeta('delete_finance_entry') },
        }
      }

      const row = await financeDb.agentFinanceLedger.findUnique({ where: { id } })
      if (!row || row.deleted) return { success: false, error: 'ledger entry not found' }
      const summary = formatLedgerDeleteSummary(row)
      const action = await financeDb.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'delete_finance_entry',
          payload: { type: 'ledger', id, personName: row.personName, snapshot: row },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, ...pendingMeta('delete_finance_entry') },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── edit_finance_entry ────────────────────────────────────────────────────────

const EDITABLE_LEDGER = new Set(['amount', 'currency', 'note', 'personName', 'direction'])
const EDITABLE_EXPENSE = new Set(['amount', 'currency', 'note', 'category'])

const edit_finance_entry: AgentTool = {
  name: 'edit_finance_entry',
  description:
    'Edits one field on an existing finance record (confirm card with before/after). ' +
    'Use list_recent_transactions to identify the record.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', enum: ['expense', 'ledger'] },
      id: { type: 'string' },
      field: { type: 'string', description: 'amount | currency | note | personName | category | direction' },
      newValue: { description: 'New value for the field' },
      conversationId: { type: 'string' },
    },
    required: ['type', 'id', 'field', 'newValue'],
  },
  handler: async (input) => {
    try {
      const entryType = String(input.type) as 'expense' | 'ledger'
      const id = String(input.id)
      const field = String(input.field)
      let newValue: unknown = input.newValue

      if (entryType === 'ledger') {
        if (!EDITABLE_LEDGER.has(field)) return { success: false, error: `cannot edit ledger field: ${field}` }
        const row = await financeDb.agentFinanceLedger.findUnique({ where: { id } })
        if (!row || row.deleted) return { success: false, error: 'ledger entry not found' }
        if (field === 'amount') newValue = Math.round(Number(newValue))
        if (field === 'direction' && !['lent', 'borrowed', 'repaid_to_me', 'repaid_by_me'].includes(String(newValue))) {
          return { success: false, error: 'invalid direction' }
        }
        const before = { ...row, amount: row.amount, personName: row.personName, direction: row.direction, currency: row.currency, note: row.note }
        const after = { ...before, [field]: newValue }
        const summary = formatEditSummary('ledger', before, after)
        const action = await financeDb.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'edit_finance_entry',
            payload: { type: 'ledger', id, field, newValue, before, after, personName: row.personName },
            summary,
            costEstimate: 0,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: { pendingActionId: action.id as string, summary, ...pendingMeta('edit_finance_entry') },
        }
      }

      if (!EDITABLE_EXPENSE.has(field)) return { success: false, error: `cannot edit expense field: ${field}` }
      const row = await financeDb.agentFinanceExpense.findUnique({ where: { id } })
      if (!row || row.deleted) return { success: false, error: 'expense not found' }
      if (field === 'amount') newValue = Math.round(Number(newValue))
      const before = { amount: row.amount, currency: row.currency, note: row.note, category: row.category }
      const after = { ...before, [field]: newValue }
      const summary = formatEditSummary('expense', before, after)
      const action = await financeDb.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'edit_finance_entry',
          payload: { type: 'expense', id, field, newValue, before, after },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, ...pendingMeta('edit_finance_entry') },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_financial_health: AgentTool = {
  name: 'get_financial_health',
  description:
    'CFO-style financial snapshot: revenue, expenses by category, ad spend & ROI caveats, gross/net profit, margin, ' +
    'WoW trends, per-product/channel breakdown, and flags (thin margin, rising costs, poor ad ROI). Use for financial questions, ' +
    '"business er financial obostha", profit/expense/ROI analysis. Says clearly if cost data is missing — never guesses margin.',
  input_schema: {
    type: 'object' as const,
    properties: {
      days: { type: 'number', description: 'Analysis window in days (default 30, max 90)' },
    },
  },
  handler: async (input) => {
    try {
      const days = Number(input.days ?? 30)
      const { analyzeFinancials } = await import('@/lib/financial-intelligence')
      const health = await analyzeFinancials({ days })
      return { success: true, data: health }
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
  list_recent_transactions,
  delete_finance_entry,
  edit_finance_entry,
  get_financial_health,
]

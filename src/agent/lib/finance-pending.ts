/**
 * Pending finance action helpers — rebuild summaries after edit/batch remove.
 */
import {
  type ExpenseEntryInput,
  type LedgerEntryInput,
  formatExpenseBatchSummary,
  formatExpenseLineSummary,
  formatLedgerBatchSummary,
  formatLedgerLineSummary,
  FINANCE_CONFIRM_TYPES,
} from '@/agent/lib/finance-shared'

export { FINANCE_CONFIRM_TYPES }

type PendingAction = {
  type: string
  payload: Record<string, unknown>
  summary: string
}

export function isFinanceConfirmType(type: string): boolean {
  return FINANCE_CONFIRM_TYPES.has(type)
}

export function getEntryCount(action: PendingAction): number {
  if (action.type === 'log_ledger_entries_batch' || action.type === 'log_expenses_batch') {
    const entries = action.payload.entries
    return Array.isArray(entries) ? entries.length : 0
  }
  return 0
}

export function rebuildFinanceSummary(action: PendingAction): string {
  const p = action.payload
  switch (action.type) {
    case 'log_ledger_entry': {
      const { personName, direction, amount, currency, note } = p as LedgerEntryInput & { amount: number }
      return formatLedgerLineSummary(
        String(personName),
        String(direction),
        Math.round(Number(amount)),
        String(currency || 'BDT'),
        note ? String(note) : null,
      )
    }
    case 'log_expense': {
      const { amount, currency, note, category } = p as ExpenseEntryInput & { amount: number }
      return formatExpenseLineSummary(
        Math.round(Number(amount)),
        String(currency || 'BDT'),
        String(note ?? 'খরচ'),
        category ? String(category) : null,
      )
    }
    case 'log_ledger_entries_batch': {
      const title = String(p.title || 'লেজার ব্যাচ')
      const entries = (p.entries as LedgerEntryInput[]) ?? []
      return formatLedgerBatchSummary(title, entries)
    }
    case 'log_expenses_batch': {
      const title = String(p.title || 'খরচ ব্যাচ')
      const entries = (p.expenses as ExpenseEntryInput[]) ?? (p.entries as ExpenseEntryInput[]) ?? []
      return formatExpenseBatchSummary(title, entries)
    }
    default:
      return action.summary
  }
}

const LEDGER_FIELDS = new Set(['amount', 'currency', 'note', 'personName', 'direction', 'occurredAt'])
const EXPENSE_FIELDS = new Set(['amount', 'currency', 'note', 'category', 'occurredAt'])

export function applyFinanceFieldEdit(
  action: PendingAction,
  field: string,
  value: unknown,
): { payload: Record<string, unknown>; summary: string } | { error: string } {
  const p = { ...action.payload }

  if (action.type === 'log_ledger_entry') {
    if (!LEDGER_FIELDS.has(field)) return { error: `ledger field not editable: ${field}` }
    if (field === 'amount') p.amount = Math.round(Number(value))
    else if (field === 'direction' && !['lent', 'borrowed', 'repaid_to_me', 'repaid_by_me'].includes(String(value))) {
      return { error: 'invalid direction' }
    } else p[field] = value
  } else if (action.type === 'log_expense') {
    if (!EXPENSE_FIELDS.has(field)) return { error: `expense field not editable: ${field}` }
    if (field === 'amount') p.amount = Math.round(Number(value))
    else p[field] = value
  } else if (action.type === 'log_ledger_entries_batch') {
    return { error: 'batch edit: use removeEntryIndex or edit via agent' }
  } else if (action.type === 'log_expenses_batch') {
    return { error: 'batch edit: use removeEntryIndex or edit via agent' }
  } else {
    return { error: 'action not editable' }
  }

  const updated = { ...action, payload: p }
  return { payload: p, summary: rebuildFinanceSummary(updated) }
}

export function removeBatchEntry(
  action: PendingAction,
  index: number,
): { payload: Record<string, unknown>; summary: string } | { error: string } {
  if (action.type !== 'log_ledger_entries_batch' && action.type !== 'log_expenses_batch') {
    return { error: 'not a batch action' }
  }
  const key = 'entries'
  const entries = [...((action.payload.entries as unknown[]) ?? [])]
  if (index < 0 || index >= entries.length) return { error: 'invalid index' }
  entries.splice(index, 1)
  if (entries.length < 1) return { error: 'batch cannot be empty — reject instead' }

  const p = { ...action.payload, entries }
  const updated: PendingAction =
    action.type === 'log_ledger_entries_batch'
      ? { ...action, payload: p }
      : { ...action, payload: p }

  if (action.type === 'log_ledger_entries_batch' && entries.length === 1) {
    const e = entries[0] as LedgerEntryInput
    return {
      payload: {
        personName: e.personName,
        direction: e.direction,
        amount: e.amount,
        currency: e.currency || 'BDT',
        note: e.note ?? null,
        occurredAt: e.occurredAt || new Date().toISOString(),
      },
      summary: formatLedgerLineSummary(
        e.personName,
        e.direction,
        e.amount,
        e.currency || 'BDT',
        e.note,
      ),
    }
  }

  if (action.type === 'log_expenses_batch' && entries.length === 1) {
    const e = entries[0] as ExpenseEntryInput
    return {
      payload: {
        amount: e.amount,
        currency: e.currency || 'BDT',
        category: e.category ?? null,
        note: e.note ?? 'খরচ',
        occurredAt: e.occurredAt || new Date().toISOString(),
      },
      summary: formatExpenseLineSummary(e.amount, e.currency || 'BDT', e.note ?? 'খরচ', e.category),
    }
  }

  return { payload: p, summary: rebuildFinanceSummary(updated) }
}

export function financeEditFieldsForType(type: string): string[] {
  if (type === 'log_ledger_entry') return ['amount', 'personName', 'direction', 'currency', 'note']
  if (type === 'log_expense') return ['amount', 'category', 'currency', 'note']
  return []
}

export const FINANCE_EDIT_FIELD_LABELS: Record<string, string> = {
  amount: '💰 পরিমাণ',
  personName: '👤 নাম',
  category: '📂 ক্যাটাগরি',
  direction: '↔️ দিক',
  currency: '💱 মুদ্রা',
  note: '📝 নোট',
}

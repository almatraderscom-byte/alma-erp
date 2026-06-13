/**
 * Shared finance helpers — balances, formatting, active-record filter.
 */
import { prisma } from '@/lib/prisma'
import { formatDateTimeDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const financeDb = prisma as any

export const ACTIVE_FINANCE_FILTER = { deleted: false }

export const DIRECTION_BN: Record<string, string> = {
  lent: 'ধার দিলেন',
  borrowed: 'ধার নিলেন',
  repaid_to_me: 'ফেরত পেলেন',
  repaid_by_me: 'ফেরত দিলেন',
}

export const FINANCE_CONFIRM_TYPES = new Set([
  'log_expense',
  'log_expenses_batch',
  'log_ledger_entry',
  'log_ledger_entries_batch',
  'delete_finance_entry',
  'edit_finance_entry',
])

export function ledgerEntrySign(direction: string): number {
  return (direction === 'lent' || direction === 'repaid_to_me') ? 1 : -1
}

export function formatDhakaShort(d: Date): string {
  return d.toLocaleDateString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
  })
}

export function currencySymbol(currency: string): string {
  return currency === 'AED' ? 'AED ' : '৳'
}

export function formatAmount(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${amount.toLocaleString('bn-BD')}`
}

type LedgerRow = {
  personName: string
  direction: string
  amount: number
  currency: string
}

export async function computeLedgerBalances(personFilter?: string) {
  const where: Record<string, unknown> = { ...ACTIVE_FINANCE_FILTER }
  if (personFilter?.trim()) {
    where.personName = { contains: personFilter.trim(), mode: 'insensitive' }
  }

  const rows: LedgerRow[] = await financeDb.agentFinanceLedger.findMany({
    where,
    select: { personName: true, direction: true, amount: true, currency: true },
  })

  const balances: Record<string, Record<string, number>> = {}
  const names: Record<string, string> = {}
  for (const r of rows) {
    const key = r.personName.toLowerCase()
    names[key] = r.personName
    if (!balances[key]) balances[key] = {}
    const sign = ledgerEntrySign(r.direction)
    balances[key][r.currency] = (balances[key][r.currency] || 0) + sign * r.amount
  }

  return Object.entries(balances).map(([key, bals]) => ({
    person: names[key] ?? key,
    balances: bals,
  }))
}

export async function getPersonBalance(personName: string) {
  const all = await computeLedgerBalances(personName)
  return all[0] ?? { person: personName, balances: {} as Record<string, number> }
}

export type LedgerEntryInput = {
  personName: string
  direction: string
  amount: number
  currency?: string
  note?: string | null
  occurredAt?: string
}

export type ExpenseEntryInput = {
  amount: number
  currency?: string
  category?: string | null
  note?: string
  occurredAt?: string
}

export function formatLedgerBatchSummary(title: string, entries: LedgerEntryInput[]): string {
  const totals: Record<string, number> = { BDT: 0, AED: 0 }
  const lines = entries.map((e, i) => {
    const currency = e.currency || 'BDT'
    const amount = Math.round(Number(e.amount))
    totals[currency] = (totals[currency] || 0) + amount
    const dir = DIRECTION_BN[e.direction] || e.direction
    const note = e.note ? ` — ${e.note}` : ''
    return `${i + 1}. ${e.personName} → ${formatAmount(amount, currency)} (${dir})${note}`
  })
  const totalLines = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([c, v]) => (c === 'AED' ? `মোট AED: ${v.toLocaleString('bn-BD')}` : `মোট BDT: ৳${v.toLocaleString('bn-BD')}`))
  return (
    `📋 ${entries.length}টি লেনদেন:\n\n` +
    lines.join('\n') +
    (totalLines.length ? `\n\n${totalLines.join('\n')}` : '')
  )
}

export function formatExpenseBatchSummary(title: string, entries: ExpenseEntryInput[]): string {
  const totals: Record<string, number> = { BDT: 0, AED: 0 }
  const lines = entries.map((e, i) => {
    const currency = e.currency || 'BDT'
    const amount = Math.round(Number(e.amount))
    totals[currency] = (totals[currency] || 0) + amount
    const cat = e.category ? ` (${e.category})` : ''
    return `${i + 1}. ${formatAmount(amount, currency)} — ${e.note ?? 'খরচ'}${cat}`
  })
  const totalLines = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([c, v]) => (c === 'AED' ? `মোট AED: ${v.toLocaleString('bn-BD')}` : `মোট BDT: ৳${v.toLocaleString('bn-BD')}`))
  return (
    `📋 ${entries.length}টি খরচ:\n\n` +
    lines.join('\n') +
    (totalLines.length ? `\n\n${totalLines.join('\n')}` : '')
  )
}

export function formatLedgerDeleteSummary(row: {
  personName: string
  direction: string
  amount: number
  currency: string
  occurredAt: Date
}): string {
  const dir = DIRECTION_BN[row.direction] || row.direction
  const date = formatDhakaShort(row.occurredAt)
  return `🗑️ মুছবেন? ${row.personName} — ${formatAmount(row.amount, row.currency)} (${dir}) — ${date}`
}

export function formatExpenseDeleteSummary(row: {
  amount: number
  currency: string
  note: string | null
  category: string | null
  occurredAt: Date
}): string {
  const date = formatDhakaShort(row.occurredAt)
  const label = row.note || row.category || 'খরচ'
  return `🗑️ মুছবেন? ${formatAmount(row.amount, row.currency)} — ${label} (${date})`
}

export function formatEditSummary(
  type: 'expense' | 'ledger',
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const lines: string[] = ['✏️ সংশোধন অনুমোদন:']
  for (const key of Object.keys(after)) {
    if (String(before[key]) !== String(after[key])) {
      lines.push(`  ${key}: ${before[key] ?? '—'} → ${after[key]}`)
    }
  }
  return lines.join('\n')
}

export async function getMonthlyExpensesByCategory() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const rows = await financeDb.agentFinanceExpense.findMany({
    where: { ...ACTIVE_FINANCE_FILTER, occurredAt: { gte: monthStart } },
    select: { amount: true, currency: true, category: true },
  })
  const grouped: Record<string, number> = {}
  for (const r of rows) {
    const key = `${r.currency}:${r.category || 'অন্যান্য'}`
    grouped[key] = (grouped[key] || 0) + r.amount
  }
  return grouped
}

export function formatLedgerLineSummary(personName: string, direction: string, amount: number, currency: string, note?: string | null) {
  const directionBn: Record<string, string> = {
    lent: `${personName}-কে ধার দিলেন`,
    borrowed: `${personName}-এর কাছ থেকে ধার নিলেন`,
    repaid_to_me: `${personName} ফেরত দিল`,
    repaid_by_me: `${personName}-কে ফেরত দিলেন`,
  }
  return `লেজার: ${formatAmount(amount, currency)} — ${directionBn[direction] || direction}${note ? ` (${note})` : ''}`
}

export function formatExpenseLineSummary(amount: number, currency: string, note: string, category?: string | null) {
  return `খরচ লগ: ${formatAmount(amount, currency)} — ${note}${category ? ` (${category})` : ''}`
}

export { formatDateTimeDhaka }

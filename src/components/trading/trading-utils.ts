import type { TradingAccount, TradingAccountStatus } from '@/types/trading'

export const TRADING_STATUS_OPTIONS: Array<{ label: string; value: TradingAccountStatus | 'ALL' }> = [
  { label: 'All status', value: 'ALL' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Paused', value: 'PAUSED' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Closed', value: 'CLOSED' },
]

export const EXPENSE_TYPES = ['Mobile purchase', 'Internet/MB', 'SIM', 'Travel', 'Device purchase', 'Banking charges', 'Misc operational']

export function n(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function money(value: unknown): string {
  return n(value).toLocaleString('en-BD', { maximumFractionDigits: 0 })
}

/** Shared auto-fit grid for trading KPI rows. */
export const TRADING_KPI_GRID =
  'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9.75rem),1fr))]'

export function signedClass(value: unknown): string {
  return n(value) >= 0 ? 'text-green-400' : 'text-red-400'
}

export function statusClass(status: string): string {
  if (status === 'ACTIVE') return 'text-green-300 border-green-400/30 bg-green-400/10'
  if (status === 'COMPLETED') return 'text-gold-lt border-gold-dim/40 bg-gold/10'
  if (status === 'PAUSED') return 'text-amber-300 border-amber-400/30 bg-amber-400/10'
  return 'text-zinc-400 border-border bg-white/[0.03]'
}

export function accountLabel(account: TradingAccount | undefined | null): string {
  if (!account) return 'Trading account'
  return account.binanceUid ? `${account.accountTitle} · ${account.binanceUid}` : account.accountTitle
}

import { BDT_SYMBOL, fmtNum, formatBDT } from '@/lib/currency'

const CRORE = 10_000_000
const LAKH = 100_000
const THOUSAND = 1_000

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function formatScaled(abs: number, divisor: number, maxDecimals: number): string {
  const scaled = abs / divisor
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return trimTrailingZeros(scaled.toFixed(Math.min(maxDecimals, decimals)))
}

/**
 * Compact number suffix for KPI cards (K / L / Cr).
 * Examples: 155500 → 1.55L · 15550 → 15.6K
 */
export function formatCompactNumber(amount: number, maxDecimals = 2): string {
  const n = Number(amount) || 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)

  if (abs >= CRORE) return `${sign}${formatScaled(abs, CRORE, maxDecimals)}Cr`
  if (abs >= LAKH) return `${sign}${formatScaled(abs, LAKH, maxDecimals)}L`
  if (abs >= THOUSAND) return `${sign}${formatScaled(abs, THOUSAND, maxDecimals)}K`
  return fmtNum(n, abs < 1 ? 2 : 0)
}

export function formatCompactBDT(amount: number): string {
  return `${BDT_SYMBOL}${formatCompactNumber(amount)}`
}

export function formatCompactUsdt(amount: number): string {
  const n = Number(amount) || 0
  const abs = Math.abs(n)
  if (abs >= CRORE) return `${formatScaled(abs, CRORE, 2)}Cr`
  if (abs >= LAKH) return `${formatScaled(abs, LAKH, 2)}L`
  if (abs >= THOUSAND) return `${formatScaled(abs, THOUSAND, 1)}K`
  return fmtNum(n, abs < 1 ? 2 : 0)
}

/** Full display string for tooltips / accessibility. */
export function formatFinancialTitle(
  amount: number,
  kind: 'currency' | 'number' | 'usdt' = 'currency',
): string {
  const n = Number(amount) || 0
  if (kind === 'usdt') return `${fmtNum(n)} USDT`
  if (kind === 'number') return fmtNum(n)
  return formatBDT(n)
}

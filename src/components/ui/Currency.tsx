'use client'

import {
  BDT_SYMBOL,
  MONEY_CLASS,
  fmtNum,
  splitBDT,
} from '@/lib/currency'
import { cn } from '@/lib/utils'

type MoneyProps = {
  amount: number
  className?: string
  decimals?: number
}

/** Renders ৳ with Noto/Hind for the symbol; en-IN grouped digits. */
export function Money({ amount, className, decimals }: MoneyProps) {
  return (
    <span className={cn(MONEY_CLASS, className)}>
      <span className="currency-symbol">{BDT_SYMBOL}</span>
      <span className="currency-amount">{fmtNum(amount, decimals)}</span>
    </span>
  )
}

/** Renders an existing formatBDT() / fmt() string with correct glyph fonts. */
export function BdtText({ value, className }: { value: string; className?: string }) {
  const parts = splitBDT(value)
  if (!parts) {
    return <span className={className}>{value}</span>
  }
  return (
    <span className={cn(MONEY_CLASS, className)}>
      <span className="currency-symbol">{parts.symbol}</span>
      <span className="currency-amount">{parts.amount}</span>
    </span>
  )
}

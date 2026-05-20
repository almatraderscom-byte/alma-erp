'use client'

import { memo } from 'react'
import { BdtText, Money } from '@/components/ui/Currency'
import { fmtNum } from '@/lib/currency'
import {
  formatCompactBDT,
  formatCompactNumber,
  formatCompactUsdt,
  formatFinancialTitle,
} from '@/lib/format-financial'
import { cn } from '@/lib/utils'

const KPI_VALUE_BASE =
  'kpi-value block min-w-0 max-w-full font-bold tracking-tight leading-tight tabular-nums break-words [overflow-wrap:anywhere]'

const KPI_VALUE_SIZE = 'text-[clamp(0.8125rem,0.55rem+1.1vw,1.375rem)]'

export type KpiValueKind = 'currency' | 'number' | 'usdt'

type ResponsiveKpiValueProps = {
  amount: number
  className?: string
  kind?: KpiValueKind
}

function renderByKind(amount: number, compact: boolean, kind: KpiValueKind, className?: string) {
  if (kind === 'currency') {
    return compact ? (
      <BdtText value={formatCompactBDT(amount)} className={className} />
    ) : (
      <Money amount={amount} className={className} />
    )
  }
  if (kind === 'usdt') {
    const text = compact ? formatCompactUsdt(amount) : fmtNum(amount)
    return <span className={className}>{text}</span>
  }
  const text = compact ? formatCompactNumber(amount) : fmtNum(amount)
  return <span className={className}>{text}</span>
}

export const ResponsiveKpiValue = memo(function ResponsiveKpiValue({
  amount,
  className,
  kind = 'currency',
}: ResponsiveKpiValueProps) {
  const title = formatFinancialTitle(amount, kind)
  const valueClass = cn(KPI_VALUE_BASE, KPI_VALUE_SIZE, className)

  return (
    <span className="block min-w-0 max-w-full" title={title}>
      <span className="kpi-value-full">{renderByKind(amount, false, kind, valueClass)}</span>
      <span className="kpi-value-compact">{renderByKind(amount, true, kind, valueClass)}</span>
    </span>
  )
})

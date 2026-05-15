'use client'
import type { CditPaymentStatus } from '@/types/cdit'
import { Money } from '@/components/ui'

const STATUS_COLOR: Record<CditPaymentStatus, string> = {
  Unpaid: 'bg-zinc-600',
  'Partial Paid': 'bg-amber-500',
  Paid: 'bg-emerald-500',
}

export function PaymentProgressBar({
  percentage,
  status,
}: {
  percentage: number
  status: CditPaymentStatus
}) {
  const pct = Math.min(100, Math.max(0, percentage))
  return (
    <div className="w-full">
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${STATUS_COLOR[status]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function PaymentStatusBadge({ status }: { status: CditPaymentStatus }) {
  const colors: Record<CditPaymentStatus, string> = {
    Unpaid: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30',
    'Partial Paid': 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    Paid: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  }
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${colors[status]}`}>
      {status}
    </span>
  )
}

export function FinanceSummaryRow({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: 'gold' | 'green' | 'amber' | 'red'
}) {
  const color = highlight === 'gold' ? 'text-gold'
    : highlight === 'green' ? 'text-emerald-400'
    : highlight === 'amber' ? 'text-amber-400'
    : highlight === 'red' ? 'text-red-400'
    : 'text-cream'
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <Money amount={value} className={`text-sm font-bold ${color}`} />
    </div>
  )
}

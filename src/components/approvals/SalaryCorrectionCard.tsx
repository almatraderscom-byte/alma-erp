'use client'

import { parseSalaryCorrectionPayload } from '@/types/salary-correction'
import { formatMoneyBDT } from '@/lib/money'
import { formatSalarySlipPeriodLabel } from '@/lib/salary-slip'

type Props = {
  payloadSnapshot: unknown
  reason: string
  requesterName?: string | null
  createdAt?: string
  businessName?: string | null
  priority?: string
  compact?: boolean
}

function formatDelta(delta: number) {
  const sign = delta >= 0 ? '+' : ''
  return `${sign}${formatMoneyBDT(Math.abs(delta))}`
}

export function SalaryCorrectionCard({
  payloadSnapshot,
  reason,
  requesterName,
  createdAt,
  businessName,
  priority,
  compact = false,
}: Props) {
  const payload = parseSalaryCorrectionPayload(payloadSnapshot)
  if (!payload) {
    return <p className="text-[11px] text-amber-300">Salary correction payload is incomplete.</p>
  }

  const current = Number(payload.currentAmount || 0)
  const proposed = Number(payload.proposedAmount || 0)
  const delta = proposed - current
  const reversals = payload.reversals || []

  if (compact) {
    return (
      <div className="space-y-1 text-[11px]">
        <p className="font-bold text-cream">
          {payload.employeeId} · {formatSalarySlipPeriodLabel(payload.periodYm)}
        </p>
        <p className="font-mono text-zinc-300">
          {formatMoneyBDT(current)} → {formatMoneyBDT(proposed)}{' '}
          <span className={delta >= 0 ? 'text-green-400' : 'text-red-400'}>({formatDelta(delta)})</span>
        </p>
        {reversals.length > 0 ? (
          <p className="text-zinc-500">{reversals.length} reversal{reversals.length === 1 ? '' : 's'}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-2xl border border-gold-dim/25 bg-black/25 p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold-lt">Salary correction</p>
        {priority ? (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${priority === 'HIGH' ? 'bg-amber-500/15 text-amber-300' : 'bg-zinc-800 text-zinc-400'}`}>
            {priority}
          </span>
        ) : null}
      </div>
      {businessName ? <p className="text-zinc-500">PAYROLL · {businessName}</p> : null}
      {createdAt ? <p className="text-zinc-600">{new Date(createdAt).toLocaleString()}</p> : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <InfoRow label="Employee" value={`${payload.requestedByName || payload.employeeId}`} />
        <InfoRow label="Employee ID" value={payload.employeeId} mono />
        <InfoRow label="Period" value={formatSalarySlipPeriodLabel(payload.periodYm)} />
        <InfoRow label="Accrual entry" value={payload.accrualEntryId.slice(0, 12) + '…'} mono />
      </div>

      <div className="rounded-xl border border-border bg-black/30 p-3 space-y-2 font-mono">
        <div className="flex justify-between gap-3">
          <span className="text-zinc-500">Current accrual</span>
          <span className="text-cream">{formatMoneyBDT(current)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-zinc-500">Proposed amount</span>
          <span className="text-gold-lt font-bold">{formatMoneyBDT(proposed)}</span>
        </div>
        <div className="flex justify-between gap-3 border-t border-border/60 pt-2">
          <span className="text-zinc-500">Change</span>
          <span className={delta >= 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>{formatDelta(delta)}</span>
        </div>
      </div>

      {reversals.length > 0 ? (
        <div>
          <p className="text-[10px] font-black uppercase tracking-wide text-zinc-600 mb-2">
            Reversals ({reversals.length})
          </p>
          <ul className="space-y-2">
            {reversals.map((rev, i) => (
              <li key={`${rev.ledgerEntryId}-${i}`} className="rounded-lg border border-border/70 bg-black/20 px-3 py-2">
                <p className={`font-mono font-bold ${rev.amount >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {rev.amount >= 0 ? '+' : ''}
                  {formatMoneyBDT(Math.abs(rev.amount))}
                </p>
                <p className="mt-1 text-zinc-500">{rev.reason}</p>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-600">Entry {rev.ledgerEntryId.slice(0, 10)}…</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-black/20 p-3">
        <p className="text-[10px] font-black uppercase tracking-wide text-zinc-600">Reason</p>
        <p className="mt-1 text-cream leading-relaxed">{reason || payload.requestedReason}</p>
      </div>

      {requesterName || createdAt ? (
        <p className="text-[11px] text-zinc-500">
          Requested by {requesterName || '—'}
          {createdAt ? ` · ${new Date(createdAt).toLocaleString()}` : ''}
        </p>
      ) : null}
    </div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-black uppercase tracking-wide text-zinc-600">{label}</p>
      <p className={`mt-0.5 font-bold text-cream ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</p>
    </div>
  )
}

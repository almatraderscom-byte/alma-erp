'use client'

import { Button } from '@/components/ui'

export type PenaltyWaiverView = {
  id: string
  status: string
  statusLabel?: string
  requestType?: string
  originalPenaltyAmount: number
  requestedReductionAmount: number | null
  approvedReductionAmount: number | null
  finalAppliedPenalty?: number
  reason: string
  hasAttachment?: boolean
  adminNote?: string | null
  createdAt: string
}

type Props = {
  penaltyAmount: number
  lateMinutes: number
  waivers: PenaltyWaiverView[]
  onRequestReview: () => void
  onCancelPending?: (waiverId: string) => void
  cancelling?: boolean
}

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  PARTIALLY_APPROVED: 'text-green-300 border-green-500/30 bg-green-500/10',
  APPROVED: 'text-green-300 border-green-500/30 bg-green-500/10',
  FULLY_APPROVED: 'text-green-300 border-green-500/30 bg-green-500/10',
  REJECTED: 'text-red-300 border-red-500/30 bg-red-500/10',
  CANCELLED: 'text-zinc-400 border-border bg-black/20',
}

export function PenaltyAppealStatus({
  penaltyAmount,
  lateMinutes,
  waivers,
  onRequestReview,
  onCancelPending,
  cancelling,
}: Props) {
  if (penaltyAmount <= 0) return null

  const list = Array.isArray(waivers) ? waivers : []
  const active = list.find(w => w.status === 'PENDING') || list[0]
  const canRequest = !list.some(w => w.status === 'PENDING')

  return (
    <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-red-300">Late penalty</p>
          <p className="mt-1 text-lg font-bold text-cream">{money(penaltyAmount)}</p>
          <p className="text-[11px] text-zinc-500">Late by {lateMinutes} minutes · deducted from wallet</p>
        </div>
        {canRequest && (
          <Button variant="gold" size="sm" className="min-h-[44px] touch-manipulation shrink-0" onClick={onRequestReview}>
            Request review
          </Button>
        )}
      </div>

      {active && (
        <div className={`rounded-xl border px-3 py-2.5 text-[11px] ${STATUS_STYLE[active.statusLabel || active.status] || STATUS_STYLE.PENDING}`}>
          <p className="font-bold">
            Review {labelStatus(active.statusLabel || active.status)}
            {active.requestType ? ` · ${labelRequestType(active.requestType)}` : ''}
          </p>
          {active.status === 'PENDING' && (
            <p className="mt-1 opacity-90">Waiting for admin review. You asked to reduce {money(active.requestedReductionAmount ?? active.originalPenaltyAmount)}.</p>
          )}
          {(active.status === 'APPROVED' || active.status === 'PARTIALLY_APPROVED') && (
            <p className="mt-1 opacity-90">
              Approved reduction {money(active.approvedReductionAmount)} · final penalty {money(active.finalAppliedPenalty ?? 0)}
            </p>
          )}
          {active.status === 'REJECTED' && (
            <p className="mt-1 opacity-90">Request rejected — full penalty remains.</p>
          )}
          {active.adminNote && <p className="mt-1 text-zinc-400">Admin: {active.adminNote}</p>}
          {active.status === 'PENDING' && onCancelPending && (
            <Button
              size="xs"
              variant="secondary"
              className="mt-2"
              disabled={cancelling}
              onClick={() => onCancelPending(active.id)}
            >
              {cancelling ? 'Cancelling…' : 'Cancel request'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function money(value: unknown) {
  return `৳ ${Number(value || 0).toLocaleString('en-BD')}`
}

function labelStatus(s: string) {
  if (s === 'FULLY_APPROVED' || s === 'APPROVED') return 'fully approved'
  if (s === 'PARTIALLY_APPROVED') return 'partially approved'
  return s.toLowerCase().replace(/_/g, ' ')
}

function labelRequestType(t: string) {
  return t.replace(/_/g, ' ').toLowerCase()
}

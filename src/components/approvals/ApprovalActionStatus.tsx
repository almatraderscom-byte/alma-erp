'use client'

import { Spinner } from '@/components/ui'
import type { ApprovalRowUiState } from '@/lib/approval-action-tracker'

export function ApprovalProcessingBanner({
  count,
  message,
}: {
  count: number
  message?: string
}) {
  if (count <= 0) return null
  return (
    <div
      className="sticky top-0 z-20 flex items-center gap-3 rounded-2xl border border-gold-dim/40 bg-gold/10 px-4 py-3 shadow-lg backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <Spinner />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black text-gold-lt">
          {count === 1 ? 'Processing approval…' : `Processing ${count} approvals…`}
        </p>
        <p className="mt-0.5 text-xs text-zinc-400">
          {message || 'Do not close this tab until the transaction finishes. Buttons are locked to prevent duplicates.'}
        </p>
      </div>
    </div>
  )
}

export function ApprovalRowProcessingBadge({ ui }: { ui: ApprovalRowUiState }) {
  if (ui.state === 'idle') return null

  const tone =
    ui.state === 'processing'
      ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
      : ui.state === 'committed'
        ? 'border-green-500/35 bg-green-500/10 text-green-300'
        : ui.state === 'rolled_back'
          ? 'border-zinc-500/40 bg-zinc-700/30 text-zinc-300'
          : ui.state === 'failed'
            ? 'border-red-500/40 bg-red-500/10 text-red-300'
            : 'border-zinc-600 bg-zinc-800/40 text-zinc-400'

  return (
    <div className={`mt-2 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[10px] font-bold ${tone}`}>
      {ui.state === 'processing' && <Spinner />}
      <span>{ui.message || ui.state.replace(/_/g, ' ')}</span>
    </div>
  )
}

export function approvalRowLockClass(ui: ApprovalRowUiState) {
  if (ui.state === 'processing') {
    return 'pointer-events-none opacity-80 ring-2 ring-amber-500/30 ring-inset'
  }
  if (ui.state === 'failed') {
    return 'ring-1 ring-red-500/25 ring-inset'
  }
  return ''
}

'use client'

import { useEffect, useId, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { Button, Card } from '@/components/ui'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'

export type PenaltyAppealTarget = {
  attendanceRecordId: string
  penaltyAmount: number
  lateMinutes: number
  attendanceDate?: string
}

type Props = {
  open: boolean
  businessId: string
  target: PenaltyAppealTarget | null
  onClose: () => void
  onSubmitted: () => void
}

const REQUEST_TYPES = [
  { id: 'FULL_WAIVE', label: 'Full waive', hint: 'Remove the entire penalty' },
  { id: 'PARTIAL_REDUCE', label: 'Partial reduction', hint: 'Ask to reduce part of the amount' },
  { id: 'RECONSIDERATION', label: 'Reconsideration', hint: 'Explain circumstances for review' },
] as const

export function PenaltyAppealModal({ open, businessId, target, onClose, onSubmitted }: Props) {
  const fileInputId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [requestType, setRequestType] = useState<(typeof REQUEST_TYPES)[number]['id']>('FULL_WAIVE')
  const [reason, setReason] = useState('')
  const [partialAmount, setPartialAmount] = useState('')
  const [attachment, setAttachment] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setRequestType('FULL_WAIVE')
    setReason('')
    setPartialAmount('')
    setAttachment(null)
  }, [open, target?.attendanceRecordId])

  if (!open || !target) return null

  const penalty = target.penaltyAmount

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (reason.trim().length < 3) {
      toast.error('Please explain why you are requesting a review.')
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        business_id: businessId,
        attendance_record_id: target!.attendanceRecordId,
        reason: reason.trim(),
        request_type: requestType,
        attachment_data_url: attachment || undefined,
      }
      if (requestType === 'PARTIAL_REDUCE') {
        body.requested_reduction_amount = Number(partialAmount || 0)
      }
      const result = await safeFetchJsonWithToast('/api/attendance/waivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Penalty review request submitted')
      onSubmitted()
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Use an image file (JPG, PNG, WEBP)')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setAttachment(String(reader.result || ''))
    reader.onerror = () => toast.error('Could not read file')
    reader.readAsDataURL(file)
  }

  return (
    <MobileModalPortal open zIndex={95} onBackdropClick={onClose}>
      <Card className="mobile-modal-shell w-full max-w-lg border-gold-dim/35 sm:rounded-2xl">
        <div className="mobile-modal-header p-5 pb-3">
          <div className="flex justify-between items-start gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gold">Request review</p>
              <h3 className="mt-1 text-lg font-bold text-cream">Penalty appeal</h3>
              <p className="mt-1 text-xs text-zinc-500">
                Late {target.lateMinutes}m · penalty {money(penalty)}
                {target.attendanceDate ? ` · ${target.attendanceDate.slice(0, 10)}` : ''}
              </p>
            </div>
            <button type="button" className="text-zinc-500 hover:text-cream text-xl leading-none" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="mobile-modal-body space-y-4 px-5 pb-4">
          <div className="grid gap-2">
            {REQUEST_TYPES.map(opt => (
              <label
                key={opt.id}
                className={`flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors ${
                  requestType === opt.id ? 'border-gold-dim/50 bg-gold/10' : 'border-border bg-black/[0.03]'
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="requestType"
                    checked={requestType === opt.id}
                    onChange={() => setRequestType(opt.id)}
                    className="accent-gold"
                  />
                  <span className="text-sm font-semibold text-cream">{opt.label}</span>
                </span>
                <span className="mt-0.5 pl-6 text-[10px] text-zinc-500">{opt.hint}</span>
              </label>
            ))}
          </div>

          {requestType === 'PARTIAL_REDUCE' && (
            <label className="block space-y-1 text-[11px]">
              <span className="text-zinc-500">Amount to reduce (max {money(penalty)})</span>
              <input
                type="number"
                min={1}
                max={penalty}
                step={1}
                value={partialAmount}
                onChange={e => setPartialAmount(e.target.value)}
                className="w-full rounded-xl border border-border bg-black/[0.03] px-3 py-2.5 font-mono text-cream"
                placeholder={String(Math.round(penalty / 2))}
              />
            </label>
          )}

          <label className="block space-y-1 text-[11px]">
            <span className="text-zinc-500">Explanation</span>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={4}
              maxLength={1200}
              placeholder="Traffic, emergency, approved delay, transport issue..."
              className="w-full rounded-xl border border-border bg-black/[0.03] px-3 py-2.5 text-sm text-cream"
            />
          </label>

          <div className="space-y-2">
            <input
              id={fileInputId}
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="sr-only"
              onChange={e => {
                onFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <Button type="button" variant="secondary" size="sm" className="w-full min-h-[44px] touch-manipulation" onClick={() => fileRef.current?.click()}>
              {attachment ? '📎 Screenshot attached' : '📎 Add screenshot (optional)'}
            </Button>
          </div>
          </div>

          <div className="mobile-modal-footer px-5 pt-3">
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="gold" size="sm" disabled={busy} className="min-h-[44px] touch-manipulation">
                {busy ? 'Submitting…' : 'Submit request'}
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </MobileModalPortal>
  )
}

function money(value: number) {
  return `৳ ${Number(value || 0).toLocaleString('en-BD')}`
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { captureFaceFromFile } from '@/lib/attendance-face-client'
import { Button, Spinner } from '@/components/ui'

type Props = {
  businessId: string
  attendanceRecordId: string
  open: boolean
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

type Phase = 'capture' | 'confirm' | 'success'

export function SelfieVerificationModal({
  businessId,
  attendanceRecordId,
  open,
  onClose,
  onSuccess,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmAnchorRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<Phase>('capture')
  const [processingPhoto, setProcessingPhoto] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ imageDataUrl: string } | null>(null)
  const [nudgeConfirm, setNudgeConfirm] = useState(false)

  useEffect(() => setMounted(true), [])

  const resetState = useCallback(() => {
    setPhase('capture')
    setProcessingPhoto(false)
    setSubmitting(false)
    setPreview(null)
    setCapture(null)
    setNudgeConfirm(false)
  }, [])

  useEffect(() => {
    if (!open) return
    resetState()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, resetState, submitting])

  useEffect(() => {
    if (!open || phase !== 'confirm' || !capture) return
    setNudgeConfirm(false)
    const scrollTimer = window.setTimeout(() => {
      confirmAnchorRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    }, 120)
    const nudgeTimer = window.setTimeout(() => setNudgeConfirm(true), 8_000)
    return () => {
      window.clearTimeout(scrollTimer)
      window.clearTimeout(nudgeTimer)
    }
  }, [open, phase, capture])

  if (!mounted || !open) return null

  async function handleFile(file: File | undefined) {
    if (!file || processingPhoto || submitting) return
    setProcessingPhoto(true)
    setNudgeConfirm(false)
    try {
      const result = await captureFaceFromFile(file)
      setPreview(result.imageDataUrl)
      setCapture({ imageDataUrl: result.imageDataUrl })
      setPhase('confirm')
    } catch (e) {
      toast.error((e as Error).message)
      setPreview(null)
      setCapture(null)
      setPhase('capture')
    } finally {
      setProcessingPhoto(false)
    }
  }

  async function submitVerification() {
    if (!capture || submitting) {
      if (!capture) toast.error('Take a front-camera photo first')
      return
    }
    setSubmitting(true)
    setNudgeConfirm(false)
    try {
      const res = await fetch('/api/attendance/selfies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          attendance_record_id: attendanceRecordId,
          image_data_url: capture.imageDataUrl,
          content_type: 'image/jpeg',
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(String(j.error || 'Could not upload verification photo'))

      setPhase('success')
      toast.success('Verification submitted')
      await onSuccess()
      window.setTimeout(() => {
        resetState()
        onClose()
      }, 1_600)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const busy = processingPhoto || submitting

  return createPortal(
    <div
      className="fixed inset-0 z-[10050] flex flex-col justify-end overflow-hidden sm:justify-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="selfie-verify-title"
    >
      <button
        type="button"
        aria-label="Close verification"
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        disabled={submitting}
        onClick={() => {
          if (!submitting) {
            resetState()
            onClose()
          }
        }}
      />

      <div className="mobile-sheet relative z-[10051] mx-auto flex w-full max-w-md max-h-[min(100dvh,100svh)] flex-col overflow-hidden rounded-t-[28px] border border-gold-dim/30 bg-surface shadow-2xl sm:max-h-[90dvh] sm:rounded-2xl">
        <div className="safe-top shrink-0 border-b border-border px-4 pb-3 pt-4">
          <p id="selfie-verify-title" className="text-base font-black text-cream">
            {phase === 'success' ? '🟢 Verification submitted' : '📸 Complete face verification'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {phase === 'success'
              ? 'Your photo was saved. Admin will review it shortly.'
              : 'Admin requested verification. Use your front camera — attendance is already recorded.'}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {phase === 'success' ? (
            <div className="flex flex-col items-center py-6 text-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/15 text-4xl ring-2 ring-green-400/40">
                ✓
              </div>
              <p className="mt-4 text-lg font-black text-green-300">Verification submitted</p>
              <p className="mt-2 text-sm text-zinc-400">You can continue working while admin reviews.</p>
            </div>
          ) : processingPhoto ? (
            <div className="flex h-44 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-black/30">
              <Spinner />
              <p className="text-xs font-bold text-zinc-400">Processing photo…</p>
            </div>
          ) : preview ? (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-2xl border border-gold-dim/25 bg-black/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview}
                  alt="Verification preview"
                  className="mx-auto max-h-[min(42vh,280px)] w-full object-contain"
                />
              </div>
              <p className="text-center text-xs font-bold text-gold-lt">Photo ready — submit below</p>
              {nudgeConfirm && (
                <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-xs font-bold text-amber-200">
                  ⚠ Tap Submit verification at the bottom
                </p>
              )}
            </div>
          ) : (
            <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-700 bg-black/30 px-4 text-center">
              <span className="text-3xl opacity-60">📷</span>
              <p className="text-xs font-bold text-zinc-500">Front camera required</p>
              <p className="text-[11px] text-zinc-600">After capture, review your photo and submit</p>
            </div>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="user"
          className="hidden"
          disabled={busy}
          onChange={e => void handleFile(e.target.files?.[0])}
        />

        <footer className="shrink-0 border-t border-border bg-surface/98 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-md">
          {phase === 'success' ? (
            <Button variant="gold" className="h-[52px] w-full justify-center text-base font-black" disabled>
              Done
            </Button>
          ) : phase === 'confirm' && capture ? (
            <div className="grid gap-2">
              <div ref={confirmAnchorRef}>
                <Button
                  variant="gold"
                  className={`h-[56px] w-full justify-center gap-2 text-base font-black shadow-lg shadow-gold/20 ${nudgeConfirm ? 'gold-pulse' : ''}`}
                  disabled={busy}
                  onClick={() => void submitVerification()}
                >
                  {submitting ? (
                    <>
                      <Spinner />
                      Submitting…
                    </>
                  ) : (
                    '✅ Submit verification'
                  )}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11 w-full justify-center text-xs"
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                >
                  Retake
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 w-full justify-center text-xs"
                  disabled={submitting}
                  onClick={() => {
                    resetState()
                    onClose()
                  }}
                >
                  Later
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Button
                variant="gold"
                className="h-[56px] w-full justify-center text-base font-black"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {processingPhoto ? (
                  <>
                    <Spinner />
                    Opening camera…
                  </>
                ) : (
                  'Open front camera'
                )}
              </Button>
              <Button
                variant="ghost"
                className="h-11 w-full justify-center"
                disabled={submitting}
                onClick={() => {
                  resetState()
                  onClose()
                }}
              >
                Later
              </Button>
            </div>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

export function needsSelfieVerification(record: {
  verificationRequired?: boolean
  selfieCount?: number
} | null | undefined) {
  return Boolean(record?.verificationRequired && (record.selfieCount ?? 0) === 0)
}

export function selfieVerificationPending(record: {
  verificationRequired?: boolean
  selfieCount?: number
} | null | undefined) {
  return Boolean((record?.selfieCount ?? 0) > 0 && record?.verificationRequired)
}

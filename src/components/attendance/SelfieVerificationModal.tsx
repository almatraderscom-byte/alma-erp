'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import toast from 'react-hot-toast'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { captureFaceFromFile } from '@/lib/attendance-face-client'
import { logEvent } from '@/lib/logger'
import { Button, Spinner } from '@/components/ui'

type Props = {
  businessId: string
  attendanceRecordId: string
  open: boolean
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

type Phase = 'capture' | 'confirm' | 'success'

// ─── Structured capture logging ─────────────────────────────────────────────

function deviceHints() {
  if (typeof navigator === 'undefined') return {}
  const ua = navigator.userAgent
  const ios = /iphone|ipad|ipod/i.test(ua)
  const safari = ios && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua)
  const pwa =
    typeof window !== 'undefined'
    && (window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
  return { ios, safari, pwa }
}

function logCapture(
  event:
    | 'attendance.capture.created'
    | 'attendance.capture.persisted'
    | 'attendance.capture.cleared'
    | 'attendance.capture.remounted'
    | 'attendance.capture.retry'
    | 'attendance.checkin.capture_created',
  meta: Record<string, unknown>,
) {
  logEvent('info', event, { ...deviceHints(), ...meta })
}

// ─── Component ───────────────────────────────────────────────────────────────

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

  // Stable refs for callbacks that change on parent re-renders.
  // Using refs prevents the keyboard/overflow effects from re-running and
  // accidentally calling resetState() when the parent re-renders with a new
  // onClose reference (e.g. after a silent attendance refresh on iOS visibilitychange).
  const onCloseRef = useRef(onClose)
  const onSuccessRef = useRef(onSuccess)
  const submittingRef = useRef(submitting)
  const captureRef = useRef(capture)
  onCloseRef.current = onClose
  onSuccessRef.current = onSuccess
  submittingRef.current = submitting
  captureRef.current = capture

  // Mount ID for remount detection logging
  const mountIdRef = useRef<string>('')
  if (!mountIdRef.current) {
    mountIdRef.current = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `m_${Math.random().toString(36).slice(2)}_${Date.now()}`
  }

  useEffect(() => setMounted(true), [])

  const resetState = useCallback(() => {
    setPhase('capture')
    setProcessingPhoto(false)
    setSubmitting(false)
    setPreview(null)
    setCapture(null)
    setNudgeConfirm(false)
  }, [])

  // Log remounts so we can detect unexpected parent-driven remounts in production.
  useEffect(() => {
    logCapture('attendance.capture.remounted', {
      component: 'SelfieVerificationModal',
      mountId: mountIdRef.current,
      businessId,
      attendanceRecordId,
    })
    return () => {
      // If capture is still held on unmount and we haven't persisted, log a warning.
      if (captureRef.current) {
        logCapture('attendance.capture.cleared', {
          component: 'SelfieVerificationModal',
          mountId: mountIdRef.current,
          reason: 'component_unmount_with_capture',
          businessId,
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard handler — reads onClose/submitting from refs so it NEVER triggers
  // a resetState() due to a parent re-render producing a new onClose reference.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submittingRef.current) onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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
      logCapture('attendance.checkin.capture_created', {
        component: 'SelfieVerificationModal',
        mountId: mountIdRef.current,
      })
      logCapture('attendance.capture.created', {
        component: 'SelfieVerificationModal',
        mountId: mountIdRef.current,
        businessId,
        attendanceRecordId,
      })
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
    // Read capture from ref to survive any render between capture and submit.
    const activeCapture = captureRef.current
    if (!activeCapture || submitting) {
      if (!activeCapture) toast.error('Take a front-camera photo first')
      return
    }
    setSubmitting(true)
    setNudgeConfirm(false)
    try {
      const result = await safeFetchJsonWithToast('/api/attendance/selfies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          attendance_record_id: attendanceRecordId,
          image_data_url: activeCapture.imageDataUrl,
          content_type: 'image/jpeg',
        }),
      })
      if (!result.ok) throw new Error(result.error.message)

      logCapture('attendance.capture.persisted', {
        component: 'SelfieVerificationModal',
        mountId: mountIdRef.current,
        businessId,
        attendanceRecordId,
      })
      setPhase('success')
      toast.success('Verification submitted')
      try {
        await onSuccessRef.current()
      } catch {
        // refresh failing must not interfere with success display
      }
      window.setTimeout(() => {
        resetState()
        onCloseRef.current()
      }, 1_600)
    } catch (e) {
      logCapture('attendance.capture.retry', {
        component: 'SelfieVerificationModal',
        mountId: mountIdRef.current,
        businessId,
        attendanceRecordId,
        error: (e as Error).message,
      })
      toast.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const busy = processingPhoto || submitting

  return (
    <MobileModalPortal
      open
      zIndex={10050}
      backdropClassName="bg-black/80"
      aria-label="Face verification"
      onBackdropClick={() => {
        if (!submitting) {
          resetState()
          onClose()
        }
      }}
    >
      <div className="mobile-modal-shell mobile-sheet mx-auto w-full max-w-md rounded-t-[28px] border border-gold-dim/30 bg-surface shadow-2xl sm:rounded-2xl">
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

        <div className="mobile-modal-body px-4 py-3">
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
                  data-attendance-photo="true"
                  data-private="true"
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

        <footer className="mobile-modal-footer px-4 pt-3">
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
    </MobileModalPortal>
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

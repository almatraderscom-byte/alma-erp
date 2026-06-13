'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import toast from 'react-hot-toast'
import { captureFaceFromFile, mapCheckInError } from '@/lib/attendance-face-client'
import { logAttendanceClientFailure, logAttendanceClientSuccess } from '@/lib/attendance-client'
import { logAttendanceMobileSubmitFailed } from '@/lib/mobile-runtime-log'
import { logEvent } from '@/lib/logger'
import { safeFetchJson } from '@/lib/safe-fetch'
import { Button, Spinner } from '@/components/ui'

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

const CHECKIN_TIMEOUT_MS = 55_000

type Props = {
  businessId: string
  open: boolean
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

type Phase = 'capture' | 'confirm' | 'success' | 'error'

type CheckInPayload = {
  record?: { id?: string; employeeId?: string; checkInAt?: string }
  duplicate?: boolean
  requestId?: string
}

export function FaceVerificationCheckIn({ businessId, open, onClose, onSuccess }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmAnchorRef = useRef<HTMLDivElement>(null)
  const inFlightRef = useRef<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<Phase>('capture')
  const [processingPhoto, setProcessingPhoto] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ imageDataUrl: string; thumbDataUrl: string } | null>(null)
  const [nudgeConfirm, setNudgeConfirm] = useState(false)
  const [successAt, setSuccessAt] = useState<string | null>(null)
  const [employeeName, setEmployeeName] = useState<string | null>(null)

  // Stable refs for callbacks that change on parent re-renders.
  // Prevents the keyboard/overflow effects from re-running (and accidentally
  // calling resetState()) when the parent re-renders with a new onClose/onSuccess
  // reference — which happens every time attendance refreshes after iOS
  // visibilitychange fires on camera open/close.
  const onCloseRef = useRef(onClose)
  const onSuccessRef = useRef(onSuccess)
  const submittingRef = useRef(submitting)
  const captureRef = useRef(capture)
  onCloseRef.current = onClose
  onSuccessRef.current = onSuccess
  submittingRef.current = submitting
  captureRef.current = capture

  // Mount ID so we can correlate logs across remounts.
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
    setSubmitError(null)
    setGpsError(null)
    setPreview(null)
    setCapture(null)
    setNudgeConfirm(false)
    setSuccessAt(null)
    setEmployeeName(null)
    inFlightRef.current = null
  }, [])

  // Log remounts to detect unexpected parent-driven remounts in production.
  useEffect(() => {
    logCapture('attendance.capture.remounted', {
      component: 'FaceVerificationCheckIn',
      mountId: mountIdRef.current,
      businessId,
    })
    return () => {
      if (captureRef.current) {
        logCapture('attendance.capture.cleared', {
          component: 'FaceVerificationCheckIn',
          mountId: mountIdRef.current,
          reason: 'component_unmount_with_capture',
          businessId,
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard handler — reads onClose/submitting from refs to avoid adding them
  // as reactive deps; that would re-run this effect (and previously resetState)
  // on every parent render that produces a new onClose arrow function.
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

  const submitCheckIn = useCallback(
    async (isRetry = false) => {
      // Read capture from ref — survives any re-render between capture and submit.
      const activeCapture = captureRef.current
      if (!open || !activeCapture) {
        if (!activeCapture) toast.error('Take a front-camera photo first')
        return
      }
      if (inFlightRef.current) {
        logAttendanceClientFailure('attendance.checkin.client_failed', {
          businessId,
          reason: 'duplicate_submit_blocked',
        })
        return
      }

      const requestId = crypto.randomUUID()
      inFlightRef.current = requestId
      setSubmitting(true)
      setSubmitError(null)
    setGpsError(null)
      setNudgeConfirm(false)

      if (isRetry) {
        logCapture('attendance.capture.retry', {
          component: 'FaceVerificationCheckIn',
          mountId: mountIdRef.current,
          businessId,
          requestId,
        })
        logAttendanceClientFailure('attendance.checkin.retry_triggered', { businessId, requestId })
      }

      const started = Date.now()
      try {
        const metadata = await attendanceMetadata()
        if (!metadata.location?.latitude || !metadata.location?.longitude) {
          const message = 'Location access required — please enable GPS in your phone settings.'
          setGpsError(message)
          throw new Error(message)
        }
        const result = await safeFetchJson<CheckInPayload>(
          '/api/attendance/check-in',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Request-Id': requestId,
            },
            body: JSON.stringify({
              business_id: businessId,
              request_id: requestId,
              metadata,
              face_verification: {
                image_data_url: activeCapture.imageDataUrl,
                thumb_data_url: activeCapture.thumbDataUrl,
              },
            }),
            // No automatic retry — duplicate clicks would create overlapping
            // submits while the first is still uploading the face photo. The
            // server uses a unique constraint to dedupe and the user gets an
            // explicit "Retry check-in" button on error.
            retries: 0,
            timeoutMs: CHECKIN_TIMEOUT_MS,
          },
        )

        if (!result.ok) {
          logAttendanceClientFailure('attendance.checkin.client_failed', {
            businessId,
            requestId,
            status: result.status,
            code: result.error.code,
            message: result.error.message,
            rolledBack: result.rolledBack,
            latencyMs: Date.now() - started,
          })
          throw new Error(mapCheckInError(result.error.message, result.status))
        }

        const record = result.data.record
        if (!record?.id || !record.checkInAt) {
          logAttendanceClientFailure('attendance.checkin.client_failed', {
            businessId,
            requestId,
            reason: 'missing_record_in_response',
            latencyMs: Date.now() - started,
          })
          throw new Error('Server accepted check-in but did not return your attendance record. Tap Retry.')
        }

        logAttendanceClientSuccess('attendance.checkin.client_success', {
          businessId,
          requestId,
          attendanceRecordId: record.id,
          duplicate: Boolean(result.data.duplicate),
          latencyMs: Date.now() - started,
        })
        logCapture('attendance.capture.persisted', {
          component: 'FaceVerificationCheckIn',
          mountId: mountIdRef.current,
          businessId,
          requestId,
          attendanceRecordId: record.id,
          latencyMs: Date.now() - started,
        })

        setEmployeeName(typeof record.employeeId === 'string' ? record.employeeId : null)
        setSuccessAt(record.checkInAt)
        setPhase('success')

        if (result.data.duplicate) {
          toast.success('You are already checked in for today')
        } else {
          toast.success('Attendance confirmed')
        }

        try {
          await onSuccessRef.current()
        } catch (refreshErr) {
          logAttendanceClientFailure('attendance.checkin.client_failed', {
            businessId,
            requestId,
            reason: 'refresh_after_success',
            message: (refreshErr as Error).message,
          })
          toast.error('Check-in saved, but the desk could not refresh. Pull to refresh.')
        }

        window.setTimeout(() => {
          resetState()
          onCloseRef.current()
        }, 1_800)
      } catch (e) {
        const message = mapCheckInError((e as Error).message)
        setSubmitError(message)
        setPhase('error')
        toast.error(message)
        logAttendanceClientFailure('attendance.checkin.client_failed', {
          businessId,
          requestId,
          message,
          latencyMs: Date.now() - started,
        })
        logAttendanceMobileSubmitFailed({
          businessId,
          api: '/api/attendance/check-in',
          message,
          requestId,
          latencyMs: Date.now() - started,
        })
        logCapture('attendance.capture.retry', {
          component: 'FaceVerificationCheckIn',
          mountId: mountIdRef.current,
          businessId,
          requestId,
          error: message,
        })
      } finally {
        if (inFlightRef.current === requestId) inFlightRef.current = null
        setSubmitting(false)
      }
    },
    // captureRef/onCloseRef/onSuccessRef are mutable refs — deliberately excluded;
    // they expose the latest value without triggering useCallback recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [businessId, open, resetState],
  )

  async function openCameraWithGps() {
    if (processingPhoto || submitting) return
    setGpsError(null)
    const location = await requireHighAccuracyLocation()
    if (!location) {
      const message = 'Location access required — please enable GPS in your phone settings.'
      setGpsError(message)
      toast.error(message)
      return
    }
    inputRef.current?.click()
  }

  if (!mounted || !open) return null

  async function handleFile(file: File | undefined) {
    if (!file || processingPhoto || submitting) return
    setProcessingPhoto(true)
    setSubmitError(null)
    setGpsError(null)
    setNudgeConfirm(false)
    try {
      const result = await captureFaceFromFile(file)
      setPreview(result.imageDataUrl)
      setCapture({ imageDataUrl: result.imageDataUrl, thumbDataUrl: result.thumbDataUrl })
      setPhase('confirm')
      logCapture('attendance.checkin.capture_created', {
        component: 'FaceVerificationCheckIn',
        mountId: mountIdRef.current,
      })
      logCapture('attendance.capture.created', {
        component: 'FaceVerificationCheckIn',
        mountId: mountIdRef.current,
        businessId,
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

  const busy = processingPhoto || submitting

  return (
    <MobileModalPortal
      open
      zIndex={10050}
      backdropClassName="bg-black/80"
      aria-label="Attendance check-in"
      onBackdropClick={() => {
        if (!submitting) {
          resetState()
          onCloseRef.current()
        }
      }}
    >
      <div className="mobile-modal-shell mobile-sheet mx-auto w-full max-w-md rounded-t-[28px] border border-gold-dim/30 bg-surface shadow-2xl sm:rounded-2xl">
        <div className="safe-top shrink-0 border-b border-border px-4 pb-3 pt-4">
          <p id="face-checkin-title" className="text-base font-black text-cream">
            {phase === 'success' ? '🟢 Attendance confirmed' : phase === 'error' ? '⚠ Check-in failed' : '📸 Start work verification'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {phase === 'success'
              ? 'Your check-in was saved. This window will close automatically.'
              : phase === 'error'
                ? submitError || 'Something went wrong. You can retry without retaking the photo.'
                : 'Use your front camera. Tap the green button below after your photo appears.'}
          </p>
        </div>

        <div className="mobile-modal-body px-4 py-3">
          {phase === 'success' ? (
            <div className="flex flex-col items-center py-6 text-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/15 text-4xl ring-2 ring-green-400/40">
                ✓
              </div>
              <p className="mt-4 text-lg font-black text-green-300">Attendance confirmed</p>
              {employeeName && <p className="mt-1 text-sm font-bold text-cream">{employeeName}</p>}
              {successAt && (
                <p className="mt-2 font-mono text-sm text-zinc-400">
                  {new Date(successAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
          ) : phase === 'error' ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-center">
              <p className="text-sm font-bold text-red-200">{submitError}</p>
              <p className="mt-2 text-xs text-zinc-500">Your photo is still ready — tap Retry check-in below.</p>
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
                  alt="Face preview"
                  className="mx-auto max-h-[min(42vh,280px)] w-full object-contain"
                  data-attendance-photo="true"
                  data-private="true"
                />
              </div>
              <p className="text-center text-xs font-bold text-gold-lt">Photo ready — confirm below</p>
              {nudgeConfirm && (
                <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-xs font-bold text-amber-200">
                  ⚠ Please confirm attendance using the button at the bottom
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {gpsError && (
                <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-xs font-bold text-red-200">
                  {gpsError}
                </p>
              )}
              <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-700 bg-black/30 px-4 text-center">
                <span className="text-3xl opacity-60">📷</span>
                <p className="text-xs font-bold text-zinc-500">Front camera required</p>
                <p className="text-[11px] text-zinc-600">After capture, a large Confirm button appears at the bottom</p>
              </div>
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
          ) : phase === 'error' && capture ? (
            <div className="grid gap-2">
              <Button
                variant="gold"
                className="h-[56px] w-full justify-center gap-2 text-base font-black"
                disabled={busy}
                onClick={() => void submitCheckIn(true)}
              >
                {submitting ? (
                  <>
                    <Spinner />
                    Retrying…
                  </>
                ) : (
                  'Retry check-in'
                )}
              </Button>
              <Button
                variant="ghost"
                className="h-11 w-full justify-center text-xs"
                disabled={submitting}
                onClick={() => {
                  resetState()
                  onCloseRef.current()
                }}
              >
                Close
              </Button>
            </div>
          ) : phase === 'confirm' && capture ? (
            <div className="grid gap-2">
              <div ref={confirmAnchorRef}>
                <Button
                  variant="gold"
                  className={`h-[56px] w-full justify-center gap-2 text-base font-black shadow-lg shadow-gold/20 ${nudgeConfirm ? 'gold-pulse' : ''}`}
                  disabled={busy}
                  onClick={() => void submitCheckIn(false)}
                >
                  {submitting ? (
                    <>
                      <Spinner />
                      Confirming…
                    </>
                  ) : (
                    '✅ Confirm check-in'
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
                  onCloseRef.current()
                }}
              >
                Cancel
              </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Button
                variant="gold"
                className="h-[56px] w-full justify-center text-base font-black"
                disabled={busy}
                onClick={() => void openCameraWithGps()}
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
                  onCloseRef.current()
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </footer>
      </div>
    </MobileModalPortal>
  )
}

async function attendanceMetadata() {
  const sessionId = stableSessionId()
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const screenText = typeof screen !== 'undefined' ? `${screen.width}x${screen.height}x${screen.colorDepth}` : ''
  const fingerprint = [
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    nav.userAgentData?.platform || navigator.platform,
    screenText,
  ].join('|')
  return {
    browserFingerprint: fingerprint,
    sessionId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    platform: nav.userAgentData?.platform || navigator.platform,
    screen: screenText,
    location: await requireHighAccuracyLocation(),
  }
}

function stableSessionId() {
  const key = 'alma-attendance-session-id'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const id = crypto.randomUUID()
  window.localStorage.setItem(key, id)
  return id
}

async function requireHighAccuracyLocation(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (!navigator.geolocation) return null
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    )
  })
}

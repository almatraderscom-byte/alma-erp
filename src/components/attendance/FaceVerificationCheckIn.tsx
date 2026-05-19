'use client'

import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { captureFaceFromFile, mapCheckInError } from '@/lib/attendance-face-client'
import { Button, Card } from '@/components/ui'

type Props = {
  businessId: string
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

export function FaceVerificationCheckIn({ businessId, open, onClose, onSuccess }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ imageDataUrl: string; thumbDataUrl: string } | null>(null)

  if (!open) return null

  async function handleFile(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      const result = await captureFaceFromFile(file)
      setPreview(result.imageDataUrl)
      setCapture({ imageDataUrl: result.imageDataUrl, thumbDataUrl: result.thumbDataUrl })
    } catch (e) {
      toast.error((e as Error).message)
      setPreview(null)
      setCapture(null)
    } finally {
      setBusy(false)
    }
  }

  async function submitCheckIn() {
    if (!capture) {
      toast.error('Take a front-camera photo first')
      return
    }
    setBusy(true)
    try {
      const metadata = await attendanceMetadata()
      const res = await fetch('/api/attendance/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          metadata,
          face_verification: {
            image_data_url: capture.imageDataUrl,
            thumb_data_url: capture.thumbDataUrl,
          },
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(mapCheckInError(String(j.error || 'Check-in failed'), res.status))
      if (j.duplicate) {
        toast.success('You are already checked in for today')
      } else {
        toast.success('Work started · face verification saved')
      }
      setPreview(null)
      setCapture(null)
      onSuccess()
      onClose()
    } catch (e) {
      toast.error(mapCheckInError((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[150] flex items-end sm:items-center justify-center bg-black/80 p-4">
      <Card className="w-full max-w-sm border-gold-dim/30 p-5">
        <p className="text-sm font-bold text-cream">📸 Start Work Verification</p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          Use your <b>front camera</b>. This photo is sent to admin Telegram for accountability. Only a small thumbnail is kept in ERP.
        </p>

        {preview ? (
          <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-black/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Face preview" className="mx-auto max-h-52 w-full object-contain" />
          </div>
        ) : (
          <div className="mt-4 flex h-40 items-center justify-center rounded-2xl border border-dashed border-zinc-700 bg-black/30 text-xs text-zinc-500">
            Front camera required
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="user"
          className="hidden"
          disabled={busy}
          onChange={e => void handleFile(e.target.files?.[0])}
        />

        <div className="mt-4 grid gap-2">
          <Button
            variant="gold"
            className="h-12 w-full justify-center"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Processing...' : preview ? 'Retake photo' : 'Open front camera'}
          </Button>
          <Button
            variant="secondary"
            className="h-12 w-full justify-center"
            disabled={busy || !capture}
            onClick={() => void submitCheckIn()}
          >
            {busy ? 'Starting work...' : 'Confirm & start work'}
          </Button>
          <Button variant="ghost" className="w-full justify-center" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </Card>
    </div>
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
    location: await quietLocation(),
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

async function quietLocation(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
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
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 1200 },
    )
  })
}

'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

/**
 * Pick a recording mimeType the platform actually supports. Chrome/Firefox give us
 * webm/opus; iOS Safari + the Capacitor WKWebView app only support mp4/aac (they
 * return false for every webm variant), which is why voice silently failed on the
 * phone before — we forced webm and got an empty/garbled blob. We probe mp4/aac as
 * first-class options and fall back to '' (let MediaRecorder choose its default).
 */
function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return ''
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac',
    'audio/ogg;codecs=opus',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

/** Map a negotiated mimeType to a file extension the transcription backend accepts. */
function extForMime(mime: string): string {
  if (/mp4|aac|m4a/i.test(mime)) return 'm4a'
  if (/ogg/i.test(mime)) return 'ogg'
  if (/mpeg|mp3/i.test(mime)) return 'mp3'
  if (/wav/i.test(mime)) return 'wav'
  return 'webm'
}

export function useVoiceRecorder(opts: {
  onTranscribed: (text: string) => void
  onError?: (msg: string) => void
  onRecordingStart?: () => void
  onRecordingStop?: () => void
}) {
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const mrRef = useRef<MediaRecorder | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const callbacksRef = useRef(opts)
  useEffect(() => { callbacksRef.current = opts }, [opts])

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    mrRef.current?.stream?.getTracks().forEach(t => t.stop())
    mrRef.current = null
    setStream(null)
    setRecording(false)
    setRecordSecs(0)
  }, [])

  const start = useCallback(async () => {
    if (mrRef.current) return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      callbacksRef.current.onError?.('মাইক্রোফোন এই ব্রাউজারে সাপোর্ট করে না — HTTPS বা অ্যাপ থেকে খুলুন।')
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      callbacksRef.current.onError?.('এই অ্যাপ/ব্রাউজারে অডিও রেকর্ডিং সাপোর্ট করে না — আপডেট করে আবার চেষ্টা করুন।')
      return
    }
    try {
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      setStream(ms)
      const mime = pickRecorderMime()
      const mr = mime ? new MediaRecorder(ms, { mimeType: mime }) : new MediaRecorder(ms)
      mrRef.current = mr
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      mr.onstop = async () => {
        ms.getTracks().forEach(t => t.stop())
        setStream(null)
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        setRecording(false)
        setRecordSecs(0)
        callbacksRef.current.onRecordingStop?.()

        // iOS/Safari record mp4/aac, not webm — use the negotiated type so the
        // transcription backend gets a correctly-labeled file.
        const actualType = mrRef.current?.mimeType || mr.mimeType || mime || 'audio/webm'
        const ext = extForMime(actualType)
        const blob = new Blob(chunks, { type: actualType })
        if (blob.size < 800) {
          callbacksRef.current.onError?.('অডিও খুব ছোট — আবার বলুন।')
          return
        }
        const fd = new FormData()
        fd.append('audio', blob, `recording.${ext}`)
        try {
          const res = await fetch('/api/assistant/transcribe', { method: 'POST', body: fd })
          const data = await res.json() as { text?: string; error?: string }
          if (res.ok && data.text?.trim()) {
            callbacksRef.current.onTranscribed(data.text.trim())
          } else {
            callbacksRef.current.onError?.(data.error ?? 'ট্রান্সক্রিপশন ব্যর্থ।')
          }
        } catch {
          callbacksRef.current.onError?.('ট্রান্সক্রিপশন ব্যর্থ।')
        }
      }
      mr.start()
      setRecording(true)
      setRecordSecs(0)
      callbacksRef.current.onRecordingStart?.()
      timerRef.current = setInterval(() => setRecordSecs(s => s + 1), 1000)
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        callbacksRef.current.onError?.('মাইক্রোফোনের অনুমতি দিন — orb-এ ট্যাপ করে Allow করুন।')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        callbacksRef.current.onError?.('মাইক্রোফোন পাওয়া যায়নি।')
      } else {
        callbacksRef.current.onError?.('মাইক্রোফোন ব্যবহার করা যাচ্ছে না — orb-এ ট্যাপ করে আবার চেষ্টা করুন।')
      }
    }
  }, [])

  const stop = useCallback(() => {
    if (mrRef.current?.state === 'recording') mrRef.current.stop()
  }, [])

  const cancel = useCallback(() => {
    if (mrRef.current) {
      mrRef.current.ondataavailable = null
      mrRef.current.onstop = null
      if (mrRef.current.state === 'recording') {
        try { mrRef.current.stop() } catch { /* ignore */ }
      }
    }
    cleanup()
  }, [cleanup])

  return { recording, recordSecs, stream, start, stop, cancel }
}

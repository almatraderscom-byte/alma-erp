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
  /** Auto-stop when the speaker goes quiet (Siri-style). Opt-in (default false) so the
   *  existing manual tap-to-stop callers are unchanged. */
  autoStop?: boolean
  /** Silence (ms) after speech before auto-stopping. Default 1400. */
  silenceMs?: number
  /** Hard cap (ms) on a single utterance. Default 20000. */
  maxMs?: number
}) {
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const mrRef = useRef<MediaRecorder | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Voice-activity-detection (auto-stop) — Web Audio analyser on the same mic stream.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  // rAF freezes when the app backgrounds/screen locks — these two keep the mic
  // from recording forever in that state (privacy + a 3-min blob nobody wanted).
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visHandlerRef = useRef<(() => void) | null>(null)
  const vadRef = useRef<{ hasSpoken: boolean; silenceStart: number; startedAt: number }>({
    hasSpoken: false, silenceStart: 0, startedAt: 0,
  })
  const callbacksRef = useRef(opts)
  useEffect(() => { callbacksRef.current = opts }, [opts])

  const teardownVad = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null }
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null }
    if (visHandlerRef.current) {
      document.removeEventListener('visibilitychange', visHandlerRef.current)
      visHandlerRef.current = null
    }
  }, [])

  const cleanup = useCallback(() => {
    teardownVad()
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    mrRef.current?.stream?.getTracks().forEach(t => t.stop())
    mrRef.current = null
    setStream(null)
    setRecording(false)
    setRecordSecs(0)
  }, [teardownVad])

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
        teardownVad()
        ms.getTracks().forEach(t => t.stop())
        // Release the recorder ref so the NEXT start() isn't blocked by the
        // `if (mrRef.current) return` guard. Without this, a voice attempt that
        // doesn't navigate away (e.g. the agent didn't understand) leaves the old
        // inactive recorder pinned, and every later attempt silently no-ops until
        // the user force-quits and reopens the app. (iOS, Android and web alike.)
        mrRef.current = null
        setStream(null)
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        setRecording(false)
        setRecordSecs(0)
        callbacksRef.current.onRecordingStop?.()

        // iOS/Safari record mp4/aac, not webm — use the negotiated type so the
        // transcription backend gets a correctly-labeled file.
        const actualType = mr.mimeType || mime || 'audio/webm'
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

      // Screen lock / app background: rAF (and the VAD below) freezes but the
      // mic keeps capturing. Stop cleanly — what was said still transcribes.
      const onVis = () => {
        if (document.hidden && mrRef.current?.state === 'recording') mrRef.current.stop()
      }
      document.addEventListener('visibilitychange', onVis)
      visHandlerRef.current = onVis
      // Hard cap on a timer, not rAF — timers survive backgrounding, rAF doesn't.
      const capMs = callbacksRef.current.autoStop === true
        ? (callbacksRef.current.maxMs ?? 20000)
        : 300000 // manual mode: 5-min absolute safety stop
      maxTimerRef.current = setTimeout(() => {
        if (mrRef.current?.state === 'recording') mrRef.current.stop()
      }, capMs)

      // ── Siri-style auto-stop: listen to the mic level and stop once the speaker
      // has spoken and then gone quiet for `silenceMs` (or hits the hard cap). ──
      if (callbacksRef.current.autoStop === true) {
        try {
          const AC: typeof AudioContext =
            window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
          if (AC) {
            const ctx = new AC()
            audioCtxRef.current = ctx
            if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
            const source = ctx.createMediaStreamSource(ms)
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 512
            source.connect(analyser)
            const buf = new Uint8Array(analyser.fftSize)
            const SPEECH = 0.045   // RMS above this = clearly speaking
            const SILENCE = 0.025  // RMS below this = quiet
            const silenceMs = callbacksRef.current.silenceMs ?? 1400
            const maxMs = callbacksRef.current.maxMs ?? 20000
            vadRef.current = { hasSpoken: false, silenceStart: 0, startedAt: performance.now() }

            const tick = () => {
              if (!audioCtxRef.current || mrRef.current?.state !== 'recording') return
              analyser.getByteTimeDomainData(buf)
              let sum = 0
              for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
              const rms = Math.sqrt(sum / buf.length)
              const now = performance.now()
              const vad = vadRef.current

              if (rms > SPEECH) { vad.hasSpoken = true; vad.silenceStart = 0 }
              else if (rms < SILENCE && vad.hasSpoken) {
                if (!vad.silenceStart) vad.silenceStart = now
                else if (now - vad.silenceStart >= silenceMs) {
                  if (mrRef.current?.state === 'recording') mrRef.current.stop()
                  return
                }
              } else if (vad.hasSpoken) {
                vad.silenceStart = 0 // in-between level → treat as still talking
              }

              if (now - vad.startedAt >= maxMs) {
                if (mrRef.current?.state === 'recording') mrRef.current.stop()
                return
              }
              rafRef.current = requestAnimationFrame(tick)
            }
            rafRef.current = requestAnimationFrame(tick)
          }
        } catch { /* VAD is a nicety — fall back to manual tap-to-stop */ }
      }
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

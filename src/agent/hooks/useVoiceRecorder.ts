'use client'

import { useRef, useState, useCallback, useEffect } from 'react'

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
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
      setStream(ms)
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
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

        const blob = new Blob(chunks, { type: 'audio/webm' })
        if (blob.size < 800) {
          callbacksRef.current.onError?.('অডিও খুব ছোট — আবার বলুন।')
          return
        }
        const fd = new FormData()
        fd.append('audio', blob, 'recording.webm')
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
    } catch {
      callbacksRef.current.onError?.('মাইক্রোফোন ব্যবহার করা যাচ্ছে না')
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

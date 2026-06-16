'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'talking'

export function useVoiceRecorder(opts: {
  onTranscribed: (text: string) => void
  onPhaseChange?: (phase: VoicePhase) => void
}) {
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onTranscribedRef = useRef(opts.onTranscribed)
  const onPhaseChangeRef = useRef(opts.onPhaseChange)

  useEffect(() => { onTranscribedRef.current = opts.onTranscribed }, [opts.onTranscribed])
  useEffect(() => { onPhaseChangeRef.current = opts.onPhaseChange }, [opts.onPhaseChange])

  const setPhase = useCallback((p: VoicePhase) => {
    onPhaseChangeRef.current?.(p)
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setStream(mediaStream)
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      const mr = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream)
      mediaRecorderRef.current = mr
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      mr.onstop = async () => {
        mediaStream.getTracks().forEach((t) => t.stop())
        setStream(null)
        if (recordTimerRef.current) clearInterval(recordTimerRef.current)
        setRecording(false)
        setRecordSecs(0)
        const blob = new Blob(chunks, { type: 'audio/webm' })
        if (blob.size < 800) {
          setPhase('idle')
          toast.error('অডিও খুব ছোট — আবার বলুন।')
          return
        }
        setPhase('transcribing')
        const fd = new FormData()
        fd.append('audio', blob, 'recording.webm')
        try {
          const res = await fetch('/api/assistant/transcribe', { method: 'POST', body: fd })
          const data = await res.json() as { text?: string; error?: string }
          if (res.ok && data.text?.trim()) {
            onTranscribedRef.current(data.text.trim())
          } else {
            toast.error(data.error ?? 'ট্রান্সক্রিপশন ব্যর্থ।')
            setPhase('idle')
          }
        } catch {
          toast.error('ট্রান্সক্রিপশন ব্যর্থ।')
          setPhase('idle')
        }
      }
      mr.start()
      setRecording(true)
      setRecordSecs(0)
      setPhase('listening')
      recordTimerRef.current = setInterval(() => setRecordSecs((s) => s + 1), 1000)
    } catch {
      toast.error('মাইক্রোফোন ব্যবহার করা যাচ্ছে না')
      setPhase('idle')
    }
  }, [setPhase])

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop()
  }, [])

  const cancelRecording = useCallback(() => {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current)
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop())
    mediaRecorderRef.current = null
    setStream(null)
    setRecording(false)
    setRecordSecs(0)
    setPhase('idle')
  }, [setPhase])

  return {
    recording,
    recordSecs,
    stream,
    startRecording,
    stopRecording,
    cancelRecording,
  }
}

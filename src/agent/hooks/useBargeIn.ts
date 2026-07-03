'use client'

import { useEffect, useRef } from 'react'

/**
 * Voice barge-in — while the agent is SPEAKING, a light mic watcher listens
 * for the owner's voice; sustained speech interrupts the reply and hands the
 * mic over, exactly like talking over Siri. Conservative by design: the
 * device's echo cancellation removes most of the agent's own voice from the
 * mic, and we additionally require a strong level held for ~450ms so speaker
 * bleed or a cough doesn't cut the reply mid-sentence.
 */
export function useBargeIn(active: boolean, onBarge: () => void) {
  const onBargeRef = useRef(onBarge)
  useEffect(() => { onBargeRef.current = onBarge }, [onBarge])

  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return

    let disposed = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        })
        if (disposed) { stream.getTracks().forEach((t) => t.stop()); return }
        const AC: typeof AudioContext =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        ctx = new AC()
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
        const buf = new Uint8Array(analyser.fftSize)
        const SPEECH = 0.08 // deliberately higher than the recorder's VAD — must be a real voice
        const HOLD_MS = 600 // long hold: speaker bleed on weak-AEC devices must not self-interrupt
        let speechStart = 0

        const tick = () => {
          if (disposed || !ctx) return
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
          const rms = Math.sqrt(sum / buf.length)
          const now = performance.now()
          if (rms > SPEECH) {
            if (!speechStart) speechStart = now
            else if (now - speechStart >= HOLD_MS) { onBargeRef.current(); return }
          } else {
            speechStart = 0
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      } catch { /* no mic / denied — barge-in is a nicety */ }
    }
    void start()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      if (ctx) void ctx.close().catch(() => {})
    }
  }, [active])
}

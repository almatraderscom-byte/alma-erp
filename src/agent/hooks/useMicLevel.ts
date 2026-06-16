'use client'

import { useEffect, useRef, useState } from 'react'

/** Normalized mic level 0–1 from a MediaStream (while recording). */
export function useMicLevel(stream: MediaStream | null, active: boolean): number {
  const [level, setLevel] = useState(0)
  const rafRef = useRef<number>(0)
  const ctxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    if (!stream || !active) {
      setLevel(0)
      return
    }

    const ctx = new AudioContext()
    ctxRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const tick = () => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      const avg = sum / data.length / 255
      setLevel(Math.min(1, avg * 2.2))
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(rafRef.current)
      source.disconnect()
      void ctx.close()
      ctxRef.current = null
      setLevel(0)
    }
  }, [stream, active])

  return level
}

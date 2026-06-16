'use client'

import { useEffect, useState } from 'react'

/** Approximate output level 0–1 while an HTMLAudioElement is playing. */
export function usePlaybackLevel(audio: HTMLAudioElement | null, playing: boolean): number {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!audio || !playing) {
      setLevel(0)
      return
    }

    let ctx: AudioContext | null = null
    let source: MediaElementAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    let raf = 0

    try {
      ctx = new AudioContext()
      source = ctx.createMediaElementSource(audio)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
      analyser.connect(ctx.destination)
      const data = new Uint8Array(analyser.frequencyBinCount)

      const tick = () => {
        if (!analyser) return
        analyser.getByteFrequencyData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i]
        setLevel(Math.min(1, (sum / data.length / 255) * 2.5))
        raf = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // MediaElementSource may only be created once per element — fallback pulse
      const pulse = () => {
        setLevel(0.35 + Math.sin(Date.now() / 180) * 0.15)
        raf = requestAnimationFrame(pulse)
      }
      pulse()
    }

    return () => {
      cancelAnimationFrame(raf)
      try {
        source?.disconnect()
        void ctx?.close()
      } catch { /* ignore */ }
      setLevel(0)
    }
  }, [audio, playing])

  return level
}

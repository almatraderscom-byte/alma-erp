'use client'

import { useEffect, useRef } from 'react'

/**
 * VoiceNavGlow — the Siri / Apple-Intelligence style edge glow.
 *
 * A full-screen, pointer-events:none overlay that wraps a soft, breathing,
 * rotating rainbow halo around ALL edges of the app while the voice navigator
 * is active (listening → thinking → going), then fades out. Mirrors the feel of
 * iPhone's Siri listening animation. Plays a subtle two-tone chime on start/stop
 * (generated with the Web Audio API — no asset files).
 *
 * Fully self-contained: it injects its own scoped CSS so it works on every
 * portal page without touching globals.css, and it reads <html data-theme> so
 * the glow reads beautifully in BOTH light (cream) and dark backgrounds.
 */
interface VoiceNavGlowProps {
  active: boolean
}

const SIRI_CSS = `
@property --alma-sa{syntax:'<angle>';inherits:false;initial-value:0deg}
@property --alma-sb{syntax:'<angle>';inherits:false;initial-value:0deg}
.alma-siri{position:fixed;inset:0;pointer-events:none;z-index:70;border-radius:46px;opacity:0;visibility:hidden;transition:opacity .85s ease;will-change:opacity}
.alma-siri.is-on{opacity:1;visibility:visible}
.alma-siri-inner{position:absolute;inset:0;border-radius:inherit;animation:alma-siri-pulse 3.2s ease-in-out infinite}
.alma-siri-inner>div{position:absolute;inset:0;border-radius:inherit;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;will-change:transform}
.alma-siri-bloom{padding:54px;filter:blur(46px);opacity:.42;background:conic-gradient(from var(--alma-sa),#ff2d8e,#b14cff,#4c8bff,#39d0ff,#ff8a3d,#ff2d8e);animation:alma-siri-spin-a 6s linear infinite,alma-siri-breathe 3.4s ease-in-out infinite}
.alma-siri-band{padding:30px;filter:blur(24px);opacity:.6;background:conic-gradient(from var(--alma-sb),#39d0ff,#b14cff,#ff2d8e,#ff8a3d,#4c8bff,#39d0ff);animation:alma-siri-spin-b 4.2s linear infinite,alma-siri-breathe 3.4s ease-in-out infinite}
.alma-siri-edge{padding:9px;filter:blur(7px);opacity:.5;background:conic-gradient(from var(--alma-sa),#ffd9ec,#e6d4ff,#cfe6ff,#ffe9d4,#ffd9ec);animation:alma-siri-spin-a 6s linear infinite,alma-siri-breathe 3.4s ease-in-out infinite}
@keyframes alma-siri-spin-a{to{--alma-sa:360deg}}
@keyframes alma-siri-spin-b{to{--alma-sb:-360deg}}
@keyframes alma-siri-pulse{0%,100%{opacity:.78}50%{opacity:1}}
@keyframes alma-siri-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.012)}}
:root[data-theme='light'] .alma-siri-bloom{opacity:.62;mix-blend-mode:multiply}
:root[data-theme='light'] .alma-siri-band{opacity:.86;mix-blend-mode:multiply}
:root[data-theme='light'] .alma-siri-edge{opacity:.78;mix-blend-mode:multiply}
@media (prefers-reduced-motion:reduce){.alma-siri-inner,.alma-siri-bloom,.alma-siri-band,.alma-siri-edge{animation:none}}
`

/** A subtle Siri-like shimmer: a soft arpeggio that rises on start, falls on stop. */
function playChime(ctx: AudioContext, rising: boolean) {
  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.setValueAtTime(0.0001, now)
  master.gain.exponentialRampToValueAtTime(0.06, now + 0.04)
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.55)

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 2800
  master.connect(filter)
  filter.connect(ctx.destination)

  const freqs = rising ? [523.25, 659.25, 783.99] : [783.99, 587.33, 440.0]
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f
    const g = ctx.createGain()
    g.gain.value = 1 / (i + 1.3)
    osc.connect(g)
    g.connect(master)
    const t = now + i * 0.06
    osc.start(t)
    osc.stop(t + 0.5)
  })
}

export function VoiceNavGlow({ active }: VoiceNavGlowProps) {
  const ctxRef = useRef<AudioContext | null>(null)
  const wasActive = useRef(false)
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) {
      // Don't chime on initial mount — only on real transitions.
      firstRun.current = false
      wasActive.current = active
      return
    }
    if (active === wasActive.current) return
    wasActive.current = active
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      if (!ctxRef.current) ctxRef.current = new AC()
      const ctx = ctxRef.current
      void ctx.resume()
      playChime(ctx, active)
    } catch {
      /* audio is best-effort */
    }
  }, [active])

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: SIRI_CSS }} />
      <div className={`alma-siri${active ? ' is-on' : ''}`} aria-hidden="true">
        <div className="alma-siri-inner">
          <div className="alma-siri-bloom" />
          <div className="alma-siri-band" />
          <div className="alma-siri-edge" />
        </div>
      </div>
    </>
  )
}

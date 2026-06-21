'use client'

import { useState, useEffect, useRef, type CSSProperties } from 'react'

/* ============================================================================
 *  AlmaSpinner — owner-supplied loading animation (built in the Claude app).
 *  ---------------------------------------------------------------------------
 *  The morphing sparkle glyph + breathing/rotation is kept EXACTLY as supplied.
 *  Two things were added on top of the original drop-in:
 *    1. TypeScript types (this repo is strict TS).
 *    2. A `sound` layer synced to the SAME rhythm as the haptics (Web Audio),
 *       because the owner wants haptic + sound in sync. Sound is opt-in.
 *
 *  Usage:
 *      <AlmaSpinner mode="thinking" />            // "thinking" | "writing" | "searching"
 *      <AlmaSpinner mode="searching" size={20} color="#E8835A" />
 *      <AlmaSpinner mode="writing" showVerb={false} haptics={false} />
 *      <AlmaSpinner mode="thinking" sound />      // adds the synced audio tick
 *
 *  Notes:
 *   • haptics use navigator.vibrate → works on Android web. iOS Safari ignores it.
 *     For a React Native app, swap the vibrate() call for expo-haptics instead.
 *   • sound uses the Web Audio API; browsers only allow it after a user gesture
 *     (sending a message counts), so it stays silent until the user interacts.
 *   • color should be a 6-digit hex (used for the glow).
 * ========================================================================== */

export type AlmaSpinnerMode = 'thinking' | 'writing' | 'searching'

const VS = '︎' // text-variation selector → forces monochrome (no emoji)
const F = (g: string) => g + VS
const FRAMES = ['·', F('✢'), F('✳'), F('✶'), F('✽'), F('✻'), F('✽'), F('✶'), F('✳'), F('✢')]
const REST = F('✻')

interface ModeConfig {
  frame: number
  verbEvery: number
  hapGap: number
  hapDur: number
  /** Tone (Hz) for the synced audio tick — gives each mode its own character. */
  hapFreq: number
  anim: string
  verbs: string[]
}

const MODES: Record<AlmaSpinnerMode, ModeConfig> = {
  thinking: {
    frame: 210, verbEvery: 2000, hapGap: 820, hapDur: 16, hapFreq: 330,
    anim: 'alma-breathe 1.7s ease-in-out infinite',
    verbs: ['Pondering', 'Musing', 'Noodling', 'Mulling', 'Wondering', 'Reflecting',
            'Contemplating', 'Untangling', 'Considering', 'Reasoning', 'Connecting dots'],
  },
  writing: {
    frame: 130, verbEvery: 1500, hapGap: 210, hapDur: 7, hapFreq: 460,
    anim: 'alma-breathe 1.05s ease-in-out infinite',
    verbs: ['Writing', 'Composing', 'Drafting', 'Wording', 'Phrasing', 'Shaping',
            'Polishing', 'Articulating', 'Putting it together', 'Streaming'],
  },
  searching: {
    frame: 300, verbEvery: 1400, hapGap: 360, hapDur: 9, hapFreq: 540,
    anim: 'alma-rot 1.25s linear infinite',
    verbs: ['Searching', 'Browsing', 'Reading', 'Fetching', 'Scanning', 'Skimming',
            'Cross-referencing', 'Digging', 'Gathering', 'Looking it up', 'Sourcing'],
  },
}

let kfInjected = false
function injectKeyframes() {
  if (kfInjected || typeof document === 'undefined') return
  kfInjected = true
  const s = document.createElement('style')
  s.textContent =
    '@keyframes alma-rot{to{transform:rotate(360deg)}}' +
    '@keyframes alma-breathe{0%,100%{opacity:.78;transform:scale(.96)}50%{opacity:1;transform:scale(1.05)}}'
  document.head.appendChild(s)
}

/* --- sound: a soft Web Audio tick, synced to the haptic rhythm ------------- */
let _audioCtx: AudioContext | null = null
function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!_audioCtx) {
    try {
      _audioCtx = new Ctor()
    } catch {
      return null
    }
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {})
  return _audioCtx
}

function playTick(freq: number, volume = 0.035) {
  const ctx = getAudioCtx()
  if (!ctx || ctx.state !== 'running') return
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  // tiny pluck: fast attack, exponential decay (~55ms) — gentle, not annoying.
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(volume, now + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.07)
}

export interface AlmaSpinnerProps {
  mode?: AlmaSpinnerMode
  haptics?: boolean
  /** Play a soft audio tick synced to the haptic rhythm. Default off. */
  sound?: boolean
  size?: number
  color?: string
  showVerb?: boolean
  style?: CSSProperties
}

export function AlmaSpinner({
  mode = 'thinking',
  haptics = true,
  sound = false,
  size = 22,
  color = '#E8835A',
  showVerb = true,
  style = {},
}: AlmaSpinnerProps) {
  const cfg = MODES[mode] || MODES.thinking
  const [frame, setFrame] = useState(REST)
  const [verb, setVerb] = useState(cfg.verbs[0])
  const fi = useRef(0)

  useEffect(() => { injectKeyframes() }, [])

  // glyph frames
  useEffect(() => {
    fi.current = 0
    const id = setInterval(() => {
      fi.current = (fi.current + 1) % FRAMES.length
      setFrame(FRAMES[fi.current])
    }, cfg.frame)
    return () => clearInterval(id)
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // rotating verbs
  useEffect(() => {
    const pick = () => cfg.verbs[Math.floor(Math.random() * cfg.verbs.length)]
    setVerb(pick())
    const id = setInterval(() => setVerb(pick()), cfg.verbEvery)
    return () => clearInterval(id)
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // haptics + sound — both fired together so they stay in sync to the mode rhythm
  useEffect(() => {
    if (!haptics && !sound) return
    const canVibrate = haptics && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
    const pulse = () => {
      if (canVibrate) navigator.vibrate(cfg.hapDur)
      if (sound) playTick(cfg.hapFreq)
    }
    pulse()
    const id = setInterval(pulse, cfg.hapGap)
    return () => {
      clearInterval(id)
      if (canVibrate) navigator.vibrate(0)
    }
  }, [mode, haptics, sound]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', ...style }}>
      <span style={{ fontSize: size, lineHeight: 1, color, width: '1.1em',
        textAlign: 'center', display: 'inline-block', fontVariantEmoji: 'text',
        textShadow: `0 0 16px ${color}80`, animation: cfg.anim } as CSSProperties}>{frame}</span>
      {showVerb && (
        <span style={{ fontSize: Math.round(size * 0.62), color: 'inherit', fontWeight: 500 }}>
          {verb}…
        </span>
      )}
    </span>
  )
}

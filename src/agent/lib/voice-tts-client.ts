/**
 * TTS playback client. iOS WKWebView only lets a media element play() if that
 * ELEMENT earned "gesture credit" — a brand-new `new Audio()` played after two
 * network awaits has none, so replies would silently never sound on iPhone.
 * The fix: one persistent audio element, unlocked (silent play) inside the
 * orb-tap gesture, then reused for every reply.
 */

import { normalizeForTts } from './tts-normalize'

/** 1-sample silent WAV — enough for a gesture-credit play() on iOS. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=='

let _ttsAudio: HTMLAudioElement | null = null
let _lastUrl: string | null = null

function getElement(): HTMLAudioElement {
  if (!_ttsAudio) {
    _ttsAudio = new Audio()
    _ttsAudio.setAttribute('playsinline', '')
    _ttsAudio.preload = 'auto'
  }
  return _ttsAudio
}

/* ---- real voice↔orb sync ----------------------------------------------
 * Siri's orb dances to the ACTUAL audio. We route the persistent element
 * through a WebAudio analyser so the orb/waveform read the live amplitude of
 * the spoken reply instead of a simulated envelope. createMediaElementSource
 * is once-per-element and reroutes output through the context, so this must
 * only ever run inside a user gesture (unlockTtsAudio) and always reconnects
 * to destination — if anything fails we leave the element untouched and the
 * orb falls back to the envelope. */
let _ttsCtx: AudioContext | null = null
let _ttsAnalyser: AnalyserNode | null = null
let _ttsBuf: Uint8Array | null = null
let _routeAttempted = false

function ensureTtsAnalyser(): void {
  if (_routeAttempted || typeof window === 'undefined') return
  _routeAttempted = true
  try {
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const el = getElement()
    const ctx = new AC()
    const src = ctx.createMediaElementSource(el)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.55
    src.connect(analyser)
    analyser.connect(ctx.destination)
    _ttsCtx = ctx
    _ttsAnalyser = analyser
    _ttsBuf = new Uint8Array(analyser.frequencyBinCount)
  } catch {
    _ttsCtx = null
    _ttsAnalyser = null
  }
}

/** Keep the routed context running — a suspended context would mute the reply. */
export function resumeTtsRoute(): void {
  if (_ttsCtx && _ttsCtx.state === 'suspended') void _ttsCtx.resume().catch(() => {})
}

/* ---- instant acknowledgements ------------------------------------------
 * The ack used to wait for STT + a TTS fetch (~1.5-2.5s of dead air). The
 * console pre-synthesizes its ack lines once per session; when the mic
 * closes, one plays from cache in the SAME tick — Siri-grade immediacy. */
const _ackCache = new Map<string, string>()

export async function primeSpokenAcks(texts: string[]): Promise<void> {
  for (const t of texts) {
    if (_ackCache.has(t)) continue
    try { _ackCache.set(t, await fetchTtsUrl(t)) } catch { /* ack stays lazy */ }
  }
}

/** Play a pre-synthesized ack instantly. False → caller falls back to the queue. */
export function playInstantAck(text: string): boolean {
  const url = _ackCache.get(text)
  if (!url) return false
  try {
    const el = getElement()
    el.onended = null
    el.onerror = null
    el.src = url
    el.muted = false
    resumeTtsRoute()
    void el.play().catch(() => {})
    return true
  } catch { return false }
}

/** Speak one standalone line right now (approval confirmations etc.).
 *  `stillValid` re-checks after the network fetch — if the console closed or
 *  the mic took over meanwhile, the line is dropped instead of resurrecting
 *  over whatever now owns the element. */
export async function speakLine(text: string, stillValid?: () => boolean): Promise<void> {
  try {
    const url = await fetchTtsUrl(text)
    if (stillValid && !stillValid()) { URL.revokeObjectURL(url); return }
    const el = getElement()
    el.onended = () => URL.revokeObjectURL(url)
    el.onerror = () => URL.revokeObjectURL(url)
    el.src = url
    el.muted = false
    resumeTtsRoute()
    await el.play().catch(() => {})
  } catch { /* spoken confirmation is best-effort */ }
}

/**
 * Siri-style earcon when the mic opens — two quick soft sine notes on the
 * routed context. Silent no-op when the context isn't available/running.
 */
export function playMicChime(): void {
  try {
    if (!_ttsCtx || _ttsCtx.state !== 'running') return
    const ctx = _ttsCtx
    const g = ctx.createGain()
    g.gain.value = 0
    g.connect(ctx.destination)
    const note = (freq: number, at: number, dur: number) => {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = freq
      o.connect(g)
      g.gain.setValueAtTime(0, ctx.currentTime + at)
      g.gain.linearRampToValueAtTime(0.09, ctx.currentTime + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + dur + 0.02)
    }
    note(880, 0, 0.12)
    note(1318.5, 0.09, 0.14)
  } catch { /* an earcon is never worth an error */ }
}

/** Descending two-note — the mic CLOSED without hearing anything (auto-listen
 *  gave up). Without this the hands-free owner thinks it's still listening. */
export function playMicCloseChime(): void {
  try {
    if (!_ttsCtx || _ttsCtx.state !== 'running') return
    const ctx = _ttsCtx
    const g = ctx.createGain()
    g.gain.value = 0
    g.connect(ctx.destination)
    const note = (freq: number, at: number, dur: number) => {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = freq
      o.connect(g)
      g.gain.setValueAtTime(0, ctx.currentTime + at)
      g.gain.linearRampToValueAtTime(0.07, ctx.currentTime + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + dur + 0.02)
    }
    note(1174.7, 0, 0.12)
    note(784, 0.09, 0.16)
  } catch { /* best-effort */ }
}

/**
 * Live amplitude (0..1) of whatever the TTS element is speaking right now,
 * or -1 when no analyser is available (caller falls back to its envelope).
 */
export function getTtsLevel(): number {
  if (!_ttsAnalyser || !_ttsBuf) return -1
  resumeTtsRoute()
  _ttsAnalyser.getByteFrequencyData(_ttsBuf)
  let sum = 0
  for (let i = 0; i < _ttsBuf.length; i++) sum += _ttsBuf[i]
  return Math.min(1, (sum / _ttsBuf.length / 255) * 2.4)
}

/**
 * Call from a REAL user gesture (the orb tap). Plays a silent wav muted on the
 * persistent element so WKWebView marks it gesture-activated; later play()
 * calls on the same element are then allowed. Idempotent and near-free.
 */
export function unlockTtsAudio(): void {
  if (typeof window === 'undefined') return
  try {
    // Inside the tap gesture: also build the analyser route (once) and keep
    // its context running — both need gesture credit on iOS.
    ensureTtsAnalyser()
    resumeTtsRoute()
    const el = getElement()
    // Don't clobber an actively-playing reply (barge-in taps land here too).
    if (!el.paused) return
    el.muted = true
    el.src = SILENT_WAV
    void el.play().then(() => { el.pause(); el.muted = false }).catch(() => { el.muted = false })
  } catch { /* unlock is best-effort */ }
}

/** The persistent (gesture-unlocked) element, for sequential chunk playback. */
export function getTtsElement(): HTMLAudioElement {
  return getElement()
}

/**
 * Fetch TTS for one chunk of text and return a blob URL — does NOT touch the
 * shared element, so the next chunk can be fetched while the current one plays.
 * Caller owns revocation. Text passes the deterministic Bangla normalizer so
 * numbers/brands/URLs are pronounced, not letter-salad (prompt steering alone
 * is not a guard).
 */
export async function fetchTtsUrl(text: string): Promise<string> {
  const clean = normalizeForTts(text).replace(/\s+/g, ' ').trim().slice(0, 1200)
  if (!clean) throw new Error('empty text')
  const res = await fetch('/api/assistant/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `TTS HTTP ${res.status}`)
  }
  return URL.createObjectURL(await res.blob())
}

/** Fetch TTS audio from server, return an HTMLAudioElement ready to play. */
export async function fetchTtsAudio(text: string): Promise<HTMLAudioElement> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200)
  if (!clean) throw new Error('empty text')

  const res = await fetch('/api/assistant/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `TTS HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)

  const audio = getElement()
  // Free the previous reply's blob; callers overwrite onended, so revocation
  // must not depend on their handlers.
  if (_lastUrl) { URL.revokeObjectURL(_lastUrl) }
  _lastUrl = url
  audio.muted = false
  audio.onended = null
  audio.onerror = null
  audio.src = url
  return audio
}

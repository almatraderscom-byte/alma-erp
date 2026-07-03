/**
 * TTS playback client. iOS WKWebView only lets a media element play() if that
 * ELEMENT earned "gesture credit" — a brand-new `new Audio()` played after two
 * network awaits has none, so replies would silently never sound on iPhone.
 * The fix: one persistent audio element, unlocked (silent play) inside the
 * orb-tap gesture, then reused for every reply.
 */

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
 * Caller owns revocation.
 */
export async function fetchTtsUrl(text: string): Promise<string> {
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

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

/**
 * Call from a REAL user gesture (the orb tap). Plays a silent wav muted on the
 * persistent element so WKWebView marks it gesture-activated; later play()
 * calls on the same element are then allowed. Idempotent and near-free.
 */
export function unlockTtsAudio(): void {
  if (typeof window === 'undefined') return
  try {
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

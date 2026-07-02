'use client'

import { useEffect, useRef } from 'react'

/**
 * "ALMA" wake-word while the voice console is open — hands-free start without
 * touching the orb. Built on the browser's on-device/vendor SpeechRecognition
 * (webkitSpeechRecognition): available on Android Chrome and desktop Chrome,
 * NOT in iOS WKWebView — callers must check `wakeWordSupported()` and hide the
 * feature where it's false (an iOS native path needs a Capacitor speech plugin
 * + Xcode rebuild; deliberately out of scope here).
 *
 * Battery + privacy guards: recognition runs ONLY while `enabled` (console
 * open, idle, toggle on) and the tab is visible; it stops the moment the real
 * recorder takes the mic.
 */

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function wakeWordSupported(): boolean {
  return getRecognitionCtor() !== null
}

/** Matches "ALMA" the ways Bangla/Banglish STT actually hears it. */
const WAKE_RE = /\b(alma|আলমা|আল্মা|আলমা|অালমা)\b|আলমা/i

export function useWakeWord(enabled: boolean, onWake: () => void) {
  const onWakeRef = useRef(onWake)
  useEffect(() => { onWakeRef.current = onWake }, [onWake])

  useEffect(() => {
    const Ctor = getRecognitionCtor()
    if (!enabled || !Ctor) return

    let disposed = false
    let rec: SpeechRecognitionLike | null = null
    let restartTimer: ReturnType<typeof setTimeout> | null = null

    const stop = () => {
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      if (rec) {
        rec.onresult = null
        rec.onend = null
        rec.onerror = null
        try { rec.abort() } catch { /* already stopped */ }
        rec = null
      }
    }

    const start = () => {
      if (disposed || document.hidden || rec) return
      try {
        rec = new Ctor()
        rec.lang = 'bn-BD'
        rec.continuous = true
        rec.interimResults = true
        rec.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const text = e.results[i]?.[0]?.transcript ?? ''
            if (WAKE_RE.test(text)) {
              stop()
              onWakeRef.current()
              return
            }
          }
        }
        // Vendor recognition self-terminates every ~30-60s of silence and on
        // transient network errors — restart with a small backoff while enabled.
        rec.onend = () => {
          rec = null
          if (!disposed && !document.hidden) restartTimer = setTimeout(start, 700)
        }
        rec.onerror = () => { /* onend fires after and handles the restart */ }
        rec.start()
      } catch {
        rec = null // e.g. mic permission denied — stay silent, orb tap still works
      }
    }

    const onVis = () => { if (document.hidden) stop(); else start() }
    document.addEventListener('visibilitychange', onVis)
    start()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVis)
      stop()
    }
  }, [enabled])
}

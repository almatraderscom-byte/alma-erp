'use client'

import { fetchTtsUrl, getTtsElement, resumeTtsRoute } from './voice-tts-client'

/**
 * Sentence-chunked streaming TTS — the reply starts SOUNDING as soon as its
 * first sentence exists instead of waiting for the whole turn. Text deltas
 * stream in via feed(); complete sentences are cut on Bangla/Latin sentence
 * boundaries, synthesized per chunk, and played back-to-back on the shared
 * gesture-unlocked audio element (iOS-safe). The next chunk is prefetched
 * while the current one plays, so the voice doesn't gap between sentences.
 */

const BOUNDARY = /[।?!\n]/
/** Don't synthesize crumbs — a chunk shorter than this waits for more text. */
const MIN_CHUNK = 24

export interface TtsChunkPlayer {
  /** Stream in raw reply text as it arrives. */
  feed: (delta: string) => void
  /** Speak a short SYSTEM line right away (ack / process narration) — jumps the
   *  sentence buffer, does not count as the reply for onFirstPlay. */
  say: (text: string) => void
  /** No more text is coming — flush the remainder; onDone fires after the last chunk ends. */
  finish: () => void
  /** Stop immediately (barge-in / console closed). Safe to call repeatedly. */
  dispose: () => void
}

export function createTtsChunkPlayer(handlers: {
  /** First audible chunk started playing. */
  onFirstPlay?: () => void
  /** A chunk just started sounding — live-subtitle hook. */
  onChunkStart?: (text: string, sys: boolean) => void
  /** Everything queued has finished sounding (or nothing was ever queued). */
  onDone?: () => void
}): TtsChunkPlayer {
  let buffer = ''
  const queue: { text: string; sys: boolean }[] = []
  let fetching = false
  let playing = false
  let finished = false
  let disposed = false
  let firstPlayed = false
  let prefetched: { text: string; sys: boolean; url: string } | null = null

  const el = getTtsElement()

  const done = () => {
    if (!disposed && finished && !playing && !fetching && queue.length === 0 && !buffer.trim()) {
      handlers.onDone?.()
    }
  }

  const playUrl = (url: string, sys: boolean, text: string) => {
    playing = true
    // System lines (ack/narration) don't flip the console to "speaking" —
    // only the real reply does.
    if (!sys && !firstPlayed) { firstPlayed = true; handlers.onFirstPlay?.() }
    handlers.onChunkStart?.(text, sys)
    el.onended = () => {
      URL.revokeObjectURL(url)
      playing = false
      void pump()
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      playing = false
      void pump()
    }
    el.src = url
    el.muted = false
    resumeTtsRoute() // a suspended WebAudio route would mute the reply
    el.play().catch(() => {
      // Autoplay refused (shouldn't happen on the unlocked element) — skip audio,
      // keep the pipeline draining so onDone still fires and the loop continues.
      URL.revokeObjectURL(url)
      playing = false
      void pump()
    })
  }

  const pump = async (): Promise<void> => {
    if (disposed || playing) { done(); return }
    // A prefetched chunk is ready to sound immediately.
    if (prefetched) {
      const p = prefetched
      prefetched = null
      playUrl(p.url, p.sys, p.text)
      void prefetchNext()
      return
    }
    if (fetching) return
    const next = queue.shift()
    if (next === undefined) { done(); return }
    fetching = true
    try {
      const url = await fetchTtsUrl(next.text)
      fetching = false
      if (disposed) { URL.revokeObjectURL(url); return }
      playUrl(url, next.sys, next.text)
      void prefetchNext()
    } catch {
      fetching = false
      void pump() // skip the failed chunk, keep the rest of the reply sounding
    }
  }

  const prefetchNext = async (): Promise<void> => {
    if (disposed || prefetched || fetching) return
    const next = queue.shift()
    if (next === undefined) return
    fetching = true
    try {
      const url = await fetchTtsUrl(next.text)
      fetching = false
      if (disposed) { URL.revokeObjectURL(url); return }
      prefetched = { text: next.text, sys: next.sys, url }
      if (!playing) void pump()
    } catch {
      fetching = false
    }
  }

  const cutSentences = () => {
    // Cut everything up to the LAST boundary, provided the piece is meaty
    // enough; the tail stays buffered for the next delta or finish().
    let lastBoundary = -1
    for (let i = 0; i < buffer.length; i++) {
      if (BOUNDARY.test(buffer[i])) lastBoundary = i
    }
    if (lastBoundary >= 0) {
      const head = buffer.slice(0, lastBoundary + 1).trim()
      if (head.length >= MIN_CHUNK) {
        queue.push({ text: head, sys: false })
        buffer = buffer.slice(lastBoundary + 1)
        void pump()
      }
    }
  }

  return {
    feed(delta: string) {
      if (disposed || finished) return
      buffer += delta
      cutSentences()
    },
    say(text: string) {
      if (disposed || finished) return
      const clean = text.trim()
      if (!clean) return
      queue.push({ text: clean, sys: true })
      void pump()
    },
    finish() {
      if (disposed || finished) return
      finished = true
      const rest = buffer.trim()
      buffer = ''
      if (rest) queue.push({ text: rest, sys: false })
      void pump()
    },
    dispose() {
      if (disposed) return
      disposed = true
      buffer = ''
      queue.length = 0
      if (prefetched) { URL.revokeObjectURL(prefetched.url); prefetched = null }
      el.onended = null
      el.onerror = null
      try { el.pause() } catch { /* fine */ }
    },
  }
}

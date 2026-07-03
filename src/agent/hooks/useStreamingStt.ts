'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * TRUE streaming STT (voice-console gap #12): mic PCM streams over WebSocket
 * to an OpenAI Realtime transcription session (ephemeral token minted by
 * /api/assistant/stt-session), and the transcript arrives AS THE OWNER SPEAKS.
 * Endpointing stays OURS (server VAD disabled): the same adaptive rules the
 * recorder uses — short utterances end at ~1.4s of silence, long dictation
 * gets the full window, 3-minute cap, no-speech abort — because the owner's
 * long-speech guarantees must not depend on a vendor's defaults.
 *
 * Every pre-audio failure rejects start(), and the console falls back to the
 * record-then-upload path — streaming is an upgrade, never a dependency.
 */

const SAMPLE_RATE = 24000
const SPEECH = 0.045
const SILENCE = 0.025

/** Inline AudioWorklet: Float32 frames → the main thread, ~50ms batches. */
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('alma-pcm-tap', PcmTap)
`

function floatTo16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function useStreamingStt(opts: {
  onFinal: (text: string) => void
  onPartial?: (text: string) => void
  onNoSpeech?: () => void
  onError?: (msg: string) => void
  onStart?: () => void
  onStop?: () => void
  silenceMs?: number
  maxMs?: number
  noSpeechMs?: number
}) {
  const [active, setActive] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])

  const sessionRef = useRef<{
    ws: WebSocket
    ctx: AudioContext
    stream: MediaStream
    node: AudioWorkletNode
    timers: ReturnType<typeof setInterval>[]
    finished: boolean
  } | null>(null)

  const teardown = useCallback((s = sessionRef.current) => {
    if (!s) return
    sessionRef.current = null
    s.timers.forEach(clearInterval)
    try { s.node.port.onmessage = null; s.node.disconnect() } catch { /* fine */ }
    s.stream.getTracks().forEach((t) => t.stop())
    void s.ctx.close().catch(() => {})
    try { s.ws.onmessage = null; s.ws.onerror = null; s.ws.onclose = null; s.ws.close() } catch { /* fine */ }
    setActive(false)
    setSeconds(0)
    setLevel(0)
  }, [])

  useEffect(() => () => teardown(), [teardown])

  /** Ends the utterance: commit the audio buffer, await the final transcript. */
  const finish = useCallback((s: NonNullable<typeof sessionRef.current>, aborted: boolean) => {
    if (s.finished) return
    s.finished = true
    s.timers.forEach(clearInterval)
    s.timers = []
    // mic off immediately — privacy first, the socket only waits for text now
    s.stream.getTracks().forEach((t) => t.stop())
    try { s.node.port.onmessage = null; s.node.disconnect() } catch { /* fine */ }
    void s.ctx.close().catch(() => {})
    setActive(false)
    setLevel(0)
    optsRef.current.onStop?.()
    if (aborted) {
      sessionRef.current = null
      try { s.ws.close() } catch { /* fine */ }
      setSeconds(0)
      optsRef.current.onNoSpeech?.()
      return
    }
    try { s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })) } catch { /* fine */ }
    // Safety: if the final transcript never arrives, fail over loudly.
    const t = setTimeout(() => {
      if (sessionRef.current === s) {
        sessionRef.current = null
        try { s.ws.close() } catch { /* fine */ }
        optsRef.current.onError?.('ট্রান্সক্রিপশন সময়মতো এলো না — আবার বলুন।')
      }
    }, 7000)
    s.timers = [t as unknown as ReturnType<typeof setInterval>]
  }, [])

  const stop = useCallback(() => {
    const s = sessionRef.current
    if (s && !s.finished) finish(s, false)
  }, [finish])

  const cancel = useCallback(() => {
    const s = sessionRef.current
    if (s) { s.finished = true; teardown(s) }
  }, [teardown])

  /**
   * Starts a streaming session. REJECTS on any failure before audio flows so
   * the caller can fall back to the recorder path for this turn.
   */
  const start = useCallback(async () => {
    if (sessionRef.current) return
    if (typeof window === 'undefined' || typeof AudioWorkletNode === 'undefined' || typeof WebSocket === 'undefined') {
      throw new Error('streaming unsupported')
    }
    // 1 — ephemeral token
    const tokenRes = await fetch('/api/assistant/stt-session', { method: 'POST' })
    if (!tokenRes.ok) throw new Error(`stt-session ${tokenRes.status}`)
    const { key } = await tokenRes.json() as { key?: string }
    if (!key) throw new Error('no ephemeral key')

    // 2 — mic + worklet
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: SAMPLE_RATE },
    })
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(workletUrl)
    } finally {
      URL.revokeObjectURL(workletUrl)
    }
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'alma-pcm-tap')
    source.connect(node)

    // 3 — realtime socket (browser auth rides the subprotocols; GA shape —
    // model in the query string, no beta protocol)
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-transcribe', [
      'realtime',
      `openai-insecure-api-key.${key}`,
    ])

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('ws timeout')), 6000)
      ws.onopen = () => { clearTimeout(to); resolve() }
      ws.onerror = () => { clearTimeout(to); reject(new Error('ws error')) }
    }).catch((err) => {
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => {})
      try { ws.close() } catch { /* fine */ }
      throw err
    })

    const s = { ws, ctx, stream, node, timers: [] as ReturnType<typeof setInterval>[], finished: false }
    sessionRef.current = s
    setActive(true)
    setSeconds(0)
    optsRef.current.onStart?.()

    // 4 — VAD state (ours, adaptive — mirrors useVoiceRecorder semantics)
    const silenceMs = optsRef.current.silenceMs ?? 2600
    const maxMs = optsRef.current.maxMs ?? 180000
    const noSpeechMs = optsRef.current.noSpeechMs ?? 0
    const startedAt = performance.now()
    let hasSpoken = false
    let firstSpeechAt = 0
    let silenceStart = 0
    let partial = ''

    ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(String(e.data)) as { type?: string; delta?: string; transcript?: string; error?: { message?: string } }
        if (!evt.type) return
        if (evt.type === 'conversation.item.input_audio_transcription.delta' && typeof evt.delta === 'string') {
          partial += evt.delta
          optsRef.current.onPartial?.(partial)
        } else if (evt.type === 'conversation.item.input_audio_transcription.completed') {
          const finalText = (typeof evt.transcript === 'string' && evt.transcript.trim()) ? evt.transcript.trim() : partial.trim()
          if (sessionRef.current === s) {
            sessionRef.current = null
            s.timers.forEach(clearInterval)
            try { ws.close() } catch { /* fine */ }
            setSeconds(0)
            if (finalText) optsRef.current.onFinal(finalText)
            else optsRef.current.onNoSpeech?.()
          }
        } else if (evt.type === 'error') {
          if (sessionRef.current === s) {
            teardown(s)
            optsRef.current.onError?.(evt.error?.message ?? 'স্ট্রিমিং ট্রান্সক্রিপশনে সমস্যা।')
          }
        }
      } catch { /* non-JSON frame */ }
    }
    ws.onclose = () => {
      // Socket died mid-utterance (network blip) — surface as an error so the
      // console can recover; a post-commit close is the normal path.
      if (sessionRef.current === s && !s.finished) {
        teardown(s)
        optsRef.current.onError?.('সংযোগ কেটে গেছে — আবার বলুন।')
      }
    }

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (s.finished || ws.readyState !== WebSocket.OPEN) return
      const f32 = e.data
      // RMS drives both the orb level and our endpointing
      let sum = 0
      for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
      const rms = Math.sqrt(sum / f32.length)
      setLevel(Math.min(1, rms * 9))
      const now = performance.now()
      if (rms > SPEECH) {
        hasSpoken = true
        silenceStart = 0
        if (!firstSpeechAt) firstSpeechAt = now
      } else if (rms < SILENCE && hasSpoken) {
        const speechSpan = firstSpeechAt ? now - firstSpeechAt : 0
        const effSilence = speechSpan < 3000 ? Math.min(1400, silenceMs) : silenceMs
        if (!silenceStart) silenceStart = now
        else if (now - silenceStart >= effSilence) { finish(s, false); return }
      } else if (hasSpoken) {
        silenceStart = 0
      }
      if (noSpeechMs && !hasSpoken && now - startedAt >= noSpeechMs) { finish(s, true); return }
      if (now - startedAt >= maxMs) { finish(s, false); return }
      const pcm = floatTo16(f32)
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64(new Uint8Array(pcm.buffer)) }))
    }

    // seconds ticker (for the "তাড়া নেই" hint) + backgrounding guard
    const tick = setInterval(() => setSeconds((v) => v + 1), 1000)
    s.timers.push(tick)
    const vis = () => { if (document.hidden && sessionRef.current === s && !s.finished) finish(s, false) }
    document.addEventListener('visibilitychange', vis)
    const visCleaner = setInterval(() => {
      if (sessionRef.current !== s) {
        document.removeEventListener('visibilitychange', vis)
        clearInterval(visCleaner)
      }
    }, 1000)
    s.timers.push(visCleaner)
  }, [finish, teardown])

  return { active, seconds, level, start, stop, cancel }
}

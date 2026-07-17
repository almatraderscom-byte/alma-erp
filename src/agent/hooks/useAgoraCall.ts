'use client'

/**
 * useAgoraCall — 1:1 app-to-app VOICE calling for the office intercom.
 *
 * Wraps agora-rtc-sdk-ng (dynamically imported so the ~heavy SDK never runs on
 * the server nor bloats first load) behind a tiny, self-contained hook. Both the
 * owner and staff use the SAME hook: one side `join(channel)`s to start a call,
 * the other `join(channel)`s the same channel to answer. When the peer joins the
 * channel, `remoteJoined` flips and the `callSeconds` timer begins (presence is
 * channel membership, not publish state — so muting never reads as a hang-up).
 *
 * The token + appId come from POST /api/assistant/office/intercom/call-token, so
 * this hook needs no NEXT_PUBLIC_AGORA_APP_ID at runtime.
 *
 * Robustness: every SDK call is wrapped — the hook NEVER throws out of a handler;
 * on failure it sets `error` and moves to state 'error'. `leave()` is idempotent
 * and safe on unmount. iOS WKWebView needs a user gesture to start audio — that is
 * satisfied because join() is invoked from a tap.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { emitWebOfficeCallEvent } from '@/agent/lib/office-call-client-events'

// Loosely-typed handles — we avoid importing the SDK's types at module scope so
// nothing from agora-rtc-sdk-ng is pulled into the server bundle.
type AnyClient = {
  join: (appId: string, channel: string, token: string | null, uid: string | number | null) => Promise<string | number>
  leave: () => Promise<void>
  publish: (tracks: unknown) => Promise<void>
  unpublish: (tracks: unknown) => Promise<void>
  subscribe: (user: unknown, mediaType: string) => Promise<void>
  on: (event: string, cb: (...args: unknown[]) => void) => void
  removeAllListeners: () => void
}
type AnyLocalAudioTrack = {
  setEnabled: (enabled: boolean) => Promise<void>
  setMuted: (muted: boolean) => Promise<void>
  stop: () => void
  close: () => void
}
type AnyRemoteUser = {
  uid: string | number
  audioTrack?: { play: () => void; stop: () => void }
}

export type AgoraCallState = 'idle' | 'connecting' | 'in-call' | 'ended' | 'error'

/**
 * A remote `user-left` may be a transient blip (network hiccup, brief
 * renegotiation), not a real hang-up. Like WhatsApp, we hold the call for a
 * short grace window before declaring the peer gone — if they rejoin within it,
 * nothing drops. Only a still-absent peer after this flips `remoteJoined` false.
 */
const REMOTE_LEFT_GRACE_MS = 5_000

export type UseAgoraCall = {
  state: AgoraCallState
  join: (channel: string) => Promise<void>
  leave: () => Promise<void>
  muted: boolean
  toggleMute: () => Promise<void>
  remoteJoined: boolean
  error: string | null
  callSeconds: number
}

export function useAgoraCall(): UseAgoraCall {
  const [state, setState] = useState<AgoraCallState>('idle')
  const [muted, setMuted] = useState(false)
  const [remoteJoined, setRemoteJoined] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [callSeconds, setCallSeconds] = useState(0)

  const clientRef = useRef<AnyClient | null>(null)
  const localTrackRef = useRef<AnyLocalAudioTrack | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Pending "peer really gone" timer — armed on user-left, cancelled on rejoin.
  const remoteGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelRef = useRef<string | null>(null)
  // Guards against setState after unmount (the hook must be safe to tear down).
  const mountedRef = useRef(true)

  const safeSet = useCallback(<T,>(setter: (v: T) => void, value: T) => {
    if (mountedRef.current) setter(value)
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const clearRemoteGrace = useCallback(() => {
    if (remoteGraceRef.current) {
      clearTimeout(remoteGraceRef.current)
      remoteGraceRef.current = null
    }
  }, [])

  /** Tear down everything. Idempotent — safe to call repeatedly and on unmount. */
  const teardown = useCallback(async () => {
    clearTimer()
    clearRemoteGrace()
    const client = clientRef.current
    const track = localTrackRef.current
    clientRef.current = null
    localTrackRef.current = null

    if (track) {
      try {
        track.stop()
        track.close()
      } catch {
        /* already closed */
      }
    }
    if (client) {
      try {
        client.removeAllListeners()
      } catch {
        /* noop */
      }
      try {
        await client.leave()
      } catch {
        /* already left / never joined */
      }
    }
  }, [clearTimer, clearRemoteGrace])

  const leave = useCallback(async () => {
    const channel = channelRef.current
    if (channel) emitWebOfficeCallEvent({ channel, event: 'client.leave_started', state: 'leaving' })
    await teardown()
    if (channel) emitWebOfficeCallEvent({ channel, event: 'client.local_left', state: 'ended' })
    channelRef.current = null
    safeSet(setRemoteJoined, false)
    safeSet(setMuted, false)
    safeSet(setCallSeconds, 0)
    safeSet(setState, 'ended')
  }, [teardown, safeSet])

  const join = useCallback(
    async (channel: string) => {
      const ch = channel?.trim()
      if (!ch) {
        safeSet(setError, 'channel_required')
        safeSet(setState, 'error')
        return
      }
      // Fresh call — clear any prior session first.
      await teardown()
      channelRef.current = ch
      emitWebOfficeCallEvent({ channel: ch, event: 'client.join_started', state: 'connecting' })
      safeSet(setError, null)
      safeSet(setRemoteJoined, false)
      safeSet(setMuted, false)
      safeSet(setCallSeconds, 0)
      safeSet(setState, 'connecting')

      try {
        // 1) Get appId + token from our server.
        const res = await fetch('/api/assistant/office/intercom/call-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: ch }),
        })
        if (!res.ok) {
          let code = `http_${res.status}`
          try {
            const j = await res.json()
            if (j?.error) code = String(j.error)
          } catch {
            /* non-JSON error body */
          }
          throw new Error(code)
        }
        const { appId, token, uid } = (await res.json()) as {
          appId: string
          channel: string
          token: string
          uid: number
        }

        // 2) Load the SDK lazily (client-only).
        const AgoraRTC = (await import('agora-rtc-sdk-ng')).default
        const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' }) as unknown as AnyClient
        clientRef.current = client

        // 3) Presence = channel membership (user-joined / user-left), NEVER the
        // publish state: muting on either side (web setMuted / native
        // muteLocalAudioStream) fires user-unpublished on the peer, and treating
        // that as "left" used to hang up the whole call the moment anyone muted.
        client.on('user-joined', () => {
          clearRemoteGrace() // peer (re)appeared — cancel any pending "gone" timer
          if (mountedRef.current) {
            setRemoteJoined(true)
            setState('in-call')
          }
          emitWebOfficeCallEvent({ channel: ch, event: 'client.peer_joined', state: 'in-call' })
        })
        client.on('user-left', () => {
          // Don't hang up on a transient leave — hold for a grace window and only
          // flip `remoteJoined` false if the peer is still absent (real hang-up).
          clearRemoteGrace()
          remoteGraceRef.current = setTimeout(() => {
            remoteGraceRef.current = null
            safeSet(setRemoteJoined, false)
            emitWebOfficeCallEvent({ channel: ch, event: 'client.peer_left', state: 'reconnecting' })
          }, REMOTE_LEFT_GRACE_MS)
        })
        // Remote audio → subscribe + play (re-fires after an unmute too).
        client.on('user-published', async (...args: unknown[]) => {
          const user = args[0] as AnyRemoteUser
          const mediaType = args[1] as string
          if (mediaType !== 'audio') return
          clearRemoteGrace() // audio flowing again — peer is present
          try {
            await client.subscribe(user, 'audio')
            user.audioTrack?.play()
            if (mountedRef.current) {
              setRemoteJoined(true)
              setState('in-call')
            }
          } catch {
            /* subscribe race — remote may have left; ignore */
          }
        })

        // 4) Join the channel (uid 0 → Agora assigns one).
        await client.join(appId, ch, token, uid ?? null)
        emitWebOfficeCallEvent({ channel: ch, event: 'client.local_joined', state: 'connecting' })

        // 5) Publish our microphone — HD voice (48 kHz mono, high bitrate) with
        // echo cancellation / noise suppression / auto gain all explicitly on.
        const micTrack = (await AgoraRTC.createMicrophoneAudioTrack({
          encoderConfig: 'high_quality',
          AEC: true,
          ANS: true,
          AGC: true,
        })) as unknown as AnyLocalAudioTrack
        localTrackRef.current = micTrack
        await client.publish(micTrack)

        // Joined & publishing. We stay 'connecting' visually until the remote is
        // heard (user-published flips us to 'in-call'); but if a remote was already
        // in the channel the event fires immediately above.
        if (mountedRef.current) {
          setState((prev) => (prev === 'connecting' ? 'connecting' : prev))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'call_failed'
        // Clean up any partial session so a retry starts fresh.
        await teardown()
        safeSet(setError, msg)
        safeSet(setState, 'error')
        emitWebOfficeCallEvent({
          channel: ch,
          event: 'client.media_error',
          state: 'error',
          metadata: { code: msg },
        })
      }
    },
    [teardown, safeSet, clearRemoteGrace],
  )

  const toggleMute = useCallback(async () => {
    const track = localTrackRef.current
    if (!track) return
    const next = !muted
    try {
      // setMuted keeps the track published (silent frames) — instant toggle, no
      // mic re-acquisition, and the peer never sees a "left"-like transition.
      await track.setMuted(next)
      safeSet(setMuted, next)
    } catch {
      /* toggling failed — leave state unchanged */
    }
  }, [muted, safeSet])

  // Run the call timer only while the remote is present.
  useEffect(() => {
    if (remoteJoined) {
      clearTimer()
      timerRef.current = setInterval(() => {
        if (mountedRef.current) setCallSeconds((s) => s + 1)
      }, 1000)
    } else {
      clearTimer()
    }
    return clearTimer
  }, [remoteJoined, clearTimer])

  // Teardown on unmount — never leak a live call.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void teardown()
    }
  }, [teardown])

  useEffect(() => {
    const onVisibility = () => {
      const channel = channelRef.current
      if (!channel) return
      emitWebOfficeCallEvent({
        channel,
        event: document.hidden ? 'client.app_backgrounded' : 'client.app_foregrounded',
        state,
      })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [state])

  return { state, join, leave, muted, toggleMute, remoteJoined, error, callSeconds }
}

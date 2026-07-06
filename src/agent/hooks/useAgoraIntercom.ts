'use client'

/**
 * useAgoraIntercom — the LIVE walkie-talkie channel (distinct from the 1:1 call
 * hook). Everyone in the office shares ONE Agora channel (itc_live_<businessId>):
 *
 *  • Staff = listeners: joinAsListener() subscribes to the channel and plays any
 *    incoming audio LIVE. The join is triggered by a tap, which unlocks the
 *    WKWebView / mobile-browser audio session — this is the ONLY way autoplay can
 *    work later, and the reason a record→poll design could never truly auto-blare.
 *  • Owner = broadcaster: startBroadcast() joins + publishes the mic; every joined
 *    listener hears it INSTANTLY. stopBroadcast() unpublishes and leaves.
 *
 * `remoteSpeaking` flips true while someone is publishing audio — the staff UI
 * uses it to show a live "🔊 বস বলছেন" indicator. The hook never throws; failures
 * set `error`. Teardown is idempotent and runs on unmount (never leak a hot mic).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type AnyClient = {
  join: (appId: string, channel: string, token: string | null, uid: string | number | null) => Promise<string | number>
  leave: () => Promise<void>
  publish: (tracks: unknown) => Promise<void>
  unpublish: (tracks: unknown) => Promise<void>
  subscribe: (user: unknown, mediaType: string) => Promise<void>
  on: (event: string, cb: (...args: unknown[]) => void) => void
  removeAllListeners: () => void
}
type AnyLocalAudioTrack = { setEnabled: (e: boolean) => Promise<void>; stop: () => void; close: () => void }
type AnyRemoteUser = { uid: string | number; audioTrack?: { play: () => void; stop: () => void } }

export type UseAgoraIntercom = {
  listening: boolean
  broadcasting: boolean
  /** Someone (the owner) is publishing audio on the channel right now. */
  remoteSpeaking: boolean
  error: string | null
  joinAsListener: (channel: string) => Promise<void>
  /**
   * Publish live audio. Pass an existing mic MediaStreamTrack (e.g. the one the
   * owner's MediaRecorder is already using) so we DON'T open a second
   * getUserMedia — a double mic grab fails on iOS WKWebView. Falls back to
   * Agora's own mic track if none is supplied.
   */
  startBroadcast: (channel: string, externalTrack?: MediaStreamTrack | null) => Promise<void>
  stopBroadcast: () => Promise<void>
  leave: () => Promise<void>
}

async function mintToken(channel: string): Promise<{ appId: string; token: string; uid: number }> {
  const res = await fetch('/api/assistant/office/intercom/call-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  })
  if (!res.ok) {
    let code = `http_${res.status}`
    try {
      const j = await res.json()
      if (j?.error) code = String(j.error)
    } catch {
      /* non-JSON */
    }
    throw new Error(code)
  }
  return (await res.json()) as { appId: string; token: string; uid: number }
}

export function useAgoraIntercom(): UseAgoraIntercom {
  const [listening, setListening] = useState(false)
  const [broadcasting, setBroadcasting] = useState(false)
  const [remoteSpeaking, setRemoteSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<AnyClient | null>(null)
  const micRef = useRef<AnyLocalAudioTrack | null>(null)
  const channelRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  const set = useCallback(<T,>(setter: (v: T) => void, v: T) => {
    if (mountedRef.current) setter(v)
  }, [])

  const teardown = useCallback(async () => {
    const client = clientRef.current
    const mic = micRef.current
    clientRef.current = null
    micRef.current = null
    channelRef.current = null
    if (mic) {
      try {
        mic.stop()
        mic.close()
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
        /* already left */
      }
    }
  }, [])

  const leave = useCallback(async () => {
    await teardown()
    set(setListening, false)
    set(setBroadcasting, false)
    set(setRemoteSpeaking, false)
  }, [teardown, set])

  /** Ensure a joined client on `channel` (subscriber wiring included). */
  const ensureJoined = useCallback(
    async (channel: string): Promise<AnyClient> => {
      if (clientRef.current && channelRef.current === channel) return clientRef.current
      await teardown()

      const { appId, token, uid } = await mintToken(channel)
      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' }) as unknown as AnyClient
      clientRef.current = client
      channelRef.current = channel

      client.on('user-published', async (...args: unknown[]) => {
        const user = args[0] as AnyRemoteUser
        const mediaType = args[1] as string
        if (mediaType !== 'audio') return
        try {
          await client.subscribe(user, 'audio')
          user.audioTrack?.play()
          set(setRemoteSpeaking, true)
        } catch {
          /* subscribe race */
        }
      })
      client.on('user-unpublished', (...args: unknown[]) => {
        if ((args[1] as string) === 'audio') set(setRemoteSpeaking, false)
      })
      client.on('user-left', () => set(setRemoteSpeaking, false))

      await client.join(appId, channel, token, uid ?? null)
      return client
    },
    [teardown, set],
  )

  // Staff: subscribe-only. The tap that calls this unlocks audio playback.
  const joinAsListener = useCallback(
    async (channel: string) => {
      const ch = channel?.trim()
      if (!ch) return
      set(setError, null)
      try {
        await ensureJoined(ch)
        set(setListening, true)
      } catch (err) {
        await teardown()
        set(setError, err instanceof Error ? err.message : 'intercom_join_failed')
        set(setListening, false)
      }
    },
    [ensureJoined, teardown, set],
  )

  // Owner: join + publish mic for the duration of the press.
  const startBroadcast = useCallback(
    async (channel: string, externalTrack?: MediaStreamTrack | null) => {
      const ch = channel?.trim()
      if (!ch) return
      set(setError, null)
      try {
        const client = await ensureJoined(ch)
        const AgoraRTC = (await import('agora-rtc-sdk-ng')).default
        // Reuse the caller's mic track when given (no second getUserMedia — that
        // fails on iOS); otherwise let Agora open its own.
        const mic = (
          externalTrack
            ? AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: externalTrack })
            : await AgoraRTC.createMicrophoneAudioTrack()
        ) as unknown as AnyLocalAudioTrack
        micRef.current = mic
        await client.publish(mic)
        set(setBroadcasting, true)
      } catch (err) {
        set(setError, err instanceof Error ? err.message : 'broadcast_failed')
        set(setBroadcasting, false)
        // Free the half-open mic but keep listening state if we were joined.
        const mic = micRef.current
        micRef.current = null
        if (mic) {
          try {
            mic.stop()
            mic.close()
          } catch {
            /* noop */
          }
        }
      }
    },
    [ensureJoined, set],
  )

  const stopBroadcast = useCallback(async () => {
    const client = clientRef.current
    const mic = micRef.current
    micRef.current = null
    set(setBroadcasting, false)
    if (mic) {
      try {
        if (client) await client.unpublish(mic)
      } catch {
        /* already unpublished */
      }
      try {
        mic.stop()
        mic.close()
      } catch {
        /* noop */
      }
    }
    // The owner only joins to talk — leave so we don't hold an idle connection.
    await teardown()
    set(setListening, false)
    set(setRemoteSpeaking, false)
  }, [teardown, set])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void teardown()
    }
  }, [teardown])

  return { listening, broadcasting, remoteSpeaking, error, joinAsListener, startBroadcast, stopBroadcast, leave }
}

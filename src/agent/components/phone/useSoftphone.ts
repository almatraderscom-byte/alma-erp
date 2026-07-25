'use client'

/**
 * Browser softphone — the SIP side of taking real customer calls inside the ERP.
 *
 * Registers this staff member's Asterisk extension over the TLS websocket, then answers and
 * places calls with the browser's own microphone. No SIM, no handset, no per-seat fee.
 *
 * Kept as a hook (rather than inside a component) because the same call state has to drive
 * both the dialler UI and the screen-pop that shows who is calling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  type Session,
} from 'sip.js'

export type PhoneStatus = 'idle' | 'connecting' | 'registered' | 'ringing' | 'in-call' | 'error'

export interface SoftphoneState {
  status: PhoneStatus
  extension: string | null
  /** Who is on the line (caller-ID for an incoming call, dialled number for outgoing). */
  peer: string | null
  incoming: boolean
  error: string | null
  /** Seconds since the call was answered, for the on-screen timer. */
  seconds: number
}

interface Credentials {
  extension: string
  password: string
  realm: string
  wsUrl: string
  displayName?: string
}

/** Pull the SIP number out of a header like `"Someone" <sip:01712345678@realm>`. */
function peerFromUri(raw: string): string {
  const m = raw.match(/sip:([^@]+)@/i)
  return m ? m[1] : raw
}

export function useSoftphone() {
  const [state, setState] = useState<SoftphoneState>({
    status: 'idle', extension: null, peer: null, incoming: false, error: null, seconds: 0,
  })
  const uaRef = useRef<UserAgent | null>(null)
  const registererRef = useRef<Registerer | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const patch = useCallback((p: Partial<SoftphoneState>) => setState((s) => ({ ...s, ...p })), [])

  /** Attach the negotiated remote audio to a hidden <audio> element so it is audible. */
  const attachRemoteAudio = useCallback((session: Session) => {
    const pc = (session.sessionDescriptionHandler as unknown as { peerConnection?: RTCPeerConnection })
      ?.peerConnection
    if (!pc || !audioRef.current) return
    const remote = new MediaStream()
    pc.getReceivers().forEach((r) => { if (r.track) remote.addTrack(r.track) })
    audioRef.current.srcObject = remote
    void audioRef.current.play().catch(() => { /* autoplay policy — user gesture will retry */ })
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const wireSession = useCallback((session: Session, peer: string, incoming: boolean) => {
    sessionRef.current = session
    patch({ peer, incoming, status: 'ringing', seconds: 0 })
    session.stateChange.addListener((s) => {
      if (s === SessionState.Established) {
        attachRemoteAudio(session)
        patch({ status: 'in-call', seconds: 0 })
        stopTimer()
        timerRef.current = setInterval(() => setState((st) => ({ ...st, seconds: st.seconds + 1 })), 1000)
      }
      if (s === SessionState.Terminated) {
        stopTimer()
        sessionRef.current = null
        if (audioRef.current) audioRef.current.srcObject = null
        patch({ status: 'registered', peer: null, incoming: false, seconds: 0 })
      }
    })
  }, [attachRemoteAudio, patch, stopTimer])

  /** Register the extension. Called on an explicit user action so mic permission is in context. */
  const connect = useCallback(async () => {
    if (uaRef.current) return
    patch({ status: 'connecting', error: null })
    try {
      const res = await fetch('/api/assistant/phone/credentials')
      const cred = (await res.json()) as Credentials & { ok?: boolean; error?: string }
      if (!res.ok || !cred.extension) throw new Error(cred.error || 'could not get a phone identity')

      const uri = UserAgent.makeURI(`sip:${cred.extension}@${cred.realm}`)
      if (!uri) throw new Error('bad SIP address')
      const ua = new UserAgent({
        uri,
        transportOptions: { server: cred.wsUrl },
        authorizationUsername: cred.extension,
        authorizationPassword: cred.password,
        displayName: cred.displayName || `ALMA ${cred.extension}`,
        // Audio only: this is a phone, and asking for camera permission would be alarming.
        sessionDescriptionHandlerFactoryOptions: { constraints: { audio: true, video: false } },
        delegate: {
          onInvite: (invitation: Invitation) => {
            // Only one call at a time: a second one is rejected rather than silently ignored,
            // so the caller hears busy instead of ringing into nothing.
            if (sessionRef.current) { void invitation.reject(); return }
            wireSession(invitation, peerFromUri(invitation.remoteIdentity.uri.toString()), true)
          },
        },
      })
      uaRef.current = ua
      await ua.start()
      const registerer = new Registerer(ua)
      registererRef.current = registerer
      registerer.stateChange.addListener((s) => {
        if (s === RegistererState.Registered) patch({ status: 'registered', extension: cred.extension })
        if (s === RegistererState.Unregistered) patch({ status: 'idle' })
      })
      await registerer.register()
    } catch (err) {
      uaRef.current = null
      patch({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }, [patch, wireSession])

  const disconnect = useCallback(async () => {
    stopTimer()
    try { await registererRef.current?.unregister() } catch { /* */ }
    try { await uaRef.current?.stop() } catch { /* */ }
    registererRef.current = null
    uaRef.current = null
    sessionRef.current = null
    patch({ status: 'idle', peer: null, incoming: false, extension: null, seconds: 0 })
  }, [patch, stopTimer])

  const answer = useCallback(async () => {
    const session = sessionRef.current
    if (!session || !(session instanceof Invitation)) return
    await session.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } })
  }, [])

  const hangup = useCallback(async () => {
    const session = sessionRef.current
    if (!session) return
    try {
      if (session instanceof Invitation && session.state === SessionState.Initial) await session.reject()
      else if (session.state === SessionState.Established) await session.bye()
      else if (session instanceof Inviter) await session.cancel()
    } catch { /* already gone */ }
  }, [])

  /**
   * Place a call. `number` is either a 4-digit colleague extension or a Bangladeshi number;
   * the dialplan the extension lands in accepts nothing else, so a typo cannot become an
   * expensive international call.
   */
  const dial = useCallback(async (number: string) => {
    const ua = uaRef.current
    if (!ua || sessionRef.current) return
    const digits = number.replace(/\D/g, '')
    if (!digits) return
    // Address the target on the same realm this UA registered with.
    const uri = UserAgent.makeURI(`sip:${digits}@${ua.configuration.uri?.host ?? ''}`)
    if (!uri) { patch({ error: 'নম্বরটি বোঝা গেল না' }); return }
    const inviter = new Inviter(ua, uri, {
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    })
    wireSession(inviter, digits, false)
    await inviter.invite()
  }, [patch, wireSession])

  useEffect(() => () => { void disconnect() }, [disconnect])

  const audioElement = useMemo(
    () => ({ ref: audioRef as React.RefObject<HTMLAudioElement> }),
    [],
  )

  return { state, connect, disconnect, answer, hangup, dial, audioElement }
}

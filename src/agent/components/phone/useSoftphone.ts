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
  muted: boolean
  /** True when the browser lets us pick an output device (desktop Chrome; not mobile WebViews). */
  canSwitchSpeaker: boolean
  speakerOn: boolean
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
    muted: false, canSwitchSpeaker: false, speakerOn: false,
  })
  const uaRef = useRef<UserAgent | null>(null)
  const registererRef = useRef<Registerer | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const answeredRef = useRef(false)
  const failureRef = useRef<string | null>(null)

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

  /**
   * Get the websocket back, then let `onConnect` re-register.
   *
   * Backed off and capped: a laptop waking after an hour should still find its phone, and a
   * gateway that is genuinely down should not be hammered once a second all day. `closingRef`
   * stops us fighting a deliberate hang-up-and-disconnect.
   */
  const reconnectRef = useRef<{ tries: number; timer: ReturnType<typeof setTimeout> | null }>({ tries: 0, timer: null })
  const closingRef = useRef(false)

  const reconnect = useCallback(() => {
    const ua = uaRef.current
    const st = reconnectRef.current
    if (!ua || closingRef.current || st.timer) return
    st.tries += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(st.tries, 5))
    st.timer = setTimeout(() => {
      st.timer = null
      if (!uaRef.current || closingRef.current) return
      uaRef.current.reconnect().then(
        () => { reconnectRef.current.tries = 0 },
        () => { reconnect() },
      )
    }, delay)
  }, [])

  const wireSession = useCallback((session: Session, peer: string, incoming: boolean) => {
    sessionRef.current = session
    patch({ peer, incoming, status: 'ringing', seconds: 0, error: null })
    session.stateChange.addListener((s) => {
      if (s === SessionState.Established) {
        answeredRef.current = true
        failureRef.current = null
        attachRemoteAudio(session)
        patch({ status: 'in-call', seconds: 0 })
        stopTimer()
        timerRef.current = setInterval(() => setState((st) => ({ ...st, seconds: st.seconds + 1 })), 1000)
      }
      if (s === SessionState.Terminated) {
        stopTimer()
        // Say WHY the call ended. Silence here is a real failure mode: dialling a colleague
        // whose tab is closed simply did nothing, with no way to tell that from a broken
        // phone (the owner hit exactly this — "1001 e test dilam kichui to ashlo na").
        const reason = !answeredRef.current ? failureRef.current : null
        sessionRef.current = null
        answeredRef.current = false
        failureRef.current = null
        if (audioRef.current) audioRef.current.srcObject = null
        patch({ status: 'registered', peer: null, incoming: false, seconds: 0, error: reason, muted: false })
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
          /*
           * RE-REGISTER ON EVERY RECONNECT. This is not housekeeping — without it the phone
           * goes half-dead and says nothing.
           *
           * Asterisk cannot OPEN a websocket; it can only accept one. So the contact it stores
           * at registration time is bound to that exact socket, and when the socket dies —
           * a gateway restart, a network blip, a laptop lid — anything Asterisk needs to SEND
           * lands nowhere: an incoming call never rings, and the BYE at the end of a call
           * never arrives. Meanwhile everything the browser INITIATES still works over the new
           * socket, so the phone looks fine. The owner hit precisely this on 2026-07-26: his
           * outgoing call connected, the far end hung up, Asterisk tore the channel down at
           * 18 s, and his screen kept counting to 0:29 until he hung up by hand.
           *
           * Registering again is what replaces the stale contact (the AOR is max_contacts=1,
           * remove_existing=yes, so the new one evicts it).
           */
          onConnect: () => {
            // Null on the very first connect — connect() happens inside ua.start(), before the
            // Registerer exists, and that first registration is done explicitly below.
            void registererRef.current?.register().catch(() => { /* the retry loop covers it */ })
            patch({ error: null })
          },
          onDisconnect: () => {
            // Never keep claiming "registered" while the socket is gone: a screen that asserts
            // a working phone is worse than one that admits it is reconnecting.
            patch({ status: 'connecting', error: null })
            reconnect()
          },
          onInvite: (invitation: Invitation) => {
            // Only one call at a time: a second one is rejected rather than silently ignored,
            // so the caller hears busy instead of ringing into nothing.
            if (sessionRef.current) { void invitation.reject(); return }
            wireSession(invitation, peerFromUri(invitation.remoteIdentity.uri.toString()), true)
          },
        },
      })
      uaRef.current = ua
      closingRef.current = false
      await ua.start()
      // A short expiry is the belt to the reconnect handler's braces: even if a reconnect is
      // ever missed, Asterisk's contact goes stale for three minutes rather than for the ten
      // that sip.js defaults to. The trunk taught this lesson expensively — a binding is only
      // as honest as its refresh interval.
      const registerer = new Registerer(ua, { expires: 180 })
      registererRef.current = registerer
      registerer.stateChange.addListener((s) => {
        if (s === RegistererState.Registered) patch({ status: 'registered', extension: cred.extension, error: null })
        // Only report "off" for a deliberate unregister. Losing the socket is a reconnect, not
        // an idle phone, and onDisconnect has already put the UI in 'connecting'.
        if (s === RegistererState.Unregistered && closingRef.current) patch({ status: 'idle' })
      })
      await registerer.register()
    } catch (err) {
      uaRef.current = null
      patch({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }, [patch, reconnect, wireSession])

  const disconnect = useCallback(async () => {
    stopTimer()
    closingRef.current = true
    if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null }
    reconnectRef.current.tries = 0
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
  /** The peer connection for the live call, or null. */
  const peerConnection = useCallback((): RTCPeerConnection | null => {
    const sdh = sessionRef.current?.sessionDescriptionHandler as unknown as
      { peerConnection?: RTCPeerConnection } | undefined
    return sdh?.peerConnection ?? null
  }, [])

  /** Mute/unmute the microphone. Disabling the track is instant and keeps the call up. */
  const toggleMute = useCallback(() => {
    const pc = peerConnection()
    if (!pc) return
    let muted = false
    pc.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') {
        sender.track.enabled = !sender.track.enabled
        muted = !sender.track.enabled
      }
    })
    patch({ muted })
  }, [patch, peerConnection])

  /**
   * Switch between the earpiece/default output and the loudspeaker. Only desktop browsers
   * expose output selection; on a phone the OS owns it, so the button is hidden rather than
   * shown-but-dead.
   */
  const toggleSpeaker = useCallback(async () => {
    const el = audioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
    if (!el?.setSinkId) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const outputs = devices.filter((d) => d.kind === 'audiooutput')
      const next = state.speakerOn
        ? outputs.find((d) => d.deviceId === 'default') ?? outputs[0]
        : outputs.find((d) => /speaker/i.test(d.label)) ?? outputs[outputs.length - 1]
      if (next) { await el.setSinkId(next.deviceId); patch({ speakerOn: !state.speakerOn }) }
    } catch { /* device switching is a convenience, never break the call over it */ }
  }, [patch, state.speakerOn])

  /** Send a keypad tone mid-call — needed for the automated menus banks and couriers use. */
  const sendDtmf = useCallback((digit: string) => {
    const session = sessionRef.current
    if (!session || session.state !== SessionState.Established) return
    try {
      session.info({ requestOptions: { body: {
        contentDisposition: 'render', contentType: 'application/dtmf-relay',
        content: `Signal=${digit}\r\nDuration=100`,
      } } })
    } catch { /* the tone is best-effort */ }
  }, [])

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
    answeredRef.current = false
    failureRef.current = null
    await inviter.invite({
      requestDelegate: {
        // Turn SIP status codes into something a non-technical user can act on.
        onReject: (response) => {
          const code = response.message.statusCode
          failureRef.current =
            code === 404 ? 'এই নম্বর/এক্সটেনশন নেই'
              : code === 480 || code === 408 ? 'কেউ ধরেননি — সহকর্মীর ফোন/ট্যাব বন্ধ থাকতে পারে'
                : code === 486 ? 'লাইন ব্যস্ত'
                  : code === 603 ? 'কল ফিরিয়ে দেওয়া হয়েছে'
                    : code === 403 ? 'এই নম্বরে কল করার অনুমতি নেই'
                      : `কল যায়নি (SIP ${code})`
        },
      },
    })
  }, [patch, wireSession])

  useEffect(() => () => { void disconnect() }, [disconnect])

  const audioElement = useMemo(
    () => ({ ref: audioRef as React.RefObject<HTMLAudioElement> }),
    [],
  )

  // Output switching only exists on desktop; detect once so the UI can hide the control.
  useEffect(() => {
    const el = audioRef.current as (HTMLAudioElement & { setSinkId?: unknown }) | null
    patch({ canSwitchSpeaker: typeof el?.setSinkId === 'function' })
  }, [patch, state.status])

  return { state, connect, disconnect, answer, hangup, dial, toggleMute, toggleSpeaker, sendDtmf, audioElement }
}

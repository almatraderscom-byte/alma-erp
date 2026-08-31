'use client'

/**
 * Headless softphone — the audio engine behind the NATIVE iOS phone screen.
 *
 * The native app renders its own SwiftUI dialler (PhoneScreen); the actual SIP
 * registration and WebRTC audio still run here, in a hidden WKWebView loading
 * /agent/phone?headless=1, because this stack (sip.js + the reconnect/keep-alive
 * lessons in useSoftphone) is live-proven and a native SIP stack would buy nothing.
 *
 * Contract with PhoneEngine.swift (keep the two in lock-step):
 *  - native → page:   window.__almaPhone.{connect|disconnect|dial(n)|answer|hangup|
 *                     toggleMute|sendDtmf(d)}
 *  - page → native:   webkit.messageHandlers.almaPhone.postMessage(state) on every
 *                     state change, plus {ready:true} once the bridge is installed.
 *
 * Renders only the hidden <audio> sink. No layout, no header — the WebView is
 * invisible and this page must stay black-empty even if it ever flashes on screen.
 */
import { useEffect } from 'react'
import { useSoftphone } from './useSoftphone'

type BridgeWindow = Window & {
  __almaPhone?: Record<string, unknown>
  webkit?: { messageHandlers?: { almaPhone?: { postMessage: (m: unknown) => void } } }
}

export default function SoftphoneHeadless() {
  const { state, connect, disconnect, answer, hangup, dial, toggleMute, sendDtmf, audioElement } =
    useSoftphone()

  // Install the command surface the native side calls into.
  useEffect(() => {
    const w = window as BridgeWindow
    const api = {
      connect: () => void connect(),
      disconnect: () => void disconnect(),
      dial: (n: string) => void dial(String(n)),
      answer: () => void answer(),
      hangup: () => void hangup(),
      toggleMute: () => toggleMute(),
      sendDtmf: (d: string) => sendDtmf(String(d)),
    }
    w.__almaPhone = api
    try { w.webkit?.messageHandlers?.almaPhone?.postMessage({ ready: true }) } catch { /* not in the app */ }
    return () => { if (w.__almaPhone === api) delete w.__almaPhone }
  }, [answer, connect, dial, disconnect, hangup, sendDtmf, toggleMute])

  // Mirror every state change up to the native screen.
  useEffect(() => {
    try {
      (window as BridgeWindow).webkit?.messageHandlers?.almaPhone?.postMessage({
        status: state.status,
        extension: state.extension,
        peer: state.peer,
        incoming: state.incoming,
        muted: state.muted,
        seconds: state.seconds,
        error: state.error,
      })
    } catch { /* page opened outside the app — nothing to tell */ }
  }, [state])

  // The native screen shows its own "ফোন চালু করো"; auto-connecting here would fire the
  // system mic prompt with no visible context. Native calls connect() when the user asks.
  return <audio ref={audioElement.ref} autoPlay playsInline className="hidden" />
}

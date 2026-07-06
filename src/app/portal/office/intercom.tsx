'use client'

/**
 * Office Live Intercom — walkie-talkie inside the office group chat.
 *
 * Owner: press-and-hold PTT in the dock → MediaRecorder → POST multipart →
 * voice bubble lands in the chat with live per-staff receipts; a transcribe
 * kick fills the agent transcript a few seconds later.
 *
 * Staff: fast poll; a fresh unconfirmed broadcast raises a full-screen
 * takeover (iOS incoming-call style) that auto-plays the audio and demands a
 * one-tap confirm. Older unconfirmed ones stay confirmable on the bubble.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tapHaptic, successHaptic, warningHaptic } from '@/lib/ui-haptics'
import { useAgoraCall } from '@/agent/hooks/useAgoraCall'
import { INTERCOM_CSS } from './intercom-css'

const POLL_MS = 6_000
/** A call broadcast only "rings" this long; older = a missed call. */
const CALL_RING_MS = 60_000
/** The Agora channel for a call is derived from its broadcast id (no signaling column needed). */
const callChannel = (broadcastId: string) => `itc_${broadcastId}`
const MIN_HOLD_MS = 900
const MAX_REC_MS = 180_000
/** Auto-play on staff phones only while the broadcast is truly "live". */
const AUTOPLAY_FRESH_MS = 120_000
const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])
const fmtDur = (s: number) => `${bn(Math.floor(s / 60))}:${bn(String(s % 60).padStart(2, '0'))}`

/**
 * Client-side office-hours gate (Asia/Dhaka, mirrors the server's day-shift
 * window 08:00–22:00). Outside it a takeover still SHOWS, but never
 * auto-blasts audio/beeps — walkie-talkie override is an office-time behavior.
 */
function isOfficeHoursDhaka(): boolean {
  try {
    const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Dhaka' }).format(new Date()))
    return h >= 8 && h < 22
  } catch {
    return true
  }
}

export type ItcReceipt = {
  staffId: string
  staffName: string
  deliveredAt: string | null
  playedAt: string | null
  confirmedAt: string | null
}
export type ItcBroadcast = {
  id: string
  kind: 'voice' | 'urgent' | 'call'
  audioUrl: string | null
  mediaType: string | null
  durationSec: number
  transcript: string | null
  targetStaffId: string | null
  createdAt: string
  receipts: ItcReceipt[]
  mine: { deliveredAt: string | null; playedAt: string | null; confirmedAt: string | null } | null
}
type ItcStaff = { id: string; name: string; phone: string | null }
type ItcFeed = { broadcasts: ItcBroadcast[]; staff: ItcStaff[] }

/** iOS WKWebView records mp4/aac; Chrome webm/opus. Probe in that spirit. */
function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac',
    'audio/ogg;codecs=opus',
  ]
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return ''
}

function extForMime(mime: string): string {
  if (/mp4|aac|m4a/i.test(mime)) return 'm4a'
  if (/ogg/i.test(mime)) return 'ogg'
  return 'webm'
}

/** Stable avatar tint per staff — same person, same colour everywhere. */
const AV_GRADS = [
  'linear-gradient(135deg,#6366f1,#8b5cf6)',
  'linear-gradient(135deg,#0ea5e9,#06b6d4)',
  'linear-gradient(135deg,#10b981,#059669)',
  'linear-gradient(135deg,#f59e0b,#d97706)',
  'linear-gradient(135deg,#ec4899,#be185d)',
  'linear-gradient(135deg,#14b8a6,#0d9488)',
]
const avInitial = (name: string) => (name.trim()[0] || '?').toUpperCase()
function avGrad(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AV_GRADS[h % AV_GRADS.length]
}

type PttState = 'idle' | 'starting' | 'live' | 'cancel' | 'sending'

export function useIntercom(self: 'owner' | 'staff') {
  const [feed, setFeed] = useState<ItcFeed>({ broadcasts: [], staff: [] })
  const [ptt, setPtt] = useState<PttState>('idle')
  const [recSecs, setRecSecs] = useState(0)
  const [target, setTarget] = useState<string>('all')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  // Live call (Agora). activeCallId = the broadcast whose channel we're in.
  const callApi = useAgoraCall()
  const [activeCallId, setActiveCallId] = useState<string | null>(null)
  const [callPeer, setCallPeer] = useState<string>('')
  const [callStarting, setCallStarting] = useState(false)

  const mrRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelRef = useRef(false)
  const pttRef = useRef<PttState>('idle')
  pttRef.current = ptt

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/office/intercom', { cache: 'no-store' })
      if (res.ok) setFeed((await res.json()) as ItcFeed)
    } catch {
      /* best-effort poll */
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) load()
    }, POLL_MS)
    const onVis = () => {
      if (!document.hidden) load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load])

  /* ── owner: PTT recording ── */
  const cleanupRec = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    timerRef.current = null
    maxTimerRef.current = null
    const mr = mrRef.current
    if (mr) {
      mr.stream.getTracks().forEach((t) => t.stop())
      mrRef.current = null
    }
  }, [])

  const sendBlob = useCallback(
    async (blob: Blob, mime: string, durationSec: number, targetStaffId: string) => {
      setPtt('sending')
      try {
        const fd = new FormData()
        fd.append('audio', new File([blob], `ptt.${extForMime(mime)}`, { type: mime }))
        fd.append('durationSec', String(durationSec))
        if (targetStaffId !== 'all') fd.append('targetStaffId', targetStaffId)
        const res = await fetch('/api/assistant/office/intercom', { method: 'POST', body: fd })
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null
          setError(data?.error === 'no_target_staff' ? 'কোনো সক্রিয় স্টাফ নেই' : 'পাঠানো যায়নি — আবার চেষ্টা করুন')
          return
        }
        setError(null)
        successHaptic()
        const { id } = (await res.json()) as { id: string }
        await load()
        // Fire the agent transcript in the background; refresh when it lands.
        fetch('/api/assistant/office/intercom/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
          .then(() => load())
          .catch(() => {})
      } finally {
        setPtt('idle')
      }
    },
    [load],
  )

  const startPtt = useCallback(async () => {
    if (pttRef.current !== 'idle') return
    setError(null)
    setPtt('starting')
    cancelRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // The press may have ended while the permission prompt was up.
      if (cancelRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        setPtt('idle')
        return
      }
      const mime = pickRecorderMime()
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      mrRef.current = mr
      chunksRef.current = []
      startedAtRef.current = Date.now()
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onstop = () => {
        const heldMs = Date.now() - startedAtRef.current
        const finalMime = (mr.mimeType || mime || 'audio/webm').split(';')[0]
        const blob = new Blob(chunksRef.current, { type: finalMime })
        const wasCancel = cancelRef.current
        cleanupRec()
        if (wasCancel || heldMs < MIN_HOLD_MS || blob.size === 0) {
          setPtt('idle')
          if (!wasCancel && heldMs < MIN_HOLD_MS) setError('খুব ছোট — চেপে ধরে কথা বলুন')
          return
        }
        void sendBlob(blob, finalMime, Math.max(1, Math.round(heldMs / 1000)), target)
      }
      mr.start(250)
      tapHaptic()
      setRecSecs(0)
      setPtt('live')
      timerRef.current = setInterval(() => {
        setRecSecs(Math.floor((Date.now() - startedAtRef.current) / 1000))
      }, 250)
      maxTimerRef.current = setTimeout(() => {
        if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop()
      }, MAX_REC_MS)
    } catch {
      setPtt('idle')
      setError('মাইক্রোফোন চালু করা যায়নি — অনুমতি দিন')
    }
  }, [cleanupRec, sendBlob, target])

  const stopPtt = useCallback((cancel: boolean) => {
    cancelRef.current = cancel || cancelRef.current
    const mr = mrRef.current
    if (mr && mr.state !== 'inactive') mr.stop()
    else if (pttRef.current === 'starting') {
      // getUserMedia still pending — flag it so the start path aborts.
      cancelRef.current = true
    }
  }, [])

  // Never leave a hot mic if the component unmounts mid-recording.
  useEffect(() => () => cleanupRec(), [cleanupRec])

  const sendUrgent = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/office/intercom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'urgent', targetStaffId: target === 'all' ? undefined : target }),
      })
      if (res.ok) {
        setError(null)
        await load()
      } else setError('এলার্ট পাঠানো যায়নি')
    } catch {
      setError('এলার্ট পাঠানো যায়নি')
    }
  }, [target, load])

  /* ── staff: receipts ── */
  const markPlayed = useCallback((id: string) => {
    void fetch('/api/assistant/office/intercom/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcastId: id, action: 'played' }),
    }).catch(() => {})
  }, [])

  const confirm = useCallback(
    async (id: string) => {
      setConfirming(id)
      successHaptic()
      try {
        await fetch('/api/assistant/office/intercom/receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcastId: id, action: 'confirmed' }),
        })
        // Optimistic — flip mine.confirmedAt locally, poll will reconcile.
        setFeed((f) => ({
          ...f,
          broadcasts: f.broadcasts.map((b) =>
            b.id === id ? { ...b, mine: { ...(b.mine ?? { deliveredAt: null, playedAt: null }), confirmedAt: new Date().toISOString() } } : b,
          ),
        }))
      } finally {
        setConfirming(null)
      }
    },
    [],
  )

  /* ── live call (Agora) ── */
  // Owner rings ONE staff: create a call broadcast, then join its channel.
  const startCall = useCallback(
    async (staffId: string, staffName: string) => {
      if (callStarting || activeCallId) return
      setCallStarting(true)
      setError(null)
      tapHaptic()
      try {
        const res = await fetch('/api/assistant/office/intercom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'call', targetStaffId: staffId }),
        })
        if (!res.ok) {
          setError('কল শুরু করা যায়নি')
          return
        }
        const { id } = (await res.json()) as { id: string }
        setCallPeer(staffName)
        setActiveCallId(id)
        await callApi.join(callChannel(id))
        void load()
      } finally {
        setCallStarting(false)
      }
    },
    [callStarting, activeCallId, callApi, load],
  )

  // Staff answers an incoming call: stop the ring (confirm) + join the channel.
  const answerCall = useCallback(
    async (b: ItcBroadcast) => {
      if (activeCallId) return
      successHaptic()
      setCallPeer('বস')
      setActiveCallId(b.id)
      void confirm(b.id)
      await callApi.join(callChannel(b.id))
    },
    [activeCallId, callApi, confirm],
  )

  // Staff declines: just stop the ring (never joins). Owner will time out.
  const declineCall = useCallback(
    (b: ItcBroadcast) => {
      warningHaptic()
      void confirm(b.id)
    },
    [confirm],
  )

  const endCall = useCallback(() => {
    void callApi.leave()
    setActiveCallId(null)
    setCallPeer('')
  }, [callApi])

  // If the remote hangs up (Agora user-left → remoteJoined flips false after
  // having been true), close our side too.
  const wasConnectedRef = useRef(false)
  useEffect(() => {
    if (callApi.remoteJoined) wasConnectedRef.current = true
    else if (wasConnectedRef.current && activeCallId) {
      wasConnectedRef.current = false
      endCall()
    }
  }, [callApi.remoteJoined, activeCallId, endCall])

  return {
    self,
    feed,
    ptt,
    recSecs,
    target,
    setTarget,
    error,
    startPtt,
    stopPtt,
    sendUrgent,
    markPlayed,
    confirm,
    confirming,
    reload: load,
    // call
    callApi,
    activeCallId,
    callPeer,
    callStarting,
    startCall,
    answerCall,
    declineCall,
    endCall,
  }
}

export type Intercom = ReturnType<typeof useIntercom>

/* ═══════════════ owner dock ═══════════════ */

export function IntercomDock({ itc }: { itc: Intercom }) {
  const { feed, ptt, recSecs, target, setTarget, error, startPtt, stopPtt } = itc
  const startYRef = useRef(0)
  const [cancelArmed, setCancelArmed] = useState(false)
  const live = ptt === 'live'

  const targetStaff = feed.staff.find((s) => s.id === target)
  const targetName = target === 'all' ? 'সবাই' : targetStaff?.name ?? ''

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    startYRef.current = e.clientY
    setCancelArmed(false)
    void startPtt()
  }
  const onMove = (e: React.PointerEvent) => {
    if (ptt !== 'live') return
    setCancelArmed(startYRef.current - e.clientY > 70)
  }
  const onUp = () => {
    stopPtt(cancelArmed)
    setCancelArmed(false)
  }

  return (
    <div className="itc-dock">
      <div className="itc-dock-h">
        <span className="t">
          <span className="dot" /> লাইভ ইন্টারকম — ওয়াকি-টকি
        </span>
        {error && <span className="itc-err">{error}</span>}
      </div>

      <div className="itc-targets">
        <button className={`itc-tpill${target === 'all' ? ' on' : ''}`} onClick={() => setTarget('all')}>
          <span className="itc-tav all">📢</span> সবাই
        </button>
        {feed.staff.map((s) => (
          <button key={s.id} className={`itc-tpill${target === s.id ? ' on' : ''}`} onClick={() => setTarget(s.id)}>
            <span className="itc-tav" style={{ backgroundImage: avGrad(s.id) }}>
              {avInitial(s.name)}
            </span>
            {s.name}
          </button>
        ))}
      </div>

      <div className="itc-row">
        <button className="itc-side urgent" onClick={() => itc.sendUrgent()} disabled={ptt !== 'idle'}>
          <span className="ic">🚨</span>জরুরি
        </button>

        <div className={`itc-ptt-wrap${live ? ' live' : ''}`}>
          <span className="itc-ring" />
          <span className="itc-ring" />
          <span className="itc-ring" />
          <button
            className={`itc-ptt${live ? (cancelArmed ? ' cancel' : ' live') : ''}`}
            disabled={ptt === 'sending' || feed.staff.length === 0}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="mic">{ptt === 'sending' ? '⏳' : '🎙️'}</span>
            <span className="lbl">
              {ptt === 'sending' ? 'যাচ্ছে…' : ptt === 'starting' ? 'মাইক…' : live ? 'বলুন' : 'চেপে ধরুন'}
            </span>
          </button>
        </div>

        {targetStaff ? (
          <button
            className="itc-side call"
            disabled={itc.callStarting || !!itc.activeCallId || ptt === 'live'}
            onClick={() => itc.startCall(targetStaff.id, targetStaff.name)}
          >
            <span className="ic">📞</span>
            <span className="cap">{itc.callStarting ? 'কল যাচ্ছে…' : 'লাইভ কল'}</span>
          </button>
        ) : (
          <span className="itc-side call" aria-disabled="true">
            <span className="ic">📞</span>
            <span className="cap">স্টাফ বাছুন</span>
          </span>
        )}
      </div>

      <div className="itc-status">
        {live ? (
          <>
            <span className="itc-eq" style={{ color: cancelArmed ? '#fcd34d' : '#fda4a4' }}>
              <i /><i /><i /><i /><i />
            </span>
            <span className={`st ${cancelArmed ? 'cancel' : 'live'}`}>
              {cancelArmed ? 'ছাড়লে বাতিল হবে' : `${targetName}-এর ফোনে যাবে`}
            </span>
            <span className="timer">🔴 {fmtDur(recSecs)}</span>
          </>
        ) : (
          <span className="st">
            {feed.staff.length === 0
              ? 'কোনো সক্রিয় স্টাফ নেই'
              : ptt === 'sending'
                ? 'পাঠানো হচ্ছে…'
                : 'চেপে ধরে বলুন — ছাড়লেই স্টাফের ফোনে বাজবে · উপরে টেনে বাতিল'}
          </span>
        )}
      </div>
    </div>
  )
}

/* ═══════════════ voice / urgent bubble (merged into the chat feed) ═══════════════ */

const BAR_HEIGHTS = [42, 68, 35, 88, 55, 74, 40, 92, 63, 48, 80, 38, 70, 52, 86, 45, 66, 58, 78, 36, 60, 84, 50, 72]

export function IntercomBubble({ b, itc }: { b: ItcBroadcast; itc: Intercom }) {
  const { self } = itc
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playedSentRef = useRef(false)

  const toggle = () => {
    if (!b.audioUrl) return
    let a = audioRef.current
    if (!a) {
      a = new Audio(b.audioUrl)
      audioRef.current = a
      a.addEventListener('timeupdate', () => {
        if (a!.duration > 0) setProgress(Math.min(100, (a!.currentTime / a!.duration) * 100))
      })
      a.addEventListener('ended', () => {
        setPlaying(false)
        setProgress(100)
      })
      a.addEventListener('play', () => {
        if (self === 'staff' && !playedSentRef.current && !b.mine?.playedAt) {
          playedSentRef.current = true
          itc.markPlayed(b.id)
        }
      })
    }
    if (playing) {
      a.pause()
      setPlaying(false)
    } else {
      if (a.ended) a.currentTime = 0 // replay from the top, not a no-op at the end
      a.play().catch(() => {})
      setPlaying(true)
    }
  }

  useEffect(
    () => () => {
      audioRef.current?.pause()
      audioRef.current = null
    },
    [],
  )

  const targetLabel = !b.targetStaffId
    ? 'সবাই'
    : self === 'staff'
      ? 'আপনার জন্য'
      : itc.feed.staff.find((s) => s.id === b.targetStaffId)?.name ?? b.receipts[0]?.staffName ?? 'একজন'

  // A live call leaves a compact log line in the chat (the actual ring/audio is
  // handled by the takeover + call overlay, not a playable bubble).
  if (b.kind === 'call') {
    const answered = b.receipts.some((r) => r.confirmedAt) || b.mine?.confirmedAt
    return (
      <div className="gb itc-vb call">
        <span className="itc-callline">
          📞 লাইভ কল · {targetLabel}
          <span className={`itc-callstat ${answered ? 'ok' : 'miss'}`}>{answered ? 'ধরা হয়েছে' : 'মিসড কল'}</span>
        </span>
      </div>
    )
  }

  if (b.kind === 'urgent') {
    return (
      <div className="gb itc-vb urgent">
        <div className="vb-utitle">🚨 জরুরি এলার্ট</div>
        <div className="vb-usub">{targetLabel === 'সবাই' ? 'সব স্টাফের ফোনে ফুল ভলিউমে গেছে' : `${targetLabel}-এর ফোনে গেছে`}</div>
        {self === 'owner' && b.receipts.length > 0 && <Receipts receipts={b.receipts} />}
        {self === 'staff' && (
          <div className="itc-mystate">
            {b.mine?.confirmedAt ? (
              <span className="itc-donechip">✅ কনফার্ম করেছেন</span>
            ) : (
              <button className="itc-confirm-sm" disabled={itc.confirming === b.id} onClick={() => itc.confirm(b.id)}>
                ✅ দেখেছি — কনফার্ম করছি
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="gb itc-vb">
      <span className="vb-tag">📡 ইন্টারকম · {targetLabel}</span>
      <div className="vb-row">
        <button className="vb-play" onClick={toggle} aria-label={playing ? 'বিরতি' : 'শুনুন'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="itc-bars">
          {BAR_HEIGHTS.map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} />
          ))}
          <span className="fill" style={{ width: `${progress}%` }}>
            {BAR_HEIGHTS.map((h, i) => (
              <i key={i} style={{ height: `${h}%` }} />
            ))}
          </span>
        </div>
        <span className="vb-dur">{fmtDur(b.durationSec)}</span>
      </div>
      {b.transcript ? (
        <div className="vb-tr">
          <b>🤖 ট্রান্সক্রিপ্ট:</b> {b.transcript}
        </div>
      ) : (
        <div className="vb-tr pending">🤖 এজেন্ট ট্রান্সক্রিপ্ট লিখছে…</div>
      )}
      {self === 'owner' && b.receipts.length > 0 && <Receipts receipts={b.receipts} />}
      {self === 'staff' && (
        <div className="itc-mystate">
          {b.mine?.confirmedAt ? (
            <span className="itc-donechip">✅ শুনেছেন — কনফার্মড</span>
          ) : (
            <button className="itc-confirm-sm" disabled={itc.confirming === b.id} onClick={() => itc.confirm(b.id)}>
              ✅ শুনেছি — কনফার্ম করছি
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Owner-side per-staff receipt chips: delivered → playing (live eq) → confirmed. */
function Receipts({ receipts }: { receipts: ItcReceipt[] }) {
  return (
    <div className="itc-rcpts">
      {receipts.map((r) => {
        const state = r.confirmedAt ? 'confirmed' : r.playedAt ? 'played' : r.deliveredAt ? 'delivered' : 'waiting'
        return (
          <span key={r.staffId} className={`itc-rcpt ${state}`}>
            <span className="itc-tav sm" style={{ backgroundImage: avGrad(r.staffId) }}>
              {avInitial(r.staffName)}
            </span>
            {r.staffName}
            {state === 'confirmed' ? (
              <span className="mk">✅</span>
            ) : state === 'played' ? (
              <span className="itc-eq sm"><i /><i /><i /></span>
            ) : state === 'delivered' ? (
              <span className="mk">✓✓</span>
            ) : (
              <span className="mk">🕓</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

/* ═══════════════ staff full-screen takeover ═══════════════ */

export function IntercomTakeover({ itc }: { itc: Intercom }) {
  const { feed, confirm, confirming, markPlayed } = itc
  // Voice/urgent broadcasts the staff hasn't confirmed, oldest first. Calls are
  // handled by IntercomCall (a ringing overlay), never here.
  const pendingList = useMemo(
    () => feed.broadcasts.filter((b) => b.kind !== 'call' && b.mine && !b.mine.confirmedAt),
    [feed.broadcasts],
  )
  const [snoozed, setSnoozed] = useState<Set<string>>(() => new Set())
  const current = pendingList.find((b) => !snoozed.has(b.id)) ?? null

  const [playing, setPlaying] = useState(false)
  const [needsTap, setNeedsTap] = useState(false)
  const [ended, setEnded] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const attemptedRef = useRef<string | null>(null)

  const beep = useCallback(() => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const t0 = ctx.currentTime
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = 880
        gain.gain.setValueAtTime(0.001, t0 + i * 0.45)
        gain.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.45 + 0.05)
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.45 + 0.35)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t0 + i * 0.45)
        osc.stop(t0 + i * 0.45 + 0.4)
      }
      setTimeout(() => ctx.close().catch(() => {}), 2000)
    } catch {
      /* autoplay policy — visual takeover still lands */
    }
  }, [])

  const play = useCallback(
    (b: ItcBroadcast) => {
      if (!b.audioUrl) return
      let a = audioRef.current
      if (!a || a.src !== b.audioUrl) {
        audioRef.current?.pause()
        a = new Audio(b.audioUrl)
        audioRef.current = a
        a.addEventListener('ended', () => {
          setPlaying(false)
          setEnded(true)
        })
        a.addEventListener('play', () => {
          setPlaying(true)
          setNeedsTap(false)
          if (!b.mine?.playedAt) markPlayed(b.id)
        })
      }
      setEnded(false)
      if (a.ended) a.currentTime = 0
      a.play().catch(() => setNeedsTap(true))
    },
    [markPlayed],
  )

  // New broadcast raised → try auto-play if it's fresh (true walkie-talkie);
  // urgent kind beeps instead. Older ones wait for a tap.
  useEffect(() => {
    if (!current || attemptedRef.current === current.id) return
    attemptedRef.current = current.id
    setEnded(false)
    setPlaying(false)
    warningHaptic()
    const fresh = Date.now() - new Date(current.createdAt).getTime() < AUTOPLAY_FRESH_MS && isOfficeHoursDhaka()
    if (current.kind === 'urgent') {
      if (fresh) beep()
      try {
        navigator.vibrate?.([200, 100, 200, 100, 400])
      } catch {
        /* iOS has no vibrate API */
      }
      return
    }
    if (fresh) play(current)
    else setNeedsTap(true)
  }, [current, play, beep])

  useEffect(
    () => () => {
      audioRef.current?.pause()
      audioRef.current = null
    },
    [],
  )

  if (!current) return null
  const isUrgent = current.kind === 'urgent'
  const remaining = pendingList.filter((b) => !snoozed.has(b.id)).length

  const doConfirm = async () => {
    audioRef.current?.pause()
    setPlaying(false)
    await confirm(current.id)
  }

  return (
    <div className={`itc-takeover${isUrgent ? ' urgent' : ''}`} role="alertdialog" aria-label="অফিস ইন্টারকম">
      <div className="itc-tk-av">
        <span className="ring" />
        <span className="ring r2" />
        {isUrgent ? '🚨' : 'M'}
      </div>
      <div className="itc-tk-kicker">অফিস ইন্টারকম</div>
      <div className="itc-tk-title">{isUrgent ? 'বসের জরুরি এলার্ট!' : playing ? '🎙️ বস বলছেন…' : ended ? 'শোনা শেষ' : 'বসের ভয়েস মেসেজ'}</div>
      <div className="itc-tk-sub">
        {isUrgent
          ? 'এখনই গ্রুপ চ্যাট দেখুন — কনফার্ম করুন'
          : playing
            ? 'লাইভ — অটো-প্লে হচ্ছে, ভলিউম চালু রাখুন'
            : ended
              ? 'শুনে থাকলে নিচে কনফার্ম করুন'
              : `${fmtDur(current.durationSec)} — শুনে কনফার্ম করুন`}
      </div>

      {!isUrgent && (
        <div className={`itc-tk-wave${playing ? ' playing' : ''}`}>
          {Array.from({ length: 20 }).map((_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      <span className="itc-tk-badge">🔊 ওয়াকি-টকি মোড · অফিস সময়</span>

      <div className="itc-tk-actions">
        {!isUrgent && (needsTap || (!playing && !ended)) && (
          <button className="itc-tk-play" onClick={() => play(current)}>
            ▶ {needsTap ? 'শুনুন' : 'চালু করুন'}
          </button>
        )}
        {!isUrgent && ended && (
          <button className="itc-tk-ghost" onClick={() => play(current)}>
            🔁 আবার শুনুন
          </button>
        )}
        <button className="itc-tk-confirm" disabled={confirming === current.id} onClick={doConfirm}>
          ✅ {isUrgent ? 'দেখেছি — কনফার্ম করছি' : 'শুনেছি — কনফার্ম করছি'}
        </button>
      </div>

      {remaining > 1 && <div className="itc-tk-count">আরও {bn(remaining - 1)}টি মেসেজ অপেক্ষায়</div>}
      <button
        className="itc-tk-later"
        onClick={() => {
          audioRef.current?.pause()
          setPlaying(false)
          setSnoozed((s) => new Set(s).add(current.id))
        }}
      >
        চ্যাটে দেখব — পরে কনফার্ম করব
      </button>
    </div>
  )
}

/* ═══════════════ live call overlay (Agora) ═══════════════ */

const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function IntercomCall({ itc }: { itc: Intercom }) {
  const { self, feed, activeCallId, callPeer, callApi, endCall, answerCall, declineCall } = itc

  // Staff: a fresh, unconfirmed call broadcast addressed to me = an incoming ring
  // (unless I'm already in a call).
  const incoming = useMemo(() => {
    if (self !== 'staff' || activeCallId) return null
    return (
      feed.broadcasts.find(
        (b) =>
          b.kind === 'call' &&
          b.mine &&
          !b.mine.confirmedAt &&
          Date.now() - new Date(b.createdAt).getTime() < CALL_RING_MS,
      ) ?? null
    )
  }, [self, activeCallId, feed.broadcasts])

  // Ring tone + vibration while an incoming call is pending.
  const ringRef = useRef<{ ctx: AudioContext; stop: () => void } | null>(null)
  useEffect(() => {
    if (!incoming) return
    let cancelled = false
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        const loop = () => {
          if (cancelled) return
          const t0 = ctx.currentTime
          for (let i = 0; i < 2; i++) {
            const osc = ctx.createOscillator()
            const g = ctx.createGain()
            osc.type = 'sine'
            osc.frequency.value = i === 0 ? 660 : 550
            g.gain.setValueAtTime(0.0001, t0 + i * 0.4)
            g.gain.exponentialRampToValueAtTime(0.35, t0 + i * 0.4 + 0.05)
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.4 + 0.3)
            osc.connect(g).connect(ctx.destination)
            osc.start(t0 + i * 0.4)
            osc.stop(t0 + i * 0.4 + 0.35)
          }
        }
        loop()
        const iv = setInterval(loop, 2000)
        ringRef.current = { ctx, stop: () => clearInterval(iv) }
      }
    } catch {
      /* autoplay blocked — the visual ring still shows */
    }
    const vib = setInterval(() => {
      try {
        navigator.vibrate?.([400, 200, 400])
      } catch {
        /* iOS */
      }
    }, 1500)
    return () => {
      cancelled = true
      clearInterval(vib)
      ringRef.current?.stop()
      ringRef.current?.ctx.close().catch(() => {})
      ringRef.current = null
    }
  }, [incoming])

  // ── incoming ring (staff) ──
  if (incoming) {
    return (
      <div className="itc-call incoming" role="alertdialog" aria-label="ইনকামিং কল">
        <div className="itc-call-top">
          <div className="itc-tk-av"><span className="ring" /><span className="ring r2" />M</div>
          <div className="itc-call-who">বস — মারুফ</div>
          <div className="itc-call-sub">📞 অফিস লাইভ কল…</div>
        </div>
        <div className="itc-call-btns">
          <button className="itc-cbtn decline" onClick={() => declineCall(incoming)} aria-label="কেটে দিন">✕</button>
          <button className="itc-cbtn accept" onClick={() => answerCall(incoming)} aria-label="ধরুন">📞</button>
        </div>
        <div className="itc-call-labels"><span>কেটে দিন</span><span>ধরুন</span></div>
      </div>
    )
  }

  // ── active call (owner or staff, once we've joined) ──
  if (!activeCallId) return null
  const st = callApi.state
  const connected = callApi.remoteJoined
  const failed = st === 'error'
  return (
    <div className="itc-call active" role="dialog" aria-label="লাইভ কল">
      <div className="itc-call-top">
        <div className={`itc-tk-av${connected ? ' connected' : ''}`}>
          {!connected && <><span className="ring" /><span className="ring r2" /></>}
          {self === 'owner' ? (callPeer.trim()[0] || 'M').toUpperCase() : 'M'}
        </div>
        <div className="itc-call-who">{self === 'owner' ? callPeer || 'স্টাফ' : 'বস — মারুফ'}</div>
        <div className="itc-call-sub">
          {failed
            ? callApi.error === 'agora_unconfigured'
              ? '⚠️ কল সেটআপ বাকি (Agora key)'
              : '⚠️ কল সংযোগে সমস্যা'
            : connected
              ? '🟢 কল চলছে — লাইভ অডিও'
              : self === 'owner'
                ? '📞 রিং হচ্ছে…'
                : 'সংযোগ হচ্ছে…'}
        </div>
        {connected && <div className="itc-call-timer">{fmtClock(callApi.callSeconds)}</div>}
      </div>

      <div className="itc-call-actions">
        {connected && (
          <button className={`itc-call-mute${callApi.muted ? ' on' : ''}`} onClick={() => callApi.toggleMute()}>
            {callApi.muted ? '🔇 আনমিউট' : '🎤 মিউট'}
          </button>
        )}
        <button className="itc-cbtn decline big" onClick={endCall} aria-label="কল শেষ">✕</button>
        <div className="itc-call-end-lbl">{failed ? 'বন্ধ করুন' : 'কল শেষ করুন'}</div>
      </div>
    </div>
  )
}

/** One <style> mount for all intercom pieces. */
export function IntercomStyle() {
  return <style dangerouslySetInnerHTML={{ __html: INTERCOM_CSS }} />
}

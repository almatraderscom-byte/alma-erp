'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { motion, AnimatePresence, useMotionValue } from 'framer-motion'
import { useBusiness } from '@/contexts/BusinessContext'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { fetchTtsAudio } from '@/agent/lib/voice-tts-client'
import { VoiceNavGlow } from './voice/VoiceNavGlow'
import { cn } from '@/lib/utils'

/**
 * Staff Navigator — a tiny app-wide assistant for EVERY staff member (Gemini Flash).
 *
 * Speak or type → it takes you to the right page (only pages your role can open —
 * validated server-side) or answers a quick question. Voice uses Whisper transcribe
 * + Google TTS (the same in-app voice stack; no ElevenLabs). The floating orb is
 * DRAGGABLE and shows a clear STATUS animation — listening / thinking / ✓ going /
 * ✕ failed — so it's always obvious whether the assistant is acting or not.
 */
const POS_KEY = 'alma-nav-fab-pos'

type Status = 'idle' | 'listening' | 'thinking' | 'go' | 'error'

/** Premium two-spark AI mark (Gemini-style) — replaces the plain compass emoji. */
function AssistantMark() {
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.25))' }}>
      <path d="M12 2.3l1.9 5.5 5.5 1.9-5.5 1.9L12 17.1l-1.9-5.5L4.6 9.7l5.5-1.9L12 2.3z" fill="currentColor" />
      <path d="M18.4 13.6l.85 2.45 2.45.85-2.45.85-.85 2.45-.85-2.45-2.45-.85 2.45-.85.85-2.45z" fill="currentColor" opacity="0.82" />
    </svg>
  )
}

export default function StaffAssistant() {
  const router = useRouter()
  const pathname = usePathname()
  const { business } = useBusiness()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)

  // Drag position (offset from the fixed bottom-right base), remembered across reloads.
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const draggedRef = useRef(false)
  const [constraints, setConstraints] = useState({ left: -300, right: 12, top: -500, bottom: 12 })

  // On-screen keyboard height (px). Self-contained so the orb lifts its panel to
  // sit just above the keyboard on BOTH iPhone and Android, instead of floating
  // far above it. Native (Capacitor, resize:None on portal): the Keyboard plugin
  // reports the exact height. Web / installed PWA: derive it from visualViewport.
  const [kb, setKb] = useState(0)
  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []
    async function setupNative(): Promise<boolean> {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (!Capacitor?.isNativePlatform?.()) return false
        const { Keyboard } = await import('@capacitor/keyboard')
        const show = await Keyboard.addListener('keyboardWillShow', (info) => { if (!disposed) setKb(info.keyboardHeight) })
        const hide = await Keyboard.addListener('keyboardWillHide', () => { if (!disposed) setKb(0) })
        cleanups.push(() => { void show.remove(); void hide.remove() })
        return true
      } catch {
        return false
      }
    }
    function setupWeb() {
      const vv = window.visualViewport
      if (!vv) return
      const onResize = () => {
        const h = window.innerHeight - vv.height - vv.offsetTop
        if (!disposed) setKb(h > 80 ? h : 0) // ignore URL-bar shifts; only a real keyboard
      }
      vv.addEventListener('resize', onResize)
      vv.addEventListener('scroll', onResize)
      cleanups.push(() => { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize) })
      onResize()
    }
    void setupNative().then((isNative) => { if (!disposed && !isNative) setupWeb() })
    return () => { disposed = true; cleanups.forEach((c) => c()) }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    setConstraints({ left: -(window.innerWidth - 76), right: 12, top: -(window.innerHeight - 210), bottom: 12 })
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null') as { x: number; y: number } | null
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) { x.set(saved.x); y.set(saved.y) }
    } catch {
      /* ignore */
    }
  }, [x, y])

  // When the keyboard opens with the panel up, pin the whole orb just above it and
  // neutralise any dragged Y offset, so the input never drifts far above the
  // keyboard (the reported Android bug). On agent routes the WebView resizes
  // natively (html.cap-native-resize) so the fixed orb already sits above the
  // keyboard — there we must NOT add the height again. The dragged position is
  // restored on close.
  const nativeResize = typeof document !== 'undefined' && document.documentElement.classList.contains('cap-native-resize')
  const kbActive = open && kb > 0
  const lift = kbActive && !nativeResize ? kb + 12 : 0
  const yBeforeKb = useRef<number | null>(null)
  useEffect(() => {
    if (kbActive) {
      if (yBeforeKb.current === null) yBeforeKb.current = y.get()
      y.set(0)
    } else if (yBeforeKb.current !== null) {
      y.set(yBeforeKb.current)
      yBeforeKb.current = null
    }
  }, [kbActive, y])

  const speak = useCallback(async (text: string) => {
    try {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
      const audio = await fetchTtsAudio(text)
      audioRef.current = audio
      await audio.play()
    } catch {
      /* TTS is best-effort — the text reply is always shown */
    }
  }, [])

  const flashError = useCallback((msg: string) => {
    setReply(msg)
    setStatus('error')
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => setStatus('idle'), 3200)
  }, [])

  const handle = useCallback(async (text: string, viaVoice: boolean) => {
    const q = text.trim()
    if (!q || inFlight.current) return
    inFlight.current = true
    if (errorTimer.current) clearTimeout(errorTimer.current)
    setStatus('thinking')
    setReply(null)
    try {
      const res = await fetch('/api/assistant/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, currentPath: pathname, businessId: business.id }),
      })
      if (!res.ok) throw new Error('http')
      const data = (await res.json().catch(() => ({}))) as { navigate?: string; reply?: string }
      const replyText = data.reply || 'বুঝতে পারিনি।'
      setReply(replyText)
      if (viaVoice) void speak(replyText)
      if (data.navigate) {
        const target = data.navigate
        setStatus('go')
        // Hold the ✓ "going" animation briefly so the move is clearly seen.
        setTimeout(() => { setOpen(false); setStatus('idle'); router.push(target) }, viaVoice ? 850 : 700)
      } else {
        setStatus('idle')
      }
    } catch {
      flashError('সংযোগে সমস্যা — আবার চেষ্টা করুন।')
    } finally {
      inFlight.current = false
      setQuery('')
    }
  }, [pathname, business.id, router, speak, flashError])

  const recorder = useVoiceRecorder({
    onTranscribed: (text: string) => { void handle(text, true) },
    onError: () => flashError('শুনতে পারিনি — আবার চেষ্টা করুন।'),
    onRecordingStart: () => setStatus('listening'),
    onRecordingStop: () => setStatus((s) => (s === 'listening' ? 'thinking' : s)),
  })

  const listening = status === 'listening'
  const toggleMic = useCallback(() => {
    if (listening) recorder.stop()
    else { setReply(null); recorder.start() }
  }, [listening, recorder])

  // ── Orb visuals per status ──────────────────────────────────────────────────
  const orbTone =
    status === 'error' ? 'from-[#E8897A] via-danger to-[#b34a3c]'
    : status === 'go' ? 'from-[#9ED0B6] via-[#81B29A] to-[#5d9079]'
    : 'from-[#E8B07A] via-gold to-gold-dim'

  // Siri-style edge glow: light up the whole screen edges while the navigator is
  // actively working (listening → thinking → going), then fade out.
  const navGlowActive = status === 'listening' || status === 'thinking' || status === 'go'

  return (
    <>
      <VoiceNavGlow active={navGlowActive} />
      <motion.div
      drag
      dragMomentum={false}
      dragElastic={0.06}
      dragConstraints={constraints}
      style={{ x, y, touchAction: 'none', ...(lift ? { bottom: lift, top: 'auto' } : {}) }}
      onDragStart={() => { draggedRef.current = true }}
      onDragEnd={() => {
        try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x.get(), y: y.get() })) } catch { /* ignore */ }
        setTimeout(() => { draggedRef.current = false }, 60)
      }}
      className="fixed right-4 z-[60] bottom-[calc(10.5rem_+_env(safe-area-inset-bottom))] md:bottom-6 md:right-6"
    >
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onPointerDownCapture={(e) => e.stopPropagation()}
            className="absolute bottom-[60px] right-0 w-[min(86vw,320px)] cursor-default rounded-2xl border border-border-strong bg-card/95 p-3 shadow-2xl backdrop-blur-2xl"
          >
            <p className="mb-2 px-1 text-[11px] font-black uppercase tracking-[0.14em] text-gold">ALMA সহকারী</p>

            <StatusBanner status={status} reply={reply} />

            <form onSubmit={(e) => { e.preventDefault(); void handle(query, false) }} className="mt-2 flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="কোথায় যাবেন? বলুন বা লিখুন…"
                disabled={status === 'thinking'}
                className="min-w-0 flex-1 rounded-xl border border-border bg-card px-3 py-2 text-[13px] text-cream placeholder:text-muted focus:border-gold-dim/50 focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={toggleMic}
                aria-label="ভয়েস"
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base transition-all',
                  listening ? 'animate-pulse border-danger/50 bg-danger/15 text-danger' : 'border-border text-muted hover:text-[#81B29A]',
                )}
              >
                🎤
              </button>
              <button
                type="submit"
                disabled={status === 'thinking' || !query.trim()}
                aria-label="পাঠান"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#E07A5F] text-sm font-bold text-white transition-all active:scale-95 disabled:opacity-40"
              >
                ↑
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative">
        {/* Status ring: breathing (idle), spinning (thinking), pop (go), shake handled on the button. */}
        {!open && status === 'idle' && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            animate={{ boxShadow: ['0 0 0 0 rgba(224,122,95,0.40)', '0 0 0 10px rgba(224,122,95,0)', '0 0 0 0 rgba(224,122,95,0)'] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        {(status === 'thinking' || status === 'listening') && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute -inset-[3px] rounded-full"
            style={{
              background: status === 'listening'
                ? 'conic-gradient(from 0deg, transparent, rgba(231,106,90,0.9), transparent 60%)'
                : 'conic-gradient(from 0deg, transparent, rgba(224,122,95,0.95), transparent 55%)',
              WebkitMask: 'radial-gradient(circle, transparent 60%, #000 62%)',
              mask: 'radial-gradient(circle, transparent 60%, #000 62%)',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: status === 'listening' ? 1.1 : 0.8, repeat: Infinity, ease: 'linear' }}
          />
        )}
        {status === 'go' && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            initial={{ boxShadow: '0 0 0 0 rgba(129,178,154,0.7)' }}
            animate={{ boxShadow: '0 0 0 16px rgba(129,178,154,0)' }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        )}
        <motion.button
          type="button"
          onClick={() => { if (draggedRef.current) return; setOpen((o) => !o) }}
          aria-label="ALMA সহকারী"
          animate={status === 'error' ? { x: [0, -5, 5, -4, 4, 0] } : { x: 0 }}
          transition={{ duration: 0.4 }}
          className={cn(
            'relative flex h-[54px] w-[54px] items-center justify-center rounded-full border text-white shadow-lg backdrop-blur-md transition-transform active:scale-95 bg-gradient-to-br',
            orbTone,
            status === 'error' ? 'border-danger/60 shadow-danger/25' : status === 'go' ? 'border-[#81B29A]/60 shadow-[#81B29A]/25' : 'border-gold-dim/50 shadow-gold/25',
          )}
        >
          {open && status === 'idle' ? <span className="text-xl leading-none">✕</span>
            : status === 'go' ? <span className="text-2xl leading-none">✓</span>
            : status === 'error' ? <span className="text-xl leading-none">!</span>
            : status === 'thinking' ? <ThinkingDots />
            : <AssistantMark />}
        </motion.button>
      </div>
      </motion.div>
    </>
  )
}

function ThinkingDots() {
  return (
    <span className="flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-white"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.13, ease: 'easeInOut' }}
        />
      ))}
    </span>
  )
}

function StatusBanner({ status, reply }: { status: Status; reply: string | null }) {
  if (status === 'listening') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/[0.08] px-3 py-2 text-[12px] font-semibold text-danger">
        <span className="flex items-center gap-[2px]">
          {[0, 1, 2, 3].map((i) => (
            <motion.span key={i} className="w-[3px] rounded-full bg-danger" animate={{ height: [6, 14, 6] }} transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.1 }} />
          ))}
        </span>
        শুনছি… থামাতে আবার 🎤
      </div>
    )
  }
  if (status === 'thinking') {
    return (
      <div className="flex items-center gap-2 overflow-hidden rounded-xl border border-gold-dim/30 bg-gold/[0.07] px-3 py-2 text-[12px] font-semibold text-gold-lt">
        <ThinkingDots />
        <span>ভাবছি…</span>
        <motion.span className="ml-auto h-3 w-10 rounded-full bg-gold/20" animate={{ opacity: [0.3, 0.8, 0.3] }} transition={{ duration: 1, repeat: Infinity }} />
      </div>
    )
  }
  if (status === 'go') {
    return (
      <motion.div
        initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
        className="flex items-center gap-2 rounded-xl border border-[#81B29A]/40 bg-[#81B29A]/[0.10] px-3 py-2 text-[12px] font-bold text-[#81B29A]"
      >
        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}>✓</motion.span>
        <span className="min-w-0 flex-1 truncate">{reply || 'যাচ্ছি…'}</span>
        <motion.span animate={{ x: [0, 4, 0] }} transition={{ duration: 0.7, repeat: Infinity }}>→</motion.span>
      </motion.div>
    )
  }
  if (status === 'error') {
    return (
      <motion.div
        initial={{ x: 0 }} animate={{ x: [0, -4, 4, -3, 0] }} transition={{ duration: 0.4 }}
        className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/[0.10] px-3 py-2 text-[12px] font-semibold text-danger"
      >
        <span>✕</span>
        <span className="min-w-0 flex-1">{reply || 'ব্যর্থ — আবার চেষ্টা করুন।'}</span>
      </motion.div>
    )
  }
  // idle: show a plain answer (a question's reply) if any.
  if (reply) {
    return <p className="rounded-xl bg-bg-2/60 px-3 py-2 text-[12px] leading-relaxed text-cream">{reply}</p>
  }
  return null
}

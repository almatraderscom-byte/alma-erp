'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { motion, AnimatePresence, useMotionValue } from 'framer-motion'
import { useBusiness } from '@/contexts/BusinessContext'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { fetchTtsAudio } from '@/agent/lib/voice-tts-client'
import { cn } from '@/lib/utils'

/**
 * Staff Navigator — a tiny app-wide assistant for EVERY staff member (Gemini Flash).
 *
 * Speak or type → it takes you to the right page (only pages your role can open —
 * validated server-side) or answers a quick question. Voice uses Whisper transcribe
 * + Google TTS (the same in-app voice stack; no ElevenLabs). The floating orb is
 * DRAGGABLE — drag it anywhere; the spot is remembered. Phase 1 = navigate + answer
 * only (no mutations).
 */
const POS_KEY = 'alma-nav-fab-pos'

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
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Drag position (offset from the fixed bottom-right base), remembered across reloads.
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const draggedRef = useRef(false)
  const [constraints, setConstraints] = useState({ left: -300, right: 12, top: -500, bottom: 12 })

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

  const handle = useCallback(async (text: string, viaVoice: boolean) => {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    setReply(null)
    try {
      const res = await fetch('/api/assistant/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, currentPath: pathname, businessId: business.id }),
      })
      const data = (await res.json().catch(() => ({}))) as { navigate?: string; reply?: string }
      const replyText = data.reply || 'বুঝতে পারিনি।'
      setReply(replyText)
      if (viaVoice) void speak(replyText)
      if (data.navigate) {
        const target = data.navigate
        setTimeout(() => { setOpen(false); router.push(target) }, viaVoice ? 700 : 250)
      }
    } catch {
      setReply('সংযোগে সমস্যা — আবার চেষ্টা করুন।')
    } finally {
      setBusy(false)
      setQuery('')
    }
  }, [busy, pathname, business.id, router, speak])

  const recorder = useVoiceRecorder({
    onTranscribed: (text: string) => { setListening(false); void handle(text, true) },
    onError: () => { setListening(false); setReply('শুনতে পারিনি — আবার চেষ্টা করুন।') },
    onRecordingStart: () => setListening(true),
    onRecordingStop: () => setListening(false),
  })

  const toggleMic = useCallback(() => {
    if (listening) recorder.stop()
    else { setReply(null); recorder.start() }
  }, [listening, recorder])

  return (
    <motion.div
      drag
      dragMomentum={false}
      dragElastic={0.06}
      dragConstraints={constraints}
      style={{ x, y, touchAction: 'none' }}
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
            {reply && <p className="mb-2 rounded-xl bg-bg-2/60 px-3 py-2 text-[12px] leading-relaxed text-cream">{reply}</p>}
            <form onSubmit={(e) => { e.preventDefault(); void handle(query, false) }} className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="কোথায় যাবেন? বলুন বা লিখুন…"
                className="min-w-0 flex-1 rounded-xl border border-border bg-card px-3 py-2 text-[13px] text-cream placeholder:text-muted focus:border-gold-dim/50 focus:outline-none"
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
                disabled={busy || !query.trim()}
                aria-label="পাঠান"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#E07A5F] text-sm font-bold text-white transition-all active:scale-95 disabled:opacity-40"
              >
                {busy ? '…' : '↑'}
              </button>
            </form>
            {listening && <p className="mt-2 px-1 text-[11px] text-danger">🎙️ শুনছি… থামাতে আবার 🎤 চাপুন</p>}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative">
        {/* Soft breathing glow ring — the "next level" cue. */}
        {!open && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{ boxShadow: '0 0 0 0 rgba(224,122,95,0.45)' }}
            animate={{ boxShadow: ['0 0 0 0 rgba(224,122,95,0.40)', '0 0 0 10px rgba(224,122,95,0)', '0 0 0 0 rgba(224,122,95,0)'] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <button
          type="button"
          onClick={() => { if (draggedRef.current) return; setOpen((o) => !o) }}
          aria-label="ALMA সহকারী"
          className="relative flex h-[54px] w-[54px] items-center justify-center rounded-full border border-gold-dim/50 bg-gradient-to-br from-[#E8B07A] via-gold to-gold-dim text-white shadow-lg shadow-gold/25 backdrop-blur-md transition-transform active:scale-95"
        >
          {open ? <span className="text-xl leading-none">✕</span> : <AssistantMark />}
        </button>
      </div>
    </motion.div>
  )
}

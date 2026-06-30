'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useBusiness } from '@/contexts/BusinessContext'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { fetchTtsAudio } from '@/agent/lib/voice-tts-client'
import { cn } from '@/lib/utils'

/**
 * Staff Navigator — a tiny app-wide assistant for EVERY staff member (Gemini Flash).
 *
 * Speak or type → it takes you to the right page (only pages your role can open —
 * validated server-side) or answers a quick question. Voice uses Whisper transcribe
 * + Google TTS (the same in-app voice stack; no ElevenLabs). Phase 1 = navigate +
 * answer only (no mutations).
 */
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
    <div className="fixed right-4 z-[60] bottom-[calc(10.5rem_+_env(safe-area-inset-bottom))] md:bottom-6 md:right-6">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            className="absolute bottom-[60px] right-0 w-[min(86vw,320px)] rounded-2xl border border-border-strong bg-card/95 p-3 shadow-2xl backdrop-blur-2xl"
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

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="ALMA সহকারী"
        className="flex h-[52px] w-[52px] items-center justify-center rounded-full border border-gold-dim/50 bg-gradient-to-br from-gold/25 to-gold-dim/20 text-xl text-gold-lt shadow-lg shadow-gold/20 backdrop-blur-md transition-transform active:scale-95"
      >
        {open ? '✕' : '🧭'}
      </button>
    </div>
  )
}

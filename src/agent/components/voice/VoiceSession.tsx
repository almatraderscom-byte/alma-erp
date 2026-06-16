'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { useMicLevel } from '@/agent/hooks/useMicLevel'
import { fetchTtsAudio } from '@/agent/lib/voice-tts-client'
import type { VoiceState } from '@/agent/lib/voice-types'
import toast from 'react-hot-toast'

interface VoiceSessionProps {
  open: boolean
  onClose: () => void
  onSendMessage: (text: string) => Promise<string | null>
}

const STATUS: Record<VoiceState, string> = {
  idle: 'ট্যাপ করে কথা বলুন',
  listening: 'শুনছি…',
  transcribing: 'ট্রান্সক্রাইব করছি…',
  thinking: 'ভাবছি…',
  speaking: 'বলছি…',
  error: 'আবার চেষ্টা করুন',
}

export default function VoiceSession({ open, onClose, onSendMessage }: VoiceSessionProps) {
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])

  const stopTts = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current = null
    }
  }, [])

  const recorder = useVoiceRecorder({
    onTranscribed: async (text) => {
      setTranscript(text)
      setState('thinking')
      try {
        const reply = await onSendMessage(text)
        if (!openRef.current) return
        if (reply?.trim()) {
          setState('speaking')
          try {
            const audio = await fetchTtsAudio(reply)
            audioRef.current = audio
            audio.onended = () => {
              audioRef.current = null
              if (openRef.current) {
                setState('idle')
                setTimeout(() => {
                  if (openRef.current && stateRef.current === 'idle') {
                    recorder.start()
                    setState('listening')
                  }
                }, 400)
              }
            }
            await audio.play()
          } catch {
            setState('idle')
          }
        } else {
          setState('idle')
        }
      } catch {
        toast.error('উত্তর পেতে ব্যর্থ')
        setState('error')
      }
    },
    onError: (msg) => {
      toast.error(msg)
      setState('error')
      setTimeout(() => { if (openRef.current) setState('idle') }, 2000)
    },
    onRecordingStart: () => setState('listening'),
    onRecordingStop: () => {
      if (stateRef.current === 'listening') setState('transcribing')
    },
  })

  const micLevel = useMicLevel(recorder.stream, recorder.recording)

  const handleTapOrb = useCallback(() => {
    if (state === 'listening') {
      recorder.stop()
    } else if (state === 'speaking') {
      stopTts()
      setState('idle')
      setTimeout(() => {
        if (openRef.current) {
          recorder.start()
          setState('listening')
        }
      }, 200)
    } else if (state === 'idle' || state === 'error') {
      setTranscript('')
      recorder.start()
    }
  }, [state, recorder, stopTts])

  const handleClose = useCallback(() => {
    recorder.cancel()
    stopTts()
    setState('idle')
    setTranscript('')
    onClose()
  }, [recorder, stopTts, onClose])

  useEffect(() => {
    if (open && state === 'idle') {
      const t = setTimeout(() => {
        if (openRef.current && stateRef.current === 'idle') {
          recorder.start()
        }
      }, 350)
      return () => clearTimeout(t)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) {
      recorder.cancel()
      stopTts()
      setState('idle')
      setTranscript('')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const orbScale = state === 'listening'
    ? 1 + micLevel * 0.18
    : state === 'speaking'
      ? 1 + Math.sin(Date.now() / 200) * 0.06
      : state === 'thinking' || state === 'transcribing'
        ? 1
        : 1

  const orbPulseClass = state === 'thinking' || state === 'transcribing' ? 'animate-pulse' : ''

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center"
          style={{ background: 'linear-gradient(180deg, #FDF8F3 0%, #F5EDE6 50%, #EDE3DA 100%)' }}
        >
          {/* Close button */}
          <button
            type="button"
            onClick={handleClose}
            className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/[0.06] text-gray-500 backdrop-blur-sm transition-colors hover:bg-black/[0.1]"
            aria-label="বন্ধ করুন"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>

          {/* Main content */}
          <div className="flex flex-col items-center gap-6">
            {/* Glow behind orb */}
            <div className="relative">
              <motion.div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  width: 260,
                  height: 260,
                  background: state === 'listening'
                    ? 'radial-gradient(circle, rgba(224,122,95,0.4) 0%, rgba(224,122,95,0.08) 50%, transparent 70%)'
                    : state === 'speaking'
                      ? 'radial-gradient(circle, rgba(56,189,248,0.35) 0%, rgba(56,189,248,0.06) 50%, transparent 70%)'
                      : 'radial-gradient(circle, rgba(224,122,95,0.2) 0%, transparent 60%)',
                }}
                animate={{
                  scale: state === 'listening' ? [1, 1.08 + micLevel * 0.12, 1] : [1, 1.04, 1],
                  opacity: state === 'listening' ? [0.6, 0.9, 0.6] : [0.4, 0.6, 0.4],
                }}
                transition={{ duration: state === 'listening' ? 0.8 : 3, repeat: Infinity, ease: 'easeInOut' }}
              />

              {/* The orb itself */}
              <motion.button
                type="button"
                onClick={handleTapOrb}
                className={`relative z-10 flex items-center justify-center rounded-full focus:outline-none ${orbPulseClass}`}
                style={{ width: 180, height: 180 }}
                animate={{ scale: orbScale }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                whileTap={{ scale: 0.94 }}
              >
                {/* Outer ring */}
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: state === 'listening'
                      ? 'conic-gradient(from 0deg, #E07A5F, #F4A261, #E07A5F)'
                      : state === 'speaking'
                        ? 'conic-gradient(from 0deg, #38BDF8, #818CF8, #38BDF8)'
                        : 'conic-gradient(from 0deg, #E07A5F, #F6D5C8, #E07A5F)',
                    padding: 3,
                    WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                    WebkitMaskComposite: 'xor',
                    maskComposite: 'exclude',
                    opacity: state === 'idle' ? 0.5 : 0.9,
                    animation: (state === 'listening' || state === 'speaking') ? 'spin 3s linear infinite' : undefined,
                  }}
                />
                {/* Inner sphere with gradient + glass effect */}
                <div
                  className="absolute rounded-full"
                  style={{
                    inset: 4,
                    background: state === 'speaking'
                      ? 'radial-gradient(circle at 35% 30%, #dbeafe 0%, #60a5fa 30%, #3b82f6 55%, #1d4ed8 85%)'
                      : state === 'listening'
                        ? 'radial-gradient(circle at 35% 30%, #FEE2D5 0%, #F4A261 25%, #E07A5F 55%, #c45a42 85%)'
                        : 'radial-gradient(circle at 35% 30%, #F6E6DF 0%, #E8B4A0 30%, #D4846A 55%, #c45a42 85%)',
                    boxShadow: state === 'listening'
                      ? '0 12px 48px rgba(224,122,95,0.45), inset 0 -12px 32px rgba(0,0,0,0.1), inset 0 6px 20px rgba(255,255,255,0.35)'
                      : state === 'speaking'
                        ? '0 12px 48px rgba(59,130,246,0.4), inset 0 -12px 32px rgba(0,0,0,0.1), inset 0 6px 20px rgba(255,255,255,0.4)'
                        : '0 8px 36px rgba(224,122,95,0.25), inset 0 -8px 24px rgba(0,0,0,0.06), inset 0 4px 16px rgba(255,255,255,0.3)',
                  }}
                />
                {/* Highlight/reflection spot */}
                <div
                  className="absolute rounded-full"
                  style={{
                    width: 56,
                    height: 36,
                    top: 24,
                    left: '50%',
                    transform: 'translateX(-50%) rotate(-15deg)',
                    background: 'radial-gradient(ellipse, rgba(255,255,255,0.55) 0%, transparent 70%)',
                    filter: 'blur(6px)',
                  }}
                />
                {/* Center icon */}
                <div className="relative z-10 flex items-center justify-center">
                  {state === 'listening' ? (
                    <MicWaveIcon />
                  ) : state === 'speaking' ? (
                    <SpeakerIcon />
                  ) : state === 'thinking' || state === 'transcribing' ? (
                    <ThinkingIcon />
                  ) : (
                    <MicIcon />
                  )}
                </div>
              </motion.button>
            </div>

            {/* Status */}
            <motion.div
              className="flex flex-col items-center gap-1.5"
              animate={{ opacity: 1 }}
              initial={{ opacity: 0 }}
            >
              <p className="text-[15px] font-semibold text-[#1a1a2e]/80">{STATUS[state]}</p>
              {transcript && (
                <p className="max-w-[280px] text-center text-[12px] leading-relaxed text-[#64748b]">
                  &ldquo;{transcript}&rdquo;
                </p>
              )}
            </motion.div>
          </div>

          {/* Bottom hint */}
          <div className="absolute bottom-[max(32px,env(safe-area-inset-bottom))] flex flex-col items-center gap-2">
            {state === 'speaking' && (
              <p className="text-[11px] text-[#64748b]/70">ট্যাপ করে থামান ও কথা বলুন</p>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="rounded-full border border-black/[0.08] bg-white/80 px-5 py-2 text-[13px] font-medium text-[#64748b] shadow-sm backdrop-blur-sm transition-colors hover:bg-white"
            >
              চ্যাটে ফিরুন
            </button>
          </div>

          <style jsx>{`
            @keyframes spin { to { transform: rotate(360deg); } }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function MicIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))' }}>
      <rect x="9" y="1" width="6" height="11" rx="3" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function MicWaveIcon() {
  return (
    <div className="flex items-center gap-[3px]">
      {[0, 1, 2, 3, 4].map(i => (
        <motion.div
          key={i}
          className="w-[3px] rounded-full bg-white"
          style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.15))' }}
          animate={{ height: [8, 20 + Math.random() * 12, 8] }}
          transition={{ duration: 0.6 + i * 0.1, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }}
        />
      ))}
    </div>
  )
}

function SpeakerIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))' }}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 010 14.14" />
      <path d="M15.54 8.46a5 5 0 010 7.07" />
    </svg>
  )
}

function ThinkingIcon() {
  return (
    <motion.div
      animate={{ rotate: 360 }}
      transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))' }}>
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    </motion.div>
  )
}

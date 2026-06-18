'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { useMicLevel } from '@/agent/hooks/useMicLevel'
import { fetchTtsAudio } from '@/agent/lib/voice-tts-client'
import type { VoiceState } from '@/agent/lib/voice-types'
import { VoiceOrb } from './VoiceOrb'
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
              if (openRef.current) setState('idle')
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
    if (!open) {
      recorder.cancel()
      stopTts()
      setState('idle')
      setTranscript('')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const orbScale = state === 'listening' ? 1 + Math.min(micLevel, 1) * 0.12 : 1

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
            className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] text-muted backdrop-blur-sm transition-colors hover:bg-white/[0.1]"
            aria-label="বন্ধ করুন"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>

          {/* Main content */}
          <div className="flex flex-col items-center gap-6">
            <motion.button
              type="button"
              onClick={handleTapOrb}
              className="relative flex select-none touch-manipulation items-center justify-center rounded-full focus:outline-none [-webkit-touch-callout:none]"
              animate={{ scale: orbScale }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              whileTap={{ scale: 0.94 }}
              aria-label="ভয়েস কন্ট্রোল"
            >
              <VoiceOrb state={state} micLevel={micLevel} size={188}>
                {state === 'listening' ? (
                  <MicWaveIcon />
                ) : state === 'speaking' ? (
                  <SpeakerIcon />
                ) : state === 'thinking' || state === 'transcribing' ? (
                  <ThinkingIcon />
                ) : (
                  <MicIcon />
                )}
              </VoiceOrb>
            </motion.button>

            {/* Status */}
            <motion.div
              className="flex flex-col items-center gap-1.5"
              animate={{ opacity: 1 }}
              initial={{ opacity: 0 }}
            >
              <p className="text-[15px] font-semibold text-cream/80">{STATUS[state]}</p>
              {transcript && (
                <p className="max-w-[280px] text-center text-[12px] leading-relaxed text-muted">
                  &ldquo;{transcript}&rdquo;
                </p>
              )}
            </motion.div>
          </div>

          {/* Bottom hint */}
          <div className="absolute bottom-[max(32px,env(safe-area-inset-bottom))] flex flex-col items-center gap-2">
            {state === 'speaking' && (
              <p className="text-[11px] text-muted/70">ট্যাপ করে থামান ও কথা বলুন</p>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="rounded-full border border-border bg-card/80 px-5 py-2 text-[13px] font-medium text-muted shadow-sm backdrop-blur-sm transition-colors hover:bg-card/80"
            >
              চ্যাটে ফিরুন
            </button>
          </div>

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
          className="w-[3px] rounded-full bg-card/80"
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

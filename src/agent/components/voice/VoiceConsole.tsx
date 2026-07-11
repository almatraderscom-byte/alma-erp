'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { useStreamingStt } from '@/agent/hooks/useStreamingStt'
import { useMicLevel } from '@/agent/hooks/useMicLevel'
import { useWakeWord, useLiveTranscript, wakeWordSupported } from '@/agent/hooks/useWakeWord'
import { useBargeIn } from '@/agent/hooks/useBargeIn'
import { unlockTtsAudio, primeSpokenAcks, playInstantAck, playMicChime, playMicCloseChime, speakLine } from '@/agent/lib/voice-tts-client'
import { createTtsChunkPlayer, type TtsChunkPlayer } from '@/agent/lib/tts-chunk-player'
import { toolDisplay } from '@/agent/lib/tool-labels'
import { voiceHaptic, agentReplyHaptic } from '@/agent/lib/haptics'
import type { VoiceState, VoiceTurnEvent } from '@/agent/lib/voice-types'
import { FluidOrb } from './FluidOrb'
import toast from 'react-hot-toast'

/**
 * Voice Console — the agent's voice-first face. Dark glass over the whole app:
 * the fluid orb front and center, live waveform while listening, and every tool
 * the head touches surfacing as a glass action card in the feed below, in real
 * time. Owner-approved design (2026-07-03 demo).
 *
 * Long speech is safe here: auto-stop waits 2.6s of true silence and the hard
 * cap is 3 minutes — a thinking pause mid-sentence never cuts the owner off.
 * Tap the orb while listening to stop early; tap while speaking to barge in.
 */

interface VoiceConsoleProps {
  open: boolean
  onClose: () => void
  /** Streams the turn; emits live events for the card feed; resolves to the reply text. */
  onSendMessage: (
    text: string,
    onEvent?: (evt: VoiceTurnEvent) => void,
    resumeOpts?: { approve: boolean },
  ) => Promise<string | null>
}

const STATUS: Record<VoiceState, string> = {
  idle: 'ট্যাপ করে বলুন',
  listening: 'শুনছি…',
  transcribing: 'বুঝে নিচ্ছি…',
  thinking: 'ভাবছি…',
  speaking: 'বলছি',
  error: 'আবার চেষ্টা করুন',
}

interface FeedCard {
  id: string
  kind: 'tool' | 'subagent' | 'approval' | 'ask' | 'model_switch'
  icon: string
  title: string
  sub?: string
  done: boolean
  success?: boolean
  at: string
  /** approval cards only */
  pendingActionId?: string
  busy?: boolean
  resolution?: 'approved' | 'rejected' | 'settled'
  /** ask cards only */
  askCardId?: string
  options?: string[]
}

const bnTime = () =>
  new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit' }).format(new Date())

/** Short spoken acknowledgements — the agent responds the moment it has HEARD,
 *  like a person would, instead of dead air until the full answer. */
const SPOKEN_ACKS = ['জি বস।', 'আচ্ছা বস, দেখছি।', 'ঠিক আছে বস।', 'জি, এক্ষুনি দেখছি।']

export default function VoiceConsole({ open, onClose, onSendMessage }: VoiceConsoleProps) {
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  /** Live subtitle while speaking: sentences already spoken + the one sounding now. */
  const [spoken, setSpoken] = useState<string[]>([])
  const [currentLine, setCurrentLine] = useState<string | null>(null)
  const [cards, setCards] = useState<FeedCard[]>([])
  /** Conversation mode (Siri+): when the reply finishes speaking, the mic
   *  re-opens by itself — no tap between turns. Silence for 8s ends the loop. */
  const [convoMode, setConvoMode] = useState(true)
  const convoModeRef = useRef(convoMode)
  useEffect(() => { convoModeRef.current = convoMode }, [convoMode])
  /** Last moment ANY audio line queued/sounded — drives the long-task keepalive. */
  const lastAudioRef = useRef(0)
  const playerRef = useRef<TtsChunkPlayer | null>(null)
  const currentLineRef = useRef<string | null>(null)
  const ackPlayedRef = useRef(false)
  /** Last exchanges kept on screen (Siri loses them; we don't). */
  const [history, setHistory] = useState<{ q: string; a: string }[]>([])
  const lastTextRef = useRef('')
  /** Stream died while the app was hidden — announce when the owner returns. */
  const hiddenAbortRef = useRef(false)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])
  const feedRef = useRef<HTMLDivElement | null>(null)

  const stopTts = useCallback(() => {
    playerRef.current?.dispose()
    playerRef.current = null
    currentLineRef.current = null
    setSpoken([])
    setCurrentLine(null)
  }, [])

  const onTurnEvent = useCallback((evt: VoiceTurnEvent) => {
    if (!openRef.current) return
    if (evt.type === 'tool_start') {
      const d = toolDisplay(evt.name)
      setCards((prev) => prev.some((c) => c.id === evt.id)
        ? prev
        : [...prev, { id: evt.id, kind: 'tool', icon: d.icon, title: d.label, done: false, at: bnTime() }])
    } else if (evt.type === 'tool_end') {
      setCards((prev) => prev.map((c) => c.id === evt.id
        ? { ...c, done: true, success: evt.success, sub: evt.resultPreview?.slice(0, 90) }
        : c))
    } else if (evt.type === 'subagent_start') {
      setCards((prev) => [...prev, {
        id: evt.id, kind: 'subagent', icon: '🤝', title: `${evt.roleLabel} কাজ করছে`, done: false, at: bnTime(),
      }])
    } else if (evt.type === 'subagent_end') {
      setCards((prev) => prev.map((c) => c.id === evt.id ? { ...c, done: true, success: evt.success !== false } : c))
    } else if (evt.type === 'confirm_card') {
      setCards((prev) => [...prev, {
        id: evt.pendingActionId ? `approval-${evt.pendingActionId}` : `approval-${prev.length}`,
        kind: 'approval', icon: '🔐',
        title: 'আপনার অনুমোদন দরকার',
        sub: evt.summary?.slice(0, 140) || (evt.pendingActionId ? undefined : 'চ্যাটে Approve কার্ডে ট্যাপ করুন'),
        pendingActionId: evt.pendingActionId,
        done: false, at: bnTime(),
      }])
    } else if (evt.type === 'text_delta') {
      setReply((prev) => prev + evt.delta)
    }
  }, [])

  // New cards slide in below — keep the latest visible.
  useEffect(() => {
    if (cards.length && feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [cards.length])

  // Conversation mode: when a spoken reply finishes, re-open the mic after a
  // beat — turn after turn with zero taps, like talking to a person. The 8s
  // no-speech abort below is the loop's exit so the mic never stays hot alone.
  const recorderRef = useRef<{ start: () => Promise<void> | void } | null>(null)
  const startListeningLateRef = useRef<() => void>(() => {})
  const autoListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleAutoListen = useCallback(() => {
    if (!convoModeRef.current || !openRef.current) return
    if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current)
    autoListenTimerRef.current = setTimeout(() => {
      if (openRef.current && convoModeRef.current && stateRef.current === 'idle') {
        startListeningLateRef.current()
      }
    }, 450)
  }, [])

  /**
   * One full voice turn. Everything a human assistant would SAY out loud is
   * said here: ack, tool narration, self-correction notes, clarifying
   * questions (ask cards), premium-model permission, errors, keepalives on
   * long tool chains. Silence is the enemy (owner audit 2026-07-03).
   */
  const runTurn = useCallback(async (text: string, resumeOpts?: { approve: boolean }) => {
    lastTextRef.current = text
    setTranscript(text)
    setReply('')
    setSpoken([])
    setCurrentLine(null)
    setState('thinking')
    // Streaming TTS: sentences start SOUNDING while the head is still
    // writing — 2-4s faster to first word than waiting for the whole reply.
    const player = createTtsChunkPlayer({
      onFirstPlay: () => {
        if (!openRef.current) return
        agentReplyHaptic()
        setState('speaking')
      },
      onChunkStart: (line, sys) => {
        lastAudioRef.current = Date.now()
        if (!openRef.current || sys) return
        // live subtitle: the sentence being SPOKEN right now lights up
        setSpoken((prev) => (currentLineRef.current ? [...prev, currentLineRef.current] : prev))
        currentLineRef.current = line
        setCurrentLine(line)
      },
      onDone: () => {
        playerRef.current = null
        currentLineRef.current = null
        if (openRef.current) {
          setCurrentLine(null)
          setState('idle')
          scheduleAutoListen()
        }
      },
    })
    playerRef.current = player
    // Human feel: the instant ack already played when the mic closed (cached
    // audio, zero wait); only fall back to the queue if the cache missed.
    if (!resumeOpts && !ackPlayedRef.current) {
      player.say(SPOKEN_ACKS[Math.floor(Math.random() * SPOKEN_ACKS.length)])
    }
    ackPlayedRef.current = false
    lastAudioRef.current = Date.now()

    // Long tool-chains must never go acoustically dark: if nothing has sounded
    // for ~14s while still thinking, say a keepalive.
    const heartbeat = setInterval(() => {
      if (!openRef.current || stateRef.current !== 'thinking') return
      if (Date.now() - lastAudioRef.current >= 14000) {
        lastAudioRef.current = Date.now()
        player.say('এখনো কাজ চলছে বস, একটু সময় দিন…')
      }
    }, 4000)

    let replyStarted = false
    let lastNarration = 0
    let sawInteraction = false // ask card / model switch — empty reply is then EXPECTED
    let verificationSaid = false
    try {
      const replyText = await onSendMessage(text, (evt) => {
        onTurnEvent(evt)
        if (evt.type === 'text_delta') {
          replyStarted = true
          player.feed(evt.delta)
        } else if (evt.type === 'tool_start' && !replyStarted) {
          // Narrate the work as it happens — first tool always, then at most
          // one line per ~6s so multi-tool turns don't become a monologue.
          if (Date.now() - lastNarration >= 6000) {
            lastNarration = Date.now()
            lastAudioRef.current = Date.now()
            player.say(`${toolDisplay(evt.name).label}, বস…`)
          }
        } else if (evt.type === 'ask_card') {
          // The head is ASKING — speak the question and show tappable options.
          sawInteraction = true
          lastAudioRef.current = Date.now()
          player.say(evt.question)
          if (evt.options.length > 0) {
            player.say(`${evt.options.join(', নাকি ')} — কোনটা, বস?`)
          }
          setCards((prev) => [...prev, {
            id: `ask-${evt.askCardId || prev.length}`, kind: 'ask', icon: '❓',
            title: evt.question.slice(0, 120), options: evt.options,
            askCardId: evt.askCardId, done: false, at: bnTime(),
          }])
        } else if (evt.type === 'model_switch_required') {
          sawInteraction = true
          lastAudioRef.current = Date.now()
          player.say('এটার জন্য আরও শক্তিশালী মডেল দরকার, বস — অনুমতি দিলে এগিয়ে যাই।')
          setCards((prev) => [...prev, {
            id: `modelswitch-${prev.length}`, kind: 'model_switch', icon: '🧠',
            title: 'শক্তিশালী মডেলের অনুমতি দরকার', done: false, at: bnTime(),
          }])
        } else if (evt.type === 'verification_retry') {
          if (!verificationSaid) {
            verificationSaid = true
            lastAudioRef.current = Date.now()
            player.say('একটু যাচাই করে ঠিক করে নিচ্ছি, বস…')
          }
        } else if (evt.type === 'error') {
          lastAudioRef.current = Date.now()
          player.say('দুঃখিত বস, একটা সমস্যা হয়েছে — একটু পরে আরেকবার বলুন।')
        }
      })
      clearInterval(heartbeat)
      if (!openRef.current) { player.dispose(); return }
      if (replyText?.trim()) {
        setReply(replyText)
        setHistory((prev) => [...prev.slice(-2), { q: text, a: replyText }])
        player.finish() // flush the tail; onDone → idle → auto-listen
      } else {
        // No reply text — but if we spoke a question/apology/permission line,
        // let it finish sounding instead of hard-cutting to silence.
        if (sawInteraction) setHistory((prev) => [...prev.slice(-2), { q: text, a: '' }])
        player.finish()
      }
    } catch {
      clearInterval(heartbeat)
      if (document.hidden) {
        // Stream died because the app went to background — announce on return.
        hiddenAbortRef.current = true
        player.dispose()
        playerRef.current = null
        if (openRef.current) setState('idle')
      } else {
        toast.error('উত্তর পেতে ব্যর্থ')
        player.say('দুঃখিত বস, সংযোগে সমস্যা হলো — আরেকবার বলুন।')
        player.finish() // onDone → idle → auto-listen keeps the loop alive
      }
    }
  }, [onSendMessage, onTurnEvent, scheduleAutoListen])

  const recorder = useVoiceRecorder({
    // Generous silence window + 3-minute cap: long instructions never get cut
    // mid-thought (the owner's #1 voice complaint — repeating himself).
    // (Short utterances end faster — adaptive endpointing in the hook.)
    autoStop: true,
    silenceMs: 2600,
    maxMs: 180000,
    // Conversation-mode wake with nobody speaking: give up quietly after 8s —
    // but SAY so with a closing chime, or the owner thinks it's still listening.
    noSpeechMs: 8000,
    onNoSpeech: () => {
      if (!openRef.current) return
      playMicCloseChime()
      voiceHaptic(false)
      setState('idle')
    },
    onTranscribed: (text) => { void runTurn(text) },
    onError: (msg) => {
      toast.error(msg)
      // Hands-free owner can't read a toast — say it (owner audit gap #5).
      void speakLine('শুনতে পাইনি বস — আরেকবার বলুন।', () => openRef.current)
      setState('error')
      setTimeout(() => { if (openRef.current) setState('idle') }, 2000)
    },
    // Feel the mic like Siri: chime + unmistakable medium tap when it opens,
    // light tick + INSTANT cached ack when it closes — zero dead air.
    onRecordingStart: () => { playMicChime(); voiceHaptic(true); setState('listening') },
    onRecordingStop: () => {
      voiceHaptic(false)
      if (stateRef.current === 'listening') {
        setState('transcribing')
        ackPlayedRef.current = playInstantAck(SPOKEN_ACKS[Math.floor(Math.random() * SPOKEN_ACKS.length)])
      }
    },
  })

  /* TRUE streaming STT (gap #12): words appear AS the owner speaks and the
     final text lands ~1-2s sooner than record-then-upload. Any start failure
     falls back to the recorder for that turn — streaming is an upgrade,
     never a dependency. */
  const sst = useStreamingStt({
    onFinal: (text) => { void runTurn(text) },
    onPartial: (liveText) => {
      if (openRef.current && stateRef.current === 'listening') setTranscript(liveText)
    },
    onNoSpeech: () => {
      if (!openRef.current) return
      playMicCloseChime()
      voiceHaptic(false)
      setState('idle')
    },
    onError: (msg) => {
      toast.error(msg)
      void speakLine('শুনতে পাইনি বস — আরেকবার বলুন।', () => openRef.current)
      setState('error')
      setTimeout(() => { if (openRef.current) setState('idle') }, 2000)
    },
    onStart: () => { playMicChime(); voiceHaptic(true); setState('listening') },
    onStop: () => {
      voiceHaptic(false)
      if (stateRef.current === 'listening') {
        setState('transcribing')
        ackPlayedRef.current = playInstantAck(SPOKEN_ACKS[Math.floor(Math.random() * SPOKEN_ACKS.length)])
      }
    },
    silenceMs: 2600,
    maxMs: 180000,
    noSpeechMs: 8000,
  })
  const sstRef = useRef(sst)
  useEffect(() => { sstRef.current = sst })

  /** One entry point for "open the mic": streaming first, recorder fallback. */
  const startListening = useCallback(() => {
    void sstRef.current.start().catch(() => {
      if (openRef.current) void recorderRef.current?.start()
    })
  }, [])
  const startListeningRef = useRef(startListening)
  useEffect(() => {
    startListeningRef.current = startListening
    startListeningLateRef.current = startListening // auto-listen loop uses the same door
  })

  const micLevel = useMicLevel(recorder.stream, recorder.recording)
  useEffect(() => { recorderRef.current = recorder })

  /* "ALMA" wake-word (hands-free start) — only where the browser supports
     SpeechRecognition (Android/desktop Chrome; iOS gets conversation mode +
     orb tap instead). Active only while idle so it never fights the recorder. */
  const wakeAvailable = wakeWordSupported()
  const [wakeMode, setWakeMode] = useState(true)
  useWakeWord(
    open && wakeAvailable && wakeMode && state === 'idle' && !recorder.recording && !sst.active,
    () => {
      if (openRef.current && stateRef.current === 'idle') startListeningRef.current()
    },
  )

  /* Live transcript while recording — SpeechRecognition path only matters on
     the recorder fallback; the streaming path gets real partials from STT. */
  useLiveTranscript(open && state === 'listening' && !sst.active, (liveText) => {
    if (openRef.current && stateRef.current === 'listening') setTranscript(liveText)
  })

  /* Voice barge-in — talk over the agent to interrupt, no tap needed. */
  useBargeIn(open && convoMode && state === 'speaking', () => {
    if (!openRef.current || stateRef.current !== 'speaking') return
    stopTts()
    setState('idle')
    setTimeout(() => {
      if (openRef.current && stateRef.current === 'idle') {
        setTranscript('')
        setReply('')
        startListeningRef.current()
      }
    }, 150)
  })

  /* Pre-synthesize the ack lines once the console opens — instant playback later. */
  useEffect(() => {
    if (open) void primeSpokenAcks(SPOKEN_ACKS)
  }, [open])

  /* Spoken greeting the moment the console opens — presence from second one.
     (iOS may block audio before the first tap; then it fails silently and the
     caption carries the greeting instead.) */
  useEffect(() => {
    if (!open) return
    const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false }).format(new Date()), 10)
    const daypart = hour >= 5 && hour < 12 ? 'সুপ্রভাত' : hour >= 12 && hour < 17 ? 'শুভ দুপুর' : hour >= 17 && hour < 21 ? 'শুভ সন্ধ্যা' : 'শুভ রাত্রি'
    const t = setTimeout(() => {
      void speakLine(`${daypart} বস — বলুন, কী করতে হবে।`, () => openRef.current && stateRef.current === 'idle')
    }, 500)
    return () => clearTimeout(t)
  }, [open])

  /* The stream died while the app was hidden — tell the owner when he returns
     instead of leaving a mystery (partial fix for backgrounded-turn loss). */
  useEffect(() => {
    if (!open) return
    const onVis = () => {
      if (!document.hidden && hiddenAbortRef.current) {
        hiddenAbortRef.current = false
        void speakLine('বস, মাঝপথে অ্যাপ ব্যাকগ্রাউন্ডে চলে গিয়েছিল — উত্তরটা চ্যাটে রেখে দিয়েছি।', () => openRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [open])

  /** Ask-card answer: record it AND continue the conversation with the choice. */
  const answerAskCard = useCallback((cardId: string, askCardId: string, option: string) => {
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, done: true, success: true, sub: `✓ ${option}` } : c))
    if (askCardId) {
      void fetch(`/api/assistant/ask-cards/${askCardId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option }),
      }).catch(() => { /* the runTurn below still carries the answer */ })
    }
    stopTts()
    void runTurn(option)
  }, [runTurn, stopTts])

  /** Premium-model permission: approve re-runs the SAME question with resume. */
  const resolveModelSwitch = useCallback((cardId: string, approve: boolean) => {
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, done: true, success: approve, sub: approve ? '✓ অনুমতি দেওয়া হয়েছে' : 'বাতিল' } : c))
    if (approve && lastTextRef.current) {
      stopTts()
      void runTurn(lastTextRef.current, { approve: true })
    } else {
      void speakLine('আচ্ছা বস, তাহলে বাদ দিলাম।', () => openRef.current)
    }
  }, [runTurn, stopTts])

  const handleTapOrb = useCallback(() => {
    // Inside the tap gesture: bless the persistent audio element so the reply
    // can actually sound on iOS WKWebView (autoplay policy).
    unlockTtsAudio()
    if (state === 'listening') {
      if (sst.active) sst.stop()
      else recorder.stop()
    } else if (state === 'speaking') {
      // barge-in: stop the reply, start listening again
      stopTts()
      setState('idle')
      setTimeout(() => {
        if (openRef.current) {
          setTranscript('')
          setReply('')
          startListening()
        }
      }, 200)
    } else if (state === 'idle' || state === 'error') {
      setTranscript('')
      setReply('')
      startListening()
    }
  }, [state, recorder, sst, stopTts, startListening])

  /** Approve/reject a pending action right here — no trip back to the chat.
   *  409/410/404 mean "already settled elsewhere/expired" — calm, never red. */
  const resolveApproval = useCallback(async (cardId: string, actionId: string, approve: boolean) => {
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, busy: true } : c))
    let resolution: FeedCard['resolution'] = 'settled'
    let failed = false
    try {
      const res = await fetch(`/api/assistant/actions/${actionId}/${approve ? 'approve' : 'reject'}`, { method: 'POST' })
      if (res.ok) resolution = approve ? 'approved' : 'rejected'
      else if (![404, 409, 410].includes(res.status)) failed = true
    } catch { failed = true }
    setCards((prev) => prev.map((c) => c.id === cardId
      ? { ...c, busy: false, done: !failed, success: !failed, resolution: failed ? undefined : resolution }
      : c))
    if (failed) { toast.error('অনুমোদন পাঠানো যায়নি — আবার চেষ্টা করুন'); return }
    // A reply may still be speaking on the SAME audio element — hand it over
    // cleanly first, or the player's chain is severed and auto-listen dies.
    if (playerRef.current) stopTts()
    void speakLine(
      resolution === 'approved' ? 'অনুমোদন করে দিয়েছি বস, কাজ এগোচ্ছে।'
        : resolution === 'rejected' ? 'বাতিল করে দিয়েছি, বস।'
          : 'এটা আগেই নিষ্পত্তি হয়ে গেছে, বস।',
      () => openRef.current && stateRef.current !== 'listening',
    )
  }, [stopTts])

  const handleClose = useCallback(() => {
    recorder.cancel()
    sst.cancel()
    stopTts()
    setState('idle')
    setTranscript('')
    setReply('')
    setCards([])
    onClose()
  }, [recorder, sst, stopTts, onClose])

  useEffect(() => {
    if (!open) {
      if (autoListenTimerRef.current) { clearTimeout(autoListenTimerRef.current); autoListenTimerRef.current = null }
      recorder.cancel()
      sst.cancel()
      stopTts()
      setState('idle')
      setTranscript('')
      setReply('')
      setCards([])
    }
    // Animation-timeline rescue: on machines where the document animation
    // timeline is frozen (seen live: Chrome with hardware acceleration off),
    // the framer fade never completes — enter sticks semi-transparent and exit
    // never unmounts. 600ms after any open/close flip, force-finish the fade;
    // on healthy devices the 250ms fade is long done and this is a no-op.
    const t = setTimeout(() => {
      document.querySelectorAll('.vc-root').forEach((el) => {
        el.getAnimations?.().forEach((a) => { try { a.finish() } catch { /* infinite anims */ } })
      })
    }, 600)
    return () => clearTimeout(t)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Portal to <body>: the app shell's stacking contexts trap the overlay's
  // z-index below the fixed bottom nav (z-50 at root level) — on the phone the
  // nav rendered ON TOP of the console and hid the dock. Escaping to body plus
  // a root-level z-index puts the console above everything, as designed.
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="vc-root"
        >
          {/* ambient field */}
          <div className="vc-aurora" data-state={state} />
          <div className="vc-dots" />

          {/* close */}
          <button type="button" onClick={handleClose} className="vc-close" aria-label="বন্ধ করুন">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>

          <div className={`vc-main${cards.length === 0 ? ' centered' : ''}`}>
            {/* state badge */}
            <div className="vc-badge" data-state={state}><i />{STATUS[state]}</div>

            {/* the orb */}
            <motion.button
              type="button"
              onClick={handleTapOrb}
              className="vc-orbbtn"
              whileTap={{ scale: 0.95 }}
              aria-label="ভয়েস কন্ট্রোল"
            >
              <FluidOrb state={state} micLevel={sst.active ? sst.level : micLevel} size={Math.min(280, typeof window !== 'undefined' ? window.innerWidth * 0.62 : 280)} />
            </motion.button>

            {/* transcript + reply */}
            <div className="vc-voicezone">
              {/* previous exchange stays readable — glancing away must not erase it */}
              {history.length > 0 && state !== 'speaking' && !reply && (
                <div className="vc-history">
                  <p className="q">{history[history.length - 1].q}</p>
                  {history[history.length - 1].a && <p className="a">{history[history.length - 1].a}</p>}
                </div>
              )}
              {transcript && (
                <div className="vc-transcript"><span className="mic">MIC</span>{transcript}</div>
              )}
              {state === 'speaking' && currentLine ? (
                /* live subtitle: the sentence being spoken glows, said ones dim */
                <p className="vc-caption">
                  {spoken.length > 0 && <span className="said">{spoken.slice(-2).join(' ')} </span>}
                  <span className="now">{currentLine}</span>
                </p>
              ) : reply ? (
                <p className="vc-caption">{reply}</p>
              ) : (
                <p className="vc-caption dim">
                  {state === 'idle'
                    ? (wakeAvailable && wakeMode
                        ? <>&ldquo;ALMA&rdquo; বললেই শুনব, <span className="sir">Boss</span> — বা অর্বে ট্যাপ করুন।</>
                        : <>বলুন, <span className="sir">Boss</span> — অর্বে ট্যাপ করুন।</>)
                    : ' '}
                </p>
              )}
            </div>

            {/* live action feed */}
            {cards.length > 0 && (
              <div className="vc-feed" ref={feedRef}>
                {cards.map((c) => (
                  <motion.div
                    key={c.id}
                    initial={{ opacity: 0, y: 14, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 26 }}
                    className={`vc-card${c.kind === 'approval' ? ' approval' : ''}`}
                  >
                    <span className="ic">{c.icon}</span>
                    <span className="tt">
                      {c.title}
                      {c.sub ? <small>{c.sub}</small> : null}
                    </span>
                    {c.kind === 'ask' && !c.done && (c.options?.length ?? 0) > 0 ? (
                      <span className="acts wrap">
                        {c.options!.slice(0, 4).map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            className="rejectbtn"
                            onClick={() => answerAskCard(c.id, c.askCardId ?? '', opt)}
                          >{opt}</button>
                        ))}
                      </span>
                    ) : c.kind === 'model_switch' && !c.done ? (
                      <span className="acts">
                        <button type="button" className="approve" onClick={() => resolveModelSwitch(c.id, true)}>অনুমতি দিন</button>
                        <button type="button" className="rejectbtn" onClick={() => resolveModelSwitch(c.id, false)}>থাক</button>
                      </span>
                    ) : c.kind === 'approval' && c.pendingActionId && !c.done ? (
                      <span className="acts">
                        <button
                          type="button"
                          disabled={c.busy}
                          className="approve"
                          onClick={() => void resolveApproval(c.id, c.pendingActionId!, true)}
                        >{c.busy ? '…' : 'অনুমোদন'}</button>
                        <button
                          type="button"
                          disabled={c.busy}
                          className="rejectbtn"
                          onClick={() => void resolveApproval(c.id, c.pendingActionId!, false)}
                        >বাতিল</button>
                      </span>
                    ) : (
                      <span className={`pill ${c.done ? (c.success === false ? 'fail' : 'ok') : 'run'}`}>
                        {c.kind === 'approval'
                          ? (c.resolution === 'approved' ? 'অনুমোদিত'
                            : c.resolution === 'rejected' ? 'বাতিল'
                              : c.resolution === 'settled' ? 'নিষ্পত্তি'
                                : 'অপেক্ষায়')
                          : c.done ? (c.success === false ? 'ব্যর্থ' : 'সম্পন্ন') : 'চলছে…'}
                      </span>
                    )}
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* bottom dock */}
          <div className="vc-dock">
            {state === 'speaking' && <p className="hint">ট্যাপ করে থামান ও কথা বলুন</p>}
            {state === 'listening' && (() => { const s = sst.active ? sst.seconds : recorder.recordSecs; return (
              <p className="hint">চুপ করলেই পাঠিয়ে দেব — তাড়া নেই, {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</p>
            ) })()}
            <div className="vc-dockrow">
              <button
                type="button"
                onClick={() => setConvoMode((v) => !v)}
                className={`vc-convo${convoMode ? ' on' : ''}`}
                aria-pressed={convoMode}
              >
                <i />কথোপকথন {convoMode ? 'চালু' : 'বন্ধ'}
              </button>
              {wakeAvailable && (
                <button
                  type="button"
                  onClick={() => setWakeMode((v) => !v)}
                  className={`vc-convo${wakeMode ? ' on' : ''}`}
                  aria-pressed={wakeMode}
                >
                  <i />&ldquo;ALMA&rdquo; ডাক {wakeMode ? 'চালু' : 'বন্ধ'}
                </button>
              )}
              <button type="button" onClick={handleClose} className="vc-back">চ্যাটে ফিরুন</button>
            </div>
          </div>

          {/* `jsx global` is required: framer-motion elements (vc-root, vc-card,
              vc-orbbtn) never receive styled-jsx's scope class, so scoped rules
              silently don't match them. Class names are vc- prefixed + unique. */}
          <style jsx global>{`
            .vc-root {
              position: fixed;
              inset: 0;
              z-index: 1000; /* above the app's fixed bottom nav (z-50) */
              display: flex;
              flex-direction: column;
              align-items: center;
              background: #04070d;
              color: #eaf2fb;
              overflow: hidden;
            }
            .vc-aurora {
              position: absolute;
              inset: 0;
              pointer-events: none;
              background:
                radial-gradient(620px 480px at 50% 20%, rgba(80, 220, 200, 0.13), transparent 68%),
                radial-gradient(900px 700px at 85% 95%, rgba(80, 160, 220, 0.06), transparent 70%);
              transition: background 1s ease;
            }
            .vc-aurora[data-state='listening'] { background: radial-gradient(620px 480px at 50% 20%, rgba(62, 224, 143, 0.14), transparent 68%), radial-gradient(900px 700px at 85% 95%, rgba(62, 224, 160, 0.05), transparent 70%); }
            .vc-aurora[data-state='thinking'],
            .vc-aurora[data-state='transcribing'] { background: radial-gradient(620px 480px at 50% 20%, rgba(157, 123, 255, 0.15), transparent 68%), radial-gradient(900px 700px at 85% 95%, rgba(140, 110, 255, 0.06), transparent 70%); }
            .vc-aurora[data-state='speaking'] { background: radial-gradient(620px 480px at 50% 20%, rgba(78, 163, 255, 0.14), transparent 68%), radial-gradient(900px 700px at 85% 95%, rgba(78, 140, 255, 0.06), transparent 70%); }
            .vc-dots {
              position: absolute;
              inset: 0;
              pointer-events: none;
              background-image: radial-gradient(rgba(150, 200, 245, 0.1) 1px, transparent 1.5px);
              background-size: 26px 26px;
              -webkit-mask-image: radial-gradient(560px 460px at 50% 24%, #000 20%, transparent 75%);
              mask-image: radial-gradient(560px 460px at 50% 24%, #000 20%, transparent 75%);
            }
            .vc-close {
              position: absolute;
              right: 16px;
              top: max(16px, env(safe-area-inset-top));
              z-index: 10;
              display: flex;
              width: 40px;
              height: 40px;
              align-items: center;
              justify-content: center;
              border-radius: 9999px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              background: rgba(140, 190, 240, 0.06);
              color: #7c92a9;
              backdrop-filter: blur(12px);
              -webkit-backdrop-filter: blur(12px);
            }
            .vc-main {
              position: relative;
              z-index: 1;
              flex: 1;
              width: 100%;
              max-width: 560px;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: flex-start;
              padding: calc(24px + env(safe-area-inset-top)) 18px 0;
              gap: 6px;
              min-height: 0;
            }
            /* No cards yet → the orb group floats centered on the tall phone
               screen instead of huddling at the top over a void. */
            .vc-main.centered { justify-content: center; padding-bottom: 10vh; }
            .vc-badge {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              margin-top: 6px;
              padding: 6px 14px;
              border-radius: 9999px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              background: rgba(140, 190, 240, 0.06);
              backdrop-filter: blur(14px);
              -webkit-backdrop-filter: blur(14px);
              font-size: 13px;
              color: #9db2c9;
            }
            .vc-badge i {
              width: 8px;
              height: 8px;
              border-radius: 9999px;
              background: #46e0c6;
              box-shadow: 0 0 12px #46e0c6;
              transition: background 0.5s, box-shadow 0.5s;
            }
            .vc-badge[data-state='listening'] i { background: #3be08f; box-shadow: 0 0 12px #3be08f; }
            .vc-badge[data-state='thinking'] i,
            .vc-badge[data-state='transcribing'] i { background: #9d7bff; box-shadow: 0 0 12px #9d7bff; }
            .vc-badge[data-state='speaking'] i { background: #4ea3ff; box-shadow: 0 0 12px #4ea3ff; }
            .vc-badge[data-state='error'] i { background: #f06e5a; box-shadow: 0 0 12px #f06e5a; }
            .vc-orbbtn {
              position: relative;
              border: none;
              background: none;
              padding: 24px;
              cursor: pointer;
              -webkit-tap-highlight-color: transparent;
            }
            .vc-orbbtn:focus-visible { outline: 2px solid rgba(120, 220, 200, 0.7); outline-offset: 8px; border-radius: 9999px; }
            .vc-voicezone {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 10px;
              text-align: center;
              min-height: 74px;
              width: 100%;
            }
            .vc-transcript {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              max-width: 100%;
              padding: 7px 16px;
              border-radius: 9999px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              background: rgba(140, 190, 240, 0.06);
              color: #9db2c9;
              font-size: 13.5px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .vc-transcript .mic {
              color: #3be08f;
              font-size: 10.5px;
              font-weight: 700;
              letter-spacing: 0.14em;
              flex: none;
            }
            .vc-caption {
              font-size: 16.5px;
              line-height: 1.75;
              max-width: 480px;
              color: #eaf2fb;
            }
            .vc-caption.dim { color: #7c92a9; font-size: 15px; }
            .vc-caption .said { color: #55708c; }
            .vc-caption .now { color: #eaf2fb; text-shadow: 0 0 18px rgba(120, 200, 255, 0.25); }
            .vc-history {
              max-width: 480px;
              text-align: center;
              opacity: 0.55;
            }
            .vc-history .q { font-size: 12px; color: #55708c; }
            .vc-history .a {
              font-size: 13px;
              color: #7c92a9;
              display: -webkit-box;
              -webkit-line-clamp: 2;
              -webkit-box-orient: vertical;
              overflow: hidden;
            }
            .vc-card .acts.wrap { flex-wrap: wrap; justify-content: flex-end; max-width: 55%; }
            .vc-caption .sir { color: #e2b366; }
            .vc-feed {
              width: 100%;
              display: flex;
              flex-direction: column;
              gap: 9px;
              overflow-y: auto;
              min-height: 0;
              flex: 1;
              padding: 8px 2px 14px;
              -webkit-overflow-scrolling: touch;
            }
            .vc-card {
              display: flex;
              align-items: center;
              gap: 11px;
              padding: 12px 14px;
              border-radius: 16px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              /* glass baked into the gradient — backdrop-filter inside an
                 animating transform is a known iOS gray-box breaker, and over
                 this near-black root a real blur buys nothing visually */
              background: linear-gradient(160deg, rgba(140, 190, 240, 0.14), rgba(140, 190, 240, 0.05));
              box-shadow: 0 10px 32px rgba(1, 4, 10, 0.4);
            }
            .vc-card.approval { border-color: rgba(226, 179, 102, 0.4); }
            .vc-card .ic {
              width: 32px;
              height: 32px;
              flex: none;
              display: grid;
              place-items: center;
              font-size: 15px;
              border-radius: 10px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              background: rgba(140, 190, 240, 0.07);
            }
            .vc-card .tt {
              flex: 1;
              min-width: 0;
              font-size: 13.5px;
              font-weight: 600;
              color: #eaf2fb;
            }
            .vc-card .tt small {
              display: block;
              font-weight: 400;
              font-size: 11.5px;
              color: #55708c;
              margin-top: 1px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .vc-card .pill {
              flex: none;
              font-size: 11px;
              padding: 4px 10px;
              border-radius: 9999px;
              white-space: nowrap;
            }
            .vc-card .pill.run { color: #f4c86a; border: 1px solid rgba(244, 200, 106, 0.35); background: rgba(244, 200, 106, 0.08); }
            .vc-card .pill.ok { color: #3be08f; border: 1px solid rgba(59, 224, 143, 0.35); background: rgba(59, 224, 143, 0.08); }
            .vc-card .pill.fail { color: #f27e7e; border: 1px solid rgba(242, 126, 126, 0.35); background: rgba(242, 126, 126, 0.08); }
            .vc-card .acts { display: inline-flex; gap: 7px; flex: none; }
            .vc-card .acts button {
              border-radius: 9999px;
              font-size: 12px;
              font-weight: 600;
              padding: 6px 13px;
              border: none;
            }
            .vc-card .acts button:disabled { opacity: 0.55; }
            .vc-card .acts .approve { color: #041018; background: linear-gradient(140deg, #7ce3c8, #4ea3ff); }
            .vc-card .acts .rejectbtn {
              color: #9db2c9;
              background: rgba(140, 190, 240, 0.07);
              border: 1px solid rgba(160, 200, 240, 0.18);
            }
            .vc-dock {
              position: relative;
              z-index: 1;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 8px;
              padding: 10px 18px calc(24px + env(safe-area-inset-bottom));
            }
            .vc-dock .hint { font-size: 12px; color: #55708c; font-variant-numeric: tabular-nums; }
            .vc-dockrow { display: flex; align-items: center; gap: 10px; }
            .vc-convo {
              display: inline-flex;
              align-items: center;
              gap: 7px;
              border-radius: 9999px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              background: rgba(140, 190, 240, 0.06);
              padding: 9px 16px;
              font-size: 12.5px;
              font-weight: 500;
              color: #7c92a9;
            }
            .vc-convo i {
              width: 7px;
              height: 7px;
              border-radius: 9999px;
              background: #55708c;
              transition: background 0.3s, box-shadow 0.3s;
            }
            .vc-convo.on { color: #9db2c9; border-color: rgba(59, 224, 143, 0.3); }
            .vc-convo.on i { background: #3be08f; box-shadow: 0 0 8px #3be08f; }
            .vc-back {
              border-radius: 9999px;
              border: 1px solid rgba(160, 200, 240, 0.13);
              background: rgba(140, 190, 240, 0.06);
              backdrop-filter: blur(12px);
              -webkit-backdrop-filter: blur(12px);
              padding: 9px 20px;
              font-size: 13px;
              font-weight: 500;
              color: #9db2c9;
            }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

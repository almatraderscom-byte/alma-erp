'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { useMicLevel } from '@/agent/hooks/useMicLevel'
import { useWakeWord, wakeWordSupported } from '@/agent/hooks/useWakeWord'
import { unlockTtsAudio } from '@/agent/lib/voice-tts-client'
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
  onSendMessage: (text: string, onEvent?: (evt: VoiceTurnEvent) => void) => Promise<string | null>
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
  kind: 'tool' | 'subagent' | 'approval'
  icon: string
  title: string
  sub?: string
  done: boolean
  success?: boolean
  at: string
}

const bnTime = () =>
  new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit' }).format(new Date())

/** Short spoken acknowledgements — the agent responds the moment it has HEARD,
 *  like a person would, instead of dead air until the full answer. */
const SPOKEN_ACKS = ['জি স্যার।', 'আচ্ছা স্যার, দেখছি।', 'ঠিক আছে স্যার।', 'জি, এক্ষুনি দেখছি।']

export default function VoiceConsole({ open, onClose, onSendMessage }: VoiceConsoleProps) {
  const [state, setState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  const [cards, setCards] = useState<FeedCard[]>([])
  /** Conversation mode (Siri+): when the reply finishes speaking, the mic
   *  re-opens by itself — no tap between turns. Silence for 8s ends the loop. */
  const [convoMode, setConvoMode] = useState(true)
  const convoModeRef = useRef(convoMode)
  useEffect(() => { convoModeRef.current = convoMode }, [convoMode])
  const playerRef = useRef<TtsChunkPlayer | null>(null)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])
  const feedRef = useRef<HTMLDivElement | null>(null)

  const stopTts = useCallback(() => {
    playerRef.current?.dispose()
    playerRef.current = null
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
        id: `approval-${prev.length}`, kind: 'approval', icon: '🔐',
        title: 'আপনার অনুমোদন দরকার', sub: 'চ্যাটে Approve কার্ডে ট্যাপ করুন', done: false, at: bnTime(),
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
  const autoListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleAutoListen = useCallback(() => {
    if (!convoModeRef.current || !openRef.current) return
    if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current)
    autoListenTimerRef.current = setTimeout(() => {
      if (openRef.current && convoModeRef.current && stateRef.current === 'idle') {
        recorderRef.current?.start()
      }
    }, 450)
  }, [])

  const recorder = useVoiceRecorder({
    // Generous silence window + 3-minute cap: long instructions never get cut
    // mid-thought (the owner's #1 voice complaint — repeating himself).
    autoStop: true,
    silenceMs: 2600,
    maxMs: 180000,
    // Conversation-mode wake with nobody speaking: give up quietly after 8s.
    noSpeechMs: 8000,
    onNoSpeech: () => {
      if (!openRef.current) return
      setState('idle')
    },
    onTranscribed: async (text) => {
      setTranscript(text)
      setReply('')
      setState('thinking')
      // Streaming TTS: sentences start SOUNDING while the head is still
      // writing — 2-4s faster to first word than waiting for the whole reply.
      const player = createTtsChunkPlayer({
        onFirstPlay: () => {
          if (!openRef.current) return
          agentReplyHaptic()
          setState('speaking')
        },
        onDone: () => {
          playerRef.current = null
          if (openRef.current) {
            setState('idle')
            scheduleAutoListen()
          }
        },
      })
      playerRef.current = player
      // Human feel: speak an instant ack, then narrate the first tool while the
      // head is still working — the owner hears the PROCESS, not just a result.
      player.say(SPOKEN_ACKS[Math.floor(Math.random() * SPOKEN_ACKS.length)])
      let replyStarted = false
      let narrated = false
      try {
        const replyText = await onSendMessage(text, (evt) => {
          onTurnEvent(evt)
          if (evt.type === 'text_delta') {
            replyStarted = true
            player.feed(evt.delta)
          } else if (evt.type === 'tool_start' && !narrated && !replyStarted) {
            narrated = true
            player.say(`${toolDisplay(evt.name).label}, স্যার…`)
          }
        })
        if (!openRef.current) { player.dispose(); return }
        if (replyText?.trim()) {
          setReply(replyText)
          player.finish() // flush the tail; onDone → idle → auto-listen
        } else {
          player.dispose()
          playerRef.current = null
          setState('idle')
        }
      } catch {
        player.dispose()
        playerRef.current = null
        toast.error('উত্তর পেতে ব্যর্থ')
        setState('error')
      }
    },
    onError: (msg) => {
      toast.error(msg)
      setState('error')
      setTimeout(() => { if (openRef.current) setState('idle') }, 2000)
    },
    // Feel the mic like Siri: unmistakable medium tap when it opens, light
    // tick when it closes, light pulse when the reply starts speaking.
    onRecordingStart: () => { voiceHaptic(true); setState('listening') },
    onRecordingStop: () => {
      voiceHaptic(false)
      if (stateRef.current === 'listening') setState('transcribing')
    },
  })

  const micLevel = useMicLevel(recorder.stream, recorder.recording)
  useEffect(() => { recorderRef.current = recorder })

  /* "ALMA" wake-word (hands-free start) — only where the browser supports
     SpeechRecognition (Android/desktop Chrome; iOS gets conversation mode +
     orb tap instead). Active only while idle so it never fights the recorder. */
  const wakeAvailable = wakeWordSupported()
  const [wakeMode, setWakeMode] = useState(true)
  useWakeWord(
    open && wakeAvailable && wakeMode && state === 'idle' && !recorder.recording,
    () => {
      if (openRef.current && stateRef.current === 'idle') recorderRef.current?.start()
    },
  )

  const handleTapOrb = useCallback(() => {
    // Inside the tap gesture: bless the persistent audio element so the reply
    // can actually sound on iOS WKWebView (autoplay policy).
    unlockTtsAudio()
    if (state === 'listening') {
      recorder.stop()
    } else if (state === 'speaking') {
      // barge-in: stop the reply, start listening again
      stopTts()
      setState('idle')
      setTimeout(() => {
        if (openRef.current) {
          setTranscript('')
          setReply('')
          recorder.start()
        }
      }, 200)
    } else if (state === 'idle' || state === 'error') {
      setTranscript('')
      setReply('')
      recorder.start()
    }
  }, [state, recorder, stopTts])

  const handleClose = useCallback(() => {
    recorder.cancel()
    stopTts()
    setState('idle')
    setTranscript('')
    setReply('')
    setCards([])
    onClose()
  }, [recorder, stopTts, onClose])

  useEffect(() => {
    if (!open) {
      if (autoListenTimerRef.current) { clearTimeout(autoListenTimerRef.current); autoListenTimerRef.current = null }
      recorder.cancel()
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
              <FluidOrb state={state} micLevel={micLevel} size={Math.min(280, typeof window !== 'undefined' ? window.innerWidth * 0.62 : 280)} />
            </motion.button>

            {/* transcript + reply */}
            <div className="vc-voicezone">
              {transcript && (
                <div className="vc-transcript"><span className="mic">MIC</span>{transcript}</div>
              )}
              {reply ? (
                <p className="vc-caption">{reply}</p>
              ) : (
                <p className="vc-caption dim">
                  {state === 'idle'
                    ? (wakeAvailable && wakeMode
                        ? <>&ldquo;ALMA&rdquo; বললেই শুনব, <span className="sir">Sir</span> — বা অর্বে ট্যাপ করুন।</>
                        : <>বলুন, <span className="sir">Sir</span> — অর্বে ট্যাপ করুন।</>)
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
                    <span className={`pill ${c.done ? (c.success === false ? 'fail' : 'ok') : 'run'}`}>
                      {c.kind === 'approval' ? 'অপেক্ষায়' : c.done ? (c.success === false ? 'ব্যর্থ' : 'সম্পন্ন') : 'চলছে…'}
                    </span>
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* bottom dock */}
          <div className="vc-dock">
            {state === 'speaking' && <p className="hint">ট্যাপ করে থামান ও কথা বলুন</p>}
            {state === 'listening' && <p className="hint">চুপ করলেই পাঠিয়ে দেব — তাড়া নেই, {Math.floor(recorder.recordSecs / 60)}:{String(recorder.recordSecs % 60).padStart(2, '0')}</p>}
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

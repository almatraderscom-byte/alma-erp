'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  OPENAI_REALTIME_TRIAL_MODEL,
  OPENAI_REALTIME_TRIAL_SECONDS,
  selectPreferredAudioInput,
  type OpenAIRealtimeTrialVoice,
} from '@/agent/lib/openai-realtime-trial'
import type { VoiceState } from '@/agent/lib/voice-types'
import { FluidOrb } from './FluidOrb'

type TrialStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

const VOICES: Array<{ id: OpenAIRealtimeTrialVoice; label: string; description: string }> = [
  { id: 'cedar', label: 'Cedar', description: 'উষ্ণ, গভীর' },
  { id: 'marin', label: 'Marin', description: 'স্বচ্ছ, প্রাণবন্ত' },
]

type InputProfile = 'far_field' | 'near_field'

type RealtimeEvent = {
  type?: string
  delta?: string
  transcript?: string
  error?: { message?: string }
  response?: {
    status?: string
    status_details?: { error?: { message?: string } }
  }
}

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
} satisfies MediaTrackConstraints

function inputProfileFor(label: string): InputProfile {
  return /airpods|headset|earbud|bluetooth|lavalier|lapel|boom/i.test(label)
    ? 'near_field'
    : 'far_field'
}

function orbState(status: TrialStatus): VoiceState {
  if (status === 'connecting' || status === 'thinking') return 'thinking'
  if (status === 'listening') return 'listening'
  if (status === 'speaking') return 'speaking'
  if (status === 'error') return 'error'
  return 'idle'
}

function statusCopy(status: TrialStatus): string {
  if (status === 'connecting') return 'সংযোগ হচ্ছে…'
  if (status === 'listening') return 'বলুন Boss, শুনছি'
  if (status === 'thinking') return 'বুঝছি…'
  if (status === 'speaking') return 'কথা বলছি'
  if (status === 'error') return 'সংযোগ হয়নি'
  return 'ট্রায়াল শুরু করুন'
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function errorMessage(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('notallowederror') || lower.includes('permission')) {
    return 'মাইক্রোফোনের অনুমতি দিন, তারপর আবার চেষ্টা করুন।'
  }
  if (lower.includes('trial_disabled')) return 'এই ট্রায়ালটি শুধু preview-তে চালু আছে।'
  if (lower.includes('openai_api_key')) return 'Preview-তে OpenAI key পাওয়া যায়নি।'
  return 'Realtime voice সংযোগ করা যায়নি। একটু পরে আবার চেষ্টা করুন।'
}

export default function OpenAIRealtimeTrial() {
  const [voice, setVoice] = useState<OpenAIRealtimeTrialVoice>('marin')
  const [status, setStatus] = useState<TrialStatus>('idle')
  const [remaining, setRemaining] = useState(OPENAI_REALTIME_TRIAL_SECONDS)
  const [muted, setMuted] = useState(false)
  const [notice, setNotice] = useState('এটি শুধু voice feel পরীক্ষা—ERP data বা action যুক্ত নয়।')
  const [micLevel, setMicLevel] = useState(0)
  const [micLabel, setMicLabel] = useState('মাইক্রোফোন এখনো চালু হয়নি')
  const [uplinkBytes, setUplinkBytes] = useState(0)
  const [eventStage, setEventStage] = useState('অপেক্ষমাণ')
  const [inputTranscript, setInputTranscript] = useState('')
  const [outputTranscript, setOutputTranscript] = useState('')

  const peerRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const statsTimerRef = useRef<number | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const intentionalCloseRef = useRef(false)

  const releaseResources = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current)
      statsTimerRef.current = null
    }
    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current)
      meterFrameRef.current = null
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined)
      audioContextRef.current = null
    }
    channelRef.current?.close()
    channelRef.current = null
    peerRef.current?.close()
    peerRef.current = null
    micStreamRef.current?.getTracks().forEach(track => track.stop())
    micStreamRef.current = null
    if (audioRef.current) audioRef.current.srcObject = null
  }, [])

  const stopSession = useCallback((reason: 'manual' | 'limit' = 'manual') => {
    intentionalCloseRef.current = true
    releaseResources()
    setStatus('idle')
    setMuted(false)
    setRemaining(OPENAI_REALTIME_TRIAL_SECONDS)
    setMicLevel(0)
    setUplinkBytes(0)
    setEventStage('বন্ধ')
    setNotice(reason === 'limit'
      ? '৩ মিনিটের নিরাপদ ট্রায়াল শেষ হয়েছে। চাইলে আবার শুরু করতে পারেন।'
      : 'ট্রায়াল বন্ধ হয়েছে। অন্য voice বেছে আবার তুলনা করতে পারেন।')
  }, [releaseResources])

  useEffect(() => () => {
    intentionalCloseRef.current = true
    releaseResources()
  }, [releaseResources])

  const startMicMeter = useCallback((stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext
    const context = new AudioContextCtor()
    audioContextRef.current = context
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.72
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let lastPaint = 0

    void context.resume().catch(() => undefined)
    const measure = (now: number) => {
      if (now - lastPaint >= 80) {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        const rms = Math.sqrt(sum / samples.length)
        setMicLevel(Math.min(1, rms * 12))
        lastPaint = now
      }
      meterFrameRef.current = window.requestAnimationFrame(measure)
    }
    meterFrameRef.current = window.requestAnimationFrame(measure)
  }, [])

  const startUplinkStats = useCallback((peer: RTCPeerConnection) => {
    const update = async () => {
      try {
        const report = await peer.getStats()
        let bytes = 0
        report.forEach(item => {
          const stat = item as RTCStats & {
            kind?: string
            mediaType?: string
            bytesSent?: number
          }
          if (
            stat.type === 'outbound-rtp'
            && (stat.kind === 'audio' || stat.mediaType === 'audio')
            && typeof stat.bytesSent === 'number'
          ) {
            bytes += stat.bytesSent
          }
        })
        setUplinkBytes(bytes)
      } catch {
        // Connection state and transcript events remain the primary diagnostics.
      }
    }
    void update()
    statsTimerRef.current = window.setInterval(() => void update(), 1_000)
  }, [])

  const handleRealtimeEvent = useCallback((event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as RealtimeEvent
      const type = payload.type ?? ''
      if (type === 'session.created' || type === 'session.updated') {
        setStatus(current => current === 'connecting' ? 'listening' : current)
        setEventStage('OpenAI session প্রস্তুত')
      } else if (type === 'input_audio_buffer.speech_started') {
        setStatus('listening')
        setInputTranscript('শুনছি…')
        setOutputTranscript('')
        setEventStage('কণ্ঠ ধরা পড়েছে')
      } else if (type === 'input_audio_buffer.speech_stopped' || type === 'response.created') {
        setStatus('thinking')
        setEventStage(type === 'response.created' ? 'উত্তর তৈরি হচ্ছে' : 'কথা শেষ—উত্তর অপেক্ষমাণ')
      } else if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
        setStatus('speaking')
        setEventStage('অডিও উত্তর আসছে')
      } else if (type === 'conversation.item.input_audio_transcription.delta' && payload.delta) {
        setInputTranscript(current => current === 'শুনছি…' ? payload.delta! : current + payload.delta)
      } else if (type === 'conversation.item.input_audio_transcription.completed') {
        setInputTranscript(payload.transcript?.trim() || 'কথা ধরা পড়েছে, transcript খালি')
        setEventStage('বাংলা transcript সম্পন্ন')
      } else if (type === 'response.output_audio_transcript.delta' && payload.delta) {
        setOutputTranscript(current => current + payload.delta)
      } else if (type === 'response.output_audio_transcript.done' && payload.transcript) {
        setOutputTranscript(payload.transcript.trim())
      } else if (type === 'response.done') {
        setStatus('listening')
        const responseError = payload.response?.status_details?.error?.message
        setEventStage(responseError ? 'উত্তর ব্যর্থ' : 'আবার শুনছি')
        if (responseError) setNotice(`OpenAI: ${responseError.slice(0, 160)}`)
      } else if (type === 'error') {
        intentionalCloseRef.current = true
        releaseResources()
        setStatus('error')
        setMicLevel(0)
        setUplinkBytes(0)
        setNotice(payload.error?.message
          ? `OpenAI: ${payload.error.message.slice(0, 160)}`
          : 'Realtime session-এ একটি সমস্যা হয়েছে।')
      }
    } catch {
      // Ignore non-JSON WebRTC control messages.
    }
  }, [releaseResources])

  const startSession = useCallback(async () => {
    if (status !== 'idle' && status !== 'error') return

    intentionalCloseRef.current = false
    releaseResources()
    setStatus('connecting')
    setMuted(false)
    setRemaining(OPENAI_REALTIME_TRIAL_SECONDS)
    setMicLevel(0)
    setUplinkBytes(0)
    setInputTranscript('')
    setOutputTranscript('')
    setEventStage('মাইক্রোফোনের অনুমতি নিচ্ছে')
    setNotice(`${voice === 'cedar' ? 'Cedar' : 'Marin'} voice প্রস্তুত হচ্ছে…`)

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone unavailable')

      let stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS })
      let micTrack = stream.getAudioTracks()[0]
      if (!micTrack) throw new Error('microphone track unavailable')

      const devices = await navigator.mediaDevices.enumerateDevices()
      const preferredDeviceId = selectPreferredAudioInput(devices, micTrack.label)
      let automaticallySelected = false
      if (preferredDeviceId) {
        try {
          const preferredStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...AUDIO_CONSTRAINTS,
              deviceId: { exact: preferredDeviceId },
            },
          })
          const preferredTrack = preferredStream.getAudioTracks()[0]
          if (preferredTrack) {
            stream.getTracks().forEach(track => track.stop())
            stream = preferredStream
            micTrack = preferredTrack
            automaticallySelected = true
          } else {
            preferredStream.getTracks().forEach(track => track.stop())
          }
        } catch {
          // Keep the browser-selected microphone if the built-in device is unavailable.
        }
      }

      micStreamRef.current = stream
      const inputProfile = inputProfileFor(micTrack.label)
      setMicLabel(`${micTrack.label || 'Default microphone'}${automaticallySelected ? ' · auto' : ''}`)
      setEventStage(inputProfile === 'near_field'
        ? 'Headset mic প্রস্তুত'
        : /macbook|built-in|internal/i.test(micTrack.label)
          ? 'Mac mic প্রস্তুত'
          : 'Far-field mic প্রস্তুত')
      micTrack.addEventListener('ended', () => {
        if (!intentionalCloseRef.current) {
          setStatus('error')
          setNotice('মাইক্রোফোন সংযোগ বন্ধ হয়ে গেছে। আবার trial শুরু করুন।')
        }
      })
      startMicMeter(stream)

      const peer = new RTCPeerConnection()
      peerRef.current = peer
      peer.addTrack(micTrack)

      peer.ontrack = event => {
        if (!audioRef.current) return
        audioRef.current.srcObject = event.streams[0]
        void audioRef.current.play().catch(() => undefined)
      }
      peer.onconnectionstatechange = () => {
        setEventStage(`WebRTC: ${peer.connectionState}`)
        if ((peer.connectionState === 'failed' || peer.connectionState === 'disconnected') && !intentionalCloseRef.current) {
          releaseResources()
          setStatus('error')
          setMicLevel(0)
          setUplinkBytes(0)
          setNotice('WebRTC সংযোগ বিচ্ছিন্ন হয়েছে। আবার চেষ্টা করুন।')
        }
      }

      const channel = peer.createDataChannel('oai-events')
      channelRef.current = channel
      channel.addEventListener('message', handleRealtimeEvent)
      channel.addEventListener('open', () => {
        setStatus('listening')
        setEventStage('বাংলায় বলুন')
        setNotice('স্বাভাবিকভাবে বাংলায় কথা বলুন—মাঝপথে বাধা দিয়েও দেখুন।')
        channel.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: 'স্বাভাবিক বাংলাদেশি উচ্চারণে শুধু এই কথাটি বলো: "আসসালামু আলাইকুম Boss, আমি শুনছি—বলুন।"',
            }],
          },
        }))
        channel.send(JSON.stringify({
          type: 'response.create',
          response: { output_modalities: ['audio'] },
        }))

        timerRef.current = window.setInterval(() => {
          setRemaining(current => {
            if (current <= 1) {
              window.setTimeout(() => stopSession('limit'), 0)
              return 0
            }
            return current - 1
          })
        }, 1_000)
      })
      channel.addEventListener('close', () => {
        if (!intentionalCloseRef.current) {
          releaseResources()
          setStatus('idle')
          setNotice('Realtime সংযোগ শেষ হয়েছে। চাইলে আবার শুরু করুন।')
        }
      })

      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      const response = await fetch(
        `/api/assistant/openai-realtime-trial?voice=${voice}&input=${inputProfile}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        },
      )
      const answer = await response.text()
      if (!response.ok) throw new Error(answer || `HTTP ${response.status}`)

      await peer.setRemoteDescription({ type: 'answer', sdp: answer })
      startUplinkStats(peer)
    } catch (error) {
      intentionalCloseRef.current = true
      releaseResources()
      setStatus('error')
      setMicLevel(0)
      setUplinkBytes(0)
      setNotice(errorMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error)))
    }
  }, [
    handleRealtimeEvent,
    releaseResources,
    startMicMeter,
    startUplinkStats,
    status,
    stopSession,
    voice,
  ])

  const toggleMute = useCallback(() => {
    const track = micStreamRef.current?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setMuted(!track.enabled)
    setNotice(track.enabled ? 'মাইক্রোফোন আবার চালু হয়েছে।' : 'মাইক্রোফোন mute করা হয়েছে।')
  }, [])

  const active = status !== 'idle' && status !== 'error'

  return (
    <div className="trial-page">
      <audio ref={audioRef} autoPlay playsInline />

      <header className="trial-header">
        <div>
          <p className="eyebrow">PRIVATE PREVIEW</p>
          <h1>GPT Realtime <span>2.1</span></h1>
          <p>Natural Bangla voice trial</p>
        </div>
        <div className="model-chip">{OPENAI_REALTIME_TRIAL_MODEL}</div>
      </header>

      <main className="trial-main">
        <section className="voice-card" aria-label="GPT Realtime voice trial">
          <div className="limit-row">
            <span className="live-dot" aria-hidden="true" />
            <span>{active ? 'LIVE SESSION' : 'OWNER ONLY'}</span>
            <strong>{formatTime(remaining)}</strong>
          </div>

          <div className={`orb-wrap orb-${status}`}>
            <FluidOrb state={orbState(status)} size={260} />
          </div>

          <div className="status" aria-live="polite">
            <h2>{statusCopy(status)}</h2>
            <p>{notice}</p>
          </div>

          <div className="diagnostics" aria-label="Live microphone diagnostics">
            <div className="diagnostic-head">
              <span>MIC SIGNAL</span>
              <strong>{Math.round(micLevel * 100)}%</strong>
            </div>
            <div className="mic-meter" aria-label={`Microphone level ${Math.round(micLevel * 100)} percent`}>
              <i style={{ width: `${Math.max(2, micLevel * 100)}%` }} />
            </div>
            <div className="diagnostic-meta">
              <span title={micLabel}>{micLabel}</span>
              <span className={uplinkBytes > 0 ? 'path-ok' : ''}>
                {active
                  ? uplinkBytes > 0
                    ? 'OpenAI-তে audio যাচ্ছে'
                    : 'audio path যাচাই হচ্ছে'
                  : 'session বন্ধ'}
              </span>
              <span>{eventStage}</span>
            </div>
          </div>

          <div className="transcripts" aria-live="polite">
            <div>
              <span>আপনি যা বলেছেন</span>
              <p>{inputTranscript || 'কথা বললে এখানে OpenAI-এর বাংলা transcript দেখা যাবে।'}</p>
            </div>
            <div>
              <span>GPT যা বলছে</span>
              <p>{outputTranscript || 'উত্তর এলে এখানে live transcript দেখা যাবে।'}</p>
            </div>
          </div>

          <div className="voice-picker" aria-label="Voice selection">
            {VOICES.map(option => (
              <button
                key={option.id}
                type="button"
                disabled={active}
                aria-pressed={voice === option.id}
                className={voice === option.id ? 'selected' : ''}
                onClick={() => setVoice(option.id)}
              >
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>

          <div className="controls">
            {active ? (
              <>
                <button type="button" className="secondary" onClick={toggleMute}>
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                <button type="button" className="stop" onClick={() => stopSession('manual')}>
                  ট্রায়াল বন্ধ করুন
                </button>
              </>
            ) : (
              <button type="button" className="start" onClick={startSession}>
                {status === 'error' ? 'আবার চেষ্টা করুন' : `${voice === 'cedar' ? 'Cedar' : 'Marin'} দিয়ে শুরু করুন`}
              </button>
            )}
          </div>
        </section>

        <aside className="boundary-card">
          <div>
            <strong>যা পরীক্ষা করবেন</strong>
            <span>স্বাভাবিকতা · Bangla বোঝা · interruption · response speed</span>
          </div>
          <div>
            <strong>এই trial যা করবে না</strong>
            <span>ERP data পড়বে না · কোনো business action নেবে না</span>
          </div>
          <p>OpenAI API usage সম্পূর্ণ free নয়। খরচ নিয়ন্ত্রণে প্রতিটি UI session ৩ মিনিটে নিজে বন্ধ হবে।</p>
        </aside>
      </main>

      <style jsx>{`
        .trial-page {
          min-height: 100%;
          padding: 28px clamp(18px, 4vw, 56px) 118px;
          color: #f8f4ec;
          background:
            radial-gradient(circle at 18% 8%, rgba(69, 114, 255, 0.22), transparent 34%),
            radial-gradient(circle at 84% 22%, rgba(192, 84, 255, 0.18), transparent 32%),
            linear-gradient(165deg, rgba(10, 12, 22, 0.96), rgba(20, 17, 31, 0.94));
        }
        audio { display: none; }
        .trial-header {
          width: min(760px, 100%);
          margin: 0 auto 22px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
        }
        .eyebrow {
          margin: 0 0 7px;
          color: #8fb0ff;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .18em;
        }
        h1 {
          margin: 0;
          font-size: clamp(28px, 5vw, 42px);
          line-height: 1;
          letter-spacing: -.04em;
        }
        h1 span { color: #a988ff; }
        .trial-header p:last-child {
          margin: 9px 0 0;
          color: rgba(248, 244, 236, .58);
          font-size: 14px;
        }
        .model-chip {
          flex: 0 0 auto;
          padding: 8px 11px;
          border: 1px solid rgba(143, 176, 255, .25);
          border-radius: 999px;
          background: rgba(21, 26, 46, .72);
          color: rgba(222, 231, 255, .78);
          font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .trial-main {
          width: min(760px, 100%);
          margin: 0 auto;
          display: grid;
          gap: 14px;
        }
        .voice-card, .boundary-card {
          border: 1px solid rgba(255, 255, 255, .10);
          background: linear-gradient(145deg, rgba(32, 33, 53, .76), rgba(18, 18, 31, .82));
          box-shadow: 0 28px 80px rgba(0, 0, 0, .32), inset 0 1px 0 rgba(255, 255, 255, .05);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
        }
        .voice-card {
          padding: 18px clamp(18px, 5vw, 42px) 30px;
          border-radius: 30px;
          text-align: center;
        }
        .limit-row {
          min-height: 25px;
          display: flex;
          align-items: center;
          color: rgba(248, 244, 236, .52);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .13em;
        }
        .limit-row strong {
          margin-left: auto;
          color: rgba(248, 244, 236, .78);
          font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0;
        }
        .live-dot {
          width: 7px;
          height: 7px;
          margin-right: 8px;
          border-radius: 50%;
          background: #5d86ff;
          box-shadow: 0 0 14px rgba(93, 134, 255, .9);
        }
        .orb-wrap {
          width: 260px;
          max-width: 76vw;
          margin: 2px auto -4px;
          transition: transform .35s ease;
        }
        .orb-speaking { transform: scale(1.025); }
        .status h2 {
          margin: 0;
          font-size: 22px;
          letter-spacing: -.02em;
        }
        .status p {
          min-height: 40px;
          margin: 8px auto 17px;
          max-width: 500px;
          color: rgba(248, 244, 236, .60);
          font-size: 13px;
          line-height: 1.55;
        }
        .diagnostics {
          margin: 0 0 12px;
          padding: 13px 14px;
          border: 1px solid rgba(255, 255, 255, .08);
          border-radius: 16px;
          background: rgba(7, 9, 18, .28);
          text-align: left;
        }
        .diagnostic-head, .diagnostic-meta {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .diagnostic-head {
          margin-bottom: 8px;
          color: rgba(248, 244, 236, .48);
          font-size: 9px;
          font-weight: 800;
          letter-spacing: .12em;
        }
        .diagnostic-head strong {
          margin-left: auto;
          color: rgba(248, 244, 236, .78);
          font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0;
        }
        .mic-meter {
          height: 7px;
          overflow: hidden;
          border-radius: 999px;
          background: rgba(255, 255, 255, .07);
        }
        .mic-meter i {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, #5d86ff, #9f75ff, #64d8bd);
          box-shadow: 0 0 14px rgba(111, 143, 255, .6);
          transition: width .08s linear;
        }
        .diagnostic-meta {
          margin-top: 8px;
          justify-content: space-between;
          color: rgba(248, 244, 236, .42);
          font-size: 9px;
        }
        .diagnostic-meta span {
          min-width: 0;
          max-width: 34%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .diagnostic-meta .path-ok { color: #76dbc3; }
        .transcripts {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 12px;
          text-align: left;
        }
        .transcripts div {
          min-height: 78px;
          padding: 11px 12px;
          border: 1px solid rgba(255, 255, 255, .075);
          border-radius: 14px;
          background: rgba(255, 255, 255, .025);
        }
        .transcripts span {
          color: #9eb8ff;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: .04em;
        }
        .transcripts p {
          margin: 6px 0 0;
          color: rgba(248, 244, 236, .68);
          font-size: 11px;
          line-height: 1.5;
        }
        .voice-picker {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 14px;
        }
        .voice-picker button {
          padding: 12px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border: 1px solid rgba(255, 255, 255, .09);
          border-radius: 15px;
          background: rgba(255, 255, 255, .035);
          color: rgba(248, 244, 236, .72);
          cursor: pointer;
          transition: border-color .2s ease, background .2s ease, transform .2s ease;
        }
        .voice-picker button:not(:disabled):active { transform: scale(.98); }
        .voice-picker button.selected {
          border-color: rgba(137, 157, 255, .62);
          background: linear-gradient(135deg, rgba(73, 104, 226, .24), rgba(154, 91, 224, .20));
          color: #fff;
        }
        .voice-picker button:disabled { cursor: not-allowed; opacity: .62; }
        .voice-picker strong { font-size: 13px; }
        .voice-picker span { font-size: 11px; color: rgba(248, 244, 236, .48); }
        .controls {
          display: flex;
          justify-content: center;
          gap: 10px;
        }
        .controls button {
          min-height: 50px;
          padding: 0 20px;
          border-radius: 16px;
          font-size: 14px;
          font-weight: 800;
          cursor: pointer;
        }
        .start {
          width: 100%;
          border: 1px solid rgba(173, 183, 255, .52);
          background: linear-gradient(135deg, #5575f3, #8c57d5);
          color: white;
          box-shadow: 0 13px 34px rgba(77, 91, 218, .34);
        }
        .secondary {
          width: 34%;
          border: 1px solid rgba(255, 255, 255, .13);
          background: rgba(255, 255, 255, .055);
          color: #f8f4ec;
        }
        .stop {
          flex: 1;
          border: 1px solid rgba(238, 111, 122, .26);
          background: rgba(183, 55, 72, .17);
          color: #ffccd1;
        }
        .boundary-card {
          padding: 17px 18px;
          border-radius: 20px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
        }
        .boundary-card div { display: grid; gap: 5px; }
        .boundary-card strong { font-size: 12px; color: rgba(248, 244, 236, .88); }
        .boundary-card span, .boundary-card p {
          margin: 0;
          color: rgba(248, 244, 236, .48);
          font-size: 11px;
          line-height: 1.5;
        }
        .boundary-card p {
          grid-column: 1 / -1;
          padding-top: 12px;
          border-top: 1px solid rgba(255, 255, 255, .07);
        }
        @media (max-width: 560px) {
          .trial-page { padding-top: 20px; }
          .trial-header { align-items: center; }
          .model-chip { display: none; }
          .voice-card { padding-top: 14px; border-radius: 25px; }
          .orb-wrap { transform: scale(.90); margin-top: -7px; margin-bottom: -16px; }
          .orb-speaking { transform: scale(.93); }
          .diagnostic-meta { flex-wrap: wrap; }
          .diagnostic-meta span { max-width: 100%; }
          .transcripts { grid-template-columns: 1fr; }
          .boundary-card { grid-template-columns: 1fr; }
          .boundary-card p { grid-column: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .orb-wrap, .voice-picker button { transition: none; }
        }
      `}</style>
    </div>
  )
}

'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'
import { cn } from '@/lib/utils'
import AgentModelSelector from './AgentModelSelector'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'

export interface PendingFile {
  file: File
  previewUrl: string
}

interface AgentComposerProps {
  onSend: (text: string, files: PendingFile[]) => void
  disabled: boolean
  onStop: () => void
  streaming: boolean
  conversationId: string | null
  isMobile?: boolean
  activeModelId?: string
  onModelChange?: (modelId: string) => void
  onVoiceStart?: () => void
}

export default function AgentComposer({
  onSend,
  disabled,
  onStop,
  streaming,
  conversationId,
  isMobile = false,
  activeModelId,
  onModelChange,
  onVoiceStart,
}: AgentComposerProps) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<PendingFile[]>([])
  const [micLevel, setMicLevel] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ChatGPT-style live dictation: tap mic → speak → transcript fills the input.
  const recorder = useVoiceRecorder({
    onTranscribed: (t) => {
      setText((prev) => (prev.trim() ? prev.trim() + ' ' : '') + t)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    onError: (m) => toast.error(m),
  })
  const { recording, recordSecs, stream, start: startDictation, stop: stopDictation, cancel: cancelDictation } = recorder

  // Live mic level (RMS) → drives the floating orb animation while listening.
  useEffect(() => {
    if (!stream) { setMicLevel(0); return }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    src.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let raf = 0
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
      setMicLevel(Math.min(1, Math.sqrt(sum / data.length) * 3))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => { cancelAnimationFrame(raf); try { src.disconnect() } catch { /* noop */ } void ctx.close() }
  }, [stream])

  const toggleDictation = useCallback(() => {
    if (recording) stopDictation()
    else void startDictation()
  }, [recording, startDictation, stopDictation])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const cap = isMobile ? 120 : 160
    const raf = requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, cap)}px`
    })
    return () => cancelAnimationFrame(raf)
  }, [text, isMobile])

  const send = useCallback(() => {
    if ((!text.trim() && files.length === 0) || disabled || streaming) return
    onSend(text, files)
    setText('')
    setFiles([])
    // NOTE: don't revoke the blob previews here — the live optimistic message still
    // renders them. AgentApp owns their lifecycle and revokes once the turn settles.
  }, [text, files, disabled, streaming, onSend])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      send()
    }
  }

  function addFiles(selected: File[]) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    const MAX = 10 * 1024 * 1024
    for (const f of selected) {
      if (!allowed.includes(f.type)) continue
      if (f.size > MAX) continue
      setFiles((prev) => [...prev, { file: f, previewUrl: URL.createObjectURL(f) }])
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

  // Paste an image straight from the clipboard (screenshot, copied photo, etc.).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items?.length) return
    const pasted: File[] = []
    for (const it of Array.from(items)) {
      if (it.kind !== 'file') continue
      if (!it.type.startsWith('image/') && it.type !== 'application/pdf') continue
      const f = it.getAsFile()
      if (f) {
        // Clipboard images often have no name — give them one so upload works.
        pasted.push(f.name ? f : new File([f], `pasted-${Date.now()}.png`, { type: f.type }))
      }
    }
    if (pasted.length) {
      e.preventDefault()
      addFiles(pasted)
    }
  }

  function removeFile(idx: number) {
    setFiles((prev) => {
      URL.revokeObjectURL(prev[idx].previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const canSend = (text.trim().length > 0 || files.length > 0) && !disabled && !streaming

  return (
    <>
    <div className="agent-composer-wrap safe-x shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-5 md:pb-5">
      {/* Floating frosted composer — Claude anatomy: text on top, then
          [ + · model pill ··· mic · voice · coral-send ] (FOUND-1B). */}
      <div
        className="agent-neon-input agent-composer-box alma-frost flex flex-col gap-1 p-2 transition-colors duration-200"
        style={{
          borderRadius: 'var(--radius-composer)',
          ...(streaming ? { borderColor: 'rgba(224,122,95,0.35)' } : null),
        }}
      >
        {recording ? (
          <RecordingBar
            level={micLevel}
            secs={recordSecs}
            onCancel={cancelDictation}
            onConfirm={stopDictation}
          />
        ) : (
        <>
        {/* Row 0 — attached-file previews, INSIDE the composer box (Claude anatomy:
            thumbnails sit attached to the input, not floating above it). */}
        {files.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-1 pt-1 pb-0.5">
            {files.map((f, i) => (
              <div key={i} className="group relative shrink-0">
                {f.file.type.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.previewUrl} alt="" className="h-16 w-16 rounded-xl border border-border-subtle object-cover" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border-subtle bg-white/[0.04] text-[10px] text-muted">PDF</div>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  aria-label="সরান"
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-cream text-[11px] leading-none shadow-md ring-1 ring-white/20 transition-transform hover:scale-110"
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* Row 1 — text (≥16px so iOS never auto-zooms; grows with content) */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled || streaming}
          placeholder="বার্তা লিখুন…"
          rows={1}
          className="max-h-[120px] min-h-[44px] w-full resize-none bg-transparent px-2 py-2 text-base leading-relaxed text-cream placeholder-gray-400 focus:outline-none disabled:opacity-40"
        />

        {/* Row 2 — controls */}
        <div className="flex items-center gap-1">
          {/* Left: circular "+" (attach/add) */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || streaming}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-all hover:bg-white/[0.05] hover:text-cream disabled:opacity-30"
            aria-label="যোগ করুন"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="hidden" onChange={handleFileChange} />

          {/* Middle: tappable model/effort pill */}
          {activeModelId && onModelChange && (
            <AgentModelSelector
              conversationId={conversationId}
              modelId={activeModelId}
              onModelChange={onModelChange}
              disabled={streaming}
            />
          )}

          <div className="min-w-0 flex-1" />

          {/* Right: mic (dictation) */}
          {!streaming && (
            <button
              type="button"
              onClick={toggleDictation}
              disabled={disabled}
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all disabled:opacity-30',
                recording
                  ? 'bg-[#E07A5F] text-white'
                  : 'text-muted hover:bg-[#E07A5F]/10 hover:text-[#E07A5F]',
              )}
              aria-label={recording ? 'ভয়েস থামান' : 'ভয়েসে লিখুন'}
            >
              {recording ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              )}
            </button>
          )}
          {/* Right: voice-to-voice session */}
          {!streaming && onVoiceStart && (
            <button
              type="button"
              onClick={onVoiceStart}
              disabled={disabled}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-all hover:bg-[#81B29A]/10 hover:text-[#81B29A] disabled:opacity-30"
              aria-label="ভয়েস টু ভয়েস"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" opacity="0"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>
            </button>
          )}

          {/* Right: coral circular send (or stop while streaming) */}
          {streaming ? (
            <button type="button" onClick={onStop} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-muted" aria-label="থামান">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all',
                canSend ? 'bg-[#E07A5F] text-white shadow-[0_2px_10px_rgba(224,122,95,0.35)] active:scale-95' : 'bg-white/[0.06] text-muted',
              )}
              aria-label="পাঠান"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            </button>
          )}
        </div>
        </>
        )}
      </div>
    </div>
    </>
  )
}

/** mm:ss for the recording timer. */
function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Claude-style scrolling voice waveform — coral bars driven by live mic level. */
function VoiceWaveform({ level }: { level: number }) {
  const BARS = 34
  const [bars, setBars] = useState<number[]>(() => Array(BARS).fill(0.06))
  useEffect(() => {
    setBars((prev) => {
      const next = prev.slice(1)
      next.push(Math.max(0.06, Math.min(1, level)))
      return next
    })
  }, [level])
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden px-1">
      {bars.map((b, i) => (
        <span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-[#E07A5F]"
          style={{ height: `${Math.round(b * 100)}%`, opacity: 0.3 + b * 0.7 }}
        />
      ))}
    </div>
  )
}

/** Inline recording bar: cancel (✕) · live waveform · timer · confirm (✓). */
function RecordingBar({
  level,
  secs,
  onCancel,
  onConfirm,
}: {
  level: number
  secs: number
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-1 py-1.5">
      <button
        type="button"
        onClick={onCancel}
        aria-label="বাতিল"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-all hover:bg-white/[0.05] active:scale-95"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <VoiceWaveform level={level} />
      <span className="shrink-0 text-[12px] tabular-nums text-muted">{mmss(secs)}</span>
      <button
        type="button"
        onClick={onConfirm}
        aria-label="সম্পন্ন"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#E07A5F] text-white shadow-[0_2px_10px_rgba(224,122,95,0.35)] transition-all active:scale-95"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </button>
    </div>
  )
}

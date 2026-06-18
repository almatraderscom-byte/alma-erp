'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'
import { cn } from '@/lib/utils'
import AgentModelSelector from './AgentModelSelector'
import { useVoiceRecorder } from '@/agent/hooks/useVoiceRecorder'
import { VoiceOrb } from './voice/VoiceOrb'

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
  const { recording, stream, start: startDictation, stop: stopDictation } = recorder

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
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl))
  }, [text, files, disabled, streaming, onSend])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      send()
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? [])
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    const MAX = 10 * 1024 * 1024
    for (const f of selected) {
      if (!allowed.includes(f.type)) continue
      if (f.size > MAX) continue
      setFiles((prev) => [...prev, { file: f, previewUrl: URL.createObjectURL(f) }])
    }
    e.target.value = ''
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
      {recording && (
        <button
          type="button"
          onClick={stopDictation}
          className="fixed left-1/2 top-[calc(env(safe-area-inset-top,0px)+0.6rem)] z-[80] flex -translate-x-1/2 select-none items-center gap-2 rounded-full border border-black/[0.06] bg-white/90 py-1.5 pl-1.5 pr-3.5 shadow-[0_6px_24px_rgba(224,122,95,0.22)] backdrop-blur-xl [-webkit-touch-callout:none]"
          aria-label="শোনা থামান"
        >
          <VoiceOrb state="listening" micLevel={micLevel} size={30} />
          <span className="text-[12.5px] font-semibold text-[#1a1a2e]">
            শুনছি… <span className="font-medium text-gray-400">ট্যাপ করে থামান</span>
          </span>
        </button>
      )}
    <div className="agent-composer-wrap safe-x shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-5 md:pb-5">
      {files.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <div key={i} className="relative shrink-0">
              {f.file.type.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl} alt="" className="h-14 w-14 rounded-xl border border-black/[0.06] object-cover" />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-black/[0.06] bg-gray-50 text-[10px] text-gray-500">PDF</div>
              )}
              <button type="button" onClick={() => removeFile(i)} className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[8px]">×</button>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          'agent-neon-input flex flex-col gap-1 rounded-2xl border p-1.5 transition-all duration-200 md:p-2',
          streaming
            ? 'border-[#E07A5F]/25 bg-white shadow-[0_2px_12px_rgba(224,122,95,0.08)]'
            : 'border-black/[0.08] bg-white focus-within:border-black/[0.14]',
        )}
      >
        <div className="flex items-end gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || streaming}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 hover:bg-black/[0.04] disabled:opacity-30 md:h-9 md:w-9"
            aria-label="ফাইল"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="hidden" onChange={handleFileChange} />

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || streaming}
            placeholder="বার্তা লিখুন…"
            rows={1}
            className="max-h-[120px] min-h-[44px] flex-1 resize-none bg-transparent px-1.5 py-2.5 text-base leading-snug text-[#1a1a2e] placeholder-gray-400 focus:outline-none disabled:opacity-40 md:min-h-[40px] md:text-sm"
          />

          {!streaming && (
            <button
              type="button"
              onClick={toggleDictation}
              disabled={disabled}
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all disabled:opacity-30 md:h-9 md:w-9',
                recording
                  ? 'bg-[#E07A5F] text-white'
                  : 'text-gray-400 hover:bg-[#E07A5F]/8 hover:text-[#E07A5F]',
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
          {!streaming && onVoiceStart && (
            <button
              type="button"
              onClick={onVoiceStart}
              disabled={disabled}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-[#81B29A]/10 hover:text-[#81B29A] disabled:opacity-30 md:h-9 md:w-9"
              aria-label="ভয়েস টু ভয়েস"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" opacity="0"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>
            </button>
          )}

          {streaming ? (
            <button type="button" onClick={onStop} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 md:h-9 md:w-9" aria-label="থামান">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all md:h-9 md:w-9',
                canSend ? 'bg-[#E07A5F] text-white' : 'bg-gray-100 text-gray-300',
              )}
              aria-label="পাঠান"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            </button>
          )}
        </div>

        {activeModelId && onModelChange && (
          <div className="flex items-center border-t border-black/[0.04] px-1 pt-1">
            <AgentModelSelector
              conversationId={conversationId}
              modelId={activeModelId}
              onModelChange={onModelChange}
              disabled={streaming}
            />
          </div>
        )}
      </div>
    </div>
    </>
  )
}

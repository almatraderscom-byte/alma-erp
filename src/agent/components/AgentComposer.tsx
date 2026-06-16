'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import AgentModelSelector from './AgentModelSelector'

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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    <div className="safe-x shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-5 md:pb-5">
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
          'flex flex-col gap-1 rounded-2xl border p-1.5 transition-all duration-200 md:p-2',
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

          {!streaming && onVoiceStart && (
            <button
              type="button"
              onClick={onVoiceStart}
              disabled={disabled}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-[#E07A5F]/8 hover:text-[#E07A5F] disabled:opacity-30 md:h-9 md:w-9"
              aria-label="ভয়েস"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
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
  )
}
